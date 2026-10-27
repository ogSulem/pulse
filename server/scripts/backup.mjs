// ─────────────────────────────────────────────────────────────────────────────
// Бэкап базы: консистентная копия SQLite без остановки сервиса.
//
//   npm run backup                 → data/backups/pulse-YYYY-MM-DD-HHMM.db
//   npm run backup -- --keep 30    → хранить 30 последних копий
//
// better-sqlite3 делает backup на уровне SQLite (страницы копируются целиком),
// поэтому копия валидна даже при активной записи — в отличие от cp файла,
// который может поймать середину транзакции или WAL без журнала.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/core/db.js';
import { DATA_DIR } from '../src/core/boot.js';

const args = process.argv.slice(2);
const keepArg = args.indexOf('--keep');
const keep = keepArg >= 0 ? Math.max(1, Number(args[keepArg + 1]) || 14) : 14;

const dir = process.env.PULSE_BACKUP_DIR || path.join(DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const file = path.join(dir, `pulse-${stamp}.db`);

await db.backup(file);
const size = fs.statSync(file).size;

const copies = fs.readdirSync(dir)
  .filter((name) => /^pulse-.*\.db$/.test(name))
  .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
  .sort((a, b) => b.at - a.at);

for (const old of copies.slice(keep)) {
  fs.rmSync(path.join(dir, old.name), { force: true });
}

const mediaDir = process.env.PULSE_MEDIA_DIR || path.join(DATA_DIR, 'media');
let mediaBytes = 0;
try {
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else mediaBytes += fs.statSync(full).size;
    }
  };
  if (fs.existsSync(mediaDir)) walk(mediaDir);
} catch { /* каталога ещё нет */ }

console.log(`Бэкап базы: ${file} (${(size / 1024).toFixed(0)} КБ)`);
console.log(`Копий в архиве: ${Math.min(copies.length, keep)} из ${keep}`);
console.log(`Медиа отдельно: ${mediaDir} (${(mediaBytes / 1048576).toFixed(1)} МБ) — видео не входит в дамп базы,`);
console.log('его стоит бэкапить тем же расписанием, если ролики нужны после переезда.');
