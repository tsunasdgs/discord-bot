// ==============================
// index.js （"type": "module" 前提）
// ==============================

import {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, InteractionType, PermissionsBitField,
  Events, Colors
} from "discord.js";
import { Pool } from "pg";
import dotenv from "dotenv";
import schedule from "node-schedule";
import crypto from "crypto";
import http from "http";

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ==============================
// クライアント
// ==============================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ==============================
// 環境設定
// ==============================
const DAILY_AMOUNT        = parseInt(process.env.DAILY_AMOUNT || "100", 10);
const REWARD_ROLE_ID      = process.env.REWARD_ROLE_ID || "";
const REWARD_PER_MESSAGE  = parseInt(process.env.REWARD_PER_MESSAGE || "10", 10);
const REWARD_DAILY_LIMIT  = parseInt(process.env.REWARD_DAILY_LIMIT || "10", 10);
const REWARD_COOLDOWN_SEC = parseInt(process.env.REWARD_COOLDOWN_SEC || "45", 10);

// [REMOVED:CASINO_ENV] CASINO_CHANNEL_ID / CASINO_SLOT_TTL_SEC / CASINO_CLEAN_LIMIT は削除済み

// ==============================
// ユーティリティ
// ==============================
function createEmbed(title, desc, color = Colors.Blurple) {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);
}
const fmt = (n) => Number(n).toLocaleString("ja-JP");

function limitContent(s, limit = 1900) {
  if (!s) return s;
  if (s.length <= limit) return s;
  return s.slice(0, limit - 20) + "\n…（省略）";
}
function formatJST(ts) {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}
const todayJST = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()); // YYYY-MM-DD

async function ephemeralReply(interaction, payload, ms = 15000) {
  const data = { ...payload };
  if (typeof data.content === "string") data.content = limitContent(data.content);
  const msg = await interaction.reply({ ...data, ephemeral: true });
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
  return msg;
}
async function ephemeralUpdate(interaction, payload, ms = 15000) {
  const data = { ...payload };
  if (typeof data.content === "string") data.content = limitContent(data.content);
  const msg = await interaction.update({ ...data });
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
  return msg;
}

// コイン加算（差額記録＋履歴）
async function addCoins(userId, amount, type, note = null) {
  const n = Math.trunc(Number(amount) || 0);
  await pool.query(
    `INSERT INTO coins (user_id, balance)
     VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET balance = coins.balance + EXCLUDED.balance`,
    [userId, n]
  );
  await pool.query(
    `INSERT INTO history (user_id, type, amount, note, created_at)
     VALUES ($1,$2,$3,$4,NOW())`,
    [userId, type, n, note]
  );
}

// [REMOVED:CASINO_CLEANUP] purgeCasinoMessages 関数は削除しました（未参照ID/権限/古いUI対策のため廃止）

// ==============================
// DB初期化
// ==============================
async function ensureTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS coins (user_id TEXT PRIMARY KEY, balance INTEGER DEFAULT 0);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS history (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT,
      created_at TIMESTAMP DEFAULT now()
    );
  `);
  await pool.query(`CREATE TABLE IF NOT EXISTS daily_claims (user_id TEXT PRIMARY KEY, last_claim DATE);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_rewards (
      user_id TEXT PRIMARY KEY,
      date TEXT,
      count INTEGER DEFAULT 0,
      last_message_at TIMESTAMP,
      last_message_hash TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rumuma_races (
      id SERIAL PRIMARY KEY,
      channel_id TEXT,
      host_id TEXT,
      race_name TEXT,
      horses TEXT[],
      finished BOOLEAN DEFAULT false,
      winner TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rumuma_bets (
      id SERIAL PRIMARY KEY,
      race_id INTEGER NOT NULL REFERENCES rumuma_races(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      horse TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rumuma_results (
      id SERIAL PRIMARY KEY,
      race_id    INTEGER,
      race_name  TEXT,
      horses     TEXT[],
      winner     TEXT,
      total_pot  INTEGER,
      status     TEXT,
      finished_at TIMESTAMP DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_rewards (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      race_id INTEGER NOT NULL,
      race_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      claimed BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  // [REMOVED:SLOT_TABLES] slot_states / slot_config の作成を削除
}

// ==============================
// レース中止（返金）
// ==============================
async function refundRumuma(raceId, reason = "開催中止") {
  const raceRes = await pool.query(`SELECT race_name, horses FROM rumuma_races WHERE id=$1`, [raceId]);
  const betsRes = await pool.query(`SELECT amount, user_id FROM rumuma_bets WHERE race_id=$1`, [raceId]);

  let totalPot = 0;
  for (const b of betsRes.rows) totalPot += Number(b.amount);

  for (const b of betsRes.rows) {
    await addCoins(b.user_id, b.amount, "rumuma_refund", `Race:${raceId} ${reason}`);
  }

  await pool.query(
    `INSERT INTO rumuma_results(race_id, race_name, horses, winner, total_pot, status, finished_at)
     VALUES ($1,$2,$3,$4,$5,'canceled',NOW())`,
    [raceId, raceRes.rows[0]?.race_name || "", raceRes.rows[0]?.horses || [], null, totalPot]
  );

  await pool.query(`DELETE FROM rumuma_bets WHERE race_id=$1`, [raceId]);
  await pool.query(`DELETE FROM rumuma_races WHERE id=$1`, [raceId]);
}

// ==============================
// 履歴表示
// ==============================
function formatHistoryEmbed(row) {
  const when = formatJST(row.created_at);
  let typeLabel = "📦 その他";
  let color = Colors.Blurple;

  switch (row.type) {
    // [NOTE] 過去の履歴互換：casino_slot は表示のみ存続
    case "casino_slot": typeLabel = "🎰（削除済）ジャグラー"; color = Colors.Grey; break;
    case "daily":       typeLabel = "🎁 デイリー";   color = Colors.Green;  break;
    case "msg_reward":  typeLabel = "💬 メッセ報酬"; color = Colors.Blue;   break;
    case "gacha":
    case "gacha_reward":typeLabel = "🎲 ガチャ";    color = Colors.Gold;   break;
    case "rumuma_bet":  typeLabel = "🏇 レースBET"; color = Colors.Aqua;   break;
    case "rumuma_refund":typeLabel= "↩️ レース返金"; color= Colors.Grey;   break;
    case "admin_adjust":typeLabel = "⚙️ 管理調整";  color = Colors.Red;    break;
    case "reward_claim":typeLabel = "💳 払い戻し受取"; color = Colors.Gold; break;
  }
  const amount = (row.amount >= 0 ? "+" : "") + fmt(row.amount);
  return new EmbedBuilder()
    .setTitle(typeLabel)
    .setDescription(`${when}\n金額: **${amount}S**\n${row.note || ""}`)
    .setColor(color);
}
async function replyHistoryEmbeds(interaction, rows) {
  const embeds = rows.map(formatHistoryEmbed);
  const chunk1 = embeds.slice(0, 10);
  const chunk2 = embeds.slice(10);
  if (chunk1.length) await interaction.reply({ embeds: chunk1, ephemeral: true });
  else return interaction.reply({ content: "履歴はありません", ephemeral: true });
  if (chunk2.length) await interaction.followUp({ embeds: chunk2, ephemeral: true });
}
// ==============================
// UI送信（管理／コイン／レース）
// ==============================
async function sendUI(channel, type) {
  if (type === "admin") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_adjust").setLabel("⚙️ コイン増減").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("view_history_admin").setLabel("📜 全員取引履歴").setStyle(ButtonStyle.Secondary),
      // [REMOVED:SLOT_CONFIG_OPEN] .setCustomId("slot_config_open") は削除
      // [REMOVED:CASINO_CLEANUP] .setCustomId("casino_cleanup") は削除
    );
    await channel.send({ content: "管理メニュー", components: [row] });
  }

  if (type === "daily") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("daily_claim").setLabel("🎁 デイリーコイン").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("gacha_play").setLabel("🎲 ガチャ").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("check_balance").setLabel("💰 残高確認").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("view_history_user").setLabel("📜 取引履歴").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("view_ranking").setLabel("🏅 ランキング").setStyle(ButtonStyle.Primary)
    );
    await channel.send({ content: "コインメニュー", components: [row] });
  }

  if (type === "rumuma") {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rumuma_create").setLabel("🏇 レース作成").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("rumuma_list").setLabel("📃 レース一覧").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rumuma_bet").setLabel("🎫 ウマ券購入").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("rumuma_my_bets").setLabel("🎫 ウマ券確認").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rumuma_odds").setLabel("📈 オッズ確認").setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rumuma_close_bets").setLabel("✅ 投票締切").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rumuma_report_result").setLabel("🏆 結果報告").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("rumuma_cancel").setLabel("⛔ 開催中止").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rumuma_history").setLabel("🗂 競争履歴").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rumuma_claim_rewards").setLabel("💳 払い戻し").setStyle(ButtonStyle.Primary)
    );
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rumuma_view_bets").setLabel("👀 賭け状況確認（ホスト）").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("check_balance").setLabel("💰 残高確認").setStyle(ButtonStyle.Secondary)
    );
    await channel.send({ content: "レースメニュー", components: [row1, row2, row3] });
  }

  // [REMOVED:CASINO_MENU] type === "casino" は削除
}

// ==============================
// ガチャ
// ==============================
async function playGacha(interaction) {
  const uid = interaction.user.id;
  const cost = 30;

  const balRes = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [uid]);
  const balance = balRes.rowCount ? Number(balRes.rows[0].balance) : 0;
  if (balance < cost) {
    return ephemeralReply(interaction, { embeds: [createEmbed("ガチャ", `残高不足：必要 ${fmt(cost)}S / 保有 ${fmt(balance)}S`, Colors.Red)] });
  }

  await addCoins(uid, -cost, "gacha", "ガチャを回した");

  const roll = Math.random();
  let rarity = "S", reward = 5;
  if (roll < 0.70) { rarity = "S"; reward = 5; }
  else if (roll < 0.95) { rarity = "SR"; reward = 10; }
  else { rarity = "SSR"; reward = 50; }

  await addCoins(uid, reward, "gacha_reward", `ガチャ当選:${rarity}`);

  if (rarity === "SSR") {
    const modal = new ModalBuilder()
      .setCustomId("gacha_ssr_modal")
      .setTitle("SSRロール作成")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("role_name").setLabel("ロール名（20文字まで）").setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("role_color").setLabel("カラーコード（例：#FFD700）").setStyle(TextInputStyle.Short).setRequired(false)
        )
      );
    return interaction.showModal(modal);
  }

  return ephemeralReply(interaction, {
    embeds: [createEmbed("🎲 ガチャ結果", `結果: **${rarity}**\n🟢 +${fmt(reward)}S`, rarity === "SR" ? Colors.Purple : Colors.Grey)]
  });
}

// ==============================
// Interaction（ボタン／セレクト／モーダル）
// ==============================
client.on("interactionCreate", async (interaction) => {
  try {
    /* ---------- ボタン ---------- */
    if (interaction.isButton()) {
      switch (interaction.customId) {
        /* ===== 管理 ===== */
        case "admin_adjust": {
          if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
            return ephemeralReply(interaction, { content: "管理者権限が必要です" });
          const modal = new ModalBuilder()
            .setCustomId("admin_adjust_modal")
            .setTitle("ユーザーコイン調整")
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("target_user").setLabel("対象ユーザーID").setStyle(TextInputStyle.Short).setRequired(true)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("amount").setLabel("増減額 (例: 100 or -50)").setStyle(TextInputStyle.Short).setRequired(true)
              )
            );
          return interaction.showModal(modal);
        }
        case "view_history_admin": {
          if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
            return ephemeralReply(interaction, { content: "管理者権限が必要です" });
          const res = await pool.query(`SELECT * FROM history ORDER BY created_at DESC LIMIT 15`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "履歴はありません" });
          await replyHistoryEmbeds(interaction, res.rows);
          return;
        }

        // [DISABLED:slot_config_open] 旧UIからの誤動作対策
        case "slot_config_open": {
          return ephemeralReply(interaction, { content: "🎰 ジャグラー機能は削除されました（設定UIは無効です）。" }, 20000);
        }
        // [DISABLED:casino_cleanup] 旧UIからの誤動作対策
        case "casino_cleanup": {
          return ephemeralReply(interaction, { content: "🎰 ジャグラー関連の掃除機能は削除されました。古いメッセージは手動で削除してください。" }, 20000);
        }

        /* ===== コイン（デイリー／残高／履歴／ガチャ／ランキング） ===== */
        case "daily_claim": {
          const uid = interaction.user.id;
          const today = todayJST();
          const res = await pool.query(`SELECT last_claim FROM daily_claims WHERE user_id=$1`, [uid]);
          let lastClaimStr = null;
          if (res.rowCount) {
            const raw = res.rows[0].last_claim;
            if (typeof raw === "string") lastClaimStr = raw;
            else if (raw) lastClaimStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(raw));
          }
          if (lastClaimStr === today) return ephemeralReply(interaction, { embeds: [createEmbed("コイン", "今日はもう受け取り済みです", Colors.Red)] });

          await pool.query(
            `INSERT INTO daily_claims (user_id, last_claim)
             VALUES ($1,$2::date)
             ON CONFLICT(user_id) DO UPDATE SET last_claim=$2::date`,
            [uid, today]
          );
          await addCoins(uid, DAILY_AMOUNT, "daily", "デイリー報酬");
          return ephemeralReply(interaction, { embeds: [createEmbed("コイン", `${fmt(DAILY_AMOUNT)}Sを受け取りました！`, Colors.Green)] });
        }
        case "check_balance": {
          const uid = interaction.user.id;
          const res = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [uid]);
          const bal = res.rowCount ? Number(res.rows[0].balance) : 0;
          return ephemeralReply(interaction, { embeds: [createEmbed("残高確認", `${fmt(bal)} S`)] }, 30000);
        }
        case "view_history_user": {
          const uid = interaction.user.id;
          const res = await pool.query(`SELECT * FROM history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 15`, [uid]);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "履歴はありません" });
          await replyHistoryEmbeds(interaction, res.rows);
          return;
        }
        case "gacha_play": return playGacha(interaction);
        case "view_ranking": {
          const rs = await pool.query(`SELECT user_id, balance FROM coins ORDER BY balance DESC LIMIT 10`);
          if (!rs.rowCount) return ephemeralReply(interaction, { content: "ランキングはまだありません" }, 30000);
          const lines = rs.rows.map((r, i) => `#${i+1} <@${r.user_id}> … **${fmt(r.balance)}S**`).join("\n");
          return ephemeralReply(interaction, { embeds: [createEmbed("🏅 コインランキング（TOP10）", lines, Colors.Gold)] }, 30000);
        }

        // [DISABLED:casino_slot] 旧UIからの誤動作対策
        case "casino_slot": {
          return ephemeralReply(interaction, { content: "🎰 ジャグラー機能は削除されました。メニューからは非表示です。" }, 20000);
        }

        /* ===== レース：一覧 ===== */
        case "rumuma_list": {
          const res = await pool.query(`SELECT * FROM rumuma_races WHERE finished=false ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "レースはありません" });
          const list = res.rows.map(r =>
            `ID:${r.id} ${r.race_name}（${(r.horses || []).join(", ")}） [開催中]`
          ).join("\n");
          return ephemeralReply(interaction, { content: list });
        }

        /* ===== レース：作成 ===== */
        case "rumuma_create": {
          const modal = new ModalBuilder()
            .setCustomId("rumuma_create_modal")
            .setTitle("レース作成")
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("race_name").setLabel("レース名").setStyle(TextInputStyle.Short).setRequired(true)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("horses").setLabel("ウマ名（改行 or , 区切り）").setStyle(TextInputStyle.Paragraph).setRequired(true)
              )
            );
          return interaction.showModal(modal);
        }

        /* ===== ウマ券購入の導線 ===== */
        case "rumuma_bet": {
          const res = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "購入可能なレースがありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_bet_race")
            .setPlaceholder("購入するレースを選択")
            .addOptions(res.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));
          return ephemeralReply(interaction, { content: "レースを選択してください", components: [new ActionRowBuilder().addComponents(menu)] });
        }

        /* ===== 自分の未決着ウマ券 ===== */
        case "rumuma_my_bets": {
          const uid = interaction.user.id;
          const res = await pool.query(
            `SELECT b.race_id, r.race_name, r.finished, b.horse, SUM(b.amount)::bigint AS total_amount
             FROM rumuma_bets b
             JOIN rumuma_races r ON r.id = b.race_id
             WHERE b.user_id=$1
             GROUP BY b.race_id, r.race_name, r.finished, b.horse
             ORDER BY b.race_id DESC, r.race_name ASC, b.horse ASC`,
            [uid]
          );
          if (!res.rowCount) return ephemeralReply(interaction, { content: "あなたのウマ券はありません" });
          const active = res.rows.filter(row => !row.finished);
          if (!active.length) return ephemeralReply(interaction, { content: "未決着のウマ券はありません" });
          const lines = active.map(row => `Race:${row.race_id} ${row.race_name} - ${row.horse} に ${fmt(row.total_amount)}S`).join("\n");
          return ephemeralReply(interaction, { content: "あなたの未決着ウマ券\n" + lines });
        }
        /* ===== 投票締切（ホスト専用） ===== */
        case "rumuma_close_bets": {
          const res = await pool.query(`SELECT id, race_name, host_id FROM rumuma_races WHERE finished=false ORDER BY id DESC`);
          const own = res.rows.filter(r => r.host_id === interaction.user.id);
          if (!own.length) return ephemeralReply(interaction, { content: "あなたがホストの締切対象レースがありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_close_race")
            .setPlaceholder("締切するレースを選択")
            .addOptions(own.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));
          return ephemeralReply(interaction, { content: "締切するレースを選択してください", components: [new ActionRowBuilder().addComponents(menu)] });
        }

        /* ===== 結果報告（ホスト専用） ===== */
        case "rumuma_report_result": {
          const res = await pool.query(`
            SELECT id, race_name, host_id
            FROM rumuma_races
            WHERE finished=true
              AND id NOT IN (SELECT race_id FROM rumuma_results WHERE status='finished')
            ORDER BY id DESC
          `);
          const own = res.rows.filter(r => r.host_id === interaction.user.id);
          if (!own.length) return ephemeralReply(interaction, { content: "あなたがホストの結果報告可能なレースがありません（まず締切してください）" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_result_race")
            .setPlaceholder("結果報告するレースを選択")
            .addOptions(own.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));
          return ephemeralReply(interaction, { content: "結果報告するレースを選択してください", components: [new ActionRowBuilder().addComponents(menu)] });
        }

        /* ===== 開催中止（管理者） ===== */
        case "rumuma_cancel": {
          if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
            return ephemeralReply(interaction, { content: "管理者権限が必要です" });
          const res = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "中止できるレースがありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_cancel_race")
            .setPlaceholder("開催中止するレースを選択")
            .addOptions(res.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));
          return ephemeralReply(interaction, { content: "開催中止するレースを選択してください（全額返金）", components: [new ActionRowBuilder().addComponents(menu)] });
        }

        /* ===== 競争履歴 ===== */
        case "rumuma_history": {
          const res = await pool.query(
            `SELECT race_id, race_name, winner, total_pot, status, finished_at
             FROM rumuma_results
             ORDER BY finished_at DESC
             LIMIT 10`
          );
          if (!res.rowCount) return ephemeralReply(interaction, { content: "競争履歴はまだありません" });
          const lines = res.rows.map(r => {
            const when = formatJST(r.finished_at);
            const tag = r.status === "canceled" ? "【開催中止】" : `勝者:${r.winner}`;
            return `${when} | Race:${r.race_id} ${r.race_name} | ${tag} | 総額:${fmt(r.total_pot ?? 0)}S`;
          }).join("\n");
          return ephemeralReply(interaction, { content: "直近10件の競争履歴\n" + lines });
        }

        /* ===== 払い戻し一括受取 ===== */
        case "rumuma_claim_rewards": {
          const uid = interaction.user.id;
          const res = await pool.query(
            `SELECT race_id, race_name, amount
             FROM pending_rewards
             WHERE user_id=$1 AND claimed=false
             ORDER BY created_at ASC`,
            [uid]
          );
          if (!res.rowCount) return ephemeralReply(interaction, { content: "未受け取りの払い戻しはありません" });
          const byRace = new Map();
          for (const row of res.rows) {
            const key = `${row.race_id}::${row.race_name}`;
            if (!byRace.has(key)) byRace.set(key, 0);
            byRace.set(key, byRace.get(key) + Number(row.amount));
          }
          const total = Array.from(byRace.values()).reduce((s, n) => s + n, 0);
          await addCoins(uid, total, "reward_claim", `払い戻し一括受け取り ${res.rowCount}件`);
          await pool.query(`UPDATE pending_rewards SET claimed=true WHERE user_id=$1 AND claimed=false`, [uid]);
          const breakdown = Array.from(byRace.entries()).map(([key, sum]) => {
            const [rid, rname] = key.split("::"); return `・Race:${rid} ${rname} …… ${fmt(sum)}S`;
          }).join("\n");
          const text = `以下の払い戻しを受け取りました！\n${breakdown}\n———\n合計：${fmt(total)}S`;
          return ephemeralReply(interaction, { content: text });
        }

        /* ===== オッズ確認（誰でも） ===== */
        case "rumuma_odds": {
          const res = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "オッズを確認できるレースがありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_odds_race")
            .setPlaceholder("オッズを確認するレースを選択")
            .addOptions(res.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));
          return ephemeralReply(interaction, { content: "レースを選択してください", components: [new ActionRowBuilder().addComponents(menu)] });
        }

        /* ===== ホスト専用：賭け状況確認 ===== */
        case "rumuma_view_bets": {
          const uid = interaction.user.id;
          const races = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE host_id=$1 ORDER BY id DESC`, [uid]);
          if (!races.rowCount) return ephemeralReply(interaction, { content: "あなたがホストのレースはありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_view_bets_race")
            .setPlaceholder("賭け状況を確認するレースを選択")
            .addOptions(races.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));
          return ephemeralReply(interaction, { content: "レースを選んでください", components: [new ActionRowBuilder().addComponents(menu)] });
        }
      }
    }

    /* ---------- セレクトメニュー ---------- */
    if (interaction.isStringSelectMenu()) {
      // 購入：レース選択 → ウマ選択
      if (interaction.customId === "select_bet_race") {
        const raceId = parseInt(interaction.values[0], 10);
        const r = await pool.query(`SELECT horses, finished FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!r.rowCount) return ephemeralUpdate(interaction, { content: "レースが見つかりません", components: [] });
        if (r.rows[0].finished) return ephemeralUpdate(interaction, { content: "このレースは締切られています", components: [] });

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`select_bet_horse_${raceId}`)
          .setPlaceholder("賭けるウマを選択（1頭ずつ購入）")
          .addOptions((r.rows[0].horses || []).map(h => ({ label: h, value: h })));

        return ephemeralUpdate(interaction, {
          content: `レースID:${raceId} 賭けるウマを選んでください`,
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }

      // 購入：ウマ選択 → 金額入力モーダル
      if (interaction.customId.startsWith("select_bet_horse_")) {
        const raceId = parseInt(interaction.customId.split("_")[3], 10);
        const horse = interaction.values[0];

        const r = await pool.query(`SELECT horses, finished FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!r.rowCount) return ephemeralUpdate(interaction, { content: "レースが見つかりません", components: [] });
        if (r.rows[0].finished) return ephemeralUpdate(interaction, { content: "このレースは締切済みです", components: [] });

        // オッズ計算（現時点・倍率のみ）
        const bets = await pool.query(
          `SELECT horse, SUM(amount)::bigint AS sum FROM rumuma_bets WHERE race_id=$1 GROUP BY horse`,
          [raceId]
        );
        const totalPot = bets.rows.reduce((s, b) => s + Number(b.sum), 0);
        const horseSum = Number(bets.rows.find(b => b.horse === horse)?.sum || 0);
        const odds = horseSum > 0 ? (totalPot / horseSum).toFixed(2) : "賭けなし";

        const balRes = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [interaction.user.id]);
        const balance = balRes.rowCount ? Number(balRes.rows[0].balance) : 0;

        const modal = new ModalBuilder()
          .setCustomId(`rumuma_bet_amount_modal_${raceId}__${encodeURIComponent(horse)}`)
          .setTitle(`ウマ券購入: ${horse}（倍率 ${odds}）`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("amounts")
                .setLabel(`金額（残高: ${fmt(balance)}S / スペース・カンマ区切りで複数可）`)
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      // 締切：レース選択 → finished=true（ホストチェック）
      if (interaction.customId === "select_close_race") {
        const raceId = parseInt(interaction.values[0], 10);
        const own = await pool.query(`SELECT host_id FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!own.rowCount || own.rows[0].host_id !== interaction.user.id)
          return ephemeralUpdate(interaction, { content: "このレースのホストではありません", components: [] });
        await pool.query(`UPDATE rumuma_races SET finished=true WHERE id=$1`, [raceId]);
        return ephemeralUpdate(interaction, { content: `レースID:${raceId} のウマ券購入を締め切りました`, components: [] });
      }

      // 結果報告：レース選択 → 勝者選択（ホストチェック）
      if (interaction.customId === "select_result_race") {
        const raceId = parseInt(interaction.values[0], 10);
        const own = await pool.query(`SELECT host_id, horses, race_name FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!own.rowCount) return ephemeralUpdate(interaction, { content: "レースが見つかりません", components: [] });
        if (own.rows[0].host_id !== interaction.user.id)
          return ephemeralUpdate(interaction, { content: "このレースのホストではありません", components: [] });

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`select_winner_${raceId}`)
          .setPlaceholder("勝者を選んでください")
          .addOptions((own.rows[0].horses || []).map(h => ({ label: h, value: h })));

        return ephemeralUpdate(interaction, {
          content: `レースID:${raceId} 勝者を選択してください`,
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }

      // 勝者選択 → 配当作成 → レース削除（多重防止）
      if (interaction.customId.startsWith("select_winner_")) {
        const raceId = parseInt(interaction.customId.split("_")[2], 10);
        const winner = interaction.values[0];

        const exist = await pool.query(`SELECT 1 FROM rumuma_results WHERE race_id=$1 AND status='finished'`, [raceId]);
        if (exist.rowCount) {
          return ephemeralUpdate(interaction, { content: "このレースは既に結果登録済みです。", components: [] });
        }

        const bets = await pool.query(`SELECT user_id, horse, amount FROM rumuma_bets WHERE race_id=$1`, [raceId]);
        if (!bets.rowCount) return ephemeralUpdate(interaction, { content: "このレースの投票がありません", components: [] });

        const totalPot = bets.rows.reduce((s, b) => s + Number(b.amount), 0);
        const winners = bets.rows.filter(b => b.horse === winner);
        const winSum = winners.reduce((s, b) => s + Number(b.amount), 0);

        const raceRow = await pool.query(`SELECT race_name, horses FROM rumuma_races WHERE id=$1`, [raceId]);

        await pool.query(
          `INSERT INTO rumuma_results(race_id, race_name, horses, winner, total_pot, status, finished_at)
           VALUES ($1,$2,$3,$4,$5,'finished',NOW())`,
          [raceId, raceRow.rows[0]?.race_name || "", raceRow.rows[0]?.horses || [], winner, totalPot]
        );

        if (winSum > 0) {
          for (const w of winners) {
            const share = Number(w.amount) / winSum;
            const payout = Math.floor(totalPot * share);
            if (payout > 0) {
              await pool.query(
                `INSERT INTO pending_rewards(user_id, race_id, race_name, amount, claimed, created_at)
                 VALUES($1,$2,$3,$4,false,NOW())`,
                [w.user_id, raceId, raceRow.rows[0]?.race_name || "", payout]
              );
            }
          }
        }

        await pool.query(`UPDATE rumuma_races SET finished=true, winner=$2 WHERE id=$1`, [raceId, winner]);
        await pool.query(`DELETE FROM rumuma_races WHERE id=$1`, [raceId]); // 多重防止

        return ephemeralUpdate(interaction, {
          content: `結果登録完了：Race:${raceId} Winner:${winner}\n総額:${fmt(totalPot)}S / 勝者合計:${fmt(winSum)}S\n勝者には「払い戻し」から受取可能な報酬を作成しました。`,
          components: []
        });
      }

      // 開催中止（管理者）
      if (interaction.customId === "select_cancel_race") {
        if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
          return ephemeralUpdate(interaction, { content: "管理者権限が必要です", components: [] });
        const raceId = parseInt(interaction.values[0], 10);
        await refundRumuma(raceId, "開催中止");
        return ephemeralUpdate(interaction, { content: `レースID:${raceId} は開催中止になりました（全額返金 & 履歴保存）`, components: [] });
      }

      // ホスト専用：賭け状況表示
      if (interaction.customId === "select_view_bets_race") {
        const raceId = parseInt(interaction.values[0], 10);
        const own = await pool.query(`SELECT host_id, race_name, horses FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!own.rowCount) return ephemeralUpdate(interaction, { content: "レースが見つかりません", components: [] });
        if (own.rows[0].host_id !== interaction.user.id)
          return ephemeralUpdate(interaction, { content: "このレースのホストではありません", components: [] });

        const bets = await pool.query(
          `SELECT user_id, horse, SUM(amount)::bigint AS total_amount
           FROM rumuma_bets WHERE race_id=$1 GROUP BY user_id, horse`,
          [raceId]
        );
        const horses = own.rows[0].horses || [];
        const totalPot = bets.rows.reduce((s, b) => s + Number(b.total_amount), 0);
        const byHorse = new Map(horses.map(h => [h, 0]));
        for (const b of bets.rows) byHorse.set(b.horse, (byHorse.get(b.horse) || 0) + Number(b.total_amount));

        let lines = `🏇 **Race:${raceId} ${own.rows[0].race_name}**\n💰 総額: ${fmt(totalPot)}S\n\n`
        for (const h of horses) {
          const betSum = byHorse.get(h) || 0;
          const odds = betSum > 0 ? (totalPot / betSum).toFixed(2) : "賭けなし";
          lines += `🐴 ${h} — 合計: ${fmt(betSum)}S | オッズ: ${odds}\n`;
          const betters = bets.rows.filter(b => b.horse === h);
          if (betters.length) lines += betters.map(b => `　・<@${b.user_id}> ${fmt(b.total_amount)}S`).join("\n") + "\n";
          lines += "\n";
        }
        return ephemeralUpdate(interaction, { embeds: [createEmbed("👀 賭け状況", lines, Colors.Aqua)], components: [] });
      }

      // オッズ確認：レース選択後 → 倍率のみを即表示
      if (interaction.customId === "select_odds_race") {
        const raceId = parseInt(interaction.values[0], 10);
        const r = await pool.query(`SELECT race_name, horses FROM rumuma_races WHERE id=$1 AND finished=false`, [raceId]);
        if (!r.rowCount) return ephemeralUpdate(interaction, { content: "レースが見つからないか締切済みです", components: [] });
        const raceName = r.rows[0].race_name;
        const horses = r.rows[0].horses || [];

        const bets = await pool.query(
          `SELECT horse, SUM(amount)::bigint AS sum FROM rumuma_bets WHERE race_id=$1 GROUP BY horse`,
          [raceId]
        );
        const byHorse = new Map(horses.map(h => [h, 0]));
        for (const row of bets.rows) byHorse.set(row.horse, Number(row.sum));
        const totalPot = Array.from(byHorse.values()).reduce((s, n) => s + n, 0);

        let lines = `🏇 **Race:${raceId} ${raceName}**\n💰 総額: ${fmt(totalPot)}S\n\n`;
        for (const h of horses) {
          const sum = byHorse.get(h) || 0;
          const odds = (sum > 0 && totalPot > 0) ? (totalPot / sum).toFixed(2) : "—";
          lines += `🐴 ${h} — オッズ: ${odds}\n`;
        }
        return ephemeralUpdate(interaction, { embeds: [createEmbed("📈 現時点オッズ（倍率のみ）", lines, Colors.Aqua)], components: [] });
      }
    }

    /* ---------- モーダル ---------- */
    if (interaction.type === InteractionType.ModalSubmit) {
      // 管理：コイン調整
      if (interaction.customId === "admin_adjust_modal") {
        const uid = interaction.fields.getTextInputValue("target_user").trim();
        const amount = parseInt(interaction.fields.getTextInputValue("amount"), 10);
        if (!Number.isFinite(amount)) return ephemeralReply(interaction, { content: "金額が不正です" });
        await addCoins(uid, amount, "admin_adjust", "管理者操作");
        return ephemeralReply(interaction, { content: `ユーザー:${uid} に ${fmt(amount)} 調整しました` });
      }

      // [DISABLED:slot_config_modal] 旧UIからの誤動作対策
      if (interaction.customId === "slot_config_modal") {
        return ephemeralReply(interaction, { content: "🎰 ジャグラー設定は削除済みです。" }, 20000);
      }

      // レース作成
      if (interaction.customId === "rumuma_create_modal") {
        const raceName = interaction.fields.getTextInputValue("race_name").trim();
        const horses = interaction.fields.getTextInputValue("horses").split(/[\n,、,]/).map(h => h.trim()).filter(Boolean);
        if (horses.length < 2) return ephemeralReply(interaction, { content: "ウマは2頭以上必要です" });

        const res = await pool.query(
          `INSERT INTO rumuma_races(channel_id, host_id, race_name, horses, finished)
           VALUES($1,$2,$3,$4,false) RETURNING id`,
          [interaction.channelId, interaction.user.id, raceName, horses]
        );
        return ephemeralReply(interaction, { content: `レース作成完了🎉 ID:${res.rows[0].id} ${raceName}` });
      }

      // ウマ券購入：金額確定
      if (interaction.customId.startsWith("rumuma_bet_amount_modal_")) {
        const after = interaction.customId.replace("rumuma_bet_amount_modal_", "");
        const [raceIdStr, horseEncoded] = after.split("__");
        const raceId = parseInt(raceIdStr, 10);
        const horse = decodeURIComponent(horseEncoded);

        const amountsRaw = interaction.fields.getTextInputValue("amounts").trim();
        const amounts = amountsRaw.split(/[,\s]+/).map(a => parseInt(a, 10)).filter(n => Number.isFinite(n) && n > 0);
        if (!amounts.length) return ephemeralReply(interaction, { content: "金額が不正です" });

        const raceRes = await pool.query(`SELECT horses, finished, host_id, race_name FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!raceRes.rowCount) return ephemeralReply(interaction, { content: "レースが見つかりません" });
        if (raceRes.rows[0].finished) return ephemeralReply(interaction, { content: "このレースは締切済みです" });
        if (!raceRes.rows[0].horses.includes(horse)) return ephemeralReply(interaction, { content: "そのウマは出走していません" });

        const total = amounts.reduce((s, n) => s + n, 0);

        const balRes = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [interaction.user.id]);
        const balance = balRes.rowCount ? Number(balRes.rows[0].balance) : 0;
        if (balance < total) return ephemeralReply(interaction, { content: `残高不足：必要 ${fmt(total)}S / 保有 ${fmt(balance)}S` });

        // 購入直前のオッズ（倍率のみ）
        const betsSnap = await pool.query(
          `SELECT horse, SUM(amount)::bigint AS sum FROM rumuma_bets WHERE race_id=$1 GROUP BY horse`,
          [raceId]
        );
        const totalPotSnap = betsSnap.rows.reduce((s, b) => s + Number(b.sum), 0);
        const horseSumSnap = Number(betsSnap.rows.find(b => b.horse === horse)?.sum || 0);
        const oddsSnap = horseSumSnap > 0 ? (totalPotSnap / horseSumSnap).toFixed(2) : "賭けなし";

        await addCoins(interaction.user.id, -total, "rumuma_bet", `Race:${raceId} Bet:${horse} x${amounts.length}`);

        for (const amt of amounts) {
          await pool.query(
            `INSERT INTO rumuma_bets(race_id, user_id, horse, amount) VALUES($1,$2,$3,$4)`,
            [raceId, interaction.user.id, horse, amt]
          );
        }

        return ephemeralReply(interaction, {
          content: `購入完了：Race:${raceId} ${horse} に [${amounts.map(fmt).join(", ")}]S\n現在の残高：${fmt(balance - total)}S\n倍率(購入直前): ${oddsSnap}`
        });
      }

      // SSRロール作成（ガチャ）
      if (interaction.customId === "gacha_ssr_modal") {
        const roleName = interaction.fields.getTextInputValue("role_name").trim();
        let roleColor = (interaction.fields.getTextInputValue("role_color").trim() || "#FFD700");
        if (!/^#?[0-9A-Fa-f]{6}$/.test(roleColor)) roleColor = "#FFD700";
        if (!roleColor.startsWith("#")) roleColor = "#" + roleColor;

        const guild = interaction.guild;
        if (!guild) return;

        try {
          const role = await guild.roles.create({
            name: roleName,
            color: roleColor,
            permissions: [],
            reason: `SSRガチャ当選 by ${interaction.user.tag}`
          });

          const botHighest = guild.members.me.roles.highest;
          const newPos = Math.max(1, botHighest.position - 1);
          await role.setPosition(newPos).catch(() => {});
          const member = await guild.members.fetch(interaction.user.id).catch(() => null);
          if (member) await member.roles.add(role).catch(() => {});
          setTimeout(async () => { await role.delete("SSRロール有効期限切れ").catch(() => {}); }, 7 * 24 * 60 * 60 * 1000);

          return ephemeralReply(interaction, {
            embeds: [createEmbed("SSR当選 🎉", `ロール **${roleName}** を作成し付与しました！（色:${roleColor}）\nこのロールは **Botロール直下** に配置され、1週間後に自動削除されます。`, Colors.Gold)]
          }, 30000);
        } catch (e) {
          console.error("SSRロール作成失敗:", e);
          return ephemeralReply(interaction, { embeds: [createEmbed("SSRロール", "ロール作成に失敗しました。Botロールの位置と権限を確認してください。", Colors.Red)] }, 30000);
        }
      }
    }
  } catch (err) {
    console.error("interaction error:", err);
    if (interaction.isRepliable?.()) {
      await ephemeralReply(interaction, { content: "処理中にエラーが発生しました" }).catch(() => {});
    }
  }
});

// ==============================
// 発言報酬（スパム抑止）
// ==============================
const NG_WORDS = new Set(["ああ", "いい", "あ", "い", "う", "え", "お", "草", "w", "ｗ"]);
const hashMessage = (t) => crypto.createHash("sha1").update(t).digest("hex");

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot || !msg.guild) return;

    // ロール制限
    if (REWARD_ROLE_ID) {
      const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
      if (!member || !member.roles.cache.has(REWARD_ROLE_ID)) return;
    }

    const content = (msg.content || "").trim();
    if (!content) return;
    if (NG_WORDS.has(content) || content.length <= 2) return;

    const today = new Date().toISOString().slice(0, 10); // UTC基準
    const h = hashMessage(content);

    const inserted = await pool.query(
      `INSERT INTO message_rewards(user_id, date, count, last_message_at, last_message_hash)
       VALUES ($1,$2,1,NOW(),$3)
       ON CONFLICT (user_id) DO NOTHING`,
      [msg.author.id, today, h]
    );
    if (inserted.rowCount) {
      await addCoins(msg.author.id, REWARD_PER_MESSAGE, "msg_reward", "初回メッセージ報酬");
      return;
    }

    const res = await pool.query(`SELECT * FROM message_rewards WHERE user_id=$1`, [msg.author.id]);
    if (!res.rowCount) return;
    const row = res.rows[0];

    if (row.date !== today) {
      await pool.query(`UPDATE message_rewards SET date=$1, count=0 WHERE user_id=$2`, [today, msg.author.id]);
      row.count = 0;
    }
    if (row.count >= REWARD_DAILY_LIMIT) return;

    const lastAt = row.last_message_at ? new Date(row.last_message_at).getTime() : 0;
    const diffSec = (Date.now() - lastAt) / 1000;
    if (diffSec < REWARD_COOLDOWN_SEC) return;
    if (row.last_message_hash && row.last_message_hash === h) return;

    await addCoins(msg.author.id, REWARD_PER_MESSAGE, "msg_reward", "メッセージ報酬");
    await pool.query(
      `UPDATE message_rewards
       SET count=count+1, last_message_at=NOW(), last_message_hash=$1
       WHERE user_id=$2`,
      [h, msg.author.id]
    );
  } catch (e) {
    console.error("message reward error:", e);
  }
});

// ==============================
// デイリー受取リセット（JST 05:00）
// ==============================
schedule.scheduleJob("0 20 * * *", async () => { // UTC20:00 = JST05:00
  await pool.query("DELETE FROM daily_claims");
  console.log("✅ デイリー受取リセット完了 (JST05:00)");
});

// ==============================
// READY
// ==============================
async function trySendUIById(id, type) {
  const ch = await client.channels.fetch(id).catch(() => null);
  if (ch) await sendUI(ch, type);
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await ensureTables();

  if (process.env.ADMIN_CHANNEL_ID) {
    await trySendUIById(process.env.ADMIN_CHANNEL_ID, "admin");
  }
  if (process.env.DAILY_CHANNEL_ID) {
    await trySendUIById(process.env.DAILY_CHANNEL_ID, "daily");
  }
  if (process.env.RUMUMA_CHANNELS) {
    for (const cid of process.env.RUMUMA_CHANNELS.split(",").map(s => s.trim()).filter(Boolean)) {
      await trySendUIById(cid, "rumuma");
    }
  }
  // [REMOVED:CASINO_BOOT] カジノUI自動送信は削除
});

client.login(process.env.DISCORD_TOKEN);

// ==============================
// HTTP サーバ（Render）
// ==============================
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!\n");
}).listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
});

// ✅ 完全出力完了（JUGGLER REMOVED）
