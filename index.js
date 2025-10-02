// index.js （完全統合版 / "type": "module" 前提）
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
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
   DBテーブル初期化 & ALTER
============================== */
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coins (user_id TEXT PRIMARY KEY, balance INTEGER DEFAULT 0);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS history (
      id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
      amount INTEGER NOT NULL, note TEXT, created_at TIMESTAMP DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_claims (user_id TEXT PRIMARY KEY, last_claim TEXT);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_rewards (
      user_id TEXT PRIMARY KEY, date TEXT, count INTEGER DEFAULT 0,
      last_message_at TIMESTAMP, last_message_hash TEXT
    );
  `);

  // レース・ベット・結果・未受取
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
      race_id INTEGER,
      race_name TEXT,
      horses TEXT[],
      winner TEXT,
      total_pot INTEGER,
      status TEXT,
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

  // UMA拡張カラム
  await pool.query(`ALTER TABLE rumuma_races ADD COLUMN IF NOT EXISTS type TEXT DEFAULT '中距離';`);
  await pool.query(`ALTER TABLE rumuma_races ADD COLUMN IF NOT EXISTS special BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE rumuma_races ADD COLUMN IF NOT EXISTS reward_participation INTEGER DEFAULT 10;`);
  await pool.query(`ALTER TABLE rumuma_races ADD COLUMN IF NOT EXISTS reward_winner INTEGER DEFAULT 50;`);
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
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("daily_claim").setLabel("🎁 デイリーコイン").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("gacha_play").setLabel("🎰 ガチャ").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("check_balance").setLabel("💰 残高確認").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("view_history_user").setLabel("📜 取引履歴").setStyle(ButtonStyle.Secondary)
    );
    await channel.send({ content: "コインメニュー", components: [row] });
  }
  if (type === "rumuma") {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rumuma_create").setLabel("🏇 レース作成").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("rumuma_create_special").setLabel("🎇 特別レース作成").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rumuma_list").setLabel("📃 レース一覧").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rumuma_bet").setLabel("🎫 ウマ券購入").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("rumuma_my_bets").setLabel("🎫 ウマ券確認").setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rumuma_close_bets").setLabel("✅ 投票締切").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rumuma_start").setLabel("🏁 出走（実況）").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("rumuma_cancel").setLabel("⛔ 開催中止").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rumuma_history").setLabel("🗂 競争履歴").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rumuma_claim_rewards").setLabel("💳 払い戻し受取").setStyle(ButtonStyle.Primary)
    );
    await channel.send({ content: "レースメニュー", components: [row1, row2] });
  }
}

/* ==============================
   ガチャ処理（SSRロール付き）
============================== */
async function playGacha(interaction) {
  const uid = interaction.user.id;
  const cost = 30;
  const balRes = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [uid]);
  const balance = balRes.rowCount ? Number(balRes.rows[0].balance) : 0;
  if (balance < cost) {
    return ephemeralReply(interaction, { embeds: [createEmbed("ガチャ", `残高不足：必要 ${fmt(cost)}S / 保有 ${fmt(balance)}S`, "Red")] });
  }
  await addCoins(uid, -cost, "gacha", "ガチャを回した");

  // 抽選
  const roll = Math.random();
  let rarity = "S", reward = 5;
  if (roll < 0.70) { rarity = "S"; reward = 5; }
  else if (roll < 0.95) { rarity = "SR"; reward = 10; }
  else { rarity = "SSR"; reward = 50; }

  // 報酬付与
  await addCoins(uid, reward, "gacha_reward", `ガチャ当選:${rarity}`);

  // SSRはモーダルでロール作成
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
    await ephemeralReply(interaction, {
      embeds: [createEmbed("🎰 ガチャ結果", `**${rarity}** 当選！\n🟢 +${fmt(reward)}S\nこのあとロール作成画面が開きます。`, "Gold")]
    });
    return interaction.showModal(modal);
  }

  // SSR以外
  return ephemeralReply(interaction, {
    embeds: [createEmbed("🎰 ガチャ結果", `結果: **${rarity}**\n🟢 +${fmt(reward)}S`, rarity === "SR" ? "Purple" : "Grey")]
  });
}

/* ==============================
   実況エンジン（5回/7回, 距離別パターン）
============================== */
function buildDistanceCommentary(race, winner) {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const anyHorse = () => pick(race.horses);

  const short = [
    "🏇 スタートしました！爆発的な加速！",
    `⚡ ${anyHorse()} が一気に先頭へ！`,
    "🔥 まさにスプリント勝負！",
    "💨 ゴールは目前！",
    `👑 ${winner} が駆け抜けた！一瞬の勝負！`
  ];
  const middle = [
    "🏇 スタートしました！各馬しっかり飛び出す！",
    "🔥 先頭争いは激しいデッドヒート！",
    `⚡ ${anyHorse()} が加速！観客がどよめく！`,
    "🎆 ゴール前の攻防！激しい叩き合い！",
    `👑 ${winner} が抜け出してゴールイン！`
  ];
  const long = [
    "🏇 スタートしました！各馬慎重に出だし！",
    "💤 静かな序盤、スタミナを温存している！",
    "🔥 じわじわと展開が動く！",
    `⚡ ${anyHorse()} が追い上げてきた！`,
    "🎆 最後の直線！耐久戦の決着へ！",
    `👑 ${winner} が渾身の走りでゴールイン！`
  ];

  if (race.type === "短距離") return short;
  if (race.type === "長距離") return long;
  return middle;
}

/* ==============================
   レース進行（実況＋結果確定）
============================== */
async function runRaceWithCommentary(channel, race) {
  // 内部レース進行（疑似）
  let prog = race.horses.map(h => ({ name: h, pos: 0 }));

  for (let t = 0; t < 10; t++) {
    prog.forEach(p => {
      const base = Math.random() * 3 + 1;
      const bonus = Math.random() < 0.22 ? 2 : 0;
      p.pos += Math.floor(base + bonus);
    });
  }
  prog.sort((a, b) => b.pos - a.pos);
  const winner = prog[0].name;

  // 実況（通常5回、特別7回）
  const count = race.special ? 7 : 5;
  const commentary = buildDistanceCommentary(race, winner);
  const title = race.special ? "🌟 実況 🌟" : "🐎 実況";
  const color1 = race.special ? "Orange" : "Blue";
  const color2 = race.special ? "Gold" : "Green";

  // スタート
  const startEmbed = new EmbedBuilder()
    .setTitle(`🏁 ${race.race_name}（${race.type}）スタート！`)
    .setDescription("スタートしました！")
    .setColor(race.special ? "Gold" : "Blue");
  await channel.send({ embeds: [startEmbed] });

  for (let i = 0; i < count - 1; i++) {
    await new Promise(r => setTimeout(r, 3000));
    await channel.send({ embeds: [createEmbed(title, commentary[i], color1)] });
  }
  // ラスト
  await new Promise(r => setTimeout(r, 3000));
  await channel.send({ embeds: [createEmbed(title, commentary[commentary.length - 1], color2)] });

  // 結果
  const medal = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "　");
  const ranking = prog.slice(0, 3).map((p, i) => `${medal(i)} ${p.name}`).join("\n");
  const effects = [
    `🎉✨🏆 大歓声の中、${winner} が栄光を掴んだ！✨🎉`,
    `🔥👑 ${winner} が王者の風格でゴール！👑🔥`,
    `🎆🐎 ${winner}、伝説の走り！ 🎆`
  ];
  const resultText = race.special ? effects[Math.floor(Math.random() * effects.length)] : `🏆 勝者: ${winner}`;

  const resultEmbed = new EmbedBuilder()
    .setTitle(race.special ? "🌟 特別レース結果 🌟" : "🐎 レース結果")
    .setDescription(
      `レース名: ${race.race_name}\n距離: ${race.type}\n\n${resultText}\n\n${ranking}` +
      (race.special ? `\n\n💰 特別賞\n・参加賞: ${fmt(race.reward_participation)}S\n・優勝賞: ${fmt(race.reward_winner)}S` : "")
    )
    .setColor(race.special ? "Gold" : "Blue");

  await channel.send({ embeds: [resultEmbed] });

  // DBに確定
  await pool.query(`UPDATE rumuma_races SET winner=$1, finished=true WHERE id=$2`, [winner, race.id]);

  // 配当
  await settlePayouts(race.id, winner, race);
}

/* ==============================
   配当（単勝・全額配当）＋ 特別賞
============================== */
async function settlePayouts(raceId, winner, raceRow) {
  const betsRes = await pool.query(`SELECT * FROM rumuma_bets WHERE race_id=$1`, [raceId]);
  const bets = betsRes.rows;
  const totalPot = bets.reduce((s, b) => s + Number(b.amount), 0);
  const winBets = bets.filter(b => b.horse === winner);
  const winSum  = winBets.reduce((s, b) => s + Number(b.amount), 0);

  // 履歴
  await pool.query(
    `INSERT INTO rumuma_results(race_id, race_name, horses, winner, total_pot, status, finished_at)
     VALUES ($1,$2,$3,$4,$5,'settled',NOW())`,
    [raceId, raceRow.race_name, raceRow.horses, winner, totalPot]
  );

  // 単勝配当（総額を的中者で按分）
  if (winSum > 0) {
    for (const b of winBets) {
      const payout = Math.floor(totalPot * (b.amount / winSum));
      await pool.query(
        `INSERT INTO pending_rewards(user_id, race_id, race_name, amount) VALUES($1,$2,$3,$4)`,
        [b.user_id, raceId, raceRow.race_name, payout]
      );
    }
  }

  // 特別賞
  if (raceRow.special) {
    const distinctUsers = [...new Set(bets.map(b => b.user_id))];
    for (const uid of distinctUsers) {
      if (raceRow.reward_participation > 0) {
        await pool.query(
          `INSERT INTO pending_rewards(user_id, race_id, race_name, amount) VALUES($1,$2,$3,$4)`,
          [uid, raceId, `[参加賞] ${raceRow.race_name}`, raceRow.reward_participation]
        );
      }
    }
    if (raceRow.reward_winner > 0 && winBets.length > 0) {
      // 的中者のうち最大ベット者へ優勝賞（簡易）
      const top = winBets.slice().sort((a,b)=>b.amount-a.amount)[0];
      await pool.query(
        `INSERT INTO pending_rewards(user_id, race_id, race_name, amount) VALUES($1,$2,$3,$4)`,
        [top.user_id, raceId, `[優勝賞] ${raceRow.race_name}`, raceRow.reward_winner]
      );
    }
  }
}

/* ==============================
   Interaction（ボタン／セレクト／モーダル）
============================== */
client.on("interactionCreate", async (interaction) => {
  try {
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

        /* ===== コインUI ===== */
        case "daily_claim": {
          const uid = interaction.user.id;
          const today = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo" })
            .formatToParts(new Date()).filter(p => ["year","month","day"].includes(p.type)).map(p => p.value).join("-");
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
        case "gacha_play": return playGacha(interaction);

        /* ===== レースUI ===== */
        case "rumuma_list": {
          const res = await pool.query(`SELECT * FROM rumuma_races ORDER BY id DESC LIMIT 15`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "レースはありません" });
          const list = res.rows.map(r =>
            `ID:${r.id} ${r.race_name}（${(r.horses || []).join(", ")}） ${r.finished ? "[締切]" : "[開催中]"} / 距離:${r.type}${r.special ? " / 特別🎇" : ""}`
          ).join("\n");
          return ephemeralReply(interaction, { content: list });
        }
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
        case "rumuma_create_special": {
          if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
            return ephemeralReply(interaction, { content: "特別レースは管理者のみ作成できます" });
          const modal = new ModalBuilder()
            .setCustomId("rumuma_create_special_modal")
            .setTitle("特別レース作成")
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("race_name").setLabel("レース名").setStyle(TextInputStyle.Short).setRequired(true)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("horses").setLabel("ウマ名（改行 or , 区切り）").setStyle(TextInputStyle.Paragraph).setRequired(true)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("reward_participation").setLabel("参加賞S（空なら10）").setStyle(TextInputStyle.Short).setRequired(false)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("reward_winner").setLabel("優勝賞S（空なら50）").setStyle(TextInputStyle.Short).setRequired(false)
              )
            );
          return interaction.showModal(modal);
        }
        case "rumuma_bet": {
          const res = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "購入可能なレースがありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_bet_race")
            .setPlaceholder("購入するレースを選択")
            .addOptions(res.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));
          return ephemeralReply(interaction, { content: "レースを選択してください", components: [new ActionRowBuilder().addComponents(menu)] });
        }
        case "rumuma_my_bets": {
          const uid = interaction.user.id;
          const res = await pool.query(
            `SELECT b.race_id, r.race_name, r.finished, b.horse, SUM(b.amount)::bigint AS total_amount
             FROM rumuma_bets b JOIN rumuma_races r ON r.id = b.race_id
             WHERE b.user_id=$1 GROUP BY b.race_id, r.race_name, r.finished, b.horse
             ORDER BY b.race_id DESC, r.race_name ASC, b.horse ASC`, [uid]
          );
          if (!res.rowCount) return ephemeralReply(interaction, { content: "あなたのウマ券はありません" });
          const active = res.rows.filter(row => !row.finished);
          if (!active.length) return ephemeralReply(interaction, { content: "未決着のウマ券はありません" });
          const lines = active.map(row => `Race:${row.race_id} ${row.race_name} - ${row.horse} に ${fmt(row.total_amount)}S`).join("\n");
          return ephemeralReply(interaction, { content: "あなたの未決着ウマ券\n" + lines });
        }
        case "rumuma_close_bets": {
          const res = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "締切対象のレースがありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_close_race")
            .setPlaceholder("締切するレースを選択")
            .addOptions(res.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));
          return ephemeralReply(interaction, { content: "締切するレースを選択してください", components: [new ActionRowBuilder().addComponents(menu)] });
        }
        case "rumuma_start": {
          const res = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "出走できるレースがありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_start_race")
            .setPlaceholder("出走（実況）するレースを選択")
            .addOptions(res.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));
          return ephemeralReply(interaction, { content: "出走するレースを選んでください", components: [new ActionRowBuilder().addComponents(menu)] });
        }
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
        case "rumuma_history": {
          const res = await pool.query(
            `SELECT race_id, race_name, winner, total_pot, status, finished_at
             FROM rumuma_results ORDER BY finished_at DESC LIMIT 10`
          );
          if (!res.rowCount) return ephemeralReply(interaction, { content: "競争履歴はまだありません" });
          const lines = res.rows.map(r => {
            const when = formatJST(r.finished_at);
            const tag = r.status === "canceled" ? "【開催中止】" : `勝者:${r.winner}`;
            return `${when} | Race:${r.race_id} ${r.race_name} | ${tag} | 総額:${fmt(r.total_pot ?? 0)}S`;
          }).join("\n");
          return ephemeralReply(interaction, { content: "直近10件の競争履歴\n" + lines });
        }
        case "rumuma_claim_rewards": {
          const uid = interaction.user.id;
          const res = await pool.query(
            `SELECT race_id, race_name, amount FROM pending_rewards WHERE user_id=$1 AND claimed=false ORDER BY created_at ASC`, [uid]
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
            const [rid, rname] = key.split("::");
            return `・Race:${rid} ${rname} …… ${fmt(sum)}S`;
          }).join("\n");
          return ephemeralReply(interaction, { content: `以下の払い戻しを受け取りました！\n${breakdown}\n———\n合計：${fmt(total)}S` });
        }
      }
    }

    if (interaction.isStringSelectMenu()) {
      // ウマ券：レース選択 → ウマ選択
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

      // 締切：レース選択
      if (interaction.customId === "select_close_race") {
        const raceId = parseInt(interaction.values[0], 10);
        await pool.query(`UPDATE rumuma_races SET finished=true WHERE id=$1`, [raceId]);
        return ephemeralUpdate(interaction, { content: `レースID:${raceId} のウマ券購入を締め切りました`, components: [] });
      }

      // 出走：レース選択 → 実況開始
      if (interaction.customId === "select_start_race") {
        const raceId = parseInt(interaction.values[0], 10);
        const raceRes = await pool.query(`SELECT * FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!raceRes.rowCount) return ephemeralUpdate(interaction, { content: "レースが見つかりません", components: [] });
        const race = raceRes.rows[0];
        // 出走はホスト or 管理者のみ
        const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
        if (race.host_id !== interaction.user.id && !isAdmin)
          return ephemeralUpdate(interaction, { content: "出走はホストまたは管理者のみ可能です", components: [] });
        await ephemeralUpdate(interaction, { content: `レースID:${raceId} 出走！`, components: [] });
        const channel = interaction.channel;
        runRaceWithCommentary(channel, race); // 非同期進行
      }

      // 開催中止：管理者限定
      if (interaction.customId === "select_cancel_race") {
        if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
          return ephemeralUpdate(interaction, { content: "管理者権限が必要です", components: [] });
        const raceId = parseInt(interaction.values[0], 10);
        await refundRumuma(raceId, "開催中止");
        return ephemeralUpdate(interaction, { content: `レースID:${raceId} は開催中止になりました（全額返金 & 履歴保存）`, components: [] });
      }

      // ウマ券：ウマ選択 → 金額入力
      if (interaction.customId.startsWith("select_bet_horse_")) {
        const raceId = parseInt(interaction.customId.split("_")[3], 10);
        const horse = interaction.values[0];
        const modal = new ModalBuilder()
          .setCustomId(`rumuma_bet_amount_modal_${raceId}__${encodeURIComponent(horse)}`)
          .setTitle(`ウマ券購入: ${horse}`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("amounts").setLabel("金額（半角スペース/カンマ区切りで複数可）").setStyle(TextInputStyle.Short).setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      // 距離タイプ選択（通常/特別レース作成後）
      if (interaction.customId.startsWith("select_race_type::")) {
        const [, raceName, horsesStr, specialFlag, partS, winS] = interaction.customId.split("::"); // special版でも再利用
        const horses = decodeURIComponent(horsesStr).split(",");
        const raceType = interaction.values[0]; // 短距離/中距離/長距離

        const isSpecial = specialFlag === "1";
        const rewardPart = Number(partS ?? "10") || 10;
        const rewardWin  = Number(winS  ?? "50") || 50;

        const res = await pool.query(
          `INSERT INTO rumuma_races(channel_id, host_id, race_name, horses, finished, type, special, reward_participation, reward_winner)
           VALUES($1,$2,$3,$4,false,$5,$6,$7,$8) RETURNING id`,
          [interaction.channelId, interaction.user.id, raceName, horses, raceType, isSpecial, rewardPart, rewardWin]
        );
        return ephemeralUpdate(interaction, {
          content: `🎉 レース作成完了: ID:${res.rows[0].id} ${raceName} (距離:${raceType}${isSpecial ? " / 特別🎇" : ""})`,
          components: []
        });
      }
    }

    if (interaction.type === InteractionType.ModalSubmit) {
      // 管理：コイン調整
      if (interaction.customId === "admin_adjust_modal") {
        const uid = interaction.fields.getTextInputValue("target_user").trim();
        const amount = parseInt(interaction.fields.getTextInputValue("amount"), 10);
        if (!Number.isFinite(amount)) return ephemeralReply(interaction, { content: "金額が不正です" });
        await addCoins(uid, amount, "admin_adjust", "管理者操作");
        return ephemeralReply(interaction, { content: `ユーザー:${uid} に ${fmt(amount)} 調整しました` });
      }

      // 通常レース：レース名＆馬 → 距離セレクト
      if (interaction.customId === "rumuma_create_modal") {
        const raceName = interaction.fields.getTextInputValue("race_name").trim();
        const horses = interaction.fields.getTextInputValue("horses").split(/[\n,、,]/).map(h => h.trim()).filter(Boolean);
        if (horses.length < 2) return ephemeralReply(interaction, { content: "ウマは2頭以上必要です" });
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`select_race_type::${raceName}::${encodeURIComponent(horses.join(","))}::0::10::50`)
          .setPlaceholder("距離タイプを選択してください")
          .addOptions(
            { label: "短距離 (100m)", value: "短距離", description: "スピード勝負！" },
            { label: "中距離 (500m)", value: "中距離", description: "バランス型" },
            { label: "長距離 (1000m)", value: "長距離", description: "スタミナがカギ" }
          );
        return ephemeralReply(interaction, { content: "距離タイプを選択してください", components: [new ActionRowBuilder().addComponents(menu)] });
      }

      // 特別レース：レース名＆馬＆賞金 → 距離セレクト（管理者限定）
      if (interaction.customId === "rumuma_create_special_modal") {
        if (!interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator))
          return ephemeralReply(interaction, { content: "特別レースは管理者のみ作成できます" });
        const raceName = interaction.fields.getTextInputValue("race_name").trim();
        const horses = interaction.fields.getTextInputValue("horses").split(/[\n,、,]/).map(h => h.trim()).filter(Boolean);
        if (horses.length < 2) return ephemeralReply(interaction, { content: "ウマは2頭以上必要です" });
        const partS = interaction.fields.getTextInputValue("reward_participation").trim();
        const winS  = interaction.fields.getTextInputValue("reward_winner").trim();
        const partN = Number(partS) || 10;
        const winN  = Number(winS)  || 50;

        const menu = new StringSelectMenuBuilder()
          .setCustomId(`select_race_type::${raceName}::${encodeURIComponent(horses.join(","))}::1::${partN}::${winN}`)
          .setPlaceholder("距離タイプを選択してください（特別レース）")
          .addOptions(
            { label: "短距離 (100m)", value: "短距離", description: "スピード勝負！" },
            { label: "中距離 (500m)", value: "中距離", description: "バランス型" },
            { label: "長距離 (1000m)", value: "長距離", description: "スタミナがカギ" }
          );
        return ephemeralReply(interaction, { content: "距離タイプを選択してください（特別レース）", components: [new ActionRowBuilder().addComponents(menu)] });
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

        const raceRes = await pool.query(`SELECT horses, finished FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!raceRes.rowCount) return ephemeralReply(interaction, { content: "レースが見つかりません" });
        if (raceRes.rows[0].finished) return ephemeralReply(interaction, { content: "このレースは締切済みです" });
        if (!raceRes.rows[0].horses.includes(horse)) return ephemeralReply(interaction, { content: "そのウマは出走していません" });

        const total = amounts.reduce((s, n) => s + n, 0);
        const balRes = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [interaction.user.id]);
        const balance = balRes.rowCount ? Number(balRes.rows[0].balance) : 0;
        if (balance < total) return ephemeralReply(interaction, { content: `残高不足：必要 ${fmt(total)}S / 保有 ${fmt(balance)}S` });

        await addCoins(interaction.user.id, -total, "rumuma_bet", `Race:${raceId} Bet:${horse} x${amounts.length}`);
        for (const amt of amounts) {
          await pool.query(`INSERT INTO rumuma_bets(race_id, user_id, horse, amount) VALUES($1,$2,$3,$4)`,
            [raceId, interaction.user.id, horse, amt]);
        }
        return ephemeralReply(interaction, { content: `購入完了：Race:${raceId} ${horse} に [${amounts.map(fmt).join(", ")}]S` });
      }

      // ガチャSSRロール作成
      if (interaction.customId === "gacha_ssr_modal") {
        const roleName = interaction.fields.getTextInputValue("role_name").trim();
        let roleColor = (interaction.fields.getTextInputValue("role_color").trim() || "#FFD700");
        if (!/^#?[0-9A-Fa-f]{6}$/.test(roleColor)) roleColor = "#FFD700";
        if (!roleColor.startsWith("#")) roleColor = "#" + roleColor;
        const guild = interaction.guild;
        if (!guild) return;
        try {
          const role = await guild.roles.create({ name: roleName, color: roleColor, permissions: [], reason: `SSRガチャ当選 by ${interaction.user.tag}` });
          const everyoneRole = guild.roles.everyone;
          await role.setPosition(everyoneRole.position + 1).catch(() => {});
          const member = await guild.members.fetch(interaction.user.id).catch(() => null);
          if (member) await member.roles.add(role);
          setTimeout(async () => { await role.delete("SSRロール有効期限切れ").catch(() => {}); }, 7 * 24 * 60 * 60 * 1000);
          return ephemeralReply(interaction, { embeds: [createEmbed("SSR当選 🎉", `ロール **${roleName}** を作成し付与しました！（色:${roleColor}）\nこのロールは **@everyone直下** に配置され、1週間後に自動削除されます。`, "Gold")] });
        } catch (e) {
          console.error("SSRロール作成失敗:", e);
          return ephemeralReply(interaction, { embeds: [createEmbed("SSRロール", "ロール作成に失敗しました。Botロールの位置と権限を確認してください。", "Red")] });
        }
      }
    }
  } catch (err) {
    console.error("interaction error:", err);
    try { await ephemeralReply(interaction, { content: "処理中にエラーが発生しました" }); } catch {}
  }
});

/* ==============================
   発言報酬（スパム対策付き）
============================== */
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

    const today = new Date().toISOString().slice(0, 10);
    const h = hashMessage(content);
    const res = await pool.query(`SELECT * FROM message_rewards WHERE user_id=$1`, [msg.author.id]);

    if (!res.rowCount) {
      await pool.query(`INSERT INTO message_rewards(user_id, date, count, last_message_at, last_message_hash) VALUES ($1,$2,1,NOW(),$3)`,
        [msg.author.id, today, h]);
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
    if (row.last_message_hash && row.last_message_hash === h) return;

    await addCoins(msg.author.id, REWARD_PER_MESSAGE, "msg_reward", "メッセージ報酬");
    await pool.query(
      `UPDATE message_rewards SET count=count+1, last_message_at=NOW(), last_message_hash=$1 WHERE user_id=$2`,
      [h, msg.author.id]
    );
  } catch (e) { console.error("message reward error:", e); }
});

/* ==============================
   デイリー受取リセット（UTC 05:00）
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
});

client.login(process.env.DISCORD_TOKEN);

/* ==============================
   HTTP サーバ（Render 等のヘルスチェック用）
============================== */
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!\n");
}).listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
});
