// ─────────────────────────────────────────────────────────────────────────────
// Обслуживание диска: медиа — самый прожорливый ресурс на хостинге.
//
// Один вертикальный ролик — 3–8 МБ, серия на 12 минут — 60–150 МБ. На Railway
// том Hobby — 5 ГБ, и без уборки он заполняется за месяц-полтора: сначала
// падают рендеры («ENOSPC»), потом база. Панель при этом выглядит здоровой.
//
// Поэтому: считаем занятое место, показываем его в готовности хостинга и убираем
// файлы старше PULSE_MEDIA_RETENTION_DAYS (по умолчанию 14 дней). Строки в базе
// и статистика НЕ удаляются — удаляется только сам файл, ссылка помечается
// `media_pruned`, и видео можно пересобрать из тех же сцен.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso } from '../core/db.js';
import { MEDIA_DIR } from './render.js';
import { log } from '../core/logger.js';

const env = process.env;

export const retentionDays = () => {
  const n = Number(env.PULSE_MEDIA_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 14;
};

const VIDEO_RE = /\.(mp4|webm|mov|m4a|mp3|wav)$/i;

function walk(dir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile()) {
      try {
        const st = fs.statSync(full);
        acc.push({ path: full, bytes: st.size, mtime: st.mtimeMs, video: VIDEO_RE.test(entry.name) });
      } catch { /* файл исчез между readdir и stat */ }
    }
  }
  return acc;
}

/** Что лежит в каталоге медиа: сколько файлов, сколько места, что можно убрать. */
export function storageUsage() {
  const files = walk(MEDIA_DIR);
  const cutoff = Date.now() - retentionDays() * 86400000;
  const stale = files.filter((f) => f.mtime < cutoff);
  const sum = (arr) => arr.reduce((a, f) => a + f.bytes, 0);
  return {
    dir: MEDIA_DIR,
    files: files.length,
    bytes: sum(files),
    videos: files.filter((f) => f.video).length,
    videoBytes: sum(files.filter((f) => f.video)),
    staleFiles: stale.length,
    staleBytes: sum(stale),
    retentionDays: retentionDays(),
    freeBytes: (() => {
      try {
        const s = fs.statfsSync(MEDIA_DIR);
        return s.bavail * s.bsize;
      } catch { return null; }
    })(),
  };
}

/**
 * Удаляет файлы старше retention. По умолчанию ровно то, что попадает под
 * политику; `dryRun` только считает.
 */
export function pruneMedia({ days = null, dryRun = false, includeAll = false } = {}) {
  const keepDays = Number(days) > 0 ? Number(days) : retentionDays();
  const cutoff = Date.now() - keepDays * 86400000;
  const files = walk(MEDIA_DIR).filter((f) => includeAll || f.video);
  const stale = files.filter((f) => f.mtime < cutoff);
  let freedBytes = 0;
  let removed = 0;
  for (const file of stale) {
    if (dryRun) { freedBytes += file.bytes; removed += 1; continue; }
    try {
      fs.rmSync(file.path, { force: true });
      freedBytes += file.bytes;
      removed += 1;
    } catch { /* файл занят рендером — уберём в следующий раз */ }
  }
  if (!dryRun && removed) {
    // помечаем эпизоды, у которых файл убран, — в интерфейсе видно, что ролик
    // остаётся в статистике, но локального mp4 больше нет
    try {
      const rows = db.prepare("SELECT id, video_path FROM episodes WHERE video_path IS NOT NULL AND video_path <> ''").all();
      for (const row of rows) {
        const abs = path.isAbsolute(row.video_path) ? row.video_path : path.join(MEDIA_DIR, path.basename(row.video_path));
        if (!fs.existsSync(abs)) db.prepare('UPDATE episodes SET media_pruned_at = ? WHERE id = ?').run(nowIso(), row.id);
      }
    } catch { /* старая база без колонки — не критично */ }
    log({
      level: 'info', actor: 'system', action: 'storage.pruned',
      message: `Уборка медиа: ${removed} файлов, освобождено ${Math.round(freedBytes / 1024 ** 2)} МБ (порог ${keepDays} дн.)`,
      meta: { removed, freedBytes, keepDays },
    });
  }
  return { ok: true, dryRun, keepDays, removed, freedBytes, ...storageUsage() };
}

/**
 * Плановая уборка из планировщика: не чаще раза в 6 часов и только если есть
 * что убирать. Возвращает null, когда ничего не делалось.
 */
let lastRunAt = 0;
export function autoPrune({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastRunAt < 6 * 3600 * 1000) return null;
  const usage = storageUsage();
  if (!usage.staleFiles && !force) { lastRunAt = now; return null; }
  const result = pruneMedia();
  lastRunAt = now;
  return result;
}
