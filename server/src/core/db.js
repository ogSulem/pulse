import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.PULSE_DB_PATH || path.resolve(process.cwd(), 'data/pulse.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  niche         TEXT NOT NULL,
  description   TEXT DEFAULT '',
  product_url   TEXT DEFAULT '',
  language      TEXT DEFAULT 'ru',
  tone          TEXT DEFAULT 'friendly',
  format        TEXT DEFAULT 'problem-solution',
  aspect        TEXT DEFAULT '9:16',
  duration_sec  INTEGER DEFAULT 32,
  autopilot     INTEGER DEFAULT 1,
  posts_per_day INTEGER DEFAULT 2,
  ab_tests      INTEGER DEFAULT 1,
  archived      INTEGER DEFAULT 0,
  color         TEXT DEFAULT 'violet',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,              -- reels | tiktok
  handle        TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_hue    INTEGER DEFAULT 270,
  status        TEXT NOT NULL DEFAULT 'healthy', -- healthy | warmup | cooldown | blocked
  daily_limit   INTEGER DEFAULT 3,
  min_gap_min   INTEGER DEFAULT 90,
  window_start  TEXT DEFAULT '09:00',
  window_end    TEXT DEFAULT '23:00',
  timezone      TEXT DEFAULT 'Europe/Moscow',
  warmup_until  TEXT,
  blocked_until TEXT,
  quality       INTEGER DEFAULT 80,
  notes         TEXT DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  url          TEXT NOT NULL,
  pitch        TEXT DEFAULT '',
  proof        TEXT DEFAULT '',
  template     TEXT DEFAULT 'review',    -- review | before-after | problem-solution | case | meme
  utm_source   TEXT DEFAULT 'reels',
  utm_medium   TEXT DEFAULT 'short',
  utm_campaign TEXT DEFAULT 'pulse',
  active       INTEGER DEFAULT 1,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ideas (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  hook        TEXT NOT NULL,
  angle       TEXT NOT NULL,
  format      TEXT NOT NULL,
  tags        TEXT DEFAULT '[]',
  score       INTEGER DEFAULT 50,
  source      TEXT DEFAULT 'ai',
  status      TEXT DEFAULT 'new',       -- new | used | rejected
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
  id          TEXT PRIMARY KEY,
  idea_id     TEXT REFERENCES ideas(id) ON DELETE SET NULL,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hook        TEXT NOT NULL,
  scenes      TEXT NOT NULL,            -- JSON [{n, text, visual, seconds}]
  cta         TEXT NOT NULL,
  caption     TEXT DEFAULT '',
  hashtags    TEXT DEFAULT '[]',
  duration_sec INTEGER DEFAULT 30,
  tone        TEXT DEFAULT 'friendly',
  status      TEXT DEFAULT 'draft',     -- draft | approved | archived
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS episodes (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idea_id      TEXT,
  script_id    TEXT,
  product_id   TEXT,
  account_id   TEXT,
  title        TEXT NOT NULL,
  description  TEXT DEFAULT '',
  hashtags     TEXT DEFAULT '[]',
  scenes       TEXT DEFAULT '[]',
  cover_seed   TEXT DEFAULT '',
  topic        TEXT DEFAULT '',
  format       TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'queued',
  stage        TEXT NOT NULL DEFAULT 'idea',
  progress     INTEGER DEFAULT 0,
  risk         INTEGER DEFAULT 0,
  error        TEXT,
  attempts     INTEGER DEFAULT 0,
  autopilot    INTEGER DEFAULT 1,
  ab_test      INTEGER DEFAULT 0,
  scheduled_at TEXT,
  published_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publications (
  id            TEXT PRIMARY KEY,
  episode_id    TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL,
  account_id    TEXT,
  platform      TEXT NOT NULL,
  variant       TEXT DEFAULT 'A',       -- A | B (A/B-тест)
  title         TEXT DEFAULT '',
  description   TEXT DEFAULT '',
  hashtags      TEXT DEFAULT '[]',
  cover_seed    TEXT DEFAULT '',
  url           TEXT DEFAULT '',
  status        TEXT DEFAULT 'scheduled', -- scheduled | published | failed
  scheduled_at  TEXT,
  published_at  TEXT,
  views         INTEGER DEFAULT 0,
  likes         INTEGER DEFAULT 0,
  comments      INTEGER DEFAULT 0,
  shares        INTEGER DEFAULT 0,
  saves         INTEGER DEFAULT 0,
  clicks        INTEGER DEFAULT 0,
  followers     INTEGER DEFAULT 0,
  watch_avg     REAL DEFAULT 0,
  target_views  INTEGER DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics_daily (
  id             TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  day            TEXT NOT NULL,
  views          INTEGER DEFAULT 0,
  likes          INTEGER DEFAULT 0,
  comments       INTEGER DEFAULT 0,
  shares         INTEGER DEFAULT 0,
  clicks         INTEGER DEFAULT 0,
  followers      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_metrics_day ON metrics_daily(day);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      TEXT DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed | dead
  priority     INTEGER DEFAULT 5,
  attempts     INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 4,
  run_after    TEXT NOT NULL,
  lease_until  TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_jobs_due ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS logs (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info',   -- info | success | warn | error
  actor       TEXT DEFAULT 'system',
  action      TEXT NOT NULL,
  entity_type TEXT DEFAULT '',
  entity_id   TEXT DEFAULT '',
  message     TEXT NOT NULL,
  meta        TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_logs_ts ON logs(ts DESC);

CREATE TABLE IF NOT EXISTS accounts_daily (
  account_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  used       INTEGER DEFAULT 0,
  PRIMARY KEY (account_id, day)
);
`;

export function migrate() {
  db.exec(SCHEMA);
}

export const nowIso = () => new Date().toISOString();

export const settingsDefaults = {
  mode: process.env.PULSE_MODE || 'demo',
  timezone: process.env.PULSE_TZ || 'Europe/Moscow',
  autopilot_global: '1',
  manual_review: '0',
  risk_threshold: '55',
  max_daily_per_account: '3',
  niches: '[]',
};

export function ensureSettings() {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(settingsDefaults)) insert.run(key, String(value));
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) stmt.run(key, typeof value === 'string' ? value : JSON.stringify(value));
  });
  tx(Object.entries(patch));
  return getSettings();
}

export { DB_PATH };
