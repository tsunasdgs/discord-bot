import { query } from './db.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const handleCommand = async (interaction) => {
  if (interaction.commandName === 'uma_create') {
    const name = interaction.options.getString('name');
    const icon = interaction.options.getString('icon') || '🐎';
    const exists = await query('SELECT * FROM umas WHERE user_id=$1', [interaction.user.id]);
    if (exists.rows.length > 0) return interaction.reply({ content:'すでにUMAを持っています', ephemeral:true});
    await query('INSERT INTO umas(user_id,name,icon) VALUES($1,$2,$3)', [interaction.user.id,name,icon]);
    const embed = new EmbedBuilder().setTitle('UMA作成完了').setDescription(`${icon} あなたのUMA「${name}」が誕生しました`).setColor('Green');
    return interaction.reply({ embeds:[embed] });
  }
  if (interaction.commandName === 'uma_status') {
    const res = await query('SELECT * FROM umas WHERE user_id=$1', [interaction.user.id]);
    if (res.rows.length===0) return interaction.reply({ content:'UMA未作成', ephemeral:true });
    const uma = res.rows[0];
    const embed = new EmbedBuilder().setTitle(`${uma.icon} ${uma.name} のステータス`)
      .addFields({ name:'速度', value:`${uma.speed}`, inline:true },
                 { name:'スタミナ', value:`${uma.stamina}`, inline:true },
                 { name:'運', value:`${uma.luck}`, inline:true })
      .setColor('Blue');
    return interaction.reply({ embeds:[embed] });
  }
};
