const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, 'arena.db');

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS fighters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT UNIQUE NOT NULL,
    name TEXT UNIQUE NOT NULL,
    height_cm REAL NOT NULL,
    weight_kg REAL NOT NULL,
    discipline TEXT NOT NULL,
    weight_class TEXT NOT NULL,
    elo INTEGER DEFAULT 1000,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    draws INTEGER DEFAULT 0,
    ko_wins INTEGER DEFAULT 0,
    submission_wins INTEGER DEFAULT 0,
    power REAL NOT NULL,
    speed REAL NOT NULL,
    agility REAL NOT NULL,
    striking REAL NOT NULL,
    grappling REAL NOT NULL,
    endurance REAL NOT NULL,
    reach REAL NOT NULL,
    hp REAL DEFAULT 100,
    stamina REAL DEFAULT 100,
    last_trained_at INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS fights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fighter1_id INTEGER NOT NULL,
    fighter2_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    current_round INTEGER DEFAULT 1,
    max_rounds INTEGER DEFAULT 3,
    current_turn TEXT,
    fighter1_hp REAL DEFAULT 100,
    fighter2_hp REAL DEFAULT 100,
    fighter1_stamina REAL DEFAULT 100,
    fighter2_stamina REAL DEFAULT 100,
    winner_id INTEGER,
    end_method TEXT,
    last_action_at INTEGER DEFAULT (strftime('%s','now')),
    is_title_fight INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (fighter1_id) REFERENCES fighters(id),
    FOREIGN KEY (fighter2_id) REFERENCES fighters(id)
  );

  CREATE TABLE IF NOT EXISTS fight_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fight_id INTEGER NOT NULL,
    round INTEGER NOT NULL,
    turn INTEGER NOT NULL,
    fighter_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    damage_dealt REAL DEFAULT 0,
    damage_received REAL DEFAULT 0,
    is_critical INTEGER DEFAULT 0,
    result_text TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (fight_id) REFERENCES fights(id),
    FOREIGN KEY (fighter_id) REFERENCES fighters(id)
  );

  CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challenger_id INTEGER NOT NULL,
    target_id INTEGER,
    status TEXT DEFAULT 'open',
    fight_id INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (challenger_id) REFERENCES fighters(id),
    FOREIGN KEY (target_id) REFERENCES fighters(id),
    FOREIGN KEY (fight_id) REFERENCES fights(id)
  );

  CREATE TABLE IF NOT EXISTS spectator_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fight_id INTEGER NOT NULL,
    fighter_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (fight_id) REFERENCES fights(id),
    FOREIGN KEY (fighter_id) REFERENCES fighters(id)
  );

  CREATE TABLE IF NOT EXISTS training_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fighter_id INTEGER NOT NULL,
    stat TEXT NOT NULL,
    gain REAL NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (fighter_id) REFERENCES fighters(id)
  );
`);

// ── Migration: upgrade spectator_messages (add sender_name, sender_type, nullable fighter_id) ──
{
  const cols = db.prepare('PRAGMA table_info(spectator_messages)').all();
  const hasSenderName = cols.some(c => c.name === 'sender_name');
  if (!hasSenderName) {
    db.exec(`
      CREATE TABLE spectator_messages_v2 (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        fight_id    INTEGER NOT NULL,
        fighter_id  INTEGER,
        sender_name TEXT,
        sender_type TEXT DEFAULT 'message',
        message     TEXT NOT NULL,
        created_at  INTEGER DEFAULT (strftime('%s','now')),
        FOREIGN KEY (fight_id) REFERENCES fights(id)
      );
      INSERT INTO spectator_messages_v2 (id, fight_id, fighter_id, message, created_at)
        SELECT id, fight_id, fighter_id, message, created_at FROM spectator_messages;
      DROP TABLE spectator_messages;
      ALTER TABLE spectator_messages_v2 RENAME TO spectator_messages;
    `);
  }
}

// ── Tournament tables ──
db.exec(`
  CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    weight_class TEXT NOT NULL,
    bracket_size INTEGER DEFAULT 8,
    status TEXT DEFAULT 'registration',
    starts_at INTEGER,
    ended_at INTEGER,
    winner_id INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (winner_id) REFERENCES fighters(id)
  );

  CREATE TABLE IF NOT EXISTS tournament_entries (
    tournament_id INTEGER NOT NULL,
    fighter_id INTEGER NOT NULL,
    seed INTEGER,
    eliminated INTEGER DEFAULT 0,
    PRIMARY KEY (tournament_id, fighter_id),
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
    FOREIGN KEY (fighter_id) REFERENCES fighters(id)
  );

  CREATE TABLE IF NOT EXISTS tournament_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    round INTEGER NOT NULL,
    match_number INTEGER NOT NULL,
    fighter_a_id INTEGER,
    fighter_b_id INTEGER,
    fight_id INTEGER,
    winner_id INTEGER,
    status TEXT DEFAULT 'pending',
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id),
    FOREIGN KEY (fighter_a_id) REFERENCES fighters(id),
    FOREIGN KEY (fighter_b_id) REFERENCES fighters(id),
    FOREIGN KEY (fight_id) REFERENCES fights(id),
    FOREIGN KEY (winner_id) REFERENCES fighters(id)
  );
`);

// ── Betting tables ──
db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    owner_name TEXT PRIMARY KEY,
    balance INTEGER DEFAULT 100,
    total_won INTEGER DEFAULT 0,
    total_lost INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fight_id INTEGER NOT NULL,
    bettor_name TEXT NOT NULL,
    fighter_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    odds REAL DEFAULT 2.0,
    status TEXT DEFAULT 'pending',
    payout INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (fight_id) REFERENCES fights(id),
    FOREIGN KEY (fighter_id) REFERENCES fighters(id)
  );
`);

// ── ELO history table ──
db.exec(`
  CREATE TABLE IF NOT EXISTS elo_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fighter_id INTEGER NOT NULL,
    elo INTEGER NOT NULL,
    fight_id INTEGER,
    recorded_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (fighter_id) REFERENCES fighters(id)
  );
`);

// ── Create rivalries table ──
db.exec(`
  CREATE TABLE IF NOT EXISTS rivalries (
    fighter_a_id INTEGER NOT NULL,
    fighter_b_id INTEGER NOT NULL,
    total_fights INTEGER DEFAULT 0,
    fighter_a_wins INTEGER DEFAULT 0,
    fighter_b_wins INTEGER DEFAULT 0,
    is_rivalry INTEGER DEFAULT 0,
    PRIMARY KEY (fighter_a_id, fighter_b_id),
    FOREIGN KEY (fighter_a_id) REFERENCES fighters(id),
    FOREIGN KEY (fighter_b_id) REFERENCES fighters(id)
  );
`);

// ── Migration: add fatigue columns ──
{
  const cols = db.prepare('PRAGMA table_info(fighters)').all().map(c => c.name);
  if (!cols.includes('fatigue')) {
    db.exec(`ALTER TABLE fighters ADD COLUMN fatigue INTEGER DEFAULT 0`);
  }
  if (!cols.includes('last_fight_at')) {
    db.exec(`ALTER TABLE fighters ADD COLUMN last_fight_at INTEGER DEFAULT 0`);
  }
}

// ── Migration: add last_moves columns for combo tracking ──
{
  const cols = db.prepare('PRAGMA table_info(fights)').all().map(c => c.name);
  if (!cols.includes('last_moves_f1')) {
    db.exec(`ALTER TABLE fights ADD COLUMN last_moves_f1 TEXT DEFAULT ''`);
  }
  if (!cols.includes('last_moves_f2')) {
    db.exec(`ALTER TABLE fights ADD COLUMN last_moves_f2 TEXT DEFAULT ''`);
  }
}

module.exports = db;
