// ─────────────────────────────────────────────────────────────────────────────
// Демо-данные. Нужны, чтобы панель была «живой» сразу после docker compose up.
// Отключаются переменной PULSE_SEED=0.
// ─────────────────────────────────────────────────────────────────────────────
import { db, nowIso, ensureSettings } from '../core/db.js';
import { uid, seededRandom, addDays, addMinutes } from '../core/utils.js';
import { zonedToUtc, localParts } from '../engine/schedule.js';
import { buildScript, hashtagsFor, generateIdeas, riskScore, COVER_PALETTES } from '../engine/brain.js';
import { growthCurve } from '../engine/pipeline.js';
import { revenueFor, disclosureFor, syncCampaignMetrics } from '../engine/ads.js';
import { simulateTraffic } from '../engine/money.js';
import { log } from '../core/logger.js';

const PROJECTS = [
  {
    key: 'pulse', name: 'Pulse Studio', niche: 'SaaS для автоматизации контента и коротких видео',
    description: 'Свой продукт: конвейер коротких видео. Продвигаем подписку на сервис.',
    product_url: 'https://pulse.studio', format: 'problem-solution', posts_per_day: 2, color: 'violet',
  },
  {
    key: 'momentum', name: 'Momentum', niche: 'психология, привычки и продуктивность',
    description: 'Приложение-трекер привычек. Аудитория: 20–35, хотят систему без насилия над собой.',
    product_url: 'https://momentum.app', format: 'before-after', posts_per_day: 2, color: 'indigo',
  },
  {
    key: 'fitflow', name: 'FitFlow', niche: 'фитнес и тренировки дома',
    description: 'Онлайн-тренировки 20 минут. Продаём 7-дневный план.',
    product_url: 'https://fitflow.ru', format: 'case', posts_per_day: 1, color: 'fuchsia',
  },
];

// Портфель из трёх площадок: у каждого аккаунта своя роль и своя история роста.
// followers — реальные подписчики на момент старта демо (дальше растут из факта).
const ACCOUNTS = [
  { platform: 'reels', handle: 'pulse.studio', display_name: 'Pulse Studio', status: 'healthy', daily_limit: 3, min_gap_min: 110, quality: 92, hue: 268, followers: 24800, project: 'pulse', topic: 'автоматизация контента и короткие видео' },
  { platform: 'reels', handle: 'momentum.app', display_name: 'Momentum', status: 'healthy', daily_limit: 3, min_gap_min: 95, quality: 84, hue: 250, followers: 18400, project: 'momentum', topic: 'привычки и продуктивность' },
  { platform: 'reels', handle: 'fitflow.daily', display_name: 'FitFlow Daily', status: 'warmup', daily_limit: 2, min_gap_min: 140, quality: 71, hue: 300, followers: 6100, project: 'fitflow', topic: 'фитнес дома' },
  { platform: 'tiktok', handle: 'pulse.studio', display_name: 'Pulse', status: 'healthy', daily_limit: 3, min_gap_min: 90, quality: 88, hue: 275, followers: 41200, project: 'pulse', topic: 'закулисье контент-завода' },
  { platform: 'tiktok', handle: 'momentum.app', display_name: 'Momentum', status: 'cooldown', daily_limit: 2, min_gap_min: 120, quality: 63, hue: 240, followers: 12600, project: 'momentum', topic: 'привычки и дисциплина' },
  { platform: 'youtube', handle: 'pulse.studio', display_name: 'Pulse Studio', status: 'healthy', daily_limit: 2, min_gap_min: 240, quality: 86, hue: 8, followers: 9800, project: 'pulse', topic: 'зомби-истории и разборы контента' },
  { platform: 'youtube', handle: 'momentum.shorts', display_name: 'Momentum Shorts', status: 'warmup', daily_limit: 1, min_gap_min: 300, quality: 68, hue: 355, followers: 3200, project: 'momentum', topic: 'короткие разборы привычек' },
  { platform: 'youtube', handle: 'fitflow.daily', display_name: 'FitFlow Daily', status: 'healthy', daily_limit: 2, min_gap_min: 260, quality: 74, hue: 20, followers: 1150, project: 'fitflow', topic: 'тренировки дома без инвентаря' },
];

const PRODUCTS = [
  { name: 'Pulse Pro', url: 'https://pulse.studio/pro', pitch: 'запускает 30 роликов в месяц без монтажёра', proof: '18 000 роликов собрано за квартал', template: 'review', utm_source: 'reels', utm_medium: 'short', utm_campaign: 'pro-launch' },
  { name: 'Momentum App', url: 'https://momentum.app/start', pitch: 'собирает привычку за 21 день, по 4 минуты в день', proof: 'средний стрик пользователей — 34 дня', template: 'before-after', utm_source: 'reels', utm_medium: 'short', utm_campaign: 'habit-21' },
  { name: 'FitFlow 7 дней', url: 'https://fitflow.ru/plan7', pitch: '7 тренировок по 20 минут без зала', proof: '4 200 человек прошли план до конца', template: 'case', utm_source: 'tiktok', utm_medium: 'short', utm_campaign: 'plan7' },
];

// Демо-отчёты проверок: у части роликов есть предупреждения и низкий скор,
// чтобы экраны «Прозрачность» и карточка ролика были содержательными сразу.
function demoChecks(seedIndex) {
  const viral = 38 + ((seedIndex * 17) % 46);
  const warn = seedIndex % 5 === 0;
  const low = viral < 45;
  // Демо-данные должны быть непротиворечивы: опубликованный ролик не может
  // быть заблокирован комплаенсом. Правило «лёгких денег» — предупреждение,
  // а не блок, поэтому в блокировки оно не попадает.
  const compliance = {
    ok: true,
    score: warn ? 88 : 96,
    platform: seedIndex % 2 ? 'tiktok' : 'reels',
    blocking: [],
    warnings: warn ? [{ id: 'headline-claim', severity: 'warn', reason: 'Есть признаки рекламы, но нет пометки — Pulse добавит её сам', match: 'скидк' }] : [],
    findings: [],
    limits: { captionMax: 2200, hashtagsRecommended: 6, publishPer24h: seedIndex % 2 ? 15 : 50 },
    labels: { ad: true, ai: true },
  };
  const viralMeta = {
    score: viral,
    grade: viral >= 75 ? 'high' : viral >= 55 ? 'medium' : 'low',
    factors: [
      { id: 'hook', label: 'Хук первой фразы', value: Math.min(95, viral + 9), weight: 0.3, detail: 'вопрос в первой фразе' },
      { id: 'length', label: 'Длительность', value: 100, weight: 0.16, detail: '26 с — оптимум 18–34 с' },
      { id: 'pace', label: 'Темп речи', value: Math.min(96, viral + 4), weight: 0.14, detail: '2,2 слов/с — оптимум 1,8–2,8' },
      { id: 'retention', label: 'Удержание', value: Math.max(30, viral - 6), weight: 0.18, detail: '5 сцен, есть обещание в конце' },
      { id: 'caption', label: 'Описание и теги', value: Math.min(94, viral + 12), weight: 0.12, detail: '148 символов, 6 тегов' },
      { id: 'novelty', label: 'Новизна темы', value: 74, weight: 0.1, detail: 'тема выходила один раз — нужен новый угол' },
    ],
    advice: low ? ['Перепишите первую фразу: вопрос, число или конфликт в первых 12 словах.', 'Сократите ролик до 18–34 секунд — там лучшая досматриваемость.'] : [],
    confidence: 'эвристика по 6 признакам, не прогноз алгоритма',
    meta: { durationSec: 26, words: 57, wps: 2.2, scenes: 5 },
    computed_at: new Date().toISOString(),
  };
  return { compliance, viralMeta, viral };
}

const EPISODE_COST_CENTS = 6600; // 66 ₽: видео 45 + TTS 12 + LLM 8 + рендер 1
const LOG_SEED = [
  ['success', 'publisher', 'episode.published', 'Опубликовано: «Почему автопостинг убивает охваты» (Reels)'],
  ['info', 'engine', 'episode.script', 'Сценарий готов: 4 сцены, риск 22/100'],
  ['info', 'provider.video.nvidia', 'episode.footage', 'Видеоряд сгенерирован (NVIDIA NIM, demo)'],
  ['warn', 'guard', 'publish.throttled', 'Нет свободного аккаунта: квоты исчерпаны. Перенос на 20:15'],
  ['success', 'autopilot', 'autopilot.fill', 'Автопилот добавил в конвейер: «5 привычек, которые стоят 10 минут»'],
  ['info', 'provider.tts', 'episode.voice', 'Озвучка готова: 31 с, провайдер demo'],
  ['error', 'queue', 'job.retry', 'Задача episode.render: 429 rate limit, повтор через 40 с'],
  ['info', 'user', 'settings.updated', 'Настройки конвейера изменены'],
  ['success', 'user', 'episode.approved', 'Ролик подтверждён и поставлен в расписание'],
  ['warn', 'user', 'account.updated', 'Аккаунт @momentum.app помечен как cooldown — нагрузка перераспределена'],
  ['info', 'user', 'product.added', 'Продукт «Pulse Pro» добавлен в продвижение'],
  ['success', 'engine', 'episode.ready', 'Ролик собран и запланирован'],
];

function truncateAll() {
  // Порядок важен: сначала зависимые таблицы. Сериалы и их серии забывались —
  // каждый `npm run seed` оставлял ещё одну «Мёртвую станцию» в базе.
  const tables = ['series_episodes', 'series', 'campaign_posts', 'campaigns', 'brands', 'metrics_daily', 'conversions', 'clicks', 'publications', 'episodes', 'scripts', 'ideas', 'products', 'accounts', 'projects', 'jobs', 'logs', 'accounts_daily'];
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
}

// демо-реальность: лента активнее в определённые часы, поэтому охват зависит
// от локального времени публикации. Именно этот эффект потом «находит»
// engine/schedule.js на собственных данных — и показывает основу решения.
function hourBoost(publishedAt) {
  const tz = process.env.PULSE_TZ || 'Europe/Moscow';
  let hour = 12;
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(publishedAt))) % 24;
  } catch {}
  const peaks = hour >= 11 && hour <= 13 || hour >= 18 && hour <= 21;
  const shoulder = hour >= 9 && hour <= 22;
  if (peaks) return 1.22;
  if (shoulder) return 1;
  return 0.62;
}

function makePublicationsFor(episode, project, accounts, rnd, publishedAt) {
  const platforms = ['reels'];
  if (rnd() > 0.4) platforms.push('tiktok');
  // Shorts — не «копия везде»: только часть роликов, иначе охват размывается
  if (rnd() > 0.6) platforms.push('youtube');
  const out = [];
  for (const platform of platforms) {
    // аккаунт публикует только контент своего бренда — история не смешивается
    const pool = accounts.filter((a) => a.platform === platform && a.status !== 'blocked'
      && (!a.project_id || !project?.id || a.project_id === project.id));
    if (!pool.length) continue;
    const account = pool[Math.floor(rnd() * pool.length)];
    const variants = platform === 'youtube' || rnd() <= 0.55 ? ['A'] : ['A', 'B']; // у Shorts A/B не делаем
    const viral = rnd() < 0.14 ? 5 + rnd() * 8 : 1;
    const base = 900 + rnd() * 2200;
    // у Shorts ниже базовый охват, но выше «долгий хвост»: множитель честнее
    const platformFactor = platform === 'youtube' ? 0.75 : 1;
    const targetA = Math.round(base * viral * platformFactor * (1 + account.quality / 260) * hourBoost(publishedAt));
    for (const variant of variants) {
      // оба варианта A/B живут на одном аккаунте, разница только в обложке/описании
      const target = Math.round(targetA * (variant === 'B' ? 0.7 + rnd() * 0.6 : 1));
      out.push({ platform, account, variant, target });
    }
  }
  return out;
}

/**
 * Паспорт демо-ролика. Демо-данные не проходили конвейер, но карточка ролика
 * должна выглядеть как настоящая: видно, кто делает каждый шаг. Все шаги, кроме
 * текста, помечены `demo` — это данные, а не реальный вызов провайдера.
 */
function seedPassport(episodeId, { stage = 'published', publishedAt = null, title = '', handle = null, platforms = [] } = {}) {
  const at = publishedAt || nowIso();
  const meta = {
    idea: { provider: 'idea-library', model: 'автопилот', note: String(title).slice(0, 80), at },
    script: { provider: 'template', model: 'Content Brain', note: 'демо-данные: текст собран шаблонами', at },
  };
  const done = ['voice', 'footage', 'edit', 'ready', 'published'];
  if (done.includes(stage)) {
    meta.voice = { provider: 'edge', model: 'ru-RU-DmitryNeural', note: '31 с', demo: true, at };
    meta.footage = { provider: 'pollinations', model: 'flux', note: 'кадры по сценам', demo: true, at };
    meta.render = { provider: 'ffmpeg', model: '1080×1920 @ 30 fps', ms: 2600, note: 'со звуком', demo: true, at };
  } else if (stage === 'voice') {
    meta.voice = { provider: 'edge', model: 'ru-RU-DmitryNeural', note: '31 с', demo: true, at };
  }
  if (stage === 'published' && handle) {
    meta.publish = {
      provider: 'platform-api', model: `@${handle}`,
      note: platforms.map((x) => ({ reels: 'Instagram Reels', tiktok: 'TikTok', youtube: 'YouTube Shorts' }[x] || x)).join(', '),
      platforms, demo: true, at,
    };
  }
  try {
    db.prepare('UPDATE episodes SET ai_meta = ? WHERE id = ?').run(JSON.stringify(meta), episodeId);
  } catch { /* паспорт не должен ломать посев */ }
  return meta;
}

export async function seedBase() {
  ensureSettings();
  // демо-проект условно прошёл аудит Google: иначе вся история Shorts была бы приватной
  // и экран роста показывал бы нули. В live это включает владелец после проверки проекта.
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'youtube_audited'").run();
  const rnd = seededRandom('pulse-demo-v1');
  const ts = nowIso();

  const projectIds = {};
  for (const p of PROJECTS) {
    const id = uid('pr_');
    projectIds[p.key] = id;
    db.prepare(`INSERT INTO projects (id, name, niche, description, product_url, language, tone, format, aspect, duration_sec, autopilot, posts_per_day, ab_tests, color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ru', 'friendly', ?, '9:16', 32, 1, ?, 1, ?, ?, ?)`)
      .run(id, p.name, p.niche, p.description, p.product_url, p.format, p.posts_per_day, p.color,
        addDays(ts, -60), addDays(ts, -1));
  }

  const accountRows = [];
  for (const a of ACCOUNTS) {
    const id = uid('ac_');
    const projectId = projectIds[a.project] || null;
    db.prepare(`INSERT INTO accounts (id, platform, handle, display_name, avatar_hue, status, daily_limit, min_gap_min, window_start, window_end, timezone, quality, notes, followers, followers_source, followers_updated_at, project_id, topic, language, visual_style, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '09:00', '23:00', 'Europe/Moscow', ?, '', ?, 'seed', ?, ?, ?, 'ru', 'cinematic', ?, ?)`)
      .run(id, a.platform, a.handle, a.display_name, a.hue, a.status, a.daily_limit, a.min_gap_min, a.quality,
        a.followers || 0, ts, projectId, a.topic || '', addDays(ts, -(60 + Math.floor(rnd() * 240))), ts);
    accountRows.push({ ...a, id, project_id: projectId });
  }

  const productRows = [];
  for (const p of PRODUCTS) {
    const id = uid('pd_');
    db.prepare(`INSERT INTO products (id, name, url, pitch, proof, template, utm_source, utm_medium, utm_campaign, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(id, p.name, p.url, p.pitch, p.proof, p.template, p.utm_source, p.utm_medium, p.utm_campaign, addDays(ts, -45));
    productRows.push({ ...p, id });
  }

  // ── история: 21 день публикаций ───────────────────────────────────────────
  let publishedCount = 0;
  const insertPub = db.prepare(`INSERT INTO publications (id, episode_id, project_id, account_id, platform, variant, title, description, hashtags, cover_seed, click_token, url, status, scheduled_at, published_at, views, likes, comments, shares, clicks, followers, watch_avg, target_views, privacy, cost_cents, created_at)
    VALUES (@id, @episode_id, @project_id, @account_id, @platform, @variant, @title, @description, @hashtags, @cover_seed, @click_token, @url, 'published', @published_at, @published_at, 0, 0, 0, 0, 0, 0, 0, @target_views, @privacy, @cost_cents, @published_at)`);
  const insertMetric = db.prepare(`INSERT OR REPLACE INTO metrics_daily (id, publication_id, day, views, likes, comments, shares, clicks, followers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const [idx, p] of PROJECTS.entries()) {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectIds[p.key]);
    const product = productRows[idx];
    const ideas = generateIdeas(project, { count: 14, product });
    const ideaRows = [];
    for (const i of ideas) {
      const id = uid('id_');
      const status = rnd() > 0.72 ? 'used' : 'new';
      db.prepare(`INSERT INTO ideas (id, project_id, title, hook, angle, format, tags, score, source, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'template', ?, ?)`)
        .run(id, project.id, i.title, i.hook, i.angle, i.format, JSON.stringify(i.tags), i.score, status, addDays(ts, -(20 - idx * 3)));
      ideaRows.push({ ...i, id, status });
    }

    const postsPerDay = p.posts_per_day;
    for (let d = 20; d >= 1; d--) {
      const postsToday = Math.max(1, Math.round(postsPerDay * (0.7 + rnd() * 0.7)));
      for (let k = 0; k < postsToday; k++) {
        const idea = ideaRows[Math.floor(rnd() * ideaRows.length)];
        // 80/20: продаём не в каждом ролике, иначе падает досмотр и охват.
        // Детерминированно: каждый 4-й выпуск — прямой CTA, остальные — польза.
        const promoDirect = (d + k) % 4 === 0;
        const episodeProduct = promoDirect ? product : null;
        const script = buildScript(project, idea, { product: episodeProduct, platform: 'reels', duration: project.duration_sec });
        // публикуем в локальные часы (11:00 и 19:00 — пики ленты), а не «сейчас + 9 часов»
        const dayParts = localParts(addDays(ts, -d), process.env.PULSE_TZ || 'Europe/Moscow');
        const hourSlot = [11, 19, 15][k % 3];
        const publishedAt = zonedToUtc(dayParts.year, dayParts.month, dayParts.day, hourSlot, Math.floor(rnd() * 50), process.env.PULSE_TZ || 'Europe/Moscow').toISOString();
        const episodeId = uid('ep_');
        const scriptId = uid('sc_');
        db.prepare(`INSERT INTO scripts (id, idea_id, project_id, hook, scenes, cta, caption, hashtags, duration_sec, tone, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'friendly', 'approved', ?)`)
          .run(scriptId, idea.id, project.id, script.hook, JSON.stringify(script.scenes), script.cta, script.caption,
            JSON.stringify(script.hashtags), script.duration_sec, publishedAt);
        const risk = riskScore(`${idea.title} ${script.caption}`);
        db.prepare(`INSERT INTO episodes (id, project_id, idea_id, script_id, product_id, account_id, title, description, hashtags, scenes, cover_seed, topic, format, status, stage, progress, risk, error, attempts, autopilot, ab_test, scheduled_at, published_at, cost_cents, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'published', 'published', 100, ?, NULL, 1, 1, 1, ?, ?, ?, ?, ?)`)
          .run(episodeId, project.id, idea.id, scriptId, episodeProduct?.id || null, idea.title, script.caption,
            JSON.stringify(script.hashtags), JSON.stringify(script.scenes), `${episodeId}-${idea.title}`,
            idea.title, idea.format, risk, publishedAt, publishedAt, EPISODE_COST_CENTS, publishedAt, publishedAt);

        const demo = demoChecks(d + k);
        db.prepare('UPDATE episodes SET compliance = ?, viral = ?, viral_meta = ? WHERE id = ?')
          .run(JSON.stringify(demo.compliance), demo.viral, JSON.stringify(demo.viralMeta), episodeId);
        const pubList = makePublicationsFor(null, project, accountRows, rnd, publishedAt);
        seedPassport(episodeId, {
          stage: 'published', publishedAt, title: idea.title,
          handle: pubList[0]?.account?.handle || null,
          platforms: pubList.map((x) => x.platform),
        });
        for (const pub of pubList) {
          const pid = uid('pb_');
          insertPub.run({
            id: pid, episode_id: episodeId, project_id: project.id, account_id: pub.account.id,
            platform: pub.platform, variant: pub.variant, title: idea.title,
            description: script.caption, hashtags: JSON.stringify(hashtagsFor(project, pub.platform, idea)),
            cover_seed: `${episodeId}-${pub.variant}`,
            click_token: uid('ct_').replace(/[^a-z0-9]/gi, '').slice(0, 18),
            privacy: pub.platform === 'tiktok' ? 'SELF_ONLY' : 'public',
            cost_cents: Math.round(EPISODE_COST_CENTS / Math.max(1, pubList.length)),
            url: pub.platform === 'tiktok'
              ? `https://www.tiktok.com/@${pub.account.handle}/video/${Math.floor(rnd() * 9e17)}`
              : pub.platform === 'youtube'
                ? `https://www.youtube.com/shorts/${Math.floor(rnd() * 1e12).toString(36)}`
                : `https://www.instagram.com/reel/${Math.floor(rnd() * 9e9).toString(36)}/`,
            published_at: publishedAt, target_views: pub.target,
          });
          publishedCount++;

          // дневные метрики: накопленный рост по кривой
          const ageDays = (Date.now() - new Date(publishedAt).getTime()) / 86400000;
          let prevViews = 0, prevLikes = 0, prevClicks = 0, prevFollowers = 0;
          for (let dd = 0; dd <= Math.floor(ageDays); dd++) {
            const day = addDays(publishedAt, dd).slice(0, 10);
            const ageH = dd * 24 + 6;
            const cum = growthCurve(ageH);
            const views = Math.round(pub.target * cum * (0.98 + rnd() * 0.04));
            if (views <= prevViews) continue;
            const likes = Math.round(views * (0.05 + rnd() * 0.035));
            const clicks = Math.round(views * (0.012 + rnd() * 0.012));
            const followers = Math.round(views * 0.0035);
            insertMetric.run(`${pid}:${day}`, pid, day, views - prevViews, likes - prevLikes,
              Math.round((views - prevViews) * 0.006), Math.round((views - prevViews) * 0.009),
              clicks - prevClicks, followers - prevFollowers);
            prevViews = views; prevLikes = likes; prevClicks = clicks; prevFollowers = followers;
          }
          // итоговые значения публикации должны совпадать с суммой дневных приростов,
          // иначе сборщик аналитики запишет в «сегодня» всю накопленную сумму
          // удержание: база площадки × качество аккаунта + бонус за «залетевший» ролик.
          // Диапазон честный: 45–85%, а не «красивые» 99% у всех подряд.
          const baseRetention = pub.platform === 'youtube' ? 52 : pub.platform === 'tiktok' ? 46 : 50;
          const retention = baseRetention + (pub.account.quality - 70) * 0.25 + (pub.target > 6000 ? 12 : 0) + rnd() * 8;
          db.prepare(`UPDATE publications SET views = ?, likes = ?, comments = ?, shares = ?, clicks = ?, followers = ?, watch_avg = ? WHERE id = ?`)
            .run(prevViews, prevLikes, Math.round(prevViews * 0.006), Math.round(prevViews * 0.009), prevClicks, prevFollowers,
              Math.round(Math.min(88, Math.max(38, retention)) * 10) / 10, pid);
        }
      }
    }
  }

  // ── будущее расписание и текущая работа конвейера ────────────────────────
  const projectKeys = Object.keys(projectIds);
  const now = Date.now();
  const queuePlan = [
    { status: 'scheduled', stage: 'ready', progress: 100, offsetMin: 38 },
    { status: 'scheduled', stage: 'ready', progress: 100, offsetMin: 165 },
    { status: 'scheduled', stage: 'ready', progress: 100, offsetMin: 320 },
    { status: 'review', stage: 'ready', progress: 100, offsetMin: 25, risk: 68 },
    { status: 'generating', stage: 'voice', progress: 46, offsetMin: 0 },
    { status: 'generating', stage: 'footage', progress: 66, offsetMin: 0 },
    { status: 'queued', stage: 'idea', progress: 6, offsetMin: 0 },
    { status: 'failed', stage: 'footage', progress: 66, offsetMin: 0, error: 'Провайдер видео вернул 429 (rate limit) — 3 попытки исчерпаны' },
  ];

  for (const [i, plan] of queuePlan.entries()) {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectIds[projectKeys[i % projectKeys.length]]);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productRows[i % productRows.length].id);
    const idea = db.prepare("SELECT * FROM ideas WHERE project_id = ? ORDER BY RANDOM() LIMIT 1").get(project.id);
    const script = buildScript(project, idea, { product, platform: 'reels', duration: project.duration_sec });
    const scheduledAt = plan.offsetMin > 0 ? new Date(now + plan.offsetMin * 60000).toISOString() : null;
    const episodeId = uid('ep_');
    db.prepare(`INSERT INTO episodes (id, project_id, idea_id, script_id, product_id, account_id, title, description, hashtags, scenes, cover_seed, topic, format, status, stage, progress, risk, error, attempts, autopilot, ab_test, scheduled_at, published_at, cost_cents, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, NULL, ?, ?, ?)`)
      .run(episodeId, project.id, idea?.id || null, null, product.id, idea?.title || 'Новый ролик', script.caption,
        JSON.stringify(script.hashtags), JSON.stringify(script.scenes), `${episodeId}-${idea?.title}`,
        idea?.title || 'Новый ролик', idea?.format || project.format, plan.status, plan.stage, plan.progress,
        plan.risk || riskScore(script.caption), plan.error || null, scheduledAt, EPISODE_COST_CENTS,
        new Date(now - (plan.status === 'scheduled' ? 60000 : 300000)).toISOString(),
        new Date(now - (plan.status === 'scheduled' ? 60000 : 300000)).toISOString());
    seedPassport(episodeId, { stage: plan.stage, title: idea?.title || '' });
  }

  // ── реклама: бренды и живые кампании ────────────────────────────────────
  // Нужны, чтобы экран «Реклама» сразу показывал реальные деньги: кто платит,
  // сколько выходов сделано, что уже оплачено и где не хватает маркировки.
  const CAMPAIGNS = [
    {
      brand: { name: 'Nordwind', legal_name: 'ООО «Нордвинд»', inn: '7701234567', contact: 'ads@nordwind.ru' },
      name: 'Nordwind — зимняя капсула', model: 'fixed', budget: 180000, rate: 45000, posts_target: 4, deliver: 4,
      status: 'active', erid: '2VtzqxP9dKf', mention: '@nordwind', hashtags: ['#nordwind', '#зима'],
      brief: 'Показать 3 вещи из капсулы, без «купите» — сценарий через личный опыт. Обязательно erid и @nordwind.',
      days: [-6, 12], daily_cap: 1,
    },
    {
      brand: { name: 'FitFlow', legal_name: 'ИП Соколова А. В.', inn: '770987654321', contact: 'brand@fitflow.ru' },
      name: 'FitFlow — приложение тренировок', model: 'cpm', budget: 90000, rate: 320, posts_target: 24, deliver: 14,
      status: 'active', erid: '2VtzqwR4mNp', mention: '@fitflow.app', hashtags: ['#fitflow', '#тренировки'],
      brief: 'Сторителлинг «как я бросил зал и вернулся», CTA в описании, ссылка в шапке.',
      days: [-14, 20], daily_cap: 2,
    },
    {
      brand: { name: 'Skillkit', legal_name: 'ООО «Скилкит»', inn: '7811223344', contact: 'partners@skillkit.io' },
      name: 'Skillkit — курсы по аналитике', model: 'cpa', budget: 150000, rate: 1200, posts_target: 26, deliver: 16,
      status: 'active', erid: '2VtzqxT7bLz', mention: '@skillkit', hashtags: ['#skillkit', '#аналитика'],
      brief: 'Разбор кейса + промокод PULSE20. Оплата за оплативших курс, постбэк приходит автоматически.',
      days: [-3, 30], daily_cap: 2,
    },
    {
      brand: { name: 'Nordwind', legal_name: 'ООО «Нордвинд»', inn: '7701234567', contact: 'ads@nordwind.ru' },
      name: 'Nordwind — бартер, осенняя съёмка', model: 'barter', budget: 0, rate: 0, posts_target: 2, deliver: 2,
      status: 'done', erid: '', marking: 'none', mention: '@nordwind', hashtags: ['#nordwind'],
      brief: 'Бартер: вещи за ролик. Деньги не начисляются, но выходы учитываются.',
      days: [-40, -12], daily_cap: 1,
    },
  ];

  const brandIds = new Map();
  const campaignRows = [];
  for (const c of CAMPAIGNS) {
    let brandId = brandIds.get(c.brand.name);
    if (!brandId) {
      brandId = uid('br_');
      db.prepare('INSERT INTO brands (id, name, legal_name, inn, contact, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(brandId, c.brand.name, c.brand.legal_name, c.brand.inn, c.brand.contact, '', addDays(ts, -60));
      brandIds.set(c.brand.name, brandId);
    }
    const id = uid('cm_');
    const startsAt = addDays(ts, c.days[0]);
    const endsAt = addDays(ts, c.days[1]);
    db.prepare(`INSERT INTO campaigns (id, brand_id, project_id, name, model, budget_cents, rate_cents, posts_target,
        starts_at, ends_at, status, brief, mention, link_url, hashtags, erid, marking, paid_cents, daily_cap, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 0, ?, ?, ?)`)
      .run(id, brandId, c.name, c.model, Math.round(c.budget * 100), Math.round(c.rate * 100), c.posts_target,
        startsAt, endsAt, c.status, c.brief, c.mention, JSON.stringify(c.hashtags), c.erid, c.marking || 'erid', c.daily_cap,
        addDays(ts, c.days[0]), addDays(ts, c.days[0]));
    campaignRows.push({ ...c, id, brandId, startsAt, endsAt });
  }

  // демо-трафик до раздачи кампаний: у CPA-модели уже есть конверсии для начислений
  if ((process.env.PULSE_MODE || 'demo') !== 'live') simulateTraffic({ budget: 60000 });

  // раздаём кампании части уже вышедших роликов и считаем деньги по факту просмотров
  // каждый выход = одна публикация (A/B на одном аккаунте — это два выхода)
  const pubPool = db.prepare(`SELECT pb.id pub_id, pb.views, pb.clicks, pb.published_at, e.id ep_id, e.description
    FROM publications pb JOIN episodes e ON e.id = pb.episode_id
    WHERE pb.status = 'published'
      AND EXISTS (SELECT 1 FROM clicks c WHERE c.publication_id = pb.id)
    ORDER BY pb.published_at DESC`).all();
  const convByPub = new Map(db.prepare('SELECT publication_id pid, COUNT(*) n FROM conversions WHERE publication_id IS NOT NULL GROUP BY publication_id')
    .all().map((r) => [r.pid, r.n]));
  let cursor = 0;
  let campaignPosts = 0;
  for (const campaign of campaignRows) {
    const disclosure = disclosureFor({ brand_id: campaign.brandId, erid: campaign.erid, marking: 'erid' });
    const touched = new Set();
    const quota = Math.min(campaign.posts_target, campaign.deliver ?? campaign.posts_target);
    for (let taken = 0; taken < quota && cursor < pubPool.length; taken++) {
      const pub = pubPool[cursor++];
      if (!touched.has(pub.ep_id)) {
        touched.add(pub.ep_id);
        db.prepare('UPDATE episodes SET campaign_id = ?, ad_disclosure = ? WHERE id = ?')
          .run(campaign.id, disclosure, pub.ep_id);
      }
      const revenue = revenueFor(
        { model: campaign.model, rate_cents: Math.round(campaign.rate * 100), posts_target: campaign.posts_target },
        { views: pub.views, clicks: pub.clicks, conversions: convByPub.get(pub.pub_id) || 0 },
      );
      db.prepare('INSERT INTO campaign_posts (id, campaign_id, episode_id, publication_id, revenue_cents, views, clicks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uid('cp_'), campaign.id, pub.ep_id, pub.pub_id, revenue, pub.views, pub.clicks, pub.published_at);
      campaignPosts++;
    }
  }

  // метрики досинхронизируются так же, как в проде после сбора аналитики
  syncCampaignMetrics();

  // кампании, где все выходы сделаны, закрываются автоматически
  for (const campaign of campaignRows) {
    const done = db.prepare('SELECT COUNT(*) n FROM campaign_posts WHERE campaign_id = ?').get(campaign.id).n;
    if (done >= campaign.posts_target) db.prepare("UPDATE campaigns SET status = 'done' WHERE id = ?").run(campaign.id);
  }

  // оплаты: часть счетов уже закрыта, часть — в дебиторке (видно на экране «Реклама»)
  for (const c of campaignRows) {
    const earned = db.prepare('SELECT COALESCE(SUM(revenue_cents),0) v FROM campaign_posts WHERE campaign_id = ?').get(c.id).v;
    const status = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(c.id).status;
    // закрытая кампания закрыта и по деньгам, активная — частично оплачена (дебиторка видна на экране)
    const paid = status === 'done' ? earned : Math.round(earned * 0.6);
    db.prepare('UPDATE campaigns SET paid_cents = ? WHERE id = ?').run(paid, c.id);
  }

  // ── журнал ────────────────────────────────────────────────────────────────
  for (let i = 0; i < 24; i++) {
    const [level, actor, action, message] = LOG_SEED[i % LOG_SEED.length];
    db.prepare('INSERT INTO logs (id, ts, level, actor, action, entity_type, entity_id, message, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid('log_'), new Date(now - i * 1000 * 60 * (6 + rnd() * 18)).toISOString(), level, actor, action, 'system', '', message, '{}');
  }

  // ── демо-сериал ───────────────────────────────────────────────────────────
  // Пустой раздел «Сериалы» на первом запуске выглядит как недоделка. Держим один
  // готовый сериал с серией в стадии сценария: видно формат, экономику и автопилот.
  try {
    const { createSeries, composeEpisode } = await import('../engine/series.js');
    const series = createSeries({
      title: 'Мёртвая станция',
      genre: 'zombie',
      episodesPlanned: 8,
      episodeSec: 900,
      logline: 'Двенадцать выживших держат последнюю станцию метро — и не говорят, что живёт в тоннеле.',
    });
    const ep = composeEpisode({ seriesId: series.id, episodeNo: 1 });
    db.prepare("UPDATE series SET auto_compose = 1, lookahead = 3 WHERE id = ?").run(series.id);
    if (ep?.id) db.prepare("UPDATE series_episodes SET stage = 'script' WHERE id = ?").run(ep.id);
  } catch (err) {
    log({ level: 'warn', actor: 'seed', action: 'seed.series_failed', message: `Демо-сериал не создан: ${String(err.message || err).slice(0, 160)}` });
  }

  return { projects: PROJECTS.length, accounts: ACCOUNTS.length, publications: publishedCount };
}

export async function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) n FROM projects').get().n;
  if (count > 0) return false;
  const res = await seedBase();
  log({ level: 'success', actor: 'system', action: 'seed.created', message: `Демо-стенд готов: ${res.projects} проекта, ${res.publications} публикаций в истории` });
  return true;
}

export async function reseed() {
  truncateAll();
  await seedBase();
  log({ level: 'success', actor: 'system', action: 'seed.reseed', message: 'Демо-данные пересозданы' });
  return true;
}
