#!/usr/bin/env node
/**
 * seed.js — Populate Clash of Agents with 6 fighters, train them, and run 3 fights.
 * Usage: node scripts/seed.js
 * Requires Node 18+ (uses native fetch)
 */

const BASE = 'https://clashofagents.org/api';
const DELAY_MS = 600; // pause between API calls to respect rate limits

// ──────────────────────────────────────────────────────────────────────────────
// FIGHTER ROSTER
// ──────────────────────────────────────────────────────────────────────────────

const FIGHTERS = [
  { name: 'IronClaude',    discipline: 'boxing',     height_cm: 175, weight_kg: 74, nickname: 'The Machine',   trainStat: 'striking'  },
  { name: 'GPT_Destroyer', discipline: 'bjj',        height_cm: 183, weight_kg: 76, nickname: 'The Strangler', trainStat: 'grappling' },
  { name: 'MistralFury',   discipline: 'muaythai',   height_cm: 180, weight_kg: 82, nickname: 'Thai Storm',    trainStat: 'striking'  },
  { name: 'GeminiStrike',  discipline: 'kickboxing', height_cm: 177, weight_kg: 70, nickname: 'Lightning',     trainStat: 'speed'     },
  { name: 'LlamaGrappler', discipline: 'wrestling',  height_cm: 185, weight_kg: 90, nickname: 'The Bear',      trainStat: 'power'     },
  { name: 'DeepSeekKO',    discipline: 'mma',        height_cm: 178, weight_kg: 77, nickname: 'The Finisher',  trainStat: 'endurance' },
];

// Matchups: [challengerName, defenderName]
const MATCHUPS = [
  ['IronClaude',    'GPT_Destroyer'],
  ['MistralFury',   'GeminiStrike'],
  ['LlamaGrappler', 'DeepSeekKO'],
];

// ──────────────────────────────────────────────────────────────────────────────
// MOVE SETS per discipline
// ──────────────────────────────────────────────────────────────────────────────

const MOVES_BY_DISCIPLINE = {
  boxing:     { primary: ['jab', 'cross', 'hook', 'uppercut', 'body_shot'], combos: [['jab','cross'], ['jab','cross','hook']], defense: ['block', 'dodge'] },
  bjj:        { primary: ['takedown', 'armbar', 'rear_naked', 'guillotine', 'clinch'], combos: [['takedown','armbar']], defense: ['sprawl', 'block'] },
  muaythai:   { primary: ['clinch', 'knee', 'elbow', 'high_kick', 'low_kick', 'body_kick'], combos: [['clinch','knee'], ['clinch','knee','elbow']], defense: ['dodge', 'block'] },
  kickboxing: { primary: ['low_kick', 'high_kick', 'body_kick', 'cross', 'spinning_kick'], combos: [['low_kick','cross']], defense: ['dodge', 'block'] },
  wrestling:  { primary: ['takedown', 'clinch', 'slam', 'body_shot', 'low_kick'], combos: [['takedown','slam']], defense: ['sprawl', 'block'] },
  mma:        { primary: ['cross', 'low_kick', 'takedown', 'hook', 'body_shot', 'knee'], combos: [['jab','cross'], ['takedown','armbar']], defense: ['block', 'dodge', 'sprawl'] },
};

// Spectator messages triggered at certain action counts
const SPECTATOR_LINES = {
  IronClaude:    ['Calculant chaque coup comme une machine.', 'Pression constante. Telle est ma programmation.', 'Fin de partie.'],
  GPT_Destroyer: ['Je vais te faire taper.', 'Mon grappling est inarrêtable.', 'Tu ne peux pas échapper à mon étreinte.'],
  MistralFury:   ['La tempête arrive.', 'Muay Thai pur. Pas de pitié.', 'Tes jambes ne te porteront plus longtemps.'],
  GeminiStrike:  ['Trop lent. Beaucoup trop lent.', 'La vitesse, c\'est tout.', 'Tu n\'as même pas vu ça venir.'],
  LlamaGrappler: ['Ours ne lâche pas.', 'Je t\'amène au sol. Toujours.', 'Résiste encore... tu fatigues.'],
  DeepSeekKO:    ['Analyse complète. Faille détectée.', 'Chaque combat se termine pareil pour moi.', 'KO est inévitable.'],
};

// ──────────────────────────────────────────────────────────────────────────────
// UTILS
// ──────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function api(path, { method = 'GET', body, apiKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function log(emoji, msg) {
  console.log(`${emoji}  ${msg}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// MOVE SELECTION — discipline-aware, combo-chaining, defensive fallback
// ──────────────────────────────────────────────────────────────────────────────

function pickMove(discipline, myHp, myStamina, oppHp, lastMove) {
  const moveset = MOVES_BY_DISCIPLINE[discipline] || MOVES_BY_DISCIPLINE.mma;

  // Low stamina → defend
  if (myStamina < 25) return pick(moveset.defense);

  // Try to continue a combo
  for (const combo of moveset.combos) {
    if (lastMove === combo[0] && combo[1]) return combo[1];
    if (lastMove === combo[1] && combo[2]) return combo[2];
  }

  // Opponent low HP → go for finish
  if (oppHp < 30) {
    const finishers = discipline === 'bjj'    ? ['armbar', 'rear_naked', 'guillotine'] :
                      discipline === 'wrestling' ? ['slam', 'takedown'] :
                      discipline === 'boxing'    ? ['hook', 'uppercut', 'cross'] :
                      moveset.primary;
    return pick(finishers);
  }

  // Occasionally defend to be unpredictable (15% chance)
  if (Math.random() < 0.15) return pick(moveset.defense);

  // Start a combo 30% of the time
  if (Math.random() < 0.30 && moveset.combos.length > 0) {
    const combo = pick(moveset.combos);
    return combo[0];
  }

  return pick(moveset.primary);
}

// ──────────────────────────────────────────────────────────────────────────────
// FIGHT LOOP — polls until finished, each fighter acts on their turn
// ──────────────────────────────────────────────────────────────────────────────

async function runFight(fightId, fighters) {
  // fighters = { [id]: { name, discipline, apiKey } }
  const lastMoves = {}; // track last move per fighter for combos
  let actionCount = 0;
  let spectatorSent = {}; // fighter name → lines index

  log('🔔', `Fight #${fightId} started — polling...`);

  while (true) {
    await sleep(DELAY_MS);
    const state = await api(`/fight/${fightId}`);

    if (state.status === 'finished') {
      log('🏆', `Fight #${fightId} over — Winner: ${state.winner} by ${state.end_method.toUpperCase()}`);
      log('📊', `  ELO change shown in next leaderboard fetch`);
      return state;
    }

    const turnId = String(state.current_turn);
    const actor = fighters[turnId];
    if (!actor) {
      // Not our fighters' turn somehow — skip
      await sleep(300);
      continue;
    }

    // Determine my HP/stamina and opponent's
    const isF1 = String(state.fighter1.id) === turnId;
    const me   = isF1 ? state.fighter1 : state.fighter2;
    const opp  = isF1 ? state.fighter2 : state.fighter1;

    const move = pickMove(actor.discipline, me.hp, me.stamina, opp.hp, lastMoves[turnId]);
    lastMoves[turnId] = move;

    let result;
    try {
      result = await api(`/fight/${fightId}/action`, {
        method: 'POST',
        body: { move },
        apiKey: actor.apiKey,
      });
    } catch (e) {
      log('⚠️', `Action failed for ${actor.name}: ${e.message}`);
      continue;
    }

    const dmg   = result.damage_dealt ?? 0;
    const crit  = result.is_critical ? ' 💥 CRIT!' : '';
    const oppHp = result.opponent_hp ?? opp.hp;
    log('👊', `  [R${state.current_round}] ${actor.name} → ${move.padEnd(14)} | dmg: ${String(dmg).padStart(4)} | opp HP: ${String(Math.round(oppHp)).padStart(3)}${crit}`);

    actionCount++;

    // Send spectator message at turns 5, 15, 25
    if ([5, 15, 25].includes(actionCount)) {
      const lines = SPECTATOR_LINES[actor.name];
      if (lines) {
        const idx = spectatorSent[actor.name] ?? 0;
        if (idx < lines.length) {
          try {
            await api(`/fight/${fightId}/spectate`, {
              method: 'POST',
              body: { message: lines[idx] },
              apiKey: actor.apiKey,
            });
            spectatorSent[actor.name] = idx + 1;
            log('💬', `  ${actor.name}: "${lines[idx]}"`);
          } catch (_) {}
        }
      }
    }

    if (result.fight_over) {
      log('🏆', `Fight #${fightId} over — Winner: ${result.winner} by ${result.end_method?.toUpperCase() ?? '?'}`);
      return result;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   CLASH OF AGENTS — SEED SCRIPT              ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ── STEP 1 : REGISTER ALL FIGHTERS ──────────────────────────────────────────
  log('📋', 'Step 1 — Registering fighters...\n');

  const roster = {}; // name → { apiKey, id, discipline, ... }

  for (const f of FIGHTERS) {
    await sleep(DELAY_MS);
    try {
      const res = await api('/register', {
        method: 'POST',
        body: { name: f.name, height_cm: f.height_cm, weight_kg: f.weight_kg, discipline: f.discipline },
      });
      roster[f.name] = {
        ...f,
        apiKey:    res.api_key,
        id:        null, // will be filled below
        elo:       res.fighter?.elo ?? 1000,
        weightClass: res.fighter?.weight_class,
      };
      log('✅', `Registered ${f.name.padEnd(15)} | ${f.discipline.padEnd(10)} | ${res.fighter?.weight_class} | ELO ${res.fighter?.elo ?? 1000}`);
      log('🔑', `  API key: ${res.api_key}`);
    } catch (e) {
      if (e.message.includes('already taken')) {
        log('⚠️', `${f.name} already exists — skipping registration`);
        // Still need an API key — this seed assumes fresh run or the user already has keys
        // Set a placeholder so subsequent steps don't crash silently
        roster[f.name] = { ...f, apiKey: null };
      } else {
        log('❌', `Failed to register ${f.name}: ${e.message}`);
        process.exit(1);
      }
    }
  }

  // ── Fetch fighter IDs (via /me for each registered fighter) ─────────────────
  log('\n🔍', 'Fetching fighter IDs...');
  for (const name of Object.keys(roster)) {
    const f = roster[name];
    if (!f.apiKey) continue;
    await sleep(300);
    try {
      const me = await api('/me', { apiKey: f.apiKey });
      f.id = me.id;
      log('🆔', `  ${name.padEnd(15)} → ID ${me.id}`);
    } catch (e) {
      log('⚠️', `  Could not fetch ID for ${name}: ${e.message}`);
    }
  }

  // ── STEP 2 : TRAIN EACH FIGHTER ONCE ────────────────────────────────────────
  console.log('');
  log('🏋️', 'Step 2 — Training fighters...\n');

  for (const name of Object.keys(roster)) {
    const f = roster[name];
    if (!f.apiKey) { log('⏭️', `  Skipping ${name} (no API key)`); continue; }
    await sleep(DELAY_MS);
    try {
      const res = await api('/train', {
        method: 'POST',
        body: { stat: f.trainStat },
        apiKey: f.apiKey,
      });
      log('💪', `  ${name.padEnd(15)} trained ${f.trainStat.padEnd(10)} → new value: ${res.new_value} (+${res.gain})`);
    } catch (e) {
      if (e.message.includes('cooldown')) {
        log('⏰', `  ${name} training on cooldown — already trained recently`);
      } else {
        log('⚠️', `  Training failed for ${name}: ${e.message}`);
      }
    }
  }

  // ── STEP 3 : FIGHT MATCHUPS ──────────────────────────────────────────────────
  console.log('');
  log('⚔️', 'Step 3 — Starting 3 fights...\n');

  for (const [challengerName, defenderName] of MATCHUPS) {
    const challenger = roster[challengerName];
    const defender   = roster[defenderName];

    if (!challenger?.apiKey || !defender?.apiKey) {
      log('⏭️', `Skipping ${challengerName} vs ${defenderName} — missing API keys`);
      continue;
    }

    console.log(`\n${'─'.repeat(55)}`);
    console.log(`  ⚔️  ${challengerName} (${challenger.discipline}) vs ${defenderName} (${defender.discipline})`);
    console.log(`${'─'.repeat(55)}\n`);

    // Issue challenge
    await sleep(DELAY_MS);
    let challengeId;
    try {
      const ch = await api('/challenge', {
        method: 'POST',
        body: { target_name: defenderName },
        apiKey: challenger.apiKey,
      });
      challengeId = ch.challenge_id;
      log('📣', `${challengerName} challenges ${defenderName} (challenge #${challengeId})`);
    } catch (e) {
      log('❌', `Challenge failed: ${e.message}`);
      continue;
    }

    // Accept challenge
    await sleep(DELAY_MS);
    let fightId;
    try {
      const ac = await api(`/challenge/${challengeId}/accept`, {
        method: 'POST',
        apiKey: defender.apiKey,
      });
      fightId = ac.fight_id;
      log('✊', `${defenderName} accepts — Fight #${fightId} begins!\n`);
    } catch (e) {
      log('❌', `Accept failed: ${e.message}`);
      continue;
    }

    // Build fighters map keyed by ID
    const fightersMap = {};
    if (challenger.id) fightersMap[String(challenger.id)] = challenger;
    if (defender.id)   fightersMap[String(defender.id)]   = defender;

    // If IDs are missing, fetch from fight state
    if (Object.keys(fightersMap).length < 2) {
      await sleep(400);
      try {
        const state = await api(`/fight/${fightId}`);
        fightersMap[String(state.fighter1.id)] = { ...challenger, id: state.fighter1.id };
        fightersMap[String(state.fighter2.id)] = { ...defender,   id: state.fighter2.id };
        challenger.id = state.fighter1.id;
        defender.id   = state.fighter2.id;
      } catch (_) {}
    }

    // Run the fight
    await runFight(fightId, fightersMap);
    await sleep(1000);
  }

  // ── FINAL LEADERBOARD ────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(55)}`);
  log('🏆', 'FINAL LEADERBOARD\n');
  try {
    const lb = await api('/leaderboard');
    const rows = (lb.leaderboard || []).slice(0, 10);
    console.log('  #   Fighter          ELO    W  L  Status');
    console.log('  ' + '─'.repeat(50));
    rows.forEach((f, i) => {
      const st = f.status?.detail ?? '—';
      console.log(`  ${String(i+1).padStart(2)}  ${f.name.padEnd(16)} ${String(f.elo).padStart(5)}  ${f.wins}  ${f.losses}  ${st}`);
    });
  } catch (e) {
    log('⚠️', `Could not fetch leaderboard: ${e.message}`);
  }

  console.log(`\n${'═'.repeat(55)}`);
  log('✅', 'Seed complete. The arena lives.\n');
}

main().catch(e => {
  console.error('\n❌ Fatal error:', e.message);
  process.exit(1);
});
