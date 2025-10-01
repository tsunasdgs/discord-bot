import Discord from 'discord.js';
import dotenv from 'dotenv';
import http from 'http';
import { setupCoin } from './coin.js';
import { setupRumma } from './rumma.js';
import { initDB } from './db.js';
import { dailyButtons, lummaButtons, adminButtons } from './ui.js';

dotenv.config();

const {
  DISCORD_TOKEN,
  DAILY_CHANNEL_ID,
  ADMIN_CHANNEL_ID,
  RUMMA_CHANNELS,
  PORT = 10000
} = process.env;

if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN が設定されていません');

const ALLOWED_RUMMA_CHANNELS = RUMMA_CHANNELS?.split(',').map(c => c.trim()) || [];

const client = new Discord.Client({
  intents: [Discord.GatewayIntentBits.Guilds, Discord.GatewayIntentBits.GuildMessages, Discord.GatewayIntentBits.MessageContent],
  partials: [Discord.Partials.Channel, Discord.Partials.Message],
});

// ---------------- Ready ----------------
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await initDB();

  try {
    // デイリーUI
    if (DAILY_CHANNEL_ID) {
      const ch = await client.channels.fetch(DAILY_CHANNEL_ID);
      if (ch?.isTextBased()) await ch.send({ content:'💰 デイリー操作', components:[dailyButtons()] });
    }

    // ルムマUI
    for (const cid of ALLOWED_RUMMA_CHANNELS) {
      const ch = await client.channels.fetch(cid);
      if (ch?.isTextBased()) await ch.send({ content:'🏇 ルムマ操作', components:[lummaButtons()] });
    }

    // 管理UI
    if (ADMIN_CHANNEL_ID) {
      const ch = await client.channels.fetch(ADMIN_CHANNEL_ID);
      if (ch?.isTextBased()) await ch.send({ content:'⚙ 管理操作', components:[adminButtons()] });
    }
  } catch (e) { console.error('UI送信エラー:', e); }
});

// ---------------- 機能セットアップ ----------------
setupCoin(client);
setupRumma(client);

// ---------------- HTTP Server (Render用) ----------------
http.createServer((req,res)=>{
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end('Bot is running\n');
}).listen(PORT,()=>console.log(`HTTP server running on port ${PORT}`));

client.login(DISCORD_TOKEN);
