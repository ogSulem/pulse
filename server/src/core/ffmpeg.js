// ─────────────────────────────────────────────────────────────────────────────
// Где взять ffmpeg.
//
// @ffmpeg-installer/ffmpeg несёт статический бинарь и ставится не на всех
// платформах (на arm64 в образе может не оказаться нужного optional-пакета).
// Поэтому резолвим по цепочке:
//   1. PULSE_FFMPEG_PATH — ручное указание (свой бинарь, нестандартный путь);
//   2. @ffmpeg-installer — версия зафиксирована зависимостью, поведение стабильно;
//   3. системный ffmpeg (apt install ffmpeg) — так собирается Docker-образ,
//      и это единственный рабочий вариант на ARM (Oracle Ampere, Raspberry).
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function fromPath() {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'ffmpeg');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveFfmpeg() {
  const candidates = [];
  if (process.env.PULSE_FFMPEG_PATH) candidates.push(process.env.PULSE_FFMPEG_PATH);
  try { candidates.push(require('@ffmpeg-installer/ffmpeg').path); } catch { /* нет пакета */ }
  candidates.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg');
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return fromPath();
}

export const ffmpegSource = (binary) => {
  if (!binary) return 'нет';
  if (process.env.PULSE_FFMPEG_PATH && binary === process.env.PULSE_FFMPEG_PATH) return 'PULSE_FFMPEG_PATH';
  return /node_modules|@ffmpeg-installer/.test(binary) ? 'ffmpeg-installer' : 'system';
};
