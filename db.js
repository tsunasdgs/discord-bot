import pkg from 'pg';
const { Pool } = pkg;

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl:{ rejectUnauthorized:false } });

export async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS coins (user_id TEXT PRIMARY KEY, balance INT DEFAULT 0);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS daily_claims (user_id TEXT PRIMARY KEY, last_claim DATE);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS history (
    id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
    amount INT NOT NULL, note TEXT, created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lumma_races (
    id SERIAL PRIMARY KEY, channel_id TEXT, host_id TEXT, race_name TEXT,
    horses TEXT[], created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_closed BOOLEAN DEFAULT FALSE, winner TEXT
  );`);
}

export const getUser = async (uid) => {
  const res = await pool.query('SELECT * FROM coins WHERE user_id=$1',[uid]);
  if(!res.rows.length){
    await pool.query('INSERT INTO coins(user_id) VALUES($1)',[uid]);
    return { user_id: uid, balance:0 };
  }
  return res.rows[0];
};

export const updateCoins = async (uid, amount, type='manual', note='') => {
  const user = await getUser(uid);
  const newBalance = user.balance + amount;
  await pool.query('UPDATE coins SET balance=$1 WHERE user_id=$2',[newBalance,uid]);
  await pool.query('INSERT INTO history(user_id,type,amount,note) VALUES($1,$2,$3,$4)',[uid,type,amount,note]);
  return newBalance;
};
