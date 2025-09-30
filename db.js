import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      coins INT DEFAULT 0,
      last_daily TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS history (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      type TEXT,
      amount INT,
      info TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS umas (
      user_id TEXT PRIMARY KEY,
      name TEXT,
      icon TEXT,
      speed INT,
      stamina INT,
      luck INT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gacha_history (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      result TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ssr_roles (
      user_id TEXT PRIMARY KEY,
      role_id TEXT,
      role_name TEXT,
      role_color TEXT,
      expire_at TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rumma_races (
      race_id TEXT PRIMARY KEY,
      name TEXT,
      host_id TEXT,
      status TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rumma_horses (
      id SERIAL PRIMARY KEY,
      race_id TEXT,
      name TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rumma_bets (
      id SERIAL PRIMARY KEY,
      race_id TEXT,
      horse_id INT,
      user_id TEXT,
      amount INT,
      payout INT DEFAULT 0
    );
  `);
}

export { pool, initDB };
