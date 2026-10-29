import fs from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Один каталог данных на всё приложение.
//
// Раньше база, медиа и секрет подписи определялись независимо: `PULSE_DB_PATH`,
// `PULSE_MEDIA_DIR` и `PULSE_DATA_DIR`. Если задать только `PULSE_DATA_DIR`
// (а именно так написано в .env.example), база и ролики всё равно уезжали в
// ./data рядом с процессом — на Railway это значит «данные вне тома» и потерю
// всего после перезапуска. Теперь база и медиа по умолчанию лежат внутри
// DATA_DIR, а явные переменные по-прежнему главнее (нужны, когда том монтируют
// в отдельные каталоги).
// ─────────────────────────────────────────────────────────────────────────────

export const DATA_DIR = process.env.PULSE_DATA_DIR
  ? path.resolve(process.env.PULSE_DATA_DIR)
  : path.resolve(process.cwd(), 'data');

export const DB_PATH = process.env.PULSE_DB_PATH
  ? path.resolve(process.env.PULSE_DB_PATH)
  : path.join(DATA_DIR, 'pulse.db');

export const MEDIA_DIR = process.env.PULSE_MEDIA_DIR
  ? path.resolve(process.env.PULSE_MEDIA_DIR)
  : path.join(DATA_DIR, 'media');

/** Создаёт каталоги, без которых приложение не стартует. Возвращает фактические пути. */
export function ensureDirs() {
  for (const dir of [DATA_DIR, path.dirname(DB_PATH), MEDIA_DIR]) fs.mkdirSync(dir, { recursive: true });
  return { DATA_DIR, DB_PATH, MEDIA_DIR };
}

export default { DATA_DIR, DB_PATH, MEDIA_DIR };
