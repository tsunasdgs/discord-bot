import { pool, getUser, updateCoins } from './db.js';
import { createEmbed, createFieldEmbed } from './ui.js';
import Discord from 'discord.js';

export async function handleDaily(interaction, amount){
  const uid = interaction.user.id;
  if(!interaction.deferred && !interaction.replied){
    await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });
  }

  const res = await pool.query('SELECT last_claim FROM daily_claims WHERE user_id=$1',[uid]);
  const last = res.rows[0]?.last_claim;
  const today = new Date().toISOString().split('T')[0];

  if(last === today){
    return interaction.editReply({ embeds:[createEmbed('通知','今日のデイリーは取得済み','Grey')] });
  }

  try{
    await pool.query('BEGIN');
    await pool.query(`
      INSERT INTO coins(user_id,balance) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET balance=coins.balance+$2
    `,[uid, amount]);
    await pool.query(`
      INSERT INTO history(user_id,type,amount,note) VALUES($1,'daily',$2,'デイリー報酬')
    `,[uid, amount]);
    await pool.query(`
      INSERT INTO daily_claims(user_id,last_claim) VALUES($1,CURRENT_DATE)
      ON CONFLICT(user_id) DO UPDATE SET last_claim=CURRENT_DATE
    `,[uid]);
    await pool.query('COMMIT');
    return interaction.editReply({ embeds:[createEmbed('デイリー取得',`デイリー ${amount}S 取得!`,'Green')] });
  }catch(e){
    await pool.query('ROLLBACK');
    console.error(e);
    return interaction.editReply({ embeds:[createEmbed('エラー','デイリー取得に失敗しました','Red')] });
  }
}

export async function handleCheckBalance(interaction){
  const user = await getUser(interaction.user.id);
  return interaction.editReply({ embeds:[createFieldEmbed('所持S', [{ name:'残高', value:`${user.balance}S`, inline:true }],'Gold')] });
}

export async function handleCheckHistory(interaction){
  const res = await pool.query(
    `SELECT * FROM history WHERE user_id=$1 AND created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 20`,
    [interaction.user.id]
  );
  if(!res.rows.length) return interaction.editReply({ embeds:[createEmbed('履歴','過去1週間の取引履歴はありません','Grey')] });
  const fields = res.rows.map(r => ({ name: `${r.type} (${r.amount>0?'+':''}${r.amount}S)`, value: `${r.note||''} - ${new Date(r.created_at).toLocaleString()}` }));
  return interaction.editReply({ embeds:[createFieldEmbed('直近の履歴', fields,'Blue')] });
}
