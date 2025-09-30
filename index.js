import { query, initDB } from './db.js';
import express from 'express';
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { initDB } from './db.js';
import * as coin from './coin.js';
import * as uma from './uma.js';
import * as gacha from './gacha.js';
import * as rumma from './rumma.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

await initDB();

// Discord イベント
client.on('interactionCreate', async interaction => { /* 省略 */ });
client.on('messageCreate', async message => { /* 省略 */ });

client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));
client.login(process.env.TOKEN);

// Webサーバー起動
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
