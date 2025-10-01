import Discord from 'discord.js';
import dotenv from 'dotenv';
import http from 'http';
import { initDB } from './db.js';
import * as Coin from './coin.js';
import * as Rumma from './rumma.js';
import { dailyButtons, lummaButtons, adminButtons } from './ui.js';

dotenv.config();

const client = new Discord.Client({
  intents: [Discord.GatewayIntentBits.Guilds, Discord.GatewayIntentBits.GuildMessages, Discord.GatewayIntentBits.MessageContent]
});

const { DAILY_CHANNEL_ID, ADMIN_CHANNEL_ID, RUMMA_CHANNELS, PORT=10000 } = process.env;
const ALLOWED_RUMMA_CHANNELS = RUMMA_CHANNELS?.split(',').map(c=>c.trim()) || [];

client.once('ready', async ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  await initDB();

  if(DAILY_CHANNEL_ID){
    const ch = await client.channels.fetch(DAILY_CHANNEL_ID);
    if(ch?.isTextBased()) await ch.send({ content:'💰 デイリー操作', components:[dailyButtons()] });
  }

  for(const cid of ALLOWED_RUMMA_CHANNELS){
    const ch = await client.channels.fetch(cid);
    if(ch?.isTextBased()) await ch.send({ content:'🏇 ルムマ操作', components:[lummaButtons()] });
  }

  if(ADMIN_CHANNEL_ID){
    const ch = await client.channels.fetch(ADMIN_CHANNEL_ID);
    if(ch?.isTextBased()) await ch.send({ content:'⚙ 管理操作', components:[adminButtons()] });
  }
});

client.on('interactionCreate', async interaction=>{
  try{
    if(interaction.isButton()){
      const cid = interaction.customId;
      if(cid==='daily_claim') return Coin.handleDaily(interaction, Number(process.env.DAILY_AMOUNT || 100));
      if(cid==='check_balance') return Coin.handleCheckBalance(interaction);
      if(cid==='check_history') return Coin.handleCheckHistory(interaction);
      if(['lumma_create','lumma_list','lumma_bet'].includes(cid)) return Rumma.handleLummaButton(interaction);
    }

    if(interaction.isModalSubmit()){
      // モーダル送信処理も同様に安全に deferReply + DB操作
    }

  }catch(e){
    console.error('interaction error:', e);
    if(!interaction.replied) await interaction.reply({ embeds:[Coin.createEmbed('エラー','内部エラー','Red')], flags: Discord.MessageFlags.Ephemeral });
  }
});

http.createServer((req,res)=>{
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end('Bot is running\n');
}).listen(PORT,()=>console.log(`HTTP server running on port ${PORT}`));

client.login(process.env.DISCORD_TOKEN);
