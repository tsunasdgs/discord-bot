// coin.js
import { query } from './db.js';

const DAILY_AMOUNT = Number(process.env.DAILY_AMOUNT || 100);
const MESSAGE_AMOUNT = Number(process.env.MESSAGE_AMOUNT || 10);
const MESSAGE_DAILY_LIMIT = Number(process.env.MESSAGE_DAILY_LIMIT || 5);
const FORBIDDEN_WORDS = (process.env.FORBIDDEN_WORDS || '')
  .split(',')
  .map(word => word.trim())
  .filter(Boolean);

// ===== ユーザー取得 or 初期作成 =====
export async function getUser(userId) {
  const res = await query('SELECT * FROM coins WHERE user_id=$1', [userId]);
  if (res.rows.length) return res.rows[0];

  await query('INSERT INTO coins(user_id,balance) VALUES($1,$2)', [userId, 0]);
  return { user_id: userId, balance: 0 };
}

// ===== 残高確認 =====
export async function getBalance(userId) {
  const user = await getUser(userId);
  return user.balance;
}

// ===== コイン更新 =====
export async function updateCoins(userId, amount, type = 'manual', note = '') {
  // balance は増分で更新
  await query(
    `
    INSERT INTO coins(user_id,balance) VALUES($1,$2)
    ON CONFLICT(user_id) DO UPDATE SET balance = coins.balance + EXCLUDED.balance
  `,
    [userId, amount]
  );

  await query(
    `
    INSERT INTO history(user_id,type,amount,note)
    VALUES($1,$2,$3,$4)
  `,
    [userId, type, amount, note]
  );
}

// ===== 発言報酬チェック =====
const messageCooldowns = {};

export async function canRewardMessage(userId, messageContent) {
  const content = messageContent.replace(/\s/g, '');
  if (FORBIDDEN_WORDS.some(word => content.includes(word))) return false;

  const now = Date.now();
  if (messageCooldowns[userId] && now - messageCooldowns[userId] < 60_000) {
    return false; // 1分クールダウン
  }
  messageCooldowns[userId] = now;

  const res = await query(
    `
    SELECT COUNT(*) 
    FROM history 
    WHERE user_id=$1 AND type='message' AND created_at::date = CURRENT_DATE
  `,
    [userId]
  );

  return Number(res.rows[0].count) < MESSAGE_DAILY_LIMIT;
}

// ===== 発言報酬付与 =====
export async function rewardMessage(userId) {
  await updateCoins(userId, MESSAGE_AMOUNT, 'message', '発言報酬');
}

// ===== デイリー報酬 (朝5時リセット対応) =====
export async function claimDaily(userId) {
  // JST で 5時リセットのキーを作成
  const now = new Date();
  const resetHour = 5;
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC→JST
  jst.setHours(jst.getHours() - resetHour);
  const keyDate = jst.toISOString().split('T')[0];

  const res = await query('SELECT last_claim FROM daily_claims WHERE user_id=$1', [userId]);

  if (res.rows.length) {
    const lastClaim = res.rows[0].last_claim?.toISOString().split('T')[0];
    if (lastClaim === keyDate) return false;

    await query('UPDATE daily_claims SET last_claim=$2 WHERE user_id=$1', [userId, keyDate]);
  } else {
    await query('INSERT INTO daily_claims(user_id,last_claim) VALUES($1,$2)', [userId, keyDate]);
  }

  await updateCoins(userId, DAILY_AMOUNT, 'daily', 'デイリー報酬');
  return true;
}

// ===== デイリーリセット（全ユーザー対象） =====
export async function resetDaily() {
  await query('TRUNCATE daily_claims');
}

// ===== ランキング取得（上位N名） =====
export async function getTop(limit = 10) {
  const res = await query('SELECT * FROM coins ORDER BY balance DESC LIMIT $1', [limit]);
  return res.rows;
}

// ===== 取引履歴取得（最新N件） =====
export async function getHistory(limit = 10) {
  const res = await query('SELECT * FROM history ORDER BY created_at DESC LIMIT $1', [limit]);
  return res.rows;
}
