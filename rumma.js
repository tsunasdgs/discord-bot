// rumma.js
import { query } from './db.js';

export async function handleCommand(interaction) {
  if (interaction.commandName === 'rumma') {
    return interaction.reply('ルムマ機能はここに統合予定');
  }
}
