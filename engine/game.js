const WEIGHT_CLASSES = [
  { name: 'strawweight',       min: 0,     max: 52.2  },
  { name: 'flyweight',         min: 52.2,  max: 56.7  },
  { name: 'bantamweight',      min: 56.7,  max: 61.2  },
  { name: 'featherweight',     min: 61.2,  max: 65.8  },
  { name: 'lightweight',       min: 65.8,  max: 70.3  },
  { name: 'welterweight',      min: 70.3,  max: 77.1  },
  { name: 'middleweight',      min: 77.1,  max: 83.9  },
  { name: 'light_heavyweight', min: 83.9,  max: 93.0  },
  { name: 'heavyweight',       min: 93.0,  max: 120.2 },
];

const DISCIPLINES = {
  boxing:    { power: 15, speed: 10, striking: 20, grappling: -10, endurance: 5, agility: 5 },
  muaythai:  { power: 10, speed: 8,  striking: 18, grappling: 0,   endurance: 8, agility: 8 },
  kickboxing:{ power: 10, speed: 12, striking: 15, grappling: -5,  endurance: 5, agility: 12 },
  wrestling: { power: 12, speed: 5,  striking: -5, grappling: 20,  endurance: 10, agility: 5 },
  bjj:       { power: 5,  speed: 5,  striking: -10,grappling: 25,  endurance: 8,  agility: 8 },
  mma:       { power: 8,  speed: 8,  striking: 8,  grappling: 8,   endurance: 8,  agility: 8 },
};

const MOVES = {
  // Striking
  jab:          { type: 'strike', baseDamage: 5,  staminaCost: 4,  powerMod: 0.4, speedMod: 0.8, category: 'punch' },
  cross:        { type: 'strike', baseDamage: 10, staminaCost: 7,  powerMod: 0.9, speedMod: 0.5, category: 'punch' },
  hook:         { type: 'strike', baseDamage: 12, staminaCost: 8,  powerMod: 1.0, speedMod: 0.4, category: 'punch' },
  uppercut:     { type: 'strike', baseDamage: 11, staminaCost: 8,  powerMod: 0.9, speedMod: 0.5, category: 'punch' },
  body_shot:    { type: 'strike', baseDamage: 8,  staminaCost: 6,  powerMod: 0.7, speedMod: 0.5, category: 'punch' },
  low_kick:     { type: 'strike', baseDamage: 9,  staminaCost: 6,  powerMod: 0.6, speedMod: 0.7, category: 'kick' },
  high_kick:    { type: 'strike', baseDamage: 15, staminaCost: 12, powerMod: 0.9, speedMod: 0.5, category: 'kick' },
  body_kick:    { type: 'strike', baseDamage: 12, staminaCost: 9,  powerMod: 0.8, speedMod: 0.6, category: 'kick' },
  knee:         { type: 'strike', baseDamage: 13, staminaCost: 9,  powerMod: 0.9, speedMod: 0.5, category: 'knee' },
  elbow:        { type: 'strike', baseDamage: 14, staminaCost: 8,  powerMod: 0.8, speedMod: 0.6, category: 'elbow' },
  spinning_kick:{ type: 'strike', baseDamage: 18, staminaCost: 15, powerMod: 1.0, speedMod: 0.3, category: 'kick' },
  // Grappling
  takedown:     { type: 'grapple', baseDamage: 6,  staminaCost: 14, powerMod: 0.5, speedMod: 0.5, category: 'takedown' },
  clinch:       { type: 'grapple', baseDamage: 4,  staminaCost: 8,  powerMod: 0.3, speedMod: 0.3, category: 'clinch' },
  slam:         { type: 'grapple', baseDamage: 16, staminaCost: 18, powerMod: 1.0, speedMod: 0.2, category: 'takedown' },
  armbar:       { type: 'submission', baseDamage: 20, staminaCost: 18, powerMod: 0.4, speedMod: 0.4, category: 'joint' },
  rear_naked:   { type: 'submission', baseDamage: 20, staminaCost: 16, powerMod: 0.5, speedMod: 0.5, category: 'choke' },
  triangle:     { type: 'submission', baseDamage: 20, staminaCost: 16, powerMod: 0.3, speedMod: 0.4, category: 'choke' },
  guillotine:   { type: 'submission', baseDamage: 20, staminaCost: 14, powerMod: 0.5, speedMod: 0.6, category: 'choke' },
  // Defense
  block:        { type: 'defense', baseDamage: 0, staminaCost: 3,  powerMod: 0, speedMod: 0, category: 'block' },
  dodge:        { type: 'defense', baseDamage: 0, staminaCost: 4,  powerMod: 0, speedMod: 0, category: 'dodge' },
  sprawl:       { type: 'defense', baseDamage: 0, staminaCost: 6,  powerMod: 0, speedMod: 0, category: 'anti_grapple' },
};

const COMBOS = {
  'jab+cross':                  { bonus: 1.3, name: 'One-Two' },
  'jab+cross+hook':             { bonus: 1.5, name: 'Classic Combo' },
  'jab+body_shot+hook':         { bonus: 1.4, name: 'Body-Head Switch' },
  'low_kick+cross+high_kick':   { bonus: 1.6, name: 'Dutch Combo' },
  'jab+cross+uppercut':         { bonus: 1.5, name: 'Power Combo' },
  'clinch+knee+elbow':          { bonus: 1.5, name: 'Thai Clinch Combo' },
  'takedown+armbar':            { bonus: 1.4, name: 'Ground & Pound to Sub' },
  'takedown+slam':              { bonus: 1.6, name: 'Takedown Slam' },
};

// Check if the last moves form a combo. Returns combo object or null.
function checkCombo(moves) {
  if (moves.length >= 3) {
    const key = moves.slice(-3).join('+');
    if (COMBOS[key]) return COMBOS[key];
  }
  if (moves.length >= 2) {
    const key = moves.slice(-2).join('+');
    if (COMBOS[key]) return COMBOS[key];
  }
  return null;
}

function getWeightClass(weight_kg) {
  for (const wc of WEIGHT_CLASSES) {
    if (weight_kg >= wc.min && weight_kg <= wc.max) return wc.name;
  }
  if (weight_kg > 120.2) return 'heavyweight';
  return 'strawweight';
}

function calcBaseStats(height_cm, weight_kg, discipline) {
  const bonus = DISCIPLINES[discipline] || DISCIPLINES.mma;
  const speedMod = 80 / weight_kg;

  const power     = Math.round(50 * (weight_kg / 80) + bonus.power);
  const speed     = Math.round(50 * speedMod + bonus.speed);
  const agility   = Math.round(50 * ((180 - Math.abs(height_cm - 175)) / 180) * speedMod + bonus.agility);
  const striking  = Math.round(50 + bonus.striking);
  const grappling = Math.round(50 + bonus.grappling);
  const endurance = Math.round(50 + bonus.endurance);
  const reach     = Math.round(height_cm * 1.02);

  return { power, speed, agility, striking, grappling, endurance, reach };
}

function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'arena_';
  for (let i = 0; i < 26; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function calcDamage(attacker, move, defender) {
  const moveData = MOVES[move];
  if (!moveData) return { damage: 0, isCritical: false, blocked: false };

  const staminaFactor = Math.max(0.3, attacker.stamina / 100);
  const baseDmg = moveData.baseDamage;
  const powerContrib = (attacker.power / 100) * moveData.powerMod * 20;
  const speedContrib = (attacker.speed / 100) * moveData.speedMod * 10;

  let damage = (baseDmg + powerContrib + speedContrib) * staminaFactor;

  // Critical hit
  const critChance = 0.05 + Math.max(0, (attacker.power - 50) * 0.002);
  const isCritical = Math.random() < critChance;
  if (isCritical) damage *= 1.8;

  // Submission — based on grappling vs endurance
  if (moveData.type === 'submission') {
    const subChance = (attacker.grappling - defender.grappling) / 200 + 0.15;
    if (Math.random() < subChance) {
      return { damage: defender.hp, isCritical: false, blocked: false, submission: true };
    }
    damage = moveData.baseDamage * 0.3;
  }

  return { damage: Math.round(damage * 10) / 10, isCritical, blocked: false };
}

function resolveAction(attacker, move, defender, defenderAction) {
  const moveData = MOVES[move];
  const defData = MOVES[defenderAction] || null;

  if (!moveData) return { damage: 0, isCritical: false, resultText: 'Invalid move' };

  // Defense logic
  if (defData && defData.type === 'defense') {
    const defenderStat = attacker.speed;
    const attackerStat = defenderAction === 'sprawl' ? attacker.grappling : attacker.speed;

    if (defenderAction === 'sprawl' && moveData.type === 'grapple') {
      const sprawlChance = Math.min(0.8, 0.3 + defender.grappling / 200);
      if (Math.random() < sprawlChance) {
        return { damage: 0, isCritical: false, blocked: true, resultText: `${defender.name} sprawls and avoids the takedown!` };
      }
    }

    if (defenderAction === 'block' && moveData.category !== 'takedown') {
      const blockChance = Math.min(0.6, 0.2 + defender.agility / 300);
      if (Math.random() < blockChance) {
        const reduced = calcDamage(attacker, move, defender);
        reduced.damage = Math.round(reduced.damage * 0.3 * 10) / 10;
        reduced.blocked = true;
        reduced.resultText = `${defender.name} blocks and absorbs reduced damage`;
        return reduced;
      }
    }

    if (defenderAction === 'dodge' && moveData.type === 'strike') {
      const dodgeChance = Math.min(0.5, 0.1 + defender.agility / 200 + defender.speed / 400);
      if (Math.random() < dodgeChance) {
        return { damage: 0, isCritical: false, blocked: true, resultText: `${defender.name} dodges!` };
      }
    }
  }

  return calcDamage(attacker, move, defender);
}

function calcEloChange(winner, loser, method) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (loser.elo - winner.elo) / 400));
  let base = Math.round(K * (1 - expected));

  const methodBonus = { ko: 50, tko: 40, submission: 45, decision: 25 };
  base += methodBonus[method] || 0;

  if (loser.elo > winner.elo) base = Math.round(base * 1.5);

  return { winnerGain: base, loserLoss: Math.round(K * expected) };
}

const TRAINING_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes
const FATIGUE_PER_FIGHT    = 20;
const FATIGUE_PER_TRAIN    = 5;
const FATIGUE_MAX_FIGHT    = 90; // can't fight at 90+
const FATIGUE_DECAY_PER_HOUR = 10;

// Returns a fighter object with stats reduced by fatigue
// Formula: effective_stat = base_stat * (1 - fatigue/200)
// At 0 fatigue: 100%, at 50: 75%, at 100: 50%
function applyFatigue(fighter) {
  const fatigue = fighter.fatigue || 0;
  if (fatigue === 0) return fighter;
  const factor = 1 - fatigue / 200;
  return {
    ...fighter,
    power:     Math.round(fighter.power     * factor),
    speed:     Math.round(fighter.speed     * factor),
    agility:   Math.round(fighter.agility   * factor),
    striking:  Math.round(fighter.striking  * factor),
    grappling: Math.round(fighter.grappling * factor),
    endurance: Math.round(fighter.endurance * factor),
  };
}

// Current fatigue after natural decay
function currentFatigue(fighter) {
  const stored = fighter.fatigue || 0;
  const lastFight = fighter.last_fight_at || 0;
  const hoursElapsed = (Date.now() / 1000 - lastFight) / 3600;
  const decayed = Math.floor(hoursElapsed * FATIGUE_DECAY_PER_HOUR);
  return Math.max(0, stored - decayed);
}

function canTrain(fighter) {
  const now = Date.now();
  const lastTrained = fighter.last_trained_at * 1000;
  return now - lastTrained >= TRAINING_COOLDOWN_MS;
}

function calcTrainingGain(stat, fighter) {
  const base = 1.5;
  const current = fighter[stat] || 50;
  const diminish = Math.max(0.1, 1 - (current - 50) / 200);
  return Math.round(base * diminish * 10) / 10;
}

const MARKETPLACE = {
  power_boost:     { id: 'power_boost',     category: 'boost',    name: 'Power Boost',     price: 30,  effect: { stat: 'power',    amount: 10, duration_fights: 3 } },
  speed_boost:     { id: 'speed_boost',     category: 'boost',    name: 'Speed Boost',     price: 30,  effect: { stat: 'speed',    amount: 10, duration_fights: 3 } },
  agility_boost:   { id: 'agility_boost',   category: 'boost',    name: 'Agility Boost',   price: 30,  effect: { stat: 'agility',  amount: 10, duration_fights: 3 } },
  striking_boost:  { id: 'striking_boost',  category: 'boost',    name: 'Striking Boost',  price: 35,  effect: { stat: 'striking', amount: 10, duration_fights: 3 } },
  grappling_boost: { id: 'grappling_boost', category: 'boost',    name: 'Grappling Boost', price: 35,  effect: { stat: 'grappling',amount: 10, duration_fights: 3 } },
  endurance_boost: { id: 'endurance_boost', category: 'boost',    name: 'Endurance Boost', price: 25,  effect: { stat: 'endurance',amount: 10, duration_fights: 3 } },
  iron_chin:       { id: 'iron_chin',       category: 'boost',    name: 'Iron Chin',       price: 50,  effect: { head_dmg_reduction: 0.20, duration_fights: 2 } },
  cardio_king:     { id: 'cardio_king',     category: 'boost',    name: 'Cardio King',     price: 40,  effect: { stamina_cost_reduction: 0.30, duration_fights: 2 } },
  energy_drink:    { id: 'energy_drink',    category: 'recovery', name: 'Energy Drink',    price: 15,  effect: { fatigue_reduction: 20 } },
  full_recovery:   { id: 'full_recovery',   category: 'recovery', name: 'Full Recovery',   price: 40,  effect: { fatigue_reduction: 100 } },
  massage:         { id: 'massage',         category: 'recovery', name: 'Massage',         price: 25,  effect: { fatigue_reduction: 30, reset_training_cooldown: true } },
  boxing_coach:    { id: 'boxing_coach',    category: 'coaching', name: 'Boxing Coach',    price: 50,  effect: { train_stat: 'striking', bonus_points: 5 } },
  wrestling_coach: { id: 'wrestling_coach', category: 'coaching', name: 'Wrestling Coach', price: 50,  effect: { train_stat: 'grappling', bonus_points: 5 } },
  cardio_coach:    { id: 'cardio_coach',    category: 'coaching', name: 'Cardio Coach',    price: 40,  effect: { train_stat: 'endurance', bonus_points: 5 } },
  speed_coach:     { id: 'speed_coach',     category: 'coaching', name: 'Speed Coach',     price: 45,  effect: { train_stat: 'speed', bonus_points: 4 } },
  defense_coach:   { id: 'defense_coach',   category: 'coaching', name: 'Defense Coach',   price: 60,  effect: { block_dodge_bonus: 0.15, duration_fights: 5 } },
  gold_shorts:     { id: 'gold_shorts',     category: 'cosmetic', name: 'Gold Shorts',     price: 100, effect: { visual: 'gold_shorts' } },
  red_gloves:      { id: 'red_gloves',      category: 'cosmetic', name: 'Red Gloves',      price: 50,  effect: { visual: 'red_gloves' } },
  champion_aura:   { id: 'champion_aura',   category: 'cosmetic', name: 'Champion Aura',   price: 200, effect: { visual: 'champion_aura' } },
  custom_nickname: { id: 'custom_nickname', category: 'cosmetic', name: 'Change Nickname', price: 25,  effect: { visual: 'nickname' } },
};

module.exports = {
  WEIGHT_CLASSES,
  DISCIPLINES,
  MOVES,
  COMBOS,
  getWeightClass,
  calcBaseStats,
  generateApiKey,
  calcDamage,
  resolveAction,
  calcEloChange,
  canTrain,
  calcTrainingGain,
  checkCombo,
  applyFatigue,
  currentFatigue,
  TRAINING_COOLDOWN_MS,
  FATIGUE_PER_FIGHT,
  FATIGUE_PER_TRAIN,
  FATIGUE_MAX_FIGHT,
  FATIGUE_DECAY_PER_HOUR,
  MARKETPLACE,
};
