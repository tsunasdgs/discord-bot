// index.js
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
  DAILY_AMOUNT = 100,
  MESSAGE_AMOUNT = 10,
  MESSAGE_LIMIT = 5,
  PORT = 10000
} = process.env;

if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN が設定されていません');

// ---------------- 定数 ----------------
const ALLOWED_RUMMA_CHANNELS = RUMMA_CHANNELS?.split(',').map(c => c.trim()) || [];
const DAILY_AMOUNT_NUM = Number(DAILY_AMOUNT);
const MESSAGE_AMOUNT_NUM = Number(MESSAGE_AMOUNT);
const MESSAGE_LIMIT_NUM = Number(MESSAGE_LIMIT);
const FORBIDDEN_WORDS = ['ああ','いい','AA'];
const MESSAGE_COOLDOWN_MS = 60000;

// ---------------- DB接続 ----------------
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ---------------- Client ----------------
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
const createEmbed = (title, desc, color='Blue') =>
  new Discord.EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);

const createFieldEmbed = (title, fields, color='Blue') =>
  new Discord.EmbedBuilder().setTitle(title).addFields(fields).setColor(color);

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
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    if (DAILY_CHANNEL_ID) {
      const ch = await client.channels.fetch(DAILY_CHANNEL_ID);
      if (ch?.isTextBased()) await ch.send({ content:'💰 デイリー操作', components:[dailyButtons()] });
    }
    for (const cid of ALLOWED_RUMMA_CHANNELS) {
      const ch = await client.channels.fetch(cid);
      if (ch?.isTextBased()) await ch.send({ content:'🏇 ルムマ操作', components:[lummaButtons()] });
    }
    if (ADMIN_CHANNEL_ID) {
      const ch = await client.channels.fetch(ADMIN_CHANNEL_ID);
      if (ch?.isTextBased()) await ch.send({ content:'⚙ 管理操作', components:[adminButtons()] });
    }
  } catch(e){ console.error('UI送信エラー:', e); }
});

// ---------------- Interaction ----------------
client.on('interactionCreate', async (interaction) => {
  const uid = interaction.user.id;

  try {
    // ===== ボタン =====
    if(interaction.isButton()){
      // モーダル表示するボタンは defer 不要
      if(!['lumma_create','lumma_bet','adjust_coins'].includes(interaction.customId)){
        if(!interaction.deferred && !interaction.replied){
          await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });
        }
      }

      // デイリー
      if(interaction.customId==='daily_claim'){
        const res = await pool.query('SELECT last_claim FROM daily_claims WHERE user_id=$1',[uid]);
        const last = res.rows[0]?.last_claim;
        if(last && new Date(last).toDateString()===new Date().toDateString())
          return interaction.editReply({ embeds:[createEmbed('通知','今日のデイリーは取得済み')] });

        await updateCoins(uid, DAILY_AMOUNT_NUM, 'daily', 'デイリー報酬');
        await pool.query(`INSERT INTO daily_claims(user_id,last_claim) VALUES($1,CURRENT_DATE)
          ON CONFLICT (user_id) DO UPDATE SET last_claim=CURRENT_DATE`, [uid]);
        return interaction.editReply({ embeds:[createEmbed('デイリー取得',`デイリー ${DAILY_AMOUNT_NUM}S 取得!`,'Green')] });
      }

      if(interaction.customId==='check_balance'){
        const user = await getUser(uid);
        return interaction.editReply({ embeds:[createFieldEmbed('所持S',[{name:'残高',value:`${user.balance}S`}],'Gold')] });
      }

      if(interaction.customId==='check_history'){
        const res = await pool.query(
          `SELECT * FROM history WHERE user_id=$1 AND created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 20`,
          [uid]
        );
        if(!res.rows.length) return interaction.editReply({ embeds:[createEmbed('履歴','過去1週間の履歴なし','Grey')] });
        const fields = res.rows.map(r => ({ name: `${r.type} (${r.amount>0?'+':''}${r.amount}S)`, value: `${r.note||''} - ${new Date(r.created_at).toLocaleString()}` }));
        return interaction.editReply({ embeds:[createFieldEmbed('直近の履歴', fields,'Blue')] });
      }

      // ルムマモーダル
      if(interaction.customId==='lumma_create'){
        const modal = new Discord.ModalBuilder()
          .setCustomId('lumma_create_modal')
          .setTitle('ルムマ作成')
          .addComponents(
            new Discord.ActionRowBuilder().addComponents(
              new Discord.TextInputBuilder().setCustomId('race_name').setLabel('レース名').setStyle(Discord.TextInputStyle.Short).setRequired(true)
            ),
            new Discord.ActionRowBuilder().addComponents(
              new Discord.TextInputBuilder().setCustomId('horses').setLabel('ウマ名をカンマ区切りで入力 (2-18頭)').setStyle(Discord.TextInputStyle.Paragraph).setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      if(interaction.customId==='lumma_list'){
        const res = await pool.query('SELECT * FROM lumma_races WHERE is_closed=false ORDER BY created_at DESC LIMIT 10');
        if(!res.rows.length) return interaction.editReply({ embeds:[createEmbed('レース一覧','開催中なし','Grey')] });
        const fields = res.rows.map(r => ({ name: r.race_name, value: `ホスト:<@${r.host_id}>\n出走:${r.horses.join(', ')}` }));
        return interaction.editReply({ embeds:[createFieldEmbed('開催中レース', fields,'Blue')] });
      }

      if(interaction.customId==='lumma_bet'){
        const modal = new Discord.ModalBuilder()
          .setCustomId('lumma_bet_modal')
          .setTitle('ウマに賭ける')
          .addComponents(
            new Discord.ActionRowBuilder().addComponents(
              new Discord.TextInputBuilder().setCustomId('race_id').setLabel('レースID').setStyle(Discord.TextInputStyle.Short).setRequired(true)
            ),
            new Discord.ActionRowBuilder().addComponents(
              new Discord.TextInputBuilder().setCustomId('horse_name').setLabel('ウマ名').setStyle(Discord.TextInputStyle.Short).setRequired(true)
            ),
            new Discord.ActionRowBuilder().addComponents(
              new Discord.TextInputBuilder().setCustomId('bet_amount').setLabel('賭け金').setStyle(Discord.TextInputStyle.Short).setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      // 管理モーダル
      if(interaction.customId==='adjust_coins'){
        const modal = new Discord.ModalBuilder()
          .setCustomId('adjust_coins_modal')
          .setTitle('ユーザーコイン増減')
          .addComponents(
            new Discord.ActionRowBuilder().addComponents(
              new Discord.TextInputBuilder().setCustomId('target_user').setLabel('ユーザーID').setStyle(Discord.TextInputStyle.Short).setRequired(true)
            ),
            new Discord.ActionRowBuilder().addComponents(
              new Discord.TextInputBuilder().setCustomId('amount').setLabel('増減コイン数(+/-)').setStyle(Discord.TextInputStyle.Short).setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      if(interaction.customId==='history_all'){
        const res = await pool.query(
          `SELECT * FROM history WHERE created_at > now() - interval '7 days' ORDER BY created_at DESC LIMIT 50`
        );
        if(!res.rows.length) return interaction.editReply({ embeds:[createEmbed('全員履歴','過去1週間の履歴なし','Grey')] });
        const fields = res.rows.map(r => ({ name:`<@${r.user_id}> ${r.type} (${r.amount>0?'+':''}${r.amount}S)`, value:r.note||'' }));
        return interaction.editReply({ embeds:[createFieldEmbed('全員履歴',fields,'Blue')] });
      }
    }

    // ===== モーダル =====
    if(interaction.isModalSubmit()){
      if(interaction.customId==='lumma_create_modal'){
        const raceName = interaction.fields.getTextInputValue('race_name');
        const horses = interaction.fields.getTextInputValue('horses').split(',').map(h=>h.trim()).filter(h=>h);
        if(horses.length<2 || horses.length>18){
          return interaction.reply({ embeds:[createEmbed('エラー','ウマは2〜18頭で入力してください','Red')], flags: Discord.MessageFlags.Ephemeral });
        }
        await pool.query('INSERT INTO lumma_races(channel_id,host_id,race_name,horses) VALUES($1,$2,$3,$4)', [interaction.channelId, interaction.user.id, raceName, horses]);
        return interaction.reply({ embeds:[createEmbed('ルムマ作成完了',`レース:${raceName}\n出走:${horses.join(', ')}`,'Green')], flags: Discord.MessageFlags.Ephemeral });
      }

      if(interaction.customId==='lumma_bet_modal'){
        const raceId = interaction.fields.getTextInputValue('race_id');
        const horse = interaction.fields.getTextInputValue('horse_name');
        const bet = parseInt(interaction.fields.getTextInputValue('bet_amount'));
        const raceRes = await pool.query('SELECT * FROM lumma_races WHERE id=$1 AND is_closed=false',[raceId]);
        if(!raceRes.rows.length) return interaction.reply({ embeds:[createEmbed('エラー','レースが存在しません','Red')], flags: Discord.MessageFlags.Ephemeral });

        const user = await getUser(uid);
        if(user.balance<bet) return interaction.reply({ embeds:[createEmbed('エラー','残高不足','Red')], flags: Discord.MessageFlags.Ephemeral });

        await updateCoins(uid,-bet,'bet',`Race#${raceId}:${horse}`);
        await pool.query('INSERT INTO lumma_bets(race_id,user_id,horse_name,bet_amount) VALUES($1,$2,$3,$4)',[raceId,uid,horse,bet]);
        return interaction.reply({ embeds:[createEmbed('ベット完了',`Race#${raceId}\n${horse} に ${bet}S 賭けました`,'Green')], flags: Discord.MessageFlags.Ephemeral });
      }

      if(interaction.customId==='adjust_coins_modal'){
        const target = interaction.fields.getTextInputValue('target_user');
        const amount = parseInt(interaction.fields.getTextInputValue('amount'));
        const newBalance = await updateCoins(target,amount,'admin_adjust',`管理者:${uid}`);
        return interaction.reply({ embeds:[createEmbed('管理操作完了',`<@${target}> の残高: ${newBalance}S`,'Green')], flags: Discord.MessageFlags.Ephemeral });
      }
    }

  } catch(err){
    console.error('interaction error:', err);
    if(interaction.isRepliable()){
      await interaction.reply({ embeds:[createEmbed('エラー','内部エラーが発生しました','Red')], flags: Discord.MessageFlags.Ephemeral }).catch(()=>{});
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
