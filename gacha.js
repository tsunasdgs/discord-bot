// gacha.js
import { query } from './db.js';

export async function handleCommand(interaction) {
  // 簡易サンプル: /gacha
  if (interaction.commandName === 'gacha') {
    const items = await query('SELECT * FROM gacha_items ORDER BY RANDOM() LIMIT 1');
    if (items.rows.length) {
      return interaction.reply(`ガチャ結果: ${items.rows[0].name} (${items.rows[0].rarity})`);
    }
    return interaction.reply('ガチャアイテムがありません');
  }
}
