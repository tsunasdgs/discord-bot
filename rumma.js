import { pool } from './db.js';
import { createEmbed, createFieldEmbed, lummaButtons } from './ui.js';
import Discord from 'discord.js';

export async function handleLummaButton(interaction){
  await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });
  const { customId } = interaction;

  if(customId==='lumma_create'){
    const modal = new Discord.ModalBuilder()
      .setCustomId('lumma_create_modal')
      .setTitle('ルムマ作成')
      .addComponents(
        new Discord.ActionRowBuilder().addComponents(
          new Discord.TextInputBuilder().setCustomId('race_name').setLabel('レース名').setStyle(Discord.TextInputStyle.Short).setRequired(true)
        ),
        new Discord.ActionRowBuilder().addComponents(
          new Discord.TextInputBuilder().setCustomId('horses').setLabel('ウマ名をカンマ区切りで入力 (2-18頭)').setStyle(Discord.TextInputStyle.Paragraph).setRequired(true)
        )
      );
    return interaction.showModal(modal);
  }

  if(customId==='lumma_list'){
    const res = await pool.query('SELECT * FROM lumma_races WHERE is_closed=false ORDER BY created_at DESC LIMIT 10');
    if(!res.rows.length) return interaction.editReply({ embeds:[createEmbed('レース一覧','現在開催中のレースはありません','Grey')] });
    const fields = res.rows.map(r => ({ name: r.race_name, value:`ホスト: <@${r.host_id}>, 出走ウマ: ${r.horses.join(', ')}` }));
    return interaction.editReply({ embeds:[createFieldEmbed('開催中レース', fields,'Blue')] });
  }

  if(customId==='lumma_bet'){
    const modal = new Discord.ModalBuilder()
      .setCustomId('lumma_bet_modal')
      .setTitle('ウマに賭ける')
      .addComponents(
        new Discord.ActionRowBuilder().addComponents(
          new Discord.TextInputBuilder().setCustomId('race_id').setLabel('レースID').setStyle(Discord.TextInputStyle.Short).setRequired(true)
        ),
        new Discord.ActionRowBuilder().addComponents(
          new Discord.TextInputBuilder().setCustomId('horse_name').setLabel('ウマ名').setStyle(Discord.TextInputStyle.Short).setRequired(true)
        ),
        new Discord.ActionRowBuilder().addComponents(
          new Discord.TextInputBuilder().setCustomId('bet_amount').setLabel('賭け金').setStyle(Discord.TextInputStyle.Short).setRequired(true)
        )
      );
    return interaction.showModal(modal);
  }
}
