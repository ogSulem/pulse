// ─────────────────────────────────────────────────────────────────────────────
// Нарезка: вертикальный клип из готового видео (фильм, интервью, запись).
//
// Отличие от сериала (engine/serialrender.js): там кадр рисуется процедурно,
// здесь — реальное кино. Поэтому задача рендера другая:
//   • не «сделать картинку», а честно вырезать фрагмент и вписать его в 9:16;
//   • 16:9 и 2.35:1 не обрезаем по центру (так теряются герои и половина кадра),
//     а кладём целиком на размытый фон — это стандарт коротких нарезок и
//     единственный способ не «зумить» лица;
//   • звук выравниваем по громкости площадок (loudnorm −14 LUFS): тихая дорожка
//     из фильма в ленте звучит как «сломалось»;
//   • первые секунды закрыты крупным заголовком, последние — призывом: без них
//     фрагмент выглядит как случайный кусок, а не как клип.
//
// Всё режется одним проходом ffmpeg: `-ss` до входа (быстрый seek) + перекодирование
// под вертикаль. Копирование потока тут невозможно — меняется геометрия кадра,
// зато 30-секундный клип собирается за секунды, а не за минуты.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpeg, resolveFfprobe, toolsInfo } from '../core/ffmpeg.js';
import { MEDIA_DIR } from './render.js';
import { sharp } from '../core/sharp.js';
import { log } from '../core/logger.js';
import { num } from '../core/utils.js';
import { buildTextOverlay, PALETTES, hash } from './scene.js';

const W = 1080;
const H = 1920;
const FPS = Number(process.env.PULSE_RENDER_FPS || 30);
const MAX_OUT_SEC = 59;

const ffmpegPath = resolveFfmpeg();
const ffprobePath = resolveFfprobe();

const safeId = (id) => String(id || 'clip').replace(/[^a-z0-9_]/gi, '');

/**
 * Запуск внешнего бинаря с прогрессом.
 * stderr режем до хвоста: ffmpeg на длинном файле пишет мегабайты, а нам нужны
 * последние строки для понятной ошибки.
 */
function run(bin, args, { timeoutMs = 900000, onProgress = null, progress = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('ffmpeg не найден'));
    const full = progress ? [...args, '-progress', 'pipe:1', '-nostats'] : args;
    const child = spawn(bin, full, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      reject(new Error('Обработка видео превысила лимит времени'));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (progress) {
        const text = d.toString();
        const m = [...text.matchAll(/out_time_ms=(\d+)/g)].pop();
        if (m && onProgress) onProgress(Number(m[1]) / 1e6);
        return;
      }
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400);
      return reject(new Error(`ffmpeg exit ${code}: ${tail || 'без пояснений'}`));
    });
  });
}

export function clipRenderInfo() {
  const tools = toolsInfo();
  return {
    ...tools,
    sharp: Boolean(sharp),
    // ffprobe желателен, но не обязателен: параметры читаются из вывода ffmpeg
    // (см. probeFallback). Иначе на машине без пакета ffprobe нарезка была бы
    // «недоступна» при живом ffmpeg — а резать он умеет.
    available: Boolean(tools.ffmpeg && sharp && process.env.PULSE_RENDER !== 'off'),
    width: W,
    height: H,
    fps: FPS,
    maxSeconds: MAX_OUT_SEC,
  };
}

/**
 * Метаданные файла через ffprobe.
 * Длительность из ffprobe, а не из текста ffmpeg: на MKV с несколькими
 * дорожками и переменным битрейтом парсинг «Duration:» даёт другое число.
 */
export function probeMedia(file) {
  return new Promise((resolve) => {
    if (!ffprobePath || !file || !fs.existsSync(file)) return resolve(null);
    const child = spawn(ffprobePath, [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      let data;
      try { data = JSON.parse(out); } catch { return resolve(null); }
      const streams = Array.isArray(data.streams) ? data.streams : [];
      const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) || streams.find((s) => s.codec_type === 'video');
      const audio = streams.filter((s) => s.codec_type === 'audio');
      const subs = streams.filter((s) => s.codec_type === 'subtitle');
      if (!video) return resolve(null);
      const fpsRaw = String(video.avg_frame_rate || video.r_frame_rate || '0/1');
      const [fn, fd] = fpsRaw.split('/').map(Number);
      const fps = fd ? fn / fd : 0;
      const duration = num(data.format?.duration, 0) || num(video.duration, 0) || 0;
      resolve({
        ok: true,
        durationSec: Math.max(0, duration),
        width: num(video.width, 0),
        height: num(video.height, 0),
        fps: Number.isFinite(fps) ? Math.round(fps * 100) / 100 : 0,
        videoCodec: video.codec_name || '',
        hasAudio: audio.length > 0,
        audioStreams: audio.length,
        audioLang: audio[0]?.tags?.language || '',
        subtitleStreams: subs.length,
        subtitleLang: subs[0]?.tags?.language || '',
        subtitleCodec: subs[0]?.codec_name || '',
        sizeBytes: num(data.format?.size, 0) || (fs.existsSync(file) ? fs.statSync(file).size : 0),
      });
    });
  });
}

/**
 * Параметры без ffprobe: разбираем `ffmpeg -i` (он печатает все дорожки).
 * Нужно как запасной путь и как страховка: если ffprobe не установлен, клип
 * всё равно должен получить картинку и звук, а не молчаливую дорожку.
 */
export function probeFallback(file) {
  return new Promise((resolve) => {
    if (!ffmpegPath || !fs.existsSync(file)) return resolve(null);
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 40000) err = err.slice(-40000); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const dm = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const duration = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 0;
      const videoLine = err.split('\n').find((l) => /Stream #\d+:\d+.*: Video:/.test(l)) || '';
      const size = videoLine.match(/(\d{2,5})x(\d{2,5})/);
      const fps = videoLine.match(/([\d.]+)\s+fps/);
      const audioLine = err.split('\n').find((l) => /Stream #\d+:\d+.*: Audio:/.test(l)) || '';
      const subtitleLines = err.split('\n').filter((l) => /Stream #\d+:\d+.*: Subtitle:/.test(l));
      const langOf = (line) => (line.match(/\(([a-z]{2,3})\)/) || [])[1] || '';
      if (!duration && !size) return resolve(null);
      resolve({
        ok: true,
        durationSec: duration,
        width: size ? Number(size[1]) : 0,
        height: size ? Number(size[2]) : 0,
        fps: fps ? Number(fps[1]) : 0,
        hasAudio: Boolean(audioLine),
        audioStreams: audioLine ? 1 : 0,
        audioLang: langOf(audioLine),
        subtitleStreams: subtitleLines.length,
        subtitleLang: langOf(subtitleLines[0] || ''),
        sizeBytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
        approximate: true,
      });
    });
  });
}

/** Длительность без ffprobe — запасной путь (как в сериалах, по stderr ffmpeg). */
export function probeDuration(file) {
  return new Promise((resolve) => {
    if (!ffmpegPath || !file || !fs.existsSync(file)) return resolve(null);
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null);
    });
  });
}

/**
 * Смены сцен. ffmpeg считает разницу кадров (`scene`), мы забираем только
 * моменты выше порога. Кадры ужимаем до 320 px: метрика от этого не страдает,
 * а декодирование идёт в разы быстрее — двухчасовой фильм разбирается за
 * десятки секунд, а не за десять минут.
 */
export async function detectScenes(file, { threshold = 0.32, maxSec = 0 } = {}) {
  if (!ffmpegPath || !fs.existsSync(file)) return [];
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info'];
  if (maxSec) args.push('-t', String(Math.round(maxSec)));
  args.push(
    '-i', file, '-an', '-sn',
    '-filter:v', `scale=320:-2,select='gt(scene,${threshold})',showinfo`,
    '-f', 'null', '-',
  );
  try {
    const { stderr } = await run(ffmpegPath, args, { timeoutMs: 20 * 60 * 1000, progress: false });
    const points = [];
    for (const m of stderr.matchAll(/pts_time:\s*([\d.]+)/g)) {
      const t = Number(m[1]);
      if (Number.isFinite(t)) points.push(Math.round(t * 10) / 10);
    }
    return [...new Set(points)].sort((a, b) => a - b);
  } catch (err) {
    log({ level: 'warn', actor: 'clips', action: 'scenes.failed', message: `Разбор сцен не удался: ${String(err.message || err).slice(0, 200)}` });
    return [];
  }
}

/** Паузы в звуке: тишина — естественная граница фрагмента. */
export async function detectSilence(file, { noiseDb = -32, minDur = 0.55, maxSec = 0 } = {}) {
  if (!ffmpegPath || !fs.existsSync(file)) return [];
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info'];
  if (maxSec) args.push('-t', String(Math.round(maxSec)));
  args.push('-i', file, '-vn', '-sn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minDur}`, '-f', 'null', '-');
  try {
    const { stderr } = await run(ffmpegPath, args, { timeoutMs: 20 * 60 * 1000, progress: false });
    const starts = [...stderr.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    return starts.map((start, i) => ({ start, end: ends[i] ?? null })).filter((s) => s.start >= 0 && s.end);
  } catch {
    return [];
  }
}

/** Вшитые субтитры → SRT-текст. У многих MKV дорожка уже внутри файла. */
export function extractEmbeddedSubtitles(file) {
  return new Promise((resolve) => {
    if (!ffmpegPath || !fs.existsSync(file)) return resolve(null);
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-i', file, '-map', '0:s:0', '-f', 'srt', '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); if (out.length > 8_000_000) child.kill('SIGKILL'); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.trim() ? out : null));
  });
}

/** Звук куска в mp3 16 кГц — для распознавания речи (файл ~200 КБ на 30 секунд). */
export async function extractAudioWindow(file, startSec, endSec, outPath) {
  const dur = Math.max(1, endSec - startSec);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await run(ffmpegPath, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', String(startSec.toFixed(3)), '-t', String(dur.toFixed(3)),
    '-i', file, '-vn', '-sn', '-ac', '1', '-ar', '16000', '-b:a', '64k',
    '-y', outPath,
  ], { timeoutMs: 180000, progress: false });
  return outPath;
}

/** Кадр-обложка: 1080×1920, заполнение с обрезкой по центру. */
export async function extractCover(file, atSec, outPath) {
  await run(ffmpegPath, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', String(Math.max(0, atSec).toFixed(3)), '-i', file,
    '-frames:v', '1',
    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`,
    '-q:v', '3', '-y', outPath,
  ], { timeoutMs: 120000, progress: false });
  return outPath;
}

async function rasterize(svg, outPath) {
  await sharp(Buffer.from(svg), { density: 96 })
    .resize({ width: W })
    .png({ compressionLevel: 6 })
    .toFile(outPath);
  return outPath;
}

function buildFilter({ seconds, style, hookSec, ctaSec }) {
  const hookEnd = Math.max(1.5, hookSec);
  const ctaFrom = Math.max(hookEnd + 1, seconds - ctaSec);
  const base = style === 'fill'
    ? `[0:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[base]`
    : [
      `[0:v]fps=${FPS},split=2[bgs][fgs]`,
      `[bgs]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=32:2,eq=brightness=-0.06:saturation=0.9[bg]`,
      `[fgs]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[base]`,
    ].join(';');
  const scrim = `drawbox=x=0:y=ih*0.38:w=iw:h=ih*0.62:color=black@0.30:t=fill`;
  return [
    base,
    `[base]${scrim}:enable='lt(t,${hookEnd.toFixed(2)})'[s1]`,
    `[s1]${scrim}:enable='gt(t,${ctaFrom.toFixed(2)})'[s2]`,
    `[s2][1:v]overlay=0:0:enable='lt(t,${hookEnd.toFixed(2)})'[v1]`,
    `[v1][2:v]overlay=0:0:enable='gt(t,${ctaFrom.toFixed(2)})',format=yuv420p[v]`,
  ].join(';');
}

/**
 * Сборка одного клипа.
 * @param {object} source  строка movie_sources (file_path, title)
 * @param {object} clip    { id, idx, start_sec, end_sec, title, hook, caption }
 */
export async function renderMovieClip({ source, clip, style = 'blur', hookSec = 4, onProgress = null }) {
  const info = clipRenderInfo();
  if (!info.available) {
    return { ok: false, reason: 'render_disabled', message: info.ffmpeg ? 'Нет sharp — наложение текста недоступно' : 'Нет ffmpeg/ffprobe на сервере' };
  }
  const filePath = String(source.file_path || '');
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'source_missing', message: 'Файл исходника не найден на диске' };

  const id = safeId(clip.id || `clip-${Date.now()}`);
  const start = Math.max(0, num(clip.start_sec, 0));
  const seconds = Math.min(MAX_OUT_SEC, Math.max(8, num(clip.seconds, num(clip.end_sec, 0) - start) || 25));
  const workDir = path.join(MEDIA_DIR, 'tmp', `clip-${id}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const palette = PALETTES[hash(`${source.title || ''}${clip.title || ''}`) % PALETTES.length];
  const hookOverlay = await rasterize(buildTextOverlay({
    text: String(clip.hook || clip.title || source.title || '').slice(0, 160),
    title: source.title || '',
    index: 0,
    total: 1,
    palette,
    progress: false,
    counter: false,
  }), path.join(workDir, 'hook.png'));
  const ctaOverlay = await rasterize(buildTextOverlay({
    text: 'Полное видео — в профиле',
    title: clip.title || source.title || '',
    index: 1,
    total: 1,
    palette,
    progress: false,
    counter: false,
  }), path.join(workDir, 'cta.png'));

  const ctaSec = Math.min(4, Math.max(2.2, seconds * 0.14));
  const filter = buildFilter({ seconds, style, hookSec, ctaSec });

  const videoAbs = path.join(MEDIA_DIR, `clip-${id}.mp4`);
  const tmpOut = path.join(workDir, 'out.mp4');
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', start.toFixed(3), '-t', (seconds + 0.5).toFixed(3), '-i', filePath,
    '-loop', '1', '-framerate', String(FPS), '-t', String(seconds + 0.5), '-i', hookOverlay,
    '-loop', '1', '-framerate', String(FPS), '-t', String(seconds + 0.5), '-i', ctaOverlay,
  ];
  if (!source.has_audio) {
    args.push('-f', 'lavfi', '-t', String(seconds + 0.5), '-i', 'anullsrc=r=48000:cl=stereo');
  }
  args.push(
    '-filter_complex', filter,
    '-map', '[v]', '-map', source.has_audio ? '0:a:0' : '3:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS * 2),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    ...(source.has_audio ? ['-af', 'loudnorm=I=-14:TP=-1.5:LRA=11'] : []),
    '-t', String(seconds),
    '-movflags', '+faststart', '-y', tmpOut,
  );

  const started = Date.now();
  try {
    await run(ffmpegPath, args, {
      timeoutMs: 20 * 60 * 1000,
      onProgress: onProgress ? (sec) => onProgress(Math.min(1, sec / Math.max(1, seconds))) : null,
    });
    // Перемещаем только готовый файл: оборванный рендер не оставляет мусора
    // в /media, где его подхватил бы плеер и панель.
    fs.renameSync(tmpOut, videoAbs);

    const coverPaths = {};
    for (const [variant, at] of [['A', start + Math.min(2.5, seconds * 0.15)], ['B', start + seconds * 0.55]]) {
      const cover = path.join(MEDIA_DIR, `clip-${id}-${variant}.jpg`);
      await extractCover(filePath, at, cover).catch(() => null);
      if (fs.existsSync(cover)) coverPaths[variant] = `/media/clip-${id}-${variant}.jpg`;
    }

    const stat = fs.statSync(videoAbs);
    return {
      ok: true,
      videoPath: `/media/clip-${id}.mp4`,
      videoAbs,
      bytes: stat.size,
      width: W,
      height: H,
      seconds,
      coverPaths,
      renderMs: Date.now() - started,
    };
  } catch (err) {
    fs.rmSync(tmpOut, { force: true });
    return { ok: false, reason: 'render_failed', message: String(err.message || err).slice(0, 400) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
