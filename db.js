// db.js
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render / Neon 向け
});

export async function query(text, params) {
  return pool.query(text, params);
}

// DB初期化
export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coins (
      user_id TEXT PRIMARY KEY,
      balance INT DEFAULT 1000,
      last_daily TIMESTAMP
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
    CREATE TABLE IF NOT EXISTS rumma_races (
      race_id TEXT PRIMARY KEY,
      name TEXT,
      host_id TEXT,
      status TEXT,
      horses JSONB,
      bets JSONB
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS gacha_items (
      id SERIAL PRIMARY KEY,
      name TEXT,
      rarity TEXT
    );
  `);

  console.log("DB initialized");
}
