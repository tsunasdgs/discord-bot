import { pool } from './db.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder } from 'discord.js';

const MAX_STAT = 20;

async function getUMA(userId) {
  const res = await pool.query('SELECT * FROM umas WHERE user_id=$1', [userId]);
  return res.rows[0] || null;
}

async function createUMA(userId, name, icon) {
  await pool.query('INSERT INTO umas (user_id,name,icon,speed,stamina,luck) VALUES ($1,$2,$3,5,5,5)', [userId,name,icon]);
  return await getUMA(userId);
}

async function trainUMA(userId, column) {
  const uma = await getUMA(userId);
  if (!uma) return null;
  const val = uma[column];
  const successRate = Math.max(5, 100 - val*5);
  const success = Math.random()*100 <= successRate;
  if (success) await pool.query(`UPDATE umas SET ${column}=${column}+1 WHERE user_id=$1`, [userId]);
  return success;
}

export { getUMA, createUMA, trainUMA, MAX_STAT };
