import Discord from 'discord.js';
import { pool } from './db.js';
import { createEmbed, createFieldEmbed } from './ui.js';

export function setupRumma(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    try {
      if (interaction.customId === 'lumma_create') {
        const modal = new Discord.ModalBuilder()
          .setCustomId('lumma_create_modal')
          .setTitle('ルムマ作成')
          .addComponents(
            new Discord.ActionRowBuilder().addComponents(
              new Discord.TextInputBuilder().setCustomId('race_name').setLabel('レース名').setStyle(Discord.TextInputStyle.Short).setRequired(true)
            ),
            new Discord.ActionRowBuilder().addComponents(
              new Discord.TextInputBuilder().setCustomId('horses').setLabel('ウマ名(カンマ区切り)').setStyle(Discord.TextInputStyle.Paragraph).setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'lumma_list') {
        const res = await pool.query('SELECT * FROM lumma_races WHERE is_closed=false ORDER BY created_at DESC LIMIT 10');
        if (!res.rows.length)
          return interaction.reply({ embeds:[createEmbed('レース一覧','現在開催中はありません','Grey')], flags: Discord.MessageFlags.Ephemeral });

        const fields = res.rows.map(r=>({name:r.race_name,value:`ホスト:<@${r.host_id}> 出走:${r.horses.join(',')}`}));
        return interaction.reply({ embeds:[createFieldEmbed('開催中レース', fields,'Blue')], flags: Discord.MessageFlags.Ephemeral });
      }
    } catch (e) { console.error('rumma error:', e); }
  });
}
