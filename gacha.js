import { pool } from './db.js';

const GACHA_COST = 30;
const PROB = { S:0.7, SR:0.25, SSR:0.05 };
const REWARD = { S:5, SR:10 };

async function rollGacha(userId) {
  const res = await pool.query('SELECT coins FROM users WHERE user_id=$1', [userId]);
  if (!res.rows[0] || res.rows[0].coins < GACHA_COST) return { success:false, message:'コイン不足' };
  await pool.query('UPDATE users SET coins=coins-$1 WHERE user_id=$2', [GACHA_COST,userId]);

  const r = Math.random();
  let result;
  if (r < PROB.S) result='S';
  else if (r < PROB.S+PROB.SR) result='SR';
  else result='SSR';

  if(result==='S' || result==='SR') await pool.query('UPDATE users SET coins=coins+$1 WHERE user_id=$2',[REWARD[result],userId]);
  await pool.query('INSERT INTO gacha_history (user_id,result) VALUES ($1,$2)', [userId,result]);
  return { success:true, result };
}

export { rollGacha, GACHA_COST };
