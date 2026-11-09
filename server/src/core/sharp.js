import os from 'node:os';
import { createRequire } from 'node:module';

/**
 * Одна точка настройки sharp/libvips на всё приложение.
 *
 * libvips по умолчанию держит кэш файлов и пул потоков по числу ядер. На
 * небольшом VPS (1–2 ГБ) это давало постоянные 500–600 МБ RSS и заметный CPU
 * даже без работы. Настройки ниже применяются один раз — до первого рендера.
 *
 * Раньше каждый модуль (render, frames, serialrender) подключал sharp сам и
 * настраивал по-своему: порядок импортов решал, какие настройки победят. Теперь
 * источник один, и `sharp === null` значит «нативный модуль не собрался» —
 * рендер переключается на процедурные кадры, а не падает.
 */
const require = createRequire(import.meta.url);

let sharp = null;
try {
  sharp = require('sharp');
  // кэш памяти в мегабайтах; файловый кэш выключен — слои читаются один раз
  sharp.cache({ memory: 32, files: 0, items: 24 });
  // один рендер за раз: больше потоков = больше RSS без выигрыша по времени
  sharp.concurrency(Math.max(1, Math.min(2, os.cpus().length || 1)));
} catch {
  sharp = null;
}

export { sharp };
export default sharp;
