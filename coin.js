import { pool } from './db.js';

const spamCooldown = {};
const DAILY_MESSAGE_LIMIT = 5;
const DAILY_COINS = 100;

async function getUser(userId) {
  const res = await pool.query('SELECT * FROM users WHERE user_id=$1', [userId]);
  if (res.rows.length === 0) {
    await pool.query('INSERT INTO users (user_id) VALUES ($1)', [userId]);
    return { user_id: userId, coins: 0, last_daily: null };
  }
  return res.rows[0];
}

async function updateCoins(userId, amount, type='manual', info='') {
  const user = await getUser(userId);
  const newCoins = user.coins + amount;
  await pool.query('UPDATE users SET coins=$1 WHERE user_id=$2', [newCoins, userId]);
  await pool.query('INSERT INTO history (user_id,type,amount,info) VALUES ($1,$2,$3,$4)', [userId,type,amount,info]);
  return newCoins;
}

async function claimDaily(userId) {
  const user = await getUser(userId);
  const now = new Date();
  const last = user.last_daily ? new Date(user.last_daily) : null;

  const today5am = new Date();
  today5am.setHours(5,0,0,0);
  if (last && last >= today5am) return false;

  await updateCoins(userId, DAILY_COINS, 'daily', 'デイリー報酬');
  await pool.query('UPDATE users SET last_daily=$1 WHERE user_id=$2', [now, userId]);
  return true;
}

function canRewardMessage(userId) {
  const now = Date.now();
  const last = spamCooldown[userId] || 0;
  if (now - last < 60*1000) return false;
  spamCooldown[userId] = now;
  return true;
}

export { getUser, updateCoins, claimDaily, canRewardMessage, DAILY_MESSAGE_LIMIT };
