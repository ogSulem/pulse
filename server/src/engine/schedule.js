// ─────────────────────────────────────────────────────────────────────────────
// Умное расписание: «когда публиковать», а не «через сколько минут».
//
// Три источника решения:
//   1. окна аккаунта      — не публикуем ночью, даже если «пора» (window_start/end + таймзона);
//   2. приоры площадок    — часы, в которые лента исторически активнее;
//   3. собственные данные — фактический охват по локальному часу публикации.
//
// Данные перекрывают приоры постепенно: пока на час меньше 3 наблюдений, вес приора
// выше. Поэтому на старте расписание осмысленное, а через 2–3 недели — своё.
// Всё считается в таймзоне проекта (по умолчанию PULSE_TZ), не в UTC сервера.
// ─────────────────────────────────────────────────────────────────────────────
import { db, getSettings, nowIso } from '../core/db.js';
import { num, clamp } from '../core/utils.js';

const HOUR = 3600000;
const DAY = 86400000;

// Приоры: часы активности аудитории по площадкам (локальное время).
export const PLATFORM_PEAKS = {
  reels: { hours: [11, 12, 13, 18, 19, 20, 21], label: 'обед и вечер' },
  tiktok: { hours: [7, 8, 12, 13, 17, 18, 19, 20, 21, 22], label: 'утро, обед, вечер' },
};

const priorScore = (hour, platform) => {
  const peaks = PLATFORM_PEAKS[platform] || PLATFORM_PEAKS.reels;
  if (peaks.hours.includes(hour)) return 1;
  // «плечо» рядом с пиком почти так же хорошо, глубокая ночь — заметно хуже
  if (peaks.hours.some((h) => Math.abs(h - hour) === 1)) return 0.86;
  if (hour >= 0 && hour <= 5) return 0.42;
  return 0.66;
};

// ── Таймзоны без внешних зависимостей ───────────────────────────────────────
export function tzOffsetMinutes(date, tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour % 24), +p.minute, +p.second);
    return Math.round((asUTC - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

export function localParts(value, tz) {
  const date = value instanceof Date ? value : new Date(value);
  const d = new Date(date.getTime() + tzOffsetMinutes(date, tz) * 60000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

export function zonedToUtc(year, month, day, hour, minute, tz) {
  let ts = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMinutes(new Date(ts), tz);
    ts = Date.UTC(year, month - 1, day, hour, minute, 0) - off * 60000;
  }
  return new Date(ts);
}

const tzFor = (project = null) => project?.timezone || getSettings().timezone || process.env.PULSE_TZ || 'UTC';

// ── Обучение на собственных данных ──────────────────────────────────────────
/**
 * Охват по локальному часу публикации, нормированный на медиану проекта.
 * Нормировка убирает «проект просто крупнее» и оставляет именно эффект времени.
 */
export function observedHours({ platform = null, days = 45 } = {}) {
  const since = new Date(Date.now() - days * DAY).toISOString();
  // просмотры берём из metrics_daily: там накопительный факт, а publications.views
  // может быть ещё не пересчитан (или обнулён при импорте истории)
  const rows = db.prepare(`
    SELECT COALESCE(SUM(md.views), pb.views, 0) AS total_views, pb.published_at, pb.project_id, pb.platform,
           ac.timezone tz
    FROM publications pb
    LEFT JOIN accounts ac ON ac.id = pb.account_id
    LEFT JOIN metrics_daily md ON md.publication_id = pb.id
    WHERE pb.status = 'published' AND pb.published_at > ?
      ${platform ? 'AND pb.platform = ?' : ''}
    GROUP BY pb.id
    HAVING total_views > 0
  `).all(...(platform ? [since, platform] : [since]));

  // медиана по проекту = «обычный» ролик этого проекта
  const byProject = new Map();
  for (const r of rows) {
    if (!byProject.has(r.project_id)) byProject.set(r.project_id, []);
    byProject.get(r.project_id).push(r.total_views);
  }
  const median = new Map();
  for (const [pid, list] of byProject) {
    const sorted = [...list].sort((a, b) => a - b);
    median.set(pid, sorted[Math.floor(sorted.length / 2)] || 1);
  }

  const buckets = new Map();
  for (const r of rows) {
    const tz = r.tz || getSettings().timezone || 'UTC';
    const { hour } = localParts(new Date(r.published_at), tz);
    const ratio = r.total_views / Math.max(1, median.get(r.project_id));
    if (!buckets.has(hour)) buckets.set(hour, []);
    buckets.get(hour).push(ratio);
  }
  const out = new Map();
  for (const [hour, list] of buckets) {
    // медиана устойчивее среднего: один «залетевший» ролик не делает час лучшим
    const sorted = [...list].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    out.set(hour, { samples: list.length, lift: Math.round(med * 100) / 100 });
  }
  return out;
}

/** Итоговый скор часа: приор + факт, с плавным переходом по числу наблюдений */
export function hourScores(platform, { days = 45 } = {}) {
  const observed = observedHours({ platform, days });
  const rows = [];
  for (let hour = 0; hour < 24; hour++) {
    const prior = priorScore(hour, platform);
    const obs = observed.get(hour);
    const n = obs?.samples || 0;
    // данных нужно заметно больше, чем «пара постов»: до 8 наблюдений верим приору
    const dataWeight = n < 8 ? Math.min(0.25, n / 40) : Math.min(0.7, 0.35 + (n - 8) / 40);
    // lift ограничен: час не может быть «в 3 раза лучше», это почти всегда шум
    const lift = obs ? clamp(obs.lift, 0.75, 1.3) : 1;
    const dataScore = obs ? clamp(0.35 + lift * 0.55, 0.5, 1.12) : prior;
    const score = prior * (1 - dataWeight) + dataScore * dataWeight;
    rows.push({
      hour,
      score: Math.round(score * 1000) / 1000,
      samples: n,
      lift: obs?.lift ?? null,
      source: n >= 8 ? 'data' : 'prior',
    });
  }
  return rows;
}

/** Лучшие часы — только внутри реального окна публикаций */
export function bestHours(platform, count = 3) {
  const windows = accountWindows(null);
  const start = Math.min(...windows.map((w) => w.start));
  const end = Math.max(...windows.map((w) => w.end));
  const rows = hourScores(platform).filter((r) => r.hour * 60 >= start && r.hour * 60 + 30 <= end);
  return (rows.length ? rows : hourScores(platform)).sort((a, b) => b.score - a.score).slice(0, count);
}

/** Сводка для интерфейса: какие часы лучшие и на чём основано решение */
export function scheduleInsights({ days = 45 } = {}) {
  const platforms = db.prepare("SELECT DISTINCT platform FROM accounts").all().map((r) => r.platform);
  const list = (platforms.length ? platforms : ['reels', 'tiktok']).map((platform) => {
    const rows = hourScores(platform, { days });
    const withData = rows.filter((r) => r.samples >= 8);
    return {
      platform,
      label: PLATFORM_PEAKS[platform]?.label || '',
      hours: rows,
      best: bestHours(platform, 4),
      samples: withData.reduce((a, r) => a + r.samples, 0),
      learned: withData.some((r) => r.samples >= 3),
    };
  });
  return { days, timezone: getSettings().timezone || 'UTC', platforms: list };
}

/** Площадка проекта: та, на которой он чаще публиковался, иначе первая доступная */
export function platformForProject(projectId) {
  const row = db.prepare(`SELECT platform, COUNT(*) n FROM publications WHERE project_id = ? GROUP BY platform ORDER BY n DESC LIMIT 1`).get(projectId);
  if (row?.platform) return row.platform;
  const acc = db.prepare("SELECT platform FROM accounts WHERE status IN ('healthy','warmup') ORDER BY quality DESC LIMIT 1").get();
  return acc?.platform || 'reels';
}

// ── Окна публикаций ─────────────────────────────────────────────────────────
const toMinutes = (hhmm, fallback) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return fallback;
  return (+m[1]) * 60 + (+m[2]);
};

function accountWindows(projectId) {
  const rows = db.prepare("SELECT * FROM accounts WHERE status IN ('healthy','warmup')").all();
  const relevant = rows.length ? rows : [{ window_start: '09:00', window_end: '23:00', timezone: null, min_gap_min: 90 }];
  return relevant.map((a) => ({
    start: toMinutes(a.window_start, 9 * 60),
    end: toMinutes(a.window_end, 23 * 60),
    minGap: num(a.min_gap_min, 90),
    tz: a.timezone || null,
    projectId,
  }));
}

function projectBusy(projectId, tz) {
  const rows = db.prepare(`SELECT scheduled_at, published_at FROM episodes
      WHERE project_id = ? AND status IN ('scheduled','published')`).all(projectId);
  return rows
    .map((r) => new Date(r.published_at || r.scheduled_at).getTime())
    .filter((t) => Number.isFinite(t));
}

/**
 * Следующий слот проекта.
 * Возвращает не только время, но и причину — интерфейс обязан это показывать.
 */
export function planSlot(projectId, { after = null, project = null } = {}) {
  const prj = project || db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const tz = tzFor(prj);
  const settings = getSettings();
  const perDay = clamp(num(prj?.posts_per_day, 2), 1, 12);
  const gapMin = Math.max(45, Math.round((24 * 60) / perDay));
  const windows = accountWindows(projectId);
  const winStart = Math.min(...windows.map((w) => w.start));
  const winEnd = Math.max(...windows.map((w) => w.end));
  const from = after ? new Date(after) : new Date();
  const busy = projectBusy(projectId, tz);

  // 1. самая ранняя допустимая точка: не раньше «после» и не раньше интервала от последнего поста
  let earliest = from.getTime() + 5 * 60000;
  const lastAt = busy.length ? Math.max(...busy) : 0;
  if (lastAt) earliest = Math.max(earliest, lastAt + gapMin * 60000);

  // 2. ищем лучший час в пределах ±5 часов от «ровного» слота, внутри окна аккаунтов
  const startParts = localParts(new Date(earliest), tz);
  const dayStartUtc = zonedToUtc(startParts.year, startParts.month, startParts.day, 0, 0, tz).getTime();

  let best = null;
  for (let dayOffset = 0; dayOffset <= 3 && !best; dayOffset++) {
    const dayTs = dayStartUtc + dayOffset * DAY;
    const platform = platformForProject(projectId);
    const scores = new Map(hourScores(platform).map((r) => [r.hour, r]));
    for (let hour = 0; hour < 24; hour++) {
      const minutesStart = hour * 60;
      if (minutesStart < winStart || minutesStart + 30 > winEnd) continue;
      const ts = dayTs + hour * HOUR + 7 * 60000; // :07 — не «ровный час», меньше похоже на бота
      if (ts < earliest) continue;
      const tooClose = busy.some((b) => Math.abs(b - ts) < Math.min(gapMin, 45) * 60000);
      if (tooClose) continue;
      const s = scores.get(hour) || { score: priorScore(hour, platform), source: 'prior', samples: 0 };
      // 3. штраф за слишком далёкий перенос: не стоим «полдня» ради +2% охвата
      const delayHours = (ts - earliest) / HOUR;
      const urgency = Math.max(0, 1 - delayHours / 14);
      const total = s.score * 0.62 + urgency * 0.38;
      if (!best || total > best.total) best = { ts, hour, score: s.score, source: s.source, samples: s.samples, total, delayHours };
    }
  }

  // 4. не нашли свободное окно (например, всё занято) — сдвигаем на сутки вперёд
  if (!best) {
    const ts = earliest + DAY;
    return { at: new Date(ts).toISOString(), hour: localParts(new Date(ts), tz).hour, score: 0.5, source: 'fallback', samples: 0, reason: 'Окно переполнено — сдвиг на сутки', timezone: tz };
  }

  const timeLabel = `${String(best.hour).padStart(2, '0')}:07`;
  const reason = best.source === 'data'
    ? `${timeLabel} — ваш лучший час по ${best.samples} публикациям (скор ${best.score.toFixed(2)})`
    : `${timeLabel} — пик активности: ${PLATFORM_PEAKS[platformForProject(projectId)]?.label || 'аудитория'}`;

  return {
    at: new Date(best.ts).toISOString(),
    hour: best.hour,
    score: Math.round(best.score * 1000) / 1000,
    source: best.source,
    samples: best.samples,
    window: { start: `${String(Math.floor(winStart / 60)).padStart(2, '0')}:00`, end: `${String(Math.floor(winEnd / 60)).padStart(2, '0')}:00` },
    timezone: tz,
    reason,
  };
}

/** Обратная совместимость: строковый ISO-слот */
export function nextSlotIso(projectId, after = null) {
  return planSlot(projectId, { after }).at;
}

/** Ближайшие слоты, которые уже стоят в расписании — для панели */
export function upcomingSlots(limit = 6) {
  return db.prepare(`SELECT e.id, e.title, e.scheduled_at, e.project_id, pr.name project_name
      FROM episodes e LEFT JOIN projects pr ON pr.id = e.project_id
      WHERE e.status = 'scheduled' AND e.scheduled_at IS NOT NULL
      ORDER BY e.scheduled_at ASC LIMIT ?`).all(limit).map((r) => ({
    ...r,
    localHour: localParts(new Date(r.scheduled_at), getSettings().timezone || 'UTC').hour,
  }));
}

export const scheduleUtils = { tzOffsetMinutes, localParts, zonedToUtc, nowIso };
