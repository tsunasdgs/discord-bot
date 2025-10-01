import {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, InteractionType
} from "discord.js";
import { Pool } from "pg";
import dotenv from "dotenv";
import schedule from "node-schedule";

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// ================== ヘルパー ==================
function createEmbed(title, desc, color = "Blue") {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);
}

async function addCoins(userId, amount, type, note = null) {
  await pool.query(
    `INSERT INTO coins (user_id, balance)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET balance = coins.balance + $2`,
    [userId, amount]
  );

  await pool.query(
    `INSERT INTO history (user_id, type, amount, note)
     VALUES ($1, $2, $3, $4)`,
    [userId, type, amount, note]
  );
}

// ================== UI ボタン配置 ==================
async function sendMainUI(channel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("daily_claim").setLabel("🎁 デイリー取得").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("check_balance").setLabel("💰 残高確認").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("lumma_create").setLabel("🏇 ルムマ作成").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("admin_adjust").setLabel("⚙️ 管理UI").setStyle(ButtonStyle.Danger)
  );
  await channel.send({ content: "コイン＆ルムマメニュー", components: [row] });
}

// ================== INTERACTIONS ==================
client.on("interactionCreate", async (interaction) => {
  try {
    // ----- ボタン -----
    if (interaction.isButton()) {
      switch (interaction.customId) {
        case "daily_claim": {
          await interaction.deferReply({ ephemeral: true });
          const uid = interaction.user.id;
          const today = new Date().toISOString().slice(0, 10);

          const res = await pool.query(
            `SELECT last_claim FROM daily_claims WHERE user_id=$1`,
            [uid]
          );
          if (res.rowCount && res.rows[0].last_claim === today) {
            return await interaction.editReply({
              embeds: [createEmbed("デイリー", "今日はもう受け取り済みです", "Red")]
            });
          }

          await pool.query(
            `INSERT INTO daily_claims (user_id, last_claim)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET last_claim=$2`,
            [uid, today]
          );

          await addCoins(uid, 100, "daily", "デイリー報酬");
          return await interaction.editReply({
            embeds: [createEmbed("デイリー", "100Sを受け取りました！", "Green")]
          });
        }

        case "check_balance": {
          await interaction.deferReply({ ephemeral: true });
          const uid = interaction.user.id;
          const res = await pool.query(`SELECT balance FROM coins WHERE user_id=$1`, [uid]);
          const bal = res.rowCount ? res.rows[0].balance : 0;
          return await interaction.editReply({ embeds: [createEmbed("残高確認", `${bal} S`)] });
        }

        case "lumma_create": {
          const modal = new ModalBuilder()
            .setCustomId("lumma_create_modal")
            .setTitle("ルムマ作成")
            .setComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("race_name")
                  .setLabel("レース名")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("horses")
                  .setLabel("ウマ名をカンマ区切りで入力 (2-18頭)")
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(true)
              )
            );
          return await interaction.showModal(modal);
        }

        case "admin_adjust": {
          const modal = new ModalBuilder()
            .setCustomId("adjust_coins_modal")
            .setTitle("ユーザーコイン増減")
            .setComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("target_user")
                  .setLabel("対象ユーザーID")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId("amount")
                  .setLabel("増減金額 (マイナスも可)")
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
              )
            );
          return await interaction.showModal(modal);
        }
      }
    }

    // ----- モーダル -----
    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId === "lumma_create_modal") {
        const raceName = interaction.fields.getTextInputValue("race_name");
        const horses = interaction.fields
          .getTextInputValue("horses")
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean);

        if (horses.length < 2 || horses.length > 18) {
          return await interaction.reply({
            embeds: [createEmbed("エラー", "ウマは2頭以上18頭以下で入力してください", "Red")],
            ephemeral: true
          });
        }

        const res = await pool.query(
          `INSERT INTO lumma_races (channel_id, host_id, race_name, horses)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [interaction.channelId, interaction.user.id, raceName, horses]
        );

        return await interaction.reply({
          embeds: [
            createEmbed(
              "ルムマ作成完了 🎉",
              `ID: ${res.rows[0].id}\nレース名: ${raceName}\n出走: ${horses.join(", ")}`
            )
          ],
          ephemeral: true
        });
      }

      if (interaction.customId === "adjust_coins_modal") {
        const target = interaction.fields.getTextInputValue("target_user");
        const amount = parseInt(interaction.fields.getTextInputValue("amount"));

        if (isNaN(amount))
          return interaction.reply({ content: "数値を入力してください", ephemeral: true });

        await addCoins(target, amount, "admin", `by ${interaction.user.id}`);
        return interaction.reply({
          content: `ユーザー ${target} に ${amount}S を適用しました`,
          ephemeral: true
        });
      }
    }
  } catch (err) {
    console.error("interaction error:", err);
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          embeds: [createEmbed("エラー", "処理中に問題が発生しました", "Red")]
        }).catch(() => {});
      } else {
        await interaction.reply({
          embeds: [createEmbed("エラー", "処理中に問題が発生しました", "Red")],
          ephemeral: true
        }).catch(() => {});
      }
    }
  }
});

// ================== スケジュール (毎日5時リセット) ==================
schedule.scheduleJob("0 5 * * *", async () => {
  await pool.query("DELETE FROM daily_claims");
  console.log("✅ デイリー受取リセット完了");
});

// ================== READY ==================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const channel = await client.channels.fetch(process.env.DAILY_CHANNEL_ID);
  if (channel) sendMainUI(channel);
});

client.login(process.env.DISCORD_TOKEN);
