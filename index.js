// index.js
import 'dotenv/config';
import express from 'express';
import { 
  Client, GatewayIntentBits, 
  ActionRowBuilder, ButtonBuilder, ButtonStyle, 
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle 
} from 'discord.js';
import schedule from 'node-schedule';
import * as coin from './coin.js';
import * as uma from './uma.js';
import * as gacha from './gacha.js';
import * as rumma from './rumma.js';

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ----- デイリーリセット（朝5時） -----
schedule.scheduleJob('0 5 * * *', async () => {
  await coin.resetDaily();
  console.log('デイリー報酬リセット完了');
});

// ----- Bot Ready -----
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const DAILY_CHANNEL_ID = process.env.DAILY_CHANNEL_ID;
  const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID;

  // デイリー用メッセージ
  const dailyChannel = await client.channels.fetch(DAILY_CHANNEL_ID);
  if (dailyChannel?.isTextBased()) {
    const embed = new EmbedBuilder()
      .setTitle('デイリー報酬')
      .setDescription(`ボタンを押して本日のデイリー報酬を取得！\n報酬: ${process.env.DAILY_AMOUNT}S`)
      .setColor('Green');

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId('daily').setLabel('デイリー取得').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('check_balance').setLabel('所持S確認').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('view_ranking').setLabel('ランキング').setStyle(ButtonStyle.Secondary)
      );

    await dailyChannel.send({ embeds: [embed], components: [row] });
  }

  // 管理者用メッセージ
  const adminChannel = await client.channels.fetch(ADMIN_CHANNEL_ID);
  if (adminChannel?.isTextBased()) {
    const adminEmbed = new EmbedBuilder()
      .setTitle('管理者コイン操作')
      .setDescription('ユーザーのコイン増減や取引履歴確認が可能です。')
      .setColor('Red');

    const adminRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId('admin_adjust').setLabel('コイン増減').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('view_history').setLabel('取引履歴確認').setStyle(ButtonStyle.Secondary)
      );

    await adminChannel.send({ embeds: [adminEmbed], components: [adminRow] });
  }
});

// ----- インタラクション -----
client.on('interactionCreate', async interaction => {
  const DAILY_CHANNEL_ID = process.env.DAILY_CHANNEL_ID;
  const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID;

  try {
    // デイリー
    if (interaction.isButton() && interaction.customId === 'daily') {
      if (interaction.channelId !== DAILY_CHANNEL_ID) {
        return safeReply(interaction, 'このチャンネルでは使用できません', true, 5);
      }
      const claimed = await coin.claimDaily(interaction.user.id);
      const message = claimed 
        ? `デイリー取得: ${process.env.DAILY_AMOUNT}S` 
        : '今日のデイリーは取得済み';
      return safeReply(interaction, message, false, 5);
    }

    // 残高確認
    if (interaction.isButton() && interaction.customId === 'check_balance') {
      const bal = await coin.getBalance(interaction.user.id);
      return safeReply(interaction, `あなたの所持S: ${bal}S`, false, 5);
    }

    // ランキング
    if (interaction.isButton() && interaction.customId === 'view_ranking') {
      const top = await coin.getTop();
      const embed = new EmbedBuilder()
        .setTitle('コインランキング（上位10名）')
        .setColor('Gold')
        .setDescription(top.map((r,i)=>`${i+1}. <@${r.user_id}> - ${r.balance}S`).join('\n'));
      return safeReply(interaction, embed, false, 5);
    }

    // 管理者操作
    if (interaction.isButton() && interaction.customId === 'admin_adjust') {
      if (interaction.channelId !== ADMIN_CHANNEL_ID || !interaction.member.permissions.has('Administrator')) return;

      const modal = new ModalBuilder()
        .setCustomId('adjust_modal')
        .setTitle('ユーザーコイン調整')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('target_user').setLabel('ユーザーID').setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('amount').setLabel('増減量（例:+100 / -50）').setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
      return interaction.showModal(modal);
    }

    // モーダル提出
    if (interaction.isModalSubmit() && interaction.customId === 'adjust_modal') {
      const targetId = interaction.fields.getTextInputValue('target_user');
      const amount = parseInt(interaction.fields.getTextInputValue('amount'));
      if (isNaN(amount)) return safeReply(interaction, '数値を入力してください', true, 5);

      await coin.updateCoins(targetId, amount, 'admin', `管理者操作 by ${interaction.user.id}`);
      return safeReply(interaction, `ユーザー ${targetId} の所持Sを更新しました`, false, 5);
    }

    // 取引履歴
    if (interaction.isButton() && interaction.customId === 'view_history') {
      const rows = await coin.getHistory();
      const embed = new EmbedBuilder()
        .setTitle('最近の取引履歴（最新10件）')
        .setColor('Blue')
        .setDescription(rows.map(r=>`[${r.created_at.toISOString()}] ${r.user_id} ${r.type} ${r.amount}S - ${r.note}`).join('\n'));
      return safeReply(interaction, embed, false, 5);
    }

    // UMA / ガチャ / ルムマ
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName.startsWith('uma')) await uma.handleCommand(interaction);
      if (interaction.commandName.startsWith('gacha')) await gacha.handleCommand(interaction);
      if (interaction.commandName.startsWith('rumma')) await rumma.handleCommand(interaction);
    }

  } catch (err) {
    console.error("インタラクション処理中エラー:", err);
    if (interaction.isRepliable()) safeReply(interaction, 'エラーが発生しました', true, 5);
  }
});

// ----- 発言報酬 -----
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!await coin.canRewardMessage(message.author.id, message.content)) return;
  await coin.rewardMessage(message.author.id);
});

// ----- 安全なreply関数 -----
// deleteAfterSec: 秒後に自動削除（0 または未指定で削除なし）
async function safeReply(interaction, contentOrEmbed, ephemeral = false, deleteAfterSec = 0) {
  try {
    let sentMessage;

    if (interaction.replied || interaction.deferred) {
      if (contentOrEmbed instanceof EmbedBuilder) {
        sentMessage = await interaction.editReply({ embeds: [contentOrEmbed] });
      } else {
        sentMessage = await interaction.editReply({ content: contentOrEmbed });
      }
    } else {
      if (contentOrEmbed instanceof EmbedBuilder) {
        sentMessage = await interaction.reply({ embeds: [contentOrEmbed], ephemeral, fetchReply: !ephemeral });
      } else {
        sentMessage = await interaction.reply({ content: contentOrEmbed, ephemeral, fetchReply: !ephemeral });
      }
    }

    if (!ephemeral && deleteAfterSec > 0 && sentMessage) {
      setTimeout(async () => {
        try { await sentMessage.delete(); } catch(err) {}
      }, deleteAfterSec * 1000);
    }

  } catch(err) {
    console.error('safeReply失敗:', err);
  }
}

client.login(process.env.TOKEN);
