import pkg from 'pg';
const { Pool } = pkg;
import 'dotenv/config';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// query 関数をエクスポート
export async function query(text, params) {
  return pool.query(text, params);
}

// DB 初期化用関数もあれば
export async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS coins (
      user_id TEXT PRIMARY KEY,
      balance INT DEFAULT 0,
      last_daily TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS umas (
      user_id TEXT PRIMARY KEY,
      name TEXT,
      icon TEXT,
      speed INT,
      stamina INT,
      luck INT
    );
  `);

  // 他のテーブルも同様に作成
}
