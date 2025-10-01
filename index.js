// index.js (ES Module / Render対応版)
import Discord from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;
import schedule from 'node-schedule';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

const {
  DISCORD_TOKEN,
  DAILY_CHANNEL_ID,
  ADMIN_CHANNEL_ID,
  LUMMA_CHANNELS,
  DATABASE_URL,
  DAILY_AMOUNT = 100,
  MESSAGE_AMOUNT = 10,
  MESSAGE_LIMIT = 5
} = process.env;

if (!DISCORD_TOKEN) throw new Error('Discord TOKEN が設定されていません');

const ALLOWED_LUMMA_CHANNELS = LUMMA_CHANNELS?.split(',').map(c => c.trim()) || [];
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
    `CREATE TABLE IF NOT EXISTS history (id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, amount INT NOT NULL, note TEXT, created_at TIMESTAMP DEFAULT NOW());`,
    `CREATE TABLE IF NOT EXISTS lumma_races (id SERIAL PRIMARY KEY, channel_id TEXT, host_id TEXT, race_name TEXT, entrants INT, bet_coins INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`
  ];
  for (const q of tables) await pool.query(q);
}
initDB().catch(console.error);

// ---------------- Helper ----------------
const getUser = async (userId) => {
  const res = await pool.query('SELECT * FROM coins WHERE user_id=$1', [userId]);
  if (!res.rows.length) {
    await pool.query('INSERT INTO coins(user_id) VALUES($1)', [userId]);
    return { user_id: userId, balance: 0 };
  }
  return res.rows[0];
};

const updateCoins = async (userId, amount, type='manual', note='') => {
  const user = await getUser(userId);
  const newBalance = user.balance + amount;
  await pool.query('UPDATE coins SET balance=$1 WHERE user_id=$2', [newBalance, userId]);
  await pool.query('INSERT INTO history(user_id,type,amount,note) VALUES($1,$2,$3,$4)', [userId,type,amount,note]);
  return newBalance;
};

const createEmbed = (title, desc, color='Blue') => new Discord.EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);
const createButtonRow = (buttons) => new Discord.ActionRowBuilder().addComponents(buttons);

// ---------------- Scheduled Tasks ----------------
schedule.scheduleJob('0 5 * * *', async () => {
  await pool.query('UPDATE daily_claims SET last_claim=NULL');
  console.log('デイリー報酬リセット完了');
});

// ---------------- Message Reward ----------------
const spamCooldown = {};
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.replace(/\s/g,'');
  if (FORBIDDEN_WORDS.some(f => content.includes(f))) return;

  const now = Date.now();
  if (now - (spamCooldown[msg.author.id] || 0) < MESSAGE_COOLDOWN_MS) return;
  spamCooldown[msg.author.id] = now;

  const countRes = await pool.query(
    'SELECT COUNT(*) FROM history WHERE user_id=$1 AND type=$2 AND created_at::date=CURRENT_DATE',
    [msg.author.id, 'message']
  );
  if (countRes.rows[0].count >= MESSAGE_LIMIT_NUM) return;

  await updateCoins(msg.author.id, MESSAGE_AMOUNT_NUM, 'message', '発言報酬');
});

// ---------------- UI ----------------
const dailyButtons = () => createButtonRow([
  new Discord.ButtonBuilder().setCustomId('daily').setLabel('デイリー報酬').setStyle(Discord.ButtonStyle.Primary),
  new Discord.ButtonBuilder().setCustomId('check_balance').setLabel('所持S確認').setStyle(Discord.ButtonStyle.Secondary)
]);
const adminButton = () => createButtonRow([
  new Discord.ButtonBuilder().setCustomId('admin_adjust').setLabel('コイン調整 (管理者)').setStyle(Discord.ButtonStyle.Danger)
]);
const lummaButton = () => createButtonRow([
  new Discord.ButtonBuilder().setCustomId('lumma_create').setLabel('ルムマ作成').setStyle(Discord.ButtonStyle.Success)
]);

// ---------------- Ready ----------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    const sendUI = async (chId, content, rowFn) => {
      if (!chId) return;
      const ch = await client.channels.fetch(chId.trim());
      if (ch?.isTextBased()) await ch.send({ content, components:[rowFn()] });
    };
    await sendUI(DAILY_CHANNEL_ID, 'デイリー報酬 & 所持S確認', dailyButtons);
    await sendUI(ADMIN_CHANNEL_ID, '管理者用コイン操作', adminButton);
    for (const cid of ALLOWED_LUMMA_CHANNELS) await sendUI(cid, 'ルムマ作成', lummaButton);
  } catch(e) { console.error('UI送信エラー:', e); }
});

// ---------------- Interaction ----------------
client.on('interactionCreate', async (interaction) => {
  const uid = interaction.user.id;
  const replyEmbed = (title, desc, color='Blue') => interaction.reply({ embeds:[createEmbed(title, desc, color)], ephemeral:true });

  // デイリー取得
  if (interaction.isButton() && interaction.customId==='daily') {
    if(interaction.channelId !== DAILY_CHANNEL_ID) return replyEmbed('エラー','このチャンネルでは使えません','Red');
    const res = await pool.query('SELECT last_claim FROM daily_claims WHERE user_id=$1',[uid]);
    const last = res.rows[0]?.last_claim;
    if(last && new Date(last).toDateString()===new Date().toDateString()) return replyEmbed('通知','今日のデイリーは取得済み');
    await updateCoins(uid, DAILY_AMOUNT_NUM, 'daily','デイリー報酬');
    await pool.query(`INSERT INTO daily_claims(user_id,last_claim) VALUES($1,CURRENT_DATE)
                      ON CONFLICT (user_id) DO UPDATE SET last_claim=CURRENT_DATE`, [uid]);
    return replyEmbed('デイリー取得',`デイリー ${DAILY_AMOUNT_NUM}S 取得!`);
  }

  // 所持S確認
  if(interaction.isButton() && interaction.customId==='check_balance') {
    const user = await getUser(uid);
    return replyEmbed('所持S',`所持S: ${user.balance}S`);
  }

  // 管理者操作
  if(interaction.isButton() && interaction.customId==='admin_adjust') {
    if(interaction.channelId !== ADMIN_CHANNEL_ID || !interaction.member.permissions.has(Discord.PermissionsBitField.Flags.Administrator)) return;
    const modal = new Discord.ModalBuilder()
      .setCustomId('adjust_modal').setTitle('ユーザーコイン調整')
      .addComponents(
        createButtonRow([ new Discord.TextInputBuilder().setCustomId('target_user').setLabel('ユーザーID').setStyle(Discord.TextInputStyle.Short).setRequired(true) ]),
        createButtonRow([ new Discord.TextInputBuilder().setCustomId('amount').setLabel('増減量').setStyle(Discord.TextInputStyle.Short).setRequired(true) ])
      );
    return interaction.showModal(modal);
  }

  if(interaction.isModalSubmit() && interaction.customId==='adjust_modal'){
    const targetId = interaction.fields.getTextInputValue('target_user');
    const amount = parseInt(interaction.fields.getTextInputValue('amount'));
    if(isNaN(amount)) return replyEmbed('エラー','数値を入力してください','Red');
    const newBal = await updateCoins(targetId, amount, 'admin', `管理者操作 by ${uid}`);
    return replyEmbed('コイン調整完了',`ユーザー ${targetId} の所持Sを ${newBal}S に更新`,'Green');
  }

  // ルムマ作成
  if(ALLOWED_LUMMA_CHANNELS.includes(interaction.channelId)){
    if(interaction.isButton() && interaction.customId==='lumma_create'){
      const modal = new Discord.ModalBuilder()
        .setCustomId('lumma_create_modal').setTitle('ルムマレース作成')
        .addComponents(
          createButtonRow([ new Discord.TextInputBuilder().setCustomId('race_name').setLabel('レース名').setStyle(Discord.TextInputStyle.Short).setRequired(true) ]),
          createButtonRow([ new Discord.TextInputBuilder().setCustomId('entrants').setLabel('出走人数(2~18)').setStyle(Discord.TextInputStyle.Short).setRequired(true) ]),
          createButtonRow([ new Discord.TextInputBuilder().setCustomId('bet_coins').setLabel('賭けコイン').setStyle(Discord.TextInputStyle.Short).setRequired(true) ])
        );
      return interaction.showModal(modal);
    }

    if(interaction.isModalSubmit() && interaction.customId==='lumma_create_modal'){
      const raceName = interaction.fields.getTextInputValue('race_name');
      const entrants = parseInt(interaction.fields.getTextInputValue('entrants'));
      const betCoins = parseInt(interaction.fields.getTextInputValue('bet_coins'));
      if(isNaN(entrants) || entrants<2 || entrants>18) return replyEmbed('エラー','出走人数は2~18人で入力してください','Red');
      if(isNaN(betCoins) || betCoins<=0) return replyEmbed('エラー','賭けコインは1以上で入力してください','Red');
      const user = await getUser(uid);
      if(user.balance < betCoins) return replyEmbed('エラー','所持コインが足りません','Red');

      await updateCoins(uid,-betCoins,'lumma',`ルムマ作成: ${raceName} 賭け ${betCoins}S`);
      await pool.query('INSERT INTO lumma_races(channel_id,host_id,race_name,entrants,bet_coins) VALUES($1,$2,$3,$4,$5)',
        [interaction.channelId, uid, raceName, entrants, betCoins]
      );
      return replyEmbed('ルムマ作成完了',`レース "${raceName}" 作成 完了。\n出走人数: ${entrants}\n賭けコイン: ${betCoins}S`,'Gold');
    }
  }
});

// ---------------- HTTP Server ----------------
const PORT = process.env.PORT || 10000;
http.createServer((req,res)=>{
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end('Bot is running\n');
}).listen(PORT,()=>console.log(`HTTP server running on port ${PORT}`));

// ---------------- Login ----------------
client.login(DISCORD_TOKEN);
