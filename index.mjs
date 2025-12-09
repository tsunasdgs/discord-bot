// ==============================
// index.mjs  — TeamSDG's Bot (Full, drop-in)
// 互換維持 + ①〜⑦すべて実装 + 自動マイグレーション
// + iOS/ウマ券系 修正 & サーバー権威化
// + UI永続化ガード・Crash/Mines 終了強制反映
// ==============================

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
// トークン デバッグログ
// ==============================
const token = process.env.DISCORD_TOKEN;
console.log("DISCORD_TOKEN length:", token ? token.length : 0);
console.log("DISCORD_TOKEN head:", token ? token.slice(0, 6) : "(none)");

// ==============================
// DB
// ==============================
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ==============================
// クライアント
// ==============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// client エラーハンドラ（デバッグ用）
client.on("error", (err) => {
  console.error("🤖 client error:", err);
});

// ==============================
// 環境設定（新既定を反映／未設定でも動く）
// ==============================
const LOG_LEVEL           = (process.env.LOG_LEVEL || "info").toLowerCase();

// Faucet / Message reward
const DAILY_AMOUNT        = parseInt(process.env.DAILY_AMOUNT || "70", 10);        // ① 推奨既定 70
const REWARD_ROLE_ID      = process.env.REWARD_ROLE_ID || "";
const REWARD_PER_MESSAGE  = parseInt(process.env.REWARD_PER_MESSAGE || "5", 10);   // ① 5
const REWARD_DAILY_LIMIT  = parseInt(process.env.REWARD_DAILY_LIMIT || "8", 10);   // ① 8
const REWARD_COOLDOWN_SEC = parseInt(process.env.REWARD_COOLDOWN_SEC || "75", 10); // ① 75
const REWARD_MIN_MSG_LEN  = parseInt(process.env.REWARD_MIN_MSG_LEN || "11", 10);  // ① new 11

// 週上限（① 新機能）
const WEEKLY_EARNINGS_LIMIT = parseInt(process.env.WEEKLY_EARNINGS_LIMIT || "700", 10);
const WEEKLY_POLICY = (process.env.WEEKLY_POLICY || "discard").toLowerCase(); // "discard" | "carry"

// UI出力先
const DAILY_CHANNEL_ID    = process.env.DAILY_CHANNEL_ID || "";
const STATIC_CASINO_CHANNEL_ID = "1424340886585868368";
const CASINO_CHANNEL_ID        = process.env.CASINO_CHANNEL_ID || STATIC_CASINO_CHANNEL_ID;

// ガチャ経済（②）
const GACHA_COST = parseInt(process.env.GACHA_COST || "40", 10);
// 互換維持: SSR_BONUS_AMOUNT / GACHA_SSR_REWARD / 3000 優先順
const SSR_BONUS_AMOUNT_ENV = process.env.SSR_BONUS_AMOUNT;
const GACHA_SSR_REWARD_FALLBACK = parseInt(
  (SSR_BONUS_AMOUNT_ENV && SSR_BONUS_AMOUNT_ENV.trim() !== "" ? SSR_BONUS_AMOUNT_ENV : (process.env.GACHA_SSR_REWARD || "3000")), 10
);

// ② プリセット/ENV化
const GACHA_PRESET = (process.env.GACHA_PRESET || "A").toUpperCase(); // "A" or "B"
const GACHA_P_S    = Number(process.env.GACHA_P_S ?? "0.74");
const GACHA_R_S    = parseInt(process.env.GACHA_REWARD_S ?? "6", 10);
const GACHA_P_SR   = Number(process.env.GACHA_P_SR ?? "0.24");
const GACHA_R_SR   = parseInt(process.env.GACHA_REWARD_SR ?? "15", 10);
const GACHA_P_SSR  = Number(process.env.GACHA_P_SSR ?? "0.02");
const GACHA_R_SSR  = parseInt(process.env.GACHA_REWARD_SSR ?? String(GACHA_SSR_REWARD_FALLBACK), 10);

// ② JPテイク率（既定 0.20 に下げ）
const GACHA_JP_ENABLED    = (process.env.GACHA_JP_ENABLED || "true").toLowerCase() === "true";
const GACHA_JP_TAKE_RATE  = Number(process.env.GACHA_JP_TAKE_RATE || "0.20");
const GACHA_JP_SEED       = parseInt(process.env.GACHA_JP_SEED || "1000", 10);
const GACHA_JP_CAP        = parseInt(process.env.GACHA_JP_CAP || "100000", 10);
const GACHA_JP_HIT_BASE   = Number(process.env.GACHA_JP_HIT_BASE || "0.0005");
const GACHA_JP_CHANNEL_ID = process.env.GACHA_JP_CHANNEL_ID || DAILY_CHANNEL_ID || CASINO_CHANNEL_ID;
const GACHA_JP_NOTIFY_MIN = parseInt(process.env.GACHA_JP_NOTIFY_MIN || "2000", 10);

// ガチャ演出 TTL（SSR 10分は維持）
const GACHA_RESULT_TTL_MS = parseInt(process.env.GACHA_RESULT_TTL_MS || "8000", 10);
const GACHA_RESULT_TTL_MS_SSR = parseInt(process.env.GACHA_RESULT_TTL_MS_SSR || "600000", 10); // 10分

// SSRロール告知遅延（既定維持）
const SSR_ROLE_MESSAGE_DELAY_MS = parseInt(process.env.SSR_ROLE_MESSAGE_DELAY_MS || "3000", 10);

// カジノ共通
const CASINO_BET_DEFAULT  = parseInt(process.env.CASINO_BET_DEFAULT || "10", 10);
const CASINO_BET_MAX      = parseInt(process.env.CASINO_BET_MAX || "500", 10);

// HL/DU（③）
const HL_BASE_MULT        = Number(process.env.HL_BASE_MULT || "1.37");  // 勝利時の基礎倍率（71%成功率想定）
const DOUBLEUP_MULT       = Number(process.env.DOUBLEUP_MULT || "1.32"); // 旧×2 → ×1.32
const DOUBLEUP_MAX_STEPS  = parseInt(process.env.DOUBLEUP_MAX_STEPS || "2", 10); // 既定2
const CASINO_STREAK_MAX   = parseInt(process.env.CASINO_STREAK_MAX || "2", 10);  // 既定2（1勝=+5%を踏襲）

// Mines（④）
const MINES_TOTAL_CELLS   = 15; // 5x3
const MINES_BOMBS_MIN     = 2;
const MINES_BOMBS_MAX     = 5;
const MINES_PEEK_PENALTY  = Number(process.env.MINES_PEEK_PENALTY || "0.9");
const MINES_EDGE          = Number(process.env.MINES_EDGE || "0.98");

// Crash（⑤）
const CRASH_EDGE               = Number(process.env.CRASH_EDGE || "0.04");  // ハウスエッジ 4%
const CRASH_SPEED_PER_SEC      = Number(process.env.CRASH_SPEED_PER_SEC || "0.16"); // 上昇速度
const CRASH_TICK_MS            = parseInt(process.env.CRASH_TICK_MS || "500", 10);
const CRASH_MIN_DURATION_SEC   = Number(process.env.CRASH_MIN_DURATION_SEC || "2.0");
const CRASH_MAX_X              = Number(process.env.CRASH_MAX_X || "10.0");

// ルムマ（⑥ レイク）
const RUMUMA_RAKE_BP     = Number(process.env.RUMUMA_RAKE_BP || "2"); // %

// 演出（⑦）
const FX_FIREWORKS_ENABLED = (process.env.FX_FIREWORKS_ENABLED || "true").toLowerCase() === "true";

// その他
const UI_AUTO_POST_ON_READY = (process.env.UI_AUTO_POST_ON_READY || "false").toLowerCase() === "true";
const SIGNING_SECRET      = process.env.SIGNING_SECRET || "sdgs-secret";

// ウマ券一覧 表示パラメータ（既存強化）
const RUMUMA_TICKET_HISTORY_LIMIT = parseInt(process.env.RUMUMA_TICKET_HISTORY_LIMIT || "30", 10);
const RUMUMA_TICKET_KEEP_DAYS     = parseInt(process.env.RUMUMA_TICKET_KEEP_DAYS || "60", 10);

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
  if (!s) return s; if (s.length <= limit) return s;
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

// JSTの週（Mon 00:00〜）境界をUTCに変換して返す
function getJSTWeekBounds(date = new Date()) {
  const now = new Date(date);
  const jstMs = now.getTime() + 9*3600*1000;           // JSTに寄せる
  const j = new Date(jstMs);
  const dow = j.getUTCDay();                           // 0:Sun..6:Sat
  const deltaDays = (dow + 6) % 7;                     // 月曜起点
  const jstWeekStartUTCms = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate(), 0,0,0) - deltaDays*86400*1000;
  const startUTC = new Date(jstWeekStartUTCms - 9*3600*1000); // JST 00:00 → UTC
  const endUTC   = new Date(startUTC.getTime() + 7*86400*1000);
  return { startUTC, endUTC };
}

// 週繰越用のキー（JST週の開始日ISO）
function jstWeekStartKey(d = new Date()){
  const { startUTC } = getJSTWeekBounds(d);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(startUTC.getTime()+9*3600*1000));
  const get=(t)=>parts.find(p=>p.type===t)?.value??"";
  return `${get("year")}-${get("month")}-${get("day")}`; // YYYY-MM-DD (JST週開始)
}

function signToken(payloadStr){
  const mac = crypto.createHmac("sha256", SIGNING_SECRET).update(payloadStr).digest("hex").slice(0,24);
  return mac;
}
function verifyToken(payloadStr, sig){
  try{ return signToken(payloadStr) === sig; }catch{ return false; }
}

// 全角→半角（数字・英A-F・記号の一部）
function toHalfWidth(str){
  if (!str) return "";
  return str.replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
            .replace(/　/g, " ");
}
// 金額などの数値入力を正規化（全角数字→半角、桁区切り削除、切り捨て、NaN→fallback）
function normalizeInt(input, fallback = 0){
  if (typeof input !== "string") return Number.isFinite(input) ? Math.trunc(input) : fallback;
  let s = toHalfWidth(input).replace(/[,_\s，．。]/g, "").trim();
  // 先頭の+/-のみ許可
  const m = s.match(/^[+-]?\d+/);
  if (!m) return fallback;
  const n = Math.trunc(Number(m[0]));
  return Number.isFinite(n) ? n : fallback;
}
// カラーコード正規化（#RRGGBB）全角#英数対応・不正時は #FFD700
function normalizeHexColor(input, def = "#FFD700"){
  let s = toHalfWidth((input||"").trim());
  s = s.replace(/^#?([0-9a-fA-F]{6}).*$/,"#$1");
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return def;
  return s.toUpperCase();
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
const randInt = (min, max) => Math.floor(Math.random() * (max - max + 1) + min); // ←後で修正（下で再定義されているのでここは実際未使用でもOK）
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; } // 正しい定義（下に再掲）

async function resolveBet(userId, requested) {
  const bal = await getBalance(userId);
  const maxByBalance = Math.max(0, Math.min(bal, CASINO_BET_MAX));
  const req = Math.max(1, Number.isFinite(requested) ? requested : CASINO_BET_DEFAULT);
  return Math.max(1, Math.min(req, maxByBalance));
}

// ==============================
// 週上限 / 繰越（①）
// ==============================
async function weeklyEarnedJST(uid) {
  const { startUTC, endUTC } = getJSTWeekBounds(new Date());
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS s
       FROM history
      WHERE user_id=$1
        AND type IN ('daily','msg_reward')
        AND created_at >= $2 AND created_at < $3`,
    [uid, startUTC, endUTC]
  );
  return Number(r.rows[0].s) || 0;
}
// carry: 翌週開始キー（JST）で保存し、該当週に入った最初の給付時に自動適用
async function applyCarryIfAny(uid) {
  const key = jstWeekStartKey(new Date()); // 今週キー
  const r = await pool.query(`SELECT carry_amount FROM weekly_carry WHERE user_id=$1 AND week_start=$2`, [uid, key]);
  if (r.rowCount && Number(r.rows[0].carry_amount) > 0) {
    const amt = Number(r.rows[0].carry_amount);
    await addCoins(uid, amt, "weekly_carry", "先週からの繰越");
    await pool.query(`DELETE FROM weekly_carry WHERE user_id=$1 AND week_start=$2`, [uid, key]);
    return amt;
  }
  return 0;
}
// 付与可否計算／carry発行
async function computeWeeklyGrant(uid, want) {
  if (WEEKLY_EARNINGS_LIMIT <= 0) return { grant: want, carry: 0, reason: "" };
  const earned = await weeklyEarnedJST(uid);
  const remain = Math.max(0, WEEKLY_EARNINGS_LIMIT - earned);
  if (remain <= 0) {
    if (WEEKLY_POLICY === "carry" && want > 0) {
      const nextKey = jstWeekStartKey(new Date(Date.now() + 7*86400*1000)); // 翌週キー
      await pool.query(
        `INSERT INTO weekly_carry(user_id, week_start, carry_amount)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id, week_start) DO UPDATE SET carry_amount=weekly_carry.carry_amount + EXCLUDED.carry_amount`,
        [uid, nextKey, want]
      );
      return { grant: 0, carry: want, reason: "週上限到達（全額繰越）" };
    }
    return { grant: 0, carry: 0, reason: "週上限到達（付与なし）" };
  }
  const grant = Math.min(remain, want);
  const over  = Math.max(0, want - grant);
  if (over > 0 && WEEKLY_POLICY === "carry") {
    const nextKey = jstWeekStartKey(new Date(Date.now() + 7*86400*1000));
    await pool.query(
      `INSERT INTO weekly_carry(user_id, week_start, carry_amount)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id, week_start) DO UPDATE SET carry_amount=weekly_carry.carry_amount + EXCLUDED.carry_amount`,
      [uid, nextKey, over]
    );
    return { grant, carry: over, reason: "一部繰越" };
  }
  return { grant, carry: 0, reason: over>0?"一部超過（破棄）":"" };
}

// ==============================
// DB初期化（自動マイグレーション含む）
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

  // 週繰越（① carry）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_carry (
      user_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      carry_amount INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, week_start)
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
  // ⑥ rake_amount 追加
  await pool.query(`ALTER TABLE rumuma_results ADD COLUMN IF NOT EXISTS rake_amount INTEGER DEFAULT 0;`);

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

  // カジノ汎用セッション（DU）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS casino_sessions (
      user_id TEXT PRIMARY KEY,
      game TEXT,
      stake INTEGER,
      step INTEGER,
      updated_at TIMESTAMP DEFAULT now(),
      meta JSONB DEFAULT '{}'::jsonb
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
      updated_at TIMESTAMP DEFAULT now(),
      session_id TEXT
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
      updated_at TIMESTAMP DEFAULT now(),
      session_id TEXT
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

  // Indexes
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
    case "weekly_carry":    typeLabel = "🔄 週繰越";     color = Colors.Aqua;   break;
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
// ガチャ設定（②）
// ==============================
function normalizedCDF([pS, pSR, pSSR]) {
  let total = pS + pSR + pSSR;
  if (total <= 0) return [0.74, 0.98, 1.00]; // 安全側デフォ
  const nS = pS / total;
  const nSR = pSR / total;
  const nSSR = 1 - nS - nSR; // 端数はSSRへ寄せ
  return [Number(nS.toFixed(6)), Number((nS + nSR).toFixed(6)), 1.0];
}
function currentGachaConfig() {
  if (GACHA_PRESET === "B") {
    const pS=0.75, pSR=0.24, pSSR=0.01;
    const [c1,c2,c3]=normalizedCDF([pS,pSR,pSSR]);
    return {
      preset: "B",
      cdf: [c1,c2,c3],
      reward: { S: 6, SR: 15, SSR: Math.max(GACHA_R_SSR, 2000) }
    };
  }
  // A (既定)
  const [c1,c2,c3]=normalizedCDF([GACHA_P_S, GACHA_P_SR, GACHA_P_SSR]);
  return {
    preset: "A",
    cdf: [c1,c2,c3],
    reward: { S: GACHA_R_S, SR: GACHA_R_SR, SSR: GACHA_R_SSR }
  };
}
function pickGacha(cdf) {
  const r = Math.random();
  if (r < cdf[0]) return "S";
  if (r < cdf[1]) return "SR";
  return "SSR";
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
// DU（汎用：iOS対策 meta 付き）
// ==============================
async function duStart(userId, pendingWin, gameLabel, meta = {}) {
  await pool.query(`
    INSERT INTO casino_sessions(user_id, game, stake, step, meta, updated_at)
    VALUES ($1, $2, $3, 0, $4::jsonb, NOW())
    ON CONFLICT (user_id) DO UPDATE SET game=$2, stake=$3, step=0, meta=$4::jsonb, updated_at=NOW()
  `, [userId, `DU_${gameLabel}`, pendingWin, JSON.stringify(meta || {})]);
}
async function duGet(userId) {
  const r = await pool.query(`SELECT game, stake, step, COALESCE(meta,'{}'::jsonb) AS meta FROM casino_sessions WHERE user_id=$1`, [userId]);
  return r.rowCount ? { ...r.rows[0], meta: r.rows[0].meta || {} } : null;
}
async function duSave(userId, stake, step, meta = null) {
  if (meta) {
    await pool.query(`UPDATE casino_sessions SET stake=$2, step=$3, meta=$4::jsonb, updated_at=NOW() WHERE user_id=$1`,
      [userId, stake, step, JSON.stringify(meta)]);
  } else {
    await pool.query(`UPDATE casino_sessions SET stake=$2, step=$3, updated_at=NOW() WHERE user_id=$1`,
      [userId, stake, step]);
  }
}
async function duClear(userId) {
  await pool.query(`DELETE FROM casino_sessions WHERE user_id=$1`, [userId]);
}

// ==============================
// 演出（⑦ 花火ON/OFF）
// ==============================
async function runShowyEffect(interaction, title, lines){
  const frames = [
    `🕹️ **${title}**\n${lines}\n\n▶️ スタート…`,
    `🕹️ **${title}**\n${lines}\n\n🎞️ ぐるぐる…`,
    `🕹️ **${title}**\n${lines}\n\n🔔 ドキドキ…`,
  ];
  await respond(interaction, { embeds:[createEmbed(title, frames[0], Colors.Blurple)] }, { ephemeral:true, noUpdate:false });
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
    const base = await ch.send({ embeds: [createEmbed(head, body, Colors.Gold)] });
    if (!FX_FIREWORKS_ENABLED) return;

    const stages = ["🎇🎇🎇 **FIREWORKS** 🎇🎇🎇","🎊🎊🎊 **CONGRATS!** 🎊🎊🎊","✨✨✨ **GLORY!** ✨✨✨"];
    for (let i=0;i<stages.length;i++){
      await new Promise(r=>setTimeout(r, 600));
      await base.edit({ embeds: [createEmbed(head, body + `\n\n${stages[i]}`, Colors.Gold)] }).catch(()=>{});
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
      new ButtonBuilder().setCustomId("admin_rumuma_reset").setLabel("🧹 レース全リセット（開催中）").setStyle(ButtonStyle.Danger),
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
async function resolveUIChannel(type, interaction) {
  let targetId = null;
  if (type === "admin") targetId = process.env.ADMIN_CHANNEL_ID || null;
  else if (type === "daily") targetId = DAILY_CHANNEL_ID || null;
  else if (type === "casino") targetId = CASINO_CHANNEL_ID || null;
  else if (type === "rumuma") {
    targetId = process.env.RUMUMA_DEFAULT_CHANNEL_ID || null;
    if (!targetId && process.env.RUMUMA_CHANNELS) {
      const first = process.env.RUMUMA_CHANNELS.split(",").map(s => s.trim()).filter(Boolean)[0];
      if (first) targetId = first;
    }
  }
  if (targetId) {
    const ch = await client.channels.fetch(targetId).catch(() => null);
    if (ch) return ch;
  }
  return interaction.channel;
}

// ==============================
// Mines：内部（stale UI対策：sessionIdを署名に含める）
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
  const sid = session.session_id || "s";
  for (let r=0;r<3;r++){
    const row = new ActionRowBuilder();
    for (let c=0;c<5;c++){
      const idx = r*5 + c;
      const opened = bitHas(session.opened_mask, idx);
      const isBomb = bitHas(session.bombs_mask, idx);
      let label = "❓";
      if (revealAll && isBomb) label = "💥";
      else if (opened) label = "✅";
      const payload = `${session.user_id || "u"}:${sid}:${idx}`;
      const sig = signToken(payload);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`mines_open:${sid}:${idx}:${sig}`)
          .setLabel(label)
          .setStyle(opened ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(locked || opened)
      );
    }
    rows.push(row);
  }
  const mult = minesMultiplier(session.bombs, bitCount(session.opened_mask), Number(session.penalty || 1.0));
  const control = new ActionRowBuilder();
  const pSig = signToken(`${session.user_id || "u"}:${sid}:cash`);
  control.addComponents(
    new ButtonBuilder().setCustomId(`mines_cash:${sid}:${pSig}`)
      .setLabel(`✅ 確定（×${mult.toFixed(2)}）`).setStyle(ButtonStyle.Success)
      .setDisabled(locked)
  );
  const peekSig = signToken(`${session.user_id || "u"}:${sid}:peek`);
  control.addComponents(
    new ButtonBuilder().setCustomId(`mines_peek:${sid}:${peekSig}`)
      .setLabel("👁️ ちら見（倍率-10%）").setStyle(ButtonStyle.Secondary)
      .setDisabled(locked || !session.can_peek)
  );
  rows.push(control);
  return rows;
}

// ==============================
// Crash：内部（stale UI対策：sessionId）
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
// Gacha 本体（②） & ゲーム群
// ==============================
async function playGacha(interaction) {
  const uid = interaction.user.id;
  const balance = await getBalance(uid);
  if (balance < GACHA_COST) {
    return ephemeralReply(interaction, { embeds: [createEmbed("ガチャ", `残高不足：必要 ${fmt(GACHA_COST)}S / 保有 ${fmt(balance)}S`, Colors.Red)] });
  }

  // 抽選設定
  const conf = currentGachaConfig();
  const rarity = pickGacha(conf.cdf);
  const reward = conf.reward[rarity];
  const color  = rarity==="SSR" ? Colors.Gold : (rarity==="SR"? Colors.Purple : Colors.Grey);

  if (rarity === "SSR") {
    await runShowyEffect(interaction, "🎲 ガチャ", `抽選中…\n必要：${fmt(GACHA_COST)}S / 当選で即時付与`);
    // 支払い
    await addCoins(uid, -GACHA_COST, "gacha", `ガチャ支払い:${GACHA_COST}S`);
    await jpContribute(GACHA_COST);

    // 付与
    await addCoins(uid, reward, "gacha_reward", `ガチャ当選:SSR`);
    await jpTryHitSSR(uid, interaction.guild);

    const jp = await jackpotLine();
    const payload = `${uid}:openmodal`;
    const sig = signToken(payload);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gacha_ssr_open:${uid}:${sig}`).setLabel("🏷️ ロール作成へ").setStyle(ButtonStyle.Primary)
    );
    await interaction.editReply({
      embeds: [createEmbed("🎲 ガチャ結果", `結果: **SSR**\n🟢 +${fmt(reward)}S\n${jp || ""}\n\n祝！ロール名とカラーを入力して記念ロールを作成できます。`, color)],
      components: [row]
    }).catch(()=>{});
    setTimeout(() => interaction.deleteReply?.().catch(()=>{}), GACHA_RESULT_TTL_MS_SSR);
    return;
  }

  // S / SR
  await runShowyEffect(interaction, "🎲 ガチャ", `抽選中…\n必要：${fmt(GACHA_COST)}S / 当選で即時付与`);
  await addCoins(uid, -GACHA_COST, "gacha", `ガチャ支払い:${GACHA_COST}S`);
  await jpContribute(GACHA_COST);
  await addCoins(uid, reward, "gacha_reward", `ガチャ当選:${rarity}`);
  const jp = await jackpotLine();
  await interaction.editReply({
    embeds: [createEmbed("🎲 ガチャ結果", `結果: **${rarity}**\n🟢 +${fmt(reward)}S\n${jp || ""}`, color)],
    components: []
  }).catch(()=>{});
  setTimeout(() => interaction.deleteReply?.().catch(()=>{}), GACHA_RESULT_TTL_MS);
}

// Mines：開始/操作
async function startMines(interaction, bet, bombs) {
  const uid = interaction.user.id;
  await addCoins(uid, -bet, "casino_mines", `BET start bombs:${bombs}`);
  const bombs_mask = randomBombMask(bombs);
  const sessionId = crypto.randomBytes(8).toString("hex");
  await pool.query(`
    INSERT INTO casino_mines_sessions(user_id, bet, bombs, bombs_mask, opened_mask, can_peek, penalty, session_id, created_at, updated_at)
    VALUES ($1,$2,$3,$4,0,true,1.0,$5,NOW(),NOW())
    ON CONFLICT (user_id) DO UPDATE SET bet=$2, bombs=$3, bombs_mask=$4, opened_mask=0, can_peek=true, penalty=1.0, session_id=$5, updated_at=NOW()
  `, [uid, bet, bombs, bombs_mask, sessionId]);

  const session = { user_id: uid, bet, bombs, bombs_mask, opened_mask: 0, can_peek: true, penalty: 1.0, session_id: sessionId };
  const rows = minesGridRows(session, false, false);
  const mult = minesMultiplier(bombs, 0, 1.0);
  await respond(interaction, {
    embeds: [createEmbed("💣 Mines", `爆弾 **${bombs}** / マス **${MINES_TOTAL_CELLS}**\n現在倍率：×${mult.toFixed(2)}\n安全マスを開けるか、いつでも「確定」で終了できます。`, Colors.DarkGrey)],
    components: rows
  }, { ephemeral: false, noUpdate: false });
}
async function handleMinesOpen(interaction, sid, idx) {
  const uid = interaction.user.id;
  const res = await pool.query(`SELECT * FROM casino_mines_sessions WHERE user_id=$1`, [uid]);
  if (!res.rowCount) {
    // 終了してるので元メッセージを潰しておく
    try {
      await interaction.message?.edit({
        embeds: [createEmbed("💣 Mines", "このゲームは終了しています。最新のメニューからもう一度開始してください。", Colors.Red)],
        components: []
      });
    } catch {}
    return ephemeralReply(interaction, { content: "Minesセッションが見つかりません。" });
  }
  const s = res.rows[0];
  if (s.session_id && s.session_id !== sid) {
    return ephemeralReply(interaction, { content: "古いUIです。最新の盤面から操作してください。" }, 12000);
  }
  if (bitHas(s.opened_mask, idx)) {
    return respond(interaction, { components: minesGridRows(s, false, false) });
  }
  if (bitHas(s.bombs_mask, idx)) {
    // 爆発 → セッション削除して盤面表示を固定
    const reveal = minesGridRows(s, true, true);
    await pool.query(`DELETE FROM casino_mines_sessions WHERE user_id=$1`, [uid]);
    return respond(interaction, {
      embeds: [createEmbed("💣 Mines", `💥 **爆発！** ベットは没収されました。`, Colors.Red)],
      components: reveal
    }, { deleteAfterMs: 60000 });
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
async function handleMinesCash(interaction, sid) {
  const uid = interaction.user.id;
  const res = await pool.query(`SELECT * FROM casino_mines_sessions WHERE user_id=$1`, [uid]);
  if (!res.rowCount) {
    try {
      await interaction.message?.edit({
        embeds: [createEmbed("💣 Mines", "このゲームは終了しています。", Colors.Red)],
        components: []
      });
    } catch {}
    return ephemeralReply(interaction, { content: "Minesセッションが見つかりません。" });
  }
  const s = res.rows[0];
  if (s.session_id && s.session_id !== sid) {
    return ephemeralReply(interaction, { content: "古いUIです。最新の盤面から操作してください。" }, 12000);
  }
  const opened = bitCount(s.opened_mask);
  const mult = minesMultiplier(s.bombs, opened, Number(s.penalty || 1.0));
  const pay = Math.floor(s.bet * mult);
  await addCoins(uid, pay, "casino_mines", `CASHOUT opened:${opened} mult:${mult.toFixed(2)} pay:${pay}`);
  await pool.query(`DELETE FROM casino_mines_sessions WHERE user_id=$1`, [uid]);
  return respond(interaction, {
    embeds: [createEmbed("💣 Mines", `✅ 確定 **+${fmt(pay)}S**（×${mult.toFixed(2)}）`, Colors.Green)],
    components: []
  }, { deleteAfterMs: 60000 });
}
async function handleMinesPeek(interaction, sid) {
  const uid = interaction.user.id;
  const res = await pool.query(`SELECT * FROM casino_mines_sessions WHERE user_id=$1`, [uid]);
  if (!res.rowCount) {
    try {
      await interaction.message?.edit({
        embeds: [createEmbed("💣 Mines", "このゲームは終了しています。", Colors.Red)],
        components: []
      });
    } catch {}
    return ephemeralReply(interaction, { content: "Minesセッションが見つかりません。" });
  }
  const s = res.rows[0];
  if (s.session_id && s.session_id !== sid) {
    return ephemeralReply(interaction, { content: "古いUIです。最新の盤面から操作してください。" }, 12000);
  }
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

// Crash：開始/確定（⑤）
async function startCrash(interaction, bet) {
  const uid = interaction.user.id;
  const target = genCrashTarget();
  const sessionId = crypto.randomBytes(8).toString("hex");
  await addCoins(uid, -bet, "casino_crash", `BET start target:${target}x`);
  await pool.query(`
    INSERT INTO casino_crash_sessions(user_id, bet, started_at, target_crash, cashed_at, session_id, created_at, updated_at)
    VALUES ($1,$2,NOW(),$3,NULL,$4,NOW(),NOW())
    ON CONFLICT (user_id) DO UPDATE SET bet=$2, started_at=NOW(), target_crash=$3, cashed_at=NULL, session_id=$4, updated_at=NOW()
  `, [uid, bet, target, sessionId]);

  const sig = signToken(`${uid}:${sessionId}:cash`);
  await respond(interaction, {
    embeds: [createEmbed("📈 Crash", `倍率が上昇します。**クラッシュ前**に「確定」を押すと、その倍率で払い戻し！\n開始直後の即クラッシュは起きにくい設定です（調整可）。`, Colors.Green)],
    components: [ new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`crash_cash:${sessionId}:${sig}`).setLabel("✅ 確定").setStyle(ButtonStyle.Success)
    ) ]
  }, { ephemeral: false, noUpdate: false });

  // 既存タイマーがいたら消す（古いタイマーが新しいゲームを触らないように）
  if (crashTimers.has(uid)) {
    clearInterval(crashTimers.get(uid));
    crashTimers.delete(uid);
  }

  const timer = setInterval(async () => {
    try {
      const r = await pool.query(`SELECT bet, started_at, target_crash, cashed_at FROM casino_crash_sessions WHERE user_id=$1`, [uid]);
      if (!r.rowCount) {
        clearInterval(timer); crashTimers.delete(uid);
        return;
      }
      const s = r.rows[0];
      const nowX = crashMultipleSince(s.started_at);
      const tsec = (Date.now() - new Date(s.started_at).getTime()) / 1000;

      // 既に確定してればここで終了
      if (s.cashed_at != null) {
        clearInterval(timer); crashTimers.delete(uid);
        return;
      }

      // クラッシュ到達
      if (tsec >= CRASH_MIN_DURATION_SEC && nowX >= Number(s.target_crash)) {
        clearInterval(timer); crashTimers.delete(uid);
        // 先にDBから消す
        await pool.query(`DELETE FROM casino_crash_sessions WHERE user_id=$1`, [uid]).catch(()=>{});
        await interaction.editReply({
          embeds: [createEmbed("📈 Crash", `💥 **CRASH** at ${Number(s.target_crash).toFixed(2)}x\n払い戻しなし`, Colors.Red)],
          components: []
        }).catch(()=>{});
        setTimeout(() => {
          interaction.deleteReply?.().catch(() => {});
        }, 60000);
        return;
      }

      // 進行中 → 倍率だけ更新
      await interaction.editReply({
        embeds: [createEmbed("📈 Crash", `現在倍率：**${nowX.toFixed(2)}x**\nクラッシュ前に確定を！`, Colors.Green)]
      }).catch(()=>{});
    } catch (e) {
      // 何かあったらタイマーとセッションを落として終了状態に
      clearInterval(timer); crashTimers.delete(uid);
      await pool.query(`DELETE FROM casino_crash_sessions WHERE user_id=$1`, [uid]).catch(()=>{});
      try {
        await interaction.editReply({
          embeds: [createEmbed("📈 Crash", "ゲーム表示の更新に失敗したため終了しました。", Colors.Red)],
          components: []
        });
      } catch {}
    }
  }, Math.max(300, CRASH_TICK_MS|0));
  crashTimers.set(uid, timer);
}
async function handleCrashCash(interaction, sid) {
  const uid = interaction.user.id;
  const r = await pool.query(`SELECT bet, started_at, target_crash, cashed_at, session_id FROM casino_crash_sessions WHERE user_id=$1`, [uid]);
  if (!r.rowCount) return ephemeralReply(interaction, { content: "Crashセッションが見つかりません。" });
  const s = r.rows[0];
  if (s.session_id && s.session_id !== sid) {
    return ephemeralReply(interaction, { content: "古いUIです。最新のゲームから操作してください。" }, 12000);
  }
  const nowX = crashMultipleSince(s.started_at);
  const tsec = (Date.now() - new Date(s.started_at).getTime()) / 1000;

  if (tsec >= CRASH_MIN_DURATION_SEC && nowX >= Number(s.target_crash)) {
    await pool.query(`DELETE FROM casino_crash_sessions WHERE user_id=$1`, [uid]);
    if (crashTimers.has(uid)) { clearInterval(crashTimers.get(uid)); crashTimers.delete(uid); }
    return respond(interaction, { embeds: [createEmbed("📈 Crash", `💥 **CRASH** at ${Number(s.target_crash).toFixed(2)}x\n払い戻しなし`, Colors.Red)], components: [] }, { deleteAfterMs: 60000 });
  }
  if (s.cashed_at != null) {
    if (crashTimers.has(uid)) { clearInterval(crashTimers.get(uid)); crashTimers.delete(uid); }
    return respond(interaction, { embeds: [createEmbed("📈 Crash", `既に ${Number(s.cashed_at).toFixed(2)}x で確定済みです。`, Colors.Grey)], components: [] });
  }
  const pay = Math.floor(Number(s.bet) * nowX);
  await addCoins(uid, pay, "casino_crash", `CASHOUT at ${nowX.toFixed(2)}x pay:${pay}`);
  await pool.query(`UPDATE casino_crash_sessions SET cashed_at=$2, updated_at=NOW() WHERE user_id=$1`, [uid, nowX]);
  if (crashTimers.has(uid)) { clearInterval(crashTimers.get(uid)); crashTimers.delete(uid); }
  // ゲーム終了なのでセッションも削除
  await pool.query(`DELETE FROM casino_crash_sessions WHERE user_id=$1`).catch(()=>{});
  return respond(interaction, { embeds: [createEmbed("📈 Crash", `✅ 確定 **+${fmt(pay)}S**（${nowX.toFixed(2)}x）`, Colors.Green)], components: [] }, { deleteAfterMs: 60000 });
}

// HL（③）：基準カード公開＆倍率再設計
function hlNearMissText(first, next) {
  if (Math.abs(next - first) === 1) return "（惜しい！±1のニアミス）";
  return "";
}
function buildHLGuessRow(tag, bet, first, stepOrBlank = "") {
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
// ✅ iOS対策：3ボタン1行ビルダー（HL用クラスタ）
// ==============================
function buildDUClusterRowHL(uid, stake, first, step) {
  const payload = `${uid}:${stake}:${step}:HL`;
  const sig = signToken(payload);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`du_hl_guess:H:${stake}:${first}:${step}`)
      .setLabel("🔺 高い").setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`du_take:${stake}:${step}:HL:${sig}`)
      .setLabel("✅ 勝ち分を受け取る").setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`du_hl_guess:L:${stake}:${first}:${step}`)
      .setLabel("🔻 低い").setStyle(ButtonStyle.Danger),
  );
}

// ==============================
// 返信系ヘルパ（iOS二重エフェメラル防止）
// ==============================
// 常設UIメッセージかどうかを判定して壊さないようにする
function isPersistentUIMessage(interaction) {
  if (!interaction?.message) return false;
  const msg = interaction.message;
  const title = msg.embeds?.[0]?.title || msg.embeds?.[0]?.data?.title;
  const content = msg.content || "";
  if (title === "コインメニュー") return true;
  if (title === "🎰 TeamSDG’s Casino 🎰") return true;
  if (content === "レースメニュー") return true;
  if (content === "管理メニュー") return true;
  return false;
}

// ❗ボタン/セレクト時：update() → editReply() → deferUpdate()。新規reply()はしない
async function respond(interaction, payload, { ephemeral = false, noUpdate = false, deleteAfterMs = 0 } = {}) {
  const data = { ...payload };
  if (typeof data.content === "string") data.content = limitContent(data.content);

  const scheduleDelete = (msg) => {
    if (!deleteAfterMs || deleteAfterMs <= 0) return;
    setTimeout(() => {
      if (msg && typeof msg.delete === "function") {
        msg.delete().catch(() => {});
      }
      interaction.deleteReply?.().catch(() => {});
    }, deleteAfterMs);
  };

  try {
    const isComponent = (interaction.isButton?.() || interaction.isStringSelectMenu?.());
    const persistent = isComponent && isPersistentUIMessage(interaction);

    if (isComponent) {
      // 常設UIは上書きしない：エフェメラルで返す
      if (persistent && (!data.components || data.components.length === 0)) {
        try {
          let m;
          if (interaction.deferred || interaction.replied) {
            m = await interaction.followUp({ ...data, ephemeral: true });
          } else {
            m = await interaction.reply({ ...data, ephemeral: true });
          }
          scheduleDelete(m);
          return m;
        } catch (e) {
          try { await interaction.deferUpdate(); } catch {}
          return;
        }
      }

      if (!noUpdate) {
        try {
          const m = await interaction.update(data);
          scheduleDelete(m);
          return m;
        } catch (_) {}
      }
      if (interaction.deferred || interaction.replied) {
        try {
          const m = await interaction.editReply(data);
          scheduleDelete(m);
          return m;
        } catch (_) {}
      }
      try {
        await interaction.deferUpdate();
        scheduleDelete(null);
      } catch {}
      return;
    } else {
      if (interaction.deferred || interaction.replied) {
        try {
          const m = await interaction.editReply(data);
          scheduleDelete(m);
          return m;
        } catch (_) {}
      }
      try {
        const m = await interaction.reply({ ...data, ephemeral });
        scheduleDelete(m);
        return m;
      } catch (_) {}
      const m = await interaction.followUp({ ...data, ephemeral: true });
      scheduleDelete(m);
      return m;
    }
  } catch (e) {
    logError("respond() failed:", e);
    try { await interaction.deferUpdate(); } catch {}
  }
}
// エフェメラル専用：必要時のみ使う
async function ephemeralReply(interaction, payload, ms = 15000) {
  let msg;
  try {
    if (interaction.deferred || interaction.replied) {
      msg = await interaction.followUp({ ...payload, ephemeral: true });
    } else {
      msg = await interaction.reply({ ...payload, ephemeral: true });
    }
  } catch {
    try { await interaction.deferUpdate(); } catch {}
  }
  if (msg?.deletable || msg?.ephemeral) {
    setTimeout(() => interaction.deleteReply?.().catch(() => {}), ms);
  }
  return msg;
}

// ==============================
// ルムマ：返金（互換）
// ==============================
async function refundRumuma(raceId, reason = "開催中止") {
  const raceRes = await pool.query(`SELECT race_name, horses FROM rumuma_races WHERE id=$1`, [raceId]);
  const betsRes = await pool.query(`SELECT amount, user_id FROM rumuma_bets WHERE race_id=$1`, [raceId]);
  for (const b of betsRes.rows) {
    await addCoins(b.user_id, b.amount, "rumuma_refund", `Race:${raceId} ${reason}`);
  }
  const totalPot = betsRes.rows.reduce((s,b)=>s+Number(b.amount),0);
  await pool.query(
    `INSERT INTO rumuma_results(race_id, race_name, horses, winner, total_pot, status, finished_at, rake_amount)
     VALUES ($1,$2,$3,$4,$5,'canceled',NOW(),0)`,
    [raceId, raceRes.rows[0]?.race_name || "", raceRes.rows[0]?.horses || [], null, totalPot]
  );
  await pool.query(`DELETE FROM rumuma_bets WHERE race_id=$1`, [raceId]);
  await pool.query(`DELETE FROM rumuma_races WHERE id=$1`, [raceId]);
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
        const targetCh = await resolveUIChannel(type, interaction);
        await respond(interaction, { content: `UI再表示：**${type}** → <#${targetCh.id}> に投稿します。` }, { ephemeral: true, noUpdate: false });
        await sendUI(targetCh, type);
        return;
      }
      if (name === "jackpot") {
        const pot = await getJackpotPot();
        return respond(interaction, { embeds: [createEmbed("🧨 Jackpot 現在高", `現在ポット：**${fmt(pot)}S**`)] }, { ephemeral: true, noUpdate: false });
      }
      if (name === "balance") {
        const bal = await getBalance(interaction.user.id);
        return respond(interaction, { embeds: [createEmbed("残高確認", `${fmt(bal)} S`)] }, { ephemeral: true, noUpdate: false });
      }
      if (name === "gacha_ev") {
        const conf = currentGachaConfig();
        const [pS,pSR,pSSR] = [conf.cdf[0], conf.cdf[1]-conf.cdf[0], 1-conf.cdf[1]];
        const rS=conf.reward.S, rSR=conf.reward.SR, rSSR=conf.reward.SSR;
        const baseEV = pS*rS + pSR*rSR + pSSR*rSSR - GACHA_COST;
        const text = [
          `プリセット：**${conf.preset}**（個別ENVより優先）`,
          `確率：S=${(pS*100).toFixed(2)}% / SR=${(pSR*100).toFixed(2)}% / SSR=${(pSSR*100).toFixed(2)}%`,
          `配当：S=${rS} / SR=${rSR} / SSR=${rSSR}`,
          `基礎EV（JP除外）：**${baseEV.toFixed(2)} S/回**`,
          `JPテイク率：${(GACHA_JP_TAKE_RATE*100).toFixed(0)}%（総EVは中立扱い）`,
          `目安：基礎EVは**80〜90%**に収まる想定`
        ].join("\n");
        return respond(interaction, { embeds: [createEmbed("🎲 ガチャEV", text, Colors.Gold)] }, { ephemeral: true, noUpdate: false });
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
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("amount").setLabel("増減額 (例: １００ or -５０)").setStyle(TextInputStyle.Short).setRequired(true))
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
        return ephemeralReply(
          interaction,
          { content: "UI再表示メニュー", components: [new ActionRowBuilder().addComponents(menu)] },
          30000
        );
      }
      if (interaction.customId === "admin_rumuma_reset") {
        if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
          return ephemeralReply(interaction, { content: "管理者権限が必要です" });
        const menu = new StringSelectMenuBuilder()
          .setCustomId("admin_rumuma_reset_confirm")
          .setPlaceholder("⚠️ 開催中の全レースをキャンセルして返金します。続行しますか？")
          .addOptions(
            { label: "はい（実行）", value: "yes" },
            { label: "いいえ（中止）", value: "no" }
          );
        return ephemeralReply(
          interaction,
          { content: "レース全リセット 確認", components: [new ActionRowBuilder().addComponents(menu)] },
          30000
        );
      }

      // コイン系
      if (interaction.customId === "daily_claim") {
        const uid = interaction.user.id;
        await applyCarryIfAny(uid); // ① 繰越の自動適用

        const today = todayJST();
        const res = await pool.query(`SELECT last_claim FROM daily_claims WHERE user_id=$1`, [uid]);
        let last = res.rowCount ? (res.rows[0].last_claim ? new Date(res.rows[0].last_claim) : null) : null;
        let lastStr = last ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(last) : null;
        if (lastStr === today) return ephemeralReply(interaction, { embeds: [createEmbed("コイン", "今日はもう受け取り済みです", Colors.Red)] });

        // ① 週上限チェック
        const { grant, carry, reason } = await computeWeeklyGrant(uid, DAILY_AMOUNT);
        if (grant <= 0) {
          await pool.query(
            `INSERT INTO daily_claims (user_id, last_claim) VALUES ($1,$2::date)
             ON CONFLICT(user_id) DO UPDATE SET last_claim=$2::date`,
            [uid, today]
          );
          const note = WEEKLY_POLICY==="carry" ? "（超過分は翌週へ繰越）" : "（週上限のため受取不可）";
          return ephemeralReply(interaction, { embeds: [createEmbed("コイン", `週上限到達で受取できません ${note}`, Colors.Red)] });
        }

        await pool.query(
          `INSERT INTO daily_claims (user_id, last_claim) VALUES ($1,$2::date)
           ON CONFLICT(user_id) DO UPDATE SET last_claim=$2::date`,
          [uid, today]
        );
        await addCoins(uid, grant, "daily", "デイリー報酬");
        const tail = (carry>0 && WEEKLY_POLICY==="carry") ? `\n※ 超過分 ${fmt(carry)}S は翌週に繰越されます` : (reason?`\n※ ${reason}`:"");
        return ephemeralReply(interaction, { embeds: [createEmbed("コイン", `${fmt(grant)}Sを受け取りました！${tail}`, Colors.Green)] });
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

      // ガチャ：SSR ロール作成モーダル
      if (interaction.customId.startsWith("gacha_ssr_open:")) {
        const [, uid, sig] = interaction.customId.split(":");
        const payload = `${uid}:openmodal`;
        if (!verifyToken(payload, sig) || interaction.user.id !== uid) {
          return ephemeralReply(interaction, { content: "権限またはトークン検証に失敗しました。" }, 10000);
        }
        const modal = new ModalBuilder()
          .setCustomId(`gacha_ssr_modal:${uid}:${sig}`)
          .setTitle("🎊 SSRおめでとう！記念ロール作成")
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("role_name").setLabel("ロール名（20文字まで）").setStyle(TextInputStyle.Short).setMaxLength(20).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("role_color").setLabel("カラー（例：#ＦＦＤ７００ など全角可）").setStyle(TextInputStyle.Short).setRequired(false))
          );
        return interaction.showModal(modal);
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

        await addCoins(uid, -bet, "casino_highlow", `BET first:${firstStr} guess:${guess}`);

        const first = parseInt(firstStr, 10);
        const next  = randInt(1, 13);
        const isHigh = next > first;
        const isLow  = next < first;

        if ((guess === "H" && isHigh) || (guess === "L" && isLow)) {
          const s = await streakWin(uid);
          const bonusRate = Math.min(s.current, CASINO_STREAK_MAX) * 0.05; // 1連勝ごと+5%
          const pending = Math.floor(bet * HL_BASE_MULT * (1 + bonusRate)); // ③ 調整
          // ✅ HL勝利 → DU開始時に meta.hl.card = next を保存（サーバー権威）
          await duStart(uid, pending, "HL", { hl: { card: next } });

          // 新1行表示
          const rowCluster = buildDUClusterRowHL(uid, pending, next, 0);

          const near = hlNearMissText(first, next);
          const line = `🃏 基準カード: **${first}** → **${next}**  ${near}\n✅ 正解！ 勝ち分 **${fmt(pending)}S**（連勝補正 +${(bonusRate*100)|0}%）を保留中\n\n**次のラウンド**\n🃏 現在の基準カード: **${next}**\n🂠 次のカード: **?**\n「高い / 低い」を選んでください（**同値は不正解**）`;
          return respond(interaction, { embeds: [createEmbed("🎯 High & Low 結果", line, Colors.Fuchsia)], components: [rowCluster] });
        } else {
          await streakLose(uid);
          const line = `🃏 基準カード: **${first}**\n🂠 次のカード: **${next}**  ${hlNearMissText(first,next)}\n❌ 不正解… **-${fmt(bet)}S**\n（**同値は不正解**）`;
          const finalBal = await getBalance(uid);
          return respond(interaction, { embeds: [createEmbed("🎯 High & Low 結果", `${line}\n残高：**${fmt(finalBal)}S**`, Colors.Red)], components: [] });
        }
      }

      // ===== ダブルアップHL：推測 =====
      if (interaction.customId.startsWith("du_hl_guess:")) {
        const [, guess, pendingStr, _firstStrFromBtn, stepStr] = interaction.customId.split(":");
        const uid = interaction.user.id;
        const sess = await duGet(uid);
        if (!sess || !String(sess.game).startsWith("DU_HL")) {
          return respond(interaction, { embeds: [createEmbed("♠️ Double Up", "セッションが見つかりません。", Colors.Red)], components: [] });
        }

        const pending = Number(pendingStr);
        const step = Number(stepStr || 0);
        if (Number(sess.stake) !== pending || Number(sess.step) !== step) {
          const curFirst = Number(sess.meta?.hl?.card) || randInt(1,13);
          const rowCluster = buildDUClusterRowHL(uid, Number(sess.stake), curFirst, Number(sess.step||0));
          return respond(interaction, { embeds: [createEmbed("♠️ Double Up", "ボタンが古いため更新しました。")], components: [rowCluster] });
        }

        const first = Number(sess.meta?.hl?.card) || randInt(1,13);
        const next  = randInt(1, 13);
        const isHigh = next > first;
        const isLow  = next < first;

        if ((guess === "H" && isHigh) || (guess === "L" && isLow)) {
          await streakWin(uid);
          const nextStake = Math.floor(pending * DOUBLEUP_MULT);
          const nextStep = step + 1;
          if (nextStep >= DOUBLEUP_MAX_STEPS) {
            await addCoins(uid, nextStake, "casino_doubleup", `HL AUTO_TAKE step:${nextStep}`);
            await duClear(uid);
            return respond(interaction, { embeds: [createEmbed("♠️ Double Up", `✅ 最大回数に達したため自動確定：**+${fmt(nextStake)}S**`, Colors.Gold)], components: [] });
          }
          await duSave(uid, nextStake, nextStep, { hl: { card: next } });
          const rowCluster = buildDUClusterRowHL(uid, nextStake, next, nextStep);

          const line = `🃏 基準カード: **${first}** → **${next}**  ${hlNearMissText(first,next)}\n✅ 成功！ 現在の勝ち分：**${fmt(nextStake)}S**（${nextStep}/${DOUBLEUP_MAX_STEPS}）\n\n**次のラウンド**\n🃏 現在の基準カード: **${next}**\n🂠 次のカード: **?**（**同値は不正解**）`;
          return respond(interaction, { embeds: [createEmbed("♠️ Double Up", line, Colors.Gold)], components: [rowCluster] });
        } else {
          await duClear(uid);
          await streakLose(uid);
          const line = `🃏 基準カード: **${first}**\n🂠 次のカード: **${next}**  ${hlNearMissText(first,next)}\n❌ 失敗… 勝ち分は没収されました。（**同値は不正解**）`;
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
        const [, sid, idxStr, sig] = interaction.customId.split(":");
        const idx = parseInt(idxStr, 10);
        const payload = `${interaction.user.id}:${sid}:${idx}`;
        if (!verifyToken(payload, sig)) return ephemeralReply(interaction, { content: "検証に失敗しました。" }, 8000);
        return handleMinesOpen(interaction, sid, idx);
      }
      if (interaction.customId.startsWith("mines_cash:")) {
        const [, sid, sig] = interaction.customId.split(":");
        const payload = `${interaction.user.id}:${sid}:cash`;
        if (!verifyToken(payload, sig)) return ephemeralReply(interaction, { content: "検証に失敗しました。" }, 8000);
        return handleMinesCash(interaction, sid);
      }
      if (interaction.customId.startsWith("mines_peek:")) {
        const [, sid, sig] = interaction.customId.split(":");
        const payload = `${interaction.user.id}:${sid}:peek`;
        if (!verifyToken(payload, sig)) return ephemeralReply(interaction, { content: "検証に失敗しました。" }, 8000);
        return handleMinesPeek(interaction, sid);
      }

      // Crashボタン
      if (interaction.customId.startsWith("crash_cash:")) {
        const [, sid, sig] = interaction.customId.split(":");
        const payload = `${interaction.user.id}:${sid}:cash`;
        if (!verifyToken(payload, sig)) return ephemeralReply(interaction, { content: "検証に失敗しました。" }, 8000);
        return handleCrashCash(interaction, sid);
      }

      // ルムマ：UI系ボタン
      if (interaction.customId === "rumuma_create") {
        const modal = new ModalBuilder()
          .setCustomId("rumuma_create_modal")
          .setTitle("レース作成")
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("race_name").setLabel("レース名").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("horses").setLabel("出走馬（カンマ/読点/スペース/改行で区切り）").setStyle(TextInputStyle.Paragraph).setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }
      if (interaction.customId === "rumuma_list") {
        const menu = new StringSelectMenuBuilder()
          .setCustomId("rumuma_list_filter")
          .setPlaceholder("表示方法を選択")
          .addOptions(
            { label: "開催中のみ（新しい順）", value: "open_desc" },
            { label: "締切済のみ（新しい順）", value: "closed_desc" },
            { label: "すべて（新しい順）", value: "all_desc" },
            { label: "すべて（古い順）", value: "all_asc" },
          );
        return ephemeralReply(
          interaction,
          { content: "レース一覧の表示方法を選んでください。", components: [new ActionRowBuilder().addComponents(menu)] },
          30000
        );
      }
      if (interaction.customId === "rumuma_bet") {
        const r = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC LIMIT 25`);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "購入可能なレースがありません。" });
        const menu = new StringSelectMenuBuilder()
          .setCustomId("rumuma_bet_pick_race")
          .setPlaceholder("レースを選択")
          .addOptions(...r.rows.map(x => ({ label: `#${x.id} ${x.race_name}`, value: String(x.id) })));
        return ephemeralReply(
          interaction,
          { content: "レース選択", components: [new ActionRowBuilder().addComponents(menu)] },
          30000
        );
      }

      // 自分のウマ券（強化済）
      if (interaction.customId === "rumuma_my_bets") {
        const uid = interaction.user.id;
        const keepDays = Math.max(1, RUMUMA_TICKET_KEEP_DAYS|0);
        const limit = Math.max(1, RUMUMA_TICKET_HISTORY_LIMIT|0);

        const winUnclaimed = await pool.query(
          `SELECT race_id, race_name, amount, created_at
             FROM pending_rewards
            WHERE user_id=$1 AND claimed=false
              AND created_at >= NOW() - ($2 || ' days')::interval
            ORDER BY id DESC
            LIMIT $3`,
          [uid, keepDays, limit]
        );
        const winClaimed = await pool.query(
          `SELECT race_id, race_name, amount, created_at
             FROM pending_rewards
            WHERE user_id=$1 AND claimed=true
              AND created_at >= NOW() - ($2 || ' days')::interval
            ORDER BY id DESC
            LIMIT $3`,
          [uid, keepDays, limit]
        );
        const pendingBets = await pool.query(
          `SELECT b.race_id, r.race_name, b.horse, b.amount
             FROM rumuma_bets b
             JOIN rumuma_races r ON r.id=b.race_id
            WHERE b.user_id=$1 AND (r.winner IS NULL OR r.finished=false)
            ORDER BY b.id DESC
            LIMIT $2`,
          [uid, limit]
        );
        const lostBets = await pool.query(
          `SELECT b.race_id, r.race_name, b.horse, b.amount, rr.finished_at
             FROM rumuma_bets b
             JOIN rumuma_races r ON r.id=b.race_id
             JOIN rumuma_results rr ON rr.race_id=b.race_id
            WHERE b.user_id=$1 AND r.winner IS NOT NULL AND b.horse <> r.winner
              AND rr.finished_at >= NOW() - ($2 || ' days')::interval
            ORDER BY b.id DESC
            LIMIT $3`,
          [uid, keepDays, limit]
        );

        const sec = (title, lines) => lines.length ? `\n**${title}**\n${lines.join("\n")}` : "";
        const fmtRace = (id,name) => `#${id} ${name}`;

        const linesPending = pendingBets.rows.map(x => `🟡 ${fmtRace(x.race_id, x.race_name)} / 馬:${x.horse} / 購入:${fmt(x.amount)}S`);
        const linesWinUn   = winUnclaimed.rows.map(x => `🟢 ${fmtRace(x.race_id, x.race_name)} / 受取可:${fmt(x.amount)}S`);
        const linesWinOK   = winClaimed.rows.map(x => `🔵 ${fmtRace(x.race_id, x.race_name)} / 受取済:${fmt(x.amount)}S / ${formatJST(x.created_at)}`);
        const linesLost    = lostBets.rows.map(x => `🔴 ${fmtRace(x.race_id, x.race_name)} / 馬:${x.horse} / ${fmt(x.amount)}S / ${formatJST(x.finished_at)}`);

        const body =
          `直近 **${limit}件 / ${keepDays}日** の表示（DBは削除しません）\n` +
          sec("🟡 未確定", linesPending) +
          sec("🟢 勝ち（未受取）", linesWinUn) +
          sec("🔵 勝ち（受取済）", linesWinOK) +
          sec("🔴 負け", linesLost) +
          `\n\n※ 払い戻しの受取は「💳 払い戻し」ボタン（**rumuma_claim_rewards**）から一括で行えます。`;

        return ephemeralReply(interaction, { embeds: [createEmbed("🎫 自分のウマ券", body)] }, 60000);
      }

      if (interaction.customId === "rumuma_odds") {
        const r = await pool.query(`
          SELECT r.id, r.race_name, r.horses, r.finished,
                 (SELECT COALESCE(SUM(amount),0) FROM rumuma_bets WHERE race_id=r.id) AS total
          FROM rumuma_races r ORDER BY id DESC LIMIT 1
        `);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "対象レースがありません。" });
        const race = r.rows[0];
        const totals = {};
        const br = await pool.query(`SELECT horse, SUM(amount) AS amt FROM rumuma_bets WHERE race_id=$1 GROUP BY horse`, [race.id]);
        for (const b of br.rows) totals[b.horse] = Number(b.amt);
        const lines = race.horses.map(h => {
          const t = totals[h] || 0;
          const total = Number(race.total) || 0;
          const share = (t === 0 || total === 0) ? "-" : `${(total/t).toFixed(2)}x`;
          return `${h} … 賭け総額 ${fmt(t)}S / 想定倍率 ${share}`;
        }).join("\n");
        return ephemeralReply(interaction, { embeds: [createEmbed(`📈 オッズ #${race.id} ${race.race_name}`, lines)] }, 30000);
      }

      if (interaction.customId === "rumuma_close_bets") {
        const r = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC LIMIT 25`);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "締切対象のレースがありません。" });
        const menu = new StringSelectMenuBuilder()
          .setCustomId("rumuma_close_pick")
          .setPlaceholder("締切るレースを選択")
          .addOptions(...r.rows.map(x => ({ label: `#${x.id} ${x.race_name}`, value: String(x.id) })));
        return ephemeralReply(interaction, { content: "投票締切：レース選択", components: [new ActionRowBuilder().addComponents(menu)] }, 30000);
      }

      if (interaction.customId === "rumuma_report_result") {
        const r = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=true AND winner IS NULL ORDER BY id DESC LIMIT 25`);
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
        const r = await pool.query(`SELECT id, race_name FROM rumuma_races ORDER BY id DESC LIMIT 25`);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "中止対象のレースがありません。" });
        const menu = new StringSelectMenuBuilder()
          .setCustomId("rumuma_cancel_pick")
          .setPlaceholder("中止するレースを選択（返金されます）")
          .addOptions(...r.rows.map(x => ({ label: `#${x.id} ${x.race_name}`, value: String(x.id) })));
        return ephemeralReply(interaction, { content: "開催中止：レース選択", components: [new ActionRowBuilder().addComponents(menu)] }, 30000);
      }

      if (interaction.customId === "rumuma_history") {
        const r = await pool.query(`SELECT race_id, race_name, winner, total_pot, status, finished_at, rake_amount FROM rumuma_results ORDER BY id DESC LIMIT 10`);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "履歴なし" });
        const lines = r.rows.map(x => {
          const st = x.status==="canceled"?"中止":`勝者:${x.winner}`;
          return `#${x.race_id} ${x.race_name} … ${st} / 総額:${fmt(x.total_pot)}S / レイク:${fmt(x.rake_amount||0)}S / ${formatJST(x.finished_at)}`;
        }).join("\n");
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

      // ====== ウマ券 金額入力へ ======
      if (interaction.customId.startsWith("rumuma_bet_amount_go:")) {
        const [, raceIdStr, idxStr, sig] = interaction.customId.split(":");
        const payload = `${raceIdStr}:${idxStr}`;
        if (!verifyToken(payload, sig)) return ephemeralReply(interaction, { content: "検証に失敗しました。" }, 8000);

        const raceId = parseInt(raceIdStr, 10);
        const rr = await pool.query(`SELECT horses FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!rr.rowCount) return ephemeralReply(interaction, { content: "レースが見つかりません。" });
        const horses = rr.rows[0].horses || [];
        const idx = parseInt(idxStr, 10);
        const horse = horses[idx];
        if (!horse) return ephemeralReply(interaction, { content: "選択された馬が不正です。" });

        const modal = new ModalBuilder()
          .setCustomId(`rumuma_bet_amount_modal:${raceId}:${idx}`)
          .setTitle(`購入金額 / ${horse}`)
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("amount").setLabel("ベット額（全角数字OK）").setStyle(TextInputStyle.Short).setRequired(true))
          );
        return interaction.showModal(modal);
      }

      return ephemeralReply(interaction, { content: "このボタンは現在利用できません。" }, 8000);
    }

    // ===== Select =====
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "admin_repost_ui_select") {
        const type = interaction.values?.[0];
        const targetCh = await resolveUIChannel(type, interaction);
        await respond(interaction, { content: `UI再表示：**${type}** → <#${targetCh.id}> に投稿します。` }, { ephemeral:true, noUpdate:false });
        await sendUI(targetCh, type);
        return;
      }
      if (interaction.customId === "admin_rumuma_reset_confirm") {
        if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
          return ephemeralReply(interaction, { content: "管理者権限が必要です" });
        const v = interaction.values?.[0];
        if (v !== "yes") return respond(interaction, { content: "キャンセルしました。"}, { ephemeral:true, noUpdate:false });
        const ongoing = await pool.query(`SELECT id FROM rumuma_races WHERE finished=false OR winner IS NULL`);
        for (const row of ongoing.rows) { await refundRumuma(row.id, "全リセット"); }
        return respond(interaction, { embeds: [createEmbed("🧹 レース全リセット", `開催中のレースをすべて中止・返金しました（履歴は保持）。`)] }, { ephemeral:true, noUpdate:false });
      }
      if (interaction.customId === "rumuma_list_filter") {
        const mode = interaction.values?.[0] || "all_desc";
        let where = "";
        if (mode.startsWith("open"))   where = "WHERE finished=false";
        if (mode.startsWith("closed")) where = "WHERE finished=true";
        const order = mode.endsWith("asc") ? "ASC" : "DESC";
        const q = `SELECT id, race_name, horses, finished, winner FROM rumuma_races ${where} ORDER BY id ${order} LIMIT 25`;
        const r = await pool.query(q);
        if (!r.rowCount) return respond(interaction, { content: "該当レースはありません。" });
        const lines = r.rows.map(x => {
          const st = x.winner ? `🏆 ${x.winner}` : (x.finished ? "（締切済）" : "（開催中）");
          return `#${x.id} ${x.race_name} ${st}\n　出走: ${x.horses.join(", ")}`;
        }).join("\n");
        return respond(interaction, { embeds: [createEmbed("📃 レース一覧（整頓）", lines)] });
      }
      if (interaction.customId === "rumuma_bet_pick_race") {
        const raceId = parseInt(interaction.values?.[0], 10);
        const r = await pool.query(`SELECT horses, race_name FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!r.rowCount) return respond(interaction, { content: "レースが見つかりません。" });
        const horses = r.rows[0].horses || [];
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`rumuma_bet_pick_horse:${raceId}`)
          .setPlaceholder(`#${raceId} ${r.rows[0].race_name} の馬を選択`)
          .addOptions(...horses.map((h, i) => ({ label: h, value: String(i) })).slice(0, 25));
        return respond(interaction, { content: "馬を選択してください。", components: [new ActionRowBuilder().addComponents(menu)] });
      }
      if (interaction.customId.startsWith("rumuma_bet_pick_horse:")) {
        const raceId = parseInt(interaction.customId.split(":")[1], 10);
        const idx = parseInt(interaction.values?.[0], 10);

        const rr = await pool.query(`
          SELECT r.id, r.race_name, r.horses,
                 (SELECT COALESCE(SUM(amount),0) FROM rumuma_bets WHERE race_id=r.id) AS total
          FROM rumuma_races r WHERE r.id=$1
        `, [raceId]);
        if (!rr.rowCount) return respond(interaction, { content: "レースが見つかりません。" });

        const race = rr.rows[0];
        const horses = race.horses || [];
        const horse = horses[idx];
        if (!horse) return respond(interaction, { content: "馬が見つかりません。" });

        const br = await pool.query(`SELECT horse, SUM(amount) AS amt FROM rumuma_bets WHERE race_id=$1 GROUP BY horse`, [raceId]);
        const totals = Object.fromEntries(br.rows.map(x => [x.horse, Number(x.amt)]));
        const totalPot = Number(race.total) || 0;
        const horsePot = totals[horse] || 0;

        const currentMult = (horsePot === 0 || totalPot === 0) ? "-" : `${(totalPot/horsePot).toFixed(2)}x`;
        const after100_total  = totalPot + 100;
        const after100_horse  = horsePot + 100;
        const after100_mult   = `${(after100_total/after100_horse).toFixed(2)}x`;
        const after100_payout = Math.floor(after100_total/after100_horse * 100);

        const goSig = signToken(`${raceId}:${idx}`);
        const goRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rumuma_bet_amount_go:${raceId}:${idx}:${goSig}`).setLabel("📝 ベット入力へ").setStyle(ButtonStyle.Primary),
        );

        const text = [
          `#${race.id} ${race.race_name}`,
          `🎯 馬：**${horse}**`,
          `📈 現在の想定倍率：**${currentMult}**`,
          `🧮 参考：100S 賭けた場合 → 仮定倍率 **${after100_mult}** / 期待払戻 **${fmt(after100_payout)}S**`,
          "",
          "※ 期待値は現時点の総額ベースの目安です（同時購入で変動します）。"
        ].join("\n");

        return respond(interaction, { embeds: [createEmbed("🎫 オッズ確認", text)], components: [goRow] });
      }

      if (interaction.customId === "rumuma_close_pick") {
        const raceId = parseInt(interaction.values?.[0], 10);
        const r = await pool.query(`UPDATE rumuma_races SET finished=true WHERE id=$1 RETURNING race_name`, [raceId]);
        if (!r.rowCount) return respond(interaction, { content: "レースが見つかりません。" });
        return respond(interaction, { embeds: [createEmbed("✅ 投票締切", `#${raceId} ${r.rows[0].race_name}`)] });
      }

      if (interaction.customId === "rumuma_result_pick_race") {
        const raceId = parseInt(interaction.values?.[0], 10);
        const r = await pool.query(`SELECT race_name, horses, winner FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!r.rowCount) return respond(interaction, { content: "レースが見つかりません。" });
        if (r.rows[0].winner) return respond(interaction, { content: "このレースは既に結果が確定しています。" });
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

        const rr = await pool.query(`SELECT race_name, horses, winner FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!rr.rowCount) return respond(interaction, { content: "レースが見つかりません。" });
        if (rr.rows[0].winner) return respond(interaction, { content: "このレースは既に結果が確定しています。" });
        if (!rr.rows[0].horses.includes(winner)) return respond(interaction, { content: "勝ち馬が出走一覧にありません。" });

        const bets = await pool.query(`SELECT user_id, horse, amount FROM rumuma_bets WHERE race_id=$1`, [raceId]);
        const totalPot = bets.rows.reduce((s,b)=>s+Number(b.amount),0);
        await pool.query(`UPDATE rumuma_races SET finished=true, winner=$2 WHERE id=$1`, [raceId, winner]);

        // ⑥ レイク適用
        const rakeAmount = Math.floor(totalPot * (RUMUMA_RAKE_BP/100));
        const potAfter   = Math.max(0, totalPot - rakeAmount);

        const winTotal = bets.rows.filter(b => b.horse===winner).reduce((s,b)=>s+Number(b.amount),0);
        if (winTotal > 0) {
          for (const b of bets.rows.filter(b => b.horse===winner)) {
            const share = (Number(b.amount) / winTotal) * potAfter;
            const pay = Math.floor(share);
            await pool.query(
              `INSERT INTO pending_rewards(user_id, race_id, race_name, amount, claimed, created_at) VALUES ($1,$2,$3,$4,false,NOW())`,
              [b.user_id, raceId, rr.rows[0].race_name, pay]
            );
          }
        }
        await pool.query(
          `INSERT INTO rumuma_results(race_id, race_name, horses, winner, total_pot, status, finished_at, rake_amount)
           VALUES ($1,$2,$3,$4,$5,'finished',NOW(),$6)`,
          [raceId, rr.rows[0].race_name, rr.rows[0].horses, winner, totalPot, rakeAmount]
        );
        return respond(interaction, { embeds: [createEmbed("🏆 結果確定", `#${raceId} ${rr.rows[0].race_name}\n勝者：**${winner}**\n総額：${fmt(totalPot)}S\nレイク：${fmt(rakeAmount)}S\n勝ち馬購入者に**払い戻し受取**が可能になりました。`)] });
      }

      if (interaction.customId === "rumuma_cancel_pick") {
        const raceId = parseInt(interaction.values?.[0], 10);
        await refundRumuma(raceId, "開催中止");
        return respond(interaction, { embeds: [createEmbed("⛔ 開催中止", `#${raceId} は返金済みです。`)] });
      }

      return ephemeralReply(interaction, { content: "未対応のメニューです。" }, 10000);
    }

    // ===== Modal =====
    if (interaction.type === InteractionType.ModalSubmit) {
      // 管理：コイン調整（全角対応）
      if (interaction.customId === "admin_adjust_modal") {
        const uid = interaction.fields.getTextInputValue("target_user").trim();
        const amount = normalizeInt(interaction.fields.getTextInputValue("amount"), NaN);
        if (!Number.isFinite(amount)) return ephemeralReply(interaction, { content: "金額が不正です" });
        await addCoins(uid, amount, "admin_adjust", "管理者操作");
        return ephemeralReply(interaction, { content: `ユーザー:${uid} に ${fmt(amount)} 調整しました` });
      }

      // HL起点（全角対応）
      if (interaction.customId === "casino_bet_modal_highlow") {
        const uid = interaction.user.id;
        const input = interaction.fields.getTextInputValue("bet")?.trim() ?? "";
        const req = Math.max(1, normalizeInt(input, CASINO_BET_DEFAULT));
        const bet = await resolveBet(uid, req);
        const balance = await getBalance(uid);
        if (balance < bet) return ephemeralReply(interaction, { embeds: [createEmbed("High & Low", `残高不足：必要 ${fmt(bet)}S / 保有 ${fmt(balance)}S`, Colors.Red)] }, 20000);
        const first = randInt(1, 13);
        await runShowyEffect(interaction, "🎯 High & Low", `ベット：**${fmt(bet)}S**（上限 ${fmt(CASINO_BET_MAX)}S）\n${await streakLine(uid)}`);
        const row = buildHLGuessRow("casino_highlow_guess", bet, first, "");
        await interaction.editReply({
          embeds: [createEmbed("🎯 High & Low", `🃏 **基準カード: ${first}**\n🂠 次のカード: **?**\n「高い / 低い」を選んでください（**同値は不正解**）`)],
          components: [row]
        }).catch(()=>{});
               return;
      }

      // Mines起点（全角対応）
      if (interaction.customId === "casino_bet_modal_mines") {
        const uid = interaction.user.id;
        const betIn = interaction.fields.getTextInputValue("bet")?.trim() ?? "";
        const bombsIn = interaction.fields.getTextInputValue("bombs")?.trim() ?? "";
        const betReq = Math.max(1, normalizeInt(betIn, CASINO_BET_DEFAULT));
        const bet = await resolveBet(uid, betReq);
        const balance = await getBalance(uid);
        if (balance < bet) return ephemeralReply(interaction, { embeds: [createEmbed("Mines", `残高不足：必要 ${fmt(bet)}S / 保有 ${fmt(balance)}S`, Colors.Red)] }, 20000);
        let bombs = normalizeInt(bombsIn, 3);
        bombs = Math.max(MINES_BOMBS_MIN, Math.min(MINES_BOMBS_MAX, bombs));
        return startMines(interaction, bet, bombs);
      }

      // Crash起点（全角対応）
      if (interaction.customId === "casino_bet_modal_crash") {
        const uid = interaction.user.id;
        const betIn = interaction.fields.getTextInputValue("bet")?.trim() ?? "";
        const betReq = Math.max(1, normalizeInt(betIn, CASINO_BET_DEFAULT));
        const bet = await resolveBet(uid, betReq);
        const balance = await getBalance(uid);
        if (balance < bet) return ephemeralReply(interaction, { embeds: [createEmbed("Crash", `残高不足：必要 ${fmt(bet)}S / 保有 ${fmt(balance)}S`, Colors.Red)] }, 20000);
        return startCrash(interaction, bet);
      }

      // ルムマ：作成
      if (interaction.customId === "rumuma_create_modal") {
        const name = interaction.fields.getTextInputValue("race_name").trim();
        const raw   = interaction.fields.getTextInputValue("horses");
        const horses = raw.split(/[,\s、，\n\r\t]+/g).map(s=>s.trim()).filter(Boolean);
        if (!horses.length) return ephemeralReply(interaction, { content: "出走馬が空です。" });
        const r = await pool.query(
          `INSERT INTO rumuma_races(channel_id, host_id, race_name, horses, finished, winner)
           VALUES ($1,$2,$3,$4,false,NULL) RETURNING id`,
          [interaction.channelId, interaction.user.id, name, horses]
        );
        return ephemeralReply(interaction, { embeds: [createEmbed("🏇 レース作成", `#${r.rows[0].id} ${name}\n出走: ${horses.join(", ")}`)] }, 30000);
      }

      // 後方互換：直接入力購入（全角対応）
      if (interaction.customId === "rumuma_bet_modal") {
        const uid = interaction.user.id;
        const raceId = normalizeInt(interaction.fields.getTextInputValue("race_id"), NaN);
        const horse = interaction.fields.getTextInputValue("horse").trim();
        const amt = normalizeInt(interaction.fields.getTextInputValue("amount"), NaN);
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

      // 選択式→金額モーダル結果（全角対応 / index経由で馬復元）
      if (interaction.customId.startsWith("rumuma_bet_amount_modal:")) {
        const [, raceIdStr, idxStr] = interaction.customId.split(":");
        const raceId = parseInt(raceIdStr, 10);
        const idx = parseInt(idxStr, 10);
        const uid = interaction.user.id;
        const amt = normalizeInt(interaction.fields.getTextInputValue("amount"), NaN);
        if (!Number.isFinite(amt) || amt<=0) return ephemeralReply(interaction, { content: "金額が不正です。" });
        const r = await pool.query(`SELECT horses, finished FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "レースが見つかりません。" });
        if (r.rows[0].finished) return ephemeralReply(interaction, { content: "このレースは締め切られています。" });
        const horses = r.rows[0].horses || [];
        const horse = horses[idx];
        if (!horse) return ephemeralReply(interaction, { content: "選択された馬が不正です。" });
        const bal = await getBalance(uid);
        if (bal < amt) return ephemeralReply(interaction, { content: `残高不足（必要 ${fmt(amt)}S / 保有 ${fmt(bal)}S）` });
        await addCoins(uid, -amt, "rumuma_bet", `race:${raceId} ${horse}`);
        await pool.query(`INSERT INTO rumuma_bets(race_id,user_id,horse,amount) VALUES ($1,$2,$3,$4)`, [raceId, uid, horse, amt]);
        return ephemeralReply(interaction, { embeds: [createEmbed("🎫 ウマ券購入", `#${raceId} / ${horse} に **-${fmt(amt)}S**`)] }, 20000);
      }

      // 後方互換：締切（モーダル）
      if (interaction.customId === "rumuma_close_modal") {
        const raceId = parseInt(interaction.fields.getTextInputValue("race_id"), 10);
        const r = await pool.query(`UPDATE rumuma_races SET finished=true WHERE id=$1 RETURNING race_name`, [raceId]);
        if (!r.rowCount) return ephemeralReply(interaction, { content: "レースが見つかりません。" });
        return ephemeralReply(interaction, { embeds: [createEmbed("✅ 投票締切", `#${raceId} ${r.rows[0].race_name}`)] });
      }

      // 後方互換：結果（モーダル）
      if (interaction.customId === "rumuma_result_modal") {
        const raceId = parseInt(interaction.fields.getTextInputValue("race_id"), 10);
        const winner = interaction.fields.getTextInputValue("winner").trim();
        const rr = await pool.query(`SELECT race_name, horses, winner FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!rr.rowCount) return ephemeralReply(interaction, { content: "レースが見つかりません。" });
        if (rr.rows[0].winner) return ephemeralReply(interaction, { content: "このレースは既に結果が確定しています。" });
        if (!rr.rows[0].horses.includes(winner)) return ephemeralReply(interaction, { content: "勝ち馬が出走一覧にありません。" });
        const bets = await pool.query(`SELECT user_id, horse, amount FROM rumuma_bets WHERE race_id=$1`, [raceId]);
        const totalPot = bets.rows.reduce((s,b)=>s+Number(b.amount),0);
        await pool.query(`UPDATE rumuma_races SET finished=true, winner=$2 WHERE id=$1`, [raceId, winner]);

        const rakeAmount = Math.floor(totalPot * (RUMUMA_RAKE_BP/100));
        const potAfter   = Math.max(0, totalPot - rakeAmount);

        const winTotal = bets.rows.filter(b => b.horse===winner).reduce((s,b)=>s+Number(b.amount),0);
        if (winTotal > 0) {
          for (const b of bets.rows.filter(b => b.horse===winner)) {
            const share = (Number(b.amount) / winTotal) * potAfter;
            const pay = Math.floor(share);
            await pool.query(
              `INSERT INTO pending_rewards(user_id, race_id, race_name, amount, claimed, created_at) VALUES ($1,$2,$3,$4,false,NOW())`,
              [b.user_id, raceId, rr.rows[0].race_name, pay]
            );
          }
        }
        await pool.query(
          `INSERT INTO rumuma_results(race_id, race_name, horses, winner, total_pot, status, finished_at, rake_amount)
           VALUES ($1,$2,$3,$4,$5,'finished',NOW(),$6)`,
          [raceId, rr.rows[0].race_name, rr.rows[0].horses, winner, totalPot, rakeAmount]
        );
        return ephemeralReply(interaction, { embeds: [createEmbed("🏆 結果確定", `#${raceId} ${rr.rows[0].race_name}\n勝者：**${winner}**\n総額：${fmt(totalPot)}S\nレイク：${fmt(rakeAmount)}S\n勝ち馬購入者に**払い戻し受取**が可能になりました。`)] }, 30000);
      }

      // 後方互換：中止（モーダル）
      if (interaction.customId === "rumuma_cancel_modal") {
        const raceId = parseInt(interaction.fields.getTextInputValue("race_id"), 10);
        await refundRumuma(raceId, "管理操作");
        return ephemeralReply(interaction, { embeds: [createEmbed("⛔ 開催中止", `#${raceId} は返金済みです。`)] }, 20000);
      }

      // ガチャ：SSRモーダル（ロール作成＆遅延告知）色コード正規化
      if (interaction.customId.startsWith("gacha_ssr_modal:")) {
        const [, uid, sig] = interaction.customId.split(":");
        const payload = `${uid}:openmodal`;
        if (!verifyToken(payload, sig) || interaction.user.id !== uid) {
          return ephemeralReply(interaction, { content: "権限またはトークン検証に失敗しました。" }, 10000);
        }
        const roleName = interaction.fields.getTextInputValue("role_name").trim();
        let roleColor = normalizeHexColor(interaction.fields.getTextInputValue("role_color"), "#FFD700");

        try {
          const guild = interaction.guild;
          const member = await guild.members.fetch(interaction.user.id);
          let role = guild.roles.cache.find(r => r.name === roleName);
          if (!role) role = await guild.roles.create({ name: roleName, color: roleColor || "#FFD700", reason: "SSR Reward Role" });
          if (!member.roles.cache.has(role.id)) await member.roles.add(role, "SSR Reward");
          setTimeout(() => {
            broadcastSSRWin({
              guild,
              winnerUser: interaction.user,
              reward: GACHA_R_SSR,
              roleName,
              roleColor: roleColor || "#FFD700"
            }).catch(()=>{});
          }, SSR_ROLE_MESSAGE_DELAY_MS);
          return ephemeralReply(interaction, { embeds: [createEmbed("🎊 SSRおめでとう！", `ロール **${roleName}** を付与しました！\n祝福メッセージ（全体告知）は少し遅れて流れます。`, Colors.Gold)] }, 20000);
        } catch (e) {
          logError("SSR role create/assign", e);
          return ephemeralReply(interaction, { content: "ロール作成または付与に失敗しました。" }, 15000);
        }
      }

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

    if (content.length < REWARD_MIN_MSG_LEN) return;
    if (NG_WORDS.has(content)) return;

    const today = new Date().toISOString().slice(0, 10);
    const h = hashMessage(content);

    const inserted = await pool.query(
      `INSERT INTO message_rewards(user_id, date, count, last_message_at, last_message_hash)
       VALUES ($1,$2,1,NOW(),$3)
       ON CONFLICT (user_id) DO NOTHING`,
      [msg.author.id, today, h]
    );
    if (inserted.rowCount) {
      await applyCarryIfAny(msg.author.id);
      const { grant } = await computeWeeklyGrant(msg.author.id, REWARD_PER_MESSAGE);
      if (grant > 0) await addCoins(msg.author.id, grant, "msg_reward", "初回メッセージ報酬");
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

    await applyCarryIfAny(msg.author.id);
    const { grant } = await computeWeeklyGrant(msg.author.id, REWARD_PER_MESSAGE);
    if (grant <= 0) {
      await pool.query(`UPDATE message_rewards SET last_message_at=NOW(), last_message_hash=$1 WHERE user_id=$2`, [h, msg.author.id]);
      return;
    }

    await addCoins(msg.author.id, grant, "msg_reward", "メッセージ報酬");
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
schedule.scheduleJob("0 20 * * *", async () => {
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
    new SlashCommandBuilder().setName("gacha_ev").setDescription("ガチャ確率・配当・基礎EV（JP除外）を表示"),
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

// ==============================
// LOGIN + デバッグログ
// ==============================
client.login(token)
  .then(() => {
    console.log("✅ client.login resolved");
  })
  .catch((err) => {
    console.error("❌ client.login failed:");
    console.error(err);
  });

// ==============================
// HTTP (Render keep-alive)
// ==============================
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!\n");
}).listen(PORT, () => {
  logInfo(`🌐 HTTP server running on port ${PORT}`);
});
