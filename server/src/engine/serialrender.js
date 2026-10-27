// ─────────────────────────────────────────────────────────────────────────────
// Рендер сериала: 16:9, фото-ряд, субтитры, длинная озвучка, нарезки.
//
// Отличия от короткого ролика (engine/render.js) — принципиальные:
//   • 1920×1080 вместо 9:16: сериал публикуется как обычное видео YouTube,
//     а не как Shorts. Горизонтальный кадр и есть «телевизионный» формат;
//   • каждый план живёт свою длительность (concat-демуксер), а не «один фон на
//     весь ролик»: 12 минут одного фона — это слайдшоу, за которое снимают
//     монетизацию;
//   • субтитры отдельным alpha-слоем по сценам: голос и текст совпадают;
//   • озвучка синтезируется секциями по ~3000 знаков (лимиты TTS) и склеивается
//     в один трек, а тайминг сцен считается по фактической длине каждой секции.
//
// Тяжёлый рендер (15 минут 1080p) идёт минутами, поэтому длительность
// ограничена настройкой series_max_sec и есть прогресс в лог.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildSeriesPlate, buildSeriesCaption, buildSeriesCover, buildTextOverlay, splitCaptions, PALETTES, hash, sanitize } from './scene.js';
import { MEDIA_DIR } from './render.js';
import { getSettings } from '../core/db.js';
import { num } from '../core/utils.js';

import { resolveFfmpeg, ffmpegSource } from '../core/ffmpeg.js';
const require = createRequire(import.meta.url);

let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }
// ffmpeg: env → @ffmpeg-installer → системный бинарь (см. core/ffmpeg.js).
const ffmpegPath = resolveFfmpeg();

const ASPECT = { '16:9': [1920, 1080], '9:16': [1080, 1920] };
const SERIES_W = 1920;
const SERIES_H = 1080;
const CUT_W = 1080;
const CUT_H = 1920;
const FPS = Number(process.env.PULSE_RENDER_FPS || 30);
const QUALITY = {
  high: { crf: 20, preset: 'veryfast', audio: '192k' },
  balanced: { crf: 23, preset: 'veryfast', audio: '160k' },
  fast: { crf: 26, preset: 'veryfast', audio: '128k' },
};

const safeId = (id) => String(id || 'series').replace(/[^a-z0-9_]/gi, '');

function pickQuality() {
  let q = 'high';
  try { q = getSettings().series_quality || 'high'; } catch { /* настройки могут быть недоступны в тестах */ }
  return QUALITY[q] || QUALITY.high;
}

export function seriesRenderInfo() {
  return {
    available: Boolean(sharp && ffmpegPath && fs.existsSync(ffmpegPath) && process.env.PULSE_RENDER !== 'off'),
    ffmpeg: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
    ffmpegSource: ffmpegSource(ffmpegPath),
    sharp: Boolean(sharp),
    width: SERIES_W,
    height: SERIES_H,
    fps: FPS,
    cutWidth: CUT_W,
    cutHeight: CUT_H,
    maxSec: 1200,
  };
}

function run(bin, args, { timeoutMs = 600000, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Рендер серии превысил лимит времени'));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (onProgress) {
        const m = [...out.matchAll(/out_time_ms=(\d+)/g)].pop();
        if (m) onProgress(Number(m[1]) / 1e6);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.split('\n').slice(-3).join(' ').slice(0, 400)}`));
    });
  });
}

async function rasterize(svg, outPath, width) {
  const density = Math.max(48, Math.round((96 * width) / 1080));
  await sharp(Buffer.from(svg), { density })
    .resize({ width, withoutEnlargement: false })
    .png({ compressionLevel: 6 })
    .toFile(outPath);
  return outPath;
}

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

/**
 * План озвучки: режем серию на секции по лимиту TTS (ElevenLabs — 5000 знаков
 * на запрос, OpenAI — 4096). Секция всегда кончается на границе сцены, поэтому
 * склейка звука не рвёт фразу посередине.
 */
export function planVoiceSections({ scenes = [], maxChars = 3200 } = {}) {
  const sections = [];
  let current = { index: 0, sceneNumbers: [], text: '', chars: 0 };
  for (const sc of scenes) {
    const text = String(sc.text || '').trim();
    if (!text) continue;
    if (current.chars && current.chars + text.length > maxChars) {
      sections.push(current);
      current = { index: sections.length, sceneNumbers: [], text: '', chars: 0 };
    }
    current.sceneNumbers.push(sc.n);
    current.text = current.text ? `${current.text} ${text}` : text;
    current.chars += text.length + 1;
  }
  if (current.chars) sections.push(current);
  return sections.map((s) => ({ ...s, chars: s.text.length }));
}

/**
 * Тайминг: если секции озвучены, длительность сцены берётся из реального
 * голоса (пропорционально словам внутри секции). Нет звука — из сценария.
 */
export function buildTimeline({ scenes = [], sections = [], audioDurations = [] } = {}) {
  const byScene = new Map(scenes.map((s) => [s.n, { ...s }]));
  const totalWords = scenes.reduce((a, s) => a + String(s.text || '').split(/\s+/).filter(Boolean).length, 0);

  if (sections.length && audioDurations.some((d) => d > 0)) {
    for (const [i, section] of sections.entries()) {
      const real = num(audioDurations[i], 0);
      const mine = section.sceneNumbers.map((n) => byScene.get(n)).filter(Boolean);
      if (!mine.length) continue;
      const words = mine.reduce((a, s) => a + String(s.text || '').split(/\s+/).filter(Boolean).length, 0);
      if (real > 0.5) {
        // 0.15 с на стыке — дыхание между секциями, иначе речь «слипается»
        const usable = Math.max(1, real - 0.15);
        for (const sc of mine) {
          const w = String(sc.text || '').split(/\s+/).filter(Boolean).length;
          sc.seconds = Math.round((usable * (w / Math.max(1, words))) * 10) / 10;
        }
      }
    }
  } else {
    // без озвучки: держим пропорции сценария, но проверяем, что темп читаемый
    const total = scenes.reduce((a, s) => a + num(s.seconds, 0), 0) || totalWords / 2.35;
    const scale = totalWords ? Math.min(2.2, Math.max(0.75, (totalWords / 2.35) / total)) : 1;
    for (const sc of scenes) byScene.get(sc.n).seconds = Math.round(num(sc.seconds, 8) * scale * 10) / 10;
  }

  let acc = 0;
  const timed = scenes.map((s) => {
    const sc = byScene.get(s.n);
    const seconds = Math.max(1.5, Math.round(num(sc.seconds, 8) * 10) / 10);
    const item = { ...sc, at: Math.round(acc * 10) / 10, seconds };
    acc += seconds;
    return item;
  });
  return { scenes: timed, durationSec: Math.round(acc) };
}

/** Субтитры по сцене: длительность чанка пропорциональна длине текста. */
function captionsForScene(sc) {
  const chunks = splitCaptions(sc.text, { maxChars: 100 });
  if (!chunks.length) return [{ text: sanitize(sc.text), seconds: sc.seconds }];
  const total = chunks.reduce((a, c) => a + c.length, 0) || 1;
  return chunks.map((text) => ({ text, seconds: Math.max(0.9, Math.round((sc.seconds * (text.length / total)) * 10) / 10) }));
}

/**
 * Полная сборка серии: кадры → видео, субтитры, обложки, при наличии —
 * звук. Возвращает пути относительно data/ (отдаются через /media).
 */
export async function renderSeriesEpisode({
  series = {},
  episode = {},
  scenes = [],
  frames = null,
  sections = [],
  audioPaths = [],
  handle = 'pulse',
  coverText = '',
  onProgress = null,
  workId = null,
}) {
  const info = seriesRenderInfo();
  if (!info.available) return { ok: false, reason: 'render_disabled' };
  if (!scenes.length) return { ok: false, reason: 'no_scenes' };

  let maxSec = 1200;
  try { maxSec = num(getSettings().series_max_sec, 1200); } catch { /* default */ }
  const started = Date.now();
  const id = safeId(workId || episode.id || `s${series.id || 'series'}`);
  const workDir = path.join(MEDIA_DIR, 'tmp', `series-${id}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const audioDurations = await Promise.all(audioPaths.map((p) => (p ? probeDuration(p) : null)));
  const { scenes: timed, durationSec: rawDuration } = buildTimeline({ scenes, sections, audioDurations });

  // жёсткий потолок: длиннее 20 минут YouTube-сериал не нужен, а VPS не переживёт
  let acc = 0;
  const kept = [];
  for (const sc of timed) {
    if (acc >= maxSec) break;
    const seconds = Math.min(sc.seconds, maxSec - acc);
    if (seconds < 1) break;
    kept.push({ ...sc, seconds: Math.round(seconds * 10) / 10 });
    acc += seconds;
  }
  const durationSec = Math.round(acc * 10) / 10;

  const palette = PALETTES[hash(`${series.id || series.title}-${episode.episode_no || 1}`) % PALETTES.length];
  const paletteIndex = PALETTES.indexOf(palette);
  const title = series.title || 'Сериал';
  const episodeLabel = `Серия ${episode.episode_no || 1}${episode.title ? ` · ${episode.title}` : ''}`;

  // ── кадры фото-ряда ──────────────────────────────────────────────────────
  const plateFiles = [];
  for (const [i, sc] of kept.entries()) {
    const frame = (Array.isArray(frames) && frames[i]) || sc.frame || {};
    const svg = buildSeriesPlate({
      palette,
      scenery: frame.scenery || sc.visual || 'room',
      shot: frame.shot || sc.shot || 'wide',
      seed: `${id}-${sc.n}`,
      index: i,
      title,
      episodeLabel,
    });
    const file = path.join(workDir, `plate-${i}.png`);
    await rasterize(svg, file, SERIES_W);
    plateFiles.push(file);
    if (onProgress && i % 12 === 0) onProgress({ phase: 'frames', done: i + 1, total: kept.length });
  }

  // ── субтитры ─────────────────────────────────────────────────────────────
  const capFiles = [];
  const capDurations = [];
  let ci = 0;
  for (const sc of kept) {
    for (const chunk of captionsForScene(sc)) {
      const svg = buildSeriesCaption({ text: chunk.text, palette });
      const file = path.join(workDir, `cap-${ci}.png`);
      await rasterize(svg, file, SERIES_W);
      capFiles.push(file);
      capDurations.push(chunk.seconds);
      ci += 1;
    }
  }

  // ── звук: склейка секций в один трек ─────────────────────────────────────
  let audioTrack = null;
  const existing = audioPaths.filter((p) => p && fs.existsSync(p));
  if (existing.length) {
    audioTrack = path.join(workDir, 'audio.mp3');
    if (existing.length === 1) {
      fs.copyFileSync(existing[0], audioTrack);
    } else {
      const list = path.join(workDir, 'audio.txt');
      fs.writeFileSync(list, existing.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
      await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'libmp3lame', '-b:a', '192k', '-y', audioTrack], { timeoutMs: 600000 });
    }
  }

  // ── видео: concat планов + alpha-субтитры ────────────────────────────────
  const writeConcat = (name, files, durations) => {
    const lines = [];
    for (const [i, f] of files.entries()) {
      lines.push(`file '${f.replace(/'/g, "'\\''")}'`);
      lines.push(`duration ${Math.max(0.5, Number(durations[i]) || 1).toFixed(3)}`);
    }
    if (files.length) lines.push(`file '${files[files.length - 1].replace(/'/g, "'\\''")}'`);
    const p = path.join(workDir, name);
    fs.writeFileSync(p, `${lines.join('\n')}\n`);
    return p;
  };
  const platesList = writeConcat('plates.txt', plateFiles, kept.map((s) => s.seconds));
  const capsList = writeConcat('caps.txt', capFiles, capDurations);

  const quality = pickQuality();
  const videoAbs = path.join(MEDIA_DIR, `${id}.mp4`);

  // Мягкий наезд камеры на каждом плане: «фотография» оживает, но без
  // дрожания и без панорам, от которых укачивает.
  const zoom = `zoompan=z='min(1.06,1+0.06*on/(${FPS}*14))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${SERIES_W}x${SERIES_H}:fps=${FPS}`;
  const filter = [
    `[0:v]fps=${FPS},scale=${SERIES_W}:${SERIES_H},${zoom},setsar=1[bg]`,
    `[1:v]format=rgba,fps=${FPS},scale=${SERIES_W}:${SERIES_H}[cap]`,
    `[bg][cap]overlay=0:0:format=auto:eof_action=pass,fade=t=in:st=0:d=0.6,fade=t=out:st=${Math.max(0.5, durationSec - 0.8).toFixed(2)}:d=0.8,format=yuv420p[v]`,
  ].join(';');

  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-f', 'concat', '-safe', '0', '-i', platesList,
    '-f', 'concat', '-safe', '0', '-i', capsList,
    ...(audioTrack ? ['-i', audioTrack] : ['-f', 'lavfi', '-t', String(durationSec + 1), '-i', 'anullsrc=r=48000:cl=stereo']),
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '2:a',
    ...(audioTrack ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []),
    '-c:v', 'libx264', '-preset', quality.preset, '-crf', String(quality.crf),
    '-profile:v', 'high', '-level', '4.1', '-g', String(FPS * 2),
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-t', String(durationSec),
    '-c:a', 'aac', '-b:a', quality.audio, '-ar', '48000', '-ac', '2',
    '-shortest', '-movflags', '+faststart', '-y', videoAbs,
  ];

  await run(ffmpegPath, args, {
    timeoutMs: 3_600_000,
    onProgress: (sec) => onProgress && onProgress({ phase: 'encode', done: Math.round(sec), total: Math.round(durationSec) }),
  });

  // ── обложки: 1280×720 под YouTube ────────────────────────────────────────
  const coverPaths = {};
  const scenarios = [...new Set(kept.map((s) => (s.frame || {}).scenery || s.visual || 'city'))].slice(0, 3);
  for (const [i, letter] of ['A', 'B', 'C'].entries()) {
    const svg = buildSeriesCover({
      title: coverText || title,
      episodeLabel,
      projectName: series.project_name || 'PULSE',
      handle,
      palette,
      seed: `${id}-${letter}`,
      scenery: scenarios[i % Math.max(1, scenarios.length)] || 'city',
      badge: series.genre_label || 'сериал',
    });
    const abs = path.join(MEDIA_DIR, `${id}-${letter}.jpg`);
    // размер задаём явно: плотность sharp по умолчанию 72 dpi, и «96» дало бы 1.33×
    await sharp(Buffer.from(svg), { density: 72 }).resize({ width: 1280, height: 720, fit: 'fill' }).jpeg({ quality: 90, mozjpeg: true }).toFile(abs);
    coverPaths[letter] = `/media/${id}-${letter}.jpg`;
  }

  // постер серии для страницы (16:9, тот же кадр)
  const posterAbs = path.join(MEDIA_DIR, `${id}-poster.jpg`);
  await sharp(plateFiles[0]).resize({ width: 1280 }).jpeg({ quality: 88 }).toFile(posterAbs);

  fs.rmSync(workDir, { recursive: true, force: true });
  const stat = fs.statSync(videoAbs);

  return {
    ok: true,
    videoPath: `/media/${id}.mp4`,
    videoAbs,
    posterPath: `/media/${id}-poster.jpg`,
    coverPaths,
    bytes: stat.size,
    durationSec,
    width: SERIES_W,
    height: SERIES_H,
    fps: FPS,
    scenes: kept.length,
    captions: capFiles.length,
    audio: Boolean(audioTrack),
    audioSec: Math.round((audioDurations.filter(Boolean).reduce((a, b) => a + b, 0) || 0) * 10) / 10,
    renderMs: Date.now() - started,
    palette: paletteIndex,
    quality: quality.crf,
  };
}

/**
 * Вертикальная нарезка из серии: тот же кадр, обрезанный в 9:16, и крупный
 * текст-крючок. Задача нарезки — привести нового зрителя в сериал, поэтому в
 * конце всегда подпись «полная серия в профиле».
 */
export async function renderSeriesCut({ series = {}, cut = {}, paletteIndex = 0, handle = 'pulse', workId = null }) {
  const info = seriesRenderInfo();
  if (!info.available) return { ok: false, reason: 'render_disabled' };
  const id = `${safeId(workId || series.id || 'series')}-cut${cut.index || 1}`;
  const workDir = path.join(MEDIA_DIR, 'tmp', id);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const palette = PALETTES[paletteIndex % PALETTES.length];
  const seconds = Math.min(60, Math.max(15, num(cut.seconds, 28)));

  const plate = await rasterize(buildSeriesPlate({
    palette,
    scenery: cut.scenery || 'city',
    shot: 'close',
    seed: `${id}-plate`,
    title: series.title || '',
    episodeLabel: `Серия ${cut.episodeNo || 1}`,
  }), path.join(workDir, 'plate.png'), CUT_W);

  const overlay = await rasterize(buildTextOverlay({
    text: cut.text || '',
    index: 0,
    total: 1,
    title: cut.title || series.title || '',
    palette,
  }), path.join(workDir, 'text.png'), CUT_W);

  const videoAbs = path.join(MEDIA_DIR, `${id}.mp4`);
  const filter = [
    `[0:v]scale=${CUT_W}:${CUT_H}:force_original_aspect_ratio=increase,crop=${CUT_W}:${CUT_H},` +
      `zoompan=z='min(1.08,1+0.08*on/(${FPS}*${seconds}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${CUT_W}x${CUT_H}:fps=${FPS},setsar=1[bg]`,
    '[1:v]format=rgba[ov]',
    '[bg][ov]overlay=0:0:format=auto:eof_action=pass,format=yuv420p[v]',
  ].join(';');

  await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-loop', '1', '-t', String(seconds + 1), '-i', plate,
    '-loop', '1', '-t', String(seconds + 1), '-i', overlay,
    '-f', 'lavfi', '-t', String(seconds + 1), '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex', filter,
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-t', String(seconds),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-shortest', '-movflags', '+faststart', '-y', videoAbs,
  ], { timeoutMs: 600000 });

  fs.rmSync(workDir, { recursive: true, force: true });
  const stat = fs.statSync(videoAbs);
  return {
    ok: true,
    index: cut.index || 1,
    videoPath: `/media/${id}.mp4`,
    videoAbs,
    bytes: stat.size,
    seconds,
    width: CUT_W,
    height: CUT_H,
    title: cut.title || '',
  };
}

export { ASPECT };
