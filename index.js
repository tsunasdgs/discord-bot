import Discord from 'discord.js';
import dotenv from 'dotenv';
import http from 'http';
import { initDB } from './db.js';
import * as Coin from './coin.js';
import * as Rumma from './rumma.js';
import { dailyButtons, lummaButtons, adminButtons } from './ui.js';
dotenv.config();

const client = new Discord.Client({ intents:[
  Discord.GatewayIntentBits.Guilds,
  Discord.GatewayIntentBits.GuildMessages,
  Discord.GatewayIntentBits.MessageContent
] });

await initDB();

// ReadyイベントでUI送信
client.once('ready', async ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  if(process.env.DAILY_CHANNEL_ID){
    const ch = await client.channels.fetch(process.env.DAILY_CHANNEL_ID);
    if(ch?.isTextBased()) await ch.send({ content:'💰 デイリー操作', components:[dailyButtons()] });
  }
  if(process.env.RUMMA_CHANNELS){
    const channels = process.env.RUMMA_CHANNELS.split(',').map(c=>c.trim());
    for(const cid of channels){
      const ch = await client.channels.fetch(cid);
      if(ch?.isTextBased()) await ch.send({ content:'🏇 ルムマ操作', components:[lummaButtons()] });
    }
  }
  if(process.env.ADMIN_CHANNEL_ID){
    const ch = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);
    if(ch?.isTextBased()) await ch.send({ content:'⚙ 管理操作', components:[adminButtons()] });
  }
});

// Interaction
client.on('interactionCreate', async interaction=>{
  if(interaction.isButton()){
    await interaction.deferReply({ ephemeral:true });
    switch(interaction.customId){
      case 'daily_claim': await Coin.handleDailyClaim(interaction, Number(process.env.DAILY_AMOUNT)); break;
      case 'check_balance': await Coin.handleCheckBalance(interaction); break;
      case 'check_history': await Coin.handleHistory(interaction); break;
      case 'lumma_create': /* モーダル表示 */ break;
      case 'lumma_list': await Rumma.listRaces(interaction); break;
      case 'lumma_bet': /* モーダル表示 */ break;
      case 'adjust_coins': /* 管理者モーダル */ break;
      case 'history_all': /* 全員履歴 */ break;
    }
  }
});

// HTTPサーバー
http.createServer((req,res)=>{res.writeHead(200);res.end('Bot is running');}).listen(process.env.PORT||10000);

client.login(process.env.DISCORD_TOKEN);
