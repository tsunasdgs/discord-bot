import { pool } from './db.js';

async function createRace(raceId, name, hostId) {
  await pool.query('INSERT INTO rumma_races (race_id,name,host_id,status) VALUES ($1,$2,$3,$4)', [raceId,name,hostId,'open']);
}

async function addHorse(raceId,name) {
  await pool.query('INSERT INTO rumma_horses (race_id,name) VALUES ($1,$2)', [raceId,name]);
}

async function betRace(raceId, horseId, userId, amount) {
  await pool.query('INSERT INTO rumma_bets (race_id,horse_id,user_id,amount) VALUES ($1,$2,$3,$4)', [raceId,horseId,userId,amount]);
  await pool.query('UPDATE users SET coins=coins-$1 WHERE user_id=$2',[amount,userId]);
}

async function declareWinner(raceId, horseId) {
  const bets = await pool.query('SELECT * FROM rumma_bets WHERE race_id=$1', [raceId]);
  const total = bets.rows.reduce((a,b)=>a+b.amount,0);
  const horseTotal = bets.rows.filter(b=>b.horse_id===horseId).reduce((a,b)=>a+b.amount,0);
  const odds = horseTotal>0 ? total/horseTotal : 0;

  for(const b of bets.rows){
    const payout = b.horse_id===horseId?Math.floor(b.amount*odds):0;
    await pool.query('UPDATE users SET coins=coins+$1 WHERE user_id=$2',[payout,b.user_id]);
    await pool.query('UPDATE rumma_bets SET payout=$1 WHERE id=$2',[payout,b.id]);
  }

  await pool.query('UPDATE rumma_races SET status=$1 WHERE race_id=$2',['finished',raceId]);
}

export { createRace, addHorse, betRace, declareWinner };
