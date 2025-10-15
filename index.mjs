// index.mjs

import {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, InteractionType, PermissionsBitField,
  Events, Colors, SlashCommandBuilder
} from "discord.js";
import pg from "pg";
const { Pool } = pg;
import dotenv from "dotenv";
import schedule from "node-schedule";
import crypto from "crypto";
import http from "http";

dotenv.config();

// ==============================
// DB
// ==============================
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

// UI出力先
const DAILY_CHANNEL_ID    = process.env.DAILY_CHANNEL_ID || "";

// カジノUI（互換維持）
const STATIC_CASINO_CHANNEL_ID = "1424340886585868368";
const CASINO_CHANNEL_ID        = process.env.CASINO_CHANNEL_ID || STATIC_CASINO_CHANNEL_ID;

// ガチャ経済
const GACHA_COST = parseInt(process.env.GACHA_COST || "40", 10);
// 互換維持：SSR_BONUS_AMOUNT > GACHA_SSR_REWARD > 3000
const SSR_BONUS_AMOUNT_ENV = process.env.SSR_BONUS_AMOUNT;
const GACHA_SSR_REWARD = parseInt(
  (SSR_BONUS_AMOUNT_ENV && SSR_BONUS_AMOUNT_ENV.trim() !== "" ? SSR_BONUS_AMOUNT_ENV : (process.env.GACHA_SSR_REWARD || "3000"))
, 10);

// ガチャ演出 TTL
const GACHA_RESULT_TTL_MS = parseInt(process.env.GACHA_RESULT_TTL_MS || "8000", 10);

// ガチャテーブル（累積確率）
const GACHA_TABLE = [
  { p: 0.74, rarity: "S",   reward: 6,   color: Colors.Grey  },
  { p: 0.98, rarity: "SR",  reward: 15,  color: Colors.Purple},
  { p: 1.00, rarity: "SSR", reward: GACHA_SSR_REWARD, color: Colors.Gold  },
];

// SSRロール付与メッセ遅延
const SSR_ROLE_MESSAGE_DELAY_MS = parseInt(process.env.SSR_ROLE_MESSAGE_DELAY_MS || "3000", 10);

// カジノ共通
const CASINO_BET_DEFAULT  = parseInt(process.env.CASINO_BET_DEFAULT || "10", 10);
const CASINO_BET_MAX      = parseInt(process.env.CASINO_BET_MAX || "500", 10);

// ダブルアップ（HLはHL方式で再挑戦）
const DOUBLEUP_MAX_STEPS  = parseInt(process.env.DOUBLEUP_MAX_STEPS || "3", 10);
const CASINO_STREAK_MAX   = parseInt(process.env.CASINO_STREAK_MAX || "3", 10);

// 署名
const SIGNING_SECRET      = process.env.SIGNING_SECRET || "sdgs-secret";

// ガチャJP
const GACHA_JP_ENABLED    = (process.env.GACHA_JP_ENABLED || "true").toLowerCase() === "true";
const GACHA_JP_TAKE_RATE  = Number(process.env.GACHA_JP_TAKE_RATE || "0.25");
const GACHA_JP_SEED       = parseInt(process.env.GACHA_JP_SEED || "1000", 10);
const GACHA_JP_CAP        = parseInt(process.env.GACHA_JP_CAP || "100000", 10);
const GACHA_JP_HIT_BASE   = Number(process.env.GACHA_JP_HIT_BASE || "0.0005");
const GACHA_JP_CHANNEL_ID = process.env.GACHA_JP_CHANNEL_ID || DAILY_CHANNEL_ID || CASINO_CHANNEL_ID;
const GACHA_JP_NOTIFY_MIN = parseInt(process.env.GACHA_JP_NOTIFY_MIN || "2000", 10);

// Mines
const MINES_TOTAL_CELLS   = 15; // 5x3
const MINES_BOMBS_MIN     = 2;
const MINES_BOMBS_MAX     = 5;
const MINES_PEEK_PENALTY  = 0.9;
const MINES_EDGE          = 0.98;

// Crash
const CRASH_EDGE          = 0.02;
const CRASH_SPEED_PER_SEC = 0.35;
const CRASH_MAX_X         = 10.0;

// UI 自動再掲（デフォルト無効）
const UI_AUTO_POST_ON_READY = (process.env.UI_AUTO_POST_ON_READY || "false").toLowerCase() === "true";

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

// Interaction安全応答（★noUpdate=true で元メッセージをupdateしない）
async function respond(interaction, payload, { ephemeral = false, noUpdate = false } = {}) {
  const data = { ...payload };
  if (typeof data.content === "string") data.content = limitContent(data.content);

  try {
    if (!noUpdate && (interaction.isButton?.() || interaction.isStringSelectMenu?.())) {
      try { return await interaction.update(data); } catch (_) {}
    }
    if (interaction.deferred || interaction.replied) {
      try { return await interaction.editReply(data); } catch (_) {}
    }
    try { return await interaction.reply({ ...data, ephemeral }); } catch (_) {}
    return await interaction.followUp({ ...data, ephemeral: true });
  } catch (e) {
    logError("respond() failed:", e);
    try { return await interaction.deferUpdate(); } catch {}
  }
}
async function ephemeralReply(interaction, payload, ms = 15000) {
  const msg = await respond(interaction, payload, { ephemeral: true, noUpdate: true });
  setTimeout(() => interaction.deleteReply?.().catch(() => {}), ms);
  return msg;
}
function signToken(payloadStr){
  const mac = crypto.createHmac("sha256", SIGNING_SECRET).update(payloadStr).digest("hex").slice(0,24);
  return mac;
}
function verifyToken(payloadStr, sig){
  try{ return signToken(payloadStr) === sig; }catch{ return false; }
}

// Coin
async function addCoins(userId, amount, type, note = null) {
  const n = Math.trunc(Number(amount) || 0);
  const cli = await pool.connect();
  try {
    await cli.query("BEGIN");
    await cli.query(
      `INSERT INTO coins (user_id, balance)
       VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET balance = coins.balance + EXCLUDED.balance`,
      [userId, n]
    );
    await cli.query(
      `INSERT INTO history (user_id, type, amount, note, created_at)
       VALUES ($1,$2,$3,$4,NOW())`,
      [userId, type, n, note]
    );
    await cli.query("COMMIT");
  } catch (e) {
    await cli.query("ROLLBACK");
    throw e;
  } finally { cli.release(); }
}
async function getBalance(userId) {
  const r = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [userId]);
  return r.rowCount ? Number(r.rows[0].balance) : 0;
}
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
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

  // ルムマ
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

  // カジノ汎用セッション
  await pool.query(`
    CREATE TABLE IF NOT EXISTS casino_sessions (
      user_id TEXT PRIMARY KEY,
      game TEXT,
      stake INTEGER,
      step INTEGER,
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  // ガチャJP
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gacha_jackpot_state (
      id INTEGER PRIMARY KEY,
      pot BIGINT NOT NULL,
      seed INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT now()
    );
  `);
  const jp = await pool.query(`SELECT pot FROM gacha_jackpot_state WHERE id=1`);
  if (!jp.rowCount) {
    await pool.query(
      `INSERT INTO gacha_jackpot_state (id, pot, seed, updated_at) VALUES (1, $1, $2, NOW())`,
      [GACHA_JP_SEED, GACHA_JP_SEED]
    );
  }

  // Mines
  await pool.query(`
    CREATE TABLE IF NOT EXISTS casino_mines_sessions (
      user_id TEXT PRIMARY KEY,
      bet INTEGER NOT NULL,
      bombs INTEGER NOT NULL,
      bombs_mask INTEGER NOT NULL,
      opened_mask INTEGER NOT NULL,
      can_peek BOOLEAN NOT NULL DEFAULT true,
      penalty NUMERIC NOT NULL DEFAULT 1.0,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  // Crash
  await pool.query(`
    CREATE TABLE IF NOT EXISTS casino_crash_sessions (
      user_id TEXT PRIMARY KEY,
      bet INTEGER NOT NULL,
      started_at TIMESTAMP NOT NULL,
      target_crash NUMERIC NOT NULL,
      cashed_at NUMERIC,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  // ストリーク
  await pool.query(`
    CREATE TABLE IF NOT EXISTS casino_streaks (
      user_id TEXT PRIMARY KEY,
      current INTEGER NOT NULL DEFAULT 0,
      best INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  // インデックス
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_history_user_id ON history(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rumuma_bets_race_id ON rumuma_bets(race_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pending_rewards_user ON pending_rewards(user_id, claimed);`);
}

// ==============================
// 取引履歴 表示
// ==============================
function formatHistoryEmbed(row) {
  const when = formatJST(row.created_at);
  let typeLabel = "📦 その他";
  let color = Colors.Blurple;
  switch (row.type) {
    case "casino_slot":     typeLabel = "🎰（削除済）ジャグラー"; color = Colors.Grey; break;
    case "daily":           typeLabel = "🎁 デイリー";   color = Colors.Green;  break;
    case "msg_reward":      typeLabel = "💬 メッセ報酬"; color = Colors.Blue;   break;
    case "gacha":
    case "gacha_reward":    typeLabel = "🎲 ガチャ";    color = Colors.Gold;   break;
    case "gacha_jackpot":   typeLabel = "🧨 ガチャJP";  color = Colors.Gold;   break;
    case "rumuma_bet":      typeLabel = "🏇 レースBET"; color = Colors.Aqua;   break;
    case "rumuma_refund":   typeLabel = "↩️ レース返金"; color= Colors.Grey;   break;
    case "reward_claim":    typeLabel = "💳 払い戻し受取"; color = Colors.Gold; break;
    case "casino_highlow":  typeLabel = "🎯 High & Low"; color = Colors.Fuchsia; break;
    case "casino_cointoss": typeLabel = "🪙 Coin Toss"; color = Colors.Yellow; break;
    case "casino_dice":     typeLabel = "🎲 Dice Duel"; color = Colors.Orange; break;
    case "casino_doubleup": typeLabel = "♠️ Double Up"; color = Colors.Gold;   break;
    case "casino_mines":    typeLabel = "💣 Mines";      color = Colors.DarkGrey; break;
    case "casino_crash":    typeLabel = "📈 Crash";      color = Colors.Green; break;
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
  if (chunk1.length) await respond(interaction, { embeds: chunk1 }, { ephemeral: true, noUpdate: true });
  else return respond(interaction, { content: "履歴はありません" }, { ephemeral: true, noUpdate: true });
  if (chunk2.length) await interaction.followUp({ embeds: chunk2, ephemeral: true });
}

// ==============================
// ストリーク
// ==============================
async function streakWin(uid) {
  const r = await pool.query(`SELECT current, best FROM casino_streaks WHERE user_id=$1`, [uid]);
  let cur = 1, best = 1;
  if (r.rowCount) {
    cur = Number(r.rows[0].current) + 1;
    best = Math.max(Number(r.rows[0].best), cur);
    await pool.query(`UPDATE casino_streaks SET current=$2, best=$3, updated_at=NOW() WHERE user_id=$1`, [uid, cur, best]);
  } else {
    await pool.query(`INSERT INTO casino_streaks(user_id, current, best, updated_at) VALUES ($1,1,1,NOW())`, [uid]);
  }
  return { current: cur, best };
}
async function streakLose(uid) {
  await pool.query(`
    INSERT INTO casino_streaks(user_id, current, best, updated_at)
    VALUES ($1,0,0,NOW())
    ON CONFLICT (user_id) DO UPDATE SET current=0, updated_at=NOW()
  `, [uid]);
  return { current: 0 };
}
async function getStreak(uid) {
  const r = await pool.query(`SELECT current, best FROM casino_streaks WHERE user_id=$1`, [uid]);
  return r.rowCount ? { current: Number(r.rows[0].current), best: Number(r.rows[0].best) } : { current: 0, best: 0 };
}

// ==============================
// ガチャJP
// ==============================
async function getJackpotPot() {
  if (!GACHA_JP_ENABLED) return 0;
  const r = await pool.query(`SELECT pot FROM gacha_jackpot_state WHERE id=1`);
  return r.rowCount ? Number(r.rows[0].pot) : 0;
}
async function broadcastJPWin({ guild, winnerUser, amount, potBefore }) {
  try {
    const channelId = GACHA_JP_CHANNEL_ID || DAILY_CHANNEL_ID || CASINO_CHANNEL_ID;
    if (!channelId) return;
    const ch = await (guild ? guild.channels.fetch(channelId).catch(() => null) : client.channels.fetch(channelId).catch(() => null));
    if (!ch) return;
    const title = "🧨 JACKPOT HIT!!";
    const body  = [
      `🎉 <@${winnerUser.id}> さんが **JACKPOT** を当てました！`,
      `💰 配当：**+${fmt(amount)}S**（直前ポット: ${fmt(potBefore)}S）`,
      `🔄 ポットは初期値にリセットされました。`
    ].join("\n");
    await ch.send({ embeds: [createEmbed(title, body, Colors.Gold)] });
  } catch (e) { logError("broadcastJPWin error:", e); }
}
async function jpContribute(cost) {
  if (!GACHA_JP_ENABLED) return null;
  const add = Math.floor(cost * GACHA_JP_TAKE_RATE);
  if (add <= 0) return null;
  const cli = await pool.connect();
  try {
    await cli.query("BEGIN");
    const r = await cli.query(`SELECT pot FROM gacha_jackpot_state WHERE id=1 FOR UPDATE`);
    const pot = Number(r.rows[0].pot);
    const next = Math.min(GACHA_JP_CAP, pot + add);
    await cli.query(`UPDATE gacha_jackpot_state SET pot=$1, updated_at=NOW() WHERE id=1`, [next]);
    await cli.query("COMMIT");
    return next;
  } catch (e) {
    await cli.query("ROLLBACK"); logError("jpContribute", e); return null;
  } finally { cli.release(); }
}
async function jpTryHitSSR(userId, guild) {
  if (!GACHA_JP_ENABLED) return false;
  const cli = await pool.connect();
  try {
    await cli.query("BEGIN");
    const r = await cli.query(`SELECT pot FROM gacha_jackpot_state WHERE id=1 FOR UPDATE`);
    const pot = Number(r.rows[0].pot);
    const hit = Math.random() < GACHA_JP_HIT_BASE;
    if (!hit || pot <= 0) { await cli.query("COMMIT"); return false; }
    await addCoins(userId, pot, "gacha_jackpot", `JP HIT +${pot}S`);
    await cli.query(`UPDATE gacha_jackpot_state SET pot=$1, updated_at=NOW() WHERE id=1`, [GACHA_JP_SEED]);
    await cli.query("COMMIT");
    broadcastJPWin({ guild, winnerUser: { id: userId }, amount: pot, potBefore: pot }).catch(()=>{});
    return true;
  } catch (e) {
    await cli.query("ROLLBACK"); logError("jpTryHitSSR", e); return false;
  } finally { cli.release(); }
}

// ==============================
// ダブルアップ（汎用セッション）
// ==============================
async function duStart(userId, pendingWin, gameLabel) {
  await pool.query(`
    INSERT INTO casino_sessions(user_id, game, stake, step, updated_at)
    VALUES ($1, $2, $3, 0, NOW())
    ON CONFLICT (user_id) DO UPDATE SET game=$2, stake=$3, step=0, updated_at=NOW()
  `, [userId, `DU_${gameLabel}`, pendingWin]);
}
async function duGet(userId) {
  const r = await pool.query(`SELECT game, stake, step FROM casino_sessions WHERE user_id=$1`, [userId]);
  return r.rowCount ? r.rows[0] : null;
}
async function duSave(userId, stake, step) {
  await pool.query(`UPDATE casino_sessions SET stake=$2, step=$3, updated_at=NOW() WHERE user_id=$1`, [userId, stake, step]);
}
async function duClear(userId) {
  await pool.query(`DELETE FROM casino_sessions WHERE user_id=$1`, [userId]);
}

// ==============================
// 演出
// ==============================
async function runShowyEffect(interaction, title, lines){
  const frames = [
    `🕹️ **${title}**\n${lines}\n\n▶️ スタート…`,
    `🕹️ **${title}**\n${lines}\n\n🎞️ ぐるぐる…`,
    `🕹️ **${title}**\n${lines}\n\n🔔 ドキドキ…`,
  ];
  await respond(interaction, { embeds:[createEmbed(title, frames[0], Colors.Blurple)] }, { ephemeral:true, noUpdate:true });
  for (let i=1;i<frames.length;i++){
    await new Promise(r=>setTimeout(r, 500));
    await interaction.editReply({ embeds:[createEmbed(title, frames[i], Colors.Blurple)] }).catch(()=>{});
  }
  return interaction;
}
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
    ].filter(Boolean).join("\n");
    const msg = await ch.send({ embeds: [createEmbed(head, body, Colors.Gold)] });
    const stages = ["🎇🎇🎇 **FIREWORKS** 🎇🎇🎇","🎊🎊🎊 **CONGRATS!** 🎊🎊🎊","✨✨✨ **GLORY!** ✨✨✨"];
    for (let i=0;i<stages.length;i++){
      await new Promise(r=>setTimeout(r, 600));
      await msg.edit({ embeds: [createEmbed(head, body + `\n\n${stages[i]}`, Colors.Gold)] }).catch(()=>{});
    }
  } catch (e) { logError("broadcastSSRWin", e); }
}

// ==============================
// JP/HL 表示用テキスト
// ==============================
async function jackpotLine() {
  if (!GACHA_JP_ENABLED) return "";
  const pot = await getJackpotPot();
  return `🧨 現在JP：**${fmt(pot)}S**`;
}
async function streakLine(uid) {
  const s = await getStreak(uid);
  return `🔥 連勝：**${s.current}**（Best:${s.best}）`;
}

// ==============================
// UI送信
// ==============================
async function sendUI(channel, type, opts = {}) {
  if (type === "admin") {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_adjust").setLabel("⚙️ コイン増減").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("view_history_admin").setLabel("📜 全員取引履歴").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("admin_repost_ui").setLabel("🔁 UI再表示").setStyle(ButtonStyle.Primary),
    );
    await channel.send({ content: "管理メニュー", components: [row1] });
  }
  if (type === "daily") {
    const jp = await jackpotLine();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("daily_claim").setLabel("🎁 デイリーコイン").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("gacha_play").setLabel("🎲 ガチャ").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("check_balance").setLabel("💰 残高確認").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("view_history_user").setLabel("📜 取引履歴").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("view_ranking").setLabel("🏅 ランキング").setStyle(ButtonStyle.Primary)
    );
    await channel.send({
      embeds: [createEmbed("コインメニュー", `${jp || ""}`.trim(), Colors.Blurple)],
      components: [row]
    });
  }
  if (type === "rumuma") {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rumuma_create").setLabel("🏇 レース作成").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("rumuma_list").setLabel("📃 レース一覧").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rumuma_bet").setLabel("🎫 ウマ券購入").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("rumuma_my_bets").setLabel("🎫 自分の賭け").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rumuma_odds").setLabel("📈 オッズ").setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rumuma_close_bets").setLabel("✅ 投票締切").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rumuma_report_result").setLabel("🏆 結果報告").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("rumuma_cancel").setLabel("⛔ 開催中止").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rumuma_history").setLabel("🗂 競争履歴").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rumuma_claim_rewards").setLabel("💳 払い戻し").setStyle(ButtonStyle.Primary)
    );
    await channel.send({ content: "レースメニュー", components: [row1, row2] });
  }
  if (type === "casino") {
    const jp = await jackpotLine();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("casino_highlow").setLabel("🎯 High & Low").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("casino_mines").setLabel("💣 Mines").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("casino_crash").setLabel("📈 Crash").setStyle(ButtonStyle.Secondary)
    );
    await channel.send({
      embeds: [
        createEmbed(
          "🎰 TeamSDG’s Casino 🎰",
          `${jp || ""}\n上限 **${fmt(CASINO_BET_MAX)}S**／回。\n勝てば**ダブルアップ**に挑戦可能！`
        )
      ],
      components: [row]
    });
  }
}

// ==============================
// ルムマ：返金
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
// Mines：内部
// ==============================
const bitHas = (mask, idx) => ((mask >> idx) & 1) === 1;
const bitSet = (mask, idx) => (mask | (1 << idx));
const bitCount = (mask) => { let m = mask >>> 0, c = 0; while (m) { m &= (m - 1); c++; } return c; };
function randomBombMask(bombs, total = MINES_TOTAL_CELLS) {
  const idxs = Array.from({length: total}, (_,i)=>i);
  for (let i=0;i<bombs;i++){ const j = randInt(i, total-1); [idxs[i], idxs[j]] = [idxs[j], idxs[i]]; }
  let mask = 0; for (let i=0;i<bombs;i++) mask = bitSet(mask, idxs[i]); return mask;
}
function minesMultiplier(bombs, openedCount, penalty = 1.0) {
  const safeTotal = MINES_TOTAL_CELLS - bombs;
  if (openedCount <= 0) return 1.0;
  let prod = 1.0;
  for (let i=0;i<openedCount;i++){
    const safeRem = safeTotal - i;
    const closedRem = MINES_TOTAL_CELLS - i;
    prod *= (safeRem / closedRem);
  }
  const fair = 1 / prod;
  const mult = Math.max(1.0, Number((fair * MINES_EDGE * penalty).toFixed(2)));
  return mult;
}
function minesGridRows(session, locked = false, revealAll = false) {
  const rows = [];
  for (let r=0;r<3;r++){
    const row = new ActionRowBuilder();
    for (let c=0;c<5;c++){
      const idx = r*5 + c;
      const opened = bitHas(session.opened_mask, idx);
      const isBomb = bitHas(session.bombs_mask, idx);
      let label = "❓";
      if (revealAll && isBomb) label = "💥";
      else if (opened) label = "✅";
      const payload = `${session.user_id || "u"}:${idx}`;
      const sig = signToken(payload);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`mines_open:${idx}:${sig}`)
          .setLabel(label)
          .setStyle(opened ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(locked || opened)
      );
    }
    rows.push(row);
  }
  const mult = minesMultiplier(session.bombs, bitCount(session.opened_mask), Number(session.penalty || 1.0));
  const control = new ActionRowBuilder();
  const pSig = signToken(`${session.user_id || "u"}:cash`);
  control.addComponents(
    new ButtonBuilder().setCustomId(`mines_cash:${pSig}`)
      .setLabel(`✅ 確定（×${mult.toFixed(2)}）`).setStyle(ButtonStyle.Success)
      .setDisabled(locked)
  );
  const peekSig = signToken(`${session.user_id || "u"}:peek`);
  control.addComponents(
    new ButtonBuilder().setCustomId(`mines_peek:${peekSig}`)
      .setLabel("👁️ ちら見（倍率-10%）").setStyle(ButtonStyle.Secondary)
      .setDisabled(locked || !session.can_peek)
  );
  rows.push(control);
  return rows;
}

// ==============================
// Crash：内部
// ==============================
function genCrashTarget() {
  const r = Math.random();
  const raw = 1.0 / (1 - r * (1 - CRASH_EDGE));
  return Math.min(CRASH_MAX_X, Number(raw.toFixed(2)));
}
function crashMultipleSince(startedAt) {
  const t = (Date.now() - new Date(startedAt).getTime()) / 1000;
  return Number(Math.max(1.0, (1 + t * CRASH_SPEED_PER_SEC)).toFixed(2));
}
const crashTimers = new Map();

// ==============================
// ガチャ本体（SSRはモーダルACK→非同期処理）
// ==============================
async function playGacha(interaction) {
  const uid = interaction.user.id;
  const balance = await getBalance(uid);
  if (balance < GACHA_COST) {
    return ephemeralReply(interaction, { embeds: [createEmbed("ガチャ", `残高不足：必要 ${fmt(GACHA_COST)}S / 保有 ${fmt(balance)}S`, Colors.Red)] });
  }
  const r = Math.random();
  const pick = GACHA_TABLE.find(t => r < t.p) || GACHA_TABLE[GACHA_TABLE.length - 1];
  const { rarity, reward, color } = pick;

  if (rarity === "SSR") {
    // showModalでACK → 以降非同期
    const modal = new ModalBuilder()
      .setCustomId("gacha_ssr_modal")
      .setTitle("SSRロール作成")
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("role_name").setLabel("ロール名（20文字まで）").setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("role_color").setLabel("カラーコード（例：#FFD700）").setStyle(TextInputStyle.Short).setRequired(false))
      );
    await interaction.showModal(modal);

    (async () => {
      await addCoins(uid, -GACHA_COST, "gacha", `ガチャ支払い:${GACHA_COST}S`);
      await jpContribute(GACHA_COST);
      await addCoins(uid, reward, "gacha_reward", `ガチャ当選:${rarity}`);
      await jpTryHitSSR(uid, interaction.guild);
      // 告知はモーダル完了時（遅延あり）
    })().catch(()=>{});
    return;
  }

  // S / SR （エフェメラル＋自動削除）
  await runShowyEffect(interaction, "🎲 ガチャ", `抽選中…\n必要：${fmt(GACHA_COST)}S / 当選で即時付与`);
  await addCoins(uid, -GACHA_COST, "gacha", `ガチャ支払い:${GACHA_COST}S`);
  await jpContribute(GACHA_COST);
  await addCoins(uid, reward, "gacha_reward", `ガチャ当選:${rarity}`);
  await interaction.editReply({
    embeds: [createEmbed("🎲 ガチャ結果", `結果: **${rarity}**\n🟢 +${fmt(reward)}S`, color)],
    components: []
  }).catch(()=>{});
  setTimeout(() => interaction.deleteReply?.().catch(()=>{}), GACHA_RESULT_TTL_MS);
}

// ==============================
// Mines：開始/操作
// ==============================
async function startMines(interaction, bet, bombs) {
  const uid = interaction.user.id;
  await addCoins(uid, -bet, "casino_mines", `BET start bombs:${bombs}`);
  const bombs_mask = randomBombMask(bombs);
  await pool.query(`
    INSERT INTO casino_mines_sessions(user_id, bet, bombs, bombs_mask, opened_mask, can_peek, penalty, created_at, updated_at)
    VALUES ($1,$2,$3,$4,0,true,1.0,NOW(),NOW())
    ON CONFLICT (user_id) DO UPDATE SET bet=$2, bombs=$3, bombs_mask=$4, opened_mask=0, can_peek=true, penalty=1.0, updated_at=NOW()
  `, [uid, bet, bombs, bombs_mask]);

  const session = { user_id: uid, bet, bombs, bombs_mask, opened_mask: 0, can_peek: true, penalty: 1.0 };
  const rows = minesGridRows(session, false, false);
  const mult = minesMultiplier(bombs, 0, 1.0);
  await respond(interaction, {
    embeds: [createEmbed("💣 Mines", `爆弾 **${bombs}** / マス **${MINES_TOTAL_CELLS}**\n現在倍率：×${mult.toFixed(2)}\n安全マスを開けるか、いつでも「確定」で終了できます。`, Colors.DarkGrey)],
    components: rows
  }, { ephemeral: true, noUpdate: true });
}
async function handleMinesOpen(interaction, idx) {
  const uid = interaction.user.id;
  const res = await pool.query(`SELECT * FROM casino_mines_sessions WHERE user_id=$1`, [uid]);
  if (!res.rowCount) return ephemeralReply(interaction, { content: "Minesセッションが見つかりません。" });
  const s = res.rows[0];
  if (bitHas(s.opened_mask, idx)) {
    return respond(interaction, { components: minesGridRows(s, false, false) });
  }
  if (bitHas(s.bombs_mask, idx)) {
    const reveal = minesGridRows(s, true, true);
    await pool.query(`DELETE FROM casino_mines_sessions WHERE user_id=$1`, [uid]);
    return respond(interaction, { embeds: [createEmbed("💣 Mines", `💥 **爆発！** ベットは没収されました。`, Colors.Red)], components: reveal });
  }
  const newOpened = bitSet(s.opened_mask, idx);
  await pool.query(`UPDATE casino_mines_sessions SET opened_mask=$2, updated_at=NOW() WHERE user_id=$1`, [uid, newOpened]);
  const session = { ...s, opened_mask: newOpened };
  const mult = minesMultiplier(s.bombs, bitCount(newOpened), Number(s.penalty || 1.0));
  return respond(interaction, {
    embeds: [createEmbed("💣 Mines", `✅ 安全！\n現在倍率：**×${mult.toFixed(2)}**\n続けるか、**確定**で払い戻し。`, Colors.DarkGrey)],
    components: minesGridRows(session, false, false)
  });
}
async function handleMinesCash(interaction) {
  const uid = interaction.user.id;
  const res = await pool.query(`SELECT * FROM casino_mines_sessions WHERE user_id=$1`, [uid]);
  if (!res.rowCount) return ephemeralReply(interaction, { content: "Minesセッションが見つかりません。" });
  const s = res.rows[0];
  const opened = bitCount(s.opened_mask);
  const mult = minesMultiplier(s.bombs, opened, Number(s.penalty || 1.0));
  const pay = Math.floor(s.bet * mult);
  await addCoins(uid, pay, "casino_mines", `CASHOUT opened:${opened} mult:${mult.toFixed(2)} pay:${pay}`);
  await pool.query(`DELETE FROM casino_mines_sessions WHERE user_id=$1`, [uid]);
  return respond(interaction, { embeds: [createEmbed("💣 Mines", `✅ 確定 **+${fmt(pay)}S**（×${mult.toFixed(2)}）`, Colors.Green)], components: [] });
}
async function handleMinesPeek(interaction) {
  const uid = interaction.user.id;
  const res = await pool.query(`SELECT * FROM casino_mines_sessions WHERE user_id=$1`, [uid]);
  if (!res.rowCount) return ephemeralReply(interaction, { content: "Minesセッションが見つかりません。" });
  const s = res.rows[0];
  if (!s.can_peek) return respond(interaction, { components: minesGridRows(s, false, false) });

  const safeCandidates = [];
  for (let i=0;i<MINES_TOTAL_CELLS;i++){
    if (!bitHas(s.opened_mask, i) && !bitHas(s.bombs_mask, i)) safeCandidates.push(i);
  }
  if (safeCandidates.length === 0) return respond(interaction, { components: minesGridRows(s, false, false) });
  const pick = safeCandidates[randInt(0, safeCandidates.length - 1)];
  const newOpened = bitSet(s.opened_mask, pick);
  const newPenalty = Number(s.penalty || 1.0) * MINES_PEEK_PENALTY;

  await pool.query(`UPDATE casino_mines_sessions SET opened_mask=$2, can_peek=false, penalty=$3, updated_at=NOW() WHERE user_id=$1`,
    [uid, newOpened, newPenalty]);

  const session = { ...s, opened_mask: newOpened, can_peek: false, penalty: newPenalty };
  const mult = minesMultiplier(s.bombs, bitCount(newOpened), newPenalty);
  return respond(interaction, {
    embeds: [createEmbed("💣 Mines", `👁️ **ちら見** 使用（倍率-10%）\n現在倍率：**×${mult.toFixed(2)}**`, Colors.DarkGrey)],
    components: minesGridRows(session, false, false)
  });
}

// ==============================
// Crash：開始/確定
// ==============================
async function startCrash(interaction, bet) {
  const uid = interaction.user.id;
  const target = genCrashTarget();
  await addCoins(uid, -bet, "casino_crash", `BET start target:${target}x`);
  await pool.query(`
    INSERT INTO casino_crash_sessions(user_id, bet, started_at, target_crash, cashed_at, created_at, updated_at)
    VALUES ($1,$2,NOW(),$3,NULL,NOW(),NOW())
    ON CONFLICT (user_id) DO UPDATE SET bet=$2, started_at=NOW(), target_crash=$3, cashed_at=NULL, updated_at=NOW()
  `, [uid, bet, target]);

  const sig = signToken(`${uid}:cash`);
  await respond(interaction, {
    embeds: [createEmbed("📈 Crash", `倍率が上昇します。**クラッシュ前**に「確定」を押すと、その倍率で払い戻し！\n目標は秘密😉`, Colors.Green)],
    components: [ new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`crash_cash:${sig}`).setLabel("✅ 確定").setStyle(ButtonStyle.Success)
    ) ]
  }, { ephemeral: true, noUpdate: true });

  const tick = async () => {
    try {
      const r = await pool.query(`SELECT bet, started_at, target_crash, cashed_at FROM casino_crash_sessions WHERE user_id=$1`, [uid]);
      if (!r.rowCount) { clearInterval(crashTimers.get(uid)); crashTimers.delete(uid); return; }
      const s = r.rows[0];
      const nowX = crashMultipleSince(s.started_at);
      if (s.cashed_at != null) { clearInterval(crashTimers.get(uid)); crashTimers.delete(uid); return; }
      if (nowX >= Number(s.target_crash)) {
        clearInterval(crashTimers.get(uid)); crashTimers.delete(uid);
        await interaction.editReply({
          embeds: [createEmbed("📈 Crash", `💥 **CRASH** at ${Number(s.target_crash).toFixed(2)}x\n払い戻しなし`, Colors.Red)],
          components: []
        }).catch(()=>{});
        await pool.query(`DELETE FROM casino_crash_sessions WHERE user_id=$1`, [uid]);
        return;
      }
      await interaction.editReply({
        embeds: [createEmbed("📈 Crash", `現在倍率：**${nowX.toFixed(2)}x**\nクラッシュ前に確定を！`, Colors.Green)]
      }).catch(()=>{});
    } catch {}
  };
  const h = setInterval(tick, 350);
  crashTimers.set(uid, h);
}
async function handleCrashCash(interaction) {
  const uid = interaction.user.id;
  const r = await pool.query(`SELECT bet, started_at, target_crash, cashed_at FROM casino_crash_sessions WHERE user_id=$1`, [uid]);
  if (!r.rowCount) return ephemeralReply(interaction, { content: "Crashセッションが見つかりません。" });
  const s = r.rows[0];
  const nowX = crashMultipleSince(s.started_at);
  if (nowX >= Number(s.target_crash)) {
    await pool.query(`DELETE FROM casino_crash_sessions WHERE user_id=$1`, [uid]);
    clearInterval(crashTimers.get(uid)); crashTimers.delete(uid);
    return respond(interaction, { embeds: [createEmbed("📈 Crash", `💥 **CRASH** at ${Number(s.target_crash).toFixed(2)}x\n払い戻しなし`, Colors.Red)], components: [] });
  }
  if (s.cashed_at != null) {
    return respond(interaction, { embeds: [createEmbed("📈 Crash", `既に ${Number(s.cashed_at).toFixed(2)}x で確定済みです。`, Colors.Grey)], components: [] });
  }
  const pay = Math.floor(Number(s.bet) * nowX);
  await addCoins(uid, pay, "casino_crash", `CASHOUT at ${nowX.toFixed(2)}x pay:${pay}`);
  await pool.query(`UPDATE casino_crash_sessions SET cashed_at=$2, updated_at=NOW() WHERE user_id=$1`, [uid, nowX]);
  clearInterval(crashTimers.get(uid)); crashTimers.delete(uid);
  await pool.query(`DELETE FROM casino_crash_sessions WHERE user_id=$1`, [uid]);
  return respond(interaction, { embeds: [createEmbed("📈 Crash", `✅ 確定 **+${fmt(pay)}S**（${nowX.toFixed(2)}x）`, Colors.Green)], components: [] });
}

// ==============================
// High&Low（本戦＆ダブルアップHL）
// ==============================
function hlNearMissText(first, next) {
  if (Math.abs(next - first) === 1) return "（惜しい！±1のニアミス）";
  return "";
}
function buildHLGuessRow(tag, bet, first, stepOrBlank = "") {
  // tag: "casino_highlow_guess" | "du_hl_guess"
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${tag}:H:${bet}:${first}:${stepOrBlank}`).setLabel("🔺 高い").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${tag}:L:${bet}:${first}:${stepOrBlank}`).setLabel("🔻 低い").setStyle(ButtonStyle.Danger)
  );
  return row;
}
function buildDUTakeRow(uid, stake, step, gameLabel) {
  const payload = `${uid}:${stake}:${step}:${gameLabel}`;
  const sig = signToken(payload);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`du_take:${stake}:${step}:${gameLabel}:${sig}`).setLabel("✅ 勝ち分を受け取る").setStyle(ButtonStyle.Success)
  );
}

// ==============================
// インタラクション
// ==============================
client.on("interactionCreate", async (interaction) => {
  try {
    // ===== Slash Commands =====
    if (interaction.isChatInputCommand?.()) {
      const name = interaction.commandName;
      if (name === "ui") {
        const type = interaction.options.getString("type", true);
        await respond(interaction, { content: `UI再表示：${type}` }, { ephemeral: true, noUpdate: true });
        await sendUI(interaction.channel, type);
        return;
      }
      if (name === "jackpot") {
        const pot = await getJackpotPot();
        return respond(interaction, { embeds: [createEmbed("🧨 Jackpot 現在高", `現在ポット：**${fmt(pot)}S**`)] }, { ephemeral: true, noUpdate: true });
      }
      if (name === "balance") {
        const bal = await getBalance(interaction.user.id);
        return respond(interaction, { embeds: [createEmbed("残高確認", `${fmt(bal)} S`)] }, { ephemeral: true, noUpdate: true });
      }
    }

    // ===== Buttons =====
    if (interaction.isButton()) {
      // 管理
      if (interaction.customId === "admin_adjust") {
        if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
          return ephemeralReply(interaction, { content: "管理者権限が必要です" });
        const modal = new ModalBuilder()
          .setCustomId("admin_adjust_modal")
          .setTitle("ユーザーコイン調整")
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("target_user").setLabel("対象ユーザーID").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("amount").setLabel("増減額 (例: 100 or -50)").setStyle(TextInputStyle.Short).setRequired(true))
          );
        return interaction.showModal(modal);
      }
      if (interaction.customId === "view_history_admin") {
        if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
          return ephemeralReply(interaction, { content: "管理者権限が必要です" });
        const res = await pool.query(`SELECT * FROM history ORDER BY created_at DESC LIMIT 15`);
        if (!res.rowCount) return ephemeralReply(interaction, { content: "履歴はありません" });
        await replyHistoryEmbeds(interaction, res.rows);
        return;
      }
      if (interaction.customId === "admin_repost_ui") {
        const menu = new StringSelectMenuBuilder()
          .setCustomId("admin_repost_ui_select")
          .setPlaceholder("再表示するUIを選択")
          .addOptions(
            { label: "admin",  value: "admin" },
            { label: "daily",  value: "daily" },
            { label: "rumuma", value: "rumuma" },
            { label: "casino", value: "casino" },
          );
        const row = new ActionRowBuilder().addComponents(menu);
        return ephemeralReply(interaction, { content: "UI再表示メニュー", components: [row] }, 30000);
      }

      // コイン系
      if (interaction.customId === "daily_claim") {
        const uid = interaction.user.id;
        const today = todayJST();
        const res = await pool.query(`SELECT last_claim FROM daily_claims WHERE user_id=$1`, [uid]);
        let last = res.rowCount ? (res.rows[0].last_claim ? new Date(res.rows[0].last_claim) : null) : null;
        let lastStr = last ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(last) : null;
        if (lastStr === today) return ephemeralReply(interaction, { embeds: [createEmbed("コイン", "今日はもう受け取り済みです", Colors.Red)] });
        await pool.query(
          `INSERT INTO daily_claims (user_id, last_claim) VALUES ($1,$2::date)
           ON CONFLICT(user_id) DO UPDATE SET last_claim=$2::date`,
          [uid, today]
        );
        await addCoins(uid, DAILY_AMOUNT, "daily", "デイリー報酬");
        return ephemeralReply(interaction, { embeds: [createEmbed("コイン", `${fmt(DAILY_AMOUNT)}Sを受け取りました！`, Colors.Green)] });
      }
      if (interaction.customId === "check_balance") {
        const bal = await getBalance(interaction.user.id);
        return ephemeralReply(interaction, { embeds: [createEmbed("残高確認", `${fmt(bal)} S`)] }, 30000);
      }
      if (interaction.customId === "view_history_user") {
        const uid = interaction.user.id;
        const res = await pool.query(`SELECT * FROM history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 15`, [uid]);
        if (!res.rowCount) return ephemeralReply(interaction, { content: "履歴はありません" });
        await replyHistoryEmbeds(interaction, res.rows);
        return;
      }
      if (interaction.customId === "gacha_play") return playGacha(interaction);
      if (interaction.customId === "view_ranking") {
        const rs = await pool.query(`SELECT user_id, balance FROM coins ORDER BY balance DESC LIMIT 10`);
        if (!rs.rowCount) return ephemeralReply(interaction, { content: "ランキングはまだありません" }, 30000);
        const lines = rs.rows.map((r, i) => `#${i+1} <@${r.user_id}> … **${fmt(r.balance)}S**`).join("\n");
        return ephemeralReply(interaction, { embeds: [createEmbed("🏅 コインランキング（TOP10）", lines, Colors.Gold)] }, 30000);
      }

      // カジノ起点
      if (interaction.customId === "casino_highlow") {
        const modal = new ModalBuilder()
          .setCustomId("casino_bet_modal_highlow")
          .setTitle("High & Low / ベット額")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("bet")
                .setLabel(`ベット額（既定 ${fmt(CASINO_BET_DEFAULT)}S / 上限 ${fmt(CASINO_BET_MAX)}S）`)
                .setStyle(TextInputStyle.Short).setRequired(false)
            )
          );
        return interaction.showModal(modal);
      }
      if (interaction.customId === "casino_mines") {
        const modal = new ModalBuilder()
          .setCustomId("casino_bet_modal_mines")
          .setTitle("Mines / ベット & 爆弾数")
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bet").setLabel(`ベット額（既定 ${fmt(CASINO_BET_DEFAULT)}S / 上限 ${fmt(CASINO_BET_MAX)}S）`).setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bombs").setLabel(`爆弾数（${MINES_BOMBS_MIN}〜${MINES_BOMBS_MAX}）`).setStyle(TextInputStyle.Short).setRequired(false))
          );
        return interaction.showModal(modal);
      }
      if (interaction.customId === "casino_crash") {
        const modal = new ModalBuilder()
          .setCustomId("casino_bet_modal_crash")
          .setTitle("Crash / ベット額")
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bet").setLabel(`ベット額（既定 ${fmt(CASINO_BET_DEFAULT)}S / 上限 ${fmt(CASINO_BET_MAX)}S）`).setStyle(TextInputStyle.Short).setRequired(false))
          );
        return interaction.showModal(modal);
      }

      // ===== High&Low 本戦 結果 =====
      if (interaction.customId.startsWith("casino_highlow_guess:")) {
        const [, guess, betStr, firstStr] = interaction.customId.split(":");
        const uid = interaction.user.id;
        const betRequested = Math.max(1, parseInt(betStr, 10) || CASINO_BET_DEFAULT);
        const bet = await resolveBet(uid, betRequested);

        const balance = await getBalance(uid);
        if (balance < bet) {
          return ephemeralReply(interaction, { embeds: [createEmbed("High & Low", `残高不足：必要 ${fmt(bet)}S / 保有 ${fmt(balance)}S`, Colors.Red)] }, 20000);
        }

        // ここでBETを引く（勝っても即時は増やさない：保留管理へ）
        await addCoins(uid, -bet, "casino_highlow", `BET first:${firstStr} guess:${guess}`);

        const first = parseInt(firstStr, 10);
        const next  = randInt(1, 13);
        const isHigh = next > first;
        const isLow  = next < first;

        if ((guess === "H" && isHigh) || (guess === "L" && isLow)) {
          // 勝利：ストリーク加算＆倍率補正
          const s = await streakWin(uid);
          const bonusRate = Math.min(s.current, CASINO_STREAK_MAX) * 0.05; // 1連勝ごと+5%、上限CASINO_STREAK_MAX
          const pending = Math.floor(bet * 1.8 * (1 + bonusRate));
          await duStart(uid, pending, "HL"); // HLダブルアップへ
          const rowHL = buildHLGuessRow("du_hl_guess", pending, randInt(1,13), "0");
          const rowTake = buildDUTakeRow(uid, pending, 0, "HL");
          const near = hlNearMissText(first, next);
          const line = `🃏 最初: ${first}\n🂠 次のカード: ${next}  ${near}\n✅ 正解！ 勝ち分 **${fmt(pending)}S**（連勝補正 +${(bonusRate*100)|0}%）を保留中\n👉 **ダブルアップHL** に挑戦するか「勝ち分を受け取る」`;
          return respond(interaction, { embeds: [createEmbed("🎯 High & Low 結果", line, Colors.Fuchsia)], components: [rowHL, rowTake] });
        } else {
          // 敗北：ストリークリセット
          await streakLose(uid);
          const line = `🃏 最初: ${first}\n🂠 次のカード: ${next}  ${hlNearMissText(first,next)}\n❌ 不正解… **-${fmt(bet)}S**`;
          const finalBal = await getBalance(uid);
          return respond(interaction, { embeds: [createEmbed("🎯 High & Low 結果", `${line}\n残高：**${fmt(finalBal)}S**`, Colors.Red)], components: [] });
        }
      }

      // ===== ダブルアップHL：推測 =====
      if (interaction.customId.startsWith("du_hl_guess:")) {
        const [, guess, pendingStr, firstStr, stepStr] = interaction.customId.split(":");
        const uid = interaction.user.id;
        const sess = await duGet(uid);
        if (!sess || !String(sess.game).startsWith("DU_HL")) {
          return respond(interaction, { embeds: [createEmbed("♠️ Double Up", "セッションが見つかりません。", Colors.Red)], components: [] });
        }

        const pending = Number(pendingStr);
        const step = Number(stepStr);
        if (Number(sess.stake) !== pending || Number(sess.step) !== step) {
          // ボタン古い
          const rowHL = buildHLGuessRow("du_hl_guess", Number(sess.stake), randInt(1,13), String(sess.step||0));
          const rowTake = buildDUTakeRow(uid, Number(sess.stake), Number(sess.step), "HL");
          return respond(interaction, { embeds: [createEmbed("♠️ Double Up", "ボタンが古いため更新しました。")], components: [rowHL, rowTake] });
        }

        const first = parseInt(firstStr, 10);
        const next  = randInt(1, 13);
        const isHigh = next > first;
        const isLow  = next < first;

        if ((guess === "H" && isHigh) || (guess === "L" && isLow)) {
          // 勝ち → 倍化 or 自動確定
          await streakWin(uid);
          const nextStake = pending * 2;
          const nextStep = step + 1;
          if (nextStep >= DOUBLEUP_MAX_STEPS) {
            await addCoins(uid, nextStake, "casino_doubleup", `HL AUTO_TAKE step:${nextStep}`);
            await duClear(uid);
            return respond(interaction, { embeds: [createEmbed("♠️ Double Up", `✅ 最大回数に達したため自動確定：**+${fmt(nextStake)}S**`, Colors.Gold)], components: [] });
          }
          await duSave(uid, nextStake, nextStep);
          const rowHL = buildHLGuessRow("du_hl_guess", nextStake, randInt(1,13), String(nextStep));
          const rowTake = buildDUTakeRow(uid, nextStake, nextStep, "HL");
          const line = `🃏 ${first} → ${next}  ${hlNearMissText(first,next)}\n✅ 成功！ 現在の勝ち分：**${fmt(nextStake)}S**（${nextStep}/${DOUBLEUP_MAX_STEPS}）`;
          return respond(interaction, { embeds: [createEmbed("♠️ Double Up", line, Colors.Gold)], components: [rowHL, rowTake] });
        } else {
          // 敗北
          await duClear(uid);
          await streakLose(uid);
          const line = `🃏 ${first} → ${next}  ${hlNearMissText(first,next)}\n❌ 失敗… 勝ち分は没収されました。`;
          return respond(interaction, { embeds: [createEmbed("♠️ Double Up", line, Colors.Red)], components: [] });
        }
      }

      // ダブルアップ：受け取り
      if (interaction.customId.startsWith("du_take:")) {
        const [, pendingStr, stepStr, gameLabel, sig] = interaction.customId.split(":");
        const uid = interaction.user.id;
        const payload = `${uid}:${pendingStr}:${stepStr}:${gameLabel}`;
        if (!verifyToken(payload, sig)) return ephemeralReply(interaction, { content: "トークン検証に失敗しました。"}, 8000);
        const sess = await duGet(uid);
        if (!sess) return respond(interaction, { embeds: [createEmbed("♠️ Double Up", "セッションが見つかりません。", Colors.Red)], components: [] });
        await addCoins(uid, Number(sess.stake||0), "casino_doubleup", `TAKE ${gameLabel} step:${sess.step}`);
        await duClear(uid);
        return respond(interaction, { embeds:[createEmbed("♠️ Double Up", `✅ 勝ち分 **+${fmt(Number(sess.stake||0))}S** を受け取りました！`, Colors.Gold)], components:[] });
      }

      // Minesボタン
      if (interaction.customId.startsWith("mines_open:")) {
        const [, idxStr, sig] = interaction.customId.split(":");
        const idx = parseInt(idxStr, 10);
        const payload = `${interaction.user.id}:${idx}`;
        if (!verifyToken(payload, sig)) return ephemeralReply(interaction, { content: "検証に失敗しました。" }, 8000);
        return handleMinesOpen(interaction, idx);
      }
      if (interaction.customId.startsWith("mines_cash:")) {
        const [, sig] = interaction.customId.split(":");
        const payload = `${interaction.user.id}:cash`;
        if (!verifyToken(payload, sig)) return ephemeralReply(interaction, { content: "検証に失敗しました。" }, 8000);
        return handleMinesCash(interaction);
      }
      if (interaction.customId.startsWith("mines_peek:")) {
        const [, sig] = interaction.customId.split(":");
        const payload = `${interaction.user.id}:peek`;
        if (!verifyToken(payload, sig)) return ephemeralReply(interaction, { content: "検証に失敗しました。" }, 8000);
        return handleMinesPeek(interaction);
      }

      // Crashボタン
      if (interaction.customId.startsWith("crash_cash:")) {
        const [, sig] = interaction.customId.split(":");
        const payload = `${interaction.user.id}:cash`;
        if (!verifyToken(payload, sig)) return ephemeralReply(interaction, { content: "検証に失敗しました。" }, 8000);
        return handleCrashCash(interaction);
      }

      // ルムマ：UI系ボタン（★選択式フローに対応）
      if (interaction.customId === "rumuma_create") {
        const modal = new ModalBuilder()
          .setCustomId("rumuma_create_modal")
          .setTitle("レース作成")
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("race_name").setLabel("レース名").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("horses").setLabel("出走馬（,区切り）").setStyle(TextInputStyle.Paragraph).setRequired(true))
          );
        return interaction.showModal(modal);
      }
      if (interaction.customId === "rumuma_list") {
        const r = await pool.query(`SELECT id, race_name, horses, finished FROM rumuma_races ORDER BY id DESC LIMIT 10`);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "開催中のレースはありません。" });
        const lines = r.rows.map(x => `#${x.id} ${x.race_name} ${x.finished ? "（締切済）" : ""}\n　出走: ${x.horses.join(", ")}`).join("\n");
        return ephemeralReply(interaction, { embeds: [createEmbed("📃 レース一覧", lines)] }, 30000);
      }

      // ---- 購入：選択式 ----
      if (interaction.customId === "rumuma_bet") {
        const r = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC LIMIT 25`);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "購入可能なレースがありません。" });
        const menu = new StringSelectMenuBuilder()
          .setCustomId("rumuma_bet_pick_race")
          .setPlaceholder("レースを選択")
          .addOptions(...r.rows.map(x => ({ label: `#${x.id} ${x.race_name}`, value: String(x.id) })));
        return ephemeralReply(interaction, { content: "レース選択", components: [new ActionRowBuilder().addComponents(menu)] }, 30000);
      }

      if (interaction.customId === "rumuma_my_bets") {
        const r = await pool.query(`
          SELECT b.race_id, b.horse, b.amount, r.race_name, r.finished
          FROM rumuma_bets b JOIN rumuma_races r ON b.race_id=r.id
          WHERE b.user_id=$1 ORDER BY b.id DESC LIMIT 10
        `, [interaction.user.id]);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "購入履歴はありません。" });
        const lines = r.rows.map(x => `#${x.race_id} ${x.race_name} / ${x.horse} : ${fmt(x.amount)}S ${x.finished ? "（締切済）" : ""}`).join("\n");
        return ephemeralReply(interaction, { embeds: [createEmbed("🎫 自分のウマ券", lines)] }, 30000);
      }
      if (interaction.customId === "rumuma_odds") {
        const r = await pool.query(`
          SELECT r.id, r.race_name, r.horses, r.finished,
                 (SELECT COALESCE(SUM(amount),0) FROM rumuma_bets WHERE race_id=r.id) AS total
          FROM rumuma_races r ORDER BY r.id DESC LIMIT 1
        `);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "対象レースがありません。" });
        const race = r.rows[0];
        const totals = {};
        const br = await pool.query(`SELECT horse, SUM(amount) AS amt FROM rumuma_bets WHERE race_id=$1 GROUP BY horse`, [race.id]);
        for (const b of br.rows) totals[b.horse] = Number(b.amt);
        const lines = race.horses.map(h => {
          const t = totals[h] || 0;
          const share = (t === 0 || Number(race.total) === 0) ? "-" : `${(Number(race.total)/t).toFixed(2)}x`;
          return `${h} … 賭け総額 ${fmt(t)}S / 想定倍率 ${share}`;
        }).join("\n");
        return ephemeralReply(interaction, { embeds: [createEmbed(`📈 オッズ #${race.id} ${race.race_name}`, lines)] }, 30000);
      }

      // ---- 投票締切：選択式 ----
      if (interaction.customId === "rumuma_close_bets") {
        const r = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC LIMIT 25`);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "締切対象のレースがありません。" });
        const menu = new StringSelectMenuBuilder()
          .setCustomId("rumuma_close_pick")
          .setPlaceholder("締切るレースを選択")
          .addOptions(...r.rows.map(x => ({ label: `#${x.id} ${x.race_name}`, value: String(x.id) })));
        return ephemeralReply(interaction, { content: "投票締切：レース選択", components: [new ActionRowBuilder().addComponents(menu)] }, 30000);
      }

      // ---- 結果報告：選択式 ----
      if (interaction.customId === "rumuma_report_result") {
        const r = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=true AND winner IS NULL ORDER BY id DESC LIMIT 25`);
        // まだ finished=false のまま運用している場合もあるので finished 条件は緩めに扱う：
        const alt = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC LIMIT 25`);
        const rows = r.rowCount ? r.rows : alt.rows;
        if (!rows.length) return ephemeralReply(interaction, { content: "結果報告対象のレースがありません。" });
        const menu = new StringSelectMenuBuilder()
          .setCustomId("rumuma_result_pick_race")
          .setPlaceholder("結果を報告するレースを選択")
          .addOptions(...rows.map(x => ({ label: `#${x.id} ${x.race_name}`, value: String(x.id) })));
        return ephemeralReply(interaction, { content: "結果報告：レース選択", components: [new ActionRowBuilder().addComponents(menu)] }, 30000);
      }

      if (interaction.customId === "rumuma_cancel") {
        const modal = new ModalBuilder()
          .setCustomId("rumuma_cancel_modal")
          .setTitle("開催中止")
          .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("race_id").setLabel("レースID").setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
      }
      if (interaction.customId === "rumuma_history") {
        const r = await pool.query(`SELECT race_id, race_name, winner, total_pot, status, finished_at FROM rumuma_results ORDER BY id DESC LIMIT 10`);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "履歴なし" });
        const lines = r.rows.map(x => `#${x.race_id} ${x.race_name} … ${x.status==="canceled"?"中止":`勝者:${x.winner}`} / 総額:${fmt(x.total_pot)}S / ${formatJST(x.finished_at)}`).join("\n");
        return ephemeralReply(interaction, { embeds: [createEmbed("🗂 レース履歴", lines)] }, 30000);
      }
      if (interaction.customId === "rumuma_claim_rewards") {
        const uid = interaction.user.id;
        const r = await pool.query(`SELECT id, amount, race_name FROM pending_rewards WHERE user_id=$1 AND claimed=false`, [uid]);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "受け取れる払い戻しはありません。" });
        let total = 0;
        for (const x of r.rows) {
          total += Number(x.amount);
          await pool.query(`UPDATE pending_rewards SET claimed=true WHERE id=$1`, [x.id]);
        }
        await addCoins(uid, total, "reward_claim", "レース払い戻し一括受取");
        return ephemeralReply(interaction, { embeds: [createEmbed("💳 払い戻し", `合計 **+${fmt(total)}S** を受け取りました。`, Colors.Gold)] });
      }

      // Crash/Mines/HL 以外のボタンはフォールバック
      return ephemeralReply(interaction, { content: "このボタンは現在利用できません。" }, 8000);
    }

    // ===== Select =====
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "admin_repost_ui_select") {
        const type = interaction.values?.[0];
        await respond(interaction, { content: `UI再表示：${type}` }, { ephemeral: true });
        await sendUI(interaction.channel, type);
        return;
      }

      // 購入：レース選択 → 馬選択
      if (interaction.customId === "rumuma_bet_pick_race") {
        const raceId = parseInt(interaction.values?.[0], 10);
        const r = await pool.query(`SELECT horses, race_name FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!r.rowCount) return respond(interaction, { content: "レースが見つかりません。" });
        const horses = r.rows[0].horses || [];
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`rumuma_bet_pick_horse:${raceId}`)
          .setPlaceholder(`#${raceId} ${r.rows[0].race_name} の馬を選択`)
          .addOptions(...horses.map(h => ({ label: h, value: h })).slice(0, 25));
        return respond(interaction, { content: "馬を選択してください。", components: [new ActionRowBuilder().addComponents(menu)] });
      }
      if (interaction.customId.startsWith("rumuma_bet_pick_horse:")) {
        const raceId = parseInt(interaction.customId.split(":")[1], 10);
        const horse = interaction.values?.[0];
        const modal = new ModalBuilder()
          .setCustomId(`rumuma_bet_amount_modal:${raceId}:${encodeURIComponent(horse)}`)
          .setTitle(`購入金額 / ${horse}`)
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("amount").setLabel("ベット額").setStyle(TextInputStyle.Short).setRequired(true))
          );
        return interaction.showModal(modal);
      }

      // 投票締切：レース選択 → 即締切
      if (interaction.customId === "rumuma_close_pick") {
        const raceId = parseInt(interaction.values?.[0], 10);
        const r = await pool.query(`UPDATE rumuma_races SET finished=true WHERE id=$1 RETURNING race_name`, [raceId]);
        if (!r.rowCount) return respond(interaction, { content: "レースが見つかりません。" });
        return respond(interaction, { embeds: [createEmbed("✅ 投票締切", `#${raceId} ${r.rows[0].race_name}`)] });
      }

      // 結果報告：レース選択 → 馬選択で確定
      if (interaction.customId === "rumuma_result_pick_race") {
        const raceId = parseInt(interaction.values?.[0], 10);
        const r = await pool.query(`SELECT race_name, horses FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!r.rowCount) return respond(interaction, { content: "レースが見つかりません。" });
        const horses = r.rows[0].horses || [];
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`rumuma_result_pick_winner:${raceId}`)
          .setPlaceholder(`#${raceId} ${r.rows[0].race_name} 勝ち馬を選択`)
          .addOptions(...horses.map(h => ({ label: h, value: h })).slice(0, 25));
        return respond(interaction, { content: "勝ち馬を選択してください。", components: [new ActionRowBuilder().addComponents(menu)] });
      }
      if (interaction.customId.startsWith("rumuma_result_pick_winner:")) {
        const raceId = parseInt(interaction.customId.split(":")[1], 10);
        const winner = interaction.values?.[0];

        const rr = await pool.query(`SELECT race_name, horses FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!rr.rowCount) return respond(interaction, { content: "レースが見つかりません。" });
        if (!rr.rows[0].horses.includes(winner)) return respond(interaction, { content: "勝ち馬が出走一覧にありません。" });

        const bets = await pool.query(`SELECT user_id, horse, amount FROM rumuma_bets WHERE race_id=$1`, [raceId]);
        const totalPot = bets.rows.reduce((s,b)=>s+Number(b.amount),0);
        await pool.query(`UPDATE rumuma_races SET finished=true, winner=$2 WHERE id=$1`, [raceId, winner]);

        const winTotal = bets.rows.filter(b => b.horse===winner).reduce((s,b)=>s+Number(b.amount),0);
        if (winTotal > 0) {
          for (const b of bets.rows.filter(b => b.horse===winner)) {
            const share = (Number(b.amount) / winTotal) * totalPot;
            const pay = Math.floor(share);
            await pool.query(
              `INSERT INTO pending_rewards(user_id, race_id, race_name, amount, claimed, created_at) VALUES ($1,$2,$3,$4,false,NOW())`,
              [b.user_id, raceId, rr.rows[0].race_name, pay]
            );
          }
        }
        await pool.query(
          `INSERT INTO rumuma_results(race_id, race_name, horses, winner, total_pot, status, finished_at)
           VALUES ($1,$2,$3,$4,$5,'finished',NOW())`,
          [raceId, rr.rows[0].race_name, rr.rows[0].horses, winner, totalPot]
        );
        return respond(interaction, { embeds: [createEmbed("🏆 結果確定", `#${raceId} ${rr.rows[0].race_name}\n勝者：**${winner}**\n総額：${fmt(totalPot)}S\n勝ち馬購入者に**払い戻し受取**が可能になりました。`)] });
      }

      return ephemeralReply(interaction, { content: "未対応のメニューです。" }, 10000);
    }

    // ===== Modal =====
    if (interaction.type === InteractionType.ModalSubmit) {
      // 管理：コイン調整
      if (interaction.customId === "admin_adjust_modal") {
        const uid = interaction.fields.getTextInputValue("target_user").trim();
        const amount = parseInt(interaction.fields.getTextInputValue("amount"), 10);
        if (!Number.isFinite(amount)) return ephemeralReply(interaction, { content: "金額が不正です" });
        await addCoins(uid, amount, "admin_adjust", "管理者操作");
        return ephemeralReply(interaction, { content: `ユーザー:${uid} に ${fmt(amount)} 調整しました` });
      }

      // HL起点：ベット確定 → 最初のカード
      if (interaction.customId === "casino_bet_modal_highlow") {
        const uid = interaction.user.id;
        const input = interaction.fields.getTextInputValue("bet")?.trim();
        const req = Math.max(1, parseInt(input, 10) || CASINO_BET_DEFAULT);
        const bet = await resolveBet(uid, req);
        const balance = await getBalance(uid);
        if (balance < bet) return ephemeralReply(interaction, { embeds: [createEmbed("High & Low", `残高不足：必要 ${fmt(bet)}S / 保有 ${fmt(balance)}S`, Colors.Red)] }, 20000);
        const first = randInt(1, 13);
        await runShowyEffect(interaction, "🎯 High & Low", `ベット：**${fmt(bet)}S**（上限 ${fmt(CASINO_BET_MAX)}S）\n${await streakLine(uid)}`);
        const row = buildHLGuessRow("casino_highlow_guess", bet, first, "");
        await interaction.editReply({
          embeds: [createEmbed("🎯 High & Low", `🃏 最初のカード: **${first}**\n「高い」か「低い」か選んでください。（同値は不正解）`)],
          components: [row]
        }).catch(()=>{});
        return;
      }

      // Mines起点
      if (interaction.customId === "casino_bet_modal_mines") {
        const uid = interaction.user.id;
        const betIn = interaction.fields.getTextInputValue("bet")?.trim();
        const bombsIn = interaction.fields.getTextInputValue("bombs")?.trim();
        const betReq = Math.max(1, parseInt(betIn || "", 10) || CASINO_BET_DEFAULT);
        const bet = await resolveBet(uid, betReq);
        const balance = await getBalance(uid);
        if (balance < bet) return ephemeralReply(interaction, { embeds: [createEmbed("Mines", `残高不足：必要 ${fmt(bet)}S / 保有 ${fmt(balance)}S`, Colors.Red)] }, 20000);
        let bombs = Math.max(MINES_BOMBS_MIN, Math.min(MINES_BOMBS_MAX, parseInt(bombsIn || "", 10) || 3));
        return startMines(interaction, bet, bombs);
      }

      // Crash起点
      if (interaction.customId === "casino_bet_modal_crash") {
        const uid = interaction.user.id;
        const betIn = interaction.fields.getTextInputValue("bet")?.trim();
        const betReq = Math.max(1, parseInt(betIn || "", 10) || CASINO_BET_DEFAULT);
        const bet = await resolveBet(uid, betReq);
        const balance = await getBalance(uid);
        if (balance < bet) return ephemeralReply(interaction, { embeds: [createEmbed("Crash", `残高不足：必要 ${fmt(bet)}S / 保有 ${fmt(balance)}S`, Colors.Red)] }, 20000);
        return startCrash(interaction, bet);
      }

      // ルムマ：作成
      if (interaction.customId === "rumuma_create_modal") {
        const name = interaction.fields.getTextInputValue("race_name").trim();
        const horses = interaction.fields.getTextInputValue("horses").split(",").map(s=>s.trim()).filter(Boolean);
        if (!horses.length) return ephemeralReply(interaction, { content: "出走馬が空です。" });
        const r = await pool.query(
          `INSERT INTO rumuma_races(channel_id, host_id, race_name, horses, finished, winner)
           VALUES ($1,$2,$3,$4,false,NULL) RETURNING id`,
          [interaction.channelId, interaction.user.id, name, horses]
        );
        return ephemeralReply(interaction, { embeds: [createEmbed("🏇 レース作成", `#${r.rows[0].id} ${name}\n出走: ${horses.join(", ")}`)] }, 30000);
      }
      // ルムマ：モーダル購入（後方互換）
      if (interaction.customId === "rumuma_bet_modal") {
        const uid = interaction.user.id;
        const raceId = parseInt(interaction.fields.getTextInputValue("race_id"), 10);
        const horse = interaction.fields.getTextInputValue("horse").trim();
        const amt = parseInt(interaction.fields.getTextInputValue("amount"), 10);
        if (!Number.isFinite(raceId) || !horse || !Number.isFinite(amt) || amt<=0) return ephemeralReply(interaction, { content: "入力が不正です。" });
        const r = await pool.query(`SELECT horses, finished FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "レースが見つかりません。" });
        if (r.rows[0].finished) return ephemeralReply(interaction, { content: "このレースは締め切られています。" });
        if (!r.rows[0].horses.includes(horse)) return ephemeralReply(interaction, { content: "馬名が一覧にありません。" });
        const bal = await getBalance(uid);
        if (bal < amt) return ephemeralReply(interaction, { content: `残高不足（必要 ${fmt(amt)}S / 保有 ${fmt(bal)}S）` });
        await addCoins(uid, -amt, "rumuma_bet", `race:${raceId} ${horse}`);
        await pool.query(`INSERT INTO rumuma_bets(race_id,user_id,horse,amount) VALUES ($1,$2,$3,$4)`, [raceId, uid, horse, amt]);
        return ephemeralReply(interaction, { embeds: [createEmbed("🎫 ウマ券購入", `#${raceId} / ${horse} に **-${fmt(amt)}S**`)] }, 20000);
      }
      // ルムマ：選択式での購入金額モーダル
      if (interaction.customId.startsWith("rumuma_bet_amount_modal:")) {
        const [, raceIdStr, horseEnc] = interaction.customId.split(":");
        const raceId = parseInt(raceIdStr, 10);
        const horse = decodeURIComponent(horseEnc);
        const uid = interaction.user.id;
        const amt = parseInt(interaction.fields.getTextInputValue("amount"), 10);
        if (!Number.isFinite(amt) || amt<=0) return ephemeralReply(interaction, { content: "金額が不正です。" });
        const r = await pool.query(`SELECT horses, finished FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "レースが見つかりません。" });
        if (r.rows[0].finished) return ephemeralReply(interaction, { content: "このレースは締め切られています。" });
        if (!r.rows[0].horses.includes(horse)) return ephemeralReply(interaction, { content: "馬名が一覧にありません。" });
        const bal = await getBalance(uid);
        if (bal < amt) return ephemeralReply(interaction, { content: `残高不足（必要 ${fmt(amt)}S / 保有 ${fmt(bal)}S）` });
        await addCoins(uid, -amt, "rumuma_bet", `race:${raceId} ${horse}`);
        await pool.query(`INSERT INTO rumuma_bets(race_id,user_id,horse,amount) VALUES ($1,$2,$3,$4)`, [raceId, uid, horse, amt]);
        return ephemeralReply(interaction, { embeds: [createEmbed("🎫 ウマ券購入", `#${raceId} / ${horse} に **-${fmt(amt)}S**`)] }, 20000);
      }

      // ルムマ：締切（後方互換モーダル）
      if (interaction.customId === "rumuma_close_modal") {
        const raceId = parseInt(interaction.fields.getTextInputValue("race_id"), 10);
        const r = await pool.query(`UPDATE rumuma_races SET finished=true WHERE id=$1 RETURNING race_name`, [raceId]);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "レースが見つかりません。" });
        return ephemeralReply(interaction, { embeds: [createEmbed("✅ 投票締切", `#${raceId} ${r.rows[0].race_name}`)] });
      }
      // ルムマ：結果（後方互換モーダル）
      if (interaction.customId === "rumuma_result_modal") {
        const raceId = parseInt(interaction.fields.getTextInputValue("race_id"), 10);
        const winner = interaction.fields.getTextInputValue("winner").trim();
        const rr = await pool.query(`SELECT race_name, horses FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!rr.rowCount) return ephemeralReply(interaction, { content: "レースが見つかりません。" });
        if (!rr.rows[0].horses.includes(winner)) return ephemeralReply(interaction, { content: "勝ち馬が出走一覧にありません。" });
        const bets = await pool.query(`SELECT user_id, horse, amount FROM rumuma_bets WHERE race_id=$1`, [raceId]);
        const totalPot = bets.rows.reduce((s,b)=>s+Number(b.amount),0);
        await pool.query(`UPDATE rumuma_races SET finished=true, winner=$2 WHERE id=$1`, [raceId, winner]);

        const winTotal = bets.rows.filter(b => b.horse===winner).reduce((s,b)=>s+Number(b.amount),0);
        if (winTotal > 0) {
          for (const b of bets.rows.filter(b => b.horse===winner)) {
            const share = (Number(b.amount) / winTotal) * totalPot;
            const pay = Math.floor(share);
            await pool.query(
              `INSERT INTO pending_rewards(user_id, race_id, race_name, amount, claimed, created_at) VALUES ($1,$2,$3,$4,false,NOW())`,
              [b.user_id, raceId, rr.rows[0].race_name, pay]
            );
          }
        }
        await pool.query(
          `INSERT INTO rumuma_results(race_id, race_name, horses, winner, total_pot, status, finished_at)
           VALUES ($1,$2,$3,$4,$5,'finished',NOW())`,
          [raceId, rr.rows[0].race_name, rr.rows[0].horses, winner, totalPot]
        );
        return ephemeralReply(interaction, { embeds: [createEmbed("🏆 結果確定", `#${raceId} ${rr.rows[0].race_name}\n勝者：**${winner}**\n総額：${fmt(totalPot)}S\n勝ち馬購入者に**払い戻し受取**が可能になりました。`)] }, 30000);
      }

      // ルムマ：中止
      if (interaction.customId === "rumuma_cancel_modal") {
        const raceId = parseInt(interaction.fields.getTextInputValue("race_id"), 10);
        await refundRumuma(raceId, "管理操作");
        return ephemeralReply(interaction, { embeds: [createEmbed("⛔ 開催中止", `#${raceId} は返金済みです。`)] }, 20000);
      }

      // ガチャ：SSRモーダル（ロール作成＆遅延告知）
      if (interaction.customId === "gacha_ssr_modal") {
        const roleName = interaction.fields.getTextInputValue("role_name").trim();
        let roleColor = interaction.fields.getTextInputValue("role_color").trim();
        if (roleColor && !/^#?[0-9a-fA-F]{6}$/.test(roleColor)) roleColor = "#FFD700";
        if (roleColor && !roleColor.startsWith("#")) roleColor = `#${roleColor}`;

        // ロール作成/付与
        try {
          const guild = interaction.guild;
          const member = await guild.members.fetch(interaction.user.id);
          let role = guild.roles.cache.find(r => r.name === roleName);
          if (!role) role = await guild.roles.create({ name: roleName, color: roleColor || "#FFD700", reason: "SSR Reward Role" });
          if (!member.roles.cache.has(role.id)) await member.roles.add(role, "SSR Reward");
          // 遅延告知
          setTimeout(() => {
            broadcastSSRWin({
              guild,
              winnerUser: interaction.user,
              reward: GACHA_SSR_REWARD,
              roleName,
              roleColor: roleColor || "#FFD700"
            }).catch(()=>{});
          }, SSR_ROLE_MESSAGE_DELAY_MS);
          return ephemeralReply(interaction, { embeds: [createEmbed("SSRロール", `ロール **${roleName}** を付与しました！\n告知は少し遅れて出ます。`, Colors.Gold)] }, 20000);
        } catch (e) {
          logError("SSR role create/assign", e);
          return ephemeralReply(interaction, { content: "ロール作成または付与に失敗しました。" }, 15000);
        }
      }

      // フォールバック
      return ephemeralReply(interaction, { content: "この操作は現在利用できません。"}, 8000);
    }
  } catch (err) {
    logError("interaction error:", err);
    try { await ephemeralReply(interaction, { content: "処理中にエラーが発生しました" }); } catch {}
  }
});

// ==============================
// 発言報酬
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
  } catch (e) { logError("message reward error:", e); }
});

// ==============================
// デイリー受取リセット（JST 05:00）
// ==============================
schedule.scheduleJob("0 20 * * *", async () => { // UTC20:00 = JST05:00
  await pool.query("DELETE FROM daily_claims");
  logInfo("✅ デイリー受取リセット完了 (JST05:00)");
});

// ==============================
// Slashコマンド登録
// ==============================
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder().setName("ui").setDescription("UIを再表示")
      .addStringOption(o => o.setName("type").setDescription("admin/daily/rumuma/casino").setRequired(true)
        .addChoices({name:"admin", value:"admin"},{name:"daily", value:"daily"},{name:"rumuma", value:"rumuma"},{name:"casino", value:"casino"})),
    new SlashCommandBuilder().setName("jackpot").setDescription("ガチャJackpot残高を表示"),
    new SlashCommandBuilder().setName("balance").setDescription("自分の残高を表示"),
  ].map(c => c.toJSON());
  await client.application.commands.set(cmds);
}

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
  await registerCommands();

  if (UI_AUTO_POST_ON_READY) {
    if (process.env.ADMIN_CHANNEL_ID) await trySendUIById(process.env.ADMIN_CHANNEL_ID, "admin");
    if (DAILY_CHANNEL_ID) await trySendUIById(DAILY_CHANNEL_ID, "daily");
    if (process.env.RUMUMA_CHANNELS) {
      for (const cid of process.env.RUMUMA_CHANNELS.split(",").map(s => s.trim()).filter(Boolean)) {
        await trySendUIById(cid, "rumuma");
      }
    }
    if (CASINO_CHANNEL_ID) await trySendUIById(CASINO_CHANNEL_ID, "casino");
  } else {
    logInfo("ℹ️ UI auto-post on ready is disabled (UI_AUTO_POST_ON_READY=false). Use /ui when needed.");
  }
});

client.login(process.env.DISCORD_TOKEN);

// ==============================
// HTTP (Render)
// ==============================
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!\n");
}).listen(PORT, () => {
  logInfo(`🌐 HTTP server running on port ${PORT}`);
});
