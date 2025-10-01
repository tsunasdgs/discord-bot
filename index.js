// bot.js
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  InteractionType,
} from "discord.js";
import { Pool } from "pg";
import dotenv from "dotenv";
import schedule from "node-schedule";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 環境変数
const DAILY_CHANNEL_ID = process.env.DAILY_CHANNEL_ID;
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID;
const LUMMA_CHANNELS = process.env.LUMMA_CHANNELS?.split(",") || [];
const DAILY_AMOUNT = Number(process.env.DAILY_AMOUNT || 100);
const MESSAGE_AMOUNT = Number(process.env.MESSAGE_AMOUNT || 10);
const MESSAGE_DAILY_LIMIT = Number(process.env.MESSAGE_DAILY_LIMIT || 5);

// ================== DB関数 ==================
async function getUser(userId) {
  const { rows } = await pool.query("SELECT * FROM users WHERE user_id=$1", [userId]);
  return rows[0];
}

async function addCoins(userId, amount) {
  await pool.query(
    `INSERT INTO users (user_id, coins, last_daily, message_count)
     VALUES ($1, $2, NOW(), 0)
     ON CONFLICT (user_id) DO UPDATE SET coins = users.coins + $2`,
    [userId, amount]
  );
}

async function setCoins(userId, amount) {
  await pool.query(
    `INSERT INTO users (user_id, coins, last_daily, message_count)
     VALUES ($1, $2, NOW(), 0)
     ON CONFLICT (user_id) DO UPDATE SET coins = $2`,
    [userId, amount]
  );
}

async function resetDaily() {
  await pool.query("UPDATE users SET last_daily = NULL, message_count = 0");
}

// ================== UI送信 ==================
async function sendDailyUI() {
  const channel = await client.channels.fetch(DAILY_CHANNEL_ID);
  if (!channel) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("daily").setLabel("デイリー報酬を受け取る").setStyle(ButtonStyle.Success)
  );
  await channel.send({ content: "今日のデイリーを受け取ろう！", components: [row] });
}

async function sendAdminUI() {
  const channel = await client.channels.fetch(ADMIN_CHANNEL_ID);
  if (!channel) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("adjust_coins").setLabel("コイン増減").setStyle(ButtonStyle.Primary)
  );
  await channel.send({ content: "管理用パネル", components: [row] });
}

async function sendLumMaUI() {
  for (const chId of LUMMA_CHANNELS) {
    const channel = await client.channels.fetch(chId);
    if (!channel) continue;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("create_race").setLabel("ルムマ作成").setStyle(ButtonStyle.Danger)
    );
    await channel.send({ content: "ルムマ（レース）を開催できます", components: [row] });
  }
}

// ================== Ready ==================
client.once("ready", async () => {
  console.log(`✅ ${client.user.tag} でログインしました`);
  await sendDailyUI();
  await sendAdminUI();
  await sendLumMaUI();

  // 毎朝5時にリセット
  schedule.scheduleJob("0 5 * * *", async () => {
    await resetDaily();
    await sendDailyUI();
  });
});

// ================== Interaction ==================
client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === "daily") {
      const user = await getUser(interaction.user.id);
      if (user && user.last_daily && new Date(user.last_daily).toDateString() === new Date().toDateString()) {
        await interaction.reply({ content: "今日はすでに受け取り済みです！", flags: 64 });
      } else {
        await addCoins(interaction.user.id, DAILY_AMOUNT);
        await pool.query("UPDATE users SET last_daily = NOW() WHERE user_id=$1", [interaction.user.id]);
        await interaction.reply({ content: `✅ ${DAILY_AMOUNT}S を受け取りました！`, flags: 64 });
      }
    }

    if (interaction.customId === "adjust_coins") {
      const modal = new ModalBuilder().setCustomId("adjust_coins_modal").setTitle("ユーザーコイン増減");
      const uid = new TextInputBuilder()
        .setCustomId("target_user")
        .setLabel("ユーザーID")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const amt = new TextInputBuilder()
        .setCustomId("amount")
        .setLabel("増減する額 (+/-)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(
        new ActionRowBuilder().addComponents(uid),
        new ActionRowBuilder().addComponents(amt)
      );
      await interaction.showModal(modal);
    }

    if (interaction.customId === "create_race") {
      const modal = new ModalBuilder().setCustomId("create_race_modal").setTitle("ルムマ作成");
      const name = new TextInputBuilder()
        .setCustomId("race_name")
        .setLabel("レース名")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(name));
      await interaction.showModal(modal);
    }
  }

  if (interaction.type === InteractionType.ModalSubmit) {
    if (interaction.customId === "adjust_coins_modal") {
      const userId = interaction.fields.getTextInputValue("target_user");
      const amount = Number(interaction.fields.getTextInputValue("amount"));
      await addCoins(userId, amount);
      await interaction.reply({ content: `✅ ユーザー ${userId} に ${amount}S を反映しました`, flags: 64 });
    }

    if (interaction.customId === "create_race_modal") {
      const raceName = interaction.fields.getTextInputValue("race_name");
      const raceId = Date.now().toString();
      await pool.query("INSERT INTO races (race_id, name, status) VALUES ($1,$2,'open')", [raceId, raceName]);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`join_${raceId}`).setLabel("参加する").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`start_${raceId}`).setLabel("開始する").setStyle(ButtonStyle.Success)
      );
      await interaction.reply({ content: `🏇 レース **${raceName}** を作成しました！`, components: [row] });
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("join_")) {
      const raceId = interaction.customId.replace("join_", "");
      await pool.query(
        "INSERT INTO race_entries (race_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [raceId, interaction.user.id]
      );
      await interaction.reply({ content: "✅ レースに参加しました！", flags: 64 });
    }

    if (interaction.customId.startsWith("start_")) {
      const raceId = interaction.customId.replace("start_", "");
      const { rows } = await pool.query("SELECT * FROM race_entries WHERE race_id=$1", [raceId]);
      if (rows.length < 2) {
        await interaction.reply({ content: "⚠️ 参加者が2人以上必要です", flags: 64 });
        return;
      }
      const winner = rows[Math.floor(Math.random() * rows.length)];
      await pool.query("UPDATE races SET status='finished' WHERE race_id=$1", [raceId]);
      await interaction.reply({ content: `🏆 レース終了！優勝者は <@${winner.user_id}> さんです！` });
    }
  }
});

// ================== メッセージ報酬 ==================
client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  const user = await getUser(msg.author.id);
  if (user && user.message_count >= MESSAGE_DAILY_LIMIT) return;
  await addCoins(msg.author.id, MESSAGE_AMOUNT);
  await pool.query("UPDATE users SET message_count = COALESCE(message_count,0) + 1 WHERE user_id=$1", [msg.author.id]);
});

client.login(process.env.DISCORD_TOKEN);
