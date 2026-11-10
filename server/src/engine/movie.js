// ─────────────────────────────────────────────────────────────────────────────
// Нарезка из фильмов: исходник → умный разбор → вертикальные клипы → очередь.
//
// Зачем отдельный движок, а не ещё одна кнопка в студии. Студия придумывает
// ролик с нуля (идея, сценарий, озвучка, генерация кадров) — это десятки
// действий и минуты CPU. Нарезка работает с уже существующим материалом, и её
// ценность в другом: найти в двух часах пять кусков, которые зацепят, вырезать
// их в 9:16 и поставить в график. Здесь нет ни сценария, ни озвучки, ни
// генерации кадров — есть поиск моментов и монтаж.
//
// Конвейер:
//   1. файл лежит в DATA_DIR/sources (загружен через панель или скопирован на VPS);
//   2. ffprobe даёт длительность и дорожки;
//   3. текст берём по приоритету: свои .srt → вшитые субтитры → распознавание
//      речи (Groq Whisper) → без текста, только сцены и паузы;
//   4. кандидаты собираются по «швам» (смена сцены, конец паузы, новая реплика)
//      и оцениваются плотностью речи, вопросами, сменой планов;
//   5. языковая модель выбирает лучшие и придумывает заголовок и крючок;
//   6. ffmpeg режет вертикаль, затем клип идёт обычным путём: очередь,
//      комплаенс, лимиты площадок, публикация, аналитика.
//
// Ключевое правило: клип НЕ проходит через генерацию сценария. Иначе ИИ
// перепишет текст и «интересный кусок» перестанет соответствовать картинке.
// Поэтому клип создаётся сразу готовым эпизодом с video_path.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso, getSettings } from '../core/db.js';
import { enqueue, registerHandler } from '../core/queue.js';
import { log } from '../core/logger.js';
import { uid, num, clamp, parseJson, slugify } from '../core/utils.js';
import { SOURCE_DIR } from '../core/paths.js';
import { MEDIA_DIR } from './render.js';
import {
  clipRenderInfo, probeMedia, probeFallback, probeDuration, detectScenes, detectSilence,
  extractEmbeddedSubtitles, extractAudioWindow, renderMovieClip,
} from './movierender.js';
import { transcribe, asrStatus } from '../providers/asr.js';
import { completeJson, status as llmStatus } from '../providers/llm.js';
import { createEpisode, touchEpisode, nextSlot } from './pipeline.js';
import { checkCompliance } from './compliance.js';
import { scoreViral } from './viral.js';
import { forecastEpisode } from './forecast.js';
import { markAi } from './aimeta.js';

const SOURCE_EXT = new Set(['.mp4', '.mkv', '.mov', '.m4v', '.avi', '.webm', '.ts', '.mpg', '.mpeg', '.flv', '.wmv', '.m2ts']);
const SUB_EXT = new Set(['.srt', '.vtt']);

const getSource = (id) => db.prepare('SELECT * FROM movie_sources WHERE id = ?').get(id);
const getClip = (id) => db.prepare('SELECT * FROM movie_clips WHERE id = ?').get(id);
const settingsNum = (key, fallback) => num(getSettings()[key], fallback);

export function uploadLimitMb() {
  return num(process.env.PULSE_MAX_UPLOAD_MB, 4096) || 4096;
}
export const uploadLimitBytes = () => uploadLimitMb() * 1024 * 1024;

/** Полная сводка «чем режем и сколько влезет» — для шапки раздела. */
export function movieInfo() {
  const render = clipRenderInfo();
  return {
    ...render,
    uploadLimitMb: uploadLimitMb(),
    sourceDir: SOURCE_DIR,
    asr: asrStatus(),
    llm: llmStatus(),
    defaults: {
      count: clamp(settingsNum('clip_default_count', 5), 1, 12),
      minSec: clamp(settingsNum('clip_min_sec', 18), 10, 60),
      maxSec: clamp(settingsNum('clip_max_sec', 45), 15, 60),
      style: getSettings().clip_style || 'blur',
      hookSec: clamp(settingsNum('clip_hook_sec', 4), 2, 8),
    },
  };
}

// ── Файлы ───────────────────────────────────────────────────────────────────

function safeFileName(name, fallbackExt = '.mp4') {
  const base = path.basename(String(name || 'video'));
  const ext = path.extname(base).toLowerCase();
  const stem = slugify(path.basename(base, ext)) || 'video';
  return `${stem}${SOURCE_EXT.has(ext) ? ext : fallbackExt}`;
}

function titleFromFile(name) {
  const stem = path.basename(String(name || ''), path.extname(String(name || '')));
  return stem.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Без названия';
}

function defaultProjectId(explicit) {
  if (explicit && db.prepare('SELECT 1 x FROM projects WHERE id = ?').get(explicit)) return explicit;
  return db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get()?.id || null;
}

function insertSource({ id, title, fileName, filePath, bytes, projectId, rights }) {
  const ts = nowIso();
  db.prepare(`INSERT INTO movie_sources (id, title, file_name, file_path, bytes, rights, project_id, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`)
    .run(id, title || '', fileName || path.basename(filePath), filePath, bytes || 0, rights ? 1 : 0, defaultProjectId(projectId), ts, ts);
  return getSource(id);
}

/**
 * Приём загрузки потоком.
 * Файл фильма — гигабайты, поэтому тело запроса не буферизуется в память:
 * пишем сразу на диск, считаем байты и обрываем приём при превышении лимита.
 */
export function saveUpload(req, { name, title = '', projectId = null, rights = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const limit = uploadLimitBytes();
    const declared = num(req.headers['content-length'], 0);
    if (declared && declared > limit) {
      const err = new Error(`Файл больше лимита ${uploadLimitMb()} МБ`);
      err.status = 413;
      return reject(err);
    }
    const ext = path.extname(String(name || '')).toLowerCase();
    if (!SOURCE_EXT.has(ext)) {
      const err = new Error(`Формат ${ext || '(без расширения)'} не поддерживается. Нужен mp4, mkv, mov, m4v, webm или ts`);
      err.status = 400;
      return reject(err);
    }

    const id = uid('src_');
    const fileName = `${id}-${safeFileName(name)}`;
    const target = path.join(SOURCE_DIR, fileName);
    fs.mkdirSync(SOURCE_DIR, { recursive: true });
    const out = fs.createWriteStream(target);
    let bytes = 0;
    let aborted = false;

    const fail = (err) => {
      if (aborted) return;
      aborted = true;
      out.destroy();
      fs.rm(target, { force: true }, () => reject(err));
    };

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        req.destroy();
        const err = new Error(`Файл больше лимита ${uploadLimitMb()} МБ (приём остановлен)`);
        err.status = 413;
        fail(err);
      }
    });
    req.on('aborted', () => fail(Object.assign(new Error('Загрузка прервана'), { status: 400 })));
    req.on('error', (err) => fail(err));
    out.on('error', (err) => fail(err));
    out.on('finish', () => {
      if (aborted) return;
      if (!bytes) return fail(Object.assign(new Error('Пустой файл'), { status: 400 }));
      try {
        const source = insertSource({
          id, title: String(title || '').trim() || titleFromFile(name), fileName, filePath: target,
          bytes, projectId, rights,
        });
        log({
          level: 'info', actor: 'user', action: 'source.uploaded', entityType: 'movie_source', entityId: id,
          message: `Исходник загружен: «${source.title}», ${(bytes / 1024 ** 3).toFixed(2)} ГБ`,
          meta: { bytes, fileName },
        });
        resolve(source);
      } catch (err) {
        fail(err);
      }
    });
    req.pipe(out);
  });
}

/** Файлы, положенные в каталог источников напрямую (scp/rsync/docker cp). */
export function scanSourceFolder() {
  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  const known = new Set(db.prepare('SELECT file_path FROM movie_sources').all().map((r) => r.file_path));
  const added = [];
  for (const entry of fs.readdirSync(SOURCE_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(SOURCE_DIR, entry.name);
    if (known.has(file)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (SUB_EXT.has(ext)) continue; // субтитры привязываются к источнику, а не к папке
    if (!SOURCE_EXT.has(ext)) continue;
    const stat = fs.statSync(file);
    const source = insertSource({
      id: uid('src_'), title: titleFromFile(entry.name), fileName: entry.name, filePath: file,
      bytes: stat.size, projectId: null, rights: 1,
    });
    added.push(source);
  }
  if (added.length) {
    log({ level: 'info', actor: 'user', action: 'source.scanned', message: `Найдено новых исходников: ${added.length}` });
  }
  return added;
}

// ── Субтитры ────────────────────────────────────────────────────────────────

const SRT_TIME = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/;

function parseTime(token) {
  const m = SRT_TIME.exec(token || '');
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

/** SRT/VTT → реплики. Один парсер на оба формата: различается только шапка. */
export function parseSubtitles(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const cues = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes('-->')) continue;
    const [from, to] = line.split('-->');
    const start = parseTime(from);
    const end = parseTime(to);
    if (start == null || end == null || end <= start) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (!next.trim()) break;
      if (next.includes('-->')) break;
      if (/^\d+$/.test(next.trim()) && lines[j + 1]?.includes('-->')) break;
      body.push(next);
    }
    const clean = body.join(' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/\\N|\\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean) cues.push({ start, end, text: clean });
  }
  return cues;
}

/** Русские склонения: «3 реплики», «5 реплик», «21 реплика». */
function plural(n, [one, few, many]) {
  const abs = Math.abs(Number(n) || 0) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function cuesInRange(cues, start, end) {
  return cues.filter((c) => c.end > start && c.start < end);
}

/** Текст субтитров: свои → вшитые в файл. */
export async function ensureCues(source) {
  // Порядок важен: файл субтитров — источник правды. Если человек приложил
  // новые субтитры и запустил разбор заново, старый кэш в `analysis` не должен
  // подменять свежий текст (раньше именно так и было).
  if (source.subtitle_path && fs.existsSync(source.subtitle_path)) {
    const cues = parseSubtitles(fs.readFileSync(source.subtitle_path, 'utf8'));
    if (cues.length) return { cues, kind: source.subtitle_kind || 'srt' };
  }
  if (Number(source.subtitle_streams || 0) > 0) {
    const srt = await extractEmbeddedSubtitles(source.file_path);
    if (srt) {
      const target = path.join(SOURCE_DIR, `${source.id}.srt`);
      fs.writeFileSync(target, srt, 'utf8');
      db.prepare('UPDATE movie_sources SET subtitle_path = ?, subtitle_kind = ?, updated_at = ? WHERE id = ?')
        .run(target, 'embedded', nowIso(), source.id);
      const cues = parseSubtitles(srt);
      if (cues.length) return { cues, kind: 'embedded' };
    }
  }
  // последний шанс: кэш прошлого разбора (файл субтитров могли удалить)
  const analysis = parseJson(source.analysis, {});
  if (Array.isArray(analysis.cues) && analysis.cues.length) {
    return { cues: analysis.cues, kind: analysis.subtitleKind || 'srt' };
  }
  return { cues: [], kind: 'none' };
}

export function attachSubtitle(id, text, { fileName = 'subtitles.srt' } = {}) {
  const source = getSource(id);
  if (!source) throw Object.assign(new Error('Исходник не найден'), { status: 404 });
  const cues = parseSubtitles(text);
  if (!cues.length) throw Object.assign(new Error('В файле не найдено ни одной реплики (нужен SRT или VTT)'), { status: 400 });
  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  const target = path.join(SOURCE_DIR, `${source.id}.srt`);
  fs.writeFileSync(target, text, 'utf8');
  db.prepare('UPDATE movie_sources SET subtitle_path = ?, subtitle_kind = ?, updated_at = ? WHERE id = ?')
    .run(target, 'uploaded', nowIso(), id);
  log({
    level: 'info', actor: 'user', action: 'source.subtitles', entityType: 'movie_source', entityId: id,
    message: `Субтитры привязаны: ${cues.length} реплик (${fileName})`,
  });
  return { ok: true, cues: cues.length };
}

// ── Кандидаты ───────────────────────────────────────────────────────────────

function pickEndSeam(seams, start, minLen, maxLen) {
  const softEnd = start + maxLen;
  const options = seams.filter((t) => t >= start + minLen && t <= softEnd + 2);
  if (!options.length) return Math.min(start + (minLen + maxLen) / 2, softEnd);
  // хотим длину около середины диапазона: так нарезка не превращается
  // в «пять секунд действия» или «минуту разговора»
  const target = start + (minLen + maxLen) / 2;
  return options.reduce((best, t) => (Math.abs(t - target) < Math.abs(best - target) ? t : best), options[0]);
}

function punchyLine(text) {
  const sentences = String(text || '').split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return '';
  const scored = sentences.map((s) => ({
    s,
    score: (s.length <= 90 ? 12 : 0) + (/[?!…]/.test(s) ? 8 : 0) + Math.min(10, s.split(/\s+/).length / 2),
  })).sort((a, b) => b.score - a.score);
  return scored[0].s.slice(0, 120);
}

/**
 * Кандидаты: окна между «швами».
 * Оценка честная и объяснимая: за каждую метрику начисляются баллы, и они
 * попадают в `reason`, поэтому в интерфейсе видно, почему кусок считается
 * интересным, а не «ИИ так решил».
 */
export function buildCandidates({ duration, scenes = [], silences = [], cues = [], minSec = 18, maxSec = 45, limit = 12 } = {}) {
  const dur = num(duration, 0);
  if (dur < minSec + 2) return [];
  const seamSet = new Set();
  for (const t of scenes) seamSet.add(Math.round(num(t, 0)));
  for (const s of silences) if (s?.end) seamSet.add(Math.round(num(s.end, 0)));
  for (const c of cues) seamSet.add(Math.round(num(c.start, 0)));
  const seams = [...seamSet].filter((t) => t > 3 && t < dur - 2).sort((a, b) => a - b);
  // Если «швов» мало (статичное видео, лекция, монолог), сетка по времени: без
  // неё весь фильм даёт два кандидата, и выбор момента становится случайным.
  if (seams.length < 12) {
    const step = Math.max(10, Math.round((minSec + maxSec) / 2));
    for (let t = Math.max(5, Math.round(dur * 0.03)); t < dur - minSec; t += step) {
      if (!seams.includes(t)) seams.push(t);
    }
    seams.sort((a, b) => a - b);
  }

  const out = [];
  // шаг по швам: на двухчасовом фильме их тысячи, перебирать все — лишняя работа
  const stride = Math.max(1, Math.floor(seams.length / 240));
  for (let i = 0; i < seams.length; i += stride) {
    const start = seams[i];
    // конец никогда не выходит за файл: окно «до 87-й секунды» в 72-секундном
    // видео — это пустой кадр в конце клипа
    const end = Math.min(dur - 0.2, pickEndSeam(seams, start, minSec, maxSec));
    const seconds = end - start;
    if (seconds < minSec * 0.7 || seconds > maxSec + 4) continue;

    const bucket = cuesInRange(cues, start, end);
    const chars = bucket.reduce((acc, c) => acc + c.text.length, 0);
    const density = seconds > 0 ? chars / seconds : 0;
    const insideScenes = scenes.filter((t) => t > start && t < end).length;
    const silentSec = silences
      .filter((s) => s.end && s.end > start && s.start < end)
      .reduce((acc, s) => acc + Math.max(0, Math.min(end, s.end) - Math.max(start, s.start)), 0);
    const silenceRatio = silentSec / seconds;
    const text = bucket.map((c) => c.text).join(' ');

    let score = 0;
    const why = [];
    if (chars) {
      score += Math.min(40, density * 2.4);
      score += Math.min(14, bucket.length * 1.1);
      why.push(`${bucket.length} ${plural(bucket.length, ['реплика', 'реплики', 'реплик'])}, ${Math.round(density)} зн/с`);
      if (/[?]/.test(text)) { score += 6; why.push('есть вопрос'); }
      if (/[!]/.test(text)) { score += 3; }
      const firstCue = bucket[0];
      if (firstCue && firstCue.start - start < 1.6) { score += 7; why.push('реплика с первой секунды'); }
    } else {
      score += Math.min(42, insideScenes * 8);
      if (insideScenes) why.push(`${insideScenes} смен плана`);
      if (silenceRatio < 0.25 && (Number(cues.length) === 0)) { score += 6; why.push('плотный звук'); }
    }
    score += Math.min(10, insideScenes * 2.5);
    const position = start / dur;
    if (position > 0.06 && position < 0.72) score += 8; // середина фильма — самое плотное
    else if (position <= 0.06) score -= 14;              // заставка и титры
    else score -= 4;                                     // финал: часто титры
    if (silenceRatio > 0.55) { score -= 18; why.push('много тишины'); } else if (silenceRatio < 0.12 && chars) { score += 4; }

    out.push({
      start_sec: Math.round(start * 10) / 10,
      end_sec: Math.round(end * 10) / 10,
      seconds: Math.round(seconds * 10) / 10,
      score: Math.round(Math.max(0, Math.min(100, score)) * 10) / 10,
      transcript: text.slice(0, 1200),
      reason: why.join(' · ') || 'фрагмент между сменами плана',
    });
  }

  // дедупликация и разнос по фильму: пересекающиеся окна — один и тот же
  // момент, а пять подряд идущих кусков из первых пяти минут — это не «лучшие
  // моменты фильма», а один эпизод, порезанный на части.
  out.sort((a, b) => b.score - a.score);
  const gap = clamp(dur / (Math.max(1, limit) * 1.8), Math.min(minSec, 12), 240);
  const kept = [];
  for (const c of out) {
    if (kept.some((k) => overlap(k, c) > 0.45)) continue;
    if (kept.some((k) => Math.abs(k.start_sec - c.start_sec) < gap)) continue;
    kept.push(c);
    if (kept.length >= limit) break;
  }
  // Без текста абсолютная оценка ничего не значит (нет ни реплик, ни плотности
  // речи) — оставляем сравнение кандидатов между собой, иначе в интерфейсе
  // висели бы честные, но бесполезные «2 из 100».
  const hasText = cues.length > 0 || kept.some((c) => c.transcript);
  if (!hasText && kept.length > 1) {
    const raw = kept.map((c) => c.score);
    const min = Math.min(...raw);
    const max = Math.max(...raw);
    kept.forEach((c) => {
      c.score = Math.round(45 + ((c.score - min) / (max - min || 1)) * 45);
    });
  }
  return kept.sort((a, b) => a.start_sec - b.start_sec);
}

function overlap(a, b) {
  const from = Math.max(a.start_sec, b.start_sec);
  const to = Math.min(a.end_sec, b.end_sec);
  if (to <= from) return 0;
  return (to - from) / Math.min(a.seconds, b.seconds);
}

const mmss = (sec) => {
  const s = Math.max(0, Math.round(num(sec, 0)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Распознавание речи по окнам: только если своих субтитров нет и есть ключ. */
async function transcribeCandidates(source, candidates) {
  if (!asrStatus().enabled || !candidates.length) return candidates;
  const work = path.join(SOURCE_DIR, 'tmp');
  fs.mkdirSync(work, { recursive: true });
  const language = source.lang && source.lang !== 'und' ? source.lang.slice(0, 2) : 'ru';
  let done = 0;
  const out = [];
  for (const [i, c] of candidates.entries()) {
    const clipFile = path.join(work, `${source.id}-${i}.mp3`);
    try {
      await extractAudioWindow(source.file_path, c.start_sec, c.end_sec, clipFile);
      const res = await transcribe(clipFile, { language });
      if (res.ok) {
        out.push({ ...c, transcript: res.text.slice(0, 1200), heard: true });
        done += 1;
      } else {
        out.push(c);
      }
    } catch {
      out.push(c);
    } finally {
      fs.rm(clipFile, { force: true }, () => {});
    }
    // квота бесплатного распознавания не бесконечная: остальные окна идут в
    // выбор без текста, но не теряются
    if (done >= 8) {
      out.push(...candidates.slice(i + 1));
      break;
    }
  }
  return out;
}

/**
 * Выбор лучших фрагментов языковой моделью.
 * Модель не придумывает тайминги: она выбирает из пронумерованных кандидатов
 * и пишет заголовок, крючок и объяснение. Если ИИ недоступен — остаётся
 * эвристика с честными текстами.
 */
async function rankCandidates(source, candidates, count) {
  const heuristic = candidates.slice(0, count).map((c) => ({
    ...c,
    title: String(c.transcript || '').split(/(?<=[.!?…])\s+/)[0]?.slice(0, 80) || `${source.title}: фрагмент ${mmss(c.start_sec)}`,
    hook: punchyLine(c.transcript) || `${source.title} — момент, который стоит увидеть`,
    ai: null,
  }));
  if (!candidates.length || !candidates.some((c) => c.transcript)) return heuristic;

  const list = candidates.slice(0, 10).map((c, i) => ({
    id: i + 1,
    time: `${mmss(c.start_sec)}–${mmss(c.end_sec)}`,
    score: c.score,
    text: String(c.transcript || '').slice(0, 700),
  }));
  const res = await completeJson({
    system: 'Ты — продюсер коротких видео, специалист по удержанию. Отвечаешь только валидным JSON.',
    prompt: [
      `Фильм/видео: «${source.title}».`,
      `Ниже фрагменты с таймингами и расшифровкой речи. Выбери до ${count} самых цепляющих:`,
      'конфликт, неожиданный поворот, сильная реплика, вопрос к зрителю, интрига без спойлера финала.',
      'Не бери завязку с титрами и финальные развязки.',
      JSON.stringify(list, null, 1),
      '',
      'Верни JSON:',
      '{"picks":[{"id":1,"title":"до 70 знаков, без кавычек и хэштегов","hook":"первая фраза на экране, до 90 знаков","reason":"почему зацепит, до 120 знаков","score":0-100}]}',
      'Тексты — по-русски, живым языком, без канцелярита и без обещаний дохода.',
    ].join('\n'),
    tag: 'clips.rank',
    maxTokens: 1400,
    temperature: 0.7,
  });

  if (!res.ok || !Array.isArray(res.data?.picks)) {
    log({ level: 'warn', actor: 'clips', action: 'rank.fallback', message: `ИИ не выбрал моменты: ${res.reason || 'нет данных'} — работаем по эвристике` });
    return heuristic;
  }

  const meta = { provider: res.provider, model: res.model };
  const picked = [];
  for (const pick of res.data.picks) {
    const src = candidates[num(pick.id, 0) - 1];
    if (!src) continue;
    picked.push({
      ...src,
      title: String(pick.title || '').slice(0, 90) || heuristic[0].title,
      hook: String(pick.hook || '').slice(0, 130) || punchyLine(src.transcript),
      reason: String(pick.reason || src.reason).slice(0, 200),
      score: clamp(num(pick.score, src.score), 1, 100),
      ai: meta,
    });
  }
  if (picked.length < count) {
    for (const h of heuristic) {
      if (picked.length >= count) break;
      if (picked.some((p) => p.start_sec === h.start_sec)) continue;
      picked.push(h);
    }
  }
  return picked.slice(0, count);
}

function clipCaption({ source, clip, handle }) {
  // Маркировка здесь честная и другая, чем у сгенерированного ролика: картинка
  // в клипе — реальное видео автора, автоматика только выбрала момент, смонтировала
  // вертикаль и написала подписи. Писать «видео создано ИИ» было бы неправдой.
  const handleLine = handle ? `: @${String(handle).replace(/^@/, '')}` : '.';
  const lines = [
    clip.title || source.title,
    '',
    clip.hook || clip.transcript?.slice(0, 140) || '',
    '',
    `Полное видео — в профиле${handleLine}`,
    '',
    `#нарезка #кино #${slugify(source.title).replace(/-/g, '') || 'фильм'}`,
    '',
    'Нарезка и подписи подготовлены автоматически. Исходное видео — материал канала.',
  ];
  return lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n').slice(0, 2000);
}

// ── Разбор исходника (задача очереди) ───────────────────────────────────────

registerHandler('movie.analyze', async ({ sourceId, count = null }) => {
  const source = getSource(sourceId);
  if (!source) return;
  const settings = getSettings();
  const wanted = clamp(num(count, settingsNum('clip_default_count', 5)), 1, 12);
  const minSec = clamp(settingsNum('clip_min_sec', 18), 10, 60);
  const maxSec = Math.max(minSec + 4, clamp(settingsNum('clip_max_sec', 45), 15, 60));

  db.prepare("UPDATE movie_sources SET status = 'analyzing', stage = 'probe', error = NULL, updated_at = ? WHERE id = ?").run(nowIso(), sourceId);
  try {
    if (!fs.existsSync(source.file_path)) throw new Error('Файл исходника не найден на диске');

    db.prepare("UPDATE movie_sources SET stage = 'probe' WHERE id = ?").run(sourceId);
    const info = await probeMedia(source.file_path) || await probeFallback(source.file_path);
    const duration = info?.durationSec || await probeDuration(source.file_path) || 0;
    if (!duration) throw new Error('Не удалось определить длительность: файл повреждён или это не видео');
    db.prepare(`UPDATE movie_sources SET duration_sec = ?, width = ?, height = ?, fps = ?, has_audio = ?,
                lang = ?, bytes = ?, subtitle_streams = ?, updated_at = ? WHERE id = ?`)
      .run(
        duration, num(info?.width, 0), num(info?.height, 0), num(info?.fps, 0),
        info?.hasAudio ? 1 : 0, info?.audioLang || '', num(info?.sizeBytes, source.bytes) || source.bytes,
        num(info?.subtitleStreams, 0), nowIso(), sourceId,
      );

    db.prepare("UPDATE movie_sources SET stage = 'text' WHERE id = ?").run(sourceId);
    const { cues, kind } = await ensureCues({ ...getSource(sourceId), subtitle_streams: num(info?.subtitleStreams, 0) });

    db.prepare("UPDATE movie_sources SET stage = 'scenes' WHERE id = ?").run(sourceId);
    const [scenes, silences] = await Promise.all([
      detectScenes(source.file_path, { threshold: 0.32 }),
      info?.hasAudio ? detectSilence(source.file_path, { noiseDb: -32, minDur: 0.5 }) : Promise.resolve([]),
    ]);

    let candidates = buildCandidates({
      duration, scenes, silences, cues, minSec, maxSec, limit: Math.max(10, wanted * 2),
    });
    if (!candidates.length) {
      const reason = duration < minSec * 1.2
        ? `Видео короче минимальной длины фрагмента (${Math.round(duration)} с < ${minSec} с)`
        : 'Не нашлось ни одного фрагмента подходящей длины';
      throw new Error(reason);
    }

    // без своих субтитров — слушаем окна (лучшие по эвристике)
    let subtitleKind = kind;
    if (!cues.length) {
      db.prepare("UPDATE movie_sources SET stage = 'asr' WHERE id = ?").run(sourceId);
      const heard = await transcribeCandidates(getSource(sourceId), candidates.slice(0, 10));
      const withText = heard.filter((c) => c.heard).length;
      if (withText) {
        candidates = heard;
        subtitleKind = 'asr';
      }
    }

    db.prepare("UPDATE movie_sources SET stage = 'rank' WHERE id = ?").run(sourceId);
    const picks = await rankCandidates(getSource(sourceId), candidates, wanted);

    const now = nowIso();
    const tx = db.transaction((rows) => {
      // «черновые» клипы прошлого разбора убираем, но готовые и уже
      // поставленные в очередь не трогаем: это опубликованный контент.
      db.prepare("DELETE FROM movie_clips WHERE source_id = ? AND status = 'candidate'").run(sourceId);
      let idx = 0;
      for (const row of rows) {
        idx += 1;
        db.prepare(`INSERT INTO movie_clips (id, source_id, idx, start_sec, end_sec, seconds, title, hook, caption,
                    transcript, reason, score, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'candidate', ?, ?)`)
          .run(
            uid('clip_'), sourceId, idx, row.start_sec, row.end_sec, row.seconds,
            row.title || '', row.hook || '', row.transcript || '', row.reason || '', num(row.score, 0), now, now,
          );
      }
    });
    tx(picks);

    db.prepare(`UPDATE movie_sources SET status = 'analyzed', stage = '', subtitle_kind = ?,
                analysis = ?, candidates = ?, updated_at = ? WHERE id = ?`)
      .run(subtitleKind, JSON.stringify({ cues: cues.slice(0, 6000), scenes: scenes.length, silences: silences.length, at: now }), picks.length, now, sourceId);

    log({
      level: 'success', actor: 'clips', action: 'source.analyzed', entityType: 'movie_source', entityId: sourceId,
      message: `«${source.title}»: ${picks.length} фрагментов из ${Math.round(duration / 60)} мин (${subtitleKind === 'none' ? 'без текста' : subtitleKind === 'asr' ? 'речь распознана' : 'субтитры'})`,
      meta: { duration, scenes: scenes.length, cues: cues.length, kind: subtitleKind },
    });
  } catch (err) {
    db.prepare("UPDATE movie_sources SET status = 'failed', stage = '', error = ?, updated_at = ? WHERE id = ?")
      .run(String(err.message || err).slice(0, 500), nowIso(), sourceId);
    log({
      level: 'error', actor: 'clips', action: 'source.analyze_failed', entityType: 'movie_source', entityId: sourceId,
      message: `Разбор не удался: ${String(err.message || err).slice(0, 300)}`,
    });
    throw err;
  }
});

export function startAnalyze(id, { count = null } = {}) {
  const source = getSource(id);
  if (!source) throw Object.assign(new Error('Исходник не найден'), { status: 404 });
  if (!clipRenderInfo().available) {
    throw Object.assign(new Error('Нарезка недоступна: на сервере нет ffmpeg/ffprobe'), { status: 400 });
  }
  db.prepare("UPDATE movie_sources SET status = 'analyzing', stage = 'queued', error = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id);
  enqueue('movie.analyze', { sourceId: id, count }, { delayMs: 0, priority: 4, dedupeKey: `analyze:${id}` });
  return getSource(id);
}

// ── Рендер клипа (задача очереди) ───────────────────────────────────────────

registerHandler('movie.render', async ({ clipId }) => {
  const clip = getClip(clipId);
  if (!clip) return;
  const source = getSource(clip.source_id);
  if (!source) return;
  const settings = getSettings();
  const style = settings.clip_style === 'fill' ? 'fill' : 'blur';
  const hookSec = clamp(settingsNum('clip_hook_sec', 4), 2, 8);

  db.prepare("UPDATE movie_clips SET status = 'rendering', error = NULL, updated_at = ? WHERE id = ?").run(nowIso(), clipId);
  const out = await renderMovieClip({
    source, clip, style, hookSec,
    onProgress: (p) => {
      // прогресс не пишем в базу на каждый кадр — только в память задачи
      globalThis.__clipProgress = { ...(globalThis.__clipProgress || {}), [clipId]: Math.round(p * 100) };
    },
  });

  if (globalThis.__clipProgress) delete globalThis.__clipProgress[clipId];
  if (!out.ok) {
    db.prepare("UPDATE movie_clips SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(String(out.message || out.reason || 'ошибка рендера').slice(0, 400), nowIso(), clipId);
    log({
      level: 'error', actor: 'clips', action: 'clip.render_failed', entityType: 'movie_clip', entityId: clipId,
      message: `Клип не собран: ${String(out.message || out.reason).slice(0, 200)}`,
    });
    return;
  }

  const caption = clip.caption || clipCaption({ source, clip, handle: null });
  const hashtags = JSON.stringify(['нарезка', 'кино', 'shorts']);
  db.prepare(`UPDATE movie_clips SET status = 'ready', video_path = ?, video_bytes = ?, width = ?, height = ?,
              render_ms = ?, cover_paths = ?, caption = ?, hashtags = ?, error = NULL, updated_at = ? WHERE id = ?`)
    .run(out.videoPath, out.bytes, out.width, out.height, out.renderMs, JSON.stringify(out.coverPaths || {}), caption, hashtags, nowIso(), clipId);
  log({
    level: 'success', actor: 'clips', action: 'clip.rendered', entityType: 'movie_clip', entityId: clipId,
    message: `Клип готов: ${mmss(clip.seconds)} из «${source.title}», ${(out.bytes / 1048576).toFixed(1)} МБ за ${Math.round(out.renderMs / 1000)} с`,
  });

  if (String(settings.clip_autopilot || '0') === '1') {
    try { queueClips(source.id, { count: 12 }); } catch (err) {
      log({ level: 'warn', actor: 'clips', action: 'clip.autopilot_failed', message: String(err.message || err).slice(0, 200) });
    }
  }
});

export function startRenderClip(clipId) {
  const clip = getClip(clipId);
  if (!clip) throw Object.assign(new Error('Клип не найден'), { status: 404 });
  const info = clipRenderInfo();
  if (!info.available) throw Object.assign(new Error('Рендер недоступен: нет ffmpeg/ffprobe/sharp'), { status: 400 });
  if (clip.status === 'rendering') return clip;
  // Статус «сборка» ставит сам обработчик в момент старта. Раньше он ставился
  // здесь, и три клипа показывали «сборка», пока очередь ещё даже не взяла
  // второй из них — в интерфейсе это выглядело как зависшая работа.
  db.prepare('UPDATE movie_clips SET error = NULL, updated_at = ? WHERE id = ?').run(nowIso(), clipId);
  enqueue('movie.render', { clipId }, { delayMs: 0, priority: 4, dedupeKey: `clip:${clipId}` });
  return getClip(clipId);
}

export function renderSourceClips(sourceId) {
  const source = getSource(sourceId);
  if (!source) throw Object.assign(new Error('Исходник не найден'), { status: 404 });
  const clips = db.prepare("SELECT * FROM movie_clips WHERE source_id = ? AND status IN ('candidate','failed') ORDER BY idx").all(sourceId);
  for (const clip of clips) startRenderClip(clip.id);
  return { queued: clips.length, clips: clips.map((c) => c.id) };
}

// ── Очередь публикаций ──────────────────────────────────────────────────────

/**
 * Готовые клипы → обычные эпизоды конвейера.
 * Эпизод создаётся сразу «готовым»: файл уже есть, сценарий не нужен.
 * Дальше всё как у любого ролика — аккаунты, лимиты площадок, комплаенс,
 * маркировка, аналитика и деньги.
 */
export function queueClips(sourceId, { count = null, startAt = null, platform = null, clipIds = null } = {}) {
  const source = getSource(sourceId);
  if (!source) throw Object.assign(new Error('Исходник не найден'), { status: 404 });
  const projectId = defaultProjectId(source.project_id);
  if (!projectId) throw Object.assign(new Error('Нет проекта: клипам нужен бренд для описания и ссылок'), { status: 400 });

  const settings = getSettings();
  const wanted = clamp(num(count, settingsNum('clip_default_count', 5)), 1, 24);
  const rows = db.prepare("SELECT * FROM movie_clips WHERE source_id = ? AND status = 'ready' ORDER BY score DESC, idx").all(sourceId)
    .filter((c) => !clipIds || clipIds.includes(c.id));
  const picked = clipIds ? rows : rows.slice(0, wanted);
  if (!picked.length) throw Object.assign(new Error('Нет готовых клипов: сначала соберите нарезки'), { status: 400 });

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  // подпись «полное видео в профиле» — с реального аккаунта бренда, если он есть
  const account = db.prepare(`SELECT handle FROM accounts
      WHERE status IN ('healthy','warmup') AND (project_id = ? OR project_id IS NULL)
      ORDER BY quality DESC LIMIT 1`).get(projectId);
  const handle = String(account?.handle || '').replace(/^@/, '');
  const created = [];
  let slot = startAt || nowIso();

  for (const clip of picked) {
    if (clip.episode_id) {
      const existing = db.prepare('SELECT id FROM episodes WHERE id = ?').get(clip.episode_id);
      if (existing) continue;
    }
    const caption = clipCaption({ source, clip, handle });
    const hashtags = parseJson(clip.hashtags, ['нарезка', 'кино', 'shorts']);
    const episode = createEpisode({
      projectId,
      title: (clip.title || `${source.title}: ${mmss(clip.start_sec)}`).slice(0, 90),
      scheduledAt: slot,
      prepared: true,
    });
    const scenes = [{ text: clip.hook || clip.title || '', seconds: clip.seconds, index: 0, role: 'body' }];
    touchEpisode(episode.id, {
      description: caption,
      hashtags: JSON.stringify(hashtags),
      scenes: JSON.stringify(scenes),
      caption_platform: platform || null,
      promo: 'none',
      product_id: null,
      video_path: clip.video_path,
      video_bytes: clip.video_bytes,
      cover_paths: clip.cover_paths,
      status: 'scheduled',
      stage: 'ready',
      progress: 100,
      risk: 0,
      error: null,
      creative: JSON.stringify({
        source: 'movie', sourceId: source.id, clipId: clip.id, cut: clip.idx,
        style: settings.clip_style || 'blur', pinnedComment: null,
      }),
    });

    const compliance = checkCompliance({
      title: episode.title || clip.title,
      description: caption,
      scenes: [],
      platform: platform || 'reels',
      hashtags,
      aiLabel: Number(settings.ai_label ?? 1) === 1,
    });
    const viral = scoreViral({ title: clip.title, scenes, description: caption, hashtags, targetSec: clip.seconds, projectId });
    const forecast = forecastEpisode({ episode: { ...getEpisodeRow(episode.id) }, project, scheduledAt: slot });
    db.prepare('UPDATE episodes SET compliance = ?, viral = ?, viral_meta = ?, forecast = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(compliance), num(viral.score, 0), JSON.stringify(viral), JSON.stringify(forecast), nowIso(), episode.id);

    const textSource = source.subtitle_kind === 'asr'
      ? { provider: 'groq', model: 'whisper' }
      : source.subtitle_kind === 'none' || !source.subtitle_kind
        ? { provider: 'ffmpeg', model: 'сцены и паузы' }
        : { provider: 'subtitles', model: 'srt' };
    markAi(episode.id, 'script', {
      ...textSource,
      note: `Нарезка: ${mmss(clip.start_sec)}–${mmss(clip.end_sec)}`,
    });
    markAi(episode.id, 'render', { provider: 'ffmpeg', model: settings.clip_style === 'fill' ? 'fill 9:16' : 'blur 9:16', note: '1080×1920' });

    db.prepare("UPDATE movie_clips SET status = 'queued', episode_id = ?, caption = ?, updated_at = ? WHERE id = ?")
      .run(episode.id, caption, nowIso(), clip.id);
    created.push({ episodeId: episode.id, clipId: clip.id, title: episode.title, at: slot });
    slot = nextSlot(projectId, slot);
  }

  log({
    level: 'success', actor: 'clips', action: 'clips.queued', entityType: 'movie_source', entityId: sourceId,
    message: `Клипы в очереди: ${created.length} роликов, первый в ${new Date(created[0]?.at || slot).toLocaleString('ru-RU')}`,
    meta: { count: created.length },
  });
  return created;
}

// небольшой помощник: свежая строка эпизода (после touchEpisode)
function getEpisodeRow(id) {
  return db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
}

// ── Удаление ────────────────────────────────────────────────────────────────

function removeMedia(filePath) {
  if (!filePath) return;
  const abs = String(filePath).startsWith('/media/')
    ? path.join(MEDIA_DIR, path.basename(filePath))
    : String(filePath);
  fs.rm(abs, { force: true }, () => {});
}

export function deleteClip(clipId) {
  const clip = getClip(clipId);
  if (!clip) throw Object.assign(new Error('Клип не найден'), { status: 404 });
  if (clip.episode_id) {
    throw Object.assign(new Error('Клип уже в очереди: удалите ролик в разделе «Очередь»'), { status: 400 });
  }
  for (const cover of Object.values(parseJson(clip.cover_paths, {}))) removeMedia(cover);
  removeMedia(clip.video_path);
  db.prepare('DELETE FROM movie_clips WHERE id = ?').run(clipId);
  return { ok: true };
}

export function deleteSource(sourceId) {
  const source = getSource(sourceId);
  if (!source) throw Object.assign(new Error('Исходник не найден'), { status: 404 });
  const clips = db.prepare('SELECT * FROM movie_clips WHERE source_id = ?').all(sourceId);
  const queued = clips.filter((c) => c.episode_id);
  if (queued.length) {
    throw Object.assign(new Error(`В очереди уже ${queued.length} клипов из этого исходника: сначала уберите их из очереди`), { status: 400 });
  }
  for (const clip of clips) {
    for (const cover of Object.values(parseJson(clip.cover_paths, {}))) removeMedia(cover);
    removeMedia(clip.video_path);
  }
  db.prepare('DELETE FROM movie_clips WHERE source_id = ?').run(sourceId);
  db.prepare('DELETE FROM movie_sources WHERE id = ?').run(sourceId);
  fs.rm(source.file_path, { force: true }, () => {});
  if (source.subtitle_path) fs.rm(source.subtitle_path, { force: true }, () => {});
  log({ level: 'info', actor: 'user', action: 'source.deleted', entityType: 'movie_source', entityId: sourceId, message: `Исходник удалён: «${source.title}»` });
  return { ok: true };
}

// ── Чтение для API ──────────────────────────────────────────────────────────

const clipRow = (c) => ({
  id: c.id,
  idx: c.idx,
  start: c.start_sec,
  end: c.end_sec,
  seconds: c.seconds,
  title: c.title,
  hook: c.hook,
  caption: c.caption,
  hashtags: parseJson(c.hashtags, []),
  transcript: c.transcript,
  reason: c.reason,
  score: c.score,
  status: c.status,
  videoPath: c.video_path,
  videoBytes: c.video_bytes,
  width: c.width,
  height: c.height,
  coverPaths: parseJson(c.cover_paths, {}),
  episodeId: c.episode_id,
  error: c.error,
  progress: globalThis.__clipProgress?.[c.id] || null,
});

export function sourceView(row, { withClips = true } = {}) {
  if (!row) return null;
  const clips = withClips
    ? db.prepare('SELECT * FROM movie_clips WHERE source_id = ? ORDER BY idx').all(row.id)
    : db.prepare("SELECT status, COUNT(*) n FROM movie_clips WHERE source_id = ? GROUP BY status").all(row.id);
  const list = withClips ? clips.map(clipRow) : [];
  const counts = withClips
    ? clips.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }), {})
    : Object.fromEntries(clips.map((c) => [c.status, c.n]));
  const settings = getSettings();
  return {
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    bytes: row.bytes,
    duration: row.duration_sec,
    width: row.width,
    height: row.height,
    fps: row.fps,
    hasAudio: !!row.has_audio,
    lang: row.lang,
    subtitleKind: row.subtitle_kind || null,
    rights: !!row.rights,
    status: row.status,
    stage: row.stage,
    error: row.error,
    projectId: row.project_id,
    candidates: row.candidates,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    counts,
    style: settings.clip_style || 'blur',
    clips: list,
    // «что дальше» — одна подсказка вместо инструкции на два экрана
    next: row.status === 'failed' ? 'Разбор не удался — в журнале причина'
      : row.status === 'analyzing' ? 'Идёт разбор — обычно 1–3 минуты на час видео'
        : row.status === 'new' ? 'Запустите разбор: ИИ найдёт моменты'
          : counts.rendering ? 'Собираю вертикальные клипы'
            : counts.ready ? 'Клипы готовы — поставьте в очередь'
              : counts.queued ? 'В очереди: дальше публикация по графику'
                : 'Разбор готов: соберите вертикальные клипы',
  };
}

export function listSources({ limit = 50 } = {}) {
  const rows = db.prepare('SELECT * FROM movie_sources ORDER BY created_at DESC LIMIT ?').all(clamp(num(limit, 50), 1, 200));
  const totals = db.prepare(`SELECT
      (SELECT COUNT(*) FROM movie_sources) sources,
      (SELECT COALESCE(SUM(bytes),0) FROM movie_sources) bytes,
      (SELECT COUNT(*) FROM movie_clips) clips,
      (SELECT COUNT(*) FROM movie_clips WHERE status = 'ready') ready,
      (SELECT COUNT(*) FROM movie_clips WHERE status = 'queued') queued,
      (SELECT COUNT(*) FROM movie_clips WHERE status = 'rendering') rendering,
      (SELECT COUNT(*) FROM movie_clips WHERE status = 'candidate') candidates
  `).get();
  return {
    sources: rows.map((r) => sourceView(r, { withClips: false })),
    totals,
    info: movieInfo(),
  };
}

export function getSourceView(id) {
  const row = getSource(id);
  if (!row) return null;
  return sourceView(row, { withClips: true });
}

/**
 * Возврат «зависших» состояний после падения процесса.
 *
 * Разбор и сборка живут в очереди, но статус исходника/клипа пишется в базу
 * сразу. Если контейнер убили посреди разбора, без этой функции в интерфейсе
 * навсегда остаётся «идёт разбор» и вечный опрос. Проверяем именно отсутствие
 * живой задачи, а не только время: разбор двухчасового фильма может идти долго.
 */
export function recoverSourceStates() {
  const stale = new Date(Date.now() - 15 * 60000).toISOString();
  let fixed = 0;
  try {
    const sources = db.prepare(`SELECT s.id, (SELECT COUNT(*) FROM movie_clips c WHERE c.source_id = s.id) clips
        FROM movie_sources s
        WHERE s.status = 'analyzing' AND s.updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.status IN ('pending','running') AND j.payload LIKE '%' || s.id || '%')`)
      .all(stale);
    for (const row of sources) {
      db.prepare("UPDATE movie_sources SET status = ?, stage = '', updated_at = ? WHERE id = ?")
        .run(row.clips ? 'analyzed' : 'new', nowIso(), row.id);
      fixed += 1;
    }
  } catch { /* таблицы нет — нечего восстанавливать */ }
  try {
    const clips = db.prepare(`SELECT c.id FROM movie_clips c
        WHERE c.status = 'rendering' AND c.updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.status IN ('pending','running') AND j.payload LIKE '%' || c.id || '%')`)
      .all(stale);
    for (const row of clips) {
      db.prepare("UPDATE movie_clips SET status = 'candidate', error = 'Сборка прервана перезапуском — запустите ещё раз', updated_at = ? WHERE id = ?")
        .run(nowIso(), row.id);
      fixed += 1;
    }
  } catch { /* таблицы нет */ }
  if (fixed) log({ level: 'warn', actor: 'clips', action: 'clips.recovered', message: `Восстановлено состояний нарезки: ${fixed}` });
  return fixed;
}

/** Служебное: чистка временных каталогов нарезки при обслуживании. */
export function pruneClipTemp() {
  const tmp = path.join(SOURCE_DIR, 'tmp');
  if (!fs.existsSync(tmp)) return 0;
  const cutoff = Date.now() - 6 * 3600 * 1000;
  let removed = 0;
  for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
    const full = path.join(tmp, entry.name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch { /* файл уже удалён */ }
  }
  return removed;
}

export { SOURCE_DIR, MEDIA_DIR };
