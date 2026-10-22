// ─────────────────────────────────────────────────────────────────────────────
// Прогноз и «умные деньги».
//
// Два вопроса, на которые платформа обязана отвечать без гаданий:
//   1. сколько этот ролик принесёт и сколько он стоит — до публикации;
//   2. зарабатывает ли проект в целом — и что с этим делать (масштабировать,
//      держать, чинить или поставить на паузу).
//
// База прогноза — не «красивое число», а медиана фактического охвата проекта
// на этой площадке за 30 дней. Дальше три множителя: вирусный скор ролика,
// час публикации (из schedule.js) и качество аккаунта. Все множители
// возвращаются в ответе, чтобы цифру можно было проверить и оспорить.
// ─────────────────────────────────────────────────────────────────────────────
import { db, getSettings, nowIso } from '../core/db.js';
import { log } from '../core/logger.js';
import { num, clamp, addDays, parseJson } from '../core/utils.js';
import { hourScores, platformForProject, localParts } from './schedule.js';
import { rpmFor } from './money.js';

const DAY = 86400000;

const median = (list) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Медианный охват: проекта на площадке → площадки → фолбэк */
export function baselineViews(projectId, platform) {
  const since = new Date(Date.now() - 45 * DAY).toISOString();
  const project = db.prepare(`SELECT views FROM publications
      WHERE project_id = ? AND platform = ? AND status = 'published' AND views > 0 AND published_at > ?`)
    .all(projectId, platform, since).map((r) => r.views);
  if (project.length >= 3) return { views: median(project), source: 'project', samples: project.length };
  const global = db.prepare(`SELECT views FROM publications
      WHERE platform = ? AND status = 'published' AND views > 0 AND published_at > ?`)
    .all(platform, since).map((r) => r.views);
  if (global.length >= 3) return { views: median(global), source: 'platform', samples: global.length };
  return { views: 1200, source: 'fallback', samples: 0 };
}

const accountFactor = (account) => {
  if (!account) return 0.85;
  const q = clamp(num(account.quality, 65), 20, 100);
  const warmup = account.status === 'warmup' ? 0.55 : 1;
  return (0.6 + (q / 100) * 0.8) * warmup;
};

/**
 * Прогноз одного ролика: охват → деньги → ROI.
 * Возвращает не только числа, но и вклады — интерфейс показывает их в карточке.
 */
export function forecastEpisode({ episode, project = null, account = null, platform = null, scheduledAt = null }) {
  const settings = getSettings();
  const prj = project || db.prepare('SELECT * FROM projects WHERE id = ?').get(episode?.project_id);
  const plat = platform || (account?.platform) || platformForProject(episode?.project_id);
  const base = baselineViews(episode?.project_id, plat);

  const viral = num(episode?.viral, 60);
  const viralFactor = 0.75 + (viral / 100) * 0.6;

  const at = scheduledAt ? new Date(scheduledAt) : (episode?.scheduled_at ? new Date(episode.scheduled_at) : new Date());
  const tz = settings.timezone || 'UTC';
  const hour = localParts(at, tz).hour;
  const scoreRow = hourScores(plat).find((r) => r.hour === hour);
  const hourFactor = clamp(scoreRow?.score ?? 0.8, 0.4, 1.2);

  const accFactor = accountFactor(account);
  const expectedViews = Math.max(50, Math.round(base.views * viralFactor * hourFactor * accFactor));

  const rpm = rpmFor(plat, settings);
  const ctr = num(settings.ctr_estimate, 1.2) / 100;
  const convRate = num(settings.conv_rate, 1.6) / 100;
  const price = num(settings.product_price, 2490);
  const margin = num(settings.product_margin, 0.55);

  const expectedClicks = expectedViews * ctr;
  const expectedConversions = expectedClicks * convRate;
  const revenueAd = (expectedViews / 1000) * rpm;
  const revenueSales = expectedConversions * price * margin;
  const revenue = revenueAd + revenueSales;
  const cost = num(episode?.cost_cents, 0) / 100 || (num(settings.cost_video, 45) + num(settings.cost_tts, 12) + num(settings.cost_llm, 8) + num(settings.cost_render, 1));
  const profit = revenue - cost;
  const roi = cost > 0 ? (profit / cost) * 100 : 0;

  return {
    platform: plat,
    expectedViews,
    expectedClicks: Math.round(expectedClicks),
    expectedConversions: Math.round(expectedConversions * 10) / 10,
    revenueAd: Math.round(revenueAd * 100) / 100,
    revenueSales: Math.round(revenueSales * 100) / 100,
    revenue: Math.round(revenue * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    roi: Math.round(roi),
    currency: settings.currency || '₽',
    verdict: roi >= 120 ? 'профитно' : roi >= 0 ? 'на грани' : 'убыточно',
    factors: {
      baseline: base.views,
      baselineSource: base.source,
      baselineSamples: base.samples,
      viral: { score: viral, factor: Math.round(viralFactor * 100) / 100 },
      hour: { local: hour, score: Math.round(hourFactor * 100) / 100, source: scoreRow?.source || 'prior' },
      account: { quality: num(account?.quality, 65), factor: Math.round(accFactor * 100) / 100, status: account?.status || 'n/a' },
    },
    assumptions: {
      rpm, ctr: Math.round(ctr * 10000) / 100, conv: Math.round(convRate * 10000) / 100, price, margin,
    },
  };
}

/** Здоровье проекта: факт за период, а не прогноз */
export function projectHealth(projectId, { days = 14 } = {}) {
  const since = addDays(nowIso(), -days);
  const row = db.prepare(`SELECT COUNT(*) pubs, COALESCE(SUM(views),0) views,
      COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(cost_cents),0) cost
    FROM publications WHERE project_id = ? AND status = 'published' AND published_at > ?`).get(projectId, since);
  const conv = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(value_cents),0) v FROM conversions
      WHERE project_id = ? AND ts > ?`).get(projectId, since);
  const settings = getSettings();
  const platforms = db.prepare(`SELECT platform, COALESCE(SUM(views),0) v, COUNT(*) n FROM publications
      WHERE project_id = ? AND status = 'published' AND published_at > ? GROUP BY platform`).all(projectId, since);
  let adCents = 0;
  for (const p of platforms) {
    const rpm = rpmFor(p.platform, settings);
    adCents += Math.round((p.v / 1000) * rpm * 100);
  }
  const revenue = adCents + conv.v;
  const profit = revenue - row.cost;
  const roi = row.cost > 0 ? (profit / row.cost) * 100 : 0;
  const avgViews = row.pubs ? Math.round(row.views / row.pubs) : 0;

  let action = 'hold';
  let reason = 'Пока мало данных: нужно минимум 5 публикаций, чтобы что-то менять';
  if (row.pubs >= 5) {
    if (roi >= 250 && avgViews > 800) { action = 'scale'; reason = `ROI ${Math.round(roi)}%: можно публиковать чаще, лимиты аккаунтов ещё есть`; }
    else if (roi >= 40) { action = 'hold'; reason = `ROI ${Math.round(roi)}%: держим темп и следим за форматами`; }
    else if (roi >= 0) { action = 'fix'; reason = `ROI ${Math.round(roi)}%: прибыль почти нулевая — меняем форматы и темы`; }
    else { action = 'pause'; reason = `ROI ${Math.round(roi)}%: проект убыточен ${days} дней — автопилот стоит притормозить`; }
  }

  return {
    days,
    publications: row.pubs,
    views: row.views,
    avgViews,
    clicks: row.clicks,
    conversions: conv.n,
    revenue: Math.round(revenue) / 100,
    cost: Math.round(row.cost) / 100,
    profit: Math.round(profit) / 100,
    roi: Math.round(roi),
    action,
    reason,
  };
}

/**
 * Политика автопилота: масштабировать или притормозить.
 * Меняет posts_per_day в пределах 1–6 и никогда не выключает проект молча:
 * решение пишется в журнал и видно на экране денег.
 */
export function autopilotPolicy({ projectId = null, apply = true } = {}) {
  const projects = projectId
    ? db.prepare('SELECT * FROM projects WHERE id = ?').all(projectId)
    : db.prepare('SELECT * FROM projects WHERE archived = 0').all();
  // сколько всего постов в сутки выдержат аккаунты: выше этого темпа
  // «масштабирование» превращается в бесконечные переносы
  const capacity = db.prepare("SELECT COALESCE(SUM(daily_limit), 0) c FROM accounts WHERE status IN ('healthy','warmup')").get().c || 0;
  const planned = db.prepare('SELECT COALESCE(SUM(posts_per_day), 0) s FROM projects WHERE archived = 0').get().s || 0;

  const out = [];
  for (const project of projects) {
    const health = projectHealth(project.id);
    let posts = num(project.posts_per_day, 2);
    let changed = false;
    if (health.action === 'scale' && posts < 6) {
      if (capacity > 0 && planned + 1 > Math.floor(capacity * 0.85)) {
        health.action = 'hold';
        health.reason = `ROI ${Math.round(health.roi)}% — темп можно поднять, но лимиты аккаунтов почти заняты (${planned} из ${capacity} постов в сутки). Держим`;
      } else {
        posts = Math.min(6, posts + 1);
        changed = true;
      }
    }
    if (health.action === 'fix' && posts > 2) { posts = Math.max(2, posts - 1); changed = true; }
    if (health.action === 'pause' && posts > 1) { posts = 1; changed = true; }

    if (changed && apply) {
      db.prepare('UPDATE projects SET posts_per_day = ?, updated_at = ? WHERE id = ?').run(posts, nowIso(), project.id);
      log({
        level: health.action === 'scale' ? 'success' : 'warn',
        actor: 'money', action: `autopilot.${health.action}`, entityType: 'project', entityId: project.id,
        message: `${project.name}: ${health.reason}. Постов в день: ${project.posts_per_day} → ${posts}`,
        meta: { roi: health.roi, profit: health.profit, days: health.days },
      });
    }
    out.push({ projectId: project.id, name: project.name, postsPerDay: posts, wasPostsPerDay: project.posts_per_day, changed, health });
  }
  return out;
}

/**
 * Качество аккаунта по факту: сколько охвата он приносит относительно других
 * аккаунтов той же площадки. Так нагрузка уходит на аккаунты, которые реально
 * работают, а не на те, у которых красивая цифра в карточке.
 */
export function recalculateAccountQuality({ apply = true, minPosts = 4 } = {}) {
  const accounts = db.prepare("SELECT * FROM accounts WHERE status IN ('healthy','warmup')").all();
  const since = new Date(Date.now() - 21 * DAY).toISOString();
  const stats = db.prepare(`SELECT account_id, COUNT(*) pubs, COALESCE(AVG(views),0) avg_views
      FROM publications WHERE published_at > ? AND status = 'published' AND views > 0
      GROUP BY account_id`).all(since);
  const byId = new Map(stats.map((r) => [r.account_id, r]));
  const platformAvg = new Map();
  for (const a of accounts) {
    const st = byId.get(a.id);
    if (!st) continue;
    if (!platformAvg.has(a.platform)) platformAvg.set(a.platform, []);
    platformAvg.get(a.platform).push(st.avg_views);
  }
  const medians = new Map([...platformAvg.entries()].map(([p, list]) => {
    const s2 = [...list].sort((x, y) => x - y);
    return [p, s2[Math.floor(s2.length / 2)] || 1];
  }));

  const out = [];
  for (const a of accounts) {
    const st = byId.get(a.id);
    if (!st || st.pubs < minPosts) { out.push({ id: a.id, handle: a.handle, quality: a.quality, changed: false, samples: st?.pubs || 0 }); continue; }
    const median = medians.get(a.platform) || 1;
    const lift = st.avg_views / Math.max(1, median);
    const measured = clamp(Math.round(45 + lift * 35), 20, 100);
    // сглаживаем: один удачный месяц не должен делать аккаунт «идеальным»
    const quality = Math.round(num(a.quality, 60) * 0.6 + measured * 0.4);
    const changed = quality !== num(a.quality, 60);
    if (changed && apply) {
      db.prepare('UPDATE accounts SET quality = ?, updated_at = ? WHERE id = ?').run(quality, nowIso(), a.id);
      log({
        level: 'info', actor: 'money', action: 'account.quality', entityType: 'account', entityId: a.id,
        message: `${a.handle}: качество ${a.quality} → ${quality} (средний охват ${Math.round(st.avg_views)} при медиане ${Math.round(median)})`,
        meta: { lift: Math.round(lift * 100) / 100, pubs: st.pubs },
      });
    }
    out.push({ id: a.id, handle: a.handle, quality, was: num(a.quality, 60), changed, samples: st.pubs, lift: Math.round(lift * 100) / 100 });
  }
  return out;
}

/** Прогноз для очереди: что выгоднее выпускать первым */
export function rankEpisodes({ limit = 20 } = {}) {
  const rows = db.prepare(`SELECT e.*, a.quality account_quality, a.status account_status
      FROM episodes e LEFT JOIN accounts a ON a.id = e.account_id
      WHERE e.status IN ('scheduled','review') ORDER BY e.scheduled_at ASC LIMIT ?`).all(limit);
  const projects = new Map(db.prepare('SELECT * FROM projects').all().map((p) => [p.id, p]));
  return rows.map((ep) => {
    const f = forecastEpisode({
      episode: ep,
      project: projects.get(ep.project_id),
      account: ep.account_id ? { quality: ep.account_quality, status: ep.account_status } : null,
      scheduledAt: ep.scheduled_at,
    });
    return { episodeId: ep.id, title: ep.title, status: ep.status, scheduledAt: ep.scheduled_at, forecast: f };
  }).sort((a, b) => b.forecast.profit - a.forecast.profit);
}

export const forecastUtils = { median, parseJson };
