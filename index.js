// index.js （"type": "module" 前提）
import { initUMA } from "./uma.js";
import {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, InteractionType, PermissionsBitField,
  Events
} from "discord.js";
import { Pool } from "pg";
import dotenv from "dotenv";
import schedule from "node-schedule";
import crypto from "crypto";
import http from "http";

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* ==============================
   クライアント
============================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // 発言報酬で本文を見るため
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

/* ==============================
   環境設定
============================== */
const DAILY_AMOUNT        = parseInt(process.env.DAILY_AMOUNT || "100", 10);
const REWARD_ROLE_ID      = process.env.REWARD_ROLE_ID || "";
const REWARD_PER_MESSAGE  = parseInt(process.env.REWARD_PER_MESSAGE || "10", 10);
const REWARD_DAILY_LIMIT  = parseInt(process.env.REWARD_DAILY_LIMIT || "10", 10);
const REWARD_COOLDOWN_SEC = parseInt(process.env.REWARD_COOLDOWN_SEC || "45", 10);

/* ==============================
   ユーティリティ
============================== */
function createEmbed(title, desc, color = "Blue") {
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

async function ephemeralReply(interaction, payload, ms = 15000) {
  const data = { ...payload };
  if (typeof data.content === "string") data.content = limitContent(data.content);
  const msg = await interaction.reply({ ...data, flags: 64 });
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
  return msg;
}
async function ephemeralUpdate(interaction, payload, ms = 15000) {
  const data = { ...payload };
  if (typeof data.content === "string") data.content = limitContent(data.content);
  const msg = await interaction.update(data);
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
  return msg;
}

async function addCoins(userId, amount, type, note = null) {
  const n = Number(amount) | 0;
  await pool.query(
    `INSERT INTO coins (user_id, balance)
     VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET balance = coins.balance + $2`,
    [userId, n]
  );
  await pool.query(
    `INSERT INTO history (user_id, type, amount, note, created_at)
     VALUES ($1,$2,$3,$4,NOW())`,
    [userId, type, n, note]
  );
}

/* ==============================
   DBテーブル初期化
============================== */
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coins (
      user_id  TEXT PRIMARY KEY,
      balance  INTEGER DEFAULT 0
    );
  `);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_claims (
      user_id TEXT PRIMARY KEY,
      last_claim TEXT
    );
  `);

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
}
/* ==============================
   レース：開催中止（返金 & 履歴）
============================== */
async function refundRumuma(raceId, reason = "開催中止") {
  const raceRes = await pool.query(`SELECT race_name, horses FROM rumuma_races WHERE id=$1`, [raceId]);
  const betsRes = await pool.query(`SELECT amount, user_id FROM rumuma_bets WHERE race_id=$1`, [raceId]);

  let totalPot = 0;
  for (const b of betsRes.rows) totalPot += Number(b.amount);

  // 全額返金
  for (const b of betsRes.rows) {
    await addCoins(b.user_id, b.amount, "rumuma_refund", `Race:${raceId} ${reason}`);
  }

  // 履歴保存（開催中止）
  await pool.query(
    `INSERT INTO rumuma_results(race_id, race_name, horses, winner, total_pot, status, finished_at)
     VALUES ($1,$2,$3,$4,$5,'canceled',NOW())`,
    [raceId, raceRes.rows[0]?.race_name || "", raceRes.rows[0]?.horses || [], null, totalPot]
  );

  // データ削除
  await pool.query(`DELETE FROM rumuma_bets WHERE race_id=$1`, [raceId]);
  await pool.query(`DELETE FROM rumuma_races WHERE id=$1`, [raceId]);
}

/* ==============================
   UI（管理／コイン／レース）
============================== */
async function sendUI(channel, type) {
  if (type === "admin") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_adjust").setLabel("⚙️ ユーザーコイン増減").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("view_history_admin").setLabel("📜 全員取引履歴").setStyle(ButtonStyle.Secondary)
    );
    await channel.send({ content: "管理メニュー", components: [row] });
  }

  if (type === "daily") {
    // 希望どおり「デイリーコイン」に名称変更 & ガチャを横に配置
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("daily_claim").setLabel("🎁 デイリーコイン").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("gacha_play").setLabel("🎰 ガチャ").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("check_balance").setLabel("💰 残高確認").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("view_history_user").setLabel("📜 取引履歴").setStyle(ButtonStyle.Secondary)
    );
    await channel.send({ content: "コインメニュー", components: [row] });
  }

  if (type === "rumuma") {
    // 行1
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rumuma_create").setLabel("🏇 レース作成").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("rumuma_list").setLabel("📃 レース一覧").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rumuma_bet").setLabel("🎫 ウマ券購入").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("rumuma_my_bets").setLabel("🎫 ウマ券確認").setStyle(ButtonStyle.Secondary)
    );
    // 行2
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rumuma_close_bets").setLabel("✅ 投票締切").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rumuma_report_result").setLabel("🏆 結果報告").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("rumuma_cancel").setLabel("⛔ 開催中止").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rumuma_history").setLabel("🗂 競争履歴").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rumuma_claim_rewards").setLabel("💳 払い戻し").setStyle(ButtonStyle.Primary)
    );
    // 行3
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("check_balance").setLabel("💰 残高確認").setStyle(ButtonStyle.Secondary)
    );

    await channel.send({ content: "レースメニュー", components: [row1, row2, row3] });
  }
}

/* ==============================
   ガチャ処理（SSRロール付き）
============================== */
async function playGacha(interaction) {
  const uid = interaction.user.id;
  const cost = 30;

  // 残高チェック
  const balRes = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [uid]);
  const balance = balRes.rowCount ? Number(balRes.rows[0].balance) : 0;
  if (balance < cost) {
    return ephemeralReply(interaction, { embeds: [createEmbed("ガチャ", `残高不足：必要 ${fmt(cost)}S / 保有 ${fmt(balance)}S`, "Red")] });
  }

  // 消費
  await addCoins(uid, -cost, "gacha", "ガチャを回した");

  // 抽選
  const roll = Math.random();
  let rarity = "S", reward = 5;
  if (roll < 0.70) { rarity = "S"; reward = 5; }
  else if (roll < 0.95) { rarity = "SR"; reward = 10; }
  else { rarity = "SSR"; reward = 50; }

  // 報酬付与
  await addCoins(uid, reward, "gacha_reward", `ガチャ当選:${rarity}`);

  // SSRはモーダルへ（ロール名・色をユーザーに入力させる）
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
    // まず当選の通知だけ返す（エフェメラル）
    await ephemeralReply(interaction, {
      embeds: [createEmbed("🎰 ガチャ結果", `**${rarity}** 当選！\n🟢 +${fmt(reward)}S\nこのあとロール作成画面が開きます。`, "Gold")]
    });
    return interaction.showModal(modal);
  }

  // SSR以外は即返答
  return ephemeralReply(interaction, {
    embeds: [createEmbed("🎰 ガチャ結果", `結果: **${rarity}**\n🟢 +${fmt(reward)}S`, rarity === "SR" ? "Purple" : "Grey")]
  });
}

/* ==============================
   Interaction（ボタン／セレクト／モーダル）
============================== */
client.on("interactionCreate", async (interaction) => {
  // 簡易ログ
  console.log("🔹 interaction received:", {
    type: interaction.type,
    customId: interaction.customId || null,
    isButton: interaction.isButton?.() || false,
    isSelectMenu: interaction.isStringSelectMenu?.() || false,
    isModal: interaction.type === InteractionType.ModalSubmit
  });

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

          const res = await pool.query(`SELECT * FROM history ORDER BY created_at DESC LIMIT 20`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "履歴はありません" });

          const lines = res.rows.map(r =>
            `${formatJST(r.created_at)} | ${r.user_id} | ${r.type} | ${fmt(r.amount)} | ${r.note || ""}`
          ).join("\n");

          return ephemeralReply(interaction, { content: "直近20件\n" + lines });
        }

        /* ===== コイン（デイリー／残高／個人履歴／ガチャ） ===== */
        case "daily_claim": {
          const uid = interaction.user.id;
          const today = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo" })
            .formatToParts(new Date())
            .filter(p => ["year","month","day"].includes(p.type))
            .map(p => p.value).join("-");

          const res = await pool.query(`SELECT last_claim FROM daily_claims WHERE user_id=$1`, [uid]);
          if (res.rowCount && res.rows[0].last_claim === today)
            return ephemeralReply(interaction, { embeds: [createEmbed("コイン", "今日はもう受け取り済みです", "Red")] });

          await pool.query(
            `INSERT INTO daily_claims (user_id, last_claim)
             VALUES ($1,$2)
             ON CONFLICT(user_id) DO UPDATE SET last_claim=$2`,
            [uid, today]
          );
          await addCoins(uid, DAILY_AMOUNT, "daily", "デイリー報酬");
          return ephemeralReply(interaction, { embeds: [createEmbed("コイン", `${fmt(DAILY_AMOUNT)}Sを受け取りました！`, "Green")] });
        }

        case "check_balance": {
          const uid = interaction.user.id;
          const res = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [uid]);
          const bal = res.rowCount ? Number(res.rows[0].balance) : 0;
          return ephemeralReply(interaction, { embeds: [createEmbed("残高確認", `${fmt(bal)} S`)] });
        }

        case "view_history_user": {
          const uid = interaction.user.id;
          const res = await pool.query(`SELECT * FROM history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [uid]);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "履歴はありません" });

          const lines = res.rows.map(r =>
            `${formatJST(r.created_at)} | ${r.type} | ${fmt(r.amount)} | ${r.note || ""}`
          ).join("\n");

          return ephemeralReply(interaction, { content: "あなたの直近20件\n" + lines });
        }

        case "gacha_play": {
          return playGacha(interaction);
        }

        /* ===== レース：一覧 ===== */
        case "rumuma_list": {
          const res = await pool.query(`SELECT * FROM rumuma_races ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "レースはありません" });

          const list = res.rows.map(r =>
            `ID:${r.id} ${r.race_name}（${(r.horses || []).join(", ")}） ${r.finished ? "[締切]" : "[開催中]"}`
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

        /* ===== レース：ウマ券購入（レース→ウマ→金額） ===== */
        case "rumuma_bet": {
          const res = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "購入可能なレースがありません" });

          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_bet_race")
            .setPlaceholder("購入するレースを選択")
            .addOptions(res.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));

          return ephemeralReply(interaction, {
            content: "レースを選択してください",
            components: [new ActionRowBuilder().addComponents(menu)]
          });
        }

        /* ===== 自分のウマ券確認（未決着のみ） ===== */
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

          const lines = active.map(row =>
            `Race:${row.race_id} ${row.race_name} - ${row.horse} に ${fmt(row.total_amount)}S`
          ).join("\n");

          return ephemeralReply(interaction, { content: "あなたの未決着ウマ券\n" + lines });
        }

        /* ===== 投票締切（レース選択→締切） ===== */
        case "rumuma_close_bets": {
          const res = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "締切対象のレースがありません" });

          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_close_race")
            .setPlaceholder("締切するレースを選択")
            .addOptions(res.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));

          return ephemeralReply(interaction, {
            content: "締切するレースを選択してください",
            components: [new ActionRowBuilder().addComponents(menu)]
          });
        }

        /* ===== 結果報告（締切済レース → 勝者選択） ===== */
        case "rumuma_report_result": {
          const res = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=true ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "結果報告可能なレースがありません（まず締切してください）" });

          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_result_race")
            .setPlaceholder("結果報告するレースを選択")
            .addOptions(res.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));

          return ephemeralReply(interaction, {
            content: "結果報告するレースを選択してください",
            components: [new ActionRowBuilder().addComponents(menu)]
          });
        }

        /* ===== 開催中止（管理者のみ） ===== */
        case "rumuma_cancel": {
          if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
            return ephemeralReply(interaction, { content: "管理者権限が必要です" });

          const res = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "中止できるレースがありません" });

          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_cancel_race")
            .setPlaceholder("開催中止するレースを選択")
            .addOptions(res.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));

          return ephemeralReply(interaction, {
            content: "開催中止するレースを選択してください（全額返金）",
            components: [new ActionRowBuilder().addComponents(menu)]
          });
        }

        /* ===== 競争履歴（直近10件） ===== */
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

        /* ===== 払い戻し（未受け取り一括受取） ===== */
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

          // レース単位で集計
          const byRace = new Map();
          for (const row of res.rows) {
            const key = `${row.race_id}::${row.race_name}`;
            if (!byRace.has(key)) byRace.set(key, 0);
            byRace.set(key, byRace.get(key) + Number(row.amount));
          }
          const total = Array.from(byRace.values()).reduce((s, n) => s + n, 0);

          // 先に受け取り
          await addCoins(uid, total, "reward_claim", `払い戻し一括受け取り ${res.rowCount}件`);
          await pool.query(`UPDATE pending_rewards SET claimed=true WHERE user_id=$1 AND claimed=false`, [uid]);

          const breakdown = Array.from(byRace.entries())
            .map(([key, sum]) => {
              const [rid, rname] = key.split("::");
              return `・Race:${rid} ${rname} …… ${fmt(sum)}S`;
            })
            .join("\n");

          const text = `以下の払い戻しを受け取りました！\n${breakdown}\n———\n合計：${fmt(total)}S`;
          return ephemeralReply(interaction, { content: text });
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

      // 購入：ウマ選択 → 金額入力
      if (interaction.customId.startsWith("select_bet_horse_")) {
        const raceId = parseInt(interaction.customId.split("_")[3], 10);
        const horse = interaction.values[0];

        const modal = new ModalBuilder()
          .setCustomId(`rumuma_bet_amount_modal_${raceId}__${encodeURIComponent(horse)}`)
          .setTitle(`ウマ券購入: ${horse}`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("amounts")
                .setLabel("金額（半角スペース/カンマ区切りで複数可）")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      // 締切：レース選択 → finished=true
      if (interaction.customId === "select_close_race") {
        const raceId = parseInt(interaction.values[0], 10);
        await pool.query(`UPDATE rumuma_races SET finished=true WHERE id=$1`, [raceId]);
        return ephemeralUpdate(interaction, { content: `レースID:${raceId} のウマ券購入を締め切りました`, components: [] });
      }

      // 結果報告：レース選択 → 勝者選択
      if (interaction.customId === "select_result_race") {
        const raceId = parseInt(interaction.values[0], 10);
        const r = await pool.query(`SELECT horses, race_name FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!r.rowCount) return ephemeralUpdate(interaction, { content: "レースが見つかりません", components: [] });

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`select_winner_${raceId}`)
          .setPlaceholder("勝者を選んでください")
          .addOptions((r.rows[0].horses || []).map(h => ({ label: h, value: h })));

        return ephemeralUpdate(interaction, {
          content: `レースID:${raceId} 勝者を選択してください`,
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }

      // 開催中止：返金 & 履歴保存 & データ削除（管理者のみ）
      if (interaction.customId === "select_cancel_race") {
        if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
          return ephemeralUpdate(interaction, { content: "管理者権限が必要です", components: [] });
        const raceId = parseInt(interaction.values[0], 10);
        await refundRumuma(raceId, "開催中止");
        return ephemeralUpdate(interaction, { content: `レースID:${raceId} は開催中止になりました（全額返金 & 履歴保存）`, components: [] });
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

      // ウマ券購入（複数金額OK）
      if (interaction.customId.startsWith("rumuma_bet_amount_modal_")) {
        const after = interaction.customId.replace("rumuma_bet_amount_modal_", "");
        const [raceIdStr, horseEncoded] = after.split("__");
        const raceId = parseInt(raceIdStr, 10);
        const horse = decodeURIComponent(horseEncoded);

        const amountsRaw = interaction.fields.getTextInputValue("amounts").trim();
        const amounts = amountsRaw.split(/[,\s]+/).map(a => parseInt(a, 10)).filter(n => Number.isFinite(n) && n > 0);
        if (!amounts.length) return ephemeralReply(interaction, { content: "金額が不正です" });

        const raceRes = await pool.query(`SELECT horses, finished FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!raceRes.rowCount) return ephemeralReply(interaction, { content: "レースが見つかりません" });
        if (raceRes.rows[0].finished) return ephemeralReply(interaction, { content: "このレースは締切済みです" });
        if (!raceRes.rows[0].horses.includes(horse)) return ephemeralReply(interaction, { content: "そのウマは出走していません" });

        const total = amounts.reduce((s, n) => s + n, 0);

        // 残高チェック
        const balRes = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [interaction.user.id]);
        const balance = balRes.rowCount ? Number(balRes.rows[0].balance) : 0;
        if (balance < total) return ephemeralReply(interaction, { content: `残高不足：必要 ${fmt(total)}S / 保有 ${fmt(balance)}S` });

        // 合計分減算＋履歴
        await addCoins(interaction.user.id, -total, "rumuma_bet", `Race:${raceId} Bet:${horse} x${amounts.length}`);

        // チケット単位で記録
        for (const amt of amounts) {
          await pool.query(
            `INSERT INTO rumuma_bets(race_id, user_id, horse, amount) VALUES($1,$2,$3,$4)`,
            [raceId, interaction.user.id, horse, amt]
          );
        }
        return ephemeralReply(interaction, { content: `購入完了：Race:${raceId} ${horse} に [${amounts.map(fmt).join(", ")}]S` });
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
          // 新規ロール作成（毎回1人専用）
          const role = await guild.roles.create({
            name: roleName,
            color: roleColor,
            permissions: [],
            reason: `SSRガチャ当選 by ${interaction.user.tag}`
          });

          // @everyone 直下へ
          const everyoneRole = guild.roles.everyone;
          await role.setPosition(everyoneRole.position + 1).catch(() => {});

          // 当選者に付与
          const member = await guild.members.fetch(interaction.user.id).catch(() => null);
          if (member) await member.roles.add(role);

          // 1週間後に自動削除（通知なし）
          setTimeout(async () => {
            await role.delete("SSRロール有効期限切れ").catch(() => {});
          }, 7 * 24 * 60 * 60 * 1000);

          return ephemeralReply(interaction, {
            embeds: [createEmbed("SSR当選 🎉",
              `ロール **${roleName}** を作成し付与しました！（色:${roleColor}）\nこのロールは **@everyone直下** に配置され、1週間後に自動削除されます。`,
              "Gold"
            )]
          });
        } catch (e) {
          console.error("SSRロール作成失敗:", e);
          return ephemeralReply(interaction, { embeds: [createEmbed("SSRロール", "ロール作成に失敗しました。Botロールの位置と権限を確認してください。", "Red")] });
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

/* ==============================
   発言報酬（ロール制・1日上限・連投/スパムNG）
============================== */
const NG_WORDS = new Set(["ああ", "いい", "あ", "い", "う", "え", "お", "草", "w", "ｗ"]);
const hashMessage = (t) => crypto.createHash("sha1").update(t).digest("hex");

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot || !msg.guild) return;

    // 対象ロールのみ（指定があれば）
    if (REWARD_ROLE_ID) {
      const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
      if (!member || !member.roles.cache.has(REWARD_ROLE_ID)) return;
    }

    const content = (msg.content || "").trim();
    if (!content) return;
    if (NG_WORDS.has(content) || content.length <= 2) return; // 超短文・NG語除外

    const today = new Date().toISOString().slice(0, 10); // UTC基準
    const h = hashMessage(content);

    const res = await pool.query(`SELECT * FROM message_rewards WHERE user_id=$1`, [msg.author.id]);
    if (!res.rowCount) {
      await pool.query(
        `INSERT INTO message_rewards(user_id, date, count, last_message_at, last_message_hash)
         VALUES ($1,$2,1,NOW(),$3)`,
        [msg.author.id, today, h]
      );
      await addCoins(msg.author.id, REWARD_PER_MESSAGE, "msg_reward", "初回メッセージ報酬");
      return;
    }

    const row = res.rows[0];

    // 日付切替
    if (row.date !== today) {
      await pool.query(`UPDATE message_rewards SET date=$1, count=0 WHERE user_id=$2`, [today, msg.author.id]);
      row.count = 0;
    }

    // 上限
    if (row.count >= REWARD_DAILY_LIMIT) return;

    // クールダウン（連投NG）
    const lastAt = row.last_message_at ? new Date(row.last_message_at).getTime() : 0;
    const diffSec = (Date.now() - lastAt) / 1000;
    if (diffSec < REWARD_COOLDOWN_SEC) return;

    // 同一文連続NG
    if (row.last_message_hash && row.last_message_hash === h) return;

    // 付与
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

/* ==============================
   デイリー集計リセット（UTC 05:00）
============================== */
schedule.scheduleJob("0 5 * * *", async () => {
  await pool.query("DELETE FROM daily_claims");
  console.log("✅ デイリー受取リセット完了");
});

/* ==============================
   READY
============================== */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  await ensureTables();

  if (process.env.ADMIN_CHANNEL_ID) {
    const ch = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID).catch(() => null);
    if (ch) await sendUI(ch, "admin");
  }
  if (process.env.DAILY_CHANNEL_ID) {
    const ch = await client.channels.fetch(process.env.DAILY_CHANNEL_ID).catch(() => null);
    if (ch) await sendUI(ch, "daily");
  }
  if (process.env.RUMUMA_CHANNELS) {
    for (const cid of process.env.RUMUMA_CHANNELS.split(",").map(s => s.trim()).filter(Boolean)) {
      const ch = await client.channels.fetch(cid).catch(() => null);
      if (ch) await sendUI(ch, "rumuma");
    }
  }
// ✅ UMA機能の初期化（最後に呼び出す）
  initUMA(client, pool, ephemeralReply, ephemeralUpdate, addCoins, fmt, createEmbed);
});
client.login(process.env.DISCORD_TOKEN);

/* ==============================
   HTTP サーバ（Render Web Service 用）
============================== */
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!\n");
}).listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
});
