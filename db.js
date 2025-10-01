import pkg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pkg;

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

export async function initDB() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS coins (
      user_id TEXT PRIMARY KEY,
      balance BIGINT DEFAULT 0
    );`,
    `CREATE TABLE IF NOT EXISTS daily_claims (
      user_id TEXT PRIMARY KEY,
      last_claim DATE
    );`,
    `CREATE TABLE IF NOT EXISTS history (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES coins(user_id),
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS lumma_races (
      id SERIAL PRIMARY KEY,
      channel_id TEXT,
      host_id TEXT,
      race_name TEXT,
      horses TEXT[],
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_closed BOOLEAN DEFAULT FALSE,
      winner TEXT
    );`,
    `CREATE TABLE IF NOT EXISTS lumma_bets (
      id SERIAL PRIMARY KEY,
      race_id INT NOT NULL REFERENCES lumma_races(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      horse_name TEXT NOT NULL,
      bet_amount BIGINT NOT NULL
    );`
  ];
  for(const q of tables) await pool.query(q);
}

export async function getUser(userId){
  const res = await pool.query('SELECT * FROM coins WHERE user_id=$1',[userId]);
  if(!res.rows.length){
    await pool.query('INSERT INTO coins(user_id) VALUES($1)',[userId]);
    return { user_id:userId, balance:0 };
  }
  return res.rows[0];
}

export async function updateCoins(userId, amount, type='manual', note=''){
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO coins(user_id, balance) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET balance=coins.balance+$2
    `,[userId, amount]);
    await client.query('INSERT INTO history(user_id,type,amount,note) VALUES($1,$2,$3,$4)',[userId,type,amount,note]);
    await client.query('COMMIT');
    const user = await client.query('SELECT * FROM coins WHERE user_id=$1',[userId]);
    return user.rows[0];
  } catch(e){
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
