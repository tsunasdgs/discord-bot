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
  LUMMA_CHANNELS,
  ALLOWED_ROLE_IDS,
  DAILY_AMOUNT = 100,
  MESSAGE_AMOUNT = 10,
  MESSAGE_LIMIT = 5,
  PORT = 10000
} = process.env;

if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN が設定されていません');

const ALLOWED_LUMMA_CHANNELS = LUMMA_CHANNELS?.split(',').map(c => c.trim()) || [];
const ALLOWED_ROLES = ALLOWED_ROLE_IDS?.split(',').map(r => r.trim()) || [];
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
    `CREATE TABLE IF NOT EXISTS lumma_race_entries (
      id SERIAL PRIMARY KEY, race_id INT REFERENCES lumma_races(id),
      horse_name TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS lumma_bets (
      id SERIAL PRIMARY KEY, race_id INT, user_id TEXT, horse_name TEXT, bet_amount INT
    );`
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

const updateCoins = async (userId, amount, type = 'manual', note = '') => {
  const user = await getUser(userId);
  const newBalance = user.balance + amount;
  await pool.query('UPDATE coins SET balance=$1 WHERE user_id=$2', [newBalance, userId]);
  await pool.query('INSERT INTO history(user_id,type,amount,note) VALUES($1,$2,$3,$4)', [userId, type, amount, note]);
  return newBalance;
};

const createEmbed = (title, desc, color = 'Blue') =>
  new Discord.EmbedBuilder().setTitle(title).setDescription(desc).setColor(color);

const createFieldEmbed = (title, fields, color = 'Blue') =>
  new Discord.EmbedBuilder().setTitle(title).addFields(fields).setColor(color);

const createRow = (components) => new Discord.ActionRowBuilder().addComponents(components);

const checkRole = async (member) => {
  if (!ALLOWED_ROLES.length) return true;
  return member.roles.cache.some(r => ALLOWED_ROLES.includes(r.id));
};

// ---------------- Scheduled Tasks ----------------
schedule.scheduleJob('0 5 * * *', async () => {
  await pool.query('UPDATE daily_claims SET last_claim=NULL');
  console.log('デイリー報酬リセット完了');
});

// ---------------- Message Reward ----------------
const spamCooldown = {};
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.replace(/\s/g, '');
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

// ---------------- ルムマ Helper ----------------
const calculateOdds = (bets) => {
  const total = bets.reduce((sum, b) => sum + b.bet_amount, 0);
  return bets.map(b => ({ ...b, odds: total / b.bet_amount }));
};

const payWinners = async (raceId, winnerHorse) => {
  const betsRes = await pool.query('SELECT * FROM lumma_bets WHERE race_id=$1', [raceId]);
  const winnerBets = betsRes.rows.filter(b => b.horse_name === winnerHorse);
  const totalPool = betsRes.rows.reduce((sum, b) => sum + b.bet_amount, 0);
  const totalWinnerBets = winnerBets.reduce((sum, b) => sum + b.bet_amount, 0);

  for (const bet of winnerBets) {
    const payout = Math.floor(bet.bet_amount / totalWinnerBets * totalPool);
    await updateCoins(bet.user_id, payout, 'lumma_win', `ルムマ勝利: ${winnerHorse} (${payout}S)`);
  }

  await pool.query('UPDATE lumma_races SET is_closed=true, winner=$1 WHERE id=$2', [winnerHorse, raceId]);
};

// ---------------- UI ----------------
const dailyButton = new Discord.ActionRowBuilder().addComponents(
  new Discord.ButtonBuilder()
    .setCustomId('daily_claim')
    .setLabel('💰 デイリー報酬取得')
    .setStyle(Discord.ButtonStyle.Primary)
);

const mainMenu = () => createRow([
  new Discord.StringSelectMenuBuilder()
    .setCustomId('main_menu')
    .setPlaceholder('操作を選択してください')
    .addOptions([
      { label: '📊 残高確認', value: 'check_balance' },
      { label: '📜 履歴確認', value: 'check_history' },
      { label: '🏇 ルムマ作成', value: 'lumma_create' },
      { label: '📋 ルムマ一覧', value: 'lumma_list' },
      { label: '🎯 馬に賭ける', value: 'lumma_bet' },
      { label: '🏆 勝者報告', value: 'lumma_close' },
      { label: '🎫 自分の賭け状況', value: 'lumma_my_bets' },
      { label: '🏆 所持Sランキング', value: 'ranking' },
      { label: '🔧 管理UI', value: 'admin' }
    ])
]);

// ---------------- Ready ----------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    if (DAILY_CHANNEL_ID) {
      const ch = await client.channels.fetch(DAILY_CHANNEL_ID);
      if (ch?.isTextBased()) await ch.send({ content: 'デイリー報酬はこちら', components: [dailyButton] });
    }
  } catch (e) { console.error('UI送信エラー:', e); }
});

// ---------------- 安全 reply ----------------
const replyEmbed = async (interaction, emb) => {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [emb] }).catch(() => { });
    } else {
      await interaction.reply({ embeds: [emb], flags: Discord.MessageFlags.Ephemeral }).catch(() => { });
    }
  } catch { }
};

// ---------------- Interaction ----------------
client.on('interactionCreate', async (interaction) => {
  const uid = interaction.user.id;
  try {
    const member = interaction.guild ? await interaction.guild.members.fetch(uid) : null;

    // 権限チェック
    const restrictedInteractions = ['lumma_create', 'lumma_list', 'lumma_bet', 'lumma_close', 'lumma_my_bets'];
    if (((interaction.isStringSelectMenu() && restrictedInteractions.includes(interaction.customId)) ||
      (interaction.isModalSubmit() && interaction.customId.startsWith('lumma_create_modal')) ||
      (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_race')) ||
      (interaction.isStringSelectMenu() && interaction.customId.startsWith('bet_')) ||
      (interaction.isModalSubmit() && interaction.customId.startsWith('bet_amount_')) ||
      (interaction.isStringSelectMenu() && interaction.customId.startsWith('close_')))
      && !(member && await checkRole(member))) {
      return replyEmbed(interaction, createEmbed('権限エラー', 'この操作は許可ロールが必要です', 'Red'));
    }

    // ---------- デイリーボタン ----------
    if (interaction.isButton() && interaction.customId === 'daily_claim') {
      if (!member) return replyEmbed(interaction, createEmbed('エラー', 'サーバー内でのみ有効です', 'Red'));
      await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });

      const res = await pool.query('SELECT last_claim FROM daily_claims WHERE user_id=$1', [uid]);
      const last = res.rows[0]?.last_claim;
      if (last && new Date(last).toDateString() === new Date().toDateString())
        return interaction.editReply({ embeds: [createEmbed('通知', '今日のデイリーは取得済み')] });

      await updateCoins(uid, DAILY_AMOUNT_NUM, 'daily', 'デイリー報酬');
      await pool.query(`INSERT INTO daily_claims(user_id,last_claim) VALUES($1,CURRENT_DATE)
                        ON CONFLICT (user_id) DO UPDATE SET last_claim=CURRENT_DATE`, [uid]);
      return interaction.editReply({ embeds: [createEmbed('デイリー取得', `デイリー ${DAILY_AMOUNT_NUM}S 取得!`, 'Green')] });
    }

    // ---------- メインメニュー ----------
    if (interaction.isStringSelectMenu() && interaction.customId === 'main_menu') {
      const choice = interaction.values[0];

      // 残高確認
      if (choice === 'check_balance') {
        const user = await getUser(uid);
        return replyEmbed(interaction, createFieldEmbed('所持S', [
          { name: 'ユーザー', value: `<@${uid}>`, inline: true },
          { name: '残高', value: `${user.balance}S`, inline: true }
        ], 'Gold'));
      }

      // 取引履歴（過去1週間）
      if (choice === 'check_history') {
        const res = await pool.query(
          'SELECT * FROM history WHERE user_id=$1 AND created_at >= NOW() - INTERVAL \'7 days\' ORDER BY created_at DESC LIMIT 10',
          [uid]
        );
        if (!res.rows.length) return replyEmbed(interaction, createEmbed('履歴', '過去1週間の取引履歴はありません', 'Grey'));
        const fields = res.rows.map(r => ({
          name: `${r.type} (${r.amount > 0 ? '+' : ''}${r.amount}S)`,
          value: `${r.note || ''} - ${new Date(r.created_at).toLocaleString()}`
        }));
        return replyEmbed(interaction, createFieldEmbed('過去1週間の取引履歴', fields, 'Blue'));
      }

      // 所持Sランキング（トップ10）
      if (choice === 'ranking') {
        const res = await pool.query('SELECT user_id, balance FROM coins ORDER BY balance DESC LIMIT 10');
        const fields = res.rows.map((r, i) => ({ name: `#${i + 1}`, value: `<@${r.user_id}>: ${r.balance}S` }));
        return replyEmbed(interaction, createFieldEmbed('所持Sランキング（トップ10）', fields, 'Gold'));
      }

      // 管理UI
      if (choice === 'admin') {
        if (!member || !await checkRole(member)) return replyEmbed(interaction, createEmbed('権限エラー', '管理権限が必要です', 'Red'));
        // 簡易管理メニュー
        const adminMenu = new Discord.ActionRowBuilder().addComponents(
          new Discord.StringSelectMenuBuilder()
            .setCustomId('admin_menu')
            .setPlaceholder('管理操作を選択')
            .addOptions([
              { label: 'ユーザーのコイン調整', value: 'adjust_coin' },
              { label: 'ユーザー取引履歴確認', value: 'view_history' }
            ])
        );
        return interaction.reply({ content: '管理メニューを選択してください', components: [adminMenu], ephemeral: true });
      }

      // ルムマ作成
      if (choice === 'lumma_create') {
        if (!ALLOWED_LUMMA_CHANNELS.includes(interaction.channelId))
          return replyEmbed(interaction, createEmbed('エラー', 'このチャンネルではルムマを作成できません', 'Red'));

        const modal = new Discord.ModalBuilder()
          .setCustomId('lumma_create_modal')
          .setTitle('ルムマレース作成')
          .addComponents(
            createRow([new Discord.TextInputBuilder().setCustomId('race_name').setLabel('レース名').setStyle(Discord.TextInputStyle.Short).setRequired(true)]),
            createRow([new Discord.TextInputBuilder().setCustomId('horses').setLabel('出走馬名(カンマ区切り)').setStyle(Discord.TextInputStyle.Paragraph).setRequired(true)])
          );
        return interaction.showModal(modal);
      }
    }

    // ---------- ルムマ作成モーダル ----------
    if (interaction.isModalSubmit() && interaction.customId === 'lumma_create_modal') {
      if (!member) return replyEmbed(interaction, createEmbed('エラー', 'サーバー内でのみ有効です', 'Red'));
      await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });

      const raceName = interaction.fields.getTextInputValue('race_name');
      const horses = interaction.fields.getTextInputValue('horses').split(',').map(h => h.trim()).filter(h => h);

      if (!raceName || horses.length < 2)
        return interaction.editReply({ embeds: [createEmbed('エラー', 'レース名または出走馬が不十分です', 'Red')] });

      const res = await pool.query(
        'INSERT INTO lumma_races(channel_id, host_id, race_name, entrants) VALUES($1,$2,$3,$4) RETURNING id',
        [interaction.channelId, uid, raceName, horses.length]
      );
      const raceId = res.rows[0].id;

      // 出走馬登録
      for (const horse of horses) {
        await pool.query('INSERT INTO lumma_race_entries(race_id, horse_name) VALUES($1,$2)', [raceId, horse]);
      }

      return interaction.editReply({ embeds: [createEmbed('ルムマ作成完了', `レース: ${raceName}\n出走馬: ${horses.join(', ')}`, 'Green')] });
    }

  } catch (err) {
    console.error('interaction error:', err);
    if (interaction.deferred || interaction.replied) {
      interaction.editReply({ embeds: [createEmbed('エラー', '内部エラーが発生しました', 'Red')] }).catch(() => { });
    } else {
      interaction.reply({ embeds: [createEmbed('エラー', '内部エラーが発生しました', 'Red')], flags: Discord.MessageFlags.Ephemeral }).catch(() => { });
    }
  }
});

// ---------------- HTTP Server ----------------
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running\n');
}).listen(PORT, () => console.log(`HTTP server running on port ${PORT}`));

// ---------------- Login ----------------
client.login(DISCORD_TOKEN);
