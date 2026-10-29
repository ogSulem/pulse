import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, ensureDirs } from './paths.js';

// база, медиа и секрет живут в одном каталоге данных (см. core/paths.js)
ensureDirs();
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
  platform      TEXT NOT NULL,              -- reels | tiktok | youtube
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
  source      TEXT DEFAULT 'template',
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

CREATE TABLE IF NOT EXISTS clicks (
  id            TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  project_id    TEXT DEFAULT '',
  ts            TEXT NOT NULL,
  ua            TEXT DEFAULT '',
  ref           TEXT DEFAULT '',
  ip_hash       TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_clicks_pub ON clicks(publication_id);

CREATE TABLE IF NOT EXISTS conversions (
  id            TEXT PRIMARY KEY,
  click_id      TEXT,
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  project_id    TEXT DEFAULT '',
  value_cents   INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'confirmed',
  external_id   TEXT,
  ts            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_conv_pub ON conversions(publication_id);
CREATE UNIQUE INDEX IF NOT EXISTS ix_conv_ext ON conversions(external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS accounts_daily (
  account_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  used       INTEGER DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

-- ── Реклама: бренды, кампании и фактические выходы ─────────────────────────
CREATE TABLE IF NOT EXISTS brands (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  legal_name TEXT DEFAULT '',           -- юрлицо для маркировки рекламы
  inn        TEXT DEFAULT '',
  contact    TEXT DEFAULT '',
  notes      TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id            TEXT PRIMARY KEY,
  brand_id      TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  project_id    TEXT,                    -- NULL = любая площадка/проект
  name          TEXT NOT NULL,
  model         TEXT DEFAULT 'fixed',    -- fixed | cpm | cpa | barter
  budget_cents  INTEGER DEFAULT 0,       -- 0 = без потолка (бартер/пост-оплата)
  rate_cents    INTEGER DEFAULT 0,       -- fixed: за пост; cpm: за 1000 показов; cpa: за конверсию
  posts_target  INTEGER DEFAULT 1,
  starts_at     TEXT,
  ends_at       TEXT,
  status        TEXT DEFAULT 'draft',    -- draft | active | paused | done
  brief         TEXT DEFAULT '',
  mention       TEXT DEFAULT '',         -- @бренд в описании
  link_url      TEXT DEFAULT '',
  hashtags      TEXT DEFAULT '[]',
  erid          TEXT DEFAULT '',         -- токен маркировки (ОРД)
  marking       TEXT DEFAULT 'erid',     -- erid | brand | none
  paid_cents    INTEGER DEFAULT 0,       -- сколько бренд уже заплатил
  daily_cap     INTEGER DEFAULT 1,       -- максимум выходов в сутки по кампании
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_campaigns_status ON campaigns(status);

CREATE TABLE IF NOT EXISTS campaign_posts (
  id             TEXT PRIMARY KEY,
  campaign_id    TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  episode_id     TEXT NOT NULL,
  publication_id TEXT,
  revenue_cents  INTEGER DEFAULT 0,
  views          INTEGER DEFAULT 0,
  clicks         INTEGER DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_campaign_posts ON campaign_posts(campaign_id, episode_id);

-- ── Сериалы (длинные истории 10–20 минут) ──────────────────────────────────
-- Отдельные таблицы, а не «эпизоды с флагом»: у сериала своя библия, сезон,
-- арка и сквозные персонажи. Шортсы живут в episodes и не смешиваются с ним.
CREATE TABLE IF NOT EXISTS series (
  id               TEXT PRIMARY KEY,
  project_id       TEXT,
  title            TEXT NOT NULL,
  genre            TEXT NOT NULL DEFAULT 'zombie',
  premise          TEXT DEFAULT '',
  tone             TEXT DEFAULT 'cinematic',
  bible            TEXT NOT NULL DEFAULT '{}',
  season           INTEGER DEFAULT 1,
  episodes_planned INTEGER DEFAULT 6,
  episode_sec      INTEGER DEFAULT 900,
  season_plan      TEXT NOT NULL DEFAULT '{}',
  status           TEXT DEFAULT 'draft',
  playlist_id      TEXT,
  show_id          TEXT,
  cadence          TEXT DEFAULT '',
  notes            TEXT DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_series_status ON series(status);

CREATE TABLE IF NOT EXISTS series_episodes (
  id              TEXT PRIMARY KEY,
  series_id       TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  project_id      TEXT,
  episode_no      INTEGER NOT NULL,
  title           TEXT DEFAULT '',
  logline         TEXT DEFAULT '',
  arc             TEXT DEFAULT '',
  stage           TEXT DEFAULT 'planned',
  script          TEXT DEFAULT '{}',
  scenes          TEXT DEFAULT '[]',
  chapters        TEXT DEFAULT '[]',
  cuts            TEXT DEFAULT '[]',
  duration_sec    INTEGER DEFAULT 0,
  words           INTEGER DEFAULT 0,
  wpm             INTEGER DEFAULT 0,
  mid_rolls       INTEGER DEFAULT 0,
  rolls_at        TEXT DEFAULT '[]',
  description     TEXT DEFAULT '',
  tags            TEXT DEFAULT '[]',
  thumb_text      TEXT DEFAULT '',
  title_variants  TEXT DEFAULT '[]',
  scores          TEXT DEFAULT '{}',
  authenticity    TEXT DEFAULT '{}',
  forecast        TEXT DEFAULT '{}',
  disclosure      TEXT DEFAULT '',
  frames          TEXT DEFAULT '[]',
  video_path      TEXT,
  video_bytes     INTEGER DEFAULT 0,
  render_ms       INTEGER DEFAULT 0,
  cover_paths     TEXT DEFAULT '{}',
  audio_path      TEXT,
  audio_sec       REAL DEFAULT 0,
  publish_at      TEXT,
  published_at    TEXT,
  external_id     TEXT,
  views           INTEGER DEFAULT 0,
  rpm             REAL DEFAULT 0,
  revenue_cents   INTEGER DEFAULT 0,
  cost_cents      INTEGER DEFAULT 0,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_series_ep_no ON series_episodes(series_id, episode_no);
CREATE INDEX IF NOT EXISTS ix_series_ep_stage ON series_episodes(stage);
`;

// SQLite не умеет ADD COLUMN IF NOT EXISTS — добавляем колонки точечно.
function ensureColumns() {
  const want = {
    episodes: {
      video_path: 'TEXT',
      video_bytes: 'INTEGER DEFAULT 0',
      render_ms: 'INTEGER DEFAULT 0',
      cover_paths: "TEXT DEFAULT '{}'",
      compliance: "TEXT DEFAULT '{}'",
      viral: 'INTEGER DEFAULT 0',
      viral_meta: "TEXT DEFAULT '{}'",
      cost_cents: 'INTEGER DEFAULT 0',
      ab_winner: 'TEXT',
      ab_meta: "TEXT DEFAULT '{}'",
      forecast: "TEXT DEFAULT '{}'",
      campaign_id: 'TEXT',
      ad_disclosure: "TEXT DEFAULT ''",
      // площадка, под которую написан текст: у каждой свой лимит и свой CTA
      caption_platform: 'TEXT',
      // решение по продаже продукта на момент сценария: direct | soft | none
      promo: "TEXT DEFAULT 'none'",
      // паспорт креатива: хук, оценки, варианты — чтобы в карточке было видно, почему так
      creative: "TEXT DEFAULT '{}'",
      // файл убран плановой уборкой диска: статистика осталась, mp4 можно пересобрать
      media_pruned_at: 'TEXT',
    },
    accounts: {
      access_token: 'TEXT',
      external_id: 'TEXT',
      token_expires_at: 'TEXT',
      auth_note: 'TEXT',
      // подписчики: вручную или из API канала. Нужны портфелю и прогрессу монетизации
      followers: 'INTEGER DEFAULT 0',
      followers_updated_at: 'TEXT',
      followers_source: "TEXT DEFAULT 'manual'",
      // бренд-привязка: аккаунт ведёт один проект. NULL — универсальный (можно всё)
      project_id: 'TEXT',
      // OAuth: токен обновления, выданные права и способ подключения
      refresh_token: 'TEXT',
      token_scope: 'TEXT',
      // персона канала: тема, лицо/подача, язык — по ним строится контент
      topic: "TEXT DEFAULT ''",
      persona: "TEXT DEFAULT '{}'",
      language: "TEXT DEFAULT 'ru'",
      // визуальный стиль канала (для сериалов и обложек): палитра + look
      visual_style: "TEXT DEFAULT ''",
    },
    publications: {
      cover_path: 'TEXT',
      click_token: 'TEXT',
      privacy: "TEXT DEFAULT 'public'",
      cost_cents: 'INTEGER DEFAULT 0',
      revenue_cents: 'INTEGER DEFAULT 0',
      external_id: 'TEXT',
      publish_id: 'TEXT',
    },
    projects: {
      ai_generated: 'INTEGER DEFAULT 1',
    },

    products: {
      // где показывать продукт: video | caption | both
      placement: "TEXT DEFAULT 'both'",
      // как часто напоминать: 0 — только по правилу 80/20, 1 — в каждом ролике
      always: 'INTEGER DEFAULT 0',
      // последняя проверка ссылки глазами зрителя: видно в карточке до публикации
      link_checked_at: 'TEXT',
      link_status: 'INTEGER',
      link_level: 'TEXT',
      link_note: "TEXT DEFAULT ''",
    },
    series: {
      // сериал переиспользует проект-бренд, но может жить и без него
      project_id: 'TEXT',
      season_plan: "TEXT NOT NULL DEFAULT '{}'",
      playlist_id: 'TEXT',
      show_id: 'TEXT',
      cadence: "TEXT DEFAULT ''",
      notes: "TEXT DEFAULT ''",
      updated_at: 'TEXT',
      // автопилот сериала: сочинять серии заранее и собирать их без человека
      auto_compose: 'INTEGER DEFAULT 1',
      auto_render: 'INTEGER DEFAULT 0',
      lookahead: 'INTEGER DEFAULT 3',
      // источник фото-ряда: auto | neural | procedural
      frame_mode: "TEXT DEFAULT 'auto'",
    },
    series_episodes: {
      audio_path: 'TEXT',
      audio_sec: 'REAL DEFAULT 0',
      frames: "TEXT DEFAULT '[]'",
      cuts: "TEXT DEFAULT '[]'",
      disclosure: "TEXT DEFAULT ''",
      error: 'TEXT',
    },
    conversions: {
      external_id: 'TEXT',
      publish_id: 'TEXT',
    },
  };
  for (const [table, cols] of Object.entries(want)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, def] of Object.entries(cols)) {
      if (!existing.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
  }
}

function migrateV2Settings() {
  // В v1 ставки RPM и себестоимости были в долларах и слишком оптимистичны.
  // Обновляем только те значения, которые остались нетронутыми дефолтами.
  const upgrades = {
    rpm_reels: ['120', '25'],
    rpm_tiktok: ['60', '10'],
    cost_video: ['0.9', '45'],
    cost_tts: ['0.25', '12'],
    cost_llm: ['0.1', '8'],
    cost_render: ['0.05', '1'],
  };
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [key, [from, to]] of Object.entries(upgrades)) {
    if (get.get(key)?.value === from) set.run(key, to);
  }
  if (!get.get('schema_v2')?.value) set.run('schema_v2', '1');
}

export function migrate() {
  db.exec(SCHEMA);
  ensureColumns();
  migrateV2Settings();
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

  // ── площадки: реальные лимиты и статус приложений ────────────────────────
  tiktok_audited: '0',            // 0 = неаудированный клиент → только приватные посты
  youtube_audited: '0',           // 0 = проект Google без аудита → загрузки только private
  series_autopublish: '1',        // серии, поставленные в расписание, публикуются сами
  tiktok_privacy: 'SELF_ONLY',
  ai_label: '1',                  // помечать AI-контент (требование площадок)
  ad_label: '1',                  // помечать рекламу в описании
  min_viral_score: '45',          // ниже порога — ролик уходит на проверку

  // ── деньги: юнит-экономика (₽) ───────────────────────────────────────────
  currency: '₽',
  rpm_reels: '25',                // доход с 1000 просмотров Reels, ₽
  rpm_tiktok: '10',
  rpm_youtube: '30',
  // длинные серии (10–20 мин) монетизируются в 2–3 раза лучше шортсов:
  // пре-ролл + мид-роллы + пост-ролл. Ставка — средняя по хоррору и мистике.
  rpm_youtube_long: '190',
  series_episode_sec: '900',      // целевая длина серии, секунд
  series_episodes: '6',           // серий в сезоне
  series_max_sec: '1200',         // потолок рендера одной серии
  series_quality: 'high',         // качество рендера сериала (high|balanced|fast)
  // фото-ряд сериала: auto — нейросетевые кадры, если провайдер доступен;
  // neural — всегда (с откатом на плашки), procedural — только вектор
  series_frames: 'auto',
  series_image_max: '60',         // сколько уникальных кадров генерировать на серию
  series_auto_compose: '1',       // серии сочиняются заранее по арке сезона
  series_auto_render: '0',        // ...и собираются в видео автоматически (тяжело по CPU)
  series_lookahead: '3',          // сколько серий держим готовыми впереди
  cost_tts_1000: '20',            // озвучка длинной серии, ₽ за 1000 знаков (ElevenLabs ~$0.22/1000)
  cost_render_min: '6',           // рендер 16:9, ₽ за минуту готового видео
  conv_rate: '1.6',               // % кликов, которые становятся покупкой
  ctr_estimate: '1.2',            // % просмотров, которые переходят по ссылке
  postback_key: '',               // секрет для POST /api/postback (пусто = demo без проверки)
  product_price: '2490',
  product_margin: '0.55',         // доля маржи в цене
  cost_video: '45',               // генерация видеоряда, ₽/ролик
  cost_tts: '12',
  cost_llm: '8',
  cost_render: '1',
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
