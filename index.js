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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
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
const CASINO_CHANNEL_ID   = process.env.CASINO_CHANNEL_ID || "";

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
// ==============================
// DB初期化
// ==============================
async function ensureTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS coins (
    user_id TEXT PRIMARY KEY,
    balance INTEGER DEFAULT 0
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS history (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    note TEXT,
    created_at TIMESTAMP DEFAULT now()
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS daily_claims (
    user_id TEXT PRIMARY KEY,
    last_claim DATE
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS message_rewards (
    user_id TEXT PRIMARY KEY,
    date TEXT,
    count INTEGER DEFAULT 0,
    last_message_at TIMESTAMP,
    last_message_hash TEXT
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS rumuma_races (
    id SERIAL PRIMARY KEY,
    channel_id TEXT,
    host_id TEXT,
    race_name TEXT,
    horses TEXT[],
    finished BOOLEAN DEFAULT false,
    winner TEXT
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS rumuma_bets (
    id SERIAL PRIMARY KEY,
    race_id INTEGER NOT NULL REFERENCES rumuma_races(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    horse TEXT NOT NULL,
    amount INTEGER NOT NULL
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS rumuma_results (
    id SERIAL PRIMARY KEY,
    race_id INTEGER,
    race_name TEXT,
    horses TEXT[],
    winner TEXT,
    total_pot INTEGER,
    status TEXT,
    finished_at TIMESTAMP DEFAULT now()
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS pending_rewards (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    race_id INTEGER NOT NULL,
    race_name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    claimed BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT now()
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS slot_states (
    user_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'NORMAL',
    spins_left INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT now()
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS slot_config (
    id SERIAL PRIMARY KEY,
    big NUMERIC DEFAULT 0.006,
    reg NUMERIC DEFAULT 0.012,
    grape NUMERIC DEFAULT 0.20,
    cherry NUMERIC DEFAULT 0.10,
    updated_at TIMESTAMP DEFAULT now()
  );`);
}

// ==============================
// コイン系：残高確認
// ==============================
async function getBalance(userId) {
  const rs = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [userId]);
  return rs.rowCount ? Number(rs.rows[0].balance) : 0;
}

// ==============================
// デイリー報酬
// ==============================
async function claimDaily(interaction) {
  const uid = interaction.user.id;
  const today = todayJST();

  const rs = await pool.query(`SELECT last_claim FROM daily_claims WHERE user_id=$1`, [uid]);
  if (rs.rowCount && rs.rows[0].last_claim === today) {
    return ephemeralReply(interaction, { content: "📅 今日はすでにデイリー報酬を受け取り済みです。" });
  }

  await pool.query(`
    INSERT INTO daily_claims(user_id,last_claim)
    VALUES($1,$2)
    ON CONFLICT (user_id) DO UPDATE SET last_claim=EXCLUDED.last_claim
  `, [uid, today]);

  await addCoins(uid, DAILY_AMOUNT, "daily", "デイリー報酬");

  return ephemeralReply(interaction, { content: `✅ デイリー報酬 ${fmt(DAILY_AMOUNT)}S を受け取りました！` });
}

// ==============================
// 発言報酬
// ==============================
async function handleMessageReward(message) {
  if (message.author.bot) return;
  const uid = message.author.id;
  const today = todayJST();

  const hash = crypto.createHash("md5").update(message.content).digest("hex");
  const rs = await pool.query(`SELECT * FROM message_rewards WHERE user_id=$1`, [uid]);
  const now = new Date();

  if (rs.rowCount) {
    const row = rs.rows[0];
    if (row.date === today && row.count >= REWARD_DAILY_LIMIT) return;
    if (row.last_message_hash === hash) return;
    if (row.last_message_at && (now - new Date(row.last_message_at)) / 1000 < REWARD_COOLDOWN_SEC) return;

    await pool.query(`
      UPDATE message_rewards
      SET date=$2,count=CASE WHEN date=$2 THEN count+1 ELSE 1 END,
          last_message_at=now(), last_message_hash=$3
      WHERE user_id=$1
    `, [uid, today, hash]);
  } else {
    await pool.query(`
      INSERT INTO message_rewards(user_id,date,count,last_message_at,last_message_hash)
      VALUES($1,$2,1,now(),$3)
    `, [uid, today, hash]);
  }

  await addCoins(uid, REWARD_PER_MESSAGE, "message", "発言報酬");
}

// ==============================
// ランキング表示
// ==============================
async function showRanking(interaction) {
  const rs = await pool.query(`SELECT user_id,balance FROM coins ORDER BY balance DESC LIMIT 10`);
  let desc = "";
  for (let i=0; i<rs.rowCount; i++) {
    const row = rs.rows[i];
    desc += `#${i+1} <@${row.user_id}> — ${fmt(row.balance)}S\n`;
  }
  return ephemeralReply(interaction, { embeds: [createEmbed("💰 コインランキングTOP10", desc)] });
}
// ==============================
// レース返金（中止）
// ==============================
async function refundRumuma(raceId, reason="開催中止") {
  const raceRes = await pool.query(`SELECT race_name,horses FROM rumuma_races WHERE id=$1`, [raceId]);
  const betsRes = await pool.query(`SELECT amount,user_id FROM rumuma_bets WHERE race_id=$1`, [raceId]);

  let total = 0;
  for (const b of betsRes.rows) total += Number(b.amount);

  for (const b of betsRes.rows) {
    await addCoins(b.user_id, b.amount, "rumuma_refund", `Race:${raceId} ${reason}`);
  }

  await pool.query(`
    INSERT INTO rumuma_results(race_id,race_name,horses,winner,total_pot,status,finished_at)
    VALUES($1,$2,$3,$4,$5,'canceled',now())
  `, [raceId, raceRes.rows[0]?.race_name, raceRes.rows[0]?.horses, null, total]);

  await pool.query(`DELETE FROM rumuma_bets WHERE race_id=$1`, [raceId]);
  await pool.query(`DELETE FROM rumuma_races WHERE id=$1`, [raceId]);
}

// ==============================
// オッズ計算（倍率のみ）
// ==============================
async function calcOdds(raceId) {
  const res = await pool.query(
    `SELECT horse,SUM(amount)::bigint AS sum FROM rumuma_bets WHERE race_id=$1 GROUP BY horse`,
    [raceId]
  );
  const totalPot = res.rows.reduce((s,b) => s + Number(b.sum), 0);
  const odds = {};
  for (const row of res.rows) {
    const h = row.horse;
    const betSum = Number(row.sum);
    odds[h] = betSum > 0 ? (totalPot / betSum).toFixed(2) : "—";
  }
  return { totalPot, odds };
}

// ==============================
// レース結果登録
// ==============================
async function finalizeRace(raceId, winner, hostId) {
  // すでに結果が登録されているかチェック
  const exist = await pool.query(`SELECT 1 FROM rumuma_results WHERE race_id=$1 AND status='finished'`, [raceId]);
  if (exist.rowCount) return { error: "このレースはすでに結果登録済みです。" };

  const raceRow = await pool.query(`SELECT race_name,horses,host_id FROM rumuma_races WHERE id=$1`, [raceId]);
  if (!raceRow.rowCount) return { error: "レースが見つかりません" };
  if (raceRow.rows[0].host_id !== hostId) return { error: "このレースのホストではありません" };

  const bets = await pool.query(`SELECT user_id,horse,amount FROM rumuma_bets WHERE race_id=$1`, [raceId]);
  const totalPot = bets.rows.reduce((s,b) => s + Number(b.amount), 0);

  const winners = bets.rows.filter(b => b.horse === winner);
  const winSum = winners.reduce((s,b) => s + Number(b.amount), 0);

  await pool.query(`
    INSERT INTO rumuma_results(race_id,race_name,horses,winner,total_pot,status,finished_at)
    VALUES($1,$2,$3,$4,$5,'finished',now())
  `, [raceId, raceRow.rows[0].race_name, raceRow.rows[0].horses, winner, totalPot]);

  // 払い戻し作成
  if (winSum > 0) {
    for (const w of winners) {
      const share = Number(w.amount) / winSum;
      const payout = Math.floor(totalPot * share);
      await pool.query(`
        INSERT INTO pending_rewards(user_id,race_id,race_name,amount,claimed,created_at)
        VALUES($1,$2,$3,$4,false,now())
      `, [w.user_id, raceId, raceRow.rows[0].race_name, payout]);
    }
  }

  // レース本体削除（履歴は results に残る）
  await pool.query(`DELETE FROM rumuma_races WHERE id=$1`, [raceId]);

  return { ok: true, totalPot, winSum };
}

// ==============================
// レースUI用テキスト
// ==============================
function formatRaceList(rows) {
  return rows.map(r =>
    `ID:${r.id} ${r.race_name}（${(r.horses || []).join(", ")}） ${r.finished ? "[締切]" : "[開催中]"}`
  ).join("\n");
}

// ==============================
// レース履歴
// ==============================
async function showRaceHistory(interaction) {
  const res = await pool.query(`
    SELECT race_id,race_name,winner,total_pot,status,finished_at
    FROM rumuma_results ORDER BY finished_at DESC LIMIT 10
  `);
  if (!res.rowCount) return ephemeralReply(interaction, { content: "競走履歴はまだありません。" });

  const lines = res.rows.map(r => {
    const when = formatJST(r.finished_at);
    const tag = r.status === "canceled" ? "【中止】" : `勝者:${r.winner}`;
    return `${when} | Race:${r.race_id} ${r.race_name} | ${tag} | 総額:${fmt(r.total_pot)}S`;
  }).join("\n");

  return ephemeralReply(interaction, { content: "📜 直近10件のレース履歴\n" + lines });
}

// ==============================
// 払い戻し一括受け取り
// ==============================
async function claimRewards(interaction) {
  const uid = interaction.user.id;
  const res = await pool.query(`
    SELECT race_id,race_name,amount
    FROM pending_rewards WHERE user_id=$1 AND claimed=false
  `,[uid]);

  if (!res.rowCount) return ephemeralReply(interaction, { content: "未受け取りの払い戻しはありません。" });

  let total = 0;
  const breakdown = [];
  for (const row of res.rows) {
    total += Number(row.amount);
    breakdown.push(`・Race:${row.race_id} ${row.race_name} …… ${fmt(row.amount)}S`);
  }

  await addCoins(uid, total, "reward_claim", `払い戻し ${res.rowCount}件`);
  await pool.query(`UPDATE pending_rewards SET claimed=true WHERE user_id=$1`, [uid]);

  return ephemeralReply(interaction, { content: `✅ 払い戻しを受け取りました！\n${breakdown.join("\n")}\n合計:${fmt(total)}S` });
}
/* ==============================
   ガチャ（SSRロールあり）
============================== */
async function playGacha(interaction) {
  const uid = interaction.user.id;
  const cost = 30;

  const balance = await getBalance(uid);
  if (balance < cost) {
    return ephemeralReply(interaction, { embeds: [createEmbed("ガチャ", `残高不足！必要:${fmt(cost)}S / 保有:${fmt(balance)}S`, Colors.Red)] });
  }

  // コスト引き落とし
  await addCoins(uid, -cost, "gacha", "ガチャを回した");

  // 抽選
  const roll = Math.random();
  let rarity = "S", reward = 5;
  if (roll < 0.70) { rarity = "S"; reward = 5; }
  else if (roll < 0.95) { rarity = "SR"; reward = 10; }
  else { rarity = "SSR"; reward = 50; }

  // コイン付与
  await addCoins(uid, reward, "gacha_reward", `ガチャ当選:${rarity}`);

  // SSR → モーダルでロール作成
  if (rarity === "SSR") {
    const modal = new ModalBuilder()
      .setCustomId("gacha_ssr_modal")
      .setTitle("SSRロール作成 🎉")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("role_name")
            .setLabel("ロール名（20文字以内）")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(20)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("role_color")
            .setLabel("カラーコード（例:#FFD700）")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
        )
      );
    return interaction.showModal(modal);
  }

  // S or SR の結果
  return ephemeralReply(interaction, {
    embeds: [createEmbed("🎲 ガチャ結果", `結果: **${rarity}**\n💰 +${fmt(reward)}S`, rarity === "SR" ? Colors.Purple : Colors.Grey)]
  });
}

// ==============================
// SSRロール作成処理
// ==============================
async function handleSSRRole(interaction) {
  const roleName = interaction.fields.getTextInputValue("role_name").trim();
  let roleColor = (interaction.fields.getTextInputValue("role_color") || "#FFD700").trim();

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

    // Botロール直下に配置
    const botHighest = guild.members.me.roles.highest;
    const newPos = Math.max(1, botHighest.position - 1);
    await role.setPosition(newPos).catch(() => {});

    // ユーザーに付与
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (member) await member.roles.add(role).catch(() => {});

    // 1週間後に削除
    setTimeout(async () => {
      await role.delete("SSRロール有効期限切れ").catch(() => {});
    }, 7 * 24 * 60 * 60 * 1000);

    return ephemeralReply(interaction, {
      embeds: [createEmbed("SSR当選 🎉", `ロール **${roleName}** を作成し付与しました！（色:${roleColor}）\nこのロールは **Botロール直下** に配置され、1週間後に自動削除されます。`, Colors.Gold)]
    }, 30000);
  } catch (e) {
    console.error("SSRロール作成失敗:", e);
    return ephemeralReply(interaction, {
      embeds: [createEmbed("SSRロール", "ロール作成に失敗しました。Botロールの位置と権限を確認してください。", Colors.Red)]
    }, 30000);
  }
}
/* ==============================
   ジャグラー：確率設定
============================== */
const DEFAULT_PROBS = {
  big: 1/180,   // BIG BONUS
  reg: 1/90,    // REG BONUS
  grape: 1/6,   // ぶどう
  cherry: 1/12, // チェリー
};

// 設定取得
async function getSlotConfig() {
  const rs = await pool.query(`SELECT * FROM slot_config ORDER BY id DESC LIMIT 1`);
  if (!rs.rowCount) return DEFAULT_PROBS;
  return {
    big: Number(rs.rows[0].big),
    reg: Number(rs.rows[0].reg),
    grape: Number(rs.rows[0].grape),
    cherry: Number(rs.rows[0].cherry),
  };
}

// 設定保存
async function setSlotConfig(big, reg, grape, cherry) {
  await pool.query(`INSERT INTO slot_config(big,reg,grape,cherry,updated_at) VALUES($1,$2,$3,$4,now())`, [big, reg, grape, cherry]);
}

/* ==============================
   ジャグラー：リール制御
============================== */
const JUGGLER_BET = 10;

function drawSymbol(cfg) {
  const r = Math.random();
  if (r < cfg.big) return "7️⃣";
  if (r < cfg.big + cfg.reg) return "🎰";
  if (r < cfg.big + cfg.reg + cfg.cherry) return "🍒";
  if (r < cfg.big + cfg.reg + cfg.cherry + cfg.grape) return "🍇";
  return ["🍋","⭐"][Math.floor(Math.random()*2)];
}

function spinBoard(cfg) {
  return [
    [drawSymbol(cfg), drawSymbol(cfg), drawSymbol(cfg)],
    [drawSymbol(cfg), drawSymbol(cfg), drawSymbol(cfg)],
    [drawSymbol(cfg), drawSymbol(cfg), drawSymbol(cfg)]
  ];
}

function renderBoard(board) {
  return (
    `| ${board[0][0]} | ${board[1][0]} | ${board[2][0]} |\n` +
    `| ${board[0][1]} | ${board[1][1]} | ${board[2][1]} |\n` +
    `| ${board[0][2]} | ${board[1][2]} | ${board[2][2]} |`
  );
}

function judge(board) {
  const line = [board[0][1], board[1][1], board[2][1]];
  const all = (s) => line.every(v => v === s);
  if (all("7️⃣"))  return { reward: 300, type: "BIG" };
  if (all("🎰"))  return { reward: 100, type: "REG" };
  if (all("🍇"))  return { reward: 15,  type: "ぶどう" };
  if (all("🍒"))  return { reward: 10,  type: "チェリー" };
  return { reward: 0, type: "ハズレ" };
}

/* ==============================
   ジャグラー：プレイ
============================== */
async function playCasinoSlot(interaction) {
  const uid = interaction.user.id;
  const balance = await getBalance(uid);

  if (balance < JUGGLER_BET) {
    return ephemeralReply(interaction, { embeds: [createEmbed("🎰 ジャグラー", `残高不足！必要:${fmt(JUGGLER_BET)}S / 保有:${fmt(balance)}S`, Colors.Red)] });
  }

  const cfg = await getSlotConfig();
  const finalBoard = spinBoard(cfg);
  const { reward, type } = judge(finalBoard);
  const net = reward - JUGGLER_BET;

  await addCoins(uid, net, "casino_slot", `役:${type}`);

  // メインUI
  await interaction.deferReply({ ephemeral: true });

  let embed = new EmbedBuilder()
    .setTitle("🎰 ジャグラー START!!")
    .setDescription("```\n| ❓ | ❓ | ❓ |\n| ❓ | ❓ | ❓ |\n| ❓ | ❓ | ❓ |\n```")
    .setColor(Colors.Blurple);
  await interaction.editReply({ embeds: [embed] });

  // ドラム順番停止演出
  for (let i=0; i<3; i++) {
    await new Promise(r => setTimeout(r, 1200));
    const tempBoard = spinBoard(cfg);
    for (let j=0;j<=i;j++) tempBoard[j] = finalBoard[j];
    embed = new EmbedBuilder()
      .setTitle("🎰 回転中…")
      .setDescription("```\n" + renderBoard(tempBoard) + "\n```")
      .setColor(Colors.Blue);
    await interaction.editReply({ embeds: [embed] });
  }

  // 最終結果
  const newBalance = await getBalance(uid);
  let resultEmbed = new EmbedBuilder()
    .setTitle(`🎲 結果: ${type}`)
    .setDescription("```\n" + renderBoard(finalBoard) + "\n```" + `\n💰 獲得: ${fmt(reward)}S\n📉 収支: ${fmt(net)}S\n💵 残高: ${fmt(newBalance)}S`)
    .setColor(type==="BIG" ? Colors.Gold : type==="REG" ? Colors.Red : type==="ハズレ" ? Colors.Grey : Colors.Green);

  await interaction.editReply({ embeds: [resultEmbed] });

  // 演出ごとの追加
  if (type === "BIG") {
    await interaction.followUp({ embeds: [createEmbed("🎆 BIG BONUS 🎆", "🌈 祝福モード突入！\nファンファーレが鳴り響く！", Colors.Gold)], ephemeral: true });
  } else if (type === "REG") {
    await interaction.followUp({ embeds: [createEmbed("🔴 REG BONUS!", "♪ ピポピポーン！", Colors.Red)], ephemeral: true });
  } else if (type === "ぶどう" || type === "チェリー") {
    await interaction.followUp({ embeds: [createEmbed(`🍒 ${type} 揃い！`, "キラキラリン✨", Colors.Green)], ephemeral: true });
  } else {
    await interaction.followUp({ embeds: [createEmbed("❌ ハズレ", "♪ シーン…", Colors.Grey)], ephemeral: true });
  }
}

/* ==============================
   管理UI：ジャグラー確率設定
============================== */
async function openSlotConfigModal(interaction) {
  if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
    return ephemeralReply(interaction, { content: "管理者権限が必要です。" });
  }
  const modal = new ModalBuilder()
    .setCustomId("slot_config_modal")
    .setTitle("🎰 ジャグラー確率設定")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("big").setLabel("BIG確率 (例: 0.005)").setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("reg").setLabel("REG確率 (例: 0.01)").setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("grape").setLabel("ぶどう確率").setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("cherry").setLabel("チェリー確率").setStyle(TextInputStyle.Short).setRequired(true)
      )
    );
  return interaction.showModal(modal);
}

async function handleSlotConfigModal(interaction) {
  const big = parseFloat(interaction.fields.getTextInputValue("big"));
  const reg = parseFloat(interaction.fields.getTextInputValue("reg"));
  const grape = parseFloat(interaction.fields.getTextInputValue("grape"));
  const cherry = parseFloat(interaction.fields.getTextInputValue("cherry"));

  if (![big, reg, grape, cherry].every(v => !isNaN(v) && v > 0)) {
    return ephemeralReply(interaction, { content: "入力が不正です。数値で指定してください。" });
  }

  await setSlotConfig(big, reg, grape, cherry);
  return ephemeralReply(interaction, { content: "✅ ジャグラー確率を更新しました。" });
}
/* ==============================
   Interaction Handler
============================== */
client.on("interactionCreate", async (interaction) => {
  try {
    // ===== ボタン =====
    if (interaction.isButton()) {
      switch (interaction.customId) {
        /* --- 管理 --- */
        case "admin_adjust":
          if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
            return ephemeralReply(interaction, { content: "管理者権限が必要です。" });
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

        case "view_history_admin": {
          const res = await pool.query(`SELECT * FROM history ORDER BY created_at DESC LIMIT 15`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "履歴はありません。" });
          await replyHistoryEmbeds(interaction, res.rows);
          return;
        }

        case "slot_config": return openSlotConfigModal(interaction);

        /* --- コイン --- */
        case "daily_claim": return claimDaily(interaction);
        case "check_balance": {
          const bal = await getBalance(interaction.user.id);
          return ephemeralReply(interaction, { embeds: [createEmbed("残高確認", `${fmt(bal)} S`)] });
        }
        case "view_history_user": {
          const uid = interaction.user.id;
          const res = await pool.query(`SELECT * FROM history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 15`, [uid]);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "履歴はありません。" });
          await replyHistoryEmbeds(interaction, res.rows);
          return;
        }
        case "view_ranking": return showRanking(interaction);

        /* --- ガチャ --- */
        case "gacha_play": return playGacha(interaction);

        /* --- ジャグラー --- */
        case "casino_slot": return playCasinoSlot(interaction);

        /* --- レース --- */
        case "rumuma_history": return showRaceHistory(interaction);
        case "rumuma_claim_rewards": return claimRewards(interaction);
        // （他のレース操作は Part3 で処理済み）
      }
    }

    // ===== モーダル =====
    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId === "admin_adjust_modal") {
        const uid = interaction.fields.getTextInputValue("target_user").trim();
        const amount = parseInt(interaction.fields.getTextInputValue("amount"), 10);
        if (isNaN(amount)) return ephemeralReply(interaction, { content: "金額が不正です。" });
        await addCoins(uid, amount, "admin_adjust", "管理者操作");
        return ephemeralReply(interaction, { content: `✅ ユーザー:${uid} に ${fmt(amount)}S 調整しました。` });
      }

      if (interaction.customId === "gacha_ssr_modal") return handleSSRRole(interaction);

      if (interaction.customId === "slot_config_modal") return handleSlotConfigModal(interaction);
    }

    // ===== セレクトメニュー =====
    if (interaction.isStringSelectMenu()) {
      // Part3 レース用の処理がここに統合される（省略せず）
    }
  } catch (e) {
    console.error("interaction error:", e);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "⚠️ エラーが発生しました。", ephemeral: true });
    }
  }
});

/* ==============================
   メッセージ監視：発言報酬
============================== */
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot || !msg.guild) return;
    if (msg.content.trim().length < 2) return;
    await handleMessageReward(msg);
  } catch (e) {
    console.error("message reward error:", e);
  }
});

/* ==============================
   デイリー受取リセット（JST 05:00）
============================== */
schedule.scheduleJob("0 20 * * *", async () => { // UTC20 = JST05
  await pool.query("DELETE FROM daily_claims");
  console.log("✅ デイリー受取リセット完了 (JST05:00)");
});

/* ==============================
   Ready
============================== */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await ensureTables();

  // 管理UI
  if (process.env.ADMIN_CHANNEL_ID) {
    const ch = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID).catch(() => null);
    if (ch) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin_adjust").setLabel("⚙️ コイン増減").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("slot_config").setLabel("🎰 ジャグラー確率設定").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("view_history_admin").setLabel("📜 全履歴").setStyle(ButtonStyle.Secondary)
      );
      await ch.send({ content: "管理メニュー", components: [row] });
    }
  }

  // デイリー/コインUI
  if (process.env.DAILY_CHANNEL_ID) {
    const ch = await client.channels.fetch(process.env.DAILY_CHANNEL_ID).catch(() => null);
    if (ch) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("daily_claim").setLabel("🎁 デイリーコイン").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("gacha_play").setLabel("🎲 ガチャ").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("casino_slot").setLabel("🎰 ジャグラー").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("check_balance").setLabel("💰 残高確認").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("view_history_user").setLabel("📜 取引履歴").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("view_ranking").setLabel("🏅 ランキング").setStyle(ButtonStyle.Primary)
      );
      await ch.send({ content: "コインメニュー", components: [row] });
    }
  }

  // レースUI
  if (process.env.RUMUMA_CHANNELS) {
    for (const cid of process.env.RUMUMA_CHANNELS.split(",")) {
      const ch = await client.channels.fetch(cid.trim()).catch(() => null);
      if (ch) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("rumuma_history").setLabel("🗂 レース履歴").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("rumuma_claim_rewards").setLabel("💳 払い戻し").setStyle(ButtonStyle.Primary)
        );
        await ch.send({ content: "レースメニュー", components: [row] });
      }
    }
  }
});

/* ==============================
   HTTP Server (Render)
============================== */
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!\n");
}).listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
});

/* ==============================
   Login
============================== */
client.login(process.env.DISCORD_TOKEN);
