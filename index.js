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
    .format(new Date());

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

// コイン加算
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
    CREATE TABLE IF NOT EXISTS slot_states (
      user_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'NORMAL',
      spins_left INTEGER NOT NULL DEFAULT 0,
      spins_done INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slot_config (
      id INTEGER PRIMARY KEY,
      normal_big REAL NOT NULL,
      normal_reg REAL NOT NULL,
      normal_grape REAL NOT NULL,
      normal_cherry REAL NOT NULL
    );
  `);
  await pool.query(`
    INSERT INTO slot_config(id, normal_big, normal_reg, normal_grape, normal_cherry)
    VALUES (1, 140, 80, 5, 10)
    ON CONFLICT (id) DO NOTHING;
  `);
}
// ==============================
// 🎰 ジャグラー確率設定 + 超JAG-TIME対応
// ==============================
const JUGGLER_BET = 10;
const JAG_TIME_SPINS = 20;

// 🎯 確率設定（通常／JAG-TIME／超JAG-TIME）
function probsFromDenoms(denoms, mode, jagCount = 0) {
  const d = {
    big: Number(denoms.normal_big) || 140,
    reg: Number(denoms.normal_reg) || 80,
    grape: Number(denoms.normal_grape) || 5,
    cherry: Number(denoms.normal_cherry) || 10
  };

  // 🌈 超JAG-TIME（10回転以降）
  if (mode === "JAG_TIME" && jagCount >= 10) {
    return {
      big: 1 / (d.big * 0.2),
      reg: 1 / (d.reg * 0.4),
      grape: 1 / (d.grape * 0.7),
      cherry: 1 / (d.cherry * 0.7)
    };
  }

  // 🔥 通常JAG-TIME
  if (mode === "JAG_TIME") {
    return {
      big: 1 / (d.big * 0.33),
      reg: 1 / (d.reg * 0.5),
      grape: 1 / (d.grape * 0.77),
      cherry: 1 / (d.cherry * 0.77)
    };
  }

  // ⚪ 通常
  return {
    big: 1 / d.big,
    reg: 1 / d.reg,
    grape: 1 / d.grape,
    cherry: 1 / d.cherry
  };
}

// 🎲 抽選＆描画
function draw(cfg) {
  const r = Math.random();
  if (r < cfg.big) return "7️⃣";
  if (r < cfg.big + cfg.reg) return "🎰";
  if (r < cfg.big + cfg.reg + cfg.cherry) return "🍒";
  if (r < cfg.big + cfg.reg + cfg.cherry + cfg.grape) return "🍇";
  return ["🍋", "⭐"][Math.floor(Math.random() * 2)];
}
function spinBoard(cfg) {
  return [
    [draw(cfg), draw(cfg), draw(cfg)],
    [draw(cfg), draw(cfg), draw(cfg)],
    [draw(cfg), draw(cfg), draw(cfg)]
  ];
}
function renderBoard(board) {
  return (
    `| ${board[0][0]} | ${board[1][0]} | ${board[2][0]} |\n` +
    `| ${board[0][1]} | ${board[1][1]} | ${board[2][1]} |\n` +
    `| ${board[0][2]} | ${board[1][2]} | ${board[2][2]} |`
  );
}
function partialBoard(finalBoard, cfg, mask = { left: false, center: false, right: false }) {
  const rand = () => [draw(cfg), draw(cfg), draw(cfg)];
  const col = (i) => [finalBoard[i][0], finalBoard[i][1], finalBoard[i][2]];
  return [
    mask.left ? col(0) : rand(),
    mask.center ? col(1) : rand(),
    mask.right ? col(2) : rand()
  ];
}
function judge(board) {
  const line = [board[0][1], board[1][1], board[2][1]];
  const all = (s) => line.every(v => v === s);
  if (all("7️⃣")) return { reward: 120, type: "BIG" };
  if (all("🎰")) return { reward: 40, type: "REG" };
  if (all("🍇")) return { reward: 15, type: "ぶどう" };
  if (all("🍒")) return { reward: 10, type: "チェリー" };
  return { reward: 0, type: "ハズレ" };
}

// ==============================
// 🎰 状態管理
// ==============================
async function loadSlotConfig() {
  const r = await pool.query(`SELECT * FROM slot_config WHERE id=1`);
  if (!r.rowCount) return { normal_big: 140, normal_reg: 80, normal_grape: 5, normal_cherry: 10 };
  return r.rows[0];
}
async function getSlotState(uid) {
  const rs = await pool.query(`SELECT mode, spins_left, spins_done FROM slot_states WHERE user_id=$1`, [uid]);
  if (!rs.rowCount) return { mode: "NORMAL", spins_left: 0, spins_done: 0 };
  return rs.rows[0];
}
async function setSlotState(uid, mode, spins) {
  await pool.query(
    `INSERT INTO slot_states(user_id, mode, spins_left, spins_done, updated_at)
     VALUES ($1,$2,$3,0,now())
     ON CONFLICT (user_id) DO UPDATE SET mode=$2, spins_left=$3, spins_done=0, updated_at=now()`,
    [uid, mode, spins]
  );
}
async function consumeJagSpin(uid) {
  await pool.query(
    `UPDATE slot_states
     SET spins_left = GREATEST(spins_left - 1, 0),
         spins_done = spins_done + 1,
         mode = CASE WHEN spins_left - 1 <= 0 THEN 'NORMAL' ELSE mode END,
         updated_at = now()
     WHERE user_id=$1`,
    [uid]
  );
}

// ==============================
// 🎰 ジャグラー本体（超JAG-TIME + アニメ + メッセージ統一）
// ==============================
async function playCasinoSlot(interaction) {
  const uid = interaction.user.id;
  const balRes = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [uid]);
  const balance = balRes.rowCount ? Number(balRes.rows[0].balance) : 0;
  if (balance < JUGGLER_BET) {
    return interaction.reply({
      embeds: [createEmbed("🎰 ジャグラー", `残高不足：必要 ${fmt(JUGGLER_BET)}S / 保有 ${fmt(balance)}S`, Colors.Red)],
      ephemeral: true
    });
  }

  const state = await getSlotState(uid);
  const jagCount = state.spins_done || 0;
  const mode = (state.mode === "JAG_TIME" && state.spins_left > 0) ? "JAG_TIME" : "NORMAL";
  const denoms = await loadSlotConfig();
  const cfg = probsFromDenoms(denoms, mode, jagCount);
  const finalBoard = spinBoard(cfg);
  const { reward, type } = judge(finalBoard);
  const net = reward - JUGGLER_BET;

  // DB反映
  await addCoins(uid, net, "casino_slot", `役:${type}`);
  if (type === "BIG" || type === "REG") await setSlotState(uid, "JAG_TIME", JAG_TIME_SPINS);
  else if (mode === "JAG_TIME") await consumeJagSpin(uid);
  await pool.query(`UPDATE slot_states SET spins_done = COALESCE(spins_done,0)+1 WHERE user_id=$1`, [uid]);

  // 初期メッセージ
  let embed = new EmbedBuilder()
    .setTitle("🎰 スロット起動...")
    .setDescription("```\n| ❓ | ❓ | ❓ |\n| ❓ | ❓ | ❓ |\n| ❓ | ❓ | ❓ |\n```")
    .setColor(Colors.Purple);
  await interaction.reply({ embeds: [embed], ephemeral: true });

  // リール左→中→右停止アニメーション
  const seq = [
    { title: "🎡 左リール停止！", mask: { left: true } },
    { title: "🎡 中リール停止！", mask: { left: true, center: true } },
    { title: "🎡 右リール停止！", mask: { left: true, center: true, right: true } }
  ];
  for (const s of seq) {
    await new Promise(r => setTimeout(r, 400));
    const b = partialBoard(finalBoard, cfg, s.mask);
    embed = EmbedBuilder.from(embed)
      .setTitle(s.title)
      .setDescription("```\n" + renderBoard(b) + "\n```")
      .setColor(Colors.random());
    await interaction.editReply({ embeds: [embed] });
  }

  // 🌈 超JAG-TIME突入（10スピン後）
  if (mode === "JAG_TIME" && jagCount === 10) {
    embed = new EmbedBuilder()
      .setTitle("🌈 超JAG-TIME突入!!!")
      .setDescription("🔥 リールが虹色に輝く！確率さらに上昇!!")
      .setColor(Colors.Gold);
    await interaction.editReply({ embeds: [embed] });
    await new Promise(r => setTimeout(r, 1500));
  }

  // ✨ 判定アニメ
  for (const fx of ["💥", "🌈", "✨", "💥", "🌈"]) {
    await new Promise(r => setTimeout(r, 200));
    embed = EmbedBuilder.from(embed)
      .setTitle(`${fx} 判定中 ${fx}`)
      .setDescription("```\n" + renderBoard(finalBoard) + "\n```")
      .setColor(Colors.Gold);
    await interaction.editReply({ embeds: [embed] });
  }

  // 🎊 当選演出
  const frames = [];
  if (type === "BIG") {
    frames.push({ t: "💡 GOGO! ランプ点灯！", c: Colors.Purple });
    frames.push({ t: "✨ BONUS START!!", c: Colors.Red });
    frames.push({ t: "💥 爆発!!!", c: Colors.Yellow });
    frames.push({ t: "🌈 虹が輝く!!!", c: Colors.Green });
    frames.push({ t: "🎉 BIG BONUS!!!", c: Colors.Gold });
  } else if (type === "REG") {
    frames.push({ t: "🔴 REG BONUS!", c: Colors.Red });
    frames.push({ t: "✨ ピカピカ✨", c: Colors.Yellow });
  } else if (type === "ハズレ") {
    frames.push({ t: "⚡ フリーズ...", c: Colors.DarkGrey });
    frames.push({ t: "💀 暗転...", c: Colors.DarkButNotBlack });
    frames.push({ t: "📺 ノイズ...", c: Colors.Grey });
    frames.push({ t: "🔥 火花が散る！", c: Colors.Red });
    frames.push({ t: "❌ ハズレ…", c: Colors.DarkButNotBlack });
  }

  for (const f of frames) {
    await new Promise(r => setTimeout(r, 400));
    embed = EmbedBuilder.from(embed)
      .setTitle(f.t)
      .setDescription("```\n" + renderBoard(finalBoard) + "\n```")
      .setColor(f.c);
    await interaction.editReply({ embeds: [embed] });
  }

  // 💰 BIG時の加算アニメ
  if (type === "BIG") {
    let shown = 0;
    while (shown < reward) {
      shown += Math.min(5, reward - shown);
      embed = EmbedBuilder.from(embed)
        .setTitle("🎉 BONUS中...")
        .setDescription(`\`\`\`\n${renderBoard(finalBoard)}\n\`\`\`\n💰 +${fmt(shown)}S\n♪ ピロリロリン🎶`)
        .setColor(Colors.Gold);
      await interaction.editReply({ embeds: [embed] });
      await new Promise(r => setTimeout(r, 120));
    }
  }

  // 最終結果表示
  const balAfter = (await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [uid])).rows[0]?.balance || 0;
  const final = new EmbedBuilder()
    .setTitle("🎰 結果発表！")
    .setDescription("```\n" + renderBoard(finalBoard) + "\n```")
    .addFields(
      { name: "役", value: type, inline: true },
      { name: "払い戻し", value: `${fmt(reward)}S`, inline: true },
      { name: "純計算", value: `${net >= 0 ? "+" : ""}${fmt(net)}S`, inline: true },
      { name: "現在残高", value: `${fmt(balAfter)}S`, inline: false }
    )
    .setColor(type === "BIG" ? Colors.Gold : type === "REG" ? Colors.Red : Colors.Grey)
    .setFooter({ text: mode === "JAG_TIME" ? "🔥 JAG-TIME継続中！" : "🎵 Thanks for playing!" });
  await new Promise(r => setTimeout(r, 600));
  await interaction.editReply({ embeds: [final] });
}
// ==============================
// Interaction（ボタン／モーダル／メニュー）
// ==============================
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      switch (interaction.customId) {
        case "casino_slot":
          return playCasinoSlot(interaction);

        case "check_balance": {
          const uid = interaction.user.id;
          const res = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [uid]);
          const bal = res.rowCount ? Number(res.rows[0].balance) : 0;
          return ephemeralReply(interaction, {
            embeds: [createEmbed("💰 残高確認", `${fmt(bal)} S`, Colors.Green)]
          }, 15000);
        }

        case "daily_claim": {
          const uid = interaction.user.id;
          const today = todayJST();
          const r = await pool.query(`SELECT last_claim FROM daily_claims WHERE user_id=$1`, [uid]);
          const last = r.rowCount ? r.rows[0].last_claim : null;
          if (last === today)
            return ephemeralReply(interaction, { embeds: [createEmbed("🎁 デイリー", "今日はもう受取済みです。", Colors.Red)] });
          await pool.query(`
            INSERT INTO daily_claims(user_id, last_claim)
            VALUES($1, $2::date)
            ON CONFLICT(user_id) DO UPDATE SET last_claim=$2::date
          `, [uid, today]);
          await addCoins(uid, DAILY_AMOUNT, "daily", "デイリー報酬");
          return ephemeralReply(interaction, {
            embeds: [createEmbed("🎁 デイリー受取", `${fmt(DAILY_AMOUNT)}Sを獲得しました！`, Colors.Green)]
          });
        }

        case "view_ranking": {
          const rs = await pool.query(`SELECT user_id, balance FROM coins ORDER BY balance DESC LIMIT 10`);
          if (!rs.rowCount)
            return ephemeralReply(interaction, { content: "ランキングはまだありません" });
          const lines = rs.rows.map((r, i) =>
            `#${i + 1} <@${r.user_id}> … **${fmt(r.balance)}S**`
          ).join("\n");
          return ephemeralReply(interaction, {
            embeds: [createEmbed("🏅 コインランキング（TOP10）", lines, Colors.Gold)]
          });
        }

        default:
          return ephemeralReply(interaction, { content: "未対応のボタンです" });
      }
    }
  } catch (e) {
    console.error("interaction error:", e);
    if (interaction.isRepliable()) {
      await ephemeralReply(interaction, { content: "⚠️ エラーが発生しました。" }).catch(() => {});
    }
  }
});

// ==============================
// 💬 発言報酬（スパム防止付き）
// ==============================
const NG_WORDS = new Set(["あ", "い", "う", "え", "お", "草", "w", "ｗ"]);
const hashMessage = (t) => crypto.createHash("sha1").update(t).digest("hex");

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot || !msg.guild) return;
    if (REWARD_ROLE_ID) {
      const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
      if (!member || !member.roles.cache.has(REWARD_ROLE_ID)) return;
    }

    const content = (msg.content || "").trim();
    if (!content || NG_WORDS.has(content) || content.length <= 2) return;

    const today = todayJST();
    const h = hashMessage(content);
    const res = await pool.query(`SELECT * FROM message_rewards WHERE user_id=$1`, [msg.author.id]);
    if (!res.rowCount) {
      await pool.query(`
        INSERT INTO message_rewards(user_id, date, count, last_message_at, last_message_hash)
        VALUES($1, $2, 1, NOW(), $3)
      `, [msg.author.id, today, h]);
      await addCoins(msg.author.id, REWARD_PER_MESSAGE, "msg_reward", "初回メッセージ報酬");
      return;
    }

    const row = res.rows[0];
    if (row.date !== today) {
      await pool.query(`UPDATE message_rewards SET date=$1, count=0 WHERE user_id=$2`, [today, msg.author.id]);
      row.count = 0;
    }
    if (row.count >= REWARD_DAILY_LIMIT) return;

    const lastAt = row.last_message_at ? new Date(row.last_message_at).getTime() : 0;
    const diffSec = (Date.now() - lastAt) / 1000;
    if (diffSec < REWARD_COOLDOWN_SEC) return;
    if (row.last_message_hash === h) return;

    await addCoins(msg.author.id, REWARD_PER_MESSAGE, "msg_reward", "メッセージ報酬");
    await pool.query(`
      UPDATE message_rewards
      SET count = count + 1, last_message_at = NOW(), last_message_hash = $1
      WHERE user_id = $2
    `, [h, msg.author.id]);
  } catch (e) {
    console.error("message reward error:", e);
  }
});

// ==============================
// 🕒 デイリー受取リセット（JST05:00）
// ==============================
schedule.scheduleJob("0 20 * * *", async () => {
  await pool.query("DELETE FROM daily_claims");
  console.log("✅ デイリー受取リセット完了 (JST05:00)");
});

// ==============================
// 🤖 READY イベント
// ==============================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await ensureTables();

  if (CASINO_CHANNEL_ID) {
    const ch = await client.channels.fetch(CASINO_CHANNEL_ID).catch(() => null);
    if (ch) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("casino_slot").setLabel("🎰 ジャグラー").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("check_balance").setLabel("💰 残高確認").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("daily_claim").setLabel("🎁 デイリー").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("view_ranking").setLabel("🏅 ランキング").setStyle(ButtonStyle.Secondary)
      );
      await ch.send({ content: "🎲 **カジノメニュー** 🎲", components: [row] });
    }
  }
});

// ==============================
// 🌐 HTTP サーバ（Render保活）
// ==============================
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!\n");
}).listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);

// ✅ 完全出力完了
