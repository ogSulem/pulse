// ─────────────────────────────────────────────────────────────────────────────
// Growth Engine — «чтобы залетало»: портфель аккаунтов, темп, хуки, удержание
// и путь к монетизации. Всё считается из своих же данных, без магии.
//
// Источники правил (проверены в 2026):
//   • TikTok — решение о свайпе ~1.3 с, главный сигнал — досмотр и пересмотры,
//     рабочий диапазон 45–90 с; Creator Rewards платит только за видео > 60 с
//     и только в 8 странах (РФ в список не входит);
//   • YouTube Shorts — окно ~2 с, главный сигнал — «не свайпнули» + досмотр,
//     оптимум 22–45 с, completion ≈65% для <30 с и ≈50% для 30–60 с,
//     отдельная квота videos.insert (100 загрузок/сутки) и отдельный порог YPP;
//   • Instagram Reels — сохраняения и шеры весят больше лайков, окно ~1.3 с,
//     оптимум 20–45 с, лимит публикаций через API — 50 в скользящие 24 ч.
// ─────────────────────────────────────────────────────────────────────────────
import { db, getSettings, nowIso } from '../core/db.js';
import { addDays, clamp, num, parseJson } from '../core/utils.js';
import { scoreViral } from './viral.js';
import { forecastEpisode, baselineViews } from './forecast.js';
import { checkCompliance, PLATFORM_RULES } from './compliance.js';
import { adsOverview } from './ads.js';
import { moneySummary, rpmFor } from './money.js';
import { platformQuota } from './pipeline.js';
import { PLATFORMS, PLATFORM_LABELS, PLATFORM_API_LIMITS } from './limits.js';
import { bestHours } from './schedule.js';
import { generateIdeas } from './brain.js';

const DAY = 86400000;

export const PLATFORM_PLAYBOOK = {
  tiktok: {
    label: 'TikTok',
    hookWindowSec: 1.3,
    idealSec: [45, 90],
    monetizableSec: 61,
    completionTarget: 0.55,
    retentionBench: 'досмотр > 55% и пересмотры',
    postsPerWeek: [7, 21],
    signals: ['досмотр до конца', 'пересмотры', 'сохранения', 'шеры'],
    caption: 'Ниша + 3–5 тегов, CTA «сохрани», ссылка в профиле',
    notes: [
      'Алгоритм читает удержание раньше лайков: первые 1.3 с решают, попадёт ли ролик в следующую волну.',
      'Видео > 60 с нужно не «для алгоритма», а для Creator Rewards — но только в странах программы.',
      'Ссылки в описании не кликабельны: трафик ведём через профиль и закреплённый комментарий.',
    ],
  },
  reels: {
    label: 'Instagram Reels',
    hookWindowSec: 1.3,
    idealSec: [20, 45],
    monetizableSec: 0,
    completionTarget: 0.6,
    retentionBench: 'досмотр > 60% + сохранения',
    postsPerWeek: [5, 14],
    signals: ['сохранения', 'шеры в сторис', 'досмотры', 'подписки'],
    caption: 'Ссылка в описании кликабельна, UTM обязателен',
    notes: [
      'Сохранения и шеры весят больше лайков — поэтому в CTA просим сохранить, а не лайкнуть.',
      'Оптимум 20–45 с: длиннее — падает досмотр, короче — не хватает времени на смысл.',
      'API-лимит 50 публикаций в скользящие 24 ч, поэтому темп держим ниже.',
    ],
  },
  youtube: {
    label: 'YouTube Shorts',
    hookWindowSec: 2.1,
    idealSec: [22, 45],
    monetizableSec: 0,
    completionTarget: 0.65,
    retentionBench: 'досмотр 65% (<30 с) / 50% (30–60 с)',
    postsPerWeek: [3, 10],
    signals: ['swipe-away < 40%', 'досмотр', 'пересмотры (loop)', 'шеры', 'скорость первых 2 часов'],
    caption: 'Заголовок ≤ 100 символов, описание ≤ 5000 байт, 3–5 тегов',
    notes: [
      'Отдельного Shorts API нет: вертикальное видео ≤ 3 минут классифицируется само.',
      'Первые 2 часа — «окно скорости»: публикуем в пик аудитории, а не когда удобно автопилоту.',
      'Пересмотры (loop) сильно влияют на охват: последняя фраза должна возвращать к первой.',
      'Shorts-просмотры не идут в 4000 часов YPP — у Shorts свой порог 3 млн / 10 млн за 90 дней.',
    ],
  },
};

const median = (arr) => {
  const a = arr.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const round1 = (n) => Math.round(n * 10) / 10;
const pctOf = (value, target) => (target > 0 ? clamp(Math.round((value / target) * 100), 0, 100) : 100);

// ── Портфель аккаунтов ───────────────────────────────────────────────────────
/**
 * Что происходит с каждым аккаунтом: подписчики, охват, удержание, темп,
 * остаток квоты и одно конкретное следующее действие.
 */
export function portfolio() {
  const settings = getSettings();
  const since30 = addDays(nowIso(), -30);
  const since7 = addDays(nowIso(), -7);
  const accounts = db.prepare(`SELECT a.*, p.name AS project_name FROM accounts a
      LEFT JOIN projects p ON p.id = a.project_id ORDER BY a.platform, a.quality DESC`).all();
  const today = nowIso().slice(0, 10);

  const rows = accounts.map((a) => {
    const agg = db.prepare(`SELECT COUNT(*) posts, COALESCE(SUM(views),0) views,
        COALESCE(SUM(followers),0) followers, COALESCE(AVG(watch_avg),0) retention,
        COALESCE(AVG(views),0) avg_views, MAX(published_at) last_at
      FROM publications WHERE account_id = ? AND status = 'published' AND published_at >= ?`).get(a.id, since30);
    const week = db.prepare(`SELECT COUNT(*) posts, COALESCE(SUM(views),0) views
      FROM publications WHERE account_id = ? AND status = 'published' AND published_at >= ?`).get(a.id, since7);
    const usedToday = db.prepare('SELECT used FROM accounts_daily WHERE account_id = ? AND day = ?').get(a.id, today)?.used || 0;
    const playbook = PLATFORM_PLAYBOOK[a.platform] || PLATFORM_PLAYBOOK.reels;
    const followers = num(a.followers, 0);
    // деньги аккаунта за 30 дней: показы по RPM + продажи по его публикациям + спонсорские выходы
    const conv = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(v.value_cents),0) s FROM conversions v
        JOIN publications pb ON pb.id = v.publication_id
        WHERE pb.account_id = ? AND v.ts >= ?`).get(a.id, since30);
    const sponsor = db.prepare(`SELECT COALESCE(SUM(cp.revenue_cents),0) s FROM campaign_posts cp
        JOIN publications pb ON pb.id = cp.publication_id
        WHERE pb.account_id = ? AND pb.published_at >= ?`).get(a.id, since30).s || 0;
    const revenueAds = (num(agg.views, 0) / 1000) * rpmFor(a.platform, settings);
    const revenue = Math.round((revenueAds + conv.s / 100 + sponsor / 100) * 100) / 100;
    const retention = round1(agg.retention || 0);
    const consistency = clamp(Math.round((week.posts / Math.max(1, playbook.postsPerWeek[0])) * 100), 0, 100);

    // health 0..100: статус, качество, удержание против бенчмарка, регулярность
    const statusScore = a.status === 'healthy' ? 100 : a.status === 'warmup' ? 70 : a.status === 'cooldown' ? 40 : 0;
    const retentionScore = retention > 0 ? clamp((retention / (playbook.completionTarget * 100)) * 100, 0, 100) : 55;
    const health = Math.round(statusScore * 0.3 + clamp(num(a.quality, 70), 0, 100) * 0.3 + retentionScore * 0.25 + consistency * 0.15);

    let nextAction;
    if (a.status === 'blocked') nextAction = { tone: 'danger', text: 'Проверить ограничения и не публиковать', action: 'review' };
    else if (a.status === 'cooldown') nextAction = { tone: 'warn', text: `Дать отдых до ${a.blocked_until ? new Date(a.blocked_until).toLocaleDateString('ru-RU') : 'суток'}`, action: 'rest' };
    else if (a.status === 'warmup') nextAction = { tone: 'accent', text: 'Прогрев: 1 публикация в день с интервалом 4+ часа', action: 'warmup' };
    else if (usedToday >= num(a.daily_limit, 3)) nextAction = { tone: 'muted', text: 'Квота на сегодня выбрана — ждём окно', action: 'wait' };
    else if (retention > 0 && retention < playbook.completionTarget * 100 * 0.85) nextAction = { tone: 'warn', text: `Удержание ${retention}% ниже нормы ${Math.round(playbook.completionTarget * 100)}% — менять хуки`, action: 'hooks' };
    else nextAction = { tone: 'success', text: 'Продолжать темп и тестировать новый хук', action: 'scale' };

    return {
      id: a.id, platform: a.platform, platformLabel: playbook.label,
      handle: a.handle, displayName: a.display_name, status: a.status, quality: num(a.quality, 70),
      followers, followersFromContent: num(agg.followers, 0),
      views30: num(agg.views, 0), posts30: num(agg.posts, 0), views7: num(week.views, 0), posts7: num(week.posts, 0),
      avgViews: Math.round(num(agg.avg_views, 0)), retention,
      retentionTarget: Math.round(playbook.completionTarget * 100),
      dailyLimit: num(a.daily_limit, 3), usedToday, leftToday: Math.max(0, num(a.daily_limit, 3) - usedToday),
      minGapMin: num(a.min_gap_min, 90), window: `${a.window_start}–${a.window_end}`,
      lastAt: agg.last_at, health, consistency, nextAction,
      revenue, revenueAds: Math.round(revenueAds * 100) / 100, revenueSales: Math.round((conv.s / 100) * 100) / 100,
      revenueSponsor: Math.round((sponsor / 100) * 100) / 100, conversions: conv.n,
      rpm: num(agg.views, 0) > 0 ? Math.round((revenueAds / (num(agg.views, 0) / 1000)) * 100) / 100 : 0,
      profitPerPost: num(agg.posts, 0) > 0 ? Math.round((revenue / num(agg.posts, 0)) * 100) / 100 : 0,
      connected: Boolean(a.access_token),
      externalId: a.external_id || null,
      projectId: a.project_id || null,
      projectName: a.project_name || null,
    };
  });

  const active = rows.filter((r) => r.status === 'healthy' || r.status === 'warmup');
  const byPlatform = ['reels', 'tiktok', 'youtube'].map((platform) => {
    const list = rows.filter((r) => r.platform === platform);
    if (!list.length) return null;
    const playbook = PLATFORM_PLAYBOOK[platform];
    return {
      platform, label: playbook.label,
      accounts: list.length,
      healthy: list.filter((r) => r.status === 'healthy').length,
      followers: list.reduce((s, r) => s + r.followers, 0),
      views30: list.reduce((s, r) => s + r.views30, 0),
      capacity: list.filter((r) => r.status === 'healthy' || r.status === 'warmup').reduce((s, r) => s + Math.max(0, r.dailyLimit - r.usedToday), 0),
      retention: round1(median(list.map((r) => r.retention).filter(Boolean))),
      retentionTarget: Math.round(playbook.completionTarget * 100),
      idealSec: playbook.idealSec,
      revenue: Math.round(list.reduce((s, r) => s + r.revenue, 0) * 100) / 100,
      revenueAds: Math.round(list.reduce((s, r) => s + r.revenueAds, 0) * 100) / 100,
      revenueSales: Math.round(list.reduce((s, r) => s + r.revenueSales, 0) * 100) / 100,
      revenueSponsor: Math.round(list.reduce((s, r) => s + r.revenueSponsor, 0) * 100) / 100,
      profitPerPost: (() => {
        const posts = list.reduce((s, r) => s + r.posts30, 0);
        return posts ? Math.round((list.reduce((s, r) => s + r.revenue, 0) / posts) * 100) / 100 : 0;
      })(),
    };
  }).filter(Boolean);

  const totalFollowers = rows.reduce((s, r) => s + r.followers, 0);
  const views30 = rows.reduce((s, r) => s + r.views30, 0);
  const views7 = rows.reduce((s, r) => s + r.views7, 0);
  const posts7 = rows.reduce((s, r) => s + r.posts7, 0);
  const capacityPerDay = active.reduce((s, r) => s + Math.max(0, r.dailyLimit - r.usedToday), 0);
  const demandPerDay = db.prepare('SELECT COALESCE(SUM(posts_per_day),0) d FROM projects WHERE archived = 0 AND autopilot = 1').get().d || 0;

  return {
    updatedAt: nowIso(),
    accounts: rows,
    platforms: byPlatform,
    totals: {
      accounts: rows.length,
      active: active.length,
      attention: rows.filter((r) => r.health < 60).length,
      followers: totalFollowers,
      views30, views7, posts7,
      avgRetention: round1(median(rows.map((r) => r.retention).filter(Boolean))),
      revenue: Math.round(rows.reduce((s, r) => s + r.revenue, 0) * 100) / 100,
      revenueAds: Math.round(rows.reduce((s, r) => s + r.revenueAds, 0) * 100) / 100,
      revenueSales: Math.round(rows.reduce((s, r) => s + r.revenueSales, 0) * 100) / 100,
      revenueSponsor: Math.round(rows.reduce((s, r) => s + r.revenueSponsor, 0) * 100) / 100,
      bestAccount: rows.slice().sort((x, y) => y.revenue - x.revenue)[0]?.handle || null,
      bestPlatform: byPlatform.slice().sort((x, y) => y.revenue - x.revenue)[0]?.label || null,
      capacityPerDay,
      demandPerDay: num(demandPerDay, 0),
      // сколько роликов ещё можно выпустить сегодня, не выходя за квоты
      headroom: Math.max(0, capacityPerDay - Math.min(num(demandPerDay, 0), capacityPerDay)),
    },
    settings: {
      maxDailyPerAccount: num(settings.max_daily_per_account, 3),
      autopilot: Number(settings.autopilot_global) === 1,
    },
  };
}

// ── План ведения аккаунта ────────────────────────────────────────────────────
/**
 * Конкретный план: фаза, правила, недельная лестница темпа и темы.
 * Никаких «постим чаще» — только проверяемые шаги.
 */
export function accountPlaybook(accountId) {
  const a = db.prepare(`SELECT a.*, p.name AS project_name FROM accounts a
      LEFT JOIN projects p ON p.id = a.project_id WHERE a.id = ?`).get(accountId);
  if (!a) return null;
  const pb = PLATFORM_PLAYBOOK[a.platform] || PLATFORM_PLAYBOOK.reels;
  const posts30 = db.prepare("SELECT COUNT(*) n FROM publications WHERE account_id = ? AND status = 'published' AND published_at > ?").get(a.id, addDays(nowIso(), -30)).n;
  const avgViews = db.prepare("SELECT COALESCE(AVG(views),0) v FROM publications WHERE account_id = ? AND status = 'published' AND published_at > ?").get(a.id, addDays(nowIso(), -30)).v;
  const last = db.prepare('SELECT MAX(published_at) t FROM publications WHERE account_id = ?').get(a.id)?.t;
  const daysIdle = last ? Math.floor((Date.now() - new Date(last).getTime()) / DAY) : 999;

  let phase = 'growth';
  let phaseLabel = 'Рост';
  if (a.status === 'blocked' || a.status === 'cooldown') { phase = 'recovery'; phaseLabel = 'Восстановление'; }
  else if (a.status === 'warmup') { phase = 'warmup'; phaseLabel = 'Прогрев'; }
  else if (a.quality >= 85 && avgViews > baselineViews(null, a.platform)) { phase = 'scale'; phaseLabel = 'Масштабирование'; }

  const base = num(a.daily_limit, 3);
  const ramp = [];
  if (phase === 'warmup') {
    ramp.push({ day: 1, posts: 1, why: 'Первый день — один пост в пик аудитории, чтобы алгоритм понял нишу' });
    ramp.push({ day: 2, posts: 1, why: 'Интервал 24 ч: аккаунт не должен выглядеть как бот' });
    ramp.push({ day: 3, posts: 2, why: 'Второй пост вечером — проверяем, растёт ли медиана охвата' });
    ramp.push({ day: 5, posts: 2, why: 'Если удержание ≥ нормы — закрепляем два слота' });
    ramp.push({ day: 7, posts: Math.min(3, base), why: 'Выходим на целевой темп площадки' });
  } else if (phase === 'recovery') {
    ramp.push({ day: 1, posts: 0, why: 'Полная пауза: не публикуем в кулдаун' });
    ramp.push({ day: 2, posts: 1, why: 'Проверяем, снят ли запрет: один безопасный пост' });
    ramp.push({ day: 4, posts: 1, why: 'Держим низкий темп, пока не вернётся охват' });
    ramp.push({ day: 7, posts: Math.min(2, base), why: 'Возвращаемся к обычному темпу только при нормальном удержании' });
  } else {
    ramp.push({ day: 1, posts: Math.max(1, Math.min(base, 2)), why: 'Два слота: утро/вечер — тестируем разные аудитории' });
    ramp.push({ day: 3, posts: Math.min(base, 3), why: 'Добавляем третий слот только если удержание держится' });
    ramp.push({ day: 5, posts: Math.min(base, 3), why: 'Один слот отдаём формату-победителю, один — эксперименту' });
    ramp.push({ day: 7, posts: Math.min(base, 3), why: 'Раз в неделю — новый хук, остальное повторяем' });
  }

  const rules = [
    'Внутри одной площадки ролик выходит с одного аккаунта: один и тот же пост с двух аккаунтов площадка читает как спам. На разные площадки — можно и нужно.',
    `Между публикациями на этом аккаунте не меньше ${num(a.min_gap_min, 90)} минут.`,
    `Публикуем только в окне ${a.window_start}–${a.window_end} (${a.timezone}).`,
    'Свой текст для каждого аккаунта: подпись, обложка и хештеги не копируются 1:1.',
    `Хуки — в первые ${pb.hookWindowSec} с, иначе алгоритм не даёт следующую волну.`,
    `Длительность держим в диапазоне ${pb.idealSec[0]}–${pb.idealSec[1]} с (${pb.retentionBench}).`,
    '80% пользы / 20% продажи: иначе падает досмотр и площадка срезает охват.',
    'Первые 60 минут после публикации — отвечаем на комментарии: это сигнал обсуждения.',
    'Раз в неделю разбираем, какой хук дал лучший досмотр, и переносим его в новые ролики.',
  ];

  const issues = [];
  if (daysIdle > 3) issues.push({ tone: 'warn', text: `Аккаунт молчит ${daysIdle} дн. — регулярность важнее количества: верните 1 пост в день` });
  if (posts30 < pb.postsPerWeek[0] * 4) issues.push({ tone: 'warn', text: `За 30 дней всего ${posts30} постов — площадка хуже понимает нишу` });
  if (avgViews > 0 && avgViews < baselineViews(null, a.platform) * 0.7) issues.push({ tone: 'warn', text: 'Средний охват ниже медианы проекта: меняем хуки и обложки, а не увеличиваем частоту' });
  if (a.status === 'healthy' && num(a.daily_limit, 3) < Math.ceil(pb.postsPerWeek[0] / 7)) issues.push({ tone: 'muted', text: 'Темп ниже рекомендованного диапазона — можно добавить один слот' });

  return {
    account: {
      id: a.id, handle: a.handle, platform: a.platform, platformLabel: pb.label, status: a.status,
      followers: num(a.followers, 0), projectId: a.project_id || null, projectName: a.project_name || null,
    },
    phase, phaseLabel,
    cadence: { daily: base, weekly: Math.round(base * 7), recommended: pb.postsPerWeek },
    ramp, rules, issues,
    benchmarks: {
      hookWindowSec: pb.hookWindowSec,
      idealSec: pb.idealSec,
      completionTarget: pb.completionTarget,
      signals: pb.signals,
      caption: pb.caption,
    },
    notes: pb.notes,
    stats: { posts30, avgViews: Math.round(num(avgViews, 0)), daysIdle: daysIdle === 999 ? null : daysIdle },
  };
}

// ── Радар трендов ────────────────────────────────────────────────────────────
// Смесь своих данных (что реально даёт охват у нас) и рыночных паттернов 2026.
const MARKET_TRENDS = [
  {
    id: 'loop', label: 'Зацикленный ролик (loop)', status: 'hot',
    why: 'Пересмотры — один из сильнейших сигналов 2026: последняя фраза возвращает к первой.',
    hook: 'Последняя фраза объясняет первую — досмотри', platforms: ['youtube', 'tiktok', 'reels'],
  },
  {
    id: 'mistake', label: '«Ты делаешь это неправильно»', status: 'hot',
    why: 'Ошибка в первые секунды ломает паттерн и держит досмотр выше среднего.',
    hook: 'Перестань делать это — иначе {topic} не сработает', platforms: ['tiktok', 'reels'],
  },
  {
    id: 'number', label: 'Конкретное число в кадре', status: 'rising',
    why: 'Цифра в первой секунде обещает измеримый результат и снижает свайп.',
    hook: '3 шага, которые подняли мой охват на 40%', platforms: ['youtube', 'reels'],
  },
  {
    id: 'before-after', label: 'До / после за 20 секунд', status: 'rising',
    why: 'Визуальная разница удерживает до развязки, хорошо сохраняется.',
    hook: 'Слева — как было, справа — как стало за 7 дней', platforms: ['reels', 'tiktok'],
  },
  {
    id: 'pov', label: 'POV + сцена из жизни', status: 'steady',
    why: 'Работает на узнаваемости, но без конфликта быстро выгорает.',
    hook: 'POV: ты снова открываешь {topic} в 23:40', platforms: ['tiktok', 'reels'],
  },
  {
    id: 'myth', label: 'Миф / правда', status: 'steady',
    why: 'Спорные утверждения дают комментарии, но требуют осторожности с правилами.',
    hook: 'Миф: {topic} требует силы воли. Правда — системы', platforms: ['youtube', 'tiktok'],
  },
  {
    id: 'reply', label: 'Ответ на комментарий', status: 'rising',
    why: 'Готовый хук из реального вопроса — лучший досмотр на старте аккаунта.',
    hook: 'Меня спросили: «{question}» — отвечаю', platforms: ['tiktok', 'reels'],
  },
  {
    id: 'tool-stack', label: 'Стек инструментов', status: 'cooling',
    why: 'Списки инструментов перенасыщены: работают только с личным результатом.',
    hook: 'Мой стек из 3 инструментов вместо 10', platforms: ['youtube', 'reels'],
  },
];

export function trendRadar({ days = 30 } = {}) {
  const since = addDays(nowIso(), -days);
  const rows = db.prepare(`SELECT pb.views, pb.platform, e.format, e.topic, e.hashtags, e.title
    FROM publications pb JOIN episodes e ON e.id = pb.episode_id
    WHERE pb.status = 'published' AND pb.published_at >= ? AND pb.views > 0`).all(since);
  const baseMedian = median(rows.map((r) => r.views)) || 1;

  const groupBy = (keyFn) => {
    const map = new Map();
    for (const r of rows) {
      const keys = keyFn(r);
      for (const k of keys) {
        if (!k) continue;
        const cur = map.get(k) || { key: k, n: 0, views: 0, list: [] };
        cur.n += 1; cur.views += r.views; cur.list.push(r.views);
        map.set(k, cur);
      }
    }
    return [...map.values()]
      .filter((g) => g.n >= 2)
      .map((g) => ({ key: g.key, n: g.n, avg: Math.round(g.views / g.n), lift: round1(median(g.list) / baseMedian) }))
      .sort((a, b) => b.lift - a.lift);
  };

  const formats = groupBy((r) => [r.format]).slice(0, 6);
  const hashtags = groupBy((r) => parseJson(r.hashtags, []).map((h) => String(h).toLowerCase())).slice(0, 8);
  const own = { formats, hashtags, baseMedian: Math.round(baseMedian), samples: rows.length };

  const evidenceFor = (ids) => {
    const tags = new Set(ids);
    const matched = rows.filter((r) => parseJson(r.hashtags, []).some((h) => tags.has(String(h).toLowerCase()))
      || tags.has(String(r.format || '')));
    if (!matched.length) return { n: 0, lift: null };
    return { n: matched.length, lift: round1(median(matched.map((m) => m.views)) / baseMedian) };
  };

  const trends = MARKET_TRENDS.map((t) => {
    const ev = evidenceFor([t.id, t.id.replace(/-/g, '')]);
    // рыночный статус уточняется своими данными: если у нас формат выстрелил — поднимаем
    let status = t.status;
    if (ev.n >= 3) status = ev.lift >= 1.3 ? 'hot' : ev.lift >= 1.0 ? 'rising' : ev.lift < 0.8 ? 'cooling' : status;
    return {
      ...t,
      status,
      evidence: ev,
      verdict: status === 'hot' ? 'снимай сейчас' : status === 'rising' ? 'тестируй' : status === 'steady' ? 'держи в ротации' : 'остывает',
    };
  }).sort((a, b) => ({ hot: 0, rising: 1, steady: 2, cooling: 3 })[a.status] - ({ hot: 0, rising: 1, steady: 2, cooling: 3 })[b.status]);

  const ideas = trends.filter((t) => t.status !== 'cooling').slice(0, 4).map((t) => ({
    trend: t.label, platform: t.platforms[0], hook: t.hook,
    why: t.why, status: t.status,
  }));

  return { updatedAt: nowIso(), days, own, trends, ideas, source: `свои публикации за ${days} дн. + правила площадок 2026` };
}

// ── Лаборатория хуков ────────────────────────────────────────────────────────
// Тема подставляется в кавычках: русская грамматика не ломается на любом роде и числе
// («про «привычки»», «про «фитнес»» — одинаково корректно).
const HOOK_PATTERNS = [
  // Шаблоны короткие намеренно: окно свайпа TikTok — 1.0–1.3 с, это 3–5 слов.
  // Длинный хук физически не успевает прозвучать, поэтому «красивые» длинные
  // формулировки живут в альтернативах, а не в первой сцене.
  { id: 'contradiction', label: 'Контрадикция', template: '«{topic}» — это миф', why: 'Ломает ожидание и держит до развязки' },
  { id: 'number', label: 'Конкретное число', template: '{n} шага до результата', why: 'Цифра обещает измеримый результат' },
  { id: 'pain-question', label: 'Вопрос-боль', template: 'Почему {topic} не работает?', why: 'Зритель узнаёт свою ситуацию в первую секунду' },
  { id: 'mistake', label: 'Ошибка', template: '{topic}: главная ошибка', why: 'Прямое указание на ошибку — сильный паттерн-интеррапт' },
  { id: 'result-first', label: 'Результат вперёд', template: 'Результат за 7 дней', why: 'Показываем конец до начала, дальше держит любопытство' },
  { id: 'loop', label: 'Петля', template: 'Досмотри до развязки', why: 'Провоцирует пересмотр, а он усиливает охват' },
  { id: 'reply', label: 'Ответ на вопрос', template: '{topic} — отвечаю', why: 'Ощущение живого диалога, хорошо для старта аккаунта' },
];

const HOOK_STOPWORDS = new Set(['и', 'в', 'на', 'с', 'не', 'что', 'как', 'это', 'для', 'по']);

/** Оценка хука 0..100 по проверяемым признакам, без «нравится / не нравится». */
export function scoreHook(text, { platform = 'reels' } = {}) {
  const pb = PLATFORM_PLAYBOOK[platform] || PLATFORM_PLAYBOOK.reels;
  const t = String(text || '').trim();
  const words = t.split(/\s+/).filter(Boolean);
  const chars = t.length;
  const hasNumber = /\d/.test(t);
  const hasQuestion = /\?/.test(t);
  const hasContrast = /(неправд|ошибк|перестань|вместо|но |однако)/i.test(t);
  const hasResult = /(результат|за \d|поднял|сработал|получилось)/i.test(t);
  const hasLoop = /(последн|досмотри|до конца|вернись)/i.test(t);
  const hasCuriosity = /(почему|секрет|никто|всё|правда)/i.test(t);
  // читаемая длина: ~2.5 слова в секунду речи → 7 слов ≈ 2.8 с
  const readableSec = round1(words.length / 2.5);
  let score = 50;
  if (hasNumber) score += 12;
  if (hasQuestion) score += 8;
  if (hasContrast) score += 12;
  if (hasResult) score += 10;
  if (hasLoop) score += 8;
  if (hasCuriosity) score += 8;
  if (words.length <= 9) score += 6;    // хук успевает прозвучать до свайпа
  if (words.length > 12) score -= 14;   // длинный хук не успевает
  if (words.length < 4) score -= 10;    // слишком мало смысла
  if (chars > 90) score -= 8;
  if (new RegExp(`(${[...HOOK_STOPWORDS].join('|')})\\s+\\1`, 'i').test(t)) score -= 6;
  if (readableSec > pb.hookWindowSec + 1.5) score -= 10;
  return {
    score: clamp(Math.round(score), 0, 100),
    chars, words: words.length, readableSec,
    fitsWindow: readableSec <= pb.hookWindowSec + 0.8,
    traits: { hasNumber, hasQuestion, hasContrast, hasResult, hasLoop, hasCuriosity },
  };
}

/**
 * Лаборатория хуков: 6–7 вариантов под площадку, с оценкой и объяснением.
 * Тема берётся из ролика, проекта или вводится вручную.
 */
export function hookLab({ topic = '', platform = 'reels', niche = '' } = {}) {
  const cleanTopic = String(topic || '').trim() || niche || 'твой контент';
  const shortTopic = shortHookTopic(cleanTopic, niche) || cleanTopic;
  const hooks = HOOK_PATTERNS.map((p, i) => {
    const raw = p.template.replace('{topic}', shortTopic).replace('{n}', String(3 + (i % 3)));
    const text = raw.charAt(0).toUpperCase() + raw.slice(1);
    const s = scoreHook(text, { platform });
    // проверяем тот же текст вирусным скором как первую сцену — второй, независимый взгляд
    const viral = scoreViral({
      title: text,
      scenes: [{ text, seconds: 3 }, { text: 'Разбор по шагам', seconds: 6 }],
      description: cleanTopic,
      hashtags: ['shorts'],
      targetSec: 25,
      topic: cleanTopic,
    });
    // хук без темы звучит одинаково у всех и не цепляет именно эту аудиторию:
    // даём бонус за упоминание темы, иначе в топе всегда «Результат за 7 дней»
    const anchored = text.toLowerCase().includes(shortTopic.toLowerCase());
    const combined = Math.round(s.score * 0.65 + viral.score * 0.35 + (anchored ? 10 : 0));
    return {
      id: p.id, type: p.label, text,
      score: combined, hookScore: s.score, viralScore: viral.score,
      fitsWindow: s.fitsWindow, readableSec: s.readableSec, words: s.words,
      anchored, why: p.why,
      traits: s.traits,
    };
  }).sort((a, b) => b.score - a.score);

  const pb = PLATFORM_PLAYBOOK[platform] || PLATFORM_PLAYBOOK.reels;
  return {
    topic: cleanTopic, platform, platformLabel: pb.label,
    best: hooks[0] || null,
    hooks,
    guidance: [
      `Решение о свайпе: ${pb.hookWindowSec} с — хук должен звучать сразу, без «привет, друзья».`,
      `Длительность: ${pb.idealSec[0]}–${pb.idealSec[1]} с, досмотр целимся в ${Math.round(pb.completionTarget * 100)}%.`,
      'Число, ошибка или контрадикция в первой фразе работают лучше общих слов.',
      'Последняя фраза должна либо закрыть петлю, либо вернуть к первой — это даёт пересмотр.',
    ],
    usedTopic: cleanTopic,
  };
}

// ── Удержание: структура ролика по секундам ──────────────────────────────────
const wordsPerSec = 2.5;

export function retentionPlan({ scenes = [], title = '', description = '', platform = 'reels', durationSec = null, hashtags = null } = {}) {
  const pb = PLATFORM_PLAYBOOK[platform] || PLATFORM_PLAYBOOK.reels;
  const list = (Array.isArray(scenes) ? scenes : [])
    .map((s, i) => ({ index: i, text: String(s?.text || s || ''), seconds: num(s?.seconds, 0) }))
    .filter((s) => s.text || s.seconds);
  const total = num(durationSec, 0) || list.reduce((a, s) => a + (s.seconds || 0), 0) || 30;
  const first = list[0] || { text: title, seconds: 3 };
  const firstWords = String(first.text || '').split(/\s+/).filter(Boolean).length;
  const hookSec = round1(firstWords / wordsPerSec);
  const last = list[list.length - 1] || { text: '' };
  const hook = scoreHook(first.text || title, { platform });

  const checks = [];
  const add = (id, ok, severity, text, fix) => checks.push({ id, ok, severity: ok ? 'ok' : severity, text, fix: ok ? null : fix });

  add('hook-window', hookSec <= pb.hookWindowSec + 0.8, 'block',
    `Хук ${hookSec} с (окно ${pb.hookWindowSec} с)`,
    `Сократите первую фразу до ${Math.round(pb.hookWindowSec * wordsPerSec)} слов: «${hook.text || '...'}» → короче`);
  add('hook-strength', hook.score >= 60, 'warn',
    `Сила хука ${hook.score}/100`,
    'Добавьте число, ошибку или контрадикцию в первую фразу');
  add('duration', total >= pb.idealSec[0] && total <= pb.idealSec[1], 'warn',
    `Длительность ${Math.round(total)} с (оптимум ${pb.idealSec[0]}–${pb.idealSec[1]} с)`,
    total < pb.idealSec[0] ? `Добавьте смысла до ${pb.idealSec[0]} с — иначе досмотр есть, а веса нет` : `Срежьте до ${pb.idealSec[1]} с: длиннее — падает досмотр`);
  add('loop', /(сначала|смотри с начала|до конца|вернись|ещё раз)/i.test(String(last.text || '')), 'warn',
    'Петля в конце ролика',
    'Последняя фраза должна возвращать к первой — это даёт пересмотр и охват');
  add('payoff', list.some((s) => /\d/.test(s.text)) || /\d/.test(title), 'warn',
    'Конкретика в середине',
    'Добавьте цифру, срок или измеримый результат — без него ролик выглядит как мнение');
  const tooLong = list.filter((s) => (s.seconds || 0) > 6);
  add('pacing', tooLong.length === 0, 'warn',
    'Темп сцен',
    tooLong.length ? `Сцена ${tooLong[0].index + 1} длится ${tooLong[0].seconds} с — дробим на 3–5 с` : 'Темп ровный');
  add('caption', String(description || '').trim().length >= 40, 'warn',
    'Описание под площадку',
    'Добавьте в описание смысл и CTA: алгоритм читает первые строки');
  // теги проверяем по факту: у Shorts 3–5 (лишние режут ключевые слова),
  // у TikTok и Reels 5–8 (больше — уже спам и потеря смысла)
  const tags = Array.isArray(hashtags)
    ? hashtags.filter(Boolean)
    : String(description || '').match(/#[\p{L}\d_]+/gu) || [];
  const tagRange = platform === 'youtube' ? [3, 5] : [5, 8];
  const tagOk = tags.length >= tagRange[0] && tags.length <= tagRange[1];
  add('hashtags', tagOk, 'warn',
    `Теги: ${tags.length} (нужно ${tagRange[0]}–${tagRange[1]})`,
    tags.length === 0 ? 'Добавьте теги по теме: по ним Shorts находят в поиске' : tags.length < tagRange[0]
      ? `Добавьте до ${tagRange[0]}–${tagRange[1]} тегов по теме`
      : `Оставьте ${tagRange[1]} тегов: лишние размывают тему`);

  const failed = checks.filter((c) => c.severity !== 'ok');
  const blocking = failed.filter((c) => c.severity === 'block').length;
  // прогноз досмотра: база площадки, скорректированная на хук, длину и петлю
  const lengthPenalty = total > pb.idealSec[1] ? clamp((total - pb.idealSec[1]) / 100, 0, 0.25) : 0;
  const predicted = clamp(
    pb.completionTarget + (hook.score - 60) / 500 - lengthPenalty
    + (checks.find((c) => c.id === 'loop')?.ok ? 0.05 : 0)
    + (checks.find((c) => c.id === 'payoff')?.ok ? 0.03 : 0),
    0.2, 0.95,
  );

  return {
    platform, platformLabel: pb.label, durationSec: Math.round(total), scenes: list.length,
    hook: { text: first.text || title, seconds: hookSec, score: hook.score, windowSec: pb.hookWindowSec },
    predictedCompletion: Math.round(predicted * 100),
    targetCompletion: Math.round(pb.completionTarget * 100),
    verdict: blocking ? 'fix' : failed.length <= 1 ? 'ready' : failed.length <= 3 ? 'tune' : 'rewrite',
    checks,
    benchmarks: { idealSec: pb.idealSec, signals: pb.signals, retentionBench: pb.retentionBench },
  };
}

// ── Монетизация: где деньги и сколько до них ─────────────────────────────────
function velocity(list, days) {
  if (!list.length) return 0;
  return list.reduce((s, x) => s + num(x.views, 0), 0) / Math.max(1, days);
}

export function monetizationPlan() {
  const since30 = addDays(nowIso(), -30);
  const since90 = addDays(nowIso(), -90);
  const rows = db.prepare(`SELECT pb.platform, pb.account_id, pb.views, pb.followers, pb.published_at
    FROM publications pb WHERE pb.status = 'published' AND pb.published_at >= ?`).all(since90);
  const accounts = db.prepare('SELECT * FROM accounts').all();

  const sum = (platform, days) => {
    const since = addDays(nowIso(), -days);
    return rows.filter((r) => (!platform || r.platform === platform) && r.published_at >= since)
      .reduce((s, r) => s + num(r.views, 0), 0);
  };
  const views7 = (platform) => velocity(rows.filter((r) => !platform || r.platform === platform)
    .filter((r) => r.published_at >= addDays(nowIso(), -7)), 7);

  const followersOf = (platform) => accounts.filter((a) => !platform || a.platform === platform)
    .reduce((s, a) => s + num(a.followers, 0), 0);
  const followersFromContent = (platform, days = 30) => {
    const since = addDays(nowIso(), -days);
    return rows.filter((r) => (!platform || r.platform === platform) && r.published_at >= since)
      .reduce((s, r) => s + num(r.followers, 0), 0);
  };

  const ytAccounts = accounts.filter((a) => a.platform === 'youtube').length;
  const ytUploads90 = db.prepare(`SELECT COUNT(*) n FROM publications WHERE platform = 'youtube' AND status = 'published' AND published_at >= ?`).get(since90).n;

  const ytFollowers = followersOf('youtube');
  const ytViews90 = sum('youtube', 90);
  const ytViews7 = views7('youtube');
  const ytFollowersPerDay = followersFromContent('youtube', 30) / 30;

  const ttFollowers = followersOf('tiktok');
  const ttViews30 = sum('tiktok', 30);
  const ttViews7 = views7('tiktok');
  const ttFollowersPerDay = followersFromContent('tiktok', 30) / 30;

  const eta = (gap, perDay) => (gap <= 0 ? 0 : perDay > 0 ? Math.ceil(gap / perDay) : null);
  const fmtEta = (days) => (days === null ? 'нет данных' : days === 0 ? 'готово' : days > 365 ? 'больше года' : `${days} дн.`);

  const ads = (() => { try { return adsOverview(); } catch { return null; } })();
  const money = (() => { try { return moneySummary({ days: 30 }); } catch { return null; } })();

  const programs = [
    {
      id: 'youtube-ypp-1',
      name: 'YouTube Partner Program — ранний доступ',
      platform: 'youtube',
      reward: 'фан-финансирование, Shopping и заявка в программу',
      requirements: [
        { label: 'подписчики', current: ytFollowers, target: 500, unit: '' },
        { label: 'публичные загрузки за 90 дней', current: ytUploads90, target: 3, unit: '' },
        { label: 'просмотры Shorts за 90 дней', current: ytViews90, target: 3_000_000, unit: '' },
      ],
      etaDays: eta(Math.max(
        Math.max(0, 500 - ytFollowers) / Math.max(0.01, ytFollowersPerDay),
        Math.max(0, 3_000_000 - ytViews90) / Math.max(0.01, ytViews7),
      ), 1),
      note: 'Shorts-просмотры не конвертируются в 4000 часов: у Shorts свой порог. С 1 февраля 2027 требования удваиваются (20 млн просмотров).',
    },
    {
      id: 'youtube-ypp-2',
      name: 'YouTube Partner Program — полная монетизация',
      platform: 'youtube',
      reward: 'доход от рекламы Shorts, 45% от пула',
      requirements: [
        { label: 'подписчики', current: ytFollowers, target: 1000, unit: '' },
        { label: 'просмотры Shorts за 90 дней', current: ytViews90, target: 10_000_000, unit: '' },
      ],
      etaDays: eta(Math.max(
        Math.max(0, 1000 - ytFollowers) / Math.max(0.01, ytFollowersPerDay),
        Math.max(0, 10_000_000 - ytViews90) / Math.max(0.01, ytViews7),
      ), 1),
      note: 'Только для аудитории в странах, где включён Shorts-доход; смотреть надо на «квалифицированные» просмотры.',
    },
    {
      id: 'tiktok-rewards',
      name: 'TikTok Creator Rewards',
      platform: 'tiktok',
      // программа открыта только в 8 странах: аккаунту из РФ недоступна даже при выполнении порогов
      regionLimited: true,
      regionNote: 'Только US, UK, DE, FR, JP, KR, MX, BR',
      reward: '≈$0.40–1.20 за 1000 квалифицированных просмотров, только видео > 60 с',
      requirements: [
        { label: 'подписчики', current: ttFollowers, target: 10_000, unit: '' },
        { label: 'просмотры за 30 дней', current: ttViews30, target: 100_000, unit: '' },
      ],
      etaDays: eta(Math.max(
        Math.max(0, 10_000 - ttFollowers) / Math.max(0.01, ttFollowersPerDay),
        Math.max(0, 100_000 - ttViews30) / Math.max(0.01, ttViews7),
      ), 1),
      note: 'Программа работает только в 8 странах (US, UK, DE, FR, JP, KR, MX, BR) и требует 18+. Для РФ-аккаунта она недоступна — деньги здесь дают бренд-интеграции и продажи, а не выплаты платформы.',
    },
    {
      id: 'brand-deals',
      name: 'Бренд-интеграции',
      platform: null,
      reward: 'фикс / CPM / CPA по договору, оплата внутри платформы',
      requirements: [
        { label: 'активных кампаний', current: ads?.totals?.active || 0, target: 3, unit: '' },
        { label: 'выходов по кампаниям', current: ads?.totals?.posts || 0, target: 24, unit: '' },
      ],
      etaDays: 0,
      note: ads && ads.totals.active > 0
        ? `Уже начислено ${Math.round(ads.totals.revenue).toLocaleString('ru-RU')} ₽, дебиторка ${Math.round(ads.totals.receivable).toLocaleString('ru-RU')} ₽.`
        : 'Заведите первую кампанию на экране «Реклама» — это самый быстрый канал денег.',
    },
    {
      id: 'own-product',
      name: 'Свой продукт по ссылкам',
      platform: null,
      reward: 'маржа с каждой покупки, без посредников',
      requirements: [
        { label: 'переходов за 30 дней', current: Math.round(money?.totals?.clicks || 0), target: 5000, unit: '' },
        { label: 'покупок за 30 дней', current: Math.round(money?.totals?.conversions || 0), target: 100, unit: '' },
      ],
      etaDays: 0,
      note: money
        ? `EPC ${Math.round(money.totals.epc)} ₽, конверсия ${money.totals.cr}%. Ссылка с UTM уже стоит в описаниях.`
        : 'Добавьте продукт на экране «Продвижение».',
    },
  ].map((p) => {
    const reqs = p.requirements.map((r) => ({
      ...r,
      progress: pctOf(r.current, r.target),
      gap: Math.max(0, r.target - r.current),
      done: r.current >= r.target,
    }));
    const progress = Math.round(reqs.reduce((s, r) => s + r.progress, 0) / reqs.length);
    return {
      ...p, requirements: reqs, progress,
      ready: reqs.every((r) => r.done),
      etaText: fmtEta(p.etaDays),
    };
  });

  const monthlyBrand = Math.round(ads?.totals?.revenue || 0);
  const monthlyProduct = Math.round(money?.totals?.profit || 0);
  return {
    updatedAt: nowIso(),
    totals: {
      followers: followersOf(null),
      views30: sum(null, 30),
      views90: sum(null, 90),
      views7PerDay: Math.round(views7(null)),
      youtubeAccounts: ytAccounts,
      tiktokFollowers: ttFollowers,
      youtubeFollowers: ytFollowers,
    },
    programs,
    income: {
      brandMonthly: monthlyBrand,
      productMonthly: monthlyProduct,
      platformMonthly: 0,
      note: 'Выплаты площадок (Shorts/TikTok) подключаются только после выполнения их порогов; бренды и свой продукт уже приносят деньги.',
    },
  };
}

// ── Гейт публикации: пускать или лечить ──────────────────────────────────────
export function publishGate(episodeId) {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
  if (!episode) return null;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(episode.project_id);
  const account = episode.account_id ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(episode.account_id) : null;
  const platform = account?.platform || 'reels';
  const campaign = episode.campaign_id ? db.prepare('SELECT * FROM campaigns WHERE id = ?').get(episode.campaign_id) : null;
  const scenes = parseJson(episode.scenes, []);
  const settings = getSettings();

  const compliance = checkCompliance({
    title: episode.title, description: episode.description || '', scenes, platform,
    hashtags: parseJson(episode.hashtags, []),
    adLabel: Number(settings.ad_label) === 1, aiLabel: Number(settings.ai_label) === 1, campaign,
  });
  const viral = scoreViral({
    title: episode.title, scenes, description: episode.description || '',
    hashtags: parseJson(episode.hashtags, []), targetSec: 30, topic: episode.topic || '', projectId: episode.project_id,
  });
  const duration = scenes.reduce((s, x) => s + num(x.seconds, 0), 0);
  const retention = retentionPlan({ scenes, title: episode.title, description: episode.description, platform, durationSec: duration });
  const forecast = forecastEpisode({ episode, project, account, platform });
  // квоту считаем тем же кодом, что и публикация, — иначе вердикт и реальность расходятся
  const quota = platformQuota(platform);
  const cap = quota.cap;

  const blockers = [];
  const warnings = [];
  if (compliance.blocking.length) blockers.push(...compliance.blocking.map((b) => ({ id: b.id, text: b.reason, fix: 'Исправить текст или снять с автопубликации' })));
  if (!episode.description || episode.description.length < 40) blockers.push({ id: 'caption-short', text: 'Описание короче 40 символов', fix: 'Добавьте смысл и CTA — площадка читает первые строки' });
  if (retention.verdict === 'rewrite') warnings.push({ id: 'retention', text: `Удержание под вопросом: ${retention.checks.filter((c) => !c.ok).length} замечаний`, fix: retention.checks.find((c) => !c.ok)?.fix });
  else if (retention.verdict === 'tune') warnings.push({ id: 'retention-tune', text: `Удержание ${retention.predictedCompletion}% — можно лучше`, fix: retention.checks.find((c) => !c.ok)?.fix });
  if (viral.score < num(settings.min_viral_score, 45)) warnings.push({ id: 'viral-low', text: `Вирусный скор ${viral.score} ниже порога ${num(settings.min_viral_score, 45)}`, fix: viral.advice?.[0] || 'Сменить хук' });
  if (quota.left <= 0) warnings.push({ id: 'quota', text: `Квота ${PLATFORM_LABELS[platform] || platform} на сутки исчерпана (${quota.used}/${cap})`, fix: 'Перенести публикацию на завтра' });

  const score = Math.round(
    clamp(compliance.score, 0, 100) * 0.34
    + clamp(viral.score, 0, 100) * 0.26
    + (retention.predictedCompletion / retention.targetCompletion) * 100 * 0.2
    + clamp(80 - (quota.used / Math.max(1, cap)) * 40, 0, 100) * 0.1
    + (forecast.expectedViews > 0 ? 100 : 0) * 0.1,
  );

  return {
    episodeId, platform, platformLabel: (PLATFORM_PLAYBOOK[platform] || PLATFORM_PLAYBOOK.reels).label,
    verdict: blockers.length ? 'block' : warnings.length > 2 ? 'fix' : 'go',
    score: clamp(score, 0, 100),
    blockers, warnings,
    compliance, viral, retention, forecast,
    quota: { used: quota.used, cap, left: quota.left },
    campaign: campaign ? { id: campaign.id, name: campaign.name, erid: campaign.erid || '', marking: campaign.marking } : null,
    checkedAt: nowIso(),
  };
}

export const GROWTH_PLATFORM_LABELS = Object.fromEntries(
  Object.entries(PLATFORM_PLAYBOOK).map(([k, v]) => [k, v.label]),
);

// ─────────────────────────────────────────────────────────────────────────────
// Контент-план: что, когда и на какой площадке выйдет на этой неделе.
// Это не «идеи в вакууме»: формат, время и хук берутся из фактических данных —
// лучших часов, работающих форматов и лаборатории хуков.
// ─────────────────────────────────────────────────────────────────────────────
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

// Расписание площадок: TikTok и Reels — ежедневно, Shorts — 3–5 в неделю
// (алгоритм Shorts любит регулярность, но не поток).
const PLATFORM_DAYS = {
  tiktok: [0, 1, 2, 3, 4, 5, 6],
  reels: [0, 1, 2, 3, 4, 5, 6],
  youtube: [1, 3, 5, 6],
};

/**
 * Тема для хука: максимум 2 слова. Хук читается вслух за 1–1.6 с — это и есть
 * окно свайпа. Полная тема остаётся в заголовке и описании.
 */
function shortHookTopic(title, fallback = '') {
  const LEAD = /^(почему|как|что|зачем|когда|сколько|разбор|коротко|итог)[:\s]+/i;
  let text = String(title || '').replace(/[«»"]/g, '').trim();
  while (LEAD.test(text)) text = text.replace(LEAD, '');
  const STOP = new Set(['и', 'в', 'на', 'с', 'со', 'по', 'о', 'об', 'про', 'без', 'от', 'до', 'как', 'что', 'это', 'же', 'ли']);
  const raw = text.split(/\s+/).map((w) => w.replace(/[«»"]/g, '')).filter(Boolean);
  const words = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    const low = w.toLowerCase();
    if (STOP.has(low)) continue;
    // «SaaS для автоматизации» понятнее, чем «SaaS автоматизации»: предлог
    // сохраняем, если он склеивает два слова, а не висит в конце
    if (low === 'для' && words.length === 1 && raw[i + 1]) { words.push(w); continue; }
    words.push(w);
  }
  // одно ёмкое слово лучше, чем обрубок фразы: «фитнес», а не «фитнес и»
  const first = words[0] || '';
  const out = words.slice(0, first.length >= 6 ? 1 : (words[1] === 'для' ? 3 : 2));
  const clean = out.join(' ').replace(/[,:;—–-]+$/, '').trim();
  return clean.length >= 4 ? clean.slice(0, 24) : String(fallback || '').slice(0, 22);
}

/** Короткая тема для хука: 2–3 слова, не обрезая посреди фразы */
function shortenTopic(title, fallback = '') {
  const LEAD = /^(почему|как|что|зачем|когда|сколько|разбор|коротко|почему|итог)[:\s]+/i;
  let text = String(title || '').replace(/[«»"]/g, '').trim();
  // шаблон хука сам задаёт вопрос — не дублируем «почему почему»
  while (LEAD.test(text)) text = text.replace(LEAD, '');
  const words = text.split(/\s+/).filter(Boolean);
  const out = [];
  for (const w of words) {
    if (out.length >= 4) break;
    if (out.length && `${out.join(' ')} ${w}`.length > 34) break;
    out.push(w);
  }
  const clean = out.join(' ').replace(/[,:;—–-]+$/, '').trim();
  return clean.length >= 4 ? clean : String(fallback || '').slice(0, 34);
}

export function contentPlan({ days = 7, projectId = null } = {}) {
  const settings = getSettings();
  const span = clamp(num(days, 7), 1, 28);
  const projects = projectId
    ? db.prepare('SELECT * FROM projects WHERE id = ?').all(projectId)
    : db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY created_at').all();

  const radar = trendRadar({ days: 30 });
  const hotFormats = (radar.own?.formats || []).filter((f) => (f.lift || 0) >= 1).map((f) => f.key);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // один день — одна запись: бренды складываются в общий календарь,
  // иначе «план на неделю» превращался в три отдельных недели
  const byDate = new Map();
  for (let d = 0; d < span; d++) {
    const date = new Date(today.getTime() + d * DAY);
    byDate.set(date.toISOString().slice(0, 10), { date: date.toISOString().slice(0, 10), weekday: WEEKDAYS[date.getDay()], slots: [] });
  }
  const perPlatform = { reels: 0, tiktok: 0, youtube: 0 };
  let expectedViews = 0;
  let expectedRevenue = 0;

  for (const [brandIndex, project] of projects.entries()) {
    // темы: сначала неиспользованная библиотека проекта, потом добор из мозга
    const ideaRows = db.prepare(`SELECT title, hook, format FROM ideas
        WHERE project_id = ? ORDER BY (status = 'new') DESC, score DESC LIMIT 60`).all(project.id);
    const ideas = ideaRows.length ? ideaRows : generateIdeas(project, { count: 21 })
      .map((i) => ({ title: i.title, hook: i.hook, format: i.format }));
    let cursor = 0;
    const formats = [project.format, ...hotFormats].filter(Boolean);

    for (let d = 0; d < span; d++) {
      const date = new Date(today.getTime() + d * DAY);
      const dow = date.getDay();
      const day = byDate.get(date.toISOString().slice(0, 10));
      for (const platform of ['tiktok', 'reels', 'youtube']) {
        if (!PLATFORM_DAYS[platform].includes(dow)) continue;
        // аккаунт площадки этого бренда должен существовать — иначе слот фантомный
        const acc = db.prepare(`SELECT * FROM accounts WHERE platform = ? AND status IN ('healthy','warmup')
            AND (project_id IS NULL OR project_id = ?) ORDER BY quality DESC LIMIT 1`).get(platform, project.id);
        if (!acc) continue;
        // не больше постов в день, чем разрешает квота аккаунта
        const perDay = platform === 'youtube' ? 1 : Math.min(2, num(acc.daily_limit, 2));
        for (let k = 0; k < perDay; k++) {
          const hours = bestHours(platform, 4);
          const hour = hours[(d + k + brandIndex) % Math.max(1, hours.length)]?.hour ?? 12;
          const idea = ideas[cursor % Math.max(1, ideas.length)] || { title: project.niche, hook: '', format: project.format };
          cursor += 1;
          const format = formats[(cursor + k) % Math.max(1, formats.length)] || project.format;
          // в хук идёт короткая тема (2–4 значимых слова), а не весь заголовок ролика:
          // «Почему «Нейросети, которые реально делают работу за тебя» не даёт…» — это не хук
          const shortTopic = shortenTopic(idea.title, project.niche);
          const lab = hookLab({ topic: shortTopic || project.niche, platform, niche: project.niche });
          // берём не только победителя: план должен показывать разные ходы,
          // иначе все ролики недели начинаются одинаково
          const hookPick = lab.hooks[(d + k + brandIndex) % Math.min(3, lab.hooks.length)] || lab.best;
          const base = baselineViews(project.id, platform);
          const view = Math.round(base.views * (0.9 + (hookPick.score - 60) / 300));
          const revenue = (view / 1000) * rpmFor(platform, settings);
          expectedViews += view;
          expectedRevenue += revenue;
          perPlatform[platform] += 1;
          day.slots.push({
            platform,
            platformLabel: PLATFORM_PLAYBOOK[platform].label,
            project: project.name,
            account: { id: acc.id, handle: acc.handle },
            time: `${String(hour).padStart(2, '0')}:07`,
            topic: idea.title,
            format,
            hook: hookPick.text,
            hookScore: hookPick.score,
            fitsWindow: hookPick.fitsWindow,
            expectedViews: view,
            expectedRevenue: Math.round(revenue * 100) / 100,
            targetSec: PLATFORM_PLAYBOOK[platform].idealSec.join('–'),
            why: `${PLATFORM_PLAYBOOK[platform].hookWindowSec} с на хук · досмотр ${Math.round(PLATFORM_PLAYBOOK[platform].completionTarget * 100)}% · ${idea.hook ? 'тема из библиотеки' : 'новая тема по нише'}`,
          });
        }
      }
    }
  }

  const out = [...byDate.values()].map((day) => ({
    ...day,
    // внутри дня — по времени: это календарь, а не список
    slots: day.slots.sort((x, y) => x.time.localeCompare(y.time)),
  }));

  const totalPosts = out.reduce((s, day) => s + day.slots.length, 0);
  return {
    updatedAt: nowIso(),
    days: span,
    plan: out,
    totals: {
      posts: totalPosts,
      perWeek: Math.round((totalPosts / span) * 7),
      expectedViews,
      expectedRevenue: Math.round(expectedRevenue * 100) / 100,
      byPlatform: perPlatform,
    },
    rules: [
      'Один ролик — один аккаунт внутри площадки; на разные площадки публикуем один и тот же ролик.',
      'Shorts — 3–5 в неделю: чаще не значит лучше, алгоритм проверяет каждый ролик на новой аудитории.',
      'Первые 60 минут после выхода — отвечаем на комментарии: это сильный сигнал обсуждения.',
      'Формат ротируется: если «POV» просел по охвату, следующий слот берёт «до / после» или «кейс».',
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// База знаний: всё, что нужно знать про площадки, в одном месте и с числами.
// ─────────────────────────────────────────────────────────────────────────────
export function platformKnowledge() {
  const rules = PLATFORM_RULES;
  const demotions = {
    tiktok: [
      'Водяные знаки и логотипы других площадок — прямая демотивация.',
      'Репосты чужого контента без переработки: дубликаты алгоритм находит по хешу.',
      'Кликбейт без развязки и «подпишись, чтобы узнать» — снижение показов.',
      'Видео короче 1 секунды или без звука-смысла — не попадает в рекомендации.',
    ],
    reels: [
      'Видимые водяные знаки и низкое разрешение (< 720p) — охват падает.',
      'Репосты из TikTok с логотипом: Instagram определяет и срезает показы.',
      'Больше 8–10 тегов — размытие темы, хуже распределение.',
      'Слишком длинное вступление: до 40% уходят в первые 3 секунды.',
    ],
    youtube: [
      'Водяные знаки и репосты: Shorts демотивирует чужой контент.',
      'Вводящий в заблуждение заголовок — ограничение показов.',
      'Свайп в первые 2 секунды выше 40% — ролик не получает следующую волну.',
      'Нерегулярность: 3–5 Shorts в неделю стабильно лучше «20 за день и месяц тишины».',
    ],
  };
  const official = {
    tiktok: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
    reels: 'https://developers.facebook.com/docs/instagram-platform/content-publishing',
    youtube: 'https://developers.google.com/youtube/v3/docs/videos/insert',
  };

  const platforms = ['tiktok', 'reels', 'youtube'].map((platform) => {
    const pb = PLATFORM_PLAYBOOK[platform];
    const api = PLATFORM_API_LIMITS[platform];
    const r = rules[platform];
    return {
      platform,
      label: pb.label,
      api: { per24h: api.per24h, initPerMin: api.initPerMin, note: api.note, official: official[platform] },
      fields: {
        captionMax: r.captionMax,
        captionMaxBytes: r.captionMaxBytes || null,
        titleMax: r.titleMax || null,
        hashtagsRecommended: r.hashtagsRecommended,
        hashtagsMax: r.hashtagsMax,
        // рабочее окно тегов: у Shorts 3–5 (лишние режут ключевые слова), у Reels/TikTok 5–8
        tagRange: platform === 'youtube' ? [3, 5] : [5, 8],
        videoMaxSec: r.videoMaxSec,
        videoMaxBytes: r.videoMaxBytes,
      },
      algorithm: {
        hookWindowSec: pb.hookWindowSec,
        idealSec: pb.idealSec,
        completionTarget: Math.round(pb.completionTarget * 100),
        retentionBench: pb.retentionBench,
        postsPerWeek: pb.postsPerWeek,
        signals: pb.signals,
        caption: pb.caption,
      },
      demotions: demotions[platform],
      notes: pb.notes,
    };
  });

  const monetization = [
    {
      id: 'youtube-ypp', platform: 'youtube', label: 'YouTube Partner Program',
      tiers: [
        { name: 'Ранний доступ', followers: 500, uploads90d: 3, shortsViews90d: 3_000_000, hours: 3000, gives: 'фанаты, Shopping, заявка в программу' },
        { name: 'Полная монетизация', followers: 1000, uploads90d: 3, shortsViews90d: 10_000_000, hours: 4000, gives: 'реклама Shorts (45% создателю), watch page 55%' },
      ],
      changes: 'С 01.02.2027 требования удваиваются: 20 млн просмотров Shorts или 8 000 часов за 90 дней',
      region: 'зависит от страны аудитории',
    },
    {
      id: 'tiktok-rewards', platform: 'tiktok', label: 'TikTok Creator Rewards',
      tiers: [{ name: 'Порог', followers: 10_000, views30d: 100_000, videoSec: 61, qualifiedViews: 1000 }],
      changes: 'Платят только за оригинальные видео > 1 минуты; дуэты, stitch, фото-режим и реклама вне программы',
      region: 'только US, UK, DE, FR, JP, KR, MX, BR — в РФ недоступна',
    },
    {
      id: 'ig-bonus', platform: 'reels', label: 'Instagram (бонусы Reels)',
      tiers: [], changes: 'Бонусы Reels — только по приглашению, зависят от страны аккаунта',
      region: 'по приглашению, РФ не входит',
    },
  ];

  return {
    updatedAt: nowIso(),
    platforms,
    monetization,
    general: {
      quotas: PLATFORMS.map((p) => ({
        platform: p, label: PLATFORM_LABELS[p],
        api: PLATFORM_API_LIMITS[p], pulseCapRule: 'min(темп × 5–17, лимит API)',
      })),
      marking: {
        ru: 'Реклама у блогеров в РФ маркируется: пометка «Реклама», данные рекламодателя и erid в описании. Pulse вставляет это автоматически и блокирует публикацию без маркировки.',
        ai: 'Синтетический контент помечается как AI-generated: и по правилам площадок, и по здравому смыслу.',
      },
      truth: [
        'Просмотры Shorts не конвертируются в 4000 часов YPP — у Shorts отдельный порог.',
        'RPM Shorts обычно ниже, чем у длинных видео: там работает watch page.',
        'Регион аккаунта решает, какие программы доступны. Pulse не обещает выплат, которых в регионе нет.',
      ],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Аудит: что прямо сейчас мешает охвату и деньгам. Каждый пункт — с ценой
// вопроса и конкретным действием, а не «рекомендация».
// ─────────────────────────────────────────────────────────────────────────────
export function platformAudit() {
  const settings = getSettings();
  const issues = [];
  const since30 = addDays(nowIso(), -30);
  const accounts = db.prepare(`SELECT a.*, p.name AS project_name FROM accounts a
      LEFT JOIN projects p ON p.id = a.project_id`).all();
  const active = accounts.filter((a) => a.status === 'healthy' || a.status === 'warmup');

  // 1. Приватные публикации = нулевой охват. Это самая дорогая ошибка.
  if (Number(settings.youtube_audited) !== 1) {
    const n = active.filter((a) => a.platform === 'youtube').length;
    if (n) issues.push({
      id: 'youtube-private', severity: 'block', title: 'Shorts уходят приватно',
      impact: `${n} YouTube-аккаунт(а) публикуют без охвата: до аудита Google видео доступно только вам`,
      fix: 'Пройти аудит проекта Google и включить «Проект Google прошёл аудит» в настройках',
      action: { label: 'Открыть настройки', to: '#/settings' },
    });
  }
  if (Number(settings.tiktok_audited) !== 1 && active.some((a) => a.platform === 'tiktok')) {
    issues.push({
      id: 'tiktok-private', severity: 'warn', title: 'TikTok публикует SELF_ONLY',
      impact: 'Ролики в TikTok видны только вам — просмотров и подписчиков не будет',
      fix: 'Подать клиент TikTok Content Posting на аудит; после одобрения переключить тумблер',
      action: { label: 'Открыть настройки', to: '#/settings' },
    });
  }

  // 2. Аккаунты без токена: конвейер работает, но публикует в демо-режиме.
  const noToken = active.filter((a) => !a.access_token);
  if (noToken.length) {
    issues.push({
      id: 'no-token', severity: 'warn', title: `Аккаунты без API: ${noToken.length}`,
      impact: `@${noToken.slice(0, 3).map((a) => a.handle).join(', @')}${noToken.length > 3 ? '…' : ''} не публикуют в реальные каналы`,
      fix: 'Подключить токен у аккаунта: OAuth-приложение площадки + access token',
      action: { label: 'Открыть аккаунты', to: '#/accounts' },
    });
  }

  // 3. Бренд без аккаунта на площадке — половина охвата теряется молча.
  const projects = db.prepare('SELECT * FROM projects WHERE archived = 0').all();
  for (const project of projects) {
    const own = accounts.filter((a) => a.project_id === project.id);
    const usable = own.filter((a) => a.status === 'healthy' || a.status === 'warmup');
    const missing = PLATFORMS.filter((p) => !own.some((a) => a.platform === p));
    const resting = PLATFORMS.filter((p) => !usable.some((a) => a.platform === p) && !missing.includes(p));
    if (missing.length) {
      issues.push({
        id: `brand-gap-${project.id}`, severity: 'info', title: `${project.name}: нет аккаунта на ${missing.map((p) => PLATFORM_LABELS[p]).join(', ')}`,
        impact: 'Ролики проекта не выходят на этих площадках — теряется бесплатный охват',
        fix: 'Добавить аккаунт и привязать его к проекту',
        action: { label: 'Добавить аккаунт', to: '#/accounts' },
      });
    }
    if (resting.length) {
      issues.push({
        id: `brand-rest-${project.id}`, severity: 'warn', title: `${project.name}: аккаунт на ${resting.map((p) => PLATFORM_LABELS[p]).join(', ')} не публикует`,
        impact: 'Аккаунт в кулдауне или прогреве: площадка не получает контент вовсе',
        fix: 'Проверить ограничения аккаунта и вернуть в работу по плану восстановления',
        action: { label: 'Открыть аккаунты', to: '#/accounts' },
      });
    }
  }

  // 4. Удержание ниже нормы площадки = алгоритм не даёт следующую волну.
  for (const a of active) {
    const pb = PLATFORM_PLAYBOOK[a.platform];
    const row = db.prepare(`SELECT COUNT(*) n, AVG(watch_avg) r FROM publications
        WHERE account_id = ? AND status = 'published' AND published_at >= ?`).get(a.id, since30);
    if (row.n >= 3 && row.r > 0 && row.r < pb.completionTarget * 100 * 0.85) {
      issues.push({
        id: `retention-${a.id}`, severity: 'warn', title: `@${a.handle}: удержание ${Math.round(row.r)}% при норме ${Math.round(pb.completionTarget * 100)}%`,
        impact: `Площадка ${pb.label} не даёт роликам следующую волну показов`,
        fix: `Сократить хук до ${pb.hookWindowSec} с и держать длину ${pb.idealSec[0]}–${pb.idealSec[1]} с`,
        action: { label: 'Открыть хуки', to: '#/growth', tab: 'creative' },
      });
    }
  }

  // 5. Реклама без erid — блок публикации и риск штрафа.
  const badCampaigns = db.prepare(`SELECT id, name FROM campaigns
      WHERE status = 'active' AND marking = 'erid' AND (erid IS NULL OR erid = '')`).all();
  for (const c of badCampaigns) {
    issues.push({
      id: `campaign-${c.id}`, severity: 'block', title: `Кампания «${c.name}» без erid`,
      impact: 'Публикация с этой кампанией блокируется: реклама без маркировки — штраф',
      fix: 'Внести erid из ОРД или сменить тип маркировки на «бренд»',
      action: { label: 'Открыть рекламу', to: '#/ads' },
    });
  }

  // 6. Экономика: RPM не задан — прогноз дохода врёт в меньшую сторону.
  const rpms = { tiktok: num(settings.rpm_tiktok, 0), reels: num(settings.rpm_reels, 0), youtube: num(settings.rpm_youtube, 0) };
  const zeroRpm = Object.entries(rpms).filter(([, v]) => v <= 0).map(([k]) => PLATFORM_LABELS[k]);
  if (zeroRpm.length) {
    issues.push({
      id: 'rpm-zero', severity: 'info', title: `RPM не задан: ${zeroRpm.join(', ')}`,
      impact: 'Доход от показов считается нулевым — прогноз прибыли занижен',
      fix: 'Поставить фактический RPM после первых выплат',
      action: { label: 'Открыть настройки', to: '#/settings' },
    });
  }

  // 7. Длина ролика против порога монетизации: TikTok Rewards платит только за видео > 60 с.
  const maxSec = Number(process.env.PULSE_RENDER_MAX_SEC || 42);
  if (active.some((a) => a.platform === 'tiktok') && maxSec < 61) {
    // длительность ролика хранится в сценарии (episodes.scenes), отдельной колонки нет
    const sceneRows = db.prepare(`SELECT e.scenes FROM episodes e
        WHERE e.status = 'published' AND e.published_at >= ? LIMIT 200`).all(since30);
    const durs = sceneRows.map((r) => parseJson(r.scenes, []).reduce((a, sc) => a + num(sc?.seconds, 0), 0)).filter((x) => x > 0);
    const avgSec = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 32;
    issues.push({
      id: 'tiktok-length', severity: 'info', title: `Ролики ${Math.round(avgSec)} с — Creator Rewards платит только с 61 с`,
      impact: 'Программа считается пройденной, но выплат не будет: TikTok платит за квалифицированные просмотры видео длиннее минуты',
      fix: `Поднять PULSE_RENDER_MAX_SEC до 65 и длину проекта до 62–70 с (сейчас потолок ${maxSec} с); короткие ролики оставить для Reels и Shorts`,
      action: { label: 'Открыть проекты', to: '#/projects' },
    });
  }

  // 8. Простой аккаунтов: есть квота, но нет публикаций неделю.
  const idle = active.filter((a) => {
    const last = db.prepare('SELECT MAX(published_at) t FROM publications WHERE account_id = ?').get(a.id)?.t;
    return last && (Date.now() - new Date(last).getTime()) / DAY > 7;
  });
  if (idle.length) {
    issues.push({
      id: 'idle', severity: 'warn', title: `Простой: ${idle.length} аккаунт(ов) без публикаций неделю`,
      impact: 'Регулярность важнее количества: алгоритм перестаёт показывать аккаунт новой аудитории',
      fix: 'Вернуть 1 пост в день и держать окно публикаций',
      action: { label: 'Смотреть портфель', to: '#/growth' },
    });
  }

  const weights = { block: 34, warn: 12, info: 4 };
  const penalty = issues.reduce((s, i) => s + (weights[i.severity] || 0), 0);
  return {
    updatedAt: nowIso(),
    score: clamp(100 - penalty, 0, 100),
    counts: {
      block: issues.filter((i) => i.severity === 'block').length,
      warn: issues.filter((i) => i.severity === 'warn').length,
      info: issues.filter((i) => i.severity === 'info').length,
    },
    issues,
  };
}
