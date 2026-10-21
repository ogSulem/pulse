// ─────────────────────────────────────────────────────────────────────────────
// Демо-данные. Нужны, чтобы панель была «живой» сразу после docker compose up.
// Отключаются переменной PULSE_SEED=0.
// ─────────────────────────────────────────────────────────────────────────────
import { db, nowIso, ensureSettings } from '../core/db.js';
import { uid, seededRandom, addDays, addMinutes } from '../core/utils.js';
import { buildScript, hashtagsFor, generateIdeas, riskScore, COVER_PALETTES } from '../engine/brain.js';
import { growthCurve } from '../engine/pipeline.js';
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

const ACCOUNTS = [
  { platform: 'reels', handle: 'pulse.studio', display_name: 'Pulse Studio', status: 'healthy', daily_limit: 3, min_gap_min: 110, quality: 92, hue: 268 },
  { platform: 'reels', handle: 'momentum.app', display_name: 'Momentum', status: 'healthy', daily_limit: 3, min_gap_min: 95, quality: 84, hue: 250 },
  { platform: 'reels', handle: 'fitflow.daily', display_name: 'FitFlow Daily', status: 'warmup', daily_limit: 2, min_gap_min: 140, quality: 71, hue: 300 },
  { platform: 'tiktok', handle: 'pulse.studio', display_name: 'Pulse', status: 'healthy', daily_limit: 3, min_gap_min: 90, quality: 88, hue: 275 },
  { platform: 'tiktok', handle: 'momentum.app', display_name: 'Momentum', status: 'cooldown', daily_limit: 2, min_gap_min: 120, quality: 63, hue: 240 },
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
  const compliance = {
    ok: !low,
    score: low ? 64 : 92,
    platform: seedIndex % 2 ? 'tiktok' : 'reels',
    blocking: low ? [{ id: 'fin-getrich', severity: 'block', reason: 'Формулировка «лёгких денег»: площадки понижают охват и могут ограничить аккаунт', match: 'заработа' }] : [],
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
  const tables = ['metrics_daily', 'publications', 'episodes', 'scripts', 'ideas', 'products', 'accounts', 'projects', 'jobs', 'logs', 'accounts_daily'];
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
}

function makePublicationsFor(episode, project, accounts, rnd, publishedAt) {
  const platforms = rnd() > 0.45 ? ['reels', 'tiktok'] : ['reels'];
  const out = [];
  for (const platform of platforms) {
    const pool = accounts.filter((a) => a.platform === platform && a.status !== 'blocked');
    if (!pool.length) continue;
    const account = pool[Math.floor(rnd() * pool.length)];
    const variants = rnd() > 0.55 ? ['A', 'B'] : ['A'];
    const viral = rnd() < 0.14 ? 5 + rnd() * 8 : 1;
    const base = 900 + rnd() * 2200;
    const targetA = Math.round(base * viral * (1 + account.quality / 260));
    for (const variant of variants) {
      // оба варианта A/B живут на одном аккаунте, разница только в обложке/описании
      const target = Math.round(targetA * (variant === 'B' ? 0.7 + rnd() * 0.6 : 1));
      out.push({ platform, account, variant, target });
    }
  }
  return out;
}

export function seedBase() {
  ensureSettings();
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
    db.prepare(`INSERT INTO accounts (id, platform, handle, display_name, avatar_hue, status, daily_limit, min_gap_min, window_start, window_end, timezone, quality, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '09:00', '23:00', 'Europe/Moscow', ?, '', ?, ?)`)
      .run(id, a.platform, a.handle, a.display_name, a.hue, a.status, a.daily_limit, a.min_gap_min, a.quality,
        addDays(ts, -(60 + Math.floor(rnd() * 240))), ts);
    accountRows.push({ ...a, id });
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?)`)
        .run(id, project.id, i.title, i.hook, i.angle, i.format, JSON.stringify(i.tags), i.score, status, addDays(ts, -(20 - idx * 3)));
      ideaRows.push({ ...i, id, status });
    }

    const postsPerDay = p.posts_per_day;
    for (let d = 20; d >= 1; d--) {
      const postsToday = Math.max(1, Math.round(postsPerDay * (0.7 + rnd() * 0.7)));
      for (let k = 0; k < postsToday; k++) {
        const idea = ideaRows[Math.floor(rnd() * ideaRows.length)];
        const script = buildScript(project, idea, { product, platform: 'reels', duration: project.duration_sec });
        const publishedAt = addMinutes(addDays(ts, -d), 9 * 60 + k * 300 + Math.floor(rnd() * 90));
        const episodeId = uid('ep_');
        const scriptId = uid('sc_');
        db.prepare(`INSERT INTO scripts (id, idea_id, project_id, hook, scenes, cta, caption, hashtags, duration_sec, tone, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'friendly', 'approved', ?)`)
          .run(scriptId, idea.id, project.id, script.hook, JSON.stringify(script.scenes), script.cta, script.caption,
            JSON.stringify(script.hashtags), script.duration_sec, publishedAt);
        const risk = riskScore(`${idea.title} ${script.caption}`);
        db.prepare(`INSERT INTO episodes (id, project_id, idea_id, script_id, product_id, account_id, title, description, hashtags, scenes, cover_seed, topic, format, status, stage, progress, risk, error, attempts, autopilot, ab_test, scheduled_at, published_at, cost_cents, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'published', 'published', 100, ?, NULL, 1, 1, 1, ?, ?, ?, ?, ?)`)
          .run(episodeId, project.id, idea.id, scriptId, product.id, idea.title, script.caption,
            JSON.stringify(script.hashtags), JSON.stringify(script.scenes), `${episodeId}-${idea.title}`,
            idea.title, idea.format, risk, publishedAt, publishedAt, EPISODE_COST_CENTS, publishedAt, publishedAt);

        const demo = demoChecks(d + k);
        db.prepare('UPDATE episodes SET compliance = ?, viral = ?, viral_meta = ? WHERE id = ?')
          .run(JSON.stringify(demo.compliance), demo.viral, JSON.stringify(demo.viralMeta), episodeId);
        const pubList = makePublicationsFor(null, project, accountRows, rnd, publishedAt);
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
          db.prepare(`UPDATE publications SET views = ?, likes = ?, comments = ?, shares = ?, clicks = ?, followers = ?, watch_avg = ? WHERE id = ?`)
            .run(prevViews, prevLikes, Math.round(prevViews * 0.006), Math.round(prevViews * 0.009), prevClicks, prevFollowers,
              Math.round((24 + rnd() * 18) * 10) / 10, pid);
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
  }

  // ── журнал ────────────────────────────────────────────────────────────────
  for (let i = 0; i < 24; i++) {
    const [level, actor, action, message] = LOG_SEED[i % LOG_SEED.length];
    db.prepare('INSERT INTO logs (id, ts, level, actor, action, entity_type, entity_id, message, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid('log_'), new Date(now - i * 1000 * 60 * (6 + rnd() * 18)).toISOString(), level, actor, action, 'system', '', message, '{}');
  }

  return { projects: PROJECTS.length, accounts: ACCOUNTS.length, publications: publishedCount };
}

export function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) n FROM projects').get().n;
  if (count > 0) return false;
  const res = seedBase();
  log({ level: 'success', actor: 'system', action: 'seed.created', message: `Демо-стенд готов: ${res.projects} проекта, ${res.publications} публикаций в истории` });
  return true;
}

export function reseed() {
  truncateAll();
  seedBase();
  log({ level: 'success', actor: 'system', action: 'seed.reseed', message: 'Демо-данные пересозданы' });
  return true;
}
