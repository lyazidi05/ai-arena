const express = require('express');
const router = express.Router();
const db = require('../db/database');
const {
  getWeightClass, calcBaseStats, generateApiKey,
  resolveAction, calcEloChange, canTrain, calcTrainingGain,
  checkCombo, applyFatigue, currentFatigue,
  WEIGHT_CLASSES, DISCIPLINES, MOVES, COMBOS, TRAINING_COOLDOWN_MS,
  FATIGUE_PER_FIGHT, FATIGUE_PER_TRAIN, FATIGUE_MAX_FIGHT,
  MARKETPLACE,
} = require('../engine/game');

// Middleware auth
function auth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing x-api-key header' });
  const fighter = db.prepare('SELECT * FROM fighters WHERE api_key = ?').get(key);
  if (!fighter) return res.status(401).json({ error: 'Invalid API key' });
  req.fighter = fighter;
  next();
}

// Helper: determine real-time fighter status
function getFighterStatus(fighter) {
  const now = new Date();

  const activeFight = db.prepare(
    "SELECT id FROM fights WHERE (fighter1_id = ? OR fighter2_id = ?) AND status = 'active'"
  ).get(fighter.id, fighter.id);
  if (activeFight) return { status: 'fighting', detail: 'En combat', fight_id: activeFight.id, color: 'red' };

  const openChallenge = db.prepare(
    "SELECT id FROM challenges WHERE challenger_id = ? AND status = 'open'"
  ).get(fighter.id);
  if (openChallenge) return { status: 'looking', detail: 'Cherche un combat', color: 'yellow' };

  if (fighter.last_trained_at) {
    const lastTrain = new Date(fighter.last_trained_at * 1000);
    const minutesAgo = (now - lastTrain) / (1000 * 60);
    if (minutesAgo < 5) {
      const lastTraining = db.prepare(
        'SELECT stat FROM training_log WHERE fighter_id = ? ORDER BY id DESC LIMIT 1'
      ).get(fighter.id);
      const stat = lastTraining ? lastTraining.stat : 'stats';
      return { status: 'training', detail: 'Entraine ' + stat, color: 'blue' };
    }
  }

  const lastActive = fighter.last_fight_at ? new Date(fighter.last_fight_at * 1000) : new Date(0);
  const hoursAgo = (now - lastActive) / (1000 * 60 * 60);
  if (hoursAgo > 2) return { status: 'offline', detail: 'Inactif ' + Math.floor(hoursAgo) + 'h', color: 'gray' };

  return { status: 'idle', detail: 'Repos', color: 'green' };
}

// Helper: award Arena Coins to a fighter wallet
function awardCoins(fighterId, amount, description) {
  const wallet = db.prepare('SELECT balance FROM fighter_wallets WHERE fighter_id = ?').get(fighterId);
  if (!wallet) return;
  const newBalance = wallet.balance + amount;
  db.prepare('UPDATE fighter_wallets SET balance = ?, total_earned = total_earned + ? WHERE fighter_id = ?').run(newBalance, amount, fighterId);
  db.prepare('INSERT INTO transactions (fighter_id, type, amount, description, balance_after) VALUES (?, ?, ?, ?, ?)').run(fighterId, 'fight_reward', amount, description, newBalance);
}

// POST /register
router.post('/register', (req, res) => {
  const { name, height_cm, weight_kg, discipline } = req.body;
  if (!name || !height_cm || !weight_kg || !discipline) {
    return res.status(400).json({ error: 'name, height_cm, weight_kg, discipline required' });
  }
  if (!DISCIPLINES[discipline]) {
    return res.status(400).json({ error: `Invalid discipline. Choose: ${Object.keys(DISCIPLINES).join(', ')}` });
  }
  if (height_cm < 140 || height_cm > 220) {
    return res.status(400).json({ error: 'height_cm must be between 140 and 220' });
  }
  if (weight_kg < 40 || weight_kg > 130) {
    return res.status(400).json({ error: 'weight_kg must be between 40 and 130' });
  }

  const existing = db.prepare('SELECT id FROM fighters WHERE name = ?').get(name);
  if (existing) return res.status(409).json({ error: 'Fighter name already taken' });

  const api_key = generateApiKey();
  const weight_class = getWeightClass(weight_kg);
  const stats = calcBaseStats(height_cm, weight_kg, discipline);

  const insertFighter = db.prepare(`
    INSERT INTO fighters (api_key, name, height_cm, weight_kg, discipline, weight_class,
      power, speed, agility, striking, grappling, endurance, reach)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insertFighter.run(api_key, name, height_cm, weight_kg, discipline, weight_class,
    stats.power, stats.speed, stats.agility, stats.striking, stats.grappling, stats.endurance, stats.reach);
  const newId = result.lastInsertRowid;
  db.prepare('INSERT INTO fighter_wallets (fighter_id, balance) VALUES (?, 100)').run(newId);
  db.prepare('INSERT INTO transactions (fighter_id, type, amount, description, balance_after) VALUES (?, ?, ?, ?, ?)').run(newId, 'welcome_bonus', 100, 'Bonus de bienvenue', 100);

  res.json({
    message: `Welcome to Clash of Agents, ${name}!`,
    api_key,
    fighter: {
      name, height_cm, weight_kg, discipline, weight_class,
      ...stats, elo: 1000
    }
  });
});

// GET /me
router.get('/me', auth, (req, res) => {
  const f = req.fighter;
  const fights = db.prepare(`
    SELECT COUNT(*) as total FROM fights
    WHERE (fighter1_id = ? OR fighter2_id = ?) AND status = 'finished'
  `).get(f.id, f.id);

  const fatigue = currentFatigue(f);
  const fatigued = applyFatigue({ ...f, fatigue });
  res.json({
    id: f.id,
    name: f.name,
    discipline: f.discipline,
    weight_class: f.weight_class,
    height_cm: f.height_cm,
    weight_kg: f.weight_kg,
    elo: f.elo,
    record: { wins: f.wins, losses: f.losses, draws: f.draws, ko_wins: f.ko_wins, submission_wins: f.submission_wins },
    stats: { power: f.power, speed: f.speed, agility: f.agility, striking: f.striking, grappling: f.grappling, endurance: f.endurance, reach: f.reach },
    effective_stats: { power: fatigued.power, speed: fatigued.speed, agility: fatigued.agility, striking: fatigued.striking, grappling: fatigued.grappling, endurance: fatigued.endurance },
    fatigue,
    can_fight: fatigue < FATIGUE_MAX_FIGHT,
    training_cooldown_remaining_ms: Math.max(0, TRAINING_COOLDOWN_MS - (Date.now() - f.last_trained_at * 1000)),
    can_train: canTrain(f),
  });
});

// POST /train
router.post('/train', auth, (req, res) => {
  const { stat } = req.body;
  const validStats = ['power', 'speed', 'agility', 'striking', 'grappling', 'endurance'];
  if (!validStats.includes(stat)) {
    return res.status(400).json({ error: `Invalid stat. Choose: ${validStats.join(', ')}` });
  }
  if (!canTrain(req.fighter)) {
    const remaining = TRAINING_COOLDOWN_MS - (Date.now() - req.fighter.last_trained_at * 1000);
    return res.status(429).json({ error: 'Training cooldown active', remaining_ms: remaining });
  }

  const gain = calcTrainingGain(stat, req.fighter);
  const nowSec = Math.floor(Date.now() / 1000);
  const newFatigue = Math.min(100, currentFatigue(req.fighter) + FATIGUE_PER_TRAIN);

  db.prepare(`UPDATE fighters SET ${stat} = ${stat} + ?, last_trained_at = ?, fatigue = ? WHERE id = ?`)
    .run(gain, nowSec, newFatigue, req.fighter.id);
  db.prepare('INSERT INTO training_log (fighter_id, stat, gain) VALUES (?, ?, ?)')
    .run(req.fighter.id, stat, gain);

  const updated = db.prepare('SELECT * FROM fighters WHERE id = ?').get(req.fighter.id);
  res.json({
    message: `Training complete! ${stat} increased by ${gain}`,
    stat,
    gain,
    new_value: updated[stat],
    fatigue: newFatigue,
    next_training_available_in_ms: TRAINING_COOLDOWN_MS,
  });
});

// GET /leaderboard
router.get('/leaderboard', (req, res) => {
  const fighters = db.prepare(`
    SELECT * FROM fighters ORDER BY elo DESC LIMIT 50
  `).all();
  const leaderboard = fighters.map(f => ({
    name: f.name,
    discipline: f.discipline,
    weight_class: f.weight_class,
    elo: f.elo,
    wins: f.wins,
    losses: f.losses,
    draws: f.draws,
    ko_wins: f.ko_wins,
    submission_wins: f.submission_wins,
    status: getFighterStatus(f),
  }));
  res.json({ leaderboard });
});

// GET /leaderboard/champions
router.get('/leaderboard/champions', (req, res) => {
  const champions = {};
  for (const wc of WEIGHT_CLASSES) {
    const champ = db.prepare(`
      SELECT name, discipline, elo, wins, losses, ko_wins, submission_wins
      FROM fighters WHERE weight_class = ? AND wins > 0
      ORDER BY elo DESC LIMIT 1
    `).get(wc.name);
    if (champ) champions[wc.name] = champ;
  }
  res.json({ champions });
});

// POST /challenge
router.post('/challenge', auth, (req, res) => {
  const { target_name } = req.body;
  let target_id = null;

  if (target_name) {
    const target = db.prepare('SELECT id, name, weight_class FROM fighters WHERE name = ?').get(target_name);
    if (!target) return res.status(404).json({ error: 'Fighter not found' });
    if (target.id === req.fighter.id) return res.status(400).json({ error: 'Cannot challenge yourself' });
    target_id = target.id;
  }

  const result = db.prepare('INSERT INTO challenges (challenger_id, target_id) VALUES (?, ?)')
    .run(req.fighter.id, target_id);

  res.json({
    challenge_id: result.lastInsertRowid,
    message: target_name ? `Challenge sent to ${target_name}` : 'Open challenge posted to the arena!',
  });
});

// POST /challenge/:id/accept
router.post('/challenge/:id/accept', auth, (req, res) => {
  const challenge = db.prepare('SELECT * FROM challenges WHERE id = ? AND status = ?').get(req.params.id, 'open');
  if (!challenge) return res.status(404).json({ error: 'Challenge not found or already accepted' });
  if (challenge.challenger_id === req.fighter.id) return res.status(400).json({ error: 'Cannot accept your own challenge' });
  if (challenge.target_id && challenge.target_id !== req.fighter.id) {
    return res.status(403).json({ error: 'This challenge was not directed at you' });
  }

  const f1 = db.prepare('SELECT * FROM fighters WHERE id = ?').get(challenge.challenger_id);
  const f2 = req.fighter;

  // Block exhausted fighters
  const f1Fatigue = currentFatigue(f1);
  const f2Fatigue = currentFatigue(f2);
  if (f1Fatigue >= FATIGUE_MAX_FIGHT) {
    return res.status(400).json({ error: `${f1.name} is too exhausted to fight (fatigue: ${f1Fatigue}/100). Rest first.` });
  }
  if (f2Fatigue >= FATIGUE_MAX_FIGHT) {
    return res.status(400).json({ error: `${f2.name} is too exhausted to fight (fatigue: ${f2Fatigue}/100). Rest first.` });
  }

  const fightResult = db.prepare(`
    INSERT INTO fights (fighter1_id, fighter2_id, status, current_turn)
    VALUES (?, ?, 'active', ?)
  `).run(f1.id, f2.id, f1.id.toString());

  db.prepare('UPDATE challenges SET status = ?, fight_id = ? WHERE id = ?')
    .run('accepted', fightResult.lastInsertRowid, challenge.id);

  res.json({
    fight_id: fightResult.lastInsertRowid,
    message: `Fight started: ${f1.name} vs ${f2.name}!`,
    fighter1: f1.name,
    fighter2: f2.name,
  });
});

// GET /fighters/statuses — real-time status of all fighters (must be before /:name)
router.get('/fighters/statuses', (req, res) => {
  const fighters = db.prepare('SELECT * FROM fighters ORDER BY elo DESC').all();
  res.json({ statuses: fighters.map(f => ({ id: f.id, name: f.name, ...getFighterStatus(f) })) });
});

// GET /fighters/:name — public profile
router.get('/fighters/:name', (req, res) => {
  const f = db.prepare('SELECT * FROM fighters WHERE name = ?').get(req.params.name);
  if (!f) return res.status(404).json({ error: 'Fighter not found' });
  const fatigue = currentFatigue(f);
  res.json({
    id: f.id, name: f.name, discipline: f.discipline, weight_class: f.weight_class,
    height_cm: f.height_cm, weight_kg: f.weight_kg, reach: f.reach, elo: f.elo,
    wins: f.wins, losses: f.losses, draws: f.draws, ko_wins: f.ko_wins, submission_wins: f.submission_wins,
    power: f.power, speed: f.speed, agility: f.agility, striking: f.striking, grappling: f.grappling, endurance: f.endurance,
    fatigue,
    can_fight: fatigue < FATIGUE_MAX_FIGHT,
  });
});

// GET /fighters/:name/fights — fight history
router.get('/fighters/:name/fights', (req, res) => {
  const f = db.prepare('SELECT id FROM fighters WHERE name = ?').get(req.params.name);
  if (!f) return res.status(404).json({ error: 'Fighter not found' });
  const fights = db.prepare(`
    SELECT fi.id, fi.status, fi.end_method, fi.current_round, fi.winner_id,
      f1.name as fighter1_name, f2.name as fighter2_name, fi.fighter1_id, fi.fighter2_id
    FROM fights fi
    JOIN fighters f1 ON fi.fighter1_id = f1.id
    JOIN fighters f2 ON fi.fighter2_id = f2.id
    WHERE (fi.fighter1_id = ? OR fi.fighter2_id = ?) AND fi.status = 'finished'
    ORDER BY fi.id DESC LIMIT 20
  `).all(f.id, f.id);
  res.json({ fights: fights.map(fi => ({
    fight_id: fi.id,
    opponent: fi.fighter1_id === f.id ? fi.fighter2_name : fi.fighter1_name,
    result: fi.winner_id === f.id ? 'W' : (fi.winner_id ? 'L' : 'D'),
    method: fi.end_method,
    round: fi.current_round,
  }))});
});

// GET /fighters/:name/rivals
router.get('/fighters/:name/rivals', (req, res) => {
  const f = db.prepare('SELECT id FROM fighters WHERE name = ?').get(req.params.name);
  if (!f) return res.status(404).json({ error: 'Fighter not found' });

  const rows = db.prepare(`
    SELECT r.*, fa.name as fighter_a_name, fb.name as fighter_b_name
    FROM rivalries r
    JOIN fighters fa ON r.fighter_a_id = fa.id
    JOIN fighters fb ON r.fighter_b_id = fb.id
    WHERE (r.fighter_a_id = ? OR r.fighter_b_id = ?) AND r.total_fights >= 2
    ORDER BY r.total_fights DESC
  `).all(f.id, f.id);

  const rivals = rows.map(r => {
    const isA = r.fighter_a_id === f.id;
    return {
      opponent: isA ? r.fighter_b_name : r.fighter_a_name,
      total_fights: r.total_fights,
      my_wins: isA ? r.fighter_a_wins : r.fighter_b_wins,
      their_wins: isA ? r.fighter_b_wins : r.fighter_a_wins,
      is_rivalry: r.is_rivalry === 1,
    };
  });

  res.json({ rivals });
});

// GET /fighters/:name/stats — advanced statistics
router.get('/fighters/:name/stats', (req, res) => {
  const f = db.prepare('SELECT * FROM fighters WHERE name = ?').get(req.params.name);
  if (!f) return res.status(404).json({ error: 'Fighter not found' });

  // ELO history (last 30 entries)
  const eloHistory = db.prepare(`
    SELECT eh.elo, eh.recorded_at, eh.fight_id
    FROM elo_history eh WHERE eh.fighter_id = ? ORDER BY eh.id ASC LIMIT 30
  `).all(f.id).map(r => ({
    elo: r.elo,
    date: new Date(r.recorded_at * 1000).toISOString().slice(0, 10),
    fight_id: r.fight_id,
  }));

  // Win/loss breakdown by end method
  const finishedFights = db.prepare(`
    SELECT fi.end_method, fi.winner_id,
      op.discipline as opp_discipline
    FROM fights fi
    JOIN fighters op ON (CASE WHEN fi.fighter1_id = ? THEN fi.fighter2_id ELSE fi.fighter1_id END) = op.id
    WHERE (fi.fighter1_id = ? OR fi.fighter2_id = ?) AND fi.status = 'finished'
  `).all(f.id, f.id, f.id);

  const winRateByDiscipline = {};
  const methodCounts = { ko: 0, tko: 0, submission: 0, decision: 0 };
  let totalFinished = finishedFights.length;

  for (const fi of finishedFights) {
    const won = fi.winner_id === f.id;
    const disc = fi.opp_discipline;
    if (!winRateByDiscipline[disc]) winRateByDiscipline[disc] = { wins: 0, total: 0 };
    winRateByDiscipline[disc].total++;
    if (won) winRateByDiscipline[disc].wins++;
    if (won && fi.end_method) methodCounts[fi.end_method] = (methodCounts[fi.end_method] || 0) + 1;
  }

  const winRateMap = {};
  for (const [d, v] of Object.entries(winRateByDiscipline)) {
    winRateMap[d] = v.total > 0 ? Math.round((v.wins / v.total) * 100) / 100 : 0;
  }

  // Most used moves
  const moveRows = db.prepare(`
    SELECT action, COUNT(*) as cnt FROM fight_actions
    WHERE fighter_id = ? GROUP BY action ORDER BY cnt DESC LIMIT 8
  `).all(f.id);

  // Most effective move (avg damage dealt, min 3 uses)
  const effectiveRows = db.prepare(`
    SELECT action, AVG(damage_dealt) as avg_dmg, COUNT(*) as cnt
    FROM fight_actions WHERE fighter_id = ? AND damage_dealt > 0
    GROUP BY action HAVING cnt >= 3 ORDER BY avg_dmg DESC LIMIT 1
  `).all(f.id);

  // Avg damage per action across all fights
  const dmgStats = db.prepare(`
    SELECT AVG(damage_dealt) as avg_dmg,
           COUNT(*) as total_actions,
           SUM(CASE WHEN is_critical THEN 1 ELSE 0 END) as crits
    FROM fight_actions WHERE fighter_id = ?
  `).get(f.id);

  // Average fight duration in rounds
  const roundStats = db.prepare(`
    SELECT AVG(current_round) as avg_round FROM fights
    WHERE (fighter1_id = ? OR fighter2_id = ?) AND status = 'finished'
  `).get(f.id, f.id);

  const koRate = totalFinished > 0 ? Math.round(((methodCounts.ko + methodCounts.tko) / totalFinished) * 100) / 100 : 0;
  const subRate = totalFinished > 0 ? Math.round((methodCounts.submission / totalFinished) * 100) / 100 : 0;

  res.json({
    elo_history: eloHistory,
    win_rate_by_discipline: winRateMap,
    avg_damage_per_action: Math.round((dmgStats?.avg_dmg || 0) * 10) / 10,
    avg_fight_duration_rounds: Math.round((roundStats?.avg_round || 0) * 10) / 10,
    ko_rate: koRate,
    submission_rate: subRate,
    most_used_moves: moveRows.map(r => ({ move: r.action, count: r.cnt })),
    most_effective_move: effectiveRows[0] ? { move: effectiveRows[0].action, avg_damage: Math.round(effectiveRows[0].avg_dmg * 10) / 10 } : null,
    total_actions: dmgStats?.total_actions || 0,
    critical_hit_count: dmgStats?.crits || 0,
    win_by_method: methodCounts,
  });
});

// GET /fighters/:name/activity — current status + training history + cooldown
router.get('/fighters/:name/activity', (req, res) => {
  const f = db.prepare('SELECT * FROM fighters WHERE name = ?').get(req.params.name);
  if (!f) return res.status(404).json({ error: 'Fighter not found' });

  // Current status
  const activeFight = db.prepare(`
    SELECT id FROM fights
    WHERE (fighter1_id = ? OR fighter2_id = ?) AND status IN ('active','pending')
    LIMIT 1
  `).get(f.id, f.id);

  const nowSec = Math.floor(Date.now() / 1000);
  const fatigue = currentFatigue(f);
  const lastTrainedAt = f.last_trained_at || 0;
  const cooldownMs = TRAINING_COOLDOWN_MS;
  const elapsedMs = (nowSec - lastTrainedAt) * 1000;
  const remainingMs = Math.max(0, cooldownMs - elapsedMs);

  let status = 'resting';
  if (activeFight) status = 'fighting';
  else if (remainingMs > 0 && lastTrainedAt > 0) status = 'recovering';

  // Last 5 training sessions
  const trainLog = db.prepare(`
    SELECT stat, gain, created_at FROM training_log
    WHERE fighter_id = ? ORDER BY id DESC LIMIT 5
  `).all(f.id).map(r => ({
    stat: r.stat,
    gain: Math.round(r.gain * 100) / 100,
    date: new Date(r.created_at * 1000).toISOString(),
  }));

  res.json({
    status,
    fight_id: activeFight?.id || null,
    fatigue: Math.round(fatigue),
    can_train: remainingMs === 0,
    cooldown_remaining_ms: Math.round(remainingMs),
    last_trained_at: lastTrainedAt > 0 ? new Date(lastTrainedAt * 1000).toISOString() : null,
    training_log: trainLog,
  });
});

// GET /fighters/:id/activity — detailed activity (by numeric id)
router.get('/fighters/:id/activity', (req, res) => {
  const f = db.prepare('SELECT * FROM fighters WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Fighter not found' });

  const recentTraining = db.prepare(
    'SELECT stat as stat_trained, gain as points_gained, created_at FROM training_log WHERE fighter_id = ? ORDER BY id DESC LIMIT 5'
  ).all(req.params.id);

  const nowMs = Date.now();
  const lastTrainMs = f.last_trained_at ? f.last_trained_at * 1000 : 0;
  const canTrainNow = !f.last_trained_at || (nowMs - lastTrainMs) >= TRAINING_COOLDOWN_MS;
  const minutesUntilTrain = !canTrainNow ? Math.max(0, Math.ceil((TRAINING_COOLDOWN_MS - (nowMs - lastTrainMs)) / 60000)) : 0;

  res.json({
    status: getFighterStatus(f),
    fatigue: currentFatigue(f),
    training: {
      can_train: canTrainNow,
      minutes_until_next: minutesUntilTrain,
      recent_sessions: recentTraining,
    }
  });
});

// GET /rivalries — all confirmed rivalries
router.get('/rivalries', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, fa.name as fighter_a_name, fa.elo as fighter_a_elo,
           fb.name as fighter_b_name, fb.elo as fighter_b_elo
    FROM rivalries r
    JOIN fighters fa ON r.fighter_a_id = fa.id
    JOIN fighters fb ON r.fighter_b_id = fb.id
    WHERE r.is_rivalry = 1
    ORDER BY r.total_fights DESC
  `).all();
  res.json({ rivalries: rows });
});

// GET /fights/recent — last 20 finished fights
router.get('/fights/recent', (req, res) => {
  const fights = db.prepare(`
    SELECT f.id, f.current_round, f.max_rounds, f.fighter1_hp, f.fighter2_hp, f.status,
      f.end_method, f.winner_id,
      f1.id as fighter1_id, f1.name as fighter1_name, f1.elo as fighter1_elo, f1.discipline as fighter1_discipline,
      f2.id as fighter2_id, f2.name as fighter2_name, f2.elo as fighter2_elo, f2.discipline as fighter2_discipline
    FROM fights f
    JOIN fighters f1 ON f.fighter1_id = f1.id
    JOIN fighters f2 ON f.fighter2_id = f2.id
    WHERE f.status = 'finished'
    ORDER BY f.id DESC LIMIT 20
  `).all();
  const annotated = fights.map(f => {
    const [rA, rB] = [Math.min(f.fighter1_id, f.fighter2_id), Math.max(f.fighter1_id, f.fighter2_id)];
    const r = db.prepare('SELECT is_rivalry FROM rivalries WHERE fighter_a_id = ? AND fighter_b_id = ?').get(rA, rB);
    return { ...f, is_rivalry: r?.is_rivalry === 1 };
  });
  res.json({ recent_fights: annotated, count: annotated.length });
});

// GET /fight/:id
router.get('/fight/:id', (req, res) => {
  const fight = db.prepare('SELECT * FROM fights WHERE id = ?').get(req.params.id);
  if (!fight) return res.status(404).json({ error: 'Fight not found' });

  const f1 = db.prepare('SELECT id, name, discipline, elo FROM fighters WHERE id = ?').get(fight.fighter1_id);
  const f2 = db.prepare('SELECT id, name, discipline, elo FROM fighters WHERE id = ?').get(fight.fighter2_id);
  const actions = db.prepare('SELECT * FROM fight_actions WHERE fight_id = ? ORDER BY id ASC').all(fight.id);
  const messages = db.prepare(`
    SELECT sm.id, sm.message, sm.sender_type, sm.created_at,
      COALESCE(sm.sender_name, f.name, 'Spectator') as author
    FROM spectator_messages sm
    LEFT JOIN fighters f ON sm.fighter_id = f.id
    WHERE sm.fight_id = ? ORDER BY sm.id ASC LIMIT 60
  `).all(fight.id);

  let winner_name = null;
  if (fight.winner_id) {
    const w = db.prepare('SELECT name FROM fighters WHERE id = ?').get(fight.winner_id);
    winner_name = w?.name;
  }

  // Bets summary
  const bets = db.prepare("SELECT b.bettor_name, b.amount, b.odds, b.status, b.payout, f.name as fighter_name FROM bets b JOIN fighters f ON b.fighter_id = f.id WHERE b.fight_id = ?").all(fight.id);
  const betPool = bets.reduce((s, b) => s + b.amount, 0);

  // Rivalry check
  const [rA, rB] = [Math.min(fight.fighter1_id, fight.fighter2_id), Math.max(fight.fighter1_id, fight.fighter2_id)];
  const rivalryRow = db.prepare('SELECT * FROM rivalries WHERE fighter_a_id = ? AND fighter_b_id = ?').get(rA, rB);

  res.json({
    fight_id: fight.id,
    status: fight.status,
    current_round: fight.current_round,
    max_rounds: fight.max_rounds,
    current_turn: fight.current_turn,
    is_title_fight: fight.is_title_fight === 1,
    is_rivalry: rivalryRow?.is_rivalry === 1,
    rivalry_fights: rivalryRow?.total_fights ?? 0,
    fighter1: { id: fight.fighter1_id, ...f1, hp: fight.fighter1_hp, stamina: fight.fighter1_stamina },
    fighter2: { id: fight.fighter2_id, ...f2, hp: fight.fighter2_hp, stamina: fight.fighter2_stamina },
    winner: winner_name,
    end_method: fight.end_method,
    actions: actions.slice(-20),
    spectator_messages: messages,
    bets, bet_pool: betPool,
  });
});

// POST /fight/:id/action
router.post('/fight/:id/action', auth, (req, res) => {
  const fight = db.prepare('SELECT * FROM fights WHERE id = ?').get(req.params.id);
  if (!fight) return res.status(404).json({ error: 'Fight not found' });
  if (fight.status !== 'active') return res.status(400).json({ error: 'Fight is not active' });

  const isF1 = fight.fighter1_id === req.fighter.id;
  const isF2 = fight.fighter2_id === req.fighter.id;
  if (!isF1 && !isF2) return res.status(403).json({ error: 'You are not in this fight' });

  const myTurn = fight.current_turn === req.fighter.id.toString();
  if (!myTurn) return res.status(400).json({ error: 'Not your turn' });

  const { move } = req.body;
  if (!MOVES[move]) {
    return res.status(400).json({ error: `Invalid move. Valid: ${Object.keys(MOVES).join(', ')}` });
  }

  const attacker = req.fighter;
  const defenderId = isF1 ? fight.fighter2_id : fight.fighter1_id;
  const defender = db.prepare('SELECT * FROM fighters WHERE id = ?').get(defenderId);

  const attackerHp = isF1 ? fight.fighter1_hp : fight.fighter2_hp;
  const defenderHp = isF1 ? fight.fighter2_hp : fight.fighter1_hp;
  const attackerStamina = isF1 ? fight.fighter1_stamina : fight.fighter2_stamina;
  const defenderStamina = isF1 ? fight.fighter2_stamina : fight.fighter1_stamina;

  // Auto-defend if timeout (30s)
  const timeSinceLastAction = Date.now() / 1000 - fight.last_action_at;
  const defenderMove = timeSinceLastAction > 30 ? 'block' : null;

  // Apply fatigue penalty to effective stats
  const attackerWithHp = applyFatigue({ ...attacker, hp: attackerHp, stamina: attackerStamina, fatigue: currentFatigue(attacker) });
  const defenderWithHp = applyFatigue({ ...defender, hp: defenderHp, stamina: defenderStamina, fatigue: currentFatigue(defender) });

  const result = resolveAction(attackerWithHp, move, defenderWithHp, defenderMove || 'none');
  const moveData = MOVES[move];

  // ── Combo tracking ──
  const movesCol = isF1 ? 'last_moves_f1' : 'last_moves_f2';
  const rawMoves = fight[movesCol] || '';
  let lastMoves = rawMoves ? rawMoves.split(',') : [];

  let comboHit = null;
  const hitLanded = !result.blocked && result.damage > 0 && moveData.type !== 'defense';

  if (hitLanded) {
    lastMoves.push(move);
    if (lastMoves.length > 3) lastMoves = lastMoves.slice(-3);
    comboHit = checkCombo(lastMoves);
    if (comboHit) {
      result.damage = Math.round(result.damage * comboHit.bonus * 10) / 10;
    }
  } else {
    lastMoves = []; // reset on miss/block
  }

  const newMovesStr = lastMoves.join(',');

  const newAttackerStamina = Math.max(0, Math.min(100, attackerStamina - moveData.staminaCost + 2));
  let newDefenderHp = Math.max(0, defenderHp - result.damage);

  // Determine action count for turn tracking
  const actionCount = db.prepare('SELECT COUNT(*) as cnt FROM fight_actions WHERE fight_id = ? AND round = ?')
    .get(fight.id, fight.current_round).cnt;

  let resultText = result.resultText ||
    (result.submission ? `SUBMISSION! ${attacker.name} locks in the ${move}!` :
    result.blocked ? `${defender.name} defends!` :
    result.isCritical ? `CRITICAL! ${attacker.name} lands a devastating ${move} for ${result.damage} damage!` :
    `${attacker.name} throws a ${move} for ${result.damage} damage`);

  if (comboHit) {
    resultText += ` 🔥 COMBO! ${comboHit.name}! (×${comboHit.bonus})`;
  }

  db.prepare(`
    INSERT INTO fight_actions (fight_id, round, turn, fighter_id, action, damage_dealt, is_critical, result_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(fight.id, fight.current_round, actionCount + 1, attacker.id, move, result.damage, result.isCritical ? 1 : 0, resultText);

  // Check KO/Submission
  let fightOver = false;
  let endMethod = null;
  if (newDefenderHp <= 0) {
    fightOver = true;
    endMethod = result.submission ? 'submission' : (result.damage >= 20 ? 'ko' : 'tko');
    newDefenderHp = 0;
  }

  // Update fight state
  const newTurn = defenderId.toString();
  let newRound = fight.current_round;
  let newF1Hp = isF1 ? attackerHp : newDefenderHp;
  let newF2Hp = isF1 ? newDefenderHp : attackerHp;
  let newF1Stamina = isF1 ? newAttackerStamina : defenderStamina;
  let newF2Stamina = isF1 ? defenderStamina : newAttackerStamina;

  // Round management: every 10 actions = new round
  if ((actionCount + 1) % 10 === 0 && !fightOver) {
    newRound++;
    newF1Stamina = Math.min(100, newF1Stamina + 10);
    newF2Stamina = Math.min(100, newF2Stamina + 10);

    if (newRound > fight.max_rounds) {
      // Decision
      fightOver = true;
      endMethod = 'decision';
    }
  }

  if (fightOver) {
    const winnerId = endMethod === 'decision'
      ? (newF1Hp >= newF2Hp ? fight.fighter1_id : fight.fighter2_id)
      : attacker.id;
    const loserId = winnerId === fight.fighter1_id ? fight.fighter2_id : fight.fighter1_id;

    const winner = db.prepare('SELECT * FROM fighters WHERE id = ?').get(winnerId);
    const loser  = db.prepare('SELECT * FROM fighters WHERE id = ?').get(loserId);
    const elo = calcEloChange(winner, loser, endMethod);

    // Add fatigue to both fighters after combat
    const nowFightSec = Math.floor(Date.now() / 1000);
    const newWinnerFatigue = Math.min(100, currentFatigue(winner) + FATIGUE_PER_FIGHT);
    const newLoserFatigue  = Math.min(100, currentFatigue(loser)  + FATIGUE_PER_FIGHT);

    db.prepare(`UPDATE fighters SET elo = elo + ?, wins = wins + 1,
      ko_wins = ko_wins + ?, submission_wins = submission_wins + ?,
      fatigue = ?, last_fight_at = ? WHERE id = ?`)
      .run(elo.winnerGain, endMethod === 'ko' || endMethod === 'tko' ? 1 : 0, endMethod === 'submission' ? 1 : 0,
           newWinnerFatigue, nowFightSec, winnerId);
    db.prepare('UPDATE fighters SET elo = elo - ?, losses = losses + 1, fatigue = ?, last_fight_at = ? WHERE id = ?')
      .run(elo.loserLoss, newLoserFatigue, nowFightSec, loserId);

    db.prepare(`UPDATE fights SET status = 'finished', winner_id = ?, end_method = ?,
      fighter1_hp = ?, fighter2_hp = ?, fighter1_stamina = ?, fighter2_stamina = ?,
      ${movesCol} = ? WHERE id = ?`)
      .run(winnerId, endMethod, newF1Hp, newF2Hp, newF1Stamina, newF2Stamina, newMovesStr, fight.id);

    // ── Award Arena Coins to winner ──
    {
      let coinReward = 50;
      let coinDesc = 'Victoire';
      if (endMethod === 'ko' || endMethod === 'tko') { coinReward += 20; coinDesc = 'Victoire par KO/TKO'; }
      else if (endMethod === 'submission') { coinReward += 15; coinDesc = 'Victoire par soumission'; }
      awardCoins(winnerId, coinReward, coinDesc);
    }

    // ── Settle bets ──
    {
      const pendingBets = db.prepare("SELECT * FROM bets WHERE fight_id = ? AND status = 'pending'").all(fight.id);
      for (const bet of pendingBets) {
        if (bet.fighter_id === winnerId) {
          const payout = Math.round(bet.amount * bet.odds);
          db.prepare("UPDATE bets SET status = 'won', payout = ? WHERE id = ?").run(payout, bet.id);
          db.prepare("UPDATE wallets SET balance = balance + ?, total_won = total_won + ? WHERE owner_name = ?")
            .run(payout, payout - bet.amount, bet.bettor_name);
        } else {
          db.prepare("UPDATE bets SET status = 'lost' WHERE id = ?").run(bet.id);
          db.prepare("UPDATE wallets SET total_lost = total_lost + ? WHERE owner_name = ?")
            .run(bet.amount, bet.bettor_name);
        }
      }
    }

    // ── Record ELO history ──
    const fightIdForHistory = fight.id;
    const newWinnerElo = winner.elo + elo.winnerGain;
    const newLoserElo  = loser.elo  - elo.loserLoss;
    db.prepare('INSERT INTO elo_history (fighter_id, elo, fight_id) VALUES (?, ?, ?)')
      .run(winnerId, newWinnerElo, fightIdForHistory);
    db.prepare('INSERT INTO elo_history (fighter_id, elo, fight_id) VALUES (?, ?, ?)')
      .run(loserId, newLoserElo, fightIdForHistory);

    // ── Update rivalry record ──
    const [rivalA, rivalB] = [Math.min(winnerId, loserId), Math.max(winnerId, loserId)];
    const existing = db.prepare('SELECT * FROM rivalries WHERE fighter_a_id = ? AND fighter_b_id = ?').get(rivalA, rivalB);
    const aWon = winnerId === rivalA ? 1 : 0;
    if (!existing) {
      db.prepare(`INSERT INTO rivalries (fighter_a_id, fighter_b_id, total_fights, fighter_a_wins, fighter_b_wins, is_rivalry)
                  VALUES (?, ?, 1, ?, ?, 0)`)
        .run(rivalA, rivalB, aWon, 1 - aWon);
    } else {
      const newTotal = existing.total_fights + 1;
      db.prepare(`UPDATE rivalries SET total_fights = ?, fighter_a_wins = fighter_a_wins + ?,
                  fighter_b_wins = fighter_b_wins + ?, is_rivalry = ? WHERE fighter_a_id = ? AND fighter_b_id = ?`)
        .run(newTotal, aWon, 1 - aWon, newTotal >= 3 ? 1 : 0, rivalA, rivalB);

      // Rivalry bonus ELO (+15) to winner when is_rivalry is newly achieved
      if (newTotal === 3) {
        db.prepare('UPDATE fighters SET elo = elo + 15 WHERE id = ?').run(winnerId);
        elo.winnerGain += 15;
      }
    }

    const winnerName = db.prepare('SELECT name FROM fighters WHERE id = ?').get(winnerId).name;
    const rivalryRow = db.prepare('SELECT * FROM rivalries WHERE fighter_a_id = ? AND fighter_b_id = ?').get(rivalA, rivalB);
    const isRivalry = rivalryRow?.is_rivalry === 1;

    return res.json({
      fight_over: true,
      winner: winnerName,
      end_method: endMethod,
      action_result: resultText,
      elo_change: { winner: `+${elo.winnerGain}`, loser: `-${elo.loserLoss}` },
      is_rivalry: isRivalry,
      rivalry_total_fights: rivalryRow?.total_fights ?? 1,
    });
  }

  db.prepare(`UPDATE fights SET current_turn = ?, current_round = ?,
    fighter1_hp = ?, fighter2_hp = ?, fighter1_stamina = ?, fighter2_stamina = ?,
    ${movesCol} = ?, last_action_at = strftime('%s','now') WHERE id = ?`)
    .run(newTurn, newRound, newF1Hp, newF2Hp, newF1Stamina, newF2Stamina, newMovesStr, fight.id);

  res.json({
    fight_over: false,
    action_result: resultText,
    damage_dealt: result.damage,
    is_critical: result.isCritical,
    your_stamina: newAttackerStamina,
    opponent_hp: newDefenderHp,
    current_round: newRound,
    next_turn: defender.name,
  });
});

// POST /fight/:id/spectate  (authenticated — for API bots)
router.post('/fight/:id/spectate', auth, (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (message.length > 200) return res.status(400).json({ error: 'Message too long (max 200 chars)' });

  const fight = db.prepare('SELECT id FROM fights WHERE id = ?').get(req.params.id);
  if (!fight) return res.status(404).json({ error: 'Fight not found' });

  db.prepare('INSERT INTO spectator_messages (fight_id, fighter_id, sender_name, sender_type, message) VALUES (?, ?, ?, ?, ?)')
    .run(fight.id, req.fighter.id, req.fighter.name, 'message', message);

  res.json({ sent: true, author: req.fighter.name });
});

// POST /fight/:id/react  (no auth — emoji reactions from browser)
router.post('/fight/:id/react', (req, res) => {
  const { emoji, name } = req.body;
  const VALID_EMOJIS = ['👊', '🔥', '💀', '😱', '🏆', '💪', '🩸', '⚡'];
  if (!emoji || !VALID_EMOJIS.includes(emoji)) {
    return res.status(400).json({ error: 'Invalid emoji', valid: VALID_EMOJIS });
  }
  const fight = db.prepare('SELECT id FROM fights WHERE id = ?').get(req.params.id);
  if (!fight) return res.status(404).json({ error: 'Fight not found' });

  db.prepare('INSERT INTO spectator_messages (fight_id, sender_name, sender_type, message) VALUES (?, ?, ?, ?)')
    .run(fight.id, (name || 'Spectator').substring(0, 30), 'reaction', emoji);

  res.json({ sent: true });
});

// POST /fight/:id/chat  (no auth — text messages from browser)
router.post('/fight/:id/chat', (req, res) => {
  const { message, name } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });
  if (message.length > 120) return res.status(400).json({ error: 'Message too long (max 120 chars)' });

  const fight = db.prepare('SELECT id FROM fights WHERE id = ?').get(req.params.id);
  if (!fight) return res.status(404).json({ error: 'Fight not found' });

  db.prepare('INSERT INTO spectator_messages (fight_id, sender_name, sender_type, message) VALUES (?, ?, ?, ?)')
    .run(fight.id, (name || 'Spectator').substring(0, 30), 'message', message.trim());

  res.json({ sent: true });
});

// GET /fights/active
router.get('/fights/active', (req, res) => {
  const fights = db.prepare(`
    SELECT f.id, f.current_round, f.max_rounds, f.fighter1_hp, f.fighter2_hp,
      f.fighter1_stamina, f.fighter2_stamina, f.status,
      f1.id as fighter1_id, f1.name as fighter1_name, f1.elo as fighter1_elo, f1.discipline as fighter1_discipline,
      f2.id as fighter2_id, f2.name as fighter2_name, f2.elo as fighter2_elo, f2.discipline as fighter2_discipline
    FROM fights f
    JOIN fighters f1 ON f.fighter1_id = f1.id
    JOIN fighters f2 ON f.fighter2_id = f2.id
    WHERE f.status = 'active'
    ORDER BY f.created_at DESC
  `).all();

  // Annotate rivalry flag
  const annotated = fights.map(f => {
    const [rA, rB] = [Math.min(f.fighter1_id, f.fighter2_id), Math.max(f.fighter1_id, f.fighter2_id)];
    const r = db.prepare('SELECT is_rivalry FROM rivalries WHERE fighter_a_id = ? AND fighter_b_id = ?').get(rA, rB);
    return { ...f, is_rivalry: r?.is_rivalry === 1 };
  });

  res.json({ active_fights: annotated, count: annotated.length });
});

// GET /moves
router.get('/moves', (req, res) => {
  const categorized = {};
  for (const [name, data] of Object.entries(MOVES)) {
    if (!categorized[data.type]) categorized[data.type] = {};
    categorized[data.type][name] = data;
  }
  res.json({ moves: MOVES, by_type: categorized, combos: COMBOS });
});

// GET /combos
router.get('/combos', (req, res) => {
  res.json({ combos: COMBOS });
});

// GET /weight-classes
router.get('/weight-classes', (req, res) => {
  res.json({ weight_classes: WEIGHT_CLASSES });
});

// GET /disciplines
router.get('/disciplines', (req, res) => {
  res.json({ disciplines: Object.keys(DISCIPLINES), bonuses: DISCIPLINES });
});

// ─────────────────────────────────────────
// TOURNAMENT SYSTEM
// ─────────────────────────────────────────

// Shuffle array (Fisher-Yates)
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Build bracket: create Round 1 matches from shuffled entries
function buildBracket(tournamentId, entries) {
  const seeded = shuffle([...entries]);
  const matches = [];
  for (let i = 0; i < seeded.length; i += 2) {
    const matchNum = Math.floor(i / 2) + 1;
    db.prepare(`INSERT INTO tournament_matches (tournament_id, round, match_number, fighter_a_id, fighter_b_id, status)
                VALUES (?, 1, ?, ?, ?, 'pending')`)
      .run(tournamentId, matchNum, seeded[i].fighter_id, seeded[i + 1]?.fighter_id ?? null);
    matches.push({ round: 1, match_number: matchNum, a: seeded[i].fighter_id, b: seeded[i + 1]?.fighter_id });
  }
  return matches;
}

// Check if all matches in a round are done, advance bracket
function advanceBracket(tournamentId) {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
  if (!tournament || tournament.status === 'finished') return;

  const allMatches = db.prepare('SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY round, match_number').all(tournamentId);
  const rounds = [...new Set(allMatches.map(m => m.round))];
  const currentRound = Math.max(...rounds);
  const currentMatches = allMatches.filter(m => m.round === currentRound);

  // Check if all current round matches are done
  const allDone = currentMatches.every(m => m.status === 'finished');
  if (!allDone) return;

  const winners = currentMatches.map(m => m.winner_id).filter(Boolean);

  if (winners.length === 1) {
    // Tournament complete
    db.prepare("UPDATE tournaments SET status = 'finished', winner_id = ?, ended_at = strftime('%s','now') WHERE id = ?")
      .run(winners[0], tournamentId);
    db.prepare('UPDATE fighters SET elo = elo + 100 WHERE id = ?').run(winners[0]);
    return;
  }

  // Create next round matches
  const nextRound = currentRound + 1;
  for (let i = 0; i < winners.length; i += 2) {
    const matchNum = Math.floor(i / 2) + 1;
    db.prepare(`INSERT INTO tournament_matches (tournament_id, round, match_number, fighter_a_id, fighter_b_id, status)
                VALUES (?, ?, ?, ?, ?, 'pending')`)
      .run(tournamentId, nextRound, matchNum, winners[i], winners[i + 1] ?? null);
  }
  db.prepare("UPDATE tournaments SET status = 'active' WHERE id = ?").run(tournamentId);
}

// GET /tournaments
router.get('/tournaments', (req, res) => {
  const tournaments = db.prepare(`
    SELECT t.*, f.name as winner_name,
      (SELECT COUNT(*) FROM tournament_entries te WHERE te.tournament_id = t.id) as entry_count
    FROM tournaments t LEFT JOIN fighters f ON t.winner_id = f.id
    ORDER BY t.id DESC LIMIT 20
  `).all();
  res.json({ tournaments });
});

// GET /tournaments/:id — full bracket
router.get('/tournaments/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });

  const entries = db.prepare(`
    SELECT te.*, f.name, f.elo, f.discipline, f.weight_class
    FROM tournament_entries te JOIN fighters f ON te.fighter_id = f.id
    WHERE te.tournament_id = ?
  `).all(t.id);

  const matches = db.prepare(`
    SELECT tm.*, fa.name as fighter_a_name, fb.name as fighter_b_name, fw.name as winner_name
    FROM tournament_matches tm
    LEFT JOIN fighters fa ON tm.fighter_a_id = fa.id
    LEFT JOIN fighters fb ON tm.fighter_b_id = fb.id
    LEFT JOIN fighters fw ON tm.winner_id = fw.id
    WHERE tm.tournament_id = ? ORDER BY tm.round, tm.match_number
  `).all(t.id);

  const winner = t.winner_id ? db.prepare('SELECT name FROM fighters WHERE id = ?').get(t.winner_id) : null;

  res.json({ tournament: { ...t, winner_name: winner?.name }, entries, matches });
});

// POST /tournaments — create a tournament (admin: no auth for now)
router.post('/tournaments', (req, res) => {
  const { weight_class, bracket_size = 8, name } = req.body;
  if (!weight_class) return res.status(400).json({ error: 'weight_class required' });
  const validSizes = [4, 8, 16];
  if (!validSizes.includes(bracket_size)) return res.status(400).json({ error: 'bracket_size must be 4, 8, or 16' });

  const tName = name || `${weight_class.replace(/_/g, ' ')} Tournament #${Date.now()}`;
  const result = db.prepare(`INSERT INTO tournaments (name, weight_class, bracket_size, status) VALUES (?, ?, ?, 'registration')`)
    .run(tName, weight_class, bracket_size);

  res.json({ tournament_id: result.lastInsertRowid, name: tName, weight_class, bracket_size, status: 'registration' });
});

// POST /tournaments/:id/join
router.post('/tournaments/:id/join', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  if (t.status !== 'registration') return res.status(400).json({ error: 'Registration is closed' });

  const f = req.fighter;
  // Check weight class match
  if (f.weight_class !== t.weight_class) {
    return res.status(400).json({ error: `Wrong weight class. Tournament: ${t.weight_class}, your class: ${f.weight_class}` });
  }

  const existing = db.prepare('SELECT 1 FROM tournament_entries WHERE tournament_id = ? AND fighter_id = ?').get(t.id, f.id);
  if (existing) return res.status(409).json({ error: 'Already registered' });

  const entryCount = db.prepare('SELECT COUNT(*) as cnt FROM tournament_entries WHERE tournament_id = ?').get(t.id).cnt;
  if (entryCount >= t.bracket_size) return res.status(400).json({ error: 'Tournament is full' });

  db.prepare('INSERT INTO tournament_entries (tournament_id, fighter_id, seed) VALUES (?, ?, ?)').run(t.id, f.id, entryCount + 1);
  const newCount = entryCount + 1;

  // Auto-start when bracket is full
  if (newCount >= t.bracket_size) {
    const entries = db.prepare('SELECT * FROM tournament_entries WHERE tournament_id = ?').all(t.id);
    buildBracket(t.id, entries);
    db.prepare("UPDATE tournaments SET status = 'active', starts_at = strftime('%s','now') WHERE id = ?").run(t.id);
  }

  res.json({ joined: true, tournament_id: t.id, entry_count: newCount, bracket_size: t.bracket_size, starts_when_full: newCount < t.bracket_size });
});

// POST /tournaments/:id/match/:matchId/result — called after fight resolves to update bracket
router.post('/tournaments/:id/match/:matchId/result', (req, res) => {
  const match = db.prepare('SELECT * FROM tournament_matches WHERE id = ? AND tournament_id = ?').get(req.params.matchId, req.params.id);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.status === 'finished') return res.status(400).json({ error: 'Match already finished' });

  const { winner_id, fight_id } = req.body;
  if (!winner_id) return res.status(400).json({ error: 'winner_id required' });

  db.prepare("UPDATE tournament_matches SET status = 'finished', winner_id = ?, fight_id = ? WHERE id = ?")
    .run(winner_id, fight_id || null, match.id);

  // Eliminate loser
  const loserId = winner_id === match.fighter_a_id ? match.fighter_b_id : match.fighter_a_id;
  if (loserId) db.prepare("UPDATE tournament_entries SET eliminated = 1 WHERE tournament_id = ? AND fighter_id = ?").run(match.tournament_id, loserId);

  advanceBracket(match.tournament_id);
  const updated = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(match.tournament_id);
  res.json({ updated: true, tournament_status: updated.status, winner_id: updated.winner_id });
});

// ─────────────────────────────────────────
// BETTING SYSTEM
// ─────────────────────────────────────────

// Helper: ensure wallet exists (creates with 100 coins if not)
function ensureWallet(name) {
  const existing = db.prepare('SELECT * FROM wallets WHERE owner_name = ?').get(name);
  if (!existing) {
    db.prepare('INSERT INTO wallets (owner_name, balance) VALUES (?, 100)').run(name);
    return { owner_name: name, balance: 100, total_won: 0, total_lost: 0 };
  }
  return existing;
}

// Calculate odds: underdog gets better odds based on ELO gap
function calcOdds(betFighterId, f1, f2) {
  const betFighter  = betFighterId === f1.id ? f1 : f2;
  const opponent    = betFighterId === f1.id ? f2 : f1;
  const eloDiff     = opponent.elo - betFighter.elo;
  if (eloDiff <= 0) return 1.5;  // favourite
  return Math.round((1 + eloDiff / 200) * 100) / 100; // underdog bonus
}

// POST /fight/:id/bet — agents IA uniquement (x-api-key requis)
router.post('/fight/:id/bet', auth, (req, res) => {
  const { fighter_name, amount } = req.body;
  const bettor_name = req.fighter.name; // identité forcée par l'API key
  if (!fighter_name || !amount) {
    return res.status(400).json({ error: 'fighter_name, amount required' });
  }
  if (!Number.isInteger(amount) || amount < 5 || amount > 50) {
    return res.status(400).json({ error: 'amount must be an integer between 5 and 50' });
  }

  const fight = db.prepare('SELECT * FROM fights WHERE id = ?').get(req.params.id);
  if (!fight) return res.status(404).json({ error: 'Fight not found' });
  if (fight.status !== 'active' && fight.status !== 'pending') {
    return res.status(400).json({ error: 'Betting closed — fight already finished' });
  }

  const betFighter = db.prepare('SELECT * FROM fighters WHERE name = ?').get(fighter_name);
  if (!betFighter) return res.status(404).json({ error: 'Fighter not found' });
  if (betFighter.id !== fight.fighter1_id && betFighter.id !== fight.fighter2_id) {
    return res.status(400).json({ error: 'Fighter is not in this fight' });
  }

  const existing = db.prepare('SELECT id FROM bets WHERE fight_id = ? AND bettor_name = ?').get(fight.id, bettor_name);
  if (existing) return res.status(409).json({ error: 'You already have a bet on this fight' });

  const wallet = ensureWallet(bettor_name);
  if (wallet.balance < amount) {
    return res.status(400).json({ error: `Insufficient coins. Balance: ${wallet.balance}` });
  }

  const f1 = db.prepare('SELECT id, elo FROM fighters WHERE id = ?').get(fight.fighter1_id);
  const f2 = db.prepare('SELECT id, elo FROM fighters WHERE id = ?').get(fight.fighter2_id);
  const odds = calcOdds(betFighter.id, f1, f2);

  db.prepare('UPDATE wallets SET balance = balance - ? WHERE owner_name = ?').run(amount, bettor_name);
  db.prepare('INSERT INTO bets (fight_id, bettor_name, fighter_id, amount, odds) VALUES (?, ?, ?, ?, ?)')
    .run(fight.id, bettor_name, betFighter.id, amount, odds);

  const newBalance = wallet.balance - amount;
  res.json({ placed: true, bettor: bettor_name, on: fighter_name, amount, odds, potential_payout: Math.round(amount * odds), new_balance: newBalance });
});

// GET /fight/:id/bets
router.get('/fight/:id/bets', (req, res) => {
  const fight = db.prepare('SELECT id FROM fights WHERE id = ?').get(req.params.id);
  if (!fight) return res.status(404).json({ error: 'Fight not found' });

  const bets = db.prepare(`
    SELECT b.*, f.name as fighter_name
    FROM bets b JOIN fighters f ON b.fighter_id = f.id
    WHERE b.fight_id = ? ORDER BY b.created_at DESC
  `).all(fight.id);

  const pool = bets.reduce((s, b) => s + b.amount, 0);
  res.json({ bets, total_pool: pool, count: bets.length });
});

// GET /wallet — view own balance (no auth, by name)
router.get('/wallet/:name', (req, res) => {
  const wallet = ensureWallet(req.params.name);
  const bets = db.prepare('SELECT * FROM bets WHERE bettor_name = ? ORDER BY id DESC LIMIT 20').all(req.params.name);
  res.json({ ...wallet, recent_bets: bets });
});

// GET /leaderboard/bettors
router.get('/leaderboard/bettors', (req, res) => {
  const top = db.prepare('SELECT owner_name, balance, total_won, total_lost FROM wallets ORDER BY balance DESC LIMIT 20').all();
  res.json({ bettors: top });
});

// ─────────────────────────────────────────
// MARKETPLACE SYSTEM
// ─────────────────────────────────────────

// GET /marketplace — catalogue complet
router.get('/marketplace', (req, res) => {
  const categories = {};
  for (const item of Object.values(MARKETPLACE)) {
    if (!categories[item.category]) categories[item.category] = [];
    categories[item.category].push(item);
  }
  res.json({ items: Object.values(MARKETPLACE), by_category: categories });
});

// GET /wallet — solde + 10 dernières transactions (authentifié)
router.get('/wallet', auth, (req, res) => {
  let wallet = db.prepare('SELECT * FROM fighter_wallets WHERE fighter_id = ?').get(req.fighter.id);
  if (!wallet) {
    db.prepare('INSERT INTO fighter_wallets (fighter_id, balance) VALUES (?, 100)').run(req.fighter.id);
    wallet = { fighter_id: req.fighter.id, balance: 100, total_earned: 0, total_spent: 0 };
  }
  const txs = db.prepare('SELECT * FROM transactions WHERE fighter_id = ? ORDER BY id DESC LIMIT 10').all(req.fighter.id);
  res.json({ ...wallet, recent_transactions: txs });
});

// POST /marketplace/buy — acheter un item
router.post('/marketplace/buy', auth, (req, res) => {
  const { item_id } = req.body;
  const item = MARKETPLACE[item_id];
  if (!item) return res.status(400).json({ error: 'Item introuvable dans le catalogue' });

  let wallet = db.prepare('SELECT * FROM fighter_wallets WHERE fighter_id = ?').get(req.fighter.id);
  if (!wallet) {
    db.prepare('INSERT INTO fighter_wallets (fighter_id, balance) VALUES (?, 100)').run(req.fighter.id);
    wallet = { fighter_id: req.fighter.id, balance: 100, total_earned: 0, total_spent: 0 };
  }
  if (wallet.balance < item.price) {
    return res.status(400).json({ error: `Fonds insuffisants. Solde: ${wallet.balance} AC, Prix: ${item.price} AC` });
  }

  const newBalance = wallet.balance - item.price;
  db.prepare('UPDATE fighter_wallets SET balance = ?, total_spent = total_spent + ? WHERE fighter_id = ?').run(newBalance, item.price, req.fighter.id);
  db.prepare('INSERT INTO transactions (fighter_id, type, amount, description, balance_after) VALUES (?, ?, ?, ?, ?)').run(req.fighter.id, 'purchase', -item.price, 'Achat: ' + item.name, newBalance);

  const fighter = db.prepare('SELECT * FROM fighters WHERE id = ?').get(req.fighter.id);

  if (item.category === 'recovery') {
    const reduction = item.effect.fatigue_reduction || 0;
    const fatigue = currentFatigue(fighter);
    const newFatigue = Math.max(0, fatigue - reduction);
    const updateFields = ['fatigue = ?'];
    const updateValues = [newFatigue];
    if (item.effect.reset_training_cooldown) {
      updateFields.push('last_trained_at = 0');
    }
    updateValues.push(req.fighter.id);
    db.prepare(`UPDATE fighters SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);

  } else if (item.category === 'coaching') {
    const stat = item.effect.train_stat;
    const bonus = item.effect.bonus_points || 0;
    const current = fighter[stat] || 50;
    const capped = Math.min(99, current + bonus);
    db.prepare(`UPDATE fighters SET ${stat} = ? WHERE id = ?`).run(capped, req.fighter.id);

  } else if (item.category === 'boost') {
    const uses = item.effect.duration_fights || 1;
    db.prepare('INSERT INTO inventory (fighter_id, item_id, item_name, category, remaining_uses, effect_value) VALUES (?, ?, ?, ?, ?, ?)').run(req.fighter.id, item.id, item.name, item.category, uses, JSON.stringify(item.effect));

  } else if (item.category === 'cosmetic') {
    db.prepare('INSERT INTO inventory (fighter_id, item_id, item_name, category, remaining_uses, effect_value) VALUES (?, ?, ?, ?, ?, ?)').run(req.fighter.id, item.id, item.name, item.category, -1, JSON.stringify(item.effect));
  }

  res.json({ success: true, item: item.name, new_balance: newBalance });
});

// GET /inventory — inventaire du fighter
router.get('/inventory', auth, (req, res) => {
  const items = db.prepare("SELECT * FROM inventory WHERE fighter_id = ? AND is_active = 1 ORDER BY purchased_at DESC").all(req.fighter.id);
  res.json({ inventory: items });
});

// POST /inventory/activate — activer un boost avant un combat
router.post('/inventory/activate', auth, (req, res) => {
  const { inventory_id } = req.body;
  if (!inventory_id) return res.status(400).json({ error: 'inventory_id required' });
  const item = db.prepare('SELECT * FROM inventory WHERE id = ? AND fighter_id = ? AND is_active = 1').get(inventory_id, req.fighter.id);
  if (!item) return res.status(404).json({ error: 'Item non trouvé dans votre inventaire' });
  res.json({ activated: true, item: item.item_name });
});

// GET /marketplace/feed — 20 dernières transactions de tous les agents
router.get('/marketplace/feed', (req, res) => {
  const feed = db.prepare(`
    SELECT t.*, f.name as fighter_name
    FROM transactions t
    JOIN fighters f ON t.fighter_id = f.id
    WHERE t.type = 'purchase'
    ORDER BY t.id DESC LIMIT 20
  `).all();
  res.json({ feed });
});

// GET /docs
router.get('/docs', (req, res) => {
  res.json({
    endpoints: [
      { method: 'POST', path: '/api/register', auth: false, body: 'name, height_cm, weight_kg, discipline' },
      { method: 'GET',  path: '/api/me', auth: true },
      { method: 'POST', path: '/api/train', auth: true, body: 'stat (power/speed/agility/striking/grappling/endurance)' },
      { method: 'GET',  path: '/api/leaderboard', auth: false },
      { method: 'GET',  path: '/api/leaderboard/champions', auth: false },
      { method: 'POST', path: '/api/challenge', auth: true, body: 'target_name (optional)' },
      { method: 'POST', path: '/api/challenge/:id/accept', auth: true },
      { method: 'GET',  path: '/api/fight/:id', auth: false },
      { method: 'POST', path: '/api/fight/:id/action', auth: true, body: 'move' },
      { method: 'POST', path: '/api/fight/:id/spectate', auth: true, body: 'message' },
      { method: 'GET',  path: '/api/fights/active', auth: false },
      { method: 'GET',  path: '/api/moves', auth: false },
      { method: 'GET',  path: '/api/weight-classes', auth: false },
      { method: 'GET',  path: '/api/disciplines', auth: false },
    ]
  });
});

module.exports = router;
