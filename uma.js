// uma.js
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, InteractionType
} from "discord.js";

/**
 * UMA機能を初期化する
 * @param {Client} client
 * @param {Pool} pool
 * @param {Function} ephemeralReply
 * @param {Function} ephemeralUpdate
 * @param {Function} addCoins
 * @param {Function} fmt
 * @param {Function} createEmbed
 */
export function initUMA(client, pool, ephemeralReply, ephemeralUpdate, addCoins, fmt, createEmbed) {
  /* ==============================
     DB初期化
  ============================== */
  pool.query(`
    CREATE TABLE IF NOT EXISTS uma_matches (
      id SERIAL PRIMARY KEY,
      host_id TEXT,
      title TEXT,
      options TEXT[],
      status TEXT DEFAULT 'open',
      winner TEXT,
      created_at TIMESTAMP DEFAULT now()
    );
  `);
  pool.query(`
    CREATE TABLE IF NOT EXISTS uma_bets (
      id SERIAL PRIMARY KEY,
      match_id INTEGER REFERENCES uma_matches(id) ON DELETE CASCADE,
      user_id TEXT,
      option TEXT,
      amount INTEGER
    );
  `);

  /* ==============================
     READY時にUIを出す
  ============================== */
  client.once("ready", async () => {
    if (process.env.UMA_CHANNELS) {
      for (const cid of process.env.UMA_CHANNELS.split(",").map(s => s.trim()).filter(Boolean)) {
        const ch = await client.channels.fetch(cid).catch(() => null);
        if (ch) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("uma_create").setLabel("UMA作成").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("uma_list").setLabel("UMA一覧").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("uma_bet").setLabel("UMAベット").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("uma_history").setLabel("UMA履歴").setStyle(ButtonStyle.Secondary)
          );
          await ch.send({ content: "UMAメニュー", components: [row] });
        }
      }
    }
  });

  /* ==============================
     Interaction
  ============================== */
  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isButton()) {
        switch (interaction.customId) {
          case "uma_create": {
            const modal = new ModalBuilder()
              .setCustomId("uma_create_modal")
              .setTitle("UMA作成")
              .addComponents(
                new ActionRowBuilder().addComponents(
                  new TextInputBuilder()
                    .setCustomId("title")
                    .setLabel("UMAタイトル")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                  new TextInputBuilder()
                    .setCustomId("options")
                    .setLabel("出走者（改行区切り）")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                )
              );
            return interaction.showModal(modal);
          }

          case "uma_list": {
            const res = await pool.query(`SELECT * FROM uma_matches ORDER BY id DESC LIMIT 10`);
            if (!res.rowCount) return ephemeralReply(interaction, { content: "UMAはありません" });
            const list = res.rows.map(r =>
              `ID:${r.id} ${r.title} (${r.options.join(", ")}) 状態:${r.status}`
            ).join("\n");
            return ephemeralReply(interaction, { content: list });
          }

          case "uma_history": {
            const res = await pool.query(`SELECT * FROM uma_matches WHERE status='closed' ORDER BY created_at DESC LIMIT 10`);
            if (!res.rowCount) return ephemeralReply(interaction, { content: "履歴はまだありません" });
            const list = res.rows.map(r =>
              `ID:${r.id} ${r.title} → 勝者:${r.winner || "未設定"}`
            ).join("\n");
            return ephemeralReply(interaction, { content: list });
          }
        }
      }

      /* ===== モーダル ===== */
      if (interaction.type === InteractionType.ModalSubmit) {
        if (interaction.customId === "uma_create_modal") {
          const title = interaction.fields.getTextInputValue("title").trim();
          const options = interaction.fields.getTextInputValue("options")
            .split(/\n/)
            .map(o => o.trim())
            .filter(Boolean);

          if (options.length < 2)
            return ephemeralReply(interaction, { content: "出走者は2人以上必要です" });

          const res = await pool.query(
            `INSERT INTO uma_matches(host_id, title, options) VALUES($1,$2,$3) RETURNING id`,
            [interaction.user.id, title, options]
          );
          return ephemeralReply(interaction, { content: `UMA作成完了🎉 ID:${res.rows[0].id} ${title}` });
        }
      }
    } catch (e) {
      console.error("UMA error:", e);
    }
  });
}
