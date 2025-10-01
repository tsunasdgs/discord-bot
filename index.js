// ---------------- index.js ----------------
import Discord from 'discord.js';
import pkg from 'pg';
import schedule from 'node-schedule';
import dotenv from 'dotenv';
import http from 'http';

const { Pool } = pkg;
dotenv.config();

// ---------------- Env ----------------
const {
  DISCORD_TOKEN,
  DATABASE_URL,
  DAILY_CHANNEL_ID,
  ADMIN_CHANNEL_ID,
  LUMMA_CHANNELS,
  ALLOWED_ROLE_IDS,
  DAILY_AMOUNT = 100,
  MESSAGE_AMOUNT = 10,
  MESSAGE_LIMIT = 5,
  PORT = 10000
} = process.env;

if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN が設定されていません');

const ALLOWED_LUMMA_CHANNELS = LUMMA_CHANNELS?.split(',').map(c=>c.trim()) || [];
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
      entrants INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
  if(!ALLOWED_ROLES.length) return true; // 設定なしなら制限なし
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

  const countRes = await pool.query('SELECT COUNT(*) FROM history WHERE user_id=$1 AND type=$2 AND created_at::date=CURRENT_DATE',[msg.author.id,'message']);
  if(countRes.rows[0].count >= MESSAGE_LIMIT_NUM) return;

  await updateCoins(msg.author.id, MESSAGE_AMOUNT_NUM,'message','発言報酬');
});

// ---------------- ルムマ Helper ----------------
const calculateOdds = async (raceId) => {
  const betsRes = await pool.query('SELECT horse_name, SUM(bet_amount) as total FROM lumma_bets WHERE race_id=$1 GROUP BY horse_name',[raceId]);
  const totalPool = betsRes.rows.reduce((sum,row)=> sum + Number(row.total),0);
  const odds = {};
  for(const row of betsRes.rows) odds[row.horse_name] = totalPool / Number(row.total);
  return odds;
};

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
const mainMenu = () => createRow([
  new Discord.StringSelectMenuBuilder()
    .setCustomId('main_menu')
    .setPlaceholder('操作を選択してください')
    .addOptions([
      { label:'💰 デイリー報酬', value:'daily' },
      { label:'📊 残高確認', value:'check_balance' },
      { label:'📜 履歴確認', value:'check_history' },
      { label:'🏇 ルムマ作成', value:'lumma_create' },
      { label:'📋 ルムマ一覧', value:'lumma_list' },
      { label:'🎯 馬に賭ける', value:'lumma_bet' },
      { label:'🏆 勝者報告', value:'lumma_close' },
      { label:'🎫 自分の賭け状況', value:'lumma_my_bets' },
    ])
]);

// ---------------- Ready ----------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    const sendUI = async (chId, content, rowFn) => {
      if(!chId) return;
      const ch = await client.channels.fetch(chId.trim());
      if(ch?.isTextBased()) await ch.send({ content, components:[rowFn()] });
    };
    await sendUI(DAILY_CHANNEL_ID,'メインメニュー',mainMenu);
  } catch(e){ console.error('UI送信エラー:',e); }
});

// ---------------- Interaction ----------------
client.on('interactionCreate', async (interaction) => {
  const uid = interaction.user.id;
  const member = await interaction.guild.members.fetch(uid);
  const replyEmbed = (emb)=> interaction.reply({ embeds:[emb], ephemeral:true });

  // 全ルムマ操作は権限チェック
  const lummaInteractions = ['lumma_create','lumma_list','lumma_bet','lumma_close','lumma_my_bets'];
  if((interaction.isStringSelectMenu() && lummaInteractions.includes(interaction.customId)) || 
     (interaction.isModalSubmit() && interaction.customId.startsWith('lumma_create_modal')) ||
     (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_race')) ||
     (interaction.isStringSelectMenu() && interaction.customId.startsWith('bet_')) ||
     (interaction.isModalSubmit() && interaction.customId.startsWith('bet_amount_')) ||
     (interaction.isStringSelectMenu() && interaction.customId.startsWith('close_'))){
    if(!await checkRole(member)){
      return replyEmbed(createEmbed('権限エラー','この操作は許可ロールが必要です','Red'));
    }
  }

  // ---------------- メインメニュー ----------------
  if(interaction.isStringSelectMenu() && interaction.customId==='main_menu'){
    const choice = interaction.values[0];

    // --- デイリー報酬 ---
    if(choice==='daily'){
      const res = await pool.query('SELECT last_claim FROM daily_claims WHERE user_id=$1',[uid]);
      const last = res.rows[0]?.last_claim;
      if(last && new Date(last).toDateString()===new Date().toDateString())
        return replyEmbed(createEmbed('通知','今日のデイリーは取得済み'));
      await updateCoins(uid,DAILY_AMOUNT_NUM,'daily','デイリー報酬');
      await pool.query(`INSERT INTO daily_claims(user_id,last_claim) VALUES($1,CURRENT_DATE)
                        ON CONFLICT (user_id) DO UPDATE SET last_claim=CURRENT_DATE`,[uid]);
      return replyEmbed(createEmbed('デイリー取得',`デイリー ${DAILY_AMOUNT_NUM}S 取得!`,'Green'));
    }

    // --- 残高確認 ---
    if(choice==='check_balance'){
      const user = await getUser(uid);
      return replyEmbed(createFieldEmbed('所持S',[
        { name:'ユーザー', value:`<@${uid}>`, inline:true },
        { name:'残高', value:`${user.balance}S`, inline:true }
      ],'Gold'));
    }

    // --- 履歴確認 ---
    if(choice==='check_history'){
      const res = await pool.query('SELECT * FROM history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5',[uid]);
      if(!res.rows.length) return replyEmbed(createEmbed('履歴','取引履歴はありません','Grey'));
      const fields = res.rows.map(r=>({
        name:`${r.type} (${r.amount>0?'+':''}${r.amount}S)`,
        value:`${r.note||''} - ${new Date(r.created_at).toLocaleString()}`
      }));
      return replyEmbed(createFieldEmbed('直近の履歴',fields,'Blue'));
    }

    // --- ルムマ作成モーダル ---
    if(choice==='lumma_create'){
      const modal = new Discord.ModalBuilder()
        .setCustomId('lumma_create_modal').setTitle('ルムマレース作成')
        .addComponents(
          createRow([ new Discord.TextInputBuilder().setCustomId('race_name').setLabel('レース名').setStyle(Discord.TextInputStyle.Short).setRequired(true) ]),
          createRow([ new Discord.TextInputBuilder().setCustomId('horses').setLabel('出走馬名(カンマ区切り)').setStyle(Discord.TextInputStyle.Paragraph).setRequired(true) ])
        );
      return interaction.showModal(modal);
    }

    // --- ルムマ一覧 ---
    if(choice==='lumma_list'){
      const racesRes = await pool.query('SELECT * FROM lumma_races WHERE is_closed=false ORDER BY created_at DESC');
      if(!racesRes.rows.length) return replyEmbed(createEmbed('通知','開催中のレースはありません','Yellow'));
      const fields = racesRes.rows.map(r=>({ name:r.race_name, value:`出走馬数: ${r.entrants}`, inline:false }));
      return replyEmbed(createFieldEmbed('開催中のルムマ',fields,'Purple'));
    }

    // --- 自分の賭け状況 ---
    if(choice==='lumma_my_bets'){
      const myBets = await pool.query('SELECT l.race_name, b.horse_name, b.bet_amount FROM lumma_bets b JOIN lumma_races l ON b.race_id=l.id WHERE b.user_id=$1 AND l.is_closed=false',[uid]);
      if(!myBets.rows.length) return replyEmbed(createEmbed('通知','現在の賭けはありません','Yellow'));
      const fields = myBets.rows.map(r=>({ name:r.race_name, value:`${r.horse_name} に ${r.bet_amount}S`, inline:false }));
      return replyEmbed(createFieldEmbed('自分の賭け状況',fields,'Green'));
    }

    // --- 馬に賭ける ---
    if(choice==='lumma_bet'){
      const racesRes = await pool.query('SELECT * FROM lumma_races WHERE is_closed=false ORDER BY created_at DESC');
      if(!racesRes.rows.length) return replyEmbed(createEmbed('エラー','賭け可能なレースはありません','Red'));
      const options = racesRes.map(r=>({ label:r.race_name, value:r.id.toString() }));
      const select = new Discord.StringSelectMenuBuilder().setCustomId('select_race').setPlaceholder('賭けるレースを選択').addOptions(options);
      return interaction.reply({ content:'賭けたいレースを選択してください', components:[createRow([select])], ephemeral:true });
    }

    // --- 勝者報告 ---
    if(choice==='lumma_close'){
      const res = await pool.query('SELECT * FROM lumma_races WHERE host_id=$1 AND is_closed=false ORDER BY created_at DESC LIMIT 1',[uid]);
      const race = res.rows[0];
      if(!race) return replyEmbed(createEmbed('エラー','締め可能なレースはありません','Red'));
      const horsesRes = await pool.query('SELECT horse_name FROM lumma_bets WHERE race_id=$1 GROUP BY horse_name',[race.id]);
      const options = horsesRes.rows.map(h=>({ label:h.horse_name, value:h.horse_name }));
      if(!options.length) return replyEmbed(createEmbed('通知','まだ馬が登録されていません','Yellow'));
      const select = new Discord.StringSelectMenuBuilder().setCustomId(`close_${race.id}`).setPlaceholder('勝者馬を選択').addOptions(options);
      return interaction.reply({ content:`レース: ${race.race_name} 勝者を選択`, components:[createRow([select])], ephemeral:true });
    }
  }

  // --- レース選択後、賭け馬選択 ---
  if(interaction.isStringSelectMenu() && interaction.customId==='select_race'){
    const raceId = interaction.values[0];
    const race = await pool.query('SELECT * FROM lumma_races WHERE id=$1',[raceId]);
    if(!race.rows.length) return replyEmbed(createEmbed('エラー','レースが見つかりません','Red'));

    const betsRes = await pool.query('SELECT horse_name, SUM(bet_amount) as total FROM lumma_bets WHERE race_id=$1 GROUP BY horse_name',[raceId]);
    const totalPool = betsRes.rows.reduce((sum,row)=> sum+Number(row.total),0);
    const horses = betsRes.rows.map(r=>({ label:r.horse_name, value:r.horse_name }));
    if(!horses.length) return replyEmbed(createEmbed('通知','まだ馬が登録されていません','Yellow'));

    return interaction.reply({
      content:`レース: ${race.rows[0].race_name}\nオッズ目安: ${betsRes.rows.map(r=>`${r.horse_name}: ${(totalPool/r.total).toFixed(2)}倍`).join('\n')}`,
      components:[createRow([new Discord.StringSelectMenuBuilder().setCustomId(`bet_${raceId}`).setPlaceholder('馬を選択').addOptions(horses)])],
      ephemeral:true
    });
  }

  // --- 馬に賭ける処理 ---
  if(interaction.isStringSelectMenu() && interaction.customId.startsWith('bet_')){
    const raceId = interaction.customId.replace('bet_','');
    const horse = interaction.values[0];
    const modal = new Discord.ModalBuilder()
      .setCustomId(`bet_amount_${raceId}_${horse}`)
      .setTitle(`賭け金を入力: ${horse}`)
      .addComponents(
        createRow([ new Discord.TextInputBuilder().setCustomId('amount').setLabel('賭け金').setStyle(Discord.TextInputStyle.Short).setRequired(true) ])
      );
    return interaction.showModal(modal);
  }

  if(interaction.isModalSubmit() && interaction.customId.startsWith('bet_amount_')){
    const [_, raceId, horse] = interaction.customId.split('_');
    const amount = parseInt(interaction.fields.getTextInputValue('amount'));
    if(isNaN(amount) || amount<=0) return replyEmbed(createEmbed('エラー','正しい金額を入力してください','Red'));
    const user = await getUser(uid);
    if(user.balance < amount) return replyEmbed(createEmbed('エラー','所持コインが足りません','Red'));

    await updateCoins(uid,-amount,'lumma_bet',`ルムマ賭け ${horse} ${amount}S`);
    await pool.query('INSERT INTO lumma_bets(race_id,user_id,horse_name,bet_amount) VALUES($1,$2,$3,$4)',
      [raceId, uid, horse, amount]);
    return replyEmbed(createEmbed('賭け完了',`${horse} に ${amount}S 賭けました`,'Green'));
  }

  // --- 勝者確定処理 ---
  if(interaction.isStringSelectMenu() && interaction.customId.startsWith('close_')){
    const raceId = interaction.customId.replace('close_','');
    const winnerHorse = interaction.values[0];
    await payWinners(raceId,winnerHorse);
    return replyEmbed(createEmbed('レース締め完了',`勝者: ${winnerHorse} 配当済`,'Green'));
  }
});

// ---------------- HTTP Server ----------------
http.createServer((req,res)=>{
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end('Bot is running\n');
}).listen(PORT,()=>console.log(`HTTP server running on port ${PORT}`));

// ---------------- Login ----------------
client.login(DISCORD_TOKEN);
