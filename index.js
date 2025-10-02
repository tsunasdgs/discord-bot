// index.js  （"type": "module" 環境を想定）

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
const DAILY_AMOUNT = parseInt(process.env.DAILY_AMOUNT || "100", 10);

// 発言報酬
const REWARD_ROLE_ID       = process.env.REWARD_ROLE_ID || ""; 
const REWARD_PER_MESSAGE   = parseInt(process.env.REWARD_PER_MESSAGE || "10", 10);
const REWARD_DAILY_LIMIT   = parseInt(process.env.REWARD_DAILY_LIMIT || "10", 10);
const REWARD_COOLDOWN_SEC  = parseInt(process.env.REWARD_COOLDOWN_SEC || "45", 10);

/* ==============================
   共通ヘルパー
============================== */
function createEmbed(title, desc, color = "Blue") {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);
}

// すべての返信をエフェメラル（flags: 64）＆自動消去
async function ephemeralReply(interaction, payload, ms = 15000) {
  const msg = await interaction.reply({ ...payload, flags: 64 });
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
  return msg;
}
async function ephemeralUpdate(interaction, payload, ms = 15000) {
  const msg = await interaction.update({ ...payload });
  setTimeout(() => interaction.deleteReply().catch(() => {}), ms);
  return msg;
}

async function addCoins(userId, amount, type, note = null) {
  const n = Number(amount) | 0; // Neon integer 前提
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
      status     TEXT,      -- 'finished' | 'canceled'
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
    CREATE TABLE IF NOT EXISTS message_rewards (
      user_id TEXT PRIMARY KEY,
      date TEXT,                -- YYYY-MM-DD
      count INTEGER DEFAULT 0,
      last_message_at TIMESTAMP,
      last_message_hash TEXT
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
   UI送信（管理／デイリー／レース）
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
      new ButtonBuilder().setCustomId("daily_claim").setLabel("🎁 デイリー取得").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("check_balance").setLabel("💰 残高確認").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("view_history_user").setLabel("📜 取引履歴").setStyle(ButtonStyle.Secondary) // ラベルを「取引履歴」に変更
    );
    await channel.send({ content: "デイリーメニュー", components: [row] });
  }

  if (type === "rumuma") {
    // 1行目
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rumuma_create").setLabel("🏇 レース作成").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("rumuma_list").setLabel("📃 レース一覧").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rumuma_bet").setLabel("🎫 ウマ券購入").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("rumuma_my_bets").setLabel("🎫 ウマ券確認").setStyle(ButtonStyle.Secondary)
    );
    // 2行目
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("rumuma_close_bets").setLabel("✅ 投票締切").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rumuma_report_result").setLabel("🏆 結果報告").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("rumuma_cancel").setLabel("⛔ 開催中止").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("rumuma_history").setLabel("🗂 競争履歴").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("rumuma_claim_rewards").setLabel("💳 払い戻し").setStyle(ButtonStyle.Primary)
    );
    // 3行目（残高）
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("check_balance").setLabel("💰 残高確認").setStyle(ButtonStyle.Secondary)
    );

    await channel.send({ content: "レースメニュー", components: [row1, row2, row3] });
  }
}

/* ==============================
   Interaction（ボタン／セレクト／モーダル）
============================== */
client.on("interactionCreate", async (interaction) => {
  // 受信ログ（簡易）
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

          // 最新20件のみ（Discordの文字数制限対策）
          const res = await pool.query(`SELECT * FROM history ORDER BY created_at DESC LIMIT 20`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "履歴はありません" });
          const lines = res.rows.map(r =>
            `${r.created_at.toISOString().slice(0,19).replace("T"," ")} | ${r.user_id} | ${r.type} | ${r.amount} | ${r.note || ""}`
          ).join("\n");
          return ephemeralReply(interaction, { content: "直近20件\n" + lines });
        }

        /* ===== デイリー/残高/履歴 ===== */
        case "daily_claim": {
          const uid = interaction.user.id;
          const today = new Date().toISOString().slice(0, 10);
          const res = await pool.query(`SELECT last_claim FROM daily_claims WHERE user_id=$1`, [uid]);
          if (res.rowCount && res.rows[0].last_claim === today)
            return ephemeralReply(interaction, { embeds: [createEmbed("デイリー", "今日はもう受け取り済みです", "Red")] });

          await pool.query(
            `INSERT INTO daily_claims (user_id, last_claim)
             VALUES ($1,$2)
             ON CONFLICT(user_id) DO UPDATE SET last_claim=$2`,
            [uid, today]
          );
          await addCoins(uid, DAILY_AMOUNT, "daily", "デイリー報酬");
          return ephemeralReply(interaction, { embeds: [createEmbed("デイリー", `${DAILY_AMOUNT}Sを受け取りました！`, "Green")] });
        }

        case "check_balance": {
          const uid = interaction.user.id;
          const res = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [uid]);
          const bal = res.rowCount ? Number(res.rows[0].balance) : 0;
          return ephemeralReply(interaction, { embeds: [createEmbed("残高確認", `${bal} S`)] });
        }

        case "view_history_user": {
          const uid = interaction.user.id;
          // 最新20件のみ
          const res = await pool.query(`SELECT * FROM history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [uid]);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "履歴はありません" });
          const lines = res.rows.map(r =>
            `${r.created_at.toISOString().slice(0,19).replace("T"," ")} | ${r.type} | ${r.amount} | ${r.note || ""}`
          ).join("\n");
          return ephemeralReply(interaction, { content: "あなたの直近20件\n" + lines });
        }

        /* ===== レース：一覧 ===== */
        case "rumuma_list": {
          const res = await pool.query(`SELECT * FROM rumuma_races ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "レースはありません" });
          const list = res.rows.map(r =>
            `ID:${r.id} ${r.race_name}（${r.horses.join(", ")}） ${r.finished ? "[締切]" : "[開催中]"}`
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
          return ephemeralReply(interaction, { content: "レースを選択してください", components: [new ActionRowBuilder().addComponents(menu)] });
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

          const lines = active.map(row => `Race:${row.race_id} ${row.race_name} - ${row.horse} に ${Number(row.total_amount)}S`).join("\n");
          return ephemeralReply(interaction, { content: "あなたの未決着ウマ券\n" + lines });
        }

        /* ===== 投票締切 ===== */
        case "rumuma_close_bets": {
          const res = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=false ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "締切対象のレースがありません" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_close_race")
            .setPlaceholder("締切するレースを選択")
            .addOptions(res.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));
          return ephemeralReply(interaction, { content: "締切するレースを選択してください", components: [new ActionRowBuilder().addComponents(menu)] });
        }

        /* ===== 結果報告（締切レース → 勝者選択） ===== */
        case "rumuma_report_result": {
          const res = await pool.query(`SELECT id, race_name FROM rumuma_races WHERE finished=true ORDER BY id DESC`);
          if (!res.rowCount) return ephemeralReply(interaction, { content: "結果報告可能なレースがありません（まず締切してください）" });
          const menu = new StringSelectMenuBuilder()
            .setCustomId("select_result_race")
            .setPlaceholder("結果報告するレースを選択")
            .addOptions(res.rows.map(r => ({ label: r.race_name, value: String(r.id), description: `ID:${r.id}` })));
          return ephemeralReply(interaction, { content: "結果報告するレースを選択してください", components: [new ActionRowBuilder().addComponents(menu)] });
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
          return ephemeralReply(interaction, { content: "開催中止するレースを選択してください（全額払い戻し）", components: [new ActionRowBuilder().addComponents(menu)] });
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
            const when = r.finished_at?.toISOString?.().slice(0,19).replace("T"," ") || "";
            const tag = r.status === "canceled" ? "【開催中止】" : `勝者:${r.winner}`;
            return `${when} | Race:${r.race_id} ${r.race_name} | ${tag} | 総額:${r.total_pot ?? 0}S`;
          }).join("\n");
          return ephemeralReply(interaction, { content: "直近10件の競争履歴\n" + lines });
        }

        /* ===== 払い戻し（未受け取り一括受取：合計＋内訳表示） ===== */
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

          const total = res.rows.reduce((s, r) => s + Number(r.amount), 0);

          // 受け取り処理
          await addCoins(uid, total, "reward_claim", "払い戻し一括受け取り");
          await pool.query(`UPDATE pending_rewards SET claimed=true WHERE user_id=$1 AND claimed=false`, [uid]);

          // 内訳
          const lines = res.rows.map(r => `Race:${r.race_id} ${r.race_name} → ${r.amount}S`).join("\n");

          return ephemeralReply(interaction, {
            content: `払い戻し ${res.rowCount}件 合計 ${total}S を受け取りました！\n\n内訳:\n${lines}`
          });
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
          .addOptions(r.rows[0].horses.map(h => ({ label: h, value: h })));

        return ephemeralUpdate(interaction, {
          content: `レースID:${raceId} 賭けるウマを選んでください`,
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }

      // 購入：ウマ選択 → 金額入力モーダル（ラベルは「金額」だけ。複数値OK）
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
                .setLabel("金額") // 説明は表示しない（スペース/カンマ区切りで複数OK）
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
          .addOptions(r.rows[0].horses.map(h => ({ label: h, value: h })));

        return ephemeralUpdate(interaction, {
          content: `レースID:${raceId} 勝者を選択してください`,
          components: [new ActionRowBuilder().addComponents(menu)]
        });
      }

      // 結果報告：勝者選択 → pending_rewards に記録 & 履歴保存 & レース削除
      if (interaction.customId.startsWith("select_winner_")) {
        const raceId = parseInt(interaction.customId.split("_")[2], 10);
        const winner = interaction.values[0];

        const raceRes = await pool.query(`SELECT race_name, horses FROM rumuma_races WHERE id=$1`, [raceId]);
        if (!raceRes.rowCount) return ephemeralUpdate(interaction, { content: "レースが見つかりません", components: [] });

        const bets = await pool.query(`SELECT * FROM rumuma_bets WHERE race_id=$1`, [raceId]);
        const totalPot = bets.rows.reduce((a, b) => a + Number(b.amount), 0);
        const winners = bets.rows.filter(b => b.horse === winner);
        const totalWin = winners.reduce((a, b) => a + Number(b.amount), 0);

        if (winners.length) {
          for (const b of winners) {
            const payout = Math.floor(totalPot * (Number(b.amount) / totalWin));
            await pool.query(
              `INSERT INTO pending_rewards(user_id, race_id, race_name, amount)
               VALUES ($1,$2,$3,$4)`,
              [b.user_id, raceId, raceRes.rows[0].race_name, payout]
            );
          }
        } else {
          // 勝者に賭けなし → 全額返金
          for (const b of bets.rows) {
            await addCoins(b.user_id, b.amount, "rumuma_refund", `Race:${raceId} 勝者なし返金`);
          }
        }

        // 履歴保存
        await pool.query(
          `INSERT INTO rumuma_results(race_id, race_name, horses, winner, total_pot, status, finished_at)
           VALUES ($1,$2,$3,$4,$5,'finished',NOW())`,
          [raceId, raceRes.rows[0].race_name, raceRes.rows[0].horses, winner, totalPot]
        );

        // 後始末
        await pool.query(`DELETE FROM rumuma_bets WHERE race_id=$1`, [raceId]);
        await pool.query(`DELETE FROM rumuma_races WHERE id=$1`, [raceId]);

        return ephemeralUpdate(interaction, { content: `レースID:${raceId} 勝者:${winner} 払い戻しを未受け取りとして保存しました。「💳 払い戻し」で受け取れます。`, components: [] });
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
        return ephemeralReply(interaction, { content: `ユーザー:${uid} に ${amount} 調整しました` });
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

      // ウマ券購入（スペース/カンマ区切りの複数金額を許容）
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
        if (balance < total) return ephemeralReply(interaction, { content: `残高不足：必要 ${total}S / 保有 ${balance}S` });

        // 合計分減算＋履歴
        await addCoins(interaction.user.id, -total, "rumuma_bet", `Race:${raceId} Bet:${horse} x${amounts.length}`);

        // チケット単位で記録
        for (const amt of amounts) {
          await pool.query(
            `INSERT INTO rumuma_bets(race_id, user_id, horse, amount) VALUES($1,$2,$3,$4)`,
            [raceId, interaction.user.id, horse, amt]
          );
        }
        return ephemeralReply(interaction, { content: `購入完了：Race:${raceId} ${horse} に [${amounts.join(", ")}]S` });
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
const NG_WORDS = new Set(["ああ", "いい", "あ", "い", "う", "え", "お", "草", "w", "ｗ"]); // 簡易NG例
function hashMessage(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

client.on(Events.MessageCreate, async (msg) => {
  try {
    // BOT・DM除外
    if (msg.author.bot || !msg.guild) return;

    // 対象ロールのみ（指定があれば）
    if (REWARD_ROLE_ID) {
      const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
      if (!member || !member.roles.cache.has(REWARD_ROLE_ID)) return;
    }

    const content = (msg.content || "").trim();
    if (!content) return;

    // NGワード・超短文(2文字以下)・単発の「w/草」等 除外
    if (NG_WORDS.has(content) || content.length <= 2) return;

    const today = new Date().toISOString().slice(0,10);
    const h = hashMessage(content);

    const res = await pool.query(`SELECT * FROM message_rewards WHERE user_id=$1`, [msg.author.id]);
    if (!res.rowCount) {
      await pool.query(`INSERT INTO message_rewards(user_id, date, count, last_message_at, last_message_hash)
                        VALUES ($1,$2,1,NOW(),$3)`,
                        [msg.author.id, today, h]);
      await addCoins(msg.author.id, REWARD_PER_MESSAGE, "msg_reward", "初回メッセージ報酬");
      return;
    }

    const row = res.rows[0];
    // 日切替
    if (row.date !== today) {
      await pool.query(`UPDATE message_rewards SET date=$1, count=0 WHERE user_id=$2`, [today, msg.author.id]);
      row.count = 0;
    }

    // 上限
    if (row.count >= REWARD_DAILY_LIMIT) return;

    // 連投クールダウン
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
   デイリー集計リセット（毎日05:00）
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
   HTTP サーバー（Render の健全性チェック用）
============================== */
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running!\n");
}).listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
});
