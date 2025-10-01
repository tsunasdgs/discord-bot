import Discord from 'discord.js';
import pkg from 'pg';
import schedule from 'node-schedule';
import dotenv from 'dotenv';
import http from 'http';

const { Pool } = pkg;
dotenv.config();

const {
  DISCORD_TOKEN,
  DATABASE_URL,
  DAILY_CHANNEL_ID,
  ADMIN_CHANNEL_ID,
  RUMMA_CHANNELS,
  ALLOWED_ROLE_IDS,
  DAILY_AMOUNT = 100,
  MESSAGE_AMOUNT = 10,
  MESSAGE_LIMIT = 5,
  PORT = 10000
} = process.env;

if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN が設定されていません');

const ALLOWED_LUMMA_CHANNELS = RUMMA_CHANNELS?.split(',').map(c=>c.trim()) || [];
const ALLOWED_ROLES = ALLOWED_ROLE_IDS?.split(',').map(r=>r.trim()) || [];
const DAILY_AMOUNT_NUM = Number(DAILY_AMOUNT);
const MESSAGE_AMOUNT_NUM = Number(MESSAGE_AMOUNT);
const MESSAGE_LIMIT_NUM = Number(MESSAGE_LIMIT);

const FORBIDDEN_WORDS = ['ああ','いい','AA'];
const MESSAGE_COOLDOWN_MS = 60000;

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const client = new Discord.Client({
  intents: [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMessages,
    Discord.GatewayIntentBits.MessageContent,
  ],
  partials: [Discord.Partials.Channel, Discord.Partials.Message],
});

// ---------------- DB初期化 ----------------
async function initDB() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS coins (user_id TEXT PRIMARY KEY, balance INT DEFAULT 0);`,
    `CREATE TABLE IF NOT EXISTS daily_claims (user_id TEXT PRIMARY KEY, last_claim DATE);`,
    `CREATE TABLE IF NOT EXISTS history (
      id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
      amount INT NOT NULL, note TEXT, created_at TIMESTAMP DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS lumma_races (
      id SERIAL PRIMARY KEY, channel_id TEXT, host_id TEXT, race_name TEXT,
      entrants INT, horses TEXT[], created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_closed BOOLEAN DEFAULT FALSE, winner TEXT
    );`,
    `CREATE TABLE IF NOT EXISTS lumma_bets (
      id SERIAL PRIMARY KEY, race_id INT, user_id TEXT, horse_name TEXT, bet_amount INT
    );`
  ];
  for(const q of tables) await pool.query(q);
}
initDB().catch(console.error);

// ---------------- Helper ----------------
const getUser = async (userId) => {
  const res = await pool.query('SELECT * FROM coins WHERE user_id=$1',[userId]);
  if(!res.rows.length){
    await pool.query('INSERT INTO coins(user_id) VALUES($1)',[userId]);
    return { user_id: userId, balance:0 };
  }
  return res.rows[0];
};

const updateCoins = async (userId, amount, type='manual', note='') => {
  const user = await getUser(userId);
  const newBalance = user.balance + amount;
  await pool.query('UPDATE coins SET balance=$1 WHERE user_id=$2',[newBalance,userId]);
  await pool.query('INSERT INTO history(user_id,type,amount,note) VALUES($1,$2,$3,$4)',[userId,type,amount,note]);
  return newBalance;
};

const createEmbed = (title, desc, color='Blue') =>
  new Discord.EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);

const createFieldEmbed = (title, fields, color='Blue') =>
  new Discord.EmbedBuilder().setTitle(title).addFields(fields).setColor(color);

const createRow = (components) => new Discord.ActionRowBuilder().addComponents(components);

const checkRole = async (member) => {
  if(!ALLOWED_ROLES.length) return true;
  return member.roles.cache.some(r=>ALLOWED_ROLES.includes(r.id));
};

// ---------------- Scheduled Tasks ----------------
schedule.scheduleJob('0 5 * * *', async () => {
  await pool.query('UPDATE daily_claims SET last_claim=NULL');
  console.log('デイリー報酬リセット完了');
});

// ---------------- Message Reward ----------------
const spamCooldown = {};
client.on('messageCreate', async (msg) => {
  if(msg.author.bot) return;
  const content = msg.content.replace(/\s/g,'');
  if(FORBIDDEN_WORDS.some(f=>content.includes(f))) return;

  const now = Date.now();
  if(now - (spamCooldown[msg.author.id]||0) < MESSAGE_COOLDOWN_MS) return;
  spamCooldown[msg.author.id] = now;

  const countRes = await pool.query(
    'SELECT COUNT(*) FROM history WHERE user_id=$1 AND type=$2 AND created_at::date=CURRENT_DATE',
    [msg.author.id,'message']
  );
  if(countRes.rows[0].count >= MESSAGE_LIMIT_NUM) return;

  await updateCoins(msg.author.id, MESSAGE_AMOUNT_NUM,'message','発言報酬');
});

// ---------------- ルムマ Helper ----------------
const payWinners = async (raceId, winnerHorse) => {
  const betsRes = await pool.query('SELECT * FROM lumma_bets WHERE race_id=$1',[raceId]);
  const totalPool = betsRes.rows.reduce((sum,row)=> sum+row.bet_amount,0);
  const winnerBets = betsRes.rows.filter(b=>b.horse_name===winnerHorse);
  const totalWinnerBets = winnerBets.reduce((sum,row)=> sum+row.bet_amount,0);

  for(const bet of winnerBets){
    const payout = Math.floor(bet.bet_amount / totalWinnerBets * totalPool);
    await updateCoins(bet.user_id,payout,'lumma_win',`ルムマ勝利: ${winnerHorse} (${payout}S)`);
  }
  await pool.query('UPDATE lumma_races SET is_closed=true, winner=$1 WHERE id=$2',[winnerHorse,raceId]);
};

// ---------------- UI ----------------
const dailyButton = new Discord.ActionRowBuilder().addComponents(
  new Discord.ButtonBuilder()
    .setCustomId('daily_claim')
    .setLabel('💰 デイリー報酬取得')
    .setStyle(Discord.ButtonStyle.Primary)
);

const mainMenu = () => new Discord.ActionRowBuilder().addComponents(
  new Discord.StringSelectMenuBuilder()
    .setCustomId('main_menu')
    .setPlaceholder('操作を選択してください')
    .addOptions([
      { label:'📊 所持S確認', value:'check_balance' },
      { label:'📜 取引履歴確認(1週間)', value:'check_history' },
      { label:'🏇 ルムマ作成', value:'lumma_create' },
      { label:'📋 ルムマ一覧', value:'lumma_list' },
      { label:'🎯 馬に賭ける', value:'lumma_bet' },
      { label:'🏆 勝者報告', value:'lumma_close' },
      { label:'🎫 自分の賭け状況', value:'lumma_my_bets' },
      { label:'🏆 所持Sランキング', value:'ranking' },
      { label:'⚙ 管理UI', value:'admin_ui' },
    ])
);

// ---------------- Ready ----------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    // デイリーチャンネルにデイリー + メニュー
    if (DAILY_CHANNEL_ID) {
      const ch = await client.channels.fetch(DAILY_CHANNEL_ID);
      if(ch?.isTextBased()) {
        await ch.send({ content:'💰 デイリー報酬はこちら', components:[dailyButton, mainMenu()] });
      }
    }

    // ルムマチャンネルにメインメニュー
    for(const cid of ALLOWED_LUMMA_CHANNELS){
      const ch = await client.channels.fetch(cid);
      if(ch?.isTextBased()){
        await ch.send({ content:'🏇 ルムマ操作はこちら', components:[mainMenu()] });
      }
    }

    // 管理UI
    if(ADMIN_CHANNEL_ID){
      const ch = await client.channels.fetch(ADMIN_CHANNEL_ID);
      if(ch?.isTextBased()){
        await ch.send({ content:'⚙ 管理用メニュー', components:[mainMenu()] });
      }
    }

  } catch(e){ console.error('UI送信エラー:',e); }
});

// ---------------- 安全な replyEmbed ----------------
const replyEmbed = async (interaction, emb) => {
  try {
    if(interaction.deferred || interaction.replied){
      await interaction.editReply({ embeds:[emb] }).catch(()=>{});
    } else {
      await interaction.reply({ embeds:[emb], flags: Discord.MessageFlags.Ephemeral }).catch(()=>{});
    }
  } catch {}
};

// ---------------- HTTP Server ----------------
http.createServer((req,res)=>{
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end('Bot is running\n');
}).listen(PORT,()=>console.log(`HTTP server running on port ${PORT}`));

// ---------------- Login ----------------
client.login(DISCORD_TOKEN);
