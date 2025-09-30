import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits } from 'discord.js';
import { query, initDB } from './db.js';
import * as coin from './coin.js';
import * as uma from './uma.js';
import * as gacha from './gacha.js';
import * as rumma from './rumma.js';

const app = express();
const PORT = process.env.PORT || 3000;

// WebService 用: Render がポートを監視
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

// Discord Bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// DB 初期化
await initDB();

// スラッシュコマンド・ボタン・メッセージ報酬
client.on('interactionCreate', async interaction => {
  // デイリー報酬ボタン
  if (interaction.isButton() && interaction.customId === 'daily') {
    const claimed = await coin.claimDaily(interaction.user.id);
    await interaction.reply({ content: claimed ? 'デイリー取得: 100S' : '今日のデイリーは取得済み', ephemeral:true });
  }

  // スラッシュコマンド
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName.startsWith('uma')) await uma.handleCommand(interaction);
    if (interaction.commandName.startsWith('gacha')) await gacha.handleCommand(interaction);
    if (interaction.commandName.startsWith('rumma')) await rumma.handleCommand(interaction);
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!coin.canRewardMessage(message.author.id)) return;
  await coin.updateCoins(message.author.id,10,'message','発言報酬');
});

client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.TOKEN);
