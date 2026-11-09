// ─────────────────────────────────────────────────────────────────────────────
// Обслуживание диска и данных: всё, что должно происходить само, годами, без
// человека. Панель на VPS живёт месяцами, поэтому «мусор» здесь — не мелочь:
// один вертикальный ролик 3–8 МБ, серия 60–150 МБ, обложки и кадры — ещё
// столько же. Без уборки сначала падают рендеры на ENOSPC, потом база.
//
// Что убирается и когда (всё настраивается переменными, у всего есть разумный
// дефолт — «поставил и забыл»):
//   • видео и обложки в media/      — PULSE_MEDIA_RETENTION_DAYS (14 дней);
//   • кадры нейро-ряда в media/frames — PULSE_FRAME_RETENTION_DAYS (30 дней):
//     это кэш, кадр пересобирается по тому же промпту;
//   • ответы ИИ в data/ai-cache      — PULSE_CACHE_RETENTION_DAYS (7 дней);
//   • рабочие каталоги media/tmp     — через 6 часов (после падения рендера);
//   • задачи очереди done/dead       — 3 и 30 дней;
//   • копии базы data/backups        — ежедневно, храним 7 последних.
//
// Строки в базе и статистика НЕ удаляются — удаляется только файл, эпизод
// помечается `media_pruned_at`, и ролик можно пересобрать из тех же сцен.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso } from '../core/db.js';
import { DATA_DIR, MEDIA_DIR } from '../core/paths.js';
import { log } from '../core/logger.js';
import { cleanupJobs } from '../core/queue.js';

const env = process.env;

/** Сколько дней храним готовые ролики и обложки. */
export const retentionDays = () => {
  const n = Number(env.PULSE_MEDIA_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 14;
};

/** Сколько дней живёт кэш кадров нейро-ряда (генерируется заново по промпту). */
export const frameRetentionDays = () => {
  const n = Number(env.PULSE_FRAME_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 30;
};

/** Сколько дней живёт кэш ответов ИИ. */
export const cacheRetentionDays = () => {
  const n = Number(env.PULSE_CACHE_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 7;
};

/** Рабочий каталог рендера старше этого возраста считается брошенным. */
const TMP_MAX_AGE_MS = 6 * 3600 * 1000;

export const FRAME_DIR = path.join(MEDIA_DIR, 'frames');
export const TMP_DIR = path.join(MEDIA_DIR, 'tmp');
export const CACHE_DIR = path.join(DATA_DIR, 'ai-cache');
export const BACKUP_DIR = env.PULSE_BACKUP_DIR
  ? path.resolve(env.PULSE_BACKUP_DIR)
  : path.join(DATA_DIR, 'backups');

const VIDEO_RE = /\.(mp4|webm|mov|m4a|mp3|wav|aac)$/i;
const IMAGE_RE = /\.(jpe?g|png|webp|avif)$/i;

function kindOf(file, relPath) {
  if (relPath.startsWith('tmp/')) return 'tmp';
  if (relPath.startsWith('frames/')) return 'frame';
  if (VIDEO_RE.test(file)) return 'video';
  if (IMAGE_RE.test(file)) return 'image';
  return 'other';
}

function walk(dir, acc = [], base = dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc, base);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const st = fs.statSync(full);
      const rel = path.relative(base, full).split(path.sep).join('/');
      acc.push({ path: full, rel, bytes: st.size, mtime: st.mtimeMs, kind: kindOf(entry.name, rel) });
    } catch { /* файл исчез между readdir и stat */ }
  }
  return acc;
}

const sumBytes = (arr) => arr.reduce((a, f) => a + f.bytes, 0);

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = dirStats(full);
        files += nested.files;
        bytes += nested.bytes;
      } else {
        files += 1;
        try { bytes += fs.statSync(full).size; } catch { /* исчез */ }
      }
    }
  } catch { /* каталога нет */ }
  return { files, bytes };
}

function backupsInfo() {
  let items = [];
  try {
    items = fs.readdirSync(BACKUP_DIR)
      .filter((name) => /^pulse-.*\.db$/.test(name))
      .map((name) => {
        const full = path.join(BACKUP_DIR, name);
        const st = fs.statSync(full);
        return { name, bytes: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  } catch { /* копий ещё нет */ }
  return {
    count: items.length,
    bytes: items.reduce((a, f) => a + f.bytes, 0),
    lastAt: items[0] ? new Date(items[0].at).toISOString() : null,
    lastBytes: items[0]?.bytes || 0,
  };
}

/**
 * Что лежит в каталоге медиа: разложено по видам, чтобы в панели было видно,
 * что именно занимает место, и что попадает под уборку.
 */
export function storageUsage() {
  const files = walk(MEDIA_DIR);
  const cutoff = Date.now() - retentionDays() * 86400000;
  const by = (kind) => files.filter((f) => f.kind === kind);
  const staleOf = (kind, days) => by(kind).filter((f) => f.mtime < Date.now() - days * 86400000);
  const stale = [
    ...staleOf('video', retentionDays()),
    ...staleOf('image', retentionDays()),
    ...staleOf('frame', frameRetentionDays()),
    ...by('tmp').filter((f) => f.mtime < Date.now() - TMP_MAX_AGE_MS),
  ];
  const cache = dirStats(CACHE_DIR);
  return {
    dir: MEDIA_DIR,
    files: files.length,
    bytes: sumBytes(files),
    videos: by('video').length,
    videoBytes: sumBytes(by('video')),
    images: by('image').length,
    imageBytes: sumBytes(by('image')),
    frames: by('frame').length,
    frameBytes: sumBytes(by('frame')),
    tmpFiles: by('tmp').length,
    tmpBytes: sumBytes(by('tmp')),
    cache: { ...cache, days: cacheRetentionDays() },
    backups: backupsInfo(),
    staleFiles: stale.length,
    staleBytes: sumBytes(stale),
    retentionDays: retentionDays(),
    frameRetentionDays: frameRetentionDays(),
    freeBytes: (() => {
      try {
        const s = fs.statfsSync(MEDIA_DIR);
        return s.bavail * s.bsize;
      } catch { return null; }
    })(),
  };
}

function removeFiles(list, dryRun, acc) {
  for (const file of list) {
    if (dryRun) {
      acc.freedBytes += file.bytes;
      acc.removed += 1;
      continue;
    }
    try {
      fs.rmSync(file.path, { force: true });
      acc.freedBytes += file.bytes;
      acc.removed += 1;
    } catch { /* файл занят рендером — уберём в следующий раз */ }
  }
}

/** Отмечает эпизоды, у которых файла больше нет: статистика остаётся, mp4 можно пересобрать. */
function markPrunedEpisodes() {
  try {
    const rows = db.prepare("SELECT id, video_path FROM episodes WHERE video_path IS NOT NULL AND video_path <> '' AND media_pruned_at IS NULL").all();
    const stmt = db.prepare('UPDATE episodes SET media_pruned_at = ? WHERE id = ?');
    for (const row of rows) {
      const abs = path.isAbsolute(row.video_path) ? row.video_path : path.join(MEDIA_DIR, path.basename(row.video_path));
      if (!fs.existsSync(abs)) stmt.run(nowIso(), row.id);
    }
  } catch { /* старая база без колонки — не критично */ }
}

/**
 * Уборка медиа. `days` перекрывает порог для роликов и обложек, кадры и кэш
 * живут по своим срокам. `dryRun` только считает.
 */
export function pruneMedia({ days = null, dryRun = false, includeAll = false } = {}) {
  const keepDays = Number(days) > 0 ? Number(days) : retentionDays();
  const files = walk(MEDIA_DIR);
  const olderThan = (list, d) => list.filter((f) => f.mtime < Date.now() - d * 86400000);

  const targets = includeAll
    ? files.filter((f) => f.kind !== 'tmp')
    : [
        ...olderThan(files.filter((f) => f.kind === 'video' || f.kind === 'image'), keepDays),
        ...olderThan(files.filter((f) => f.kind === 'frame'), frameRetentionDays()),
        ...olderThan(files.filter((f) => f.kind === 'tmp'), TMP_MAX_AGE_MS / 86400000),
      ];

  const acc = { removed: 0, freedBytes: 0 };
  removeFiles(targets, dryRun, acc);
  if (!dryRun && acc.removed) markPrunedEpisodes();

  return { ok: true, dryRun, keepDays, frameDays: frameRetentionDays(), ...acc, ...storageUsage() };
}

/** Брошенные рабочие каталоги после падений: иначе они лежат годами. */
export function cleanupTemp({ dryRun = false } = {}) {
  const files = walk(TMP_DIR).filter((f) => f.mtime < Date.now() - TMP_MAX_AGE_MS);
  const acc = { removed: 0, freedBytes: 0 };
  removeFiles(files, dryRun, acc);
  // пустые каталоги от прерванных рендеров
  if (!dryRun) {
    try {
      for (const entry of fs.readdirSync(TMP_DIR, { withFileTypes: true })) {
        const full = path.join(TMP_DIR, entry.name);
        if (entry.isDirectory() && fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      }
    } catch { /* каталога ещё нет */ }
  }
  return acc;
}

/** Кэш ответов ИИ: TTL проверяется при чтении, но файлы иначе копятся вечно. */
export function cleanupCache({ dryRun = false } = {}) {
  const days = cacheRetentionDays();
  let removed = 0;
  let freedBytes = 0;
  let entries = [];
  try { entries = fs.readdirSync(CACHE_DIR); } catch { return { removed, freedBytes, days }; }
  const cutoff = Date.now() - days * 86400000;
  for (const name of entries) {
    if (!name.endsWith('.json') || name === 'usage.json') continue;
    const full = path.join(CACHE_DIR, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs >= cutoff) continue;
      freedBytes += st.size;
      removed += 1;
      if (!dryRun) fs.rmSync(full, { force: true });
    } catch { /* исчез */ }
  }
  return { removed, freedBytes, days };
}

/**
 * Копия базы. better-sqlite3 делает backup на уровне SQLite: файл валиден даже
 * при активной записи, в отличие от `cp` (может поймать середину транзакции).
 */
export async function backupDatabase({ keep = 7 } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(BACKUP_DIR, `pulse-${stamp}.db`);
  await db.backup(file);
  const size = fs.statSync(file).size;

  const copies = fs.readdirSync(BACKUP_DIR)
    .filter((name) => /^pulse-.*\.db$/.test(name))
    .map((name) => ({ name, at: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const old of copies.slice(keep)) fs.rmSync(path.join(BACKUP_DIR, old.name), { force: true });

  return { ok: true, file, size, kept: Math.min(copies.length, keep), keep };
}

/**
 * Полное обслуживание: вызывается при старте (с задержкой) и раз в 6 часов.
 * Каждый шаг изолирован: сбой уборки кэша не должен оставить без бэкапа.
 */
export async function maintenance({ force = false, backup = true } = {}) {
  const summary = { at: nowIso(), temp: null, media: null, cache: null, jobs: 0, backup: null, integrity: null, errors: [] };
  const step = async (name, fn) => {
    try { return await fn(); } catch (err) {
      summary.errors.push(`${name}: ${String(err?.message || err).slice(0, 200)}`);
      return null;
    }
  };

  summary.temp = await step('temp', () => cleanupTemp());
  summary.cache = await step('cache', () => cleanupCache());

  const usage = await step('usage', () => storageUsage());
  if (force || usage?.staleFiles) summary.media = await step('media', () => pruneMedia());

  summary.jobs = (await step('jobs', () => cleanupJobs())) || 0;

  // Раз в неделю — быстрая проверка целостности базы. SQLite на VPS годами
  // живёт в контейнере, который могут убить в момент записи; лучше узнать о
  // повреждении из журнала заранее, чем в день, когда понадобилась статистика.
  const week = 7 * 86400000;
  if (force || !lastIntegrityAt || Date.now() - lastIntegrityAt > week) {
    lastIntegrityAt = Date.now();
    summary.integrity = await step('integrity', () => {
      const row = db.prepare('PRAGMA quick_check').get();
      const okFlag = String(Object.values(row || {})[0] || '') === 'ok';
      if (!okFlag) {
        log({ level: 'error', actor: 'system', action: 'db.integrity', message: `Проверка базы не прошла: ${JSON.stringify(row).slice(0, 200)}` });
      }
      return { ok: okFlag };
    });
  }

  if (backup) {
    const info = backupsInfo();
    const day = 24 * 3600 * 1000;
    const due = force || !info.lastAt || Date.now() - new Date(info.lastAt).getTime() > day;
    if (due) summary.backup = await step('backup', () => backupDatabase({ keep: 7 }));
  }

  const freed = (summary.media?.freedBytes || 0) + (summary.temp?.freedBytes || 0) + (summary.cache?.freedBytes || 0);
  if (freed || summary.jobs || summary.backup) {
    log({
      level: 'info', actor: 'system', action: 'maintenance',
      message: `Обслуживание: освобождено ${Math.round(freed / 1024 ** 2)} МБ, файлов ${(summary.media?.removed || 0) + (summary.temp?.removed || 0) + (summary.cache?.removed || 0)}, задач убрано ${summary.jobs}${summary.backup ? `, копия базы ${Math.round(summary.backup.size / 1024)} КБ` : ''}`,
      meta: { freed, media: summary.media?.removed || 0, temp: summary.temp?.removed || 0, cache: summary.cache?.removed || 0, jobs: summary.jobs, backup: summary.backup?.file || null },
    });
  }
  return summary;
}

/**
 * Совместимость: прежняя точка входа из планировщика. Теперь делает полное
 * обслуживание, но не чаще раза в 6 часов (если не force).
 */
let lastRunAt = 0;
let lastIntegrityAt = 0;
export async function autoPrune({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastRunAt < 6 * 3600 * 1000) return null;
  lastRunAt = now;
  return maintenance({ force });
}
