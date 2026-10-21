// ─────────────────────────────────────────────────────────────────────────────
// Viral Score — честная эвристика «зайдёт / не зайдёт».
//
// Это НЕ предсказание алгоритма. Модель считает по 6 измеримым признакам,
// которые действительно коррелируют с удержанием в коротких вертикальных
// роликах, и показывает вклад каждого. Если суммарный балл ниже порога из
// настроек, ролик уходит в ручную проверку с объяснением, а не в публикацию.
//
// Признаки:
//   1. hook        — сила первой фразы (вопрос/цифра/конфликт/адресация «ты»);
//   2. length      — длина в секундах (лучший интервал 18–34 с);
//   3. pace        — слов в секунду (быстрый темп держит удержание);
//   4. retention   — наличие «петли» и обещания в начале/конце;
//   5. caption     — описание и хештеги (SEO-часть);
//   6. novelty     — свежесть темы относительно уже опубликованного.
//
// Обратная связь: после публикации фактические метрики сравниваются с прогнозом
// и модель корректируется (см. calibration()).
// ─────────────────────────────────────────────────────────────────────────────
import { db, getSettings, setSettings } from '../core/db.js';
import { clamp, parseJson } from '../core/utils.js';

// Приоры весов. Дальше они уточняются на фактических данных (recalibrate()).
export const PRIOR_WEIGHTS = { hook: 0.30, length: 0.16, pace: 0.14, retention: 0.18, caption: 0.12, novelty: 0.10 };
const MIN_SAMPLES = 12;

let weightCache = { at: 0, weights: PRIOR_WEIGHTS, meta: null };
const WEIGHT_TTL = 60000;

/** Веса факторов: приоры или обученные на своих публикациях */
export function currentWeights({ fresh = false } = {}) {
  if (!fresh && Date.now() - weightCache.at < WEIGHT_TTL) return weightCache;
  const raw = getSettings().viral_weights;
  let meta = null;
  let weights = { ...PRIOR_WEIGHTS };
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.weights) {
      const sum = Object.values(parsed.weights).reduce((a, b) => a + Number(b || 0), 0);
      if (sum > 0.5 && sum < 1.5) {
        weights = Object.fromEntries(Object.entries(PRIOR_WEIGHTS).map(([k]) => [k, Number(parsed.weights[k] ?? PRIOR_WEIGHTS[k])]));
        meta = { samples: parsed.samples, at: parsed.at, lift: parsed.lift };
      }
    }
  } catch { /* повреждённое значение — используем приоры */ }
  weightCache = { at: Date.now(), weights, meta };
  return weightCache;
}

const HOOK_PATTERNS = [
  { re: /^(почему|как|что|когда|сколько|зачем|кто)\b/i, points: 14, label: 'вопрос в первой фразе' },
  { re: /\bты\b|\bтебе\b|\bтвой\b|\bтво\b/i, points: 12, label: 'обращение к зрителю' },
  { re: /\d/, points: 10, label: 'конкретное число' },
  { re: /(перестань|никогда|ошибк|проблем|теря|лома|опасн)/i, points: 12, label: 'конфликт или риск' },
  { re: /(секрет|разбор|систем|пошагов|метод)/i, points: 8, label: 'обещание метода' },
];

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);

export function scoreViral({ title = '', scenes = [], description = '', hashtags = [], targetSec = 30, topic = '', projectId = null }) {
  const sceneList = (scenes || []).map((s) => (typeof s === 'string' ? s : s.text || '')).filter(Boolean);
  const first = sceneList[0] || title || '';
  const full = [title, ...sceneList].join(' ');
  const totalWords = words(full).length;
  const durationSec = (scenes || []).reduce((acc, s) => acc + (typeof s === 'object' ? Number(s.seconds) || 0 : 0), 0) || targetSec;
  const factors = [];

  // 1. хук
  let hook = 26;
  const hits = [];
  for (const p of HOOK_PATTERNS) {
    if (p.re.test(first)) { hook += p.points; hits.push(p.label); }
  }
  const firstWords = words(first).length;
  if (firstWords > 0 && firstWords <= 12) hook += 8;        // короткий хук читается быстрее
  if (firstWords > 22) hook -= 14;
  hook = clamp(Math.round(hook), 0, 100);
  factors.push({ id: 'hook', label: 'Хук первой фразы', value: hook, weight: 0.30, detail: hits.length ? hits.join(', ') : 'нет сильного приёма в первой фразе' });

  // 2. длина
  let length = 100;
  if (durationSec < 12) length = 42;
  else if (durationSec < 18) length = 72;
  else if (durationSec <= 34) length = 100;
  else if (durationSec <= 50) length = 74;
  else length = 48;
  factors.push({ id: 'length', label: 'Длительность', value: length, weight: 0.16, detail: `${Math.round(durationSec)} с — оптимум 18–34 с` });

  // 3. темп
  const wps = totalWords / Math.max(6, durationSec);
  const pace = clamp(Math.round(wps <= 1.6 ? 40 + wps * 22 : wps <= 2.8 ? 100 : Math.max(45, 100 - (wps - 2.8) * 26)), 0, 100);
  factors.push({ id: 'pace', label: 'Темп речи', value: pace, weight: 0.14, detail: `${wps.toFixed(1)} слов/с — оптимум 1,8–2,8` });

  // 4. удержание: обещание + CTA + петля
  let retention = 34;
  if (/(до конца|досмотри|в конце|последн)/i.test(full)) retention += 24;
  if (/(коммент|сохрани|подпишись|проверь себя)/i.test(full)) retention += 14;
  if (/(согласен|а ты как|что думаешь|\?)/i.test(full)) retention += 12;
  if (sceneList.length >= 4) retention += 12;               // смена кадра каждые 3–5 с
  retention = clamp(retention, 0, 100);
  factors.push({ id: 'retention', label: 'Удержание', value: retention, weight: 0.18, detail: `${sceneList.length} сцен, ${/(до конца|в конце)/i.test(full) ? 'есть обещание в конце' : 'нет обещания досмотреть'}` });

  // 5. описание и хештеги
  const captionLen = String(description || '').length;
  const tagCount = (hashtags || []).length;
  let caption = 40;
  if (captionLen >= 60) caption += 24;
  if (captionLen >= 140) caption += 10;
  if (captionLen > 600) caption -= 20;
  if (tagCount >= 4) caption += 14;
  if (tagCount >= 8) caption += 6;
  if (tagCount > 20) caption -= 12;
  caption = clamp(caption, 0, 100);
  factors.push({ id: 'caption', label: 'Описание и теги', value: caption, weight: 0.12, detail: `${captionLen} символов, ${tagCount} тегов` });

  // 6. новизна темы
  let novelty = 70;
  if (projectId && topic) {
    const used = db.prepare(`SELECT COUNT(*) n FROM episodes WHERE project_id = ? AND lower(topic) = lower(?) AND status IN ('scheduled','published')`).get(projectId, topic).n;
    novelty = used === 0 ? 95 : used === 1 ? 74 : used === 2 ? 56 : 38;
  }
  factors.push({ id: 'novelty', label: 'Новизна темы', value: novelty, weight: 0.10, detail: novelty >= 90 ? 'тема ещё не публиковалась' : 'тема уже выходила — нужен новый угол' });

  // веса: приоры или обученные на факте (см. recalibrate)
  const { weights, meta: weightMeta } = currentWeights();
  for (const f of factors) f.weight = weights[f.id] ?? f.weight;

  const score = Math.round(factors.reduce((acc, f) => acc + f.value * f.weight, 0));
  const weakest = [...factors].sort((a, b) => a.value - b.value)[0];
  const advice = [];
  if (factors[0].value < 55) advice.push('Перепишите первую фразу: вопрос, число или конфликт в первых 12 словах.');
  if (factors[1].value < 70) advice.push('Сократите ролик до 18–34 секунд — там лучшая досматриваемость.');
  if (factors[3].value < 60) advice.push('Добавьте обещание в конце и вопрос к зрителю — это поднимает досмотры.');
  if (factors[4].value < 60) advice.push('Дополните описание: 60–200 символов и 5–8 релевантных тегов.');
  if (factors[5].value < 60) advice.push('Смените угол: эта тема уже выходила, нужен другой вход.');

  return {
    score,
    grade: score >= 75 ? 'high' : score >= 55 ? 'medium' : 'low',
    factors,
    weakest: weakest?.id,
    advice,
    meta: {
      durationSec: Math.round(durationSec),
      words: totalWords,
      wps: Number(wps.toFixed(2)),
      scenes: sceneList.length,
    },
    confidence: 'эвристика по 6 признакам, не прогноз алгоритма',
    weights: Object.fromEntries(factors.map((f) => [f.id, f.weight])),
    weightsSource: weightMeta ? `обучены на ${weightMeta.samples} роликах` : 'приоры (данных ещё мало)',
    computed_at: new Date().toISOString(),
  };
}

export function saveViral(episodeId, report) {
  db.prepare('UPDATE episodes SET viral = ?, viral_meta = ? WHERE id = ?')
    .run(report.score, JSON.stringify(report), episodeId);
}

/**
 * Переобучение весов: какой признак реально отличает ролики с большим охватом.
 * Считаем медианное деление по каждому фактору и сравниваем охват «верхних» и
 * «нижних» роликов. Вес растёт там, где разрыв больше, но не более чем втрое —
 * чтобы один удачный ролик не перекосил модель.
 */
export function recalibrate({ minSamples = MIN_SAMPLES } = {}) {
  const rows = db.prepare(`SELECT e.id, e.project_id, e.viral_meta,
      COALESCE(SUM(pb.views), 0) views
    FROM episodes e JOIN publications pb ON pb.episode_id = e.id
    WHERE e.viral_meta IS NOT NULL AND e.viral_meta != '{}' AND pb.status = 'published'
    GROUP BY e.id HAVING views > 0`).all();
  if (rows.length < minSamples) {
    return { ready: false, samples: rows.length, need: minSamples, weights: { ...PRIOR_WEIGHTS } };
  }

  // нормировка на медиану проекта: сравниваем ролики внутри одного проекта
  const byProject = new Map();
  for (const r of rows) {
    if (!byProject.has(r.project_id)) byProject.set(r.project_id, []);
    byProject.get(r.project_id).push(r.views);
  }
  const medians = new Map();
  for (const [pid, list] of byProject) {
    const s = [...list].sort((a, b) => a - b);
    medians.set(pid, s[Math.floor(s.length / 2)] || 1);
  }
  const samples = rows.map((r) => ({
    ratio: r.views / Math.max(1, medians.get(r.project_id)),
    factors: Object.fromEntries((parseJson(r.viral_meta, {}).factors || []).map((f) => [f.id, Number(f.value)])),
  })).filter((s) => Object.keys(s.factors).length);

  const lift = {};
  for (const id of Object.keys(PRIOR_WEIGHTS)) {
    const withFactor = samples.filter((s) => Number.isFinite(s.factors[id]));
    if (withFactor.length < minSamples) { lift[id] = 1; continue; }
    const sorted = [...withFactor].sort((a, b) => a.factors[id] - b.factors[id]);
    const half = Math.floor(sorted.length / 2);
    const low = sorted.slice(0, half);
    const high = sorted.slice(sorted.length - half);
    const avg = (arr) => arr.reduce((a, s) => a + s.ratio, 0) / Math.max(1, arr.length);
    const hi = avg(high);
    const lo = avg(low);
    lift[id] = lo > 0 ? clamp(hi / lo, 0.5, 3) : 1;
  }

  const raw = Object.fromEntries(Object.keys(PRIOR_WEIGHTS).map((k) => [k, PRIOR_WEIGHTS[k] * lift[k]]));
  const sum = Object.values(raw).reduce((a, b) => a + b, 0);
  const weights = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Math.round((v / sum) * 1000) / 1000]));
  const payload = { weights, samples: samples.length, lift, at: new Date().toISOString() };
  setSettings({ viral_weights: JSON.stringify(payload) });
  weightCache = { at: Date.now(), weights, meta: { samples: samples.length, at: payload.at, lift } };
  return { ready: true, ...payload };
}

/** Калибровка: сравниваем прогноз с фактом по завершённым публикациям */
export function calibration() {
  const rows = db.prepare(`SELECT e.viral, pb.views, pd.followers avg_views
      FROM episodes e JOIN publications pb ON pb.episode_id = e.id
      WHERE e.viral IS NOT NULL AND pb.views > 0`).all();
  if (rows.length < 8) return { samples: rows.length, ready: false };
  const high = rows.filter((r) => r.viral >= 65);
  const low = rows.filter((r) => r.viral < 65);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, r) => a + r.views, 0) / arr.length) : 0);
  return {
    samples: rows.length,
    ready: true,
    highScoreAvgViews: avg(high),
    lowScoreAvgViews: avg(low),
    lift: low.length && avg(low) ? Number((avg(high) / avg(low)).toFixed(2)) : null,
    weights: currentWeights().weights,
    weightsSource: currentWeights().meta ? 'learned' : 'prior',
  };
}
