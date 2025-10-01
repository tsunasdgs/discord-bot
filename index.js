import Discord from 'discord.js';
import pkg from 'pg';
import schedule from 'node-schedule';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();
const { Pool } = pkg;

const {
  DISCORD_TOKEN,
  DATABASE_URL,
  DAILY_CHANNEL_ID,
  ADMIN_CHANNEL_ID,
  RUMMA_CHANNELS,
  DAILY_AMOUNT = 100,
  MESSAGE_AMOUNT = 10,
  MESSAGE_LIMIT = 5,
  PORT = 10000
} = process.env;

if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN が設定されていません');

const ALLOWED_RUMMA_CHANNELS = RUMMA_CHANNELS?.split(',').map(c => c.trim()) || [];
const DAILY_AMOUNT_NUM = Number(DAILY_AMOUNT);
const MESSAGE_AMOUNT_NUM = Number(MESSAGE_AMOUNT);
const MESSAGE_LIMIT_NUM = Number(MESSAGE_LIMIT);
const MESSAGE_COOLDOWN_MS = 60000;
const FORBIDDEN_WORDS = ['ああ','いい','AA'];

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
      horses TEXT[], created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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

// ---------------- Embeds / UI ----------------
const createEmbed = (title, desc, color='Blue') => new Discord.EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);
const createFieldEmbed = (title, fields, color='Blue') => new Discord.EmbedBuilder().setTitle(title).addFields(fields).setColor(color);

const dailyButtons = () => new Discord.ActionRowBuilder().addComponents([
  new Discord.ButtonBuilder().setCustomId('daily_claim').setLabel('💰 デイリー取得').setStyle(Discord.ButtonStyle.Primary),
  new Discord.ButtonBuilder().setCustomId('check_balance').setLabel('📊 残高確認').setStyle(Discord.ButtonStyle.Secondary),
  new Discord.ButtonBuilder().setCustomId('check_history').setLabel('📜 履歴(1週間)').setStyle(Discord.ButtonStyle.Secondary)
]);

const lummaButtons = () => new Discord.ActionRowBuilder().addComponents([
  new Discord.ButtonBuilder().setCustomId('lumma_create').setLabel('🏇 レース作成').setStyle(Discord.ButtonStyle.Primary),
  new Discord.ButtonBuilder().setCustomId('lumma_list').setLabel('📋 レース一覧').setStyle(Discord.ButtonStyle.Secondary),
  new Discord.ButtonBuilder().setCustomId('lumma_bet').setLabel('🎯 ウマに賭ける').setStyle(Discord.ButtonStyle.Success),
  new Discord.ButtonBuilder().setCustomId('check_balance').setLabel('📊 残高確認').setStyle(Discord.ButtonStyle.Secondary)
]);

const adminButtons = () => new Discord.ActionRowBuilder().addComponents([
  new Discord.ButtonBuilder().setCustomId('adjust_coins').setLabel('⚙ コイン増減').setStyle(Discord.ButtonStyle.Danger),
  new Discord.ButtonBuilder().setCustomId('history_all').setLabel('📜 全員取引履歴').setStyle(Discord.ButtonStyle.Secondary)
]);

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

// ---------------- Ready ----------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

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
});

// ---------------- Interaction ----------------
client.on('interactionCreate', async (interaction) => {
  const uid = interaction.user.id;
  const replyEmbed = async (emb) => {
    try {
      if(interaction.deferred || interaction.replied){
        await interaction.editReply({ embeds:[emb] }).catch(()=>{});
      } else {
        await interaction.reply({ embeds:[emb], ephemeral: true }).catch(()=>{});
      }
    } catch {}
  };

  try {
    if(interaction.isButton()){
      const { customId } = interaction;

      if (customId === 'lumma_create') {
        const modal = new Discord.ModalBuilder()
          .setCustomId('lumma_create_modal')
          .setTitle('ルムマ作成')
          .addComponents(
            new Discord.ActionRowBuilder().addComponents(
              new Discord.TextInputBuilder()
                .setCustomId('race_name')
                .setLabel('レース名')
                .setStyle(Discord.TextInputStyle.Short)
                .setRequired(true)
            ),
            new Discord.ActionRowBuilder().addComponents(
              new Discord.TextInputBuilder()
                .setCustomId('horses')
                .setLabel('ウマ名をカンマ区切りで入力 (2-18頭)')
                .setStyle(Discord.TextInputStyle.Paragraph)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      // deferReply 必要なボタン
      if (['daily_claim','check_balance','check_history','lumma_list','history_all','lumma_bet','adjust_coins'].includes(customId)) {
        await interaction.deferReply({ ephemeral:true });
      }

      // 元のボタン処理 (デイリー・残高・履歴・ルムマ一覧など) をここに追加
      // 例: daily_claim, check_balance, check_history, lumma_list, lumma_bet, adjust_coins, history_all
    }

    if(interaction.isModalSubmit()){
      const { customId } = interaction;

      if (customId === 'lumma_create_modal') {
        const raceName = interaction.fields.getTextInputValue('race_name').trim();
        const horses = interaction.fields.getTextInputValue('horses').split(',').map(h=>h.trim()).filter(h=>h);
        if(horses.length<2 || horses.length>18) return interaction.reply({ embeds:[createEmbed('エラー','ウマは2～18頭で入力してください','Red')], ephemeral:true });

        await pool.query(
          'INSERT INTO lumma_races(channel_id, host_id, race_name, horses) VALUES($1,$2,$3,$4)',
          [interaction.channelId, uid, raceName, horses]
        );
        return interaction.reply({ embeds:[createEmbed('成功',`レース「${raceName}」を作成しました!`,'Green')], ephemeral:true });
      }

      // lumma_bet
      if (customId === 'lumma_bet_modal') {
        const raceId = parseInt(interaction.fields.getTextInputValue('race_id'));
        const horseName = interaction.fields.getTextInputValue('horse_name').trim();
        const betAmount = parseInt(interaction.fields.getTextInputValue('bet_amount'));

        if(isNaN(raceId) || !horseName || isNaN(betAmount) || betAmount <= 0)
          return interaction.reply({ embeds:[createEmbed('エラー','入力が正しくありません','Red')], ephemeral:true });

        const raceRes = await pool.query('SELECT * FROM lumma_races WHERE id=$1 AND is_closed=false', [raceId]);
        const race = raceRes.rows[0];
        if(!race) return interaction.reply({ embeds:[createEmbed('エラー','指定されたレースは存在しないか締め切られています','Red')], ephemeral:true });
        if(!race.horses.includes(horseName)) return interaction.reply({ embeds:[createEmbed('エラー','指定されたウマはこのレースに存在しません','Red')], ephemeral:true });

        const user = await getUser(uid);
        if(user.balance < betAmount) return interaction.reply({ embeds:[createEmbed('エラー','所持コインが不足しています','Red')], ephemeral:true });

        await updateCoins(uid, -betAmount, 'lumma_bet', `レース:${raceId}, ウマ:${horseName}`);
        await pool.query('INSERT INTO lumma_bets(race_id,user_id,horse_name,bet_amount) VALUES($1,$2,$3,$4)', [raceId, uid, horseName, betAmount]);

        return interaction.reply({ embeds:[createEmbed('賭け完了',`レースID ${raceId} の ${horseName} に ${betAmount}S を賭けました`,'Green')], ephemeral:true });
      }

      if (customId === 'adjust_coins_modal') {
        const targetUser = interaction.fields.getTextInputValue('target_user').trim();
        const amount = parseInt(interaction.fields.getTextInputValue('amount'));
        if(!targetUser || isNaN(amount)) return interaction.reply({ embeds:[createEmbed('エラー','入力が正しくありません','Red')], ephemeral:true });

        const newBalance = await updateCoins(targetUser, amount, 'admin', `管理操作: ${amount>0?'+':''}${amount}S`);
        return interaction.reply({ embeds:[createEmbed('成功',`ユーザー <@${targetUser}> の残高を ${newBalance}S に更新しました`,'Green')], ephemeral:true });
      }
    }

  } catch(err) {
    console.error('interaction error:', err);
    if(!interaction.replied) {
      try { await interaction.reply({ embeds:[createEmbed('エラー','内部エラーが発生しました','Red')], ephemeral:true }); } catch{}
    }
  }
});

// ---------------- HTTP Server ----------------
http.createServer((req,res)=>{
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end('Bot is running\n');
}).listen(PORT,()=>console.log(`HTTP server running on port ${PORT}`));

// ---------------- Login ----------------
client.login(DISCORD_TOKEN);
