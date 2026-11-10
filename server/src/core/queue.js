// ─────────────────────────────────────────────────────────────────────────────
// Надёжная очередь задач на БД (паттерн transactional outbox + lease).
// В production-профиле заменяется на RabbitMQ/Redis Streams: интерфейс тот же
// (enqueue / claim / ack / fail / stats), см. docs/ARCHITECTURE.md.
// ─────────────────────────────────────────────────────────────────────────────
import { db, nowIso } from './db.js';
import { uid, parseJson, addMinutes, num } from './utils.js';
import { log } from './logger.js';

const HANDLERS = new Map();

export function registerHandler(type, handler) {
  HANDLERS.set(type, handler);
}

export function enqueue(type, payload = {}, { delayMs = 0, priority = 5, maxAttempts = 4, dedupeKey = null } = {}) {
  const at = new Date(Date.now() + delayMs).toISOString();
  if (dedupeKey) {
    const existing = db.prepare(
      "SELECT id FROM jobs WHERE status IN ('pending','running') AND type = ? AND payload LIKE ? LIMIT 1"
    ).get(type, `%"dedupe":"${dedupeKey}"%`);
    if (existing) return existing.id;
  }
  const id = uid('job_');
  db.prepare(`INSERT INTO jobs (id, type, payload, status, priority, attempts, max_attempts, run_after, created_at, updated_at)
              VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)`)
    .run(id, type, JSON.stringify({ ...payload, dedupe: dedupeKey }), priority, maxAttempts, at, nowIso(), nowIso());
  return id;
}

let claiming = false;

export function claimDue(limit = 6) {
  if (claiming) return [];
  claiming = true;
  try {
    const due = db.prepare(
      `SELECT * FROM jobs WHERE status = 'pending' AND run_after <= ? ORDER BY priority ASC, run_after ASC LIMIT ?`
    ).all(nowIso(), limit);
    const out = [];
    const lease = addMinutes(nowIso(), 5);
    for (const job of due) {
      const res = db.prepare(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      ).run(lease, nowIso(), job.id);
      if (res.changes === 1) out.push({ ...job, attempts: job.attempts + 1 });
    }
    return out;
  } finally {
    claiming = false;
  }
}

export function ack(job) {
  db.prepare(`UPDATE jobs SET status = 'done', lease_until = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), job.id);
}

export function fail(job, error) {
  const attempts = job.attempts ?? 1;
  const max = job.max_attempts ?? 4;
  const dead = attempts >= max;
  // Экспоненциальный backoff с джиттером: 10s, 40s, 160s…
  const delay = Math.round(10000 * Math.pow(4, attempts - 1) * (0.8 + Math.random() * 0.5));
  db.prepare(
    `UPDATE jobs SET status = ?, last_error = ?, run_after = ?, lease_until = NULL, updated_at = ? WHERE id = ?`
  ).run(dead ? 'dead' : 'pending', String(error?.message || error).slice(0, 900), new Date(Date.now() + delay).toISOString(), nowIso(), job.id);
  log({
    level: dead ? 'error' : 'warn',
    actor: 'queue',
    action: dead ? 'job.dead' : 'job.retry',
    entityType: 'job',
    entityId: job.id,
    message: dead
      ? `Задача ${job.type} ушла в dead-letter после ${attempts} попыток`
      : `Задача ${job.type}: ошибка, повтор через ${Math.round(delay / 1000)} с`,
    meta: { error: String(error?.message || error).slice(0, 300), attempts },
  });
  return { dead, delay };
}

export function jobStats() {
  const rows = db.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status').all();
  const stats = { pending: 0, running: 0, done: 0, failed: 0, dead: 0 };
  for (const r of rows) stats[r.status] = r.n;
  const next = db.prepare("SELECT MIN(run_after) t FROM jobs WHERE status = 'pending'").get();
  return { ...stats, nextRunAt: next?.t || null, handlers: [...HANDLERS.keys()] };
}

/**
 * Возврат «осиротевших» задач после падения или перезапуска процесса.
 * Один контейнер = один воркер, поэтому все running-задачи умершего процесса
 * безопасно вернуть в pending сразу, не дожидаясь истечения lease (5 минут).
 * В multi-instance профиле выключается: PULSE_SINGLE_WORKER=0.
 */
export function recoverOrphans() {
  if (process.env.PULSE_SINGLE_WORKER === '0') return 0;
  const res = db.prepare(
    "UPDATE jobs SET status = 'pending', lease_until = NULL, updated_at = ? WHERE status = 'running'"
  ).run(nowIso());
  if (res.changes > 0) {
    log({ level: 'warn', actor: 'queue', action: 'jobs.recovered', message: `Возвращено в очередь после перезапуска: ${res.changes}` });
  }
  return res.changes;
}

export function recoverStale() {
  const stale = db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'running' AND lease_until < ?").get(nowIso());
  if (stale.n > 0) {
    db.prepare("UPDATE jobs SET status = 'pending', lease_until = NULL WHERE status = 'running' AND lease_until < ?").run(nowIso());
  }
  return stale.n;
}

function withTimeout(promise, ms, type) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Задача ${type} не завершилась за ${Math.round(ms / 1000)} с — повтор`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Параллельность ──────────────────────────────────────────────────────────
// Раньше drain обрабатывал задачи строго по одной. Из-за этого разбор
// двухчасового фильма (десятки минут декодирования) блокировал вообще всё:
// аналитика, автопилот и публикации ждали, пока освободится ffmpeg. Со стороны
// это выглядело как «платформа зависла».
//
// Теперь: лёгкие задачи (подготовка, публикация, аналитика) идут параллельно
// друг с другом, тяжёлые (рендер, разбор, озвучка) — не больше
// PULSE_HEAVY_CONCURRENCY одновременно (по умолчанию 2: на одном vCPU они
// поделят ядро, но оба будут двигаться, а на двух и более — ускорятся).
const HEAVY = Math.max(1, Math.min(4, Number(process.env.PULSE_HEAVY_CONCURRENCY) || 2));
const isHeavy = (type) => /(^|\.)(render|analyze|voice|footage|cuts)$/.test(String(type || ''));

const active = new Map();
const background = new Set();
let heavyActive = 0;

// Одна задача одного типа за раз (два рендера одного вида на одном ядре только
// мешают друг другу) и не больше HEAVY тяжёлых суммарно. Так разбор фильма
// может идти одновременно с рендером ролика, но оба не вытесняют аналитику.
const hasSlot = (type) => {
  if ((active.get(`type:${type}`) || 0) > 0) return false;
  return !isHeavy(type) || heavyActive < HEAVY;
};
const takeSlot = (type) => {
  active.set(`type:${type}`, 1);
  if (isHeavy(type)) heavyActive += 1;
};
const freeSlot = (type) => {
  active.delete(`type:${type}`);
  if (isHeavy(type)) heavyActive = Math.max(0, heavyActive - 1);
};

/**
 * Вернуть захваченную, но не запущенную задачу в очередь без потери попытки.
 * Пауза в 2 секунды: иначе задача «захват → нет слота → вернуть» крутится
 * каждые 2.5 секунды и зря пишет в базу.
 */
function release(job) {
  const at = new Date(Date.now() + 2000).toISOString();
  db.prepare("UPDATE jobs SET status = 'pending', attempts = MAX(0, attempts - 1), lease_until = NULL, run_after = ?, updated_at = ? WHERE id = ? AND status = 'running'")
    .run(at, nowIso(), job.id);
}

export async function drain(limit = 8, { wait = true } = {}) {
  // Перед работой возвращаем в очередь задачи, у которых истёк lease: иначе
  // ролик навсегда застревает в «генерации», а очередь выглядит пустой.
  recoverStale();
  const jobs = claimDue(limit);
  const started = [];
  for (const job of jobs) {
    const handler = HANDLERS.get(job.type);
    if (!handler) {
      fail(job, new Error(`Нет обработчика для ${job.type}`));
      continue;
    }
    // занятый тип не запускаем повторно: задача вернётся в очередь и её
    // подхватит следующий проход, а не будет ждать в памяти
    if (!hasSlot(job.type)) {
      release(job);
      continue;
    }
    takeSlot(job.type);
    // Зависший обработчик не должен держать очередь вечно: по истечении
    // лимита задача падает в повтор, а lease освобождается.
    const limitMs = num(process.env.PULSE_JOB_TIMEOUT_SEC, 420) * 1000;
    const task = Promise.resolve()
      .then(() => withTimeout(handler(parseJson(job.payload, {}), job), limitMs, job.type))
      .then(() => ack(job), (err) => fail(job, err))
      .finally(() => freeSlot(job.type));
    started.push(task);
  }
  if (!wait) {
    // планировщику ждать нечего: он вернётся через пару секунд и заберёт новые
    // задачи, а запущенные продолжат работу в фоне
    for (const task of started) {
      background.add(task);
      task.finally(() => background.delete(task));
    }
    return started.length;
  }
  await Promise.all(started);
  return started.length;
}

// Держим таблицу задач компактной. Выполненные и упавшие старше 3 дней не нужны
// для диагностики, dead-letter — старше 30 (его ещё может понадобиться разобрать).
// Раньше dead-задачи не удалялись никогда: за годы на VPS это тысячи строк.
export function cleanupJobs() {
  const doneCutoff = new Date(Date.now() - 3 * 86400000).toISOString();
  const deadCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const done = db.prepare("DELETE FROM jobs WHERE status IN ('done','failed') AND updated_at < ?").run(doneCutoff);
  const dead = db.prepare("DELETE FROM jobs WHERE status = 'dead' AND updated_at < ?").run(deadCutoff);
  return done.changes + dead.changes;
}

export function requeueDead(limit = 50) {
  const rows = db.prepare("SELECT id FROM jobs WHERE status = 'dead' LIMIT ?").all(limit);
  const stmt = db.prepare("UPDATE jobs SET status = 'pending', attempts = 0, run_after = ?, updated_at = ? WHERE id = ?");
  for (const r of rows) stmt.run(nowIso(), nowIso(), r.id);
  return rows.length;
}
