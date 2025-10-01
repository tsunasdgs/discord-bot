import Discord from 'discord.js';

export const dailyButtons = () => new Discord.ActionRowBuilder().addComponents([
  new Discord.ButtonBuilder().setCustomId('daily_claim').setLabel('💰 デイリー取得').setStyle(Discord.ButtonStyle.Primary),
  new Discord.ButtonBuilder().setCustomId('check_balance').setLabel('📊 残高確認').setStyle(Discord.ButtonStyle.Secondary),
  new Discord.ButtonBuilder().setCustomId('check_history').setLabel('📜 履歴(1週間)').setStyle(Discord.ButtonStyle.Secondary)
]);

export const lummaButtons = () => new Discord.ActionRowBuilder().addComponents([
  new Discord.ButtonBuilder().setCustomId('lumma_create').setLabel('🏇 レース作成').setStyle(Discord.ButtonStyle.Primary),
  new Discord.ButtonBuilder().setCustomId('lumma_list').setLabel('📋 レース一覧').setStyle(Discord.ButtonStyle.Secondary),
  new Discord.ButtonBuilder().setCustomId('lumma_bet').setLabel('🎯 ウマに賭ける').setStyle(Discord.ButtonStyle.Success),
  new Discord.ButtonBuilder().setCustomId('check_balance').setLabel('📊 残高確認').setStyle(Discord.ButtonStyle.Secondary)
]);

export const adminButtons = () => new Discord.ActionRowBuilder().addComponents([
  new Discord.ButtonBuilder().setCustomId('adjust_coins').setLabel('⚙ コイン増減').setStyle(Discord.ButtonStyle.Danger),
  new Discord.ButtonBuilder().setCustomId('history_all').setLabel('📜 全員取引履歴').setStyle(Discord.ButtonStyle.Secondary)
]);
