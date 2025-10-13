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
const LOG_LEVEL           = (process.env.LOG_LEVEL || "info").toLowerCase();

// ★ コインUI（デイリー/ガチャ）用チャンネル（SSR祝福メッセの出力先）
const DAILY_CHANNEL_ID    = process.env.DAILY_CHANNEL_ID || "";

// ★ カジノUI自動配置先（明示ID優先／envで上書き可）
const STATIC_CASINO_CHANNEL_ID = "1424340886585868368";
const CASINO_CHANNEL_ID        = process.env.CASINO_CHANNEL_ID || STATIC_CASINO_CHANNEL_ID;

// ★ ガチャ経済（調整ブロック）
const GACHA_COST = parseInt(process.env.GACHA_COST || "40", 10);
const GACHA_SSR_REWARD = parseInt(process.env.GACHA_SSR_REWARD || "300", 10); // ★ 追加：ENVで増額調整
// 累積確率で判定（p は累積）
const GACHA_TABLE = [
  { p: 0.74, rarity: "S",   reward: 6,   color: Colors.Grey  },
  { p: 0.98, rarity: "SR",  reward: 15,  color: Colors.Purple},
  { p: 1.00, rarity: "SSR", reward: GACHA_SSR_REWARD, color: Colors.Gold  },
];

// ★ カジノ全体バランス
const CASINO_BET_DEFAULT  = parseInt(process.env.CASINO_BET_DEFAULT || "10", 10);
const CASINO_BET_MAX      = parseInt(process.env.CASINO_BET_MAX || "500", 10); // 賭け上限
const DOUBLEUP_MAX_STEPS  = parseInt(process.env.DOUBLEUP_MAX_STEPS || "3", 10);
const DOUBLEUP_WIN_RATE   = Number(process.env.DOUBLEUP_WIN_RATE || "0.48");   // ハウスエッジ少し
const SIGNING_SECRET      = process.env.SIGNING_SECRET || "sdgs-secret";

// ==============================
// ユーティリティ
// ==============================
function logInfo(...a){ if (LOG_LEVEL !== "error") console.log(...a); }
function logError(...a){ console.error(...a); }

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

// ========== 重要：インタラクション安全応答の統一口 ==========
// 状況に応じて update / editReply / reply / followUp を自動選択
async function respond(interaction, payload, { ephemeral = false } = {}) {
  const data = { ...payload };
  if (typeof data.content === "string") data.content = limitContent(data.content);

  try {
    // 1) ボタン/セレクトは update() を最優先（元メッセージを直接更新）
    if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
      try { return await interaction.update(data); } catch (_) {}
    }
    // 2) すでに応答済 or defer済は editReply()
    if (interaction.deferred || interaction.replied) {
      try { return await interaction.editReply(data); } catch (_) {}
    }
    // 3) まだ未応答なら reply()
    try { return await interaction.reply({ ...data, ephemeral }); } catch (_) {}
    // 4) それでもダメなら followUp()
    return await interaction.followUp({ ...data, ephemeral: true });
  } catch (e) {
    logError("respond() failed:", e);
    // どうしても失敗したら最後に握りつぶす（Unknown interaction回避）
    try { return await interaction.deferUpdate(); } catch {}
  }
}

async function ephemeralReply(interaction, payload, ms = 15000) {
  const msg = await respond(interaction, payload, { ephemeral: true });
  // ephemeralは自動消滅しないため必要なら明示削除
  setTimeout(() => interaction.deleteReply?.().catch(() => {}), ms);
  return msg;
}

// 互換：既存コードの ephemeralUpdate を respond に委譲（ephemeral固定）
async function ephemeralUpdate(interaction, payload) {
  return respond(interaction, payload, { ephemeral: true });
}

// 署名（customId改ざん防止）
function signToken(payloadStr){
  const mac = crypto.createHmac("sha256", SIGNING_SECRET).update(payloadStr).digest("hex").slice(0,24);
  return mac;
}
function verifyToken(payloadStr, sig){
  try{
    return signToken(payloadStr) === sig;
  }catch{ return false; }
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

async function getBalance(userId) {
  const r = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [userId]);
  return r.rowCount ? Number(r.rows[0].balance) : 0;
}
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// 賭け額の解決（上限・残高・最小）
async function resolveBet(userId, requested) {
  const bal = await getBalance(userId);
  const maxByBalance = Math.max(0, Math.min(bal, CASINO_BET_MAX));
  const req = Math.max(1, Number.isFinite(requested) ? requested : CASINO_BET_DEFAULT);
  return Math.max(1, Math.min(req, maxByBalance));
}

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS casino_sessions (
      user_id TEXT PRIMARY KEY,
      game TEXT,
      stake INTEGER,
      step INTEGER,
      updated_at TIMESTAMP DEFAULT now()
    );
  `);
}

// ==============================
// レース中止（返金）
// ==============================
async function refundRumuma(raceId, reason = "開催中止") {
  const raceRes = await pool.query(`SELECT race_name, horses FROM rumuma_races WHERE id=$1`, [raceId]);
  const betsRes = await pool.query(`SELECT amount, user_id FROM rumuma_bets WHERE race_id=$1`, [raceId]);

  for (const b of betsRes.rows) {
    await addCoins(b.user_id, b.amount, "rumuma_refund", `Race:${raceId} ${reason}`);
  }

  const totalPot = betsRes.rows.reduce((s,b)=>s+Number(b.amount),0);
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
    case "casino_slot": typeLabel = "🎰（削除済）ジャグラー"; color = Colors.Grey; break;
    case "daily":       typeLabel = "🎁 デイリー";   color = Colors.Green;  break;
    case "msg_reward":  typeLabel = "💬 メッセ報酬"; color = Colors.Blue;   break;
    case "gacha":
    case "gacha_reward":typeLabel = "🎲 ガチャ";    color = Colors.Gold;   break;
    case "rumuma_bet":  typeLabel = "🏇 レースBET"; color = Colors.Aqua;   break;
    case "rumuma_refund":typeLabel= "↩️ レース返金"; color= Colors.Grey;   break;
    case "admin_adjust":typeLabel = "⚙️ 管理調整";  color = Colors.Red;    break;
    case "reward_claim":typeLabel = "💳 払い戻し受取"; color = Colors.Gold; break;
    case "casino_highlow": typeLabel = "🎯 High & Low"; color = Colors.Fuchsia; break;
    case "casino_cointoss": typeLabel = "🪙 Coin Toss"; color = Colors.Yellow; break;
    case "casino_dice":   typeLabel = "🎲 Dice Duel"; color = Colors.Orange; break;
    case "casino_doubleup": typeLabel = "♠️ Double Up"; color = Colors.Gold; break;
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
  if (chunk1.length) await respond(interaction, { embeds: chunk1 }, { ephemeral: true });
  else return respond(interaction, { content: "履歴はありません" }, { ephemeral: true });
  if (chunk2.length) await interaction.followUp({ embeds: chunk2, ephemeral: true });
}

// ==============================
// UI送信（管理／コイン／レース／カジノ）
// ==============================
async function sendUI(channel, type) {
  if (type === "admin") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_adjust").setLabel("⚙️ コイン増減").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("view_history_admin").setLabel("📜 全員取引履歴").setStyle(ButtonStyle.Secondary),
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

  // 🎰 Casino Mini Games
  if (type === "casino") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("casino_highlow").setLabel("🎯 High & Low").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("casino_cointoss").setLabel("🪙 Coin Toss").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("casino_dice").setLabel("🎲 Dice Duel").setStyle(ButtonStyle.Secondary)
    );
    await channel.send({
      embeds: [
        createEmbed(
          "🎰 TeamSDG’s Casino 🎰",
          `遊びたいゲームを選んでね！\n上限 **${fmt(CASINO_BET_MAX)}S**／回（残高と上限の小さい方）。\n[🎯 High & Low] [🪙 Coin Toss] [🎲 Dice Duel]\n勝ったら **ダブルアップ**（最大${DOUBLEUP_MAX_STEPS}回）に挑戦可能！`
        )
      ],
      components: [row]
    });
  }
}

// ==============================
// （改修）SSR演出ブロードキャスト
// ==============================
async function broadcastSSRWin({ guild, winnerUser, reward, roleName, roleColor }) {
  try {
    const channelId = DAILY_CHANNEL_ID || CASINO_CHANNEL_ID;
    if (!channelId) return;
    const ch = await (guild ? guild.channels.fetch(channelId).catch(() => null) : client.channels.fetch(channelId).catch(() => null));
    if (!ch) return;

    const head = "🎆🎆🎆 **SSR 大 当 た り ！** 🎆🎆🎆";
    const body = [
      `🎉 <@${winnerUser.id}> さんが **SSR** を引き当てました！`,
      `💰 祝賀ボーナス：**+${fmt(reward)}S**`,
      roleName ? `🏷️ ロール作成：**${roleName}**（色:${roleColor || "#FFD700"}）` : null,
      "",
      "▶️ みんなも挑戦：ガチャは「コインメニュー」から！",
      "▶️ 稼ぐなら：カジノやメッセ報酬、デイリーも活用しよう！"
    ].filter(Boolean).join("\n");

    const msg = await ch.send({ embeds: [createEmbed(head, body, Colors.Gold)] });
    const stages = [
      "🎇🎇🎇 **FIREWORKS** 🎇🎇🎇",
      "🎊🎊🎊 **CONGRATS!** 🎊🎊🎊",
      "✨✨✨ **GLORY!** ✨✨✨",
    ];
    for (let i=0;i<stages.length;i++){
      await new Promise(r=>setTimeout(r, 600));
      await msg.edit({ embeds: [createEmbed(head, body + `\n\n${stages[i]}`, Colors.Gold)] }).catch(()=>{});
    }
  } catch (e) {
    logError("broadcastSSRWin error:", e);
  }
}

// ==============================
// カジノ演出（単一メッセージ上書き — ephemeralはeditReplyで更新）
// ==============================
async function runShowyEffect(interaction, title, lines){
  const frames = [
    `🕹️ **${title}**\n${lines}\n\n▶️ スタート…`,
    `🕹️ **${title}**\n${lines}\n\n🎞️ ぐるぐる…`,
    `🕹️ **${title}**\n${lines}\n\n🔔 ドキドキ…`,
  ];
  await respond(interaction, { embeds:[createEmbed(title, frames[0], Colors.Blurple)] }, { ephemeral:true });
  for (let i=1;i<frames.length;i++){
    await new Promise(r=>setTimeout(r, 500));
    await interaction.editReply({ embeds:[createEmbed(title, frames[i], Colors.Blurple)] }).catch(()=>{});
  }
  return interaction;
}

// ==============================
// ダブルアップのボタン行だけ生成
// ==============================
function buildDoubleUpRow(userId, gameLabel, wonAmount, step = 0) {
  if (wonAmount <= 0 || step >= DOUBLEUP_MAX_STEPS) return null;
  const payload = `${userId}:${wonAmount}:${step}:${gameLabel}`;
  const sig = signToken(payload);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cx_du_go:${wonAmount}:${step}:${gameLabel}:${sig}`)
      .setLabel(`♠️ ダブルアップ（${step + 1}/${DOUBLEUP_MAX_STEPS}）`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`cx_du_take:${wonAmount}:${step}:${gameLabel}:${sig}`)
      .setLabel("✅ 勝ち分を確定")
      .setStyle(ButtonStyle.Success)
  );
}
// ==============================
// ガチャ
// ==============================
async function playGacha(interaction) {
  const uid = interaction.user.id;
  const balance = await getBalance(uid);

  if (balance < GACHA_COST) {
    return ephemeralReply(interaction, { embeds: [createEmbed("ガチャ", `残高不足：必要 ${fmt(GACHA_COST)}S / 保有 ${fmt(balance)}S`, Colors.Red)] });
  }

  await addCoins(uid, -GACHA_COST, "gacha", `ガチャ支払い:${GACHA_COST}S`);

  // 抽選
  const r = Math.random();
  const pick = GACHA_TABLE.find(t => r < t.p) || GACHA_TABLE[GACHA_TABLE.length - 1];
  const { rarity, reward, color } = pick;

  await addCoins(uid, reward, "gacha_reward", `ガチャ当選:${rarity}`);

  // 表示
  if (rarity === "SSR") {
    // SSR：ロール作成モーダル＋祝祭演出（コインUI ch に掲出）— メッセはロール確定後に再告知（遅延）
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

    // 先に当選演出だけを全体へ（ネタバレは最低限。ロール詳細は後ほど）
    broadcastSSRWin({ guild: interaction.guild, winnerUser: interaction.user, reward, roleName: null, roleColor: null }).catch(() => {});
    return interaction.showModal(modal);
  }

  // S/SR：演出付き（上書き）
  await runShowyEffect(interaction, "🎲 ガチャ", `抽選中…\n必要：${fmt(GACHA_COST)}S / 当選で即時付与`);
  await new Promise(r=>setTimeout(r, 600));
  await interaction.editReply({
    embeds: [createEmbed("🎲 ガチャ結果", `結果: **${rarity}**\n🟢 +${fmt(reward)}S`, color)],
    components: []
  }).catch(()=>{});
  return;
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

        // 旧slot UIは無効応答
        case "slot_config_open": {
          return ephemeralReply(interaction, { content: "🎰 ジャグラー機能は削除されました（設定UIは無効です）。" }, 20000);
        }
        case "casino_cleanup": {
          return ephemeralReply(interaction, { content: "🎰 ジャグラー関連の掃除機能は削除されました。古いメッセージは手動で削除してください。" }, 20000);
        }

        /* ===== コイン系 ===== */
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
          const bal = await getBalance(uid);
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

        // 旧slot起動は封鎖
        case "casino_slot": {
          return ephemeralReply(interaction, { content: "🎰 ジャグラー機能は削除されました。メニューからは非表示です。" }, 20000);
        }

        /* ====== 🎰 Casino Mini Games: 起点（モーダル表示） ====== */
        case "casino_highlow": {
          const modal = new ModalBuilder()
            .setCustomId("casino_bet_modal_highlow")
            .setTitle("High & Low / ベット額")
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("bet")
                  .setLabel(`ベット額（既定 ${fmt(CASINO_BET_DEFAULT)}S / 上限 ${fmt(CASINO_BET_MAX)}S）`)
                  .setStyle(TextInputStyle.Short)
                  .setRequired(false)
              )
            );
          return interaction.showModal(modal);
        }
        case "casino_cointoss": {
          const modal = new ModalBuilder()
            .setCustomId("casino_bet_modal_cointoss")
            .setTitle("Coin Toss / ベット額")
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("bet")
                  .setLabel(`ベット額（既定 ${fmt(CASINO_BET_DEFAULT)}S / 上限 ${fmt(CASINO_BET_MAX)}S）`)
                  .setStyle(TextInputStyle.Short)
                  .setRequired(false)
              )
            );
          return interaction.showModal(modal);
        }
        case "casino_dice": {
          const modal = new ModalBuilder()
            .setCustomId("casino_bet_modal_dice")
            .setTitle("Dice Duel / ベット額")
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("bet")
                  .setLabel(`ベット額（既定 ${fmt(CASINO_BET_DEFAULT)}S / 上限 ${fmt(CASINO_BET_MAX)}S）`)
                  .setStyle(TextInputStyle.Short)
                  .setRequired(false)
              )
            );
          return interaction.showModal(modal);
        }

        /* ====== 🏇 ルムマ：起点ボタン一式（未実装だった分を実装） ====== */
        case "rumuma_create": {
          const modal = new ModalBuilder()
            .setCustomId("rumuma_create_modal")
            .setTitle("レース作成")
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("race_name").setLabel("レース名").setStyle(TextInputStyle.Short).setRequired(true)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("horses").setLabel("出走馬（改行区切り）").setStyle(TextInputStyle.Paragraph).setRequired(true)
              )
            );
          return interaction.showModal(modal);
        }
        case "rumuma_list": {
          const r = await pool.query(`SELECT id, race_name, horses, finished FROM rumuma_races ORDER BY id DESC LIMIT 20`);
          if (!r.rowCount) return ephemeralReply(interaction, { content: "開催中のレースはありません" });
          const lines = r.rows.map(v => `#${v.id} ${v.race_name} / 出走:${(v.horses||[]).length} / ${v.finished ? "締切済" : "購入可"}`).join("\n");
          return ephemeralReply(interaction, { embeds: [createEmbed("📃 レース一覧（最新20）", lines, Colors.Aqua)] });
        }
        case "rumuma_bet": {
          const r = await pool.query(`SELECT id, race_name, finished FROM rumuma_races WHERE finished=false ORDER BY id DESC LIMIT 25`);
          if (!r.rowCount) return ephemeralReply(interaction, { content: "購入可能なレースがありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_bet_race")
            .setPlaceholder("レースを選択")
            .addOptions(r.rows.map(v => ({ label: `#${v.id} ${v.race_name}`, value: String(v.id) })));
          return ephemeralReply(interaction, { content: "レースを選択してください", components: [new ActionRowBuilder().addComponents(menu)] });
        }
        case "rumuma_my_bets": {
          const uid = interaction.user.id;
          const r = await pool.query(
            `SELECT race_id, horse, SUM(amount)::bigint AS sum FROM rumuma_bets WHERE user_id=$1 GROUP BY race_id, horse ORDER BY race_id DESC LIMIT 25`,
            [uid]
          );
          if (!r.rowCount) return ephemeralReply(interaction, { content: "あなたの購入履歴はありません" });
          const lines = r.rows.map(v => `Race #${v.race_id} … ${v.horse}：${fmt(v.sum)}S`).join("\n");
          return ephemeralReply(interaction, { embeds: [createEmbed("🎫 あなたのウマ券", lines, Colors.Aqua)] });
        }
        case "rumuma_odds": {
          const r = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC LIMIT 25`);
          if (!r.rowCount) return ephemeralReply(interaction, { content: "オッズ確認可能なレースがありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_odds_race")
            .setPlaceholder("レースを選択（現時点オッズ）")
            .addOptions(r.rows.map(v => ({ label: `#${v.id} ${v.race_name}`, value: String(v.id) })));
          return ephemeralReply(interaction, { content: "レースを選択してください", components: [new ActionRowBuilder().addComponents(menu)] });
        }
        case "rumuma_close_bets": {
          const r = await pool.query(`SELECT id, race_name, host_id FROM rumuma_races WHERE finished=false ORDER BY id DESC LIMIT 25`);
          const list = r.rows.filter(v => v.host_id === interaction.user.id);
          if (!list.length) return ephemeralReply(interaction, { content: "あなたがホストの締切可能レースはありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_close_race")
            .setPlaceholder("締切るレースを選択")
            .addOptions(list.map(v => ({ label: `#${v.id} ${v.race_name}`, value: String(v.id) })));
          return ephemeralReply(interaction, { content: "レースを選んで締切してください", components: [new ActionRowBuilder().addComponents(menu)] });
        }
        case "rumuma_report_result": {
          const r = await pool.query(`SELECT id, race_name, host_id FROM rumuma_races WHERE finished=false ORDER BY id DESC LIMIT 25`);
          const list = r.rows.filter(v => v.host_id === interaction.user.id);
          if (!list.length) return ephemeralReply(interaction, { content: "あなたがホストの結果登録可能レースはありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_result_race")
            .setPlaceholder("結果登録するレースを選択")
            .addOptions(list.map(v => ({ label: `#${v.id} ${v.race_name}`, value: String(v.id) })));
          return ephemeralReply(interaction, { content: "レースを選んでください", components: [new ActionRowBuilder().addComponents(menu)] });
        }
        case "rumuma_cancel": {
          if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
            return ephemeralReply(interaction, { content: "管理者権限が必要です" });
          const r = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC LIMIT 25`);
          if (!r.rowCount) return ephemeralReply(interaction, { content: "中止可能なレースがありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_cancel_race")
            .setPlaceholder("中止するレースを選択")
            .addOptions(r.rows.map(v => ({ label: `#${v.id} ${v.race_name}`, value: String(v.id) })));
          return ephemeralReply(interaction, { content: "レースを選んでください（全額返金）", components: [new ActionRowBuilder().addComponents(menu)] });
        }
        case "rumuma_history": {
          const r = await pool.query(`SELECT race_id, race_name, winner, total_pot, status, finished_at FROM rumuma_results ORDER BY finished_at DESC LIMIT 15`);
          if (!r.rowCount) return ephemeralReply(interaction, { content: "履歴はありません" });
          const lines = r.rows.map(v =>
            `${formatJST(v.finished_at)}  #${v.race_id} ${v.race_name}  結果:${v.winner || "-"} / 総額:${fmt(v.total_pot)}S / ${v.status}`
          ).join("\n");
          return ephemeralReply(interaction, { embeds: [createEmbed("🗂 競争履歴（最新15）", lines, Colors.Aqua)] });
        }
        case "rumuma_claim_rewards": {
          const uid = interaction.user.id;
          const r = await pool.query(`SELECT id, race_id, race_name, amount FROM pending_rewards WHERE user_id=$1 AND claimed=false ORDER BY id ASC`, [uid]);
          if (!r.rowCount) return ephemeralReply(interaction, { content: "受け取れる払い戻しはありません" });
          let total = 0;
          for (const row of r.rows) {
            total += Number(row.amount);
            await addCoins(uid, row.amount, "reward_claim", `Race:${row.race_id} ${row.race_name}`);
            await pool.query(`UPDATE pending_rewards SET claimed=true WHERE id=$1`, [row.id]);
          }
          return ephemeralReply(interaction, { embeds: [createEmbed("💳 払い戻し受取", `合計 **+${fmt(total)}S** を受け取りました！`, Colors.Gold)] });
        }
        case "rumuma_view_bets": {
          const r = await pool.query(`SELECT id, race_name, host_id FROM rumuma_races WHERE finished=false ORDER BY id DESC LIMIT 25`);
          const list = r.rows.filter(v => v.host_id === interaction.user.id);
          if (!list.length) return ephemeralReply(interaction, { content: "あなたがホストのレースが見つかりません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_view_bets_race")
            .setPlaceholder("賭け状況を確認するレースを選択")
            .addOptions(list.map(v => ({ label: `#${v.id} ${v.race_name}`, value: String(v.id) })));
          return ephemeralReply(interaction, { content: "レースを選んでください", components: [new ActionRowBuilder().addComponents(menu)] });
        }
      }

      /* ===== 🎯 High&Low 2手目（高い/低い） ===== */
      if (interaction.customId.startsWith("casino_highlow_guess:")) {
        const [, guess, betStr, firstStr/*, x*/] = interaction.customId.split(":");
        const uid = interaction.user.id;

        const betRequested = Math.max(1, parseInt(betStr, 10) || CASINO_BET_DEFAULT);
        const bet = await resolveBet(uid, betRequested);

        const first = parseInt(firstStr, 10);
        const next = randInt(1, 13);

        let delta = -bet;
        let resultText = `🃏 最初: ${first}\n🂠 次のカード: ${next}\n`;
        const isHigh = next > first;
        const isLow  = next < first;
        if ((guess === "H" && isHigh) || (guess === "L" && isLow)) {
          delta = Math.floor(bet * 1.8);
          resultText += `✅ 正解！ **+${fmt(delta)}S**\n`;
        } else {
          resultText += `❌ 不正解… **-${fmt(bet)}S**\n`;
        }

        await addCoins(uid, delta, "casino_highlow", `first:${first} next:${next} guess:${guess}`);
        const finalBal = await getBalance(uid);

        const row = (delta > 0)
          ? buildDoubleUpRow(uid, "HL", Math.max(0, delta), 0)
          : null;

        return respond(interaction, {
          embeds: [
            createEmbed(
              "🎯 High & Low 結果",
              `${resultText}\n残高：**${fmt(finalBal)}S**`,
              delta >= 0 ? Colors.Fuchsia : Colors.Red
            )
          ],
          components: row ? [row] : []
        });
      }
    }

    /* ---------- セレクトメニュー（ルムマ一式） ---------- */
    if (interaction.isStringSelectMenu()) {
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

      if (interaction.customId.startsWith("select_bet_horse_")) {
        const raceId = parseInt(interaction.customId.split("_")[3], 10);
        const horse = interaction.values[0];

        const r = await pool.query(`SELECT horses, finished FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!r.rowCount) return ephemeralUpdate(interaction, { content: "レースが見つかりません", components: [] });
        if (r.rows[0].finished) return ephemeralUpdate(interaction, { content: "このレースは締切済みです", components: [] });

        const bets = await pool.query(
          `SELECT horse, SUM(amount)::bigint AS sum FROM rumuma_bets WHERE race_id=$1 GROUP BY horse`,
          [raceId]
        );
        const totalPot = bets.rows.reduce((s, b) => s + Number(b.sum), 0);
        const horseSum = Number(bets.rows.find(b => b.horse === horse)?.sum || 0);
        const odds = horseSum > 0 ? (totalPot / horseSum).toFixed(2) : "賭けなし";

        const balance = await getBalance(interaction.user.id);

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

      if (interaction.customId === "select_close_race") {
        const raceId = parseInt(interaction.values[0], 10);
        const own = await pool.query(`SELECT host_id FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!own.rowCount || own.rows[0].host_id !== interaction.user.id)
          return ephemeralUpdate(interaction, { content: "このレースのホストではありません", components: [] });
        await pool.query(`UPDATE rumuma_races SET finished=true WHERE id=$1`, [raceId]);
        return ephemeralUpdate(interaction, { content: `レースID:${raceId} のウマ券購入を締め切りました`, components: [] });
      }

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

      if (interaction.customId === "select_cancel_race") {
        if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
          return ephemeralUpdate(interaction, { content: "管理者権限が必要です", components: [] });
        const raceId = parseInt(interaction.values[0], 10);
        await refundRumuma(raceId, "開催中止");
        return ephemeralUpdate(interaction, { content: `レースID:${raceId} は開催中止になりました（全額返金 & 履歴保存）`, components: [] });
      }

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

        let lines = `🏇 **Race:${raceId} ${own.rows[0].race_name}**\n💰 総額: ${fmt(totalPot)}S\n\n`;
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

      // ===== 🎯 High & Low：ベット確定 → 1枚目提示 & 選択ボタン（演出付き） =====
      if (interaction.customId === "casino_bet_modal_highlow") {
        const uid = interaction.user.id;
        const input = interaction.fields.getTextInputValue("bet")?.trim();
        const req = Math.max(1, parseInt(input, 10) || CASINO_BET_DEFAULT);
        const bet = await resolveBet(uid, req);

        const balance = await getBalance(uid);
        if (balance <= 0) {
          return ephemeralReply(interaction, { embeds: [createEmbed("High & Low", "残高0以下のため開始できません。", Colors.Red)] }, 20000);
        }
        if (balance < bet) {
          return ephemeralReply(interaction, { embeds: [createEmbed("High & Low", `残高不足：必要 ${fmt(bet)}S / 保有 ${fmt(balance)}S`, Colors.Red)] }, 20000);
        }

        const first = randInt(1, 13);
        await runShowyEffect(interaction, "🎯 High & Low", `ベット：**${fmt(bet)}S**（上限 ${fmt(CASINO_BET_MAX)}S）`);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`casino_highlow_guess:H:${bet}:${first}:x`).setLabel("🔺 高い").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`casino_highlow_guess:L:${bet}:${first}:x`).setLabel("🔻 低い").setStyle(ButtonStyle.Danger)
        );
        await interaction.editReply({
          embeds: [createEmbed("🎯 High & Low", `🃏 最初のカード: **${first}**\n「高い」か「低い」か選んでください。\n（同値は不正解扱い）`)],
          components: [row]
        }).catch(()=>{});
        return;
      }

      // ===== 🪙 Coin Toss：ベット確定 → 勝敗（演出＋ダブルアップ） =====
      if (interaction.customId === "casino_bet_modal_cointoss") {
        const uid = interaction.user.id;
        const input = interaction.fields.getTextInputValue("bet")?.trim();
        const bet = await resolveBet(uid, Math.max(1, parseInt(input, 10) || CASINO_BET_DEFAULT));

        const balance = await getBalance(uid);
        if (balance < bet) {
          return ephemeralReply(interaction, { embeds: [createEmbed("Coin Toss", `残高不足：必要 ${fmt(bet)}S / 保有 ${fmt(balance)}S`, Colors.Red)] }, 20000);
        }

        await runShowyEffect(interaction, "🪙 Coin Toss", `ベット：**${fmt(bet)}S** / コイントス中…`);
        const win = Math.random() < 0.5;
        const delta = win ? bet : -bet;

        await addCoins(uid, delta, "casino_cointoss", win ? "WIN (50%)" : "LOSE (50%)");
        const final = await getBalance(uid);

        const row = win ? buildDoubleUpRow(uid, "CT", delta, 0) : null;

        await interaction.editReply({
          embeds: [
            createEmbed(
              "🪙 Coin Toss 結果",
              `${win ? "✅ 勝ち！" : "❌ 負け…"} 変動：**${delta > 0 ? "+" : ""}${fmt(delta)}S**\n残高：**${fmt(final)}S**`,
              win ? Colors.Yellow : Colors.Red
            )
          ],
          components: row ? [row] : []
        }).catch(()=>{});
        return;
      }

      // ===== 🎲 Dice Duel：ベット確定 → 勝敗（演出＋ダブルアップ） =====
      if (interaction.customId === "casino_bet_modal_dice") {
        const uid = interaction.user.id;
        const input = interaction.fields.getTextInputValue("bet")?.trim();
        const bet = await resolveBet(uid, Math.max(1, parseInt(input, 10) || CASINO_BET_DEFAULT));

        const balance = await getBalance(uid);
        if (balance < bet) {
          return ephemeralReply(interaction, { embeds: [createEmbed("Dice Duel", `残高不足：必要 ${fmt(bet)}S / 保有 ${fmt(balance)}S`, Colors.Red)] }, 20000);
        }

        await runShowyEffect(interaction, "🎲 Dice Duel", `ベット：**${fmt(bet)}S** / ダイス振り中…`);
        const p1 = randInt(1, 6), p2 = randInt(1, 6);
        const b1 = randInt(1, 6), b2 = randInt(1, 6);
        const ps = p1 + p2;
        const bs = b1 + b2;

        let delta = 0;
        let line = `👤 あなた: [${p1}, ${p2}] = ${ps}\n🤖 Bot: [${b1}, ${b2}] = ${bs}\n`;
        if (ps > bs) {
          delta = bet * 2;
          line += `✅ 勝利！ **+${fmt(delta)}S**\n`;
        } else if (ps < bs) {
          delta = -bet;
          line += `❌ 敗北… **-${fmt(bet)}S**\n`;
        } else {
          delta = 0;
          line += `➖ 同点（払い戻し 0）\n`;
        }

        await addCoins(uid, delta, "casino_dice", `P:${p1},${p2} B:${b1},${b2}`);
        const final = await getBalance(uid);

        const row = delta > 0 ? buildDoubleUpRow(uid, "DD", delta, 0) : null;

        await interaction.editReply({
          embeds: [
            createEmbed(
              "🎲 Dice Duel 結果",
              `${line}\n残高：**${fmt(final)}S**`,
              delta > 0 ? Colors.Orange : (delta < 0 ? Colors.Red : Colors.Grey)
            )
          ],
          components: row ? [row] : []
        }).catch(()=>{});
        return;
      }

      // ===== ダブルアップ（ボタン） =====
      if (interaction.customId.startsWith("cx_du_")) {
        const parts = interaction.customId.split(":");
        const action = parts[0]; // cx_du_go / cx_du_take
        const winAmount = parseInt(parts[1], 10);
        const step = parseInt(parts[2], 10);
        const gameLabel = parts[3];
        const sig = parts[4];
        const uid = interaction.user.id;

        const payload = `${uid}:${winAmount}:${step}:${gameLabel}`;
        if (!verifyToken(payload, sig)) {
          return ephemeralReply(interaction, { content: "トークン検証に失敗しました。操作をやり直してください。"}, 10000);
        }

        if (action === "cx_du_take") {
          return respond(interaction, {
            embeds:[createEmbed("♠️ Double Up", `勝ち分 **${fmt(winAmount)}S** を確定しました。おめでとう！`, Colors.Gold)],
            components:[]
          });
        }

        if (action === "cx_du_go") {
          if (step >= DOUBLEUP_MAX_STEPS) {
            return respond(interaction, {
              embeds:[createEmbed("♠️ Double Up", `最大回数に達しました。勝ち分 **${fmt(winAmount)}S** は確定です。`, Colors.Gold)],
              components:[]
            });
          }
          const win = Math.random() < DOUBLEUP_WIN_RATE;

          if (win) {
            await addCoins(uid, winAmount, "casino_doubleup", `STEP ${step+1} WIN (${(DOUBLEUP_WIN_RATE*100).toFixed(1)}%) ${gameLabel}`);
            const newStake = winAmount * 2;
            const nextRow = buildDoubleUpRow(uid, gameLabel, newStake, step+1);
            return respond(interaction, {
              embeds:[createEmbed("♠️ Double Up", `✅ 成功！ **+${fmt(winAmount)}S** 上乗せ\n現在の勝ち分：**${fmt(newStake)}S**\n続けますか？（最大${DOUBLEUP_MAX_STEPS}回）`, Colors.Gold)],
              components: nextRow ? [nextRow] : []
            });
          } else {
            await addCoins(uid, -winAmount, "casino_doubleup", `STEP ${step+1} LOSE (${(DOUBLEUP_WIN_RATE*100).toFixed(1)}%) ${gameLabel}`);
            return respond(interaction, {
              embeds:[createEmbed("♠️ Double Up", `❌ 失敗… 勝ち分 **-${fmt(winAmount)}S** を没収`, Colors.Red)],
              components:[]
            });
          }
        }
      }

      // ここまで来ても未処理なボタンは、エラーにならないように握りつぶす
      return ephemeralReply(interaction, { content: "このボタンは現在利用できません。" }, 8000);
    }

    // ===== ガチャ：SSRロール作成（演出込み） =====
    if (interaction.type === InteractionType.ModalSubmit) {
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

          // ロール確定後に“再告知”（ネタバレタイミングを遅らせる）
          broadcastSSRWin({
            guild,
            winnerUser: interaction.user,
            reward: GACHA_TABLE[GACHA_TABLE.length - 1].reward,
            roleName,
            roleColor
          }).catch(() => {});

          return ephemeralReply(interaction, {
            embeds: [createEmbed("SSR当選 🎉", `ロール **${roleName}** を作成し付与しました！（色:${roleColor}）\nこのロールは **Botロール直下** に配置され、1週間後に自動削除されます。`, Colors.Gold)]
          }, 30000);
        } catch (e) {
          logError("SSRロール作成失敗:", e);
          return ephemeralReply(interaction, { embeds: [createEmbed("SSRロール", "ロール作成に失敗しました。Botロールの位置と権限を確認してください。", Colors.Red)] }, 30000);
        }
      }

      // ===== ルムマ：レース作成 =====
      if (interaction.customId === "rumuma_create_modal") {
        const name = interaction.fields.getTextInputValue("race_name").trim();
        const horses = interaction.fields.getTextInputValue("horses").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        if (horses.length < 2) return ephemeralReply(interaction, { content: "出走馬は2頭以上必要です" });

        const ins = await pool.query(
          `INSERT INTO rumuma_races(channel_id, host_id, race_name, horses, finished)
           VALUES ($1,$2,$3,$4,false) RETURNING id`,
          [interaction.channel?.id || "", interaction.user.id, name, horses]
        );
        return ephemeralReply(interaction, { embeds: [createEmbed("🏇 レース作成", `#${ins.rows[0].id} ${name}\n出走:${horses.length}頭`, Colors.Green)] });
      }

      // ===== ルムマ：ベット金額入力 =====
      if (interaction.customId.startsWith("rumuma_bet_amount_modal_")) {
        const [_prefix, rest] = interaction.customId.split("rumuma_bet_amount_modal_");
        const [raceIdStr, horseEnc] = rest.split("__");
        const raceId = parseInt(raceIdStr, 10);
        const horse = decodeURIComponent(horseEnc || "");
        const input = interaction.fields.getTextInputValue("amounts");
        const nums = input.split(/[,\s]+/).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0);
        if (!nums.length) return ephemeralReply(interaction, { content: "金額が不正です" });

        const r = await pool.query(`SELECT finished FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!r.rowCount || r.rows[0].finished) return ephemeralReply(interaction, { content: "このレースは締切済みです" });

        let total = 0;
        for (const n of nums) total += n;
        const bal = await getBalance(interaction.user.id);
        if (bal < total) return ephemeralReply(interaction, { content: `残高不足：必要 ${fmt(total)}S / 保有 ${fmt(bal)}S` });

        for (const n of nums) {
          await addCoins(interaction.user.id, -n, "rumuma_bet", `Race:${raceId} ${horse}`);
          await pool.query(
            `INSERT INTO rumuma_bets(race_id, user_id, horse, amount) VALUES ($1,$2,$3,$4)`,
            [raceId, interaction.user.id, horse, n]
          );
        }
        return ephemeralReply(interaction, { embeds: [createEmbed("🎫 購入完了", `Race #${raceId}\n${horse} を **${nums.map(v=>fmt(v)+"S").join(" + ")}** 購入しました。`, Colors.Green)] });
      }
    }
  } catch (err) {
    logError("interaction error:", err);
    try { await ephemeralReply(interaction, { content: "処理中にエラーが発生しました" }); } catch {}
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
    logError("message reward error:", e);
  }
});
// ==============================
// デイリー受取リセット（JST 05:00）
// ==============================
schedule.scheduleJob("0 20 * * *", async () => { // UTC20:00 = JST05:00
  await pool.query("DELETE FROM daily_claims");
  logInfo("✅ デイリー受取リセット完了 (JST05:00)");
});

// ==============================
// READY
// ==============================
async function trySendUIById(id, type) {
  const ch = await client.channels.fetch(id).catch(() => null);
  if (ch) await sendUI(ch, type);
}

client.once("ready", async () => {
  logInfo(`✅ Logged in as ${client.user.tag}`);
  await ensureTables();

  if (process.env.ADMIN_CHANNEL_ID) {
    await trySendUIById(process.env.ADMIN_CHANNEL_ID, "admin");
  }
  if (DAILY_CHANNEL_ID) {
    await trySendUIById(DAILY_CHANNEL_ID, "daily");
  }
  if (process.env.RUMUMA_CHANNELS) {
    for (const cid of process.env.RUMUMA_CHANNELS.split(",").map(s => s.trim()).filter(Boolean)) {
      await trySendUIById(cid, "rumuma");
    }
  }

  // ★ ここでカジノメニューを自動送信（ご指定ID）
  if (CASINO_CHANNEL_ID) {
    await trySendUIById(CASINO_CHANNEL_ID, "casino");
  }
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
  logInfo(`🌐 HTTP server running on port ${PORT}`);
});
