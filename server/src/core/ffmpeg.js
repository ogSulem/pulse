// ─────────────────────────────────────────────────────────────────────────────
// Где взять ffmpeg и ffprobe.
//
// @ffmpeg-installer/ffmpeg несёт статический бинарь и ставится не на всех
// платформах (на arm64 в образе может не оказаться нужного optional-пакета).
// Поэтому резолвим по цепочке:
//   1. PULSE_FFMPEG_PATH / PULSE_FFPROBE_PATH — ручное указание;
//   2. @ffmpeg-installer — версия зафиксирована зависимостью, поведение стабильно;
//   3. системный бинарь (apt install ffmpeg) — так собирается Docker-образ,
//      и это единственный рабочий вариант на ARM (Oracle Ampere, Raspberry).
//
// ffprobe нужен нарезке из фильмов: длительность, размеры и дорожки берутся из
// него, а не из парсинга stderr — на MKV с несколькими дорожками текстовый
// разбор врёт. В Debian-пакете ffmpeg ffprobe лежит рядом, поэтому ищем его
// в том же каталоге, что и ffmpeg.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function fromPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveTool(name, { envPath = null, extra = [] } = {}) {
  const candidates = [];
  if (envPath) candidates.push(envPath);
  // «сосед» уже найденного ffmpeg: системная сборка ставит ffmpeg и ffprobe рядом
  const sibling = extra.find((p) => p && fs.existsSync(p));
  if (sibling) candidates.push(path.join(path.dirname(sibling), name));
  candidates.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`);
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return fromPath(name);
}

let cachedFfmpeg;
export function resolveFfmpeg() {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;
  let installer = null;
  try { installer = require('@ffmpeg-installer/ffmpeg').path; } catch { /* нет пакета */ }
  cachedFfmpeg = resolveTool('ffmpeg', { envPath: process.env.PULSE_FFMPEG_PATH, extra: [installer] });
  return cachedFfmpeg;
}

let cachedFfprobe;
export function resolveFfprobe() {
  if (cachedFfprobe !== undefined) return cachedFfprobe;
  cachedFfprobe = resolveTool('ffprobe', { envPath: process.env.PULSE_FFPROBE_PATH, extra: [resolveFfmpeg()] });
  return cachedFfprobe;
}

export const ffmpegSource = (binary) => {
  if (!binary) return 'нет';
  if (process.env.PULSE_FFMPEG_PATH && binary === process.env.PULSE_FFMPEG_PATH) return 'PULSE_FFMPEG_PATH';
  return /node_modules|@ffmpeg-installer/.test(binary) ? 'ffmpeg-installer' : 'system';
};

/** Короткая сводка «чем будем резать» — показывается в настройках и в ошибках. */
export function toolsInfo() {
  const ffmpeg = resolveFfmpeg();
  const ffprobe = resolveFfprobe();
  return {
    ffmpeg: Boolean(ffmpeg),
    ffprobe: Boolean(ffprobe),
    ffmpegPath: ffmpeg || null,
    ffprobePath: ffprobe || null,
    source: ffmpegSource(ffmpeg),
  };
}
