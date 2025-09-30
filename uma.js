// uma.js
import { query } from './db.js';

export async function handleCommand(interaction) {
  // 簡易サンプル: /uma status
  if (interaction.commandName === 'uma') {
    const res = await query('SELECT * FROM umas WHERE user_id=$1', [interaction.user.id]);
    if (!res.rows.length) {
      await query('INSERT INTO umas(user_id,name) VALUES($1,$2)', [interaction.user.id, 'NoNameUMA']);
      return interaction.reply('UMAを作成しました！');
    } else {
      const umaData = res.rows[0];
      return interaction.reply(`UMA情報: ${umaData.name}`);
    }
  }
}
