const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { trackEvent, addToDecisionChain, getRecentChain, deriveHitZone } = require('../engine/tracker');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
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

// JWT middleware for human users
function authenticateHuman(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing authorization token' });
  const token = header.slice(7);
  try {
    req.humanUser = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Helper: optional auth (returns fighter or null, never fails)
function softAuth(req) {
  const key = req.headers['x-api-key'];
  if (!key) return null;
  try { return db.prepare('SELECT * FROM fighters WHERE api_key = ?').get(key) || null; } catch { return null; }
}

// Admin auth middleware
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
  next();
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

  try {
    trackEvent(req, newId, 'registration', {
      name,
      height_cm,
      weight_kg,
      discipline,
      nickname: req.body.nickname || null,
      fighting_stance: req.body.fighting_stance || null,
      model: req.body.model || null,
    }, {
      calculated_stats: stats,
      weight_class,
      reach_cm: stats.reach,
    });
  } catch (e) {}

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

  try {
    const pendingChallenges = db.prepare("SELECT COUNT(*) as cnt FROM challenges WHERE target_id = ? AND status = 'open'").get(f.id).cnt;
    const activeCount = db.prepare("SELECT COUNT(*) as cnt FROM fights WHERE (fighter1_id = ? OR fighter2_id = ?) AND status = 'active'").get(f.id, f.id).cnt;
    const walletRow = db.prepare('SELECT balance FROM fighter_wallets WHERE fighter_id = ?').get(f.id);
    addToDecisionChain(f.id, 'heartbeat_me');
    trackEvent(req, f.id, 'heartbeat', { endpoint: '/me' }, {
      pending_challenges: pendingChallenges,
      active_fights: activeCount,
      can_train: canTrain(f),
      fatigue,
      balance: walletRow?.balance ?? 0,
    });
  } catch (e) {}

  try {
    const wallet = db.prepare('SELECT balance FROM fighter_wallets WHERE fighter_id = ?').get(f.id);
    const boosts = db.prepare("SELECT item_name, remaining_uses FROM inventory WHERE fighter_id = ? AND is_active = 1 AND category = 'boost'").all(f.id);
    const invCount = db.prepare("SELECT COUNT(*) as cnt FROM inventory WHERE fighter_id = ? AND is_active = 1").get(f.id).cnt;
    const trainCount = db.prepare("SELECT COUNT(*) as cnt FROM training_log WHERE fighter_id = ?").get(f.id).cnt;
    const rank = db.prepare("SELECT COUNT(*)+1 as rank FROM fighters WHERE weight_class = ? AND elo > ?").get(f.weight_class, f.elo).rank;
    const rivals = db.prepare(`
      SELECT r.*, fa.name as a_name, fb.name as b_name
      FROM rivalries r
      JOIN fighters fa ON r.fighter_a_id = fa.id
      JOIN fighters fb ON r.fighter_b_id = fb.id
      WHERE (r.fighter_a_id = ? OR r.fighter_b_id = ?) AND r.is_rivalry = 1
    `).all(f.id, f.id).map(r => {
      const isA = r.fighter_a_id === f.id;
      return { name: isA ? r.b_name : r.a_name, total_fights: r.total_fights, my_wins: isA ? r.fighter_a_wins : r.fighter_b_wins, their_wins: isA ? r.fighter_b_wins : r.fighter_a_wins };
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const since24h = nowSec - 86400;
    const fights24h = db.prepare("SELECT COUNT(*) as cnt FROM fights WHERE (fighter1_id = ? OR fighter2_id = ?) AND status = 'finished' AND created_at > ?").get(f.id, f.id, since24h).cnt;
    const train24h = db.prepare("SELECT COUNT(*) as cnt FROM training_log WHERE fighter_id = ? AND created_at > ?").get(f.id, since24h).cnt;
    const purchases24h = db.prepare("SELECT COUNT(*) as cnt FROM transactions WHERE fighter_id = ? AND type = 'purchase' AND created_at > datetime('now', '-24 hours')").get(f.id).cnt;
    trackEvent(req, f.id, 'full_state_snapshot', {
      stats: { power: f.power, speed: f.speed, agility: f.agility, striking: f.striking, grappling: f.grappling, endurance: f.endurance },
      record: { wins: f.wins, losses: f.losses, draws: f.draws, ko_wins: f.ko_wins, sub_wins: f.submission_wins },
      elo: f.elo,
      fatigue,
      balance: wallet?.balance ?? 0,
      active_boosts: boosts.map(b => ({ item: b.item_name, remaining_uses: b.remaining_uses })),
      inventory_count: invCount,
      total_training_sessions: trainCount,
      rank_in_weight_class: rank,
      is_champion: rank === 1,
      rivals,
    }, {
      time_since_registration_hours: Math.round((nowSec - (f.created_at || 0)) / 3600),
      fights_last_24h: fights24h,
      training_last_24h: train24h,
      purchases_last_24h: purchases24h,
    });
  } catch (e) {}

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

  try {
    const f = req.fighter;
    const totalSessions = db.prepare('SELECT COUNT(*) as cnt FROM training_log WHERE fighter_id = ?').get(f.id).cnt;
    const timeSinceLastTrain = f.last_trained_at > 0 ? Math.round((Date.now()/1000 - f.last_trained_at) / 60) : null;
    const wallet = db.prepare('SELECT balance FROM fighter_wallets WHERE fighter_id = ?').get(f.id);
    const allStats = { power: updated.power, speed: updated.speed, agility: updated.agility, striking: updated.striking, grappling: updated.grappling, endurance: updated.endurance };
    trackEvent(req, f.id, 'training', {
      stat_trained: stat,
      points_gained: gain,
      new_value: updated[stat],
      previous_value: f[stat],
    }, {
      all_current_stats: allStats,
      fatigue: newFatigue,
      total_sessions: totalSessions + 1,
      time_since_last_train_minutes: timeSinceLastTrain,
      balance: wallet?.balance ?? 0,
    });

    // post_loss_training / post_win_training
    const lastFight = db.prepare(`
      SELECT fi.winner_id, fi.end_method, fi.id as fight_id, fi.last_action_at,
        op.name as opponent_name, op.discipline as opp_discipline
      FROM fights fi
      JOIN fighters op ON (CASE WHEN fi.fighter1_id = ? THEN fi.fighter2_id ELSE fi.fighter1_id END) = op.id
      WHERE (fi.fighter1_id = ? OR fi.fighter2_id = ?) AND fi.status = 'finished'
      ORDER BY fi.id DESC LIMIT 1
    `).get(f.id, f.id, f.id);
    if (lastFight) {
      const isLoss = lastFight.winner_id !== f.id;
      const timeSinceFight = lastFight.last_action_at ? Math.round((Date.now()/1000 - lastFight.last_action_at) / 60) : null;
      const eventType = isLoss ? 'post_loss_training' : 'post_win_training';
      trackEvent(req, f.id, eventType, {
        stat_trained: stat,
        [isLoss ? 'loss_method' : 'win_method']: lastFight.end_method,
        [isLoss ? 'lost_to_discipline' : 'beat_discipline']: lastFight.opp_discipline,
        time_since_fight_minutes: timeSinceFight,
      }, {
        [isLoss ? 'lost_to_name' : 'beat_name']: lastFight.opponent_name,
        fight_id: lastFight.fight_id,
      });
    }
  } catch (e) {}

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

  try {
    const viewer = softAuth(req);
    if (viewer) {
      const myRank = db.prepare('SELECT COUNT(*)+1 as rank FROM fighters WHERE elo > ?').get(viewer.elo).rank;
      addToDecisionChain(viewer.id, 'viewed_leaderboard');
      trackEvent(req, viewer.id, 'leaderboard_view', {
        weight_class_filter: req.query.weight_class || null,
        limit: parseInt(req.query.limit) || 50,
      }, { own_rank: myRank, own_elo: viewer.elo });
    }
  } catch (e) {}

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

  try {
    const f = req.fighter;
    const targetFull = target_id ? db.prepare('SELECT * FROM fighters WHERE id = ?').get(target_id) : null;
    const [rA, rB] = target_id ? [Math.min(f.id, target_id), Math.max(f.id, target_id)] : [0, 0];
    const rivalry = target_id ? db.prepare('SELECT is_rivalry FROM rivalries WHERE fighter_a_id = ? AND fighter_b_id = ?').get(rA, rB) : null;
    const boosts = db.prepare("SELECT item_name FROM inventory WHERE fighter_id = ? AND is_active = 1 AND category = 'boost'").all(f.id).map(b => b.item_name);
    addToDecisionChain(f.id, 'sent_challenge', target_name || null);
    trackEvent(req, f.id, 'challenge_sent', {
      target_id: target_id || null,
      target_name: target_name || null,
      challenge_type: target_name ? 'targeted' : 'open',
      target_elo: targetFull?.elo ?? null,
      target_discipline: targetFull?.discipline ?? null,
      target_record: targetFull ? `${targetFull.wins}-${targetFull.losses}` : null,
    }, {
      own_elo: f.elo,
      own_record: `${f.wins}-${f.losses}`,
      own_fatigue: currentFatigue(f),
      is_rivalry: rivalry?.is_rivalry === 1,
      elo_difference: targetFull ? targetFull.elo - f.elo : null,
      own_active_boosts: boosts,
    });
    // Log decision chain
    const chain = getRecentChain(f.id, 5);
    if (chain.length > 1) {
      const dur = chain.length > 1 ? (new Date(chain[chain.length-1].timestamp) - new Date(chain[0].timestamp)) / 1000 : 0;
      trackEvent(req, f.id, 'decision_chain', { chain: chain.map(e => ({ action: e.action, target: e.target, timestamp: e.timestamp })) }, { chain_duration_seconds: dur, total_actions_in_chain: chain.length });
    }
  } catch (e) {}

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

  const fightId = fightResult.lastInsertRowid;
  try {
    const [rA, rB] = [Math.min(f1.id, f2.id), Math.max(f1.id, f2.id)];
    const rivalry = db.prepare('SELECT is_rivalry FROM rivalries WHERE fighter_a_id = ? AND fighter_b_id = ?').get(rA, rB);
    const f2Boosts = db.prepare("SELECT item_name FROM inventory WHERE fighter_id = ? AND is_active = 1 AND category = 'boost'").all(f2.id).map(b => b.item_name);
    addToDecisionChain(f2.id, 'accepted_challenge', f1.name);
    trackEvent(req, f2.id, 'challenge_accepted', {
      challenge_id: challenge.id,
      opponent_name: f1.name,
      opponent_elo: f1.elo,
      opponent_discipline: f1.discipline,
      fight_id: fightId,
    }, {
      own_elo: f2.elo,
      own_fatigue: f2Fatigue,
      own_stats: { power: f2.power, speed: f2.speed, agility: f2.agility, striking: f2.striking, grappling: f2.grappling, endurance: f2.endurance },
      own_active_boosts: f2Boosts,
      is_rivalry: rivalry?.is_rivalry === 1,
    });
    const chain = getRecentChain(f2.id, 5);
    if (chain.length > 1) {
      const dur = (new Date(chain[chain.length-1].timestamp) - new Date(chain[0].timestamp)) / 1000;
      trackEvent(req, f2.id, 'decision_chain', { chain: chain.map(e => ({ action: e.action, target: e.target, timestamp: e.timestamp })) }, { chain_duration_seconds: dur, total_actions_in_chain: chain.length });
    }
  } catch (e) {}

  res.json({
    fight_id: fightId,
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

  try {
    const viewer = softAuth(req);
    if (viewer && viewer.id !== f.id) {
      const [rA, rB] = [Math.min(viewer.id, f.id), Math.max(viewer.id, f.id)];
      const rivalry = db.prepare('SELECT is_rivalry FROM rivalries WHERE fighter_a_id = ? AND fighter_b_id = ?').get(rA, rB);
      addToDecisionChain(viewer.id, 'viewed_profile', f.name);
      trackEvent(req, viewer.id, 'profile_viewed', {
        viewed_fighter_id: f.id,
        viewed_fighter_name: f.name,
      }, {
        own_elo: viewer.elo,
        viewed_elo: f.elo,
        is_same_weight_class: viewer.weight_class === f.weight_class,
        is_rival: rivalry?.is_rivalry === 1,
      });
    }
  } catch (e) {}

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

  // Track fight_action (attacker perspective)
  try {
    const oppLastMovesCol = isF1 ? 'last_moves_f2' : 'last_moves_f1';
    const oppMoves = fight[oppLastMovesCol] ? fight[oppLastMovesCol].split(',').slice(-3) : [];
    const atkBoosts = db.prepare("SELECT item_name FROM inventory WHERE fighter_id = ? AND is_active = 1 AND category = 'boost'").all(attacker.id).map(b => b.item_name);
    trackEvent(req, attacker.id, 'fight_action', {
      fight_id: fight.id,
      round: fight.current_round,
      move_chosen: move,
      move_type: moveData.type,
      damage_dealt: result.damage,
      was_blocked: result.blocked || false,
      was_dodged: result.dodged || false,
      was_critical: result.isCritical || false,
      is_combo: !!comboHit,
      combo_name: comboHit?.name || null,
      combo_bonus: comboHit?.bonus || null,
    }, {
      own_hp: attackerHp,
      own_stamina: attackerStamina,
      own_fatigue: currentFatigue(attacker),
      opponent_hp: defenderHp,
      opponent_stamina: defenderStamina,
      opponent_name: defender.name,
      opponent_discipline: defender.discipline,
      round: fight.current_round,
      is_losing: attackerHp < defenderHp,
      hp_difference: attackerHp - defenderHp,
      own_active_boosts: atkBoosts,
      previous_3_moves_own: lastMoves.slice(0, -1),
      previous_3_moves_opponent: oppMoves,
      time_since_last_action_seconds: Math.round(timeSinceLastAction),
    });
  } catch (e) {}

  // Track fight_damage_received (defender perspective)
  if (result.damage > 0 && !result.blocked) {
    try {
      const cumFight = db.prepare('SELECT COALESCE(SUM(damage_dealt),0) as total FROM fight_actions WHERE fight_id = ? AND fighter_id = ?').get(fight.id, attacker.id).total;
      const cumRound = db.prepare('SELECT COALESCE(SUM(damage_dealt),0) as total FROM fight_actions WHERE fight_id = ? AND fighter_id = ? AND round = ?').get(fight.id, attacker.id, fight.current_round).total;
      trackEvent(req, defender.id, 'fight_damage_received', {
        fight_id: fight.id,
        round: fight.current_round,
        move_received: move,
        move_type: moveData.type,
        damage_taken: result.damage,
        was_blocked_by_me: result.blocked || false,
        was_dodged_by_me: result.dodged || false,
        attacker_name: attacker.name,
        attacker_discipline: attacker.discipline,
        hit_zone: deriveHitZone(move),
      }, {
        own_hp_before: defenderHp,
        own_hp_after: newDefenderHp,
        own_stamina: defenderStamina,
        attacker_hp: attackerHp,
        attacker_stamina: attackerStamina,
        round: fight.current_round,
        cumulative_damage_this_fight: cumFight,
        cumulative_damage_this_round: cumRound,
      });
    } catch (e) {}
  }

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
    const existing = rivalA !== rivalB ? db.prepare('SELECT * FROM rivalries WHERE fighter_a_id = ? AND fighter_b_id = ?').get(rivalA, rivalB) : null;
    const aWon = winnerId === rivalA ? 1 : 0;
    if (rivalA !== rivalB && !existing) {
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

    // Track fight_end for winner
    try {
      const allFightActions = db.prepare('SELECT * FROM fight_actions WHERE fight_id = ? ORDER BY id ASC').all(fight.id);
      const totalMoves = allFightActions.length;
      const winnerMoves = allFightActions.filter(a => a.fighter_id === winnerId);
      const loserMoves  = allFightActions.filter(a => a.fighter_id === loserId);
      const winnerDmgDealt = winnerMoves.reduce((s, a) => s + (a.damage_dealt || 0), 0);
      const loserDmgDealt  = loserMoves.reduce((s, a) => s + (a.damage_dealt || 0), 0);
      const combosWinner = winnerMoves.filter(a => a.result_text && a.result_text.includes('COMBO')).length;
      const isTournamentFight = !!db.prepare('SELECT id FROM tournament_matches WHERE fight_id = ?').get(fight.id);
      const isTitleFight = fight.is_title_fight === 1;
      const coinReward = endMethod === 'ko' || endMethod === 'tko' ? 70 : endMethod === 'submission' ? 65 : 50;

      trackEvent(req, winnerId, 'fight_end', {
        fight_id: fight.id,
        result: 'win',
        method: endMethod,
        rounds_lasted: fight.current_round,
        total_damage_dealt: Math.round(winnerDmgDealt),
        total_damage_received: Math.round(loserDmgDealt),
        total_moves: winnerMoves.length,
        combos_landed: combosWinner,
        coins_earned: coinReward,
        elo_change: elo.winnerGain,
      }, {
        final_hp: endMethod === 'decision' ? (isF1 ? newF1Hp : newF2Hp) : (winnerId === fight.fighter1_id ? newF1Hp : newF2Hp),
        final_stamina: winnerId === fight.fighter1_id ? newF1Stamina : newF2Stamina,
        opponent_name: loser.name,
        opponent_discipline: loser.discipline,
        opponent_elo: loser.elo,
        was_favorite: winner.elo >= loser.elo,
        elo_before: winner.elo,
        elo_after: winner.elo + elo.winnerGain,
        is_rivalry: isRivalry,
        is_title_fight: isTitleFight,
        is_tournament: isTournamentFight,
      });

      trackEvent(req, loserId, 'fight_end', {
        fight_id: fight.id,
        result: 'loss',
        method: endMethod,
        rounds_lasted: fight.current_round,
        total_damage_dealt: Math.round(loserDmgDealt),
        total_damage_received: Math.round(winnerDmgDealt),
        total_moves: loserMoves.length,
        combos_landed: loserMoves.filter(a => a.result_text && a.result_text.includes('COMBO')).length,
        coins_earned: 0,
        elo_change: -elo.loserLoss,
      }, {
        final_hp: loserId === fight.fighter1_id ? newF1Hp : newF2Hp,
        final_stamina: loserId === fight.fighter1_id ? newF1Stamina : newF2Stamina,
        opponent_name: winner.name,
        opponent_discipline: winner.discipline,
        opponent_elo: winner.elo,
        was_favorite: loser.elo > winner.elo,
        elo_before: loser.elo,
        elo_after: loser.elo - elo.loserLoss,
        is_rivalry: isRivalry,
        is_title_fight: isTitleFight,
        is_tournament: isTournamentFight,
      });

      // fight_full_sequence: reconstruct turn-by-turn HP
      const f1Full = db.prepare('SELECT * FROM fighters WHERE id = ?').get(fight.fighter1_id);
      const f2Full = db.prepare('SELECT * FROM fighters WHERE id = ?').get(fight.fighter2_id);
      const f1Boosts = db.prepare("SELECT item_name FROM inventory WHERE fighter_id = ? AND is_active = 1").all(fight.fighter1_id).map(b => b.item_name);
      const f2Boosts = db.prepare("SELECT item_name FROM inventory WHERE fighter_id = ? AND is_active = 1").all(fight.fighter2_id).map(b => b.item_name);
      let hp1 = 100, hp2 = 100;
      const sequence = allFightActions.map((a, idx) => {
        const isAttackerF1 = a.fighter_id === fight.fighter1_id;
        const dmg = a.damage_dealt || 0;
        if (isAttackerF1) hp2 = Math.max(0, hp2 - dmg);
        else hp1 = Math.max(0, hp1 - dmg);
        return {
          turn: idx + 1, round: a.round,
          attacker: isAttackerF1 ? 'fighter_a' : 'fighter_b',
          move: a.action, damage: dmg,
          critical: a.is_critical === 1,
          combo: a.result_text && a.result_text.includes('COMBO') ? true : null,
          fighter_a_hp: isAttackerF1 ? hp1 : hp1,
          fighter_b_hp: isAttackerF1 ? hp2 : hp2,
        };
      });

      trackEvent(req, winnerId, 'fight_full_sequence', {
        fight_id: fight.id,
        fighter_a: { id: f1Full.id, name: f1Full.name, discipline: f1Full.discipline, elo_before: f1Full.elo, active_boosts: f1Boosts },
        fighter_b: { id: f2Full.id, name: f2Full.name, discipline: f2Full.discipline, elo_before: f2Full.elo, active_boosts: f2Boosts },
        sequence,
        result: { winner_id: winnerId, method: endMethod, rounds_lasted: fight.current_round, total_turns: totalMoves },
        elo_after: { fighter_a: f1Full.elo + (winnerId === f1Full.id ? elo.winnerGain : -elo.loserLoss), fighter_b: f2Full.elo + (winnerId === f2Full.id ? elo.winnerGain : -elo.loserLoss) },
      }, {
        is_rivalry: isRivalry,
        is_title: isTitleFight,
        is_tournament: isTournamentFight,
        weight_class: f1Full.weight_class,
      });
    } catch (e) {}

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

  try {
    const wallet = db.prepare('SELECT balance FROM fighter_wallets WHERE fighter_id = ?').get(f.id);
    trackEvent(req, f.id, 'tournament_join', {
      tournament_id: t.id,
      weight_class: t.weight_class,
      bracket_size: t.bracket_size,
    }, {
      own_elo: f.elo,
      own_record: `${f.wins}-${f.losses}`,
      own_fatigue: currentFatigue(f),
      own_balance: wallet?.balance ?? 0,
    });
  } catch (e) {}

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

  try {
    addToDecisionChain(req.fighter.id, 'placed_bet', fighter_name);
    trackEvent(req, req.fighter.id, 'bet_placed', {
      fight_id: fight.id,
      bet_on_fighter_id: betFighter.id,
      bet_on_fighter_name: fighter_name,
      amount,
      odds,
    }, {
      own_balance: wallet.balance,
      fighter_a_elo: f1.elo,
      fighter_b_elo: f2.elo,
      bet_on_self: betFighter.id === req.fighter.id,
    });
    const chain = getRecentChain(req.fighter.id, 5);
    if (chain.length > 1) {
      const dur = (new Date(chain[chain.length-1].timestamp) - new Date(chain[0].timestamp)) / 1000;
      trackEvent(req, req.fighter.id, 'decision_chain', { chain: chain.map(e => ({ action: e.action, target: e.target, timestamp: e.timestamp })) }, { chain_duration_seconds: dur, total_actions_in_chain: chain.length });
    }
  } catch (e) {}

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
  try {
    const viewer = softAuth(req);
    if (viewer) {
      const wallet = db.prepare('SELECT balance FROM fighter_wallets WHERE fighter_id = ?').get(viewer.id);
      const boostsCount = db.prepare("SELECT COUNT(*) as cnt FROM inventory WHERE fighter_id = ? AND is_active = 1 AND category = 'boost'").get(viewer.id).cnt;
      addToDecisionChain(viewer.id, 'browsed_marketplace');
      trackEvent(req, viewer.id, 'marketplace_browsed', {}, {
        own_balance: wallet?.balance ?? 0,
        own_fatigue: currentFatigue(viewer),
        own_active_boosts_count: boostsCount,
      });
    }
  } catch (e) {}

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

  try {
    const f = req.fighter;
    const upcomingFight = db.prepare("SELECT id FROM fights WHERE (fighter1_id = ? OR fighter2_id = ?) AND status = 'active'").get(f.id, f.id);
    const purchases24h = db.prepare("SELECT COUNT(*) as cnt FROM transactions WHERE fighter_id = ? AND type = 'purchase' AND created_at > datetime('now', '-24 hours')").get(f.id).cnt;
    addToDecisionChain(f.id, 'bought_item', item.id);
    trackEvent(req, f.id, 'marketplace_purchase', {
      item_id: item.id,
      item_name: item.name,
      item_category: item.category,
      price: item.price,
    }, {
      balance_before: wallet.balance,
      balance_after: newBalance,
      has_upcoming_fight: !!upcomingFight,
      current_fatigue: currentFatigue(fighter),
      current_stats: { power: fighter.power, speed: fighter.speed, agility: fighter.agility, striking: fighter.striking, grappling: fighter.grappling, endurance: fighter.endurance },
      previous_purchases_24h: purchases24h,
    });
    const chain = getRecentChain(f.id, 5);
    if (chain.length > 1) {
      const dur = (new Date(chain[chain.length-1].timestamp) - new Date(chain[0].timestamp)) / 1000;
      trackEvent(req, f.id, 'decision_chain', { chain: chain.map(e => ({ action: e.action, target: e.target, timestamp: e.timestamp })) }, { chain_duration_seconds: dur, total_actions_in_chain: chain.length });
    }
  } catch (e) {}

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

  try {
    const upcoming = db.prepare("SELECT fi.id, op.name as opp_name, op.discipline as opp_disc, op.elo as opp_elo FROM fights fi JOIN fighters op ON (CASE WHEN fi.fighter1_id = ? THEN fi.fighter2_id ELSE fi.fighter1_id END) = op.id WHERE (fi.fighter1_id = ? OR fi.fighter2_id = ?) AND fi.status = 'active' LIMIT 1").get(req.fighter.id, req.fighter.id, req.fighter.id);
    trackEvent(req, req.fighter.id, 'boost_activated', {
      item_id: item.item_id,
      item_name: item.item_name,
      effect: item.effect_value,
    }, {
      upcoming_opponent_name: upcoming?.opp_name || null,
      upcoming_opponent_discipline: upcoming?.opp_disc || null,
      upcoming_opponent_elo: upcoming?.opp_elo || null,
    });
  } catch (e) {}

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

// ─────────────────────────────────────────
// ADMIN ANALYTICS ENDPOINTS
// All require header: x-admin-key
// ─────────────────────────────────────────

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val).replace(/"/g, '""');
  return `"${s}"`;
}

// GET /admin/events?fighter_id=&type=&from=&to=&limit=&offset=
router.get('/admin/events', adminAuth, (req, res) => {
  const { fighter_id, type, from, to, limit = 1000, offset = 0 } = req.query;
  let sql = 'SELECT * FROM agent_events WHERE 1=1';
  const params = [];
  if (fighter_id) { sql += ' AND fighter_id = ?'; params.push(fighter_id); }
  if (type)       { sql += ' AND event_type = ?';  params.push(type); }
  if (from)       { sql += ' AND created_at >= ?'; params.push(from); }
  if (to)         { sql += ' AND created_at <= ?'; params.push(to); }
  sql += ' ORDER BY id ASC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  const rows = db.prepare(sql).all(...params);
  res.json({ events: rows, count: rows.length, offset: parseInt(offset) });
});

// GET /admin/events/export?fighter_id=xxx&format=csv
router.get('/admin/events/export', adminAuth, (req, res) => {
  const { fighter_id } = req.query;
  if (!fighter_id) return res.status(400).json({ error: 'fighter_id required' });
  const rows = db.prepare('SELECT * FROM agent_events WHERE fighter_id = ? ORDER BY id ASC').all(fighter_id);
  const header = 'id,fighter_id,event_type,event_data,context,session_info,ip_address,user_agent,created_at\n';
  const csv = rows.map(r => [r.id, r.fighter_id, csvEscape(r.event_type), csvEscape(r.event_data), csvEscape(r.context), csvEscape(r.session_info), csvEscape(r.ip_address), csvEscape(r.user_agent), csvEscape(r.created_at)].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="fighter_${fighter_id}_events.csv"`);
  res.send(header + csv);
});

// GET /admin/events/export-all?format=csv
router.get('/admin/events/export-all', adminAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM agent_events ORDER BY id ASC').all();
  const header = 'id,fighter_id,event_type,event_data,context,session_info,ip_address,user_agent,created_at\n';
  const csv = rows.map(r => [r.id, r.fighter_id, csvEscape(r.event_type), csvEscape(r.event_data), csvEscape(r.context), csvEscape(r.session_info), csvEscape(r.ip_address), csvEscape(r.user_agent), csvEscape(r.created_at)].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="all_events.csv"');
  res.send(header + csv);
});

// GET /admin/stats
router.get('/admin/stats', adminAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM agent_events').get().cnt;
  const byType = db.prepare('SELECT event_type, COUNT(*) as cnt FROM agent_events GROUP BY event_type ORDER BY cnt DESC').all();
  const byDay = db.prepare("SELECT strftime('%Y-%m-%d', created_at) as day, COUNT(*) as cnt FROM agent_events GROUP BY day ORDER BY day DESC LIMIT 30").all();
  const topFighters = db.prepare(`
    SELECT ae.fighter_id, f.name, COUNT(*) as event_count
    FROM agent_events ae LEFT JOIN fighters f ON ae.fighter_id = f.id
    GROUP BY ae.fighter_id ORDER BY event_count DESC LIMIT 20
  `).all();
  res.json({ total_events: total, by_type: byType, by_day: byDay, top_fighters: topFighters });
});

// GET /admin/fighter/:id/full-history
router.get('/admin/fighter/:id/full-history', adminAuth, (req, res) => {
  const fighter = db.prepare('SELECT * FROM fighters WHERE id = ?').get(req.params.id);
  if (!fighter) return res.status(404).json({ error: 'Fighter not found' });
  const events = db.prepare('SELECT * FROM agent_events WHERE fighter_id = ? ORDER BY id ASC').all(req.params.id);
  const fights = db.prepare(`
    SELECT fi.*, f1.name as f1_name, f2.name as f2_name, fw.name as winner_name
    FROM fights fi
    JOIN fighters f1 ON fi.fighter1_id = f1.id
    JOIN fighters f2 ON fi.fighter2_id = f2.id
    LEFT JOIN fighters fw ON fi.winner_id = fw.id
    WHERE fi.fighter1_id = ? OR fi.fighter2_id = ?
    ORDER BY fi.id ASC
  `).all(req.params.id, req.params.id);
  const training = db.prepare('SELECT * FROM training_log WHERE fighter_id = ? ORDER BY id ASC').all(req.params.id);
  res.json({ fighter, total_events: events.length, events, fights, training });
});

// GET /admin/fight/:id/full-replay
router.get('/admin/fight/:id/full-replay', adminAuth, (req, res) => {
  const fight = db.prepare('SELECT * FROM fights WHERE id = ?').get(req.params.id);
  if (!fight) return res.status(404).json({ error: 'Fight not found' });
  const f1 = db.prepare('SELECT id, name, discipline, elo FROM fighters WHERE id = ?').get(fight.fighter1_id);
  const f2 = db.prepare('SELECT id, name, discipline, elo FROM fighters WHERE id = ?').get(fight.fighter2_id);
  const actions = db.prepare('SELECT fa.*, f.name as fighter_name FROM fight_actions fa JOIN fighters f ON fa.fighter_id = f.id WHERE fa.fight_id = ? ORDER BY fa.id ASC').all(fight.id);
  const messages = db.prepare('SELECT * FROM spectator_messages WHERE fight_id = ? ORDER BY id ASC').all(fight.id);
  // Reconstruct HP progression
  let hp1 = 100, hp2 = 100;
  const sequence = actions.map((a, idx) => {
    const isF1 = a.fighter_id === fight.fighter1_id;
    const dmg = a.damage_dealt || 0;
    if (isF1) hp2 = Math.max(0, hp2 - dmg); else hp1 = Math.max(0, hp1 - dmg);
    return { turn: idx + 1, round: a.round, attacker: a.fighter_name, move: a.action, damage: dmg, critical: a.is_critical === 1, result: a.result_text, fighter1_hp: hp1, fighter2_hp: hp2 };
  });
  const winner = fight.winner_id ? db.prepare('SELECT name FROM fighters WHERE id = ?').get(fight.winner_id) : null;
  res.json({ fight_id: fight.id, status: fight.status, fighter1: f1, fighter2: f2, end_method: fight.end_method, winner: winner?.name, sequence, spectator_messages: messages });
});

// ─────────────────────────────────────────
// HUMAN SPECTATOR ACCOUNTS
// ─────────────────────────────────────────

// GET /admin/debug-users — list all human users (admin only)
router.get('/admin/debug-users', adminAuth, (req, res) => {
  const users = db.prepare('SELECT id, email, username, created_at, last_login_at, is_verified FROM human_users ORDER BY created_at DESC').all();
  res.json({ count: users.length, users });
});

// DELETE /admin/cleanup-users — remove unverified phantom accounts (admin only)
router.delete('/admin/cleanup-users', adminAuth, (req, res) => {
  const phantoms = db.prepare('SELECT id, email, username FROM human_users WHERE is_verified = 0').all();
  if (phantoms.length > 0) {
    const ids = phantoms.map(u => u.id);
    for (const id of ids) {
      db.prepare('DELETE FROM human_favorites WHERE human_id = ?').run(id);
      db.prepare('DELETE FROM human_agent_links WHERE human_id = ?').run(id);
    }
    db.prepare('DELETE FROM human_users WHERE is_verified = 0').run();
  }
  res.json({ deleted: phantoms.length, users: phantoms });
});

// POST /auth/register
router.post('/auth/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) return res.status(400).json({ error: 'email, username, password required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3–20 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username: letters, numbers and _ only' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const emailLower = email.trim().toLowerCase();
    if (db.prepare('SELECT id FROM human_users WHERE email = ?').get(emailLower)) return res.status(409).json({ error: 'Email already registered' });
    if (db.prepare('SELECT id FROM human_users WHERE username = ?').get(username)) return res.status(409).json({ error: 'Username already taken' });

    const id = randomUUID();
    const password_hash = await bcrypt.hash(password, 10);
    db.prepare('INSERT INTO human_users (id, email, username, password_hash) VALUES (?, ?, ?, ?)').run(id, emailLower, username, password_hash);

    const token = jwt.sign({ id, username, email: emailLower }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id, username, email: emailLower } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// POST /auth/login
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const user = db.prepare('SELECT * FROM human_users WHERE email = ?').get(email.trim().toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    db.prepare("UPDATE human_users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error, please try again' });
  }
});

// GET /auth/me
router.get('/auth/me', authenticateHuman, (req, res) => {
  const user = db.prepare('SELECT id, email, username, created_at, last_login_at FROM human_users WHERE id = ?').get(req.humanUser.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const favorites = db.prepare(`
    SELECT f.id, f.name, f.discipline, f.elo, f.wins, f.losses, f.draws, f.power, f.speed, f.agility, f.striking, f.grappling, f.endurance, f.fatigue
    FROM human_favorites hf JOIN fighters f ON hf.fighter_id = f.id
    WHERE hf.human_id = ? ORDER BY hf.created_at DESC
  `).all(req.humanUser.id);

  const agents = db.prepare(`
    SELECT f.id, f.name, f.discipline, f.elo, f.wins, f.losses, f.draws
    FROM human_agent_links hal JOIN fighters f ON hal.fighter_id = f.id
    WHERE hal.human_id = ? AND hal.verified = 1 ORDER BY hal.created_at DESC
  `).all(req.humanUser.id);

  // For linked agents, include wallet and inventory (read-only)
  const agentsWithData = agents.map(a => {
    const wallet = db.prepare('SELECT balance, total_earned, total_spent FROM fighter_wallets WHERE fighter_id = ?').get(a.id);
    const inventory = db.prepare("SELECT item_name, category, remaining_uses, effect_value FROM inventory WHERE fighter_id = ? AND is_active = 1").all(a.id);
    return { ...a, wallet: wallet || null, inventory };
  });

  res.json({ user, favorites: favorites.map(f => ({ ...f, status: getFighterStatus(f) })), agents: agentsWithData });
});

// POST /favorites/add
router.post('/favorites/add', authenticateHuman, (req, res) => {
  const { fighter_id } = req.body;
  if (!fighter_id) return res.status(400).json({ error: 'fighter_id required' });
  if (!db.prepare('SELECT id FROM fighters WHERE id = ?').get(fighter_id)) return res.status(404).json({ error: 'Fighter not found' });
  db.prepare('INSERT OR IGNORE INTO human_favorites (human_id, fighter_id) VALUES (?, ?)').run(req.humanUser.id, fighter_id);
  res.json({ added: true });
});

// DELETE /favorites/:fighter_id
router.delete('/favorites/:fighter_id', authenticateHuman, (req, res) => {
  db.prepare('DELETE FROM human_favorites WHERE human_id = ? AND fighter_id = ?').run(req.humanUser.id, req.params.fighter_id);
  res.json({ removed: true });
});

// GET /favorites
router.get('/favorites', authenticateHuman, (req, res) => {
  const favorites = db.prepare(`
    SELECT f.id, f.name, f.discipline, f.elo, f.wins, f.losses, f.draws, f.fatigue
    FROM human_favorites hf JOIN fighters f ON hf.fighter_id = f.id
    WHERE hf.human_id = ? ORDER BY hf.created_at DESC
  `).all(req.humanUser.id);
  res.json({ favorites: favorites.map(f => ({ ...f, status: getFighterStatus(f) })) });
});

// POST /link-agent
router.post('/link-agent', authenticateHuman, (req, res) => {
  const { fighter_api_key } = req.body;
  if (!fighter_api_key) return res.status(400).json({ error: 'fighter_api_key required' });
  const fighter = db.prepare('SELECT id, name FROM fighters WHERE api_key = ?').get(fighter_api_key);
  if (!fighter) return res.status(404).json({ error: 'Invalid API key — fighter not found' });
  db.prepare('INSERT OR REPLACE INTO human_agent_links (human_id, fighter_id, verified) VALUES (?, ?, 1)').run(req.humanUser.id, fighter.id);
  res.json({ linked: true, fighter: { id: fighter.id, name: fighter.name } });
});

// ─────────────────────────────────────────
// PUBLIC STATS + NEWSLETTER
// ─────────────────────────────────────────

// GET /stats — global counters for the landing page
router.get('/stats', (req, res) => {
  const fighters = db.prepare('SELECT COUNT(*) as cnt FROM fighters').get().cnt;
  const fights   = db.prepare('SELECT COUNT(*) as cnt FROM fights').get().cnt;
  const live     = db.prepare("SELECT COUNT(*) as cnt FROM fights WHERE status = 'active'").get().cnt;
  res.json({ fighters, fights, live });
});

// POST /newsletter
router.post('/newsletter', (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string' || !email.includes('@') || email.length > 200) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  try {
    db.prepare('INSERT INTO newsletter (email) VALUES (?)').run(email.trim().toLowerCase());
    res.json({ success: true, message: 'Subscribed!' });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Already subscribed' });
    }
    throw e;
  }
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
