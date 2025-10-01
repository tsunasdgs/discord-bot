import { pool, getUser, updateCoins } from './db.js';
import Discord from 'discord.js';

export async function handleDailyClaim(interaction, DAILY_AMOUNT){
  const uid = interaction.user.id;
  const res = await pool.query('SELECT last_claim FROM daily_claims WHERE user_id=$1',[uid]);
  const last = res.rows[0]?.last_claim;
  if(last && new Date(last).toDateString()===new Date().toDateString())
    return interaction.editReply({ embeds:[new Discord.EmbedBuilder().setTitle('通知').setDescription('今日のデイリーは取得済み')] });

  await updateCoins(uid, DAILY_AMOUNT,'daily','デイリー報酬');
  await pool.query(`INSERT INTO daily_claims(user_id,last_claim) VALUES($1,CURRENT_DATE)
    ON CONFLICT (user_id) DO UPDATE SET last_claim=CURRENT_DATE`, [uid]);

  return interaction.editReply({ embeds:[new Discord.EmbedBuilder().setTitle('デイリー取得').setDescription(`デイリー ${DAILY_AMOUNT}S 取得!`).setColor('Green')] });
}

export async function handleCheckBalance(interaction){
  const user = await getUser(interaction.user.id);
  return interaction.editReply({ embeds:[new Discord.EmbedBuilder().setTitle('所持S').addFields({name:'残高',value:`${user.balance}S`,inline:true}).setColor('Gold')] });
}

export async function handleHistory(interaction){
  const res = await pool.query(
    `SELECT * FROM history WHERE user_id=$1 AND created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 20`,
    [interaction.user.id]
  );
  if(!res.rows.length) return interaction.editReply({ embeds:[new Discord.EmbedBuilder().setTitle('履歴').setDescription('過去1週間の取引履歴はありません').setColor('Grey')] });
  const fields = res.rows.map(r => ({ name:`${r.type} (${r.amount>0?'+':''}${r.amount}S)`, value:`${r.note||''} - ${new Date(r.created_at).toLocaleString()}` }));
  return interaction.editReply({ embeds:[new Discord.EmbedBuilder().setTitle('直近の履歴').addFields(fields).setColor('Blue')] });
}
