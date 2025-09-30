import { query } from './db.js';
import { DAILY_AMOUNT } from './config.js';

const dailyCooldowns = {};

export const claimDaily = async (userId) => {
  const res = await query('SELECT last_daily FROM coins WHERE user_id=$1', [userId]);
  const now = new Date();
  if (res.rows.length === 0) {
    await query('INSERT INTO coins(user_id, balance, last_daily) VALUES($1, $2, $3)', [userId, DAILY_AMOUNT, now]);
    return true;
  }
  const lastDaily = res.rows[0].last_daily;
  if (lastDaily && new Date(lastDaily).toDateString() === now.toDateString()) return false;
  await query('UPDATE coins SET balance = balance + $1, last_daily=$2 WHERE user_id=$3', [DAILY_AMOUNT, now, userId]);
  return true;
};

export const updateCoins = async (userId, amount, type, note) => {
  const res = await query('SELECT balance FROM coins WHERE user_id=$1', [userId]);
  if (res.rows.length === 0) {
    await query('INSERT INTO coins(user_id, balance) VALUES($1,$2)', [userId, amount]);
  } else {
    await query('UPDATE coins SET balance=balance+$1 WHERE user_id=$2', [amount, userId]);
  }
};

export const canRewardMessage = (userId) => {
  const last = dailyCooldowns[userId] || 0;
  const now = Date.now();
  if (now - last < 60000) return false; // 1分間隔
  dailyCooldowns[userId] = now;
  return true;
};

export const resetDaily = async () => {
  await query('UPDATE coins SET last_daily=NULL');
};

export const handleCommand = async (interaction) => {
  if (interaction.commandName === 'coin_balance') {
    const res = await query('SELECT balance FROM coins WHERE user_id=$1', [interaction.user.id]);
    const balance = res.rows[0]?.balance || 0;
    await interaction.reply({ content: `所持S: ${balance}S`, ephemeral:true });
  }
};
