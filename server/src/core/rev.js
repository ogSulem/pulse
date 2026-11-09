import crypto from 'node:crypto';
import { db } from './db.js';

/**
 * Отпечатки состояния для лёгкого опроса панели.
 *
 * Панель обновляется каждые несколько секунд. Раньше каждый тик тянул пять
 * запросов и ~117 КБ, а страницы перерисовывались, даже когда на сервере ничего
 * не поменялось — отсюда «мерцание» списков и прыжки скелетонов.
 *
 * Теперь клиент присылает отпечатки, которые у него уже есть. Сервер сравнивает
 * их с текущими и:
 *   • при полном совпадении отвечает ~120 байтами `{ rev, unchanged: true }`;
 *   • иначе отдаёт только те срезы, которые реально изменились.
 *
 * Отпечаток считается по агрегатам (count / max(updated_at) / sum), а не по
 * всему содержимому: это несколько индексных запросов на тик. Срез `money`
 * payload не имеет — он нужен как «сигнал», что цифры дохода/метрик обновились,
 * и по нему перезапрашивают свои данные «Аналитика» и «Деньги».
 */

const digest = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
};

/** Агрегаты, по которым строятся и отпечатки, и сам ответ /api/live. */
export function liveFacts() {
  const episodes = db.prepare(`SELECT COUNT(*) n,
      COALESCE(MAX(updated_at), '') u,
      COALESCE(SUM(progress), 0) p
    FROM episodes`).get();
  const byStatus = db.prepare('SELECT status, COUNT(*) n FROM episodes GROUP BY status').all();
  const jobs = db.prepare(`SELECT status, COUNT(*) n,
      COALESCE(MAX(updated_at), '') u,
      COALESCE(MIN(CASE WHEN status = 'pending' THEN run_after END), '') next
    FROM jobs GROUP BY status`).all();
  const logs = db.prepare("SELECT COUNT(*) n, COALESCE(MAX(ts), '') t FROM logs").get();
  const projects = db.prepare(`SELECT COUNT(*) n, COALESCE(MAX(updated_at), '') u,
      COALESCE(SUM(archived), 0) a FROM projects`).get();
  // один запрос вместо серии: сколько вышло, сколько просмотров, клики, конверсии
  const money = db.prepare(`SELECT
      (SELECT COUNT(*) FROM publications) pubs,
      (SELECT COALESCE(SUM(views), 0) FROM publications) views,
      (SELECT COALESCE(MAX(published_at), '') FROM publications) last_pub,
      (SELECT COUNT(*) FROM clicks) clicks,
      (SELECT COUNT(*) FROM conversions) convs,
      (SELECT COALESCE(MAX(ts), '') FROM clicks) last_click,
      (SELECT COALESCE(SUM(views), 0) FROM metrics_daily) metric_views,
      (SELECT COUNT(*) FROM metrics_daily) metrics,
      (SELECT COUNT(*) FROM campaigns) camps,
      (SELECT COALESCE(SUM(paid_cents), 0) FROM campaigns) paid,
      (SELECT COALESCE(MAX(updated_at), '') FROM campaigns) camps_at`).get();

  return { episodes, byStatus, jobs, logs, projects, money };
}

/** Отпечатки срезов + общий. Одинаковый вход — одинаковый отпечаток. */
export function liveRevs(facts = liveFacts()) {
  const statusKey = facts.byStatus.map((r) => `${r.status}:${r.n}`).sort().join(',');
  const jobsKey = facts.jobs.map((r) => `${r.status}:${r.n}:${r.u}`).sort().join(',');
  const settingsKey = db.prepare('SELECT key, value FROM settings ORDER BY key').all()
    .map((r) => `${r.key}=${r.value}`).join('\n');

  const revs = {
    // состав лент: что-то создано/сдвинулось по статусу/прогрессу
    episodes: digest([facts.episodes.n, facts.episodes.u, facts.episodes.p]),
    // счётчики конвейера + прогресс активных роликов (его видно в «Сегодня»)
    pipeline: digest([statusKey, jobsKey, facts.episodes.n, facts.episodes.u, facts.episodes.p]),
    logs: digest([facts.logs.n, facts.logs.t]),
    projects: digest([facts.projects.n, facts.projects.u, facts.projects.a]),
    settings: digest(settingsKey),
    money: digest(Object.values(facts.money)),
  };
  return { rev: digest(Object.values(revs).join('.')), revs };
}
