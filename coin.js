// coin.js
import { query } from './db.js';

export async function getBalance(userId) {
  const res = await query('SELECT balance FROM coins WHERE user_id=$1', [userId]);
  if (res.rows.length) return res.rows[0].balance;
  await query('INSERT INTO coins(user_id,balance) VALUES($1,$2)', [userId, 1000]);
  return 1000;
}

export async function updateCoins(userId, amount, type='manual', note='') {
  await query(`
    INSERT INTO coins(user_id,balance) 
    VALUES($1,$2) 
    ON CONFLICT(user_id) DO UPDATE 
    SET balance = coins.balance + $2
  `, [userId, amount]);
}

export async function canRewardMessage(userId) {
  // 簡易：1分間に1回だけ報酬
  return true; // 詳細はRedisやDBで制御可能
}

export async function claimDaily(userId) {
  const res = await query('SELECT last_daily FROM coins WHERE user_id=$1', [userId]);
  const now = new Date();
  if (res.rows.length && res.rows[0].last_daily) {
    const last = new Date(res.rows[0].last_daily);
    if (now.toDateString() === last.toDateString()) return false;
  }
  await query(`
    INSERT INTO coins(user_id,balance,last_daily)
    VALUES($1,100, $2)
    ON CONFLICT(user_id) DO UPDATE 
    SET balance = coins.balance + 100, last_daily=$2
  `, [userId, now]);
  return true;
}
