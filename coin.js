import Discord from 'discord.js';
import { pool, getUser, updateCoins } from './db.js';
import { createEmbed, createFieldEmbed } from './ui.js';

const { DAILY_AMOUNT = 100, MESSAGE_AMOUNT = 10, MESSAGE_LIMIT = 5 } = process.env;
const DAILY_AMOUNT_NUM = Number(DAILY_AMOUNT);

export function setupCoin(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    const uid = interaction.user.id;

    try {
      if (interaction.customId === 'daily_claim') {
        const res = await pool.query('SELECT last_claim FROM daily_claims WHERE user_id=$1',[uid]);
        const last = res.rows[0]?.last_claim;

        if (last && new Date(last).toDateString()===new Date().toDateString())
          return interaction.reply({ embeds:[createEmbed('通知','今日のデイリーは取得済み')], flags: Discord.MessageFlags.Ephemeral });

        await updateCoins(uid, DAILY_AMOUNT_NUM, 'daily', 'デイリー報酬');
        await pool.query(
          `INSERT INTO daily_claims(user_id,last_claim) VALUES($1,CURRENT_DATE)
           ON CONFLICT (user_id) DO UPDATE SET last_claim=CURRENT_DATE`,
          [uid]
        );

        return interaction.reply({ embeds:[createEmbed('デイリー取得',`${DAILY_AMOUNT_NUM}S 取得!`,'Green')], flags: Discord.MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'check_balance') {
        const user = await getUser(uid);
        return interaction.reply({ embeds:[createFieldEmbed('所持S',[{name:'残高',value:`${user.balance}S`}],'Gold')], flags: Discord.MessageFlags.Ephemeral });
      }
    } catch (e) { console.error('coin error:', e); }
  });
}
