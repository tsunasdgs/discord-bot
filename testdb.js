import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function test() {
  try {
    const res = await pool.query('SELECT 1');
    console.log(res.rows);
    await pool.end();
  } catch (err) {
    console.error("DB接続エラー:", err);
  }
}

test();
