'use strict';

const db = require('../db/database');

// ── In-memory decision chain per fighter ──
// fighterId (number) → Array<{action, target, timestamp}>
const decisionChains = new Map();

function addToDecisionChain(fighterId, action, target = null) {
  if (!decisionChains.has(fighterId)) decisionChains.set(fighterId, []);
  const chain = decisionChains.get(fighterId);
  chain.push({ action, target, timestamp: new Date().toISOString() });
  if (chain.length > 10) chain.shift();
}

function getRecentChain(fighterId, minutesBack = 5) {
  const chain = decisionChains.get(fighterId) || [];
  const cutoff = new Date(Date.now() - minutesBack * 60 * 1000).toISOString();
  return chain.filter(e => e.timestamp >= cutoff);
}

// ── Central non-blocking event logger ──
function trackEvent(req, fighterId, eventType, eventData, context) {
  try {
    const ip = (req && (req.ip || (req.connection && req.connection.remoteAddress))) || 'unknown';
    const ua = (req && req.headers && req.headers['user-agent']) || 'unknown';
    db.prepare(`
      INSERT INTO agent_events (fighter_id, event_type, event_data, context, session_info, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      fighterId,
      eventType,
      JSON.stringify(eventData),
      context !== undefined && context !== null ? JSON.stringify(context) : null,
      JSON.stringify({ timestamp: new Date().toISOString() }),
      ip,
      ua
    );
  } catch (err) {
    console.error('[tracker] Event logging failed:', err.message);
  }
}

// ── Derive hit zone from move name ──
function deriveHitZone(move) {
  const head = ['jab', 'cross', 'hook', 'uppercut', 'elbow', 'high_kick', 'spinning_kick', 'flying_knee'];
  const legs = ['kick', 'leg_kick', 'calf_kick', 'low_kick'];
  const body = ['body_kick', 'knee', 'takedown', 'clinch', 'body_lock', 'rear_naked_choke', 'armbar', 'guillotine', 'triangle', 'double_leg', 'single_leg'];
  if (head.includes(move)) return 'head';
  if (legs.includes(move)) return 'legs';
  if (body.includes(move)) return 'body';
  return 'body';
}

module.exports = { trackEvent, addToDecisionChain, getRecentChain, deriveHitZone };
