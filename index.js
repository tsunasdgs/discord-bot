// main_ui_neon_fixed_final.js
import { Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, PermissionsBitField
} from 'discord.js';
import { Pool } from 'pg';
import schedule from 'node-schedule';
import dotenv from 'dotenv';
import http from 'http';
dotenv.config();

// ------------------- Client -------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

// ------------------- Config -------------------
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

// ------------------- Database -------------------
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ------------------- DB初期化 -------------------
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coins (
      user_id TEXT PRIMARY KEY,
      balance INT DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_claims (
      user_id TEXT PRIMARY KEY,
      last_claim DATE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS history (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount INT NOT NULL,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lumma_races (
      id SERIAL PRIMARY KEY,
      channel_id TEXT,
      host_id TEXT,
      race_name TEXT,
      entrants INT,
      bet_coins INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
initDB();

// ------------------- Helper -------------------
async function getUser(userId) {
  const res = await pool.query('SELECT * FROM coins WHERE user_id=$1', [userId]);
  if (!res.rows.length) {
    await pool.query('INSERT INTO coins(user_id) VALUES($1)', [userId]);
    return { user_id: userId, balance: 0 };
  }
  return res.rows[0];
}

async function updateCoins(userId, amount, type='manual', note='') {
  const user = await getUser(userId);
  const newBalance = user.balance + amount;
  await pool.query('UPDATE coins SET balance=$1 WHERE user_id=$2', [newBalance, userId]);
  await pool.query('INSERT INTO history(user_id,type,amount,note) VALUES($1,$2,$3,$4)', [userId,type,amount,note]);
  return newBalance;
}

// ------------------- デイリー報酬リセット -------------------
schedule.scheduleJob('0 5 * * *', async () => {
  await pool.query('UPDATE daily_claims SET last_claim=NULL');
  console.log('デイリー報酬リセット完了');
});

// ------------------- 発言報酬 -------------------
const spamCooldown = {};
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const content = message.content.replace(/\s/g,'');
  if (FORBIDDEN_WORDS.some(f => content.includes(f))) return;

  const now = Date.now();
  if (now - (spamCooldown[message.author.id] || 0) < MESSAGE_COOLDOWN_MS) return;
  spamCooldown[message.author.id] = now;

  const todayCount = await pool.query(
    'SELECT COUNT(*) FROM history WHERE user_id=$1 AND type=$2 AND created_at::date=CURRENT_DATE',
    [message.author.id,'message']
  );
  if (todayCount.rows[0].count >= MESSAGE_LIMIT_NUM) return;

  await updateCoins(message.author.id, MESSAGE_AMOUNT_NUM, 'message', '発言報酬');
});

// ------------------- UI Helper -------------------
const dailyButtons = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('daily').setLabel('デイリー報酬').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId('check_balance').setLabel('所持S確認').setStyle(ButtonStyle.Secondary)
);

const adminButton = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('admin_adjust').setLabel('コイン調整 (管理者)').setStyle(ButtonStyle.Danger)
);

const lummaButton = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('lumma_create').setLabel('ルムマ作成').setStyle(ButtonStyle.Success)
);

const createEmbed = (title, desc, color='Blue') => new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);

// ------------------- Ready -------------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    if (DAILY_CHANNEL_ID) {
      const ch = await client.channels.fetch(DAILY_CHANNEL_ID.trim());
      if(ch?.isTextBased()) await ch.send({ content:'デイリー報酬 & 所持S確認', components:[dailyButtons()] });
    }

    if (ADMIN_CHANNEL_ID) {
      const ch = await client.channels.fetch(ADMIN_CHANNEL_ID.trim());
      if(ch?.isTextBased()) await ch.send({ content:'管理者用コイン操作', components:[adminButton()] });
    }

    for (const cid of ALLOWED_LUMMA_CHANNELS) {
      const ch = await client.channels.fetch(cid);
      if(ch?.isTextBased()) await ch.send({ content:'ルムマ作成', components:[lummaButton()] });
    }
  } catch(e) { console.error('UI送信エラー:', e); }
});

// ------------------- Interaction -------------------
client.on('interactionCreate', async interaction => {
  const userId = interaction.user.id;

  // デイリー
  if(interaction.isButton() && interaction.customId==='daily'){
    if(interaction.channelId !== DAILY_CHANNEL_ID) return interaction.reply({ content:'このチャンネルでは使えません', ephemeral:true });

    const res = await pool.query('SELECT last_claim FROM daily_claims WHERE user_id=$1', [userId]);
    const last = res.rows[0]?.last_claim;
    if(last && new Date(last).toDateString() === new Date().toDateString())
      return interaction.reply({ content:'今日のデイリーは取得済み', ephemeral:true });

    await updateCoins(userId, DAILY_AMOUNT_NUM, 'daily', 'デイリー報酬');
    await pool.query(`
      INSERT INTO daily_claims(user_id,last_claim) VALUES($1,CURRENT_DATE)
      ON CONFLICT (user_id) DO UPDATE SET last_claim=CURRENT_DATE
    `, [userId]);

    return interaction.reply({ embeds:[createEmbed('デイリー取得', `デイリー ${DAILY_AMOUNT_NUM}S 取得!`)], ephemeral:true });
  }

  // 所持S確認
  if(interaction.isButton() && interaction.customId==='check_balance'){
    const user = await getUser(userId);
    return interaction.reply({ embeds:[createEmbed('所持S', `所持S: ${user.balance}S`)], ephemeral:true });
  }

  // 管理者
  if(interaction.isButton() && interaction.customId==='admin_adjust'){
    if(interaction.channelId !== ADMIN_CHANNEL_ID || !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

    const modal = new ModalBuilder()
      .setCustomId('adjust_modal')
      .setTitle('ユーザーコイン調整')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('target_user').setLabel('ユーザーID').setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('amount').setLabel('増減量').setStyle(TextInputStyle.Short).setRequired(true)
        )
      );
    return interaction.showModal(modal);
  }

  if(interaction.isModalSubmit() && interaction.customId==='adjust_modal'){
    const targetId = interaction.fields.getTextInputValue('target_user');
    const amount = parseInt(interaction.fields.getTextInputValue('amount'));
    if(isNaN(amount)) return interaction.reply({ content:'数値を入力してください', ephemeral:true });

    const newBalance = await updateCoins(targetId, amount, 'admin', `管理者操作 by ${userId}`);
    return interaction.reply({ embeds:[createEmbed('コイン調整完了', `ユーザー ${targetId} の所持Sを ${newBalance}S に更新`, 'Green')], ephemeral:true });
  }

  // ルムマ
  if(ALLOWED_LUMMA_CHANNELS.includes(interaction.channelId)){
    if(interaction.isButton() && interaction.customId==='lumma_create'){
      const modal = new ModalBuilder()
        .setCustomId('lumma_create_modal')
        .setTitle('ルムマレース作成')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('race_name').setLabel('レース名').setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('entrants').setLabel('出走人数(2~18)').setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('bet_coins').setLabel('賭けコイン').setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
      return interaction.showModal(modal);
    }

    if(interaction.isModalSubmit() && interaction.customId==='lumma_create_modal'){
      const raceName = interaction.fields.getTextInputValue('race_name');
      const entrants = parseInt(interaction.fields.getTextInputValue('entrants'));
      const betCoins = parseInt(interaction.fields.getTextInputValue('bet_coins'));

      if(isNaN(entrants) || entrants<2 || entrants>18)
        return interaction.reply({ content:'出走人数は2~18人で入力してください', ephemeral:true });
      if(isNaN(betCoins) || betCoins<=0)
        return interaction.reply({ content:'賭けコインは1以上で入力してください', ephemeral:true });

      const user = await getUser(userId);
      if(user.balance < betCoins)
        return interaction.reply({ content:'所持コインが足りません', ephemeral:true });

      await updateCoins(userId, -betCoins, 'lumma', `ルムマ作成: ${raceName} 賭け ${betCoins}S`);
      await pool.query('INSERT INTO lumma_races(channel_id,host_id,race_name,entrants,bet_coins) VALUES($1,$2,$3,$4,$5)',
        [interaction.channelId,userId,raceName,entrants,betCoins]
      );
      return interaction.reply({ embeds:[createEmbed('ルムマ作成完了', `レース "${raceName}" 作成 完了。\n出走人数: ${entrants}\n賭けコイン: ${betCoins}S`, 'Gold')] });
    }
  }
});

// ------------------- HTTP Server -------------------
const PORT = process.env.PORT || 10000;
http.createServer((req,res)=>{
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('Bot is running\n');
}).listen(PORT, ()=>console.log(`HTTP server running on port ${PORT}`));

// ------------------- Login -------------------
client.login(DISCORD_TOKEN);
