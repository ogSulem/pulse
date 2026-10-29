// ─────────────────────────────────────────────────────────────────────────────
// Neural frames — фото-ряд сериала, нарисованный нейросетью.
//
// Зачем отдельный слой:
//   • кэш. Один и тот же «пустой город, общий план, холодный свет» не нужно
//     генерировать заново в каждой серии — файл переиспользуется по хешу;
//   • троттлинг. Бесплатный тариф Pollinations — ~1 запрос в 15 секунд, иначе
//     получаем 429 и портим рендер;
//   • детерминированный откат. Нет ключа, лимит, таймаут — возвращаем null,
//     и серия рендерится процедурными плашками, а не падает.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { MEDIA_DIR } from './render.js';
import { image } from '../providers/image.js';
import { log } from '../core/logger.js';
import { getSettings } from '../core/db.js';

const require = createRequire(import.meta.url);
let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }

export const FRAME_DIR = path.join(MEDIA_DIR, 'frames');
fs.mkdirSync(FRAME_DIR, { recursive: true });

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 24);

/**
 * Промпт кадра. Собирается из того, что уже описано в библии и сцене,
 * и намеренно НЕ содержит текст сцены: иначе каждая серия генерирует 95
 * уникальных картинок и рендер превращается в часы ожидания.
 */
export function imagePromptFor({ frame = {}, look = '', palette = '', variant = 0 } = {}) {
  const scenery = frame.sceneryRu || frame.scenery || 'пустая улица';
  const shot = frame.shotRu || frame.shot || 'общий план';
  const mood = {
    ash: 'холодный пепельный свет, туман',
    ink: 'ночной синий свет, контровой свет',
    ember: 'тёплые отблески огня, дым',
    moss: 'зелёный сырой свет, туман в низине',
    rust: 'рыжая пыль, закат сквозь дымку',
    ice: 'ледяной свет, морозная дымка',
  }[palette] || 'естественный свет, холодные тени';
  const variantNote = ['', 'человек в кадре со спины', 'крупная деталь на переднем плане', 'далёкий силуэт'][variant % 4];
  return [scenery, shot, mood, variantNote, look].filter(Boolean).join(', ');
}

let chain = Promise.resolve();
let lastAt = 0;

async function throttle(gapSec) {
  const run = async () => {
    const gap = Math.max(0, gapSec * 1000);
    const wait = Math.max(0, lastAt + gap - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  };
  // последовательная очередь: параллельные запросы к бесплатному тарифу дают 429
  chain = chain.then(run, run);
  return chain;
}

/** Сколько кадров уже в кэше — показываем в UI, чтобы было видно прогресс. */
export function framesStatus() {
  let cached = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(FRAME_DIR)) {
      if (!name.endsWith('.jpg')) continue;
      cached += 1;
      bytes += fs.statSync(path.join(FRAME_DIR, name)).size;
    }
  } catch { /* каталога ещё нет */ }
  // mode читает настройку сериалов: UI показывает, пойдёт нейро-ряд или плашки
  let mode = 'auto';
  try { mode = getSettings().series_frames || 'auto'; } catch { /* до миграции */ }
  return { ...image.status(), mode, dir: FRAME_DIR, cached, cachedMb: Math.round((bytes / 1048576) * 10) / 10 };
}

/**
 * Кадр по описанию. Возвращает путь к png нужного размера или null.
 * Никогда не бросает: рендер серии важнее картинки.
 */
export async function neuralFrame({ prompt, width, height, seed = 1, timeoutMs = 120000 } = {}) {
  if (!image.enabled() || !sharp) return { ok: false, reason: 'disabled' };
  const provider = image.current();
  const key = hash(`${provider}|${prompt}|${width}x${height}|${seed}`);
  const out = path.join(FRAME_DIR, `${key}.jpg`);
  if (fs.existsSync(out) && fs.statSync(out).size > 4096) return { ok: true, path: out, cached: true, provider };

  try {
    await throttle(image.minGapSec());
    const result = await Promise.race([
      image.generate({ prompt, width, height, seed }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('таймаут генерации кадра')), timeoutMs)),
    ]);
    // единый формат: иначе ffmpeg откажется склеивать разные размеры
    await sharp(result.buffer).resize(width, height, { fit: 'cover', position: 'attention' }).jpeg({ quality: 88 }).toFile(out);
    return { ok: true, path: out, cached: false, provider: result.provider, ms: result.ms };
  } catch (err) {
    log({
      level: 'warn', actor: 'frames', action: 'frame.failed',
      message: `Кадр не сгенерирован (${provider}): ${String(err.message || err).slice(0, 200)}`,
      meta: { prompt: String(prompt).slice(0, 160) },
    });
    return { ok: false, reason: String(err.message || err) };
  }
}

/**
 * Набор кадров для серии. Возвращает Map: индекс сцены → путь к картинке.
 * Уникальных запросов не больше `maxFrames`; повторные планы переиспользуют
 * уже сгенерированные, поэтому длинная серия не превращается в бесконечность.
 */
export async function framesForEpisode({
  scenes = [], look = '', palette = '', seed = '', maxFrames = 60, width = 1920, height = 1080,
  variants = 2, onProgress = null,
} = {}) {
  const allowed = image.enabled();
  if (!allowed) return { ok: false, reason: 'disabled', files: new Map(), generated: 0, cached: 0 };

  const unique = new Map(); // promptKey → { prompt, seed }
  const keys = scenes.map((sc, i) => {
    const frame = sc.frame || sc;
    const variant = variants > 1 ? i % variants : 0;
    const prompt = imagePromptFor({ frame, look, palette, variant });
    const promptKey = hash(`${prompt}|${variant}`);
    if (!unique.has(promptKey) && unique.size < maxFrames) {
      unique.set(promptKey, { prompt, seed: Math.abs(Number.parseInt(hash(`${seed}-${promptKey}`).slice(0, 6), 16)) });
    }
    return promptKey;
  });

  const files = new Map(); // promptKey → path | null
  let generated = 0;
  let cached = 0;
  let index = 0;
  for (const [key, job] of unique) {
    const res = await neuralFrame({ prompt: job.prompt, width, height, seed: job.seed });
    files.set(key, res.ok ? res.path : null);
    if (res.ok) { if (res.cached) cached += 1; else generated += 1; }
    index += 1;
    if (onProgress) onProgress({ phase: 'frames', done: index, total: unique.size });
  }

  // индекс сцены → файл (или null → процедурная плашка)
  const byScene = new Map();
  keys.forEach((key, i) => byScene.set(i, files.get(key) || null));
  return { ok: true, files: byScene, generated, cached, unique: unique.size };
}
