// ─────────────────────────────────────────────────────────────────────────────
// Money — сквозная юнит-экономика: клики, конверсии, доход, расход, ROI.
//
// Модель дохода честная и трёхканальная:
//   1. рекламный доход площадки — просмотры / 1000 × RPM (своя ставка для Reels
//      и TikTok, задаётся в настройках);
//   2. продажи с ролика — клики → конверсии → цена × маржа;
//   3. бренд-кампании — фикс/CPM/CPA по факту выходов (campaign_posts).
//
// Расход — себестоимость производства ролика (видео + TTS + LLM + рендер),
// сохраняется в эпизоде и раскидывается на публикации.
//
// Все цифры считаются из БД, а не «рисуются» на фронте: экран «Деньги»
// показывает ровно то, что произошло, плюс объяснение каждой метрики.
// ─────────────────────────────────────────────────────────────────────────────
import { db, getSettings, nowIso } from '../core/db.js';
import { uid, num, clamp, addDays, parseJson } from '../core/utils.js';
import { log } from '../core/logger.js';
import { PLATFORMS, PLATFORM_LABELS, PLATFORM_API_LIMITS, platformCap } from './limits.js';
import { effectiveCosts } from './costs.js';

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const hashish = (str) => {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) { h ^= String(str).charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
};

// метки площадок приходят из engine/limits.js — один источник правды
export { PLATFORM_LABELS };

export const rpmFor = (platform, settings = getSettings()) => {
  if (platform === 'tiktok') return num(settings.rpm_tiktok, 60);
  if (platform === 'youtube') return num(settings.rpm_youtube, 30);
  return num(settings.rpm_reels, 120);
};

/**
 * Демо-симулятор трафика: превращает счётчики площадок в реальные записи
 * кликов и конверсий. В live-режиме не работает — там данные приходят
 * из /t/:token (клик) и POST /api/postback (покупка).
 */
export function simulateTraffic({ onlyMissing = true, budget = 400 } = {}) {
  if ((process.env.PULSE_MODE || 'demo') === 'live') return { clicks: 0, conversions: 0 };
  const settings = getSettings();
  const ctr = num(settings.ctr_estimate, 1.2) / 100;
  const convRate = num(settings.conv_rate, 1.6) / 100;
  const price = num(settings.product_price, 2490);
  const margin = num(settings.product_margin, 0.55);

  const pubs = db.prepare("SELECT id, project_id, platform, views, clicks, url, published_at FROM publications WHERE status = 'published' AND views > 0").all();
  let addedClicks = 0;
  let addedConv = 0;
  const insClick = db.prepare('INSERT INTO clicks (id, publication_id, project_id, ts, ua, ref, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insConv = db.prepare('INSERT INTO conversions (id, click_id, publication_id, project_id, value_cents, status, ts) VALUES (?, ?, ?, ?, ?, ?, ?)');

  db.transaction(() => {
    for (const p of pubs) {
      if (addedClicks >= budget) break;
      const expected = Math.round(p.views * ctr * (0.85 + (hashish(p.id) % 30) / 100));
      const have = db.prepare('SELECT COUNT(*) n FROM clicks WHERE publication_id = ?').get(p.id).n;
      if (onlyMissing && have >= expected) continue;
      const missing = Math.max(0, Math.min(expected - have, 400, budget - addedClicks));
      const base = new Date(p.published_at || nowIso()).getTime();
      const span = Math.max(3600000, Math.min(DAY * 3, Date.now() - base));
      for (let i = 0; i < missing; i++) {
        const seed = hashish(`${p.id}:${have + i}`);
        const ts = iso(base + (seed % span));
        insClick.run(uid('cl_'), p.id, p.project_id, ts, 'demo/phone', seed % 3 === 0 ? 'feed' : 'reels', 'demo');
        addedClicks++;
      }
    }

    // конверсии: часть кликов превращается в покупку
    const candidates = db.prepare(`SELECT c.id, c.publication_id, c.project_id, c.ts
      FROM clicks c LEFT JOIN conversions v ON v.click_id = c.id
      WHERE v.id IS NULL LIMIT 20000`).all();
    for (const c of candidates) {
      const seed = hashish(`conv:${c.id}`);
      if ((seed % 10000) / 10000 >= convRate) continue;
      const value = Math.round(price * margin * 100);
      insConv.run(uid('cv_'), c.id, c.publication_id, c.project_id, value, 'paid', c.ts);
      addedConv++;
    }
  })();

  return { clicks: addedClicks, conversions: addedConv };
}

/** Фиксирует клик по короткой ссылке. Возвращает публикацию для редиректа. */
export function recordClick(token, { ua = '', ref = '', ip = '' } = {}) {
  const pub = db.prepare(`SELECT pb.*, pr.id AS product_id, pr.url AS product_link
    FROM publications pb
    LEFT JOIN episodes e ON e.id = pb.episode_id
    LEFT JOIN products pr ON pr.id = e.product_id
    WHERE pb.click_token = ?`).get(token);
  if (!pub) return null;
  const ipHash = ip ? `${hashish(ip)}`.slice(0, 10) : '';
  db.prepare('INSERT INTO clicks (id, publication_id, project_id, ts, ua, ref, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uid('cl_'), pub.id, pub.project_id, nowIso(), String(ua).slice(0, 180), String(ref).slice(0, 180), ipHash);
  db.prepare('UPDATE publications SET clicks = clicks + 1 WHERE id = ?').run(pub.id);
  return pub;
}

/** Postback из CPA-сети / платёжки: покупка по клику или по токену публикации. */
export function recordConversion({ clickId, token, value, status = 'paid', externalId = null }) {
  let click = null;
  if (clickId) click = db.prepare('SELECT * FROM clicks WHERE id = ?').get(clickId);
  if (!click && token) {
    const pub = db.prepare('SELECT * FROM publications WHERE click_token = ?').get(token);
    if (pub) click = db.prepare('SELECT * FROM clicks WHERE publication_id = ? ORDER BY ts DESC LIMIT 1').get(pub.id);
  }
  if (!click) return null;
  if (externalId) {
    const dup = db.prepare('SELECT * FROM conversions WHERE external_id = ?').get(externalId);
    if (dup) return dup; // идемпотентность postback-ов
  }
  const settings = getSettings();
  const amount = value != null
    ? Math.round(num(value, 0) * 100)
    : Math.round(num(settings.product_price, 2490) * num(settings.product_margin, 0.55) * 100);
  const id = uid('cv_');
  db.prepare('INSERT INTO conversions (id, click_id, publication_id, project_id, value_cents, status, ts, external_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, click.id, click.publication_id, click.project_id, amount, status, nowIso(), externalId);
  log({ level: 'success', actor: 'postback', action: 'conversion', entityType: 'publication', entityId: click.publication_id, message: `Конверсия: ${(amount / 100).toFixed(0)} ₽`, meta: { clickId: click.id, status } });
  return { id, value_cents: amount, publication_id: click.publication_id };
}

/** Сводка по деньгам за период. */
export function moneySummary({ days = 30, projectId = null } = {}) {
  const settings = getSettings();
  const currency = settings.currency || '₽';
  const since = addDays(nowIso(), -days);
  const filter = projectId ? 'AND pb.project_id = ?' : '';
  const params = projectId ? [projectId] : [];

  // «за 30 дней» — это ровно 30 дней. Раньше фильтра по дате не было вовсе и
  // окно показывало всю историю. Берём ролики, вышедшие в периоде, и те, что
  // набрали просмотры/клики/конверсии именно в этом периоде, — иначе старые
  // ролики, которые продолжают работать, выпадали бы из отчёта.
  const pubs = db.prepare(`SELECT pb.*, e.cost_cents episode_cost, pj.name project_name
    FROM publications pb
    LEFT JOIN episodes e ON e.id = pb.episode_id
    LEFT JOIN projects pj ON pj.id = pb.project_id
    WHERE pb.status = 'published' AND (
      pb.published_at >= ?
      OR EXISTS (SELECT 1 FROM metrics_daily md WHERE md.publication_id = pb.id AND md.day >= ?)
      OR EXISTS (SELECT 1 FROM clicks c WHERE c.publication_id = pb.id AND c.ts >= ?)
      OR EXISTS (SELECT 1 FROM conversions v WHERE v.publication_id = pb.id AND v.ts >= ?)
    ) ${filter}`).all(since, since.slice(0, 10), since, since, ...params);

  // просмотры за период берём из metrics_daily, чтобы окно было честным
  const viewsByPub = new Map(db.prepare(`SELECT md.publication_id, SUM(md.views) v
    FROM metrics_daily md JOIN publications pb ON pb.id = md.publication_id
    WHERE md.day >= ? ${filter} GROUP BY md.publication_id`).all(since.slice(0, 10), ...params)
    .map((r) => [r.publication_id, r.v]));

  const clicksByPub = new Map(db.prepare(`SELECT c.publication_id, COUNT(*) n FROM clicks c
    LEFT JOIN publications pb ON pb.id = c.publication_id
    WHERE c.ts >= ? ${filter} GROUP BY c.publication_id`).all(since, ...params).map((r) => [r.publication_id, r.n]));

  // спонсорские деньги: фактические начисления по выходам кампаний
  const sponsorByPub = new Map(db.prepare(`SELECT cp.publication_id pid, SUM(cp.revenue_cents) s
    FROM campaign_posts cp
    JOIN publications pb ON pb.id = cp.publication_id
    WHERE cp.publication_id IS NOT NULL AND pb.published_at >= ? ${filter}
    GROUP BY cp.publication_id`).all(since, ...params).map((r) => [r.pid, r.s || 0]));

  const convByPub = new Map(db.prepare(`SELECT v.publication_id, COUNT(*) n, SUM(v.value_cents) s FROM conversions v
    LEFT JOIN publications pb ON pb.id = v.publication_id
    WHERE v.ts >= ? ${filter} GROUP BY v.publication_id`).all(since, ...params).map((r) => [r.publication_id, r]));

  const perProject = new Map();
  const perPlatform = new Map();
  const perPub = [];
  let revenueAds = 0; let revenueConv = 0; let revenueSponsor = 0; let cost = 0; let views = 0; let clicks = 0; let conversions = 0;

  for (const p of pubs) {
    const v = viewsByPub.get(p.id) || 0;
    const c = clicksByPub.get(p.id) || 0;
    const cv = convByPub.get(p.id) || { n: 0, s: 0 };
    const adsCents = Math.round((v / 1000) * rpmFor(p.platform, settings) * 100);
    const convCents = cv.s || 0;
    const sponsorCents = sponsorByPub.get(p.id) || 0;
    // себестоимость уже разложена по публикациям (A/B делит её пополам).
    // Ролик, вышедший до окна, не съел бюджет этого периода — не приписываем.
    const inPeriod = String(p.published_at || '') >= since;
    const costCents = inPeriod ? (p.cost_cents || p.episode_cost || 0) : 0;

    views += v; clicks += c; conversions += cv.n;
    revenueAds += adsCents; revenueConv += convCents; revenueSponsor += sponsorCents; cost += costCents;

    const bucket = (map, key, name) => {
      const cur = map.get(key) || { id: key, name, views: 0, clicks: 0, conversions: 0, revenue: 0, cost: 0, publications: 0, sponsor: 0 };
      cur.views += v; cur.clicks += c; cur.conversions += cv.n;
      cur.revenue += adsCents + convCents + sponsorCents; cur.cost += costCents; cur.publications += 1;
      cur.sponsor += sponsorCents;
      map.set(key, cur);
    };
    bucket(perProject, p.project_id, p.project_name || 'Проект');
    bucket(perPlatform, p.platform, PLATFORM_LABELS[p.platform] || p.platform);

    if (v > 0) {
      perPub.push({
        id: p.id, episodeId: p.episode_id, title: p.title, platform: p.platform, privacy: p.privacy,
        views: v, clicks: c, conversions: cv.n,
        revenue: (adsCents + convCents + sponsorCents) / 100,
        sponsor: sponsorCents / 100,
        cost: costCents / 100,
        profit: (adsCents + convCents + sponsorCents - costCents) / 100,
        rpm: v > 0 ? Number(((adsCents / 100) / (v / 1000)).toFixed(2)) : 0,
        ctr: v > 0 ? Number(((c / v) * 100).toFixed(2)) : 0,
        epc: c > 0 ? Number(((convCents / 100) / c).toFixed(2)) : 0,
        publishedAt: p.published_at,
      });
    }
  }

  // дневной ряд
  const seriesRows = db.prepare(`SELECT md.day, SUM(md.views) views FROM metrics_daily md
    JOIN publications pb ON pb.id = md.publication_id
    WHERE md.day >= ? ${filter} GROUP BY md.day ORDER BY md.day`).all(since.slice(0, 10), ...params);
  const convRows = db.prepare(`SELECT substr(v.ts,1,10) day, COUNT(*) n, SUM(v.value_cents) s FROM conversions v
    JOIN publications pb ON pb.id = v.publication_id
    WHERE v.ts >= ? ${filter} GROUP BY day`).all(since, ...params);
  const convMap = new Map(convRows.map((r) => [r.day, r]));
  const series = seriesRows.map((r) => {
    const cRow = convMap.get(r.day) || { n: 0, s: 0 };
    return {
      day: r.day,
      label: r.day.slice(5).replace('-', '.'),
      views: r.views,
      ads: Math.round((r.views / 1000) * num(settings.rpm_reels, 120) * 100) / 100,
      conversions: cRow.n,
      convRevenue: (cRow.s || 0) / 100,
    };
  });

  const revenue = (revenueAds + revenueConv + revenueSponsor) / 100;
  const costTotal = cost / 100;
  const profit = revenue - costTotal;
  const roi = costTotal > 0 ? Number(((profit / costTotal) * 100).toFixed(1)) : null;
  const sorted = perPub.sort((a, b) => b.profit - a.profit);

  return {
    currency,
    days,
    totals: {
      views,
      clicks,
      conversions,
      revenue: round2(revenue),
      revenueAds: round2(revenueAds / 100),
      revenueConv: round2(revenueConv / 100),
      revenueSponsor: round2(revenueSponsor / 100),
      cost: round2(costTotal),
      profit: round2(profit),
      roi,
      marginPct: revenue > 0 ? round2((profit / revenue) * 100) : 0,
      rpmAvg: views > 0 ? round2((revenueAds / 100) / (views / 1000)) : 0,
      ctr: views > 0 ? round2((clicks / views) * 100) : 0,
      cr: clicks > 0 ? round2((conversions / clicks) * 100) : 0,
      epc: clicks > 0 ? round2((revenueConv / 100) / clicks) : 0,
      profitPerVideo: perPub.length ? round2(profit / perPub.length) : 0,
      costPerVideo: perPub.length ? round2(costTotal / perPub.length) : 0,
    },
    byProject: [...perProject.values()].map(finishBucket).sort((a, b) => b.profit - a.profit),
    byPlatform: [...perPlatform.values()].map(finishBucket).sort((a, b) => b.profit - a.profit),
    top: sorted.slice(0, 8),
    worst: sorted.slice(-5).reverse(),
    series,
    // Сериалы живут отдельно от publications: у них своя ставка RPM и своя
    // экономика. Показываем их рядом, чтобы «Деньги» были одной картиной.
    longform: (() => {
      const rows = db.prepare(`SELECT e.id, e.title, e.episode_no, e.views, e.rpm, e.revenue_cents, e.cost_cents,
          e.duration_sec, e.published_at, s.title series_title, s.id series_id
        FROM series_episodes e JOIN series s ON s.id = e.series_id
        WHERE e.stage = 'published'`).all();
      const revenue = rows.reduce((a, r) => a + (r.revenue_cents || 0), 0) / 100;
      const cost = rows.reduce((a, r) => a + (r.cost_cents || 0), 0) / 100;
      const viewsLong = rows.reduce((a, r) => a + (r.views || 0), 0);
      const watchHours = rows.reduce((a, r) => a + ((r.views || 0) * ((r.duration_sec || 0) / 60) * 0.4) / 60, 0);
      return {
        episodes: rows.length,
        views: viewsLong,
        revenue: round2(revenue),
        cost: round2(cost),
        profit: round2(revenue - cost),
        watchHours: Math.round(watchHours),
        rpmAvg: viewsLong > 0 ? round2(revenue / (viewsLong / 1000)) : 0,
        hoursToMonetization: Math.max(0, Math.round(4000 - watchHours)),
        top: rows
          .sort((a, b) => (b.revenue_cents || 0) - (a.revenue_cents || 0))
          .slice(0, 5)
          .map((r) => ({
            id: r.id, seriesId: r.series_id, series: r.series_title, title: r.title,
            episodeNo: r.episode_no, views: r.views || 0, minutes: Math.round((r.duration_sec || 0) / 60),
            revenue: round2((r.revenue_cents || 0) / 100), rpm: round2(r.rpm || 0),
          })),
        note: 'Длинные серии: включают мид-роллы, поэтому RPM выше Shorts того же канала в 2–3 раза.',
      };
    })(),
    sponsor: (() => {
      const rows = db.prepare(`SELECT c.id, c.name, c.model, b.name brand, c.budget_cents, c.paid_cents,
          COALESCE(SUM(cp.revenue_cents),0) revenue, COUNT(cp.id) posts
        FROM campaigns c JOIN brands b ON b.id = c.brand_id
        LEFT JOIN campaign_posts cp ON cp.campaign_id = c.id
          AND cp.created_at >= ?
        GROUP BY c.id ORDER BY revenue DESC`).all(since);
      return rows.map((r) => ({
        id: r.id, name: r.name, brand: r.brand, model: r.model,
        revenue: round2((r.revenue || 0) / 100),
        paid: round2((r.paid_cents || 0) / 100),
        budget: round2((r.budget_cents || 0) / 100),
        posts: r.posts || 0,
      }));
    })(),
    assumptions: {
      rpmReels: num(settings.rpm_reels, 120),
      rpmTiktok: num(settings.rpm_tiktok, 60),
      rpmYoutube: num(settings.rpm_youtube, 30),
      convRate: num(settings.conv_rate, 1.6),
      price: num(settings.product_price, 2490),
      margin: num(settings.product_margin, 0.55),
      costPerVideo: round2(effectiveCosts().perVideo),
      costNote: effectiveCosts().note,
      note: 'RPM — доход площадки за 1000 просмотров; конверсии — по фактическим покупкам из postback; бренд-кампании — по факту выходов (фикс/CPM/CPA). Расход — себестоимость производства, без учёта времени.',
    },
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

function finishBucket(b) {
  const revenue = b.revenue / 100;
  const cost = b.cost / 100;
  return {
    ...b,
    revenue: round2(revenue),
    cost: round2(cost),
    profit: round2(revenue - cost),
    roi: cost > 0 ? round2(((revenue - cost) / cost) * 100) : null,
    ctr: b.views > 0 ? round2((b.clicks / b.views) * 100) : 0,
    cr: b.clicks > 0 ? round2((b.conversions / b.clicks) * 100) : 0,
    rpm: b.views > 0 ? round2((b.revenue / 100) / (b.views / 1000)) : 0,
  };
}

/**
 * Прозрачность: что система сделала сама, что ждёт человека и почему.
 * Это ответ на «всё прозрачно» — каждый шаг с причиной и ссылкой на данные.
 */
export function transparency() {
  const settings = getSettings();
  const now = nowIso();
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM episodes GROUP BY status').all().map((r) => [r.status, r.n]));
  // только реальные блокировки: пустой отчёт `{}` и отчёты с ok=true сюда не попадают
  const blocked = db.prepare(`SELECT id, title, compliance, viral FROM episodes
    WHERE compliance IS NOT NULL
      AND json_valid(compliance)
      AND json_extract(compliance, '$.ok') = 0
    ORDER BY updated_at DESC LIMIT 6`).all();
  const lowViral = db.prepare(`SELECT id, title, viral, viral_meta FROM episodes
    WHERE viral > 0 AND viral < ? ORDER BY viral ASC LIMIT 6`).all(num(settings.min_viral_score, 45));
  const failed = db.prepare("SELECT id, title, error, stage FROM episodes WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 5").all();
  const media = db.prepare("SELECT COUNT(*) n, SUM(video_bytes) bytes, SUM(render_ms) ms FROM episodes WHERE video_bytes > 0").get();
  const quotas = PLATFORMS.map((platform) => {
    const since = addDays(nowIso(), -1);
    const used = db.prepare("SELECT COUNT(*) n FROM publications WHERE platform = ? AND published_at > ? AND status = 'published'").get(platform, since).n;
    const cap = platformCap(platform, settings);
    return {
      platform, label: PLATFORM_LABELS[platform], used, cap, left: Math.max(0, cap - used),
      window: 'скользящие 24 ч', apiLimit: PLATFORM_API_LIMITS[platform].per24h, apiNote: PLATFORM_API_LIMITS[platform].note,
    };
  });

  const checks = [
    {
      id: 'api-limits', label: 'Лимиты API площадок', state: quotas.every((q) => q.left > 0) ? 'ok' : 'warn',
      detail: quotas.map((q) => `${q.platform}: ${q.used}/${q.cap} за 24 ч`).join(' · '),
    },
    {
      id: 'tiktok-audit', label: 'Аудит TikTok-клиента', state: Number(settings.tiktok_audited) === 1 ? 'ok' : 'warn',
      detail: Number(settings.tiktok_audited) === 1
        ? 'Клиент аудирован: публичный постинг разрешён'
        : 'Неаудированный клиент: публикуем только приватно (SELF_ONLY), максимум 5 аккаунтов/24 ч',
    },
    {
      id: 'youtube-audit', label: 'Публичность YouTube',
      state: Number(settings.youtube_audited) === 1 ? 'ok' : 'warn',
      detail: Number(settings.youtube_audited) === 1
        ? 'Проект Google прошёл аудит: Shorts публикуются публично'
        : 'Без аудита Google загрузки только приватные — включите после проверки проекта',
    },
    {
      id: 'labels', label: 'Маркировка AI и рекламы', state: Number(settings.ai_label) === 1 && Number(settings.ad_label) === 1 ? 'ok' : 'warn',
      detail: `AI: ${Number(settings.ai_label) === 1 ? 'включена' : 'выключена'} · реклама: ${Number(settings.ad_label) === 1 ? 'включена' : 'выключена'}`,
    },
    {
      id: 'review', label: 'Ручная проверка риска', state: 'ok',
      detail: `Порог риска ${settings.risk_threshold}/100 и вирусного скора ${settings.min_viral_score}/100 — ниже уходит в проверку`,
    },
    {
      id: 'ads-marking', label: 'Маркировка бренд-кампаний',
      state: (() => {
        const risky = db.prepare(`SELECT COUNT(*) n FROM campaigns WHERE status = 'active' AND marking = 'erid' AND (erid IS NULL OR erid = '')`).get().n;
        return risky === 0 ? 'ok' : 'warn';
      })(),
      detail: (() => {
        const row = db.prepare(`SELECT COUNT(*) n FROM campaigns WHERE status = 'active' AND marking = 'erid' AND (erid IS NULL OR erid = '')`).get();
        const total = db.prepare("SELECT COUNT(*) n FROM campaigns WHERE status = 'active'").get().n;
        return row.n === 0
          ? `Активных кампаний: ${total}. У всех есть пометка «Реклама» и erid в описании`
          : `${row.n} активных кампаний без erid — публикация с ними блокируется`;
      })(),
    },
    {
      id: 'render', label: 'Рендер файлов',
      // пустой архив — это ещё не проблема: на свежей базе роликов просто нет.
      // Тревога уместна, когда ролики уже должны быть, а файлов нет.
      state: media.n > 0 ? 'ok' : (counts.review || counts.scheduled || counts.published ? 'warn' : 'info'),
      detail: media.n
        ? `${media.n} роликов, ${((media.bytes || 0) / 1048576).toFixed(1)} МБ, среднее ${Math.round((media.ms || 0) / media.n / 100) / 10} с на ролик`
        : 'Файлов пока нет — появятся после первого рендера',
    },
    {
      id: 'storage', label: 'Хранение данных', state: 'ok',
      detail: 'SQLite в Docker-томе data/, медиа в data/media, бэкап — копия каталога',
    },
  ];

  return {
    generated_at: now,
    checks,
    quotas,
    pipeline: counts,
    blocked: blocked.map((b) => ({ id: b.id, title: b.title, compliance: parseJson(b.compliance, {}), viral: b.viral })),
    lowViral: lowViral.map((v) => ({ id: v.id, title: v.title, viral: v.viral, advice: parseJson(v.viral_meta, {}).advice || [] })),
    failed,
    media: { count: media.n, bytes: media.bytes || 0, avgRenderSec: media.n ? Math.round((media.ms || 0) / media.n / 100) / 10 : 0 },
  };
}
