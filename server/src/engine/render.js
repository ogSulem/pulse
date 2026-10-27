// ─────────────────────────────────────────────────────────────────────────────
// Render Service — реальная сборка вертикального видео.
//
// Готовые, проверенные компоненты вместо самописного рендера:
//   • sharp   — растеризация SVG-сцен (librsvg) и обложек;
//   • ffmpeg  — движение камеры (zoompan), склейка, кодирование H.264 + AAC.
//
// Сцена — это SVG-макет в дизайн-пространстве 1080×1920: градиентная подложка,
// крупная типографика по сценарию, прогресс-бар и безопасные зоны под UI
// площадок. Такой «kinetic typography» формат — самый дешёвый и быстрый способ
// выпускать много роликов без стоковых съёмок и без чужих прав на видео.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildBackground, buildTextOverlay, buildCover, PALETTES, hash, fontsReady, sanitize } from './scene.js';
import { resolveFfmpeg, ffmpegSource } from '../core/ffmpeg.js';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }

// ffmpeg: env → @ffmpeg-installer → системный бинарь (см. core/ffmpeg.js).
const ffmpegPath = resolveFfmpeg();

// Рилсы и TikTok — это вертикаль 1080×1920. Именно в этом разрешении площадки
// принимают видео без апскейла, поэтому «по умолчанию» рендерим нативно.
// На слабом VPS можно включить PULSE_RENDER_QUALITY=fast (720p) или задать ширину.
const QUALITY = process.env.PULSE_RENDER_QUALITY || 'high';
const QUALITY_PRESETS = {
  high: { width: 1080, fps: 30, crf: 19, preset: 'veryfast', audio: '192k' },
  balanced: { width: 1080, fps: 30, crf: 22, preset: 'veryfast', audio: '160k' },
  fast: { width: 720, fps: 30, crf: 23, preset: 'veryfast', audio: '128k' },
};
const QP = QUALITY_PRESETS[QUALITY] || QUALITY_PRESETS.high;

const W = Number(process.env.PULSE_RENDER_W || QP.width);
const H = Math.round((W * 16) / 9);
const FPS = Number(process.env.PULSE_RENDER_FPS || QP.fps);
const CRF = Number(process.env.PULSE_RENDER_CRF || QP.crf);
const PRESET = process.env.PULSE_RENDER_PRESET || QP.preset;
const AUDIO_BITRATE = process.env.PULSE_RENDER_AUDIO || QP.audio;
const MAX_TOTAL_SEC = Number(process.env.PULSE_RENDER_MAX_SEC || 42);
const RENDER_ENABLED = String(process.env.PULSE_RENDER || 'auto') !== 'off';

export const MEDIA_DIR = process.env.PULSE_MEDIA_DIR || path.resolve(process.cwd(), 'data/media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export function renderAvailable() {
  return Boolean(sharp && ffmpegPath && fs.existsSync(ffmpegPath) && RENDER_ENABLED && fontsReady());
}

export function renderInfo() {
  return {
    available: renderAvailable(),
    ffmpeg: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
    ffmpegSource: ffmpegSource(ffmpegPath),
    sharp: Boolean(sharp),
    fonts: fontsReady(),
    width: W,
    height: H,
    fps: FPS,
    quality: QUALITY,
    crf: CRF,
  };
}

// ── типографика вынесена в scene.js (векторные контуры через fontkit) ──────
// ── обёртки sharp / ffmpeg ─────────────────────────────────────────────────
async function rasterize(svg, outPath, format = 'png', width = null) {
  // Плотность подгоняем под целевой размер: SVG растеризуется сразу в 720 px,
  // а не в 1080 с последующим ресайзом — тяжёлые blur-фильтры дешевеют втрое.
  const density = width ? Math.max(48, Math.round((96 * width) / 1080)) : 96;
  let img = sharp(Buffer.from(svg), { density });
  if (width) img = img.resize({ width, withoutEnlargement: false });
  if (format === 'jpeg') await img.jpeg({ quality: 88, mozjpeg: true }).toFile(outPath);
  else await img.png({ compressionLevel: 6 }).toFile(outPath);
  return outPath;
}

function runFfmpeg(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Рендер превысил лимит времени'));
    }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(true);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.split('\n').slice(-4).join(' ')}`));
    });
  });
}

/**
 * Длительность медиафайла без ffprobe: ffmpeg печатает Duration в stderr.
 * Нужна, чтобы подогнать тайминг сцен под реальную озвучку.
 */
function probeDuration(file) {
  return new Promise((resolve) => {
    if (!ffmpegPath || !fs.existsSync(file)) return resolve(null);
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null);
    });
    child.on('error', () => resolve(null));
  });
}

// ── публичный API ──────────────────────────────────────────────────────────
let renderChain = Promise.resolve();
const coverBadges = ['разбор', '3 шага', 'без воды', 'проверено'];

/**
 * Собирает mp4 и две обложки для эпизода.
 * Возвращает пути относительно data/ (для отдачи через /media) и метрики.
 */
export async function renderEpisode({ episode, project, scenes, handle, audioPath = null }) {
  if (!renderAvailable()) {
    return { ok: false, reason: 'render_disabled' };
  }

  // рендеры сериализуем: ffmpeg и так забирает все ядра, параллельность только вредит
  const job = renderChain.then(() => renderOne({ episode, project, scenes, handle, audioPath }));
  renderChain = job.catch(() => {});
  return job;
}

async function renderOne({ episode, project, scenes, handle, audioPath }) {
  const started = Date.now();
  const id = String(episode.id).replace(/[^a-z0-9_]/gi, '');
  const workDir = path.join(MEDIA_DIR, 'tmp', id);
  fs.mkdirSync(workDir, { recursive: true });

  const palette = PALETTES[hash(episode.id) % PALETTES.length];
  const projectName = project?.name || 'Pulse';
  const usable = (scenes && scenes.length ? scenes : [{ text: episode.title, seconds: 5 }])
    .map((s) => ({ text: sanitize(s.text || ''), seconds: Math.max(2.5, Math.min(9, Number(s.seconds) || 5)) }))
    .filter((s) => s.text);
  if (!usable.length) usable.push({ text: sanitize(episode.title) || 'Pulse', seconds: 4 });

  // ограничиваем общую длину — площадки не любят «полотна», а CPU не бесконечный
  let total = 0;
  const timed = [];
  for (const s of usable) {
    if (total >= MAX_TOTAL_SEC) break;
    const seconds = Math.min(s.seconds, MAX_TOTAL_SEC - total);
    if (seconds < 2) break;
    timed.push({ ...s, seconds });
    total += seconds;
  }

  // если есть озвучка — подгоняем длительность сцен под неё, чтобы голос не обрывался
  const audioDur = audioPath && fs.existsSync(audioPath) ? await probeDuration(audioPath) : null;
  if (audioDur && audioDur > 2) {
    const targetTotal = Math.min(MAX_TOTAL_SEC, Math.max(3, audioDur + 0.4));
    const weights = timed.map((t) => t.seconds);
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    timed.forEach((t, i) => { t.seconds = Math.max(1.6, Math.round((weights[i] / sum) * targetTotal * 10) / 10); });
    total = timed.reduce((a, t) => a + t.seconds, 0);
  }
  total = Math.max(3, Math.round(total * 10) / 10);

  // ── слои ──────────────────────────────────────────────────────────────────
  // Фон рисуется один раз на весь ролик, текст — отдельными прозрачными
  // слоями. Камера двигается по фону, текст сменяется кроссфейдом: так
  // сцены не «складываются» друг с другом и кадр остаётся читаемым.
  const bgPng = path.join(workDir, 'bg.png');
  await rasterize(buildBackground({
    palette, projectName, handle, aiLabel: true, seed: episode.id,
  }), bgPng, 'png', W);

  const layers = [];
  for (const [i, scene] of timed.entries()) {
    const svg = buildTextOverlay({
      text: scene.text,
      index: i,
      total: timed.length,
      title: episode.title,
      palette,
    });
    const png = path.join(workDir, `text-${i}.png`);
    await rasterize(svg, png, 'png', W);
    layers.push(png);
  }

  // обложки A/B — разные палитры и композиция
  const coverPaths = {};
  for (const [i, variant] of ['A', 'B'].entries()) {
    const pal = PALETTES[(hash(episode.id) + (i ? 2 : 0)) % PALETTES.length];
    const svg = buildCover({
      title: episode.title,
      subtitle: i ? 'смотри разбор' : 'смотри до конца',
      projectName,
      palette: pal,
      handle,
      variant: i,
      badge: coverBadges[i % coverBadges.length],
    });
    const abs = path.join(MEDIA_DIR, `${id}-${variant}.jpg`);
    await rasterize(svg, abs, 'jpeg');
    coverPaths[variant] = `/media/${id}-${variant}.jpg`;
  }

  const videoAbs = path.join(MEDIA_DIR, `${id}.mp4`);
  const n = layers.length;

  // текстовые слои меняются «жёстким монтажом»: сцена появляется за 2 кадра
  // и исчезает за 2 кадра. Никакого наложения двух мыслей в одном кадре.
  const TD = 0.07;
  const totalSec = Math.max(2, timed.reduce((a, t) => a + (t.seconds || 4), 0));

  const hasAudio = Boolean(audioPath && fs.existsSync(audioPath));

  // входы: [0] фон, [1..n] текстовые слои, [n+1] звук
  const inputs = [['-loop', '1', '-t', String(totalSec + 1), '-i', bgPng]];
  layers.forEach((png, i) => inputs.push(['-loop', '1', '-t', String(timed[i].seconds || 4), '-i', png]));
  if (hasAudio) inputs.push(['-i', audioPath]);
  else inputs.push(['-f', 'lavfi', '-t', String(totalSec + 1), '-i', 'anullsrc=r=48000:cl=stereo']);
  const audioIndex = inputs.length - 1;

  const filter = [];
  // фон: медленный наезд камеры на всём протяжении ролика
  const bgFrames = Math.max(2, Math.round(totalSec * FPS));
  filter.push(
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,` +
    `zoompan=z='min(1.07,1+0.07*on/${bgFrames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},` +
    `format=yuv420p[bg]`
  );

  // текстовые слои: сдвиг на позицию в таймлайне + плавное появление
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const d = timed[i].seconds || 4;
    const start = cursor;
    // слой существует ровно свою сцену; до начала и после конца — прозрачность,
    // поэтому тексты физически не могут наложиться друг на друга
    const padBefore = start;
    const padAfter = Math.max(0.1, totalSec - start - d + 0.25);
    // появление начинается чуть раньше стыка, а исчезновение заканчивается
    // ровно на стыке: в кадре никогда не бывает «пустого» фона между сценами
    const fadeInStart = Math.max(0, start - (i === 0 ? 0 : TD));
    const fadeIn = i === 0 ? 0.3 : TD;
    const fadeOut = i === n - 1 ? 0.35 : TD;
    const fadeOutStart = i === n - 1 ? Math.max(0.1, start + d - fadeOut) : Math.max(fadeInStart + 0.05, start + d - fadeOut);
    filter.push(
      `[${i + 1}:v]format=rgba,` +
      `tpad=start_duration=${padBefore.toFixed(3)}:start_mode=add:stop_duration=${padAfter.toFixed(3)}:stop_mode=add:color=0x00000000,` +
      `fade=t=in:st=${fadeInStart.toFixed(3)}:d=${fadeIn.toFixed(2)}:alpha=1,` +
      `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(2)}:alpha=1` +
      `[t${i}]`
    );
    cursor += d;
  }

  let prev = 'bg';
  for (let i = 0; i < n; i++) {
    const out = i === n - 1 ? 'vtext' : `ov${i}`;
    filter.push(`[${prev}][t${i}]overlay=0:0:format=auto:eof_action=pass:repeatlast=0[${out}]`);
    prev = out;
  }
  filter.push(`[${prev}]fade=t=out:st=${Math.max(0.3, totalSec - 0.35).toFixed(2)}:d=0.35,format=yuv420p[vout]`);

  const args = [
    ...inputs.flat(),
    '-filter_complex', filter.join(';'),
    '-map', '[vout]',
    '-map', `${audioIndex}:a`,
    ...(hasAudio ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []),
    '-c:v', 'libx264', '-preset', PRESET, '-crf', String(CRF),
    '-profile:v', 'high', '-level', '4.1', '-g', String(FPS * 2),
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-t', String(Math.round(totalSec * 100) / 100),
    '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ar', '48000', '-ac', '2',
    '-shortest', '-movflags', '+faststart', '-y', videoAbs,
  ];

  await runFfmpeg(args, 300000);

  fs.rmSync(workDir, { recursive: true, force: true });
  const stat = fs.statSync(videoAbs);

  return {
    ok: true,
    videoPath: `/media/${id}.mp4`,
    videoAbs,
    coverPaths,
    bytes: stat.size,
    durationSec: Math.round(totalSec * 10) / 10,
    renderMs: Date.now() - started,
    width: W,
    height: H,
    fps: FPS,
    quality: QUALITY,
    crf: CRF,
    layers: n,
  };
}

/** Пересобрать только обложку (например, после правки заголовка) */
export async function renderCover({ episode, project, handle }) {
  if (!renderAvailable()) return { ok: false, reason: 'render_disabled' };
  const id = String(episode.id).replace(/[^a-z0-9_]/gi, '');
  const out = {};
  for (const [i, variant] of ['A', 'B'].entries()) {
    const pal = PALETTES[(hash(episode.id) + (i ? 2 : 0)) % PALETTES.length];
    const svg = buildCover({
      title: episode.title,
      subtitle: i ? 'смотри разбор' : 'смотри до конца',
      projectName: project?.name,
      palette: pal,
      handle,
      variant: i,
      badge: coverBadges[i % coverBadges.length],
    });
    await rasterize(svg, path.join(MEDIA_DIR, `${id}-${variant}.jpg`), 'jpeg');
    out[variant] = `/media/${id}-${variant}.jpg`;
  }
  return { ok: true, coverPaths: out };
}
