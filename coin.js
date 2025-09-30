import { query } from './db.js';

const DAILY_AMOUNT = parseInt(process.env.DAILY_AMOUNT || 100);
const MESSAGE_AMOUNT = parseInt(process.env.MESSAGE_AMOUNT || 10);
const MESSAGE_DAILY_LIMIT = parseInt(process.env.MESSAGE_DAILY_LIMIT || 5);
const FORBIDDEN_WORDS = (process.env.FORBIDDEN_WORDS || '').split(',');

// ユーザー取得 or 初期作成
export async function getUser(userId) {
  const res = await query('SELECT * FROM coins WHERE user_id=$1', [userId]);
  if (res.rows.length) return res.rows[0];
  await query('INSERT INTO coins(user_id,balance,last_daily) VALUES($1,$2,NULL)', [userId, 0]);
  return { user_id: userId, balance: 0, last_daily: null };
}

// 残高確認
export async function getBalance(userId) {
  const user = await getUser(userId);
  return user.balance;
}

// コイン更新
export async function updateCoins(userId, amount, type='manual', note='') {
  await query(`
    INSERT INTO coins(user_id,balance) VALUES($1,$2)
    ON CONFLICT(user_id) DO UPDATE SET balance = coins.balance + $2
  `, [userId, amount]);

  await query(`
    INSERT INTO history(user_id,type,amount,note)
    VALUES($1,$2,$3,$4)
  `, [userId, type, amount, note]);
}

// 発言報酬チェック
const messageCooldowns = {};
export async function canRewardMessage(userId, messageContent) {
  // 禁止ワードチェック
  const content = messageContent.replace(/\s/g,'');
  if (FORBIDDEN_WORDS.some(w => w && content.includes(w))) return false;

  // 1分クールダウン
  const now = Date.now();
  if (messageCooldowns[userId] && now - messageCooldowns[userId] < 60*1000) return false;
  messageCooldowns[userId] = now;

  // 1日上限
  const today = await query(
    'SELECT COUNT(*) FROM history WHERE user_id=$1 AND type=$2 AND timestamp::date = CURRENT_DATE',
    [userId,'message']
  );
  if (parseInt(today.rows[0].count) >= MESSAGE_DAILY_LIMIT) return false;

  return true;
}

// 発言報酬処理
export async function rewardMessage(userId) {
  await updateCoins(userId, MESSAGE_AMOUNT, 'message', '発言報酬');
}

// デイリー報酬
export async function claimDaily(userId) {
  const user = await getUser(userId);
  const now = new Date();
  if (user.last_daily && new Date(user.last_daily).toDateString() === now.toDateString()) return false;
  await updateCoins(userId, DAILY_AMOUNT, 'daily', 'デイリー報酬');
  await query('UPDATE coins SET last_daily=$1 WHERE user_id=$2', [now, userId]);
  return true;
}

// デイリーリセット（朝5時）
export async function resetDaily() {
  await query('UPDATE coins SET last_daily=NULL');
}
