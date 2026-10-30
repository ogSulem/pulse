// ─────────────────────────────────────────────────────────────────────────────
// Smoke-тест: проверяет самые дорогие в отладке части системы без запуска сервера.
//   node server/scripts/smoke.mjs
// Возвращает ненулевой код, если что-то сломано — годится для CI и для проверки
// после обновления образа на VPS.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// изолируем артефакты теста, чтобы не засорять рабочий каталог data/
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-smoke-'));
process.env.PULSE_MEDIA_DIR = path.join(tmp, 'media');
// каталог данных тоже изолируем: boot.js пишет туда секрет и first-login.txt
process.env.PULSE_DATA_DIR = tmp;
process.env.PULSE_DB_PATH = path.join(tmp, 'smoke.db');
process.env.PULSE_MODE = process.env.PULSE_MODE || 'demo';

const results = [];
const ok = (name, extra = '') => results.push({ name, pass: true, extra });
const fail = (name, err) => results.push({ name, pass: false, extra: String(err?.message || err) });

const { migrate } = await import('../src/core/db.js');
const { renderEpisode, renderInfo } = await import('../src/engine/render.js');
const { checkCompliance } = await import('../src/engine/compliance.js');
const { scoreViral } = await import('../src/engine/viral.js');
const { moneySummary, transparency } = await import('../src/engine/money.js');
const { encryptSecret, decryptSecret } = await import('../src/core/secrets.js');
const { providers } = await import('../src/providers/index.js');
const { seedBase } = await import('../src/seed/seed.js');
const { disclosureFor, decorateCaption, revenueFor, adsOverview, campaignStats, pickCampaign } = await import('../src/engine/ads.js');

try {
  migrate();
  ok('база и миграции');
} catch (err) { fail('база и миграции', err); }

try {
  await seedBase();
  ok('демо-данные');
} catch (err) { fail('демо-данные', err); }

try {
  // Пересоздание демо-данных — идемпотентное: сериалы и их серии тоже чистятся,
  // иначе каждый `npm run seed` оставлял в базе ещё одну копию демо-сериала
  const { reseed } = await import('../src/seed/seed.js');
  const { db } = await import('../src/core/db.js');
  await reseed();
  await reseed();
  const series = db.prepare('SELECT COUNT(*) n FROM series').get().n;
  const episodes = db.prepare('SELECT COUNT(*) n FROM series_episodes').get().n;
  if (series !== 1) throw new Error(`после двух пересозданий сериалов ${series}, ожидался 1`);
  if (episodes < 1) throw new Error('серии демо-сериала не создались');
  ok('демо-данные без дублей', `сериалов ${series}, серий ${episodes}`);
} catch (err) { fail('демо-данные без дублей', err); }

// ── рендер ──────────────────────────────────────────────────────────────────
const info = renderInfo();
if (!info.available) fail('рендер доступен', `ffmpeg=${info.ffmpeg} sharp=${info.sharp} fonts=${info.fonts}`);
else {
  ok('рендер доступен', `${info.width}×${info.height} @ ${info.fps} fps`);
  try {
    const started = Date.now();
    const res = await renderEpisode({
      episode: { id: 'ep_smoke', title: 'Смоук-тест рендера: кириллица и цифры 2026' },
      project: { name: 'Pulse' },
      scenes: [
        { text: 'Текст первой сцены с «кавычками» и тире — проверяем переносы', seconds: 3 },
        { text: 'Вторая сцена короче', seconds: 2 },
        { text: 'Третья сцена для проверки склейки и тайминга', seconds: 3 },
      ],
      handle: 'pulse.studio',
    });
    const size = fs.statSync(res.videoAbs).size;
    if (!res.ok || size < 50_000) throw new Error(`файл слишком мал: ${size} байт`);
    if (res.width < 1080 || res.height < 1920) throw new Error(`кадр не вертикаль 1080×1920: ${res.width}×${res.height}`);
    if (res.coverPaths?.A && !fs.existsSync(path.join(tmp, 'media', path.basename(res.coverPaths.A)))) throw new Error('обложка A не создана');
    ok('сборка mp4 и обложек', `${res.durationSec} с, ${(size / 1024 / 1024).toFixed(1)} МБ, ${Date.now() - started} мс`);
  } catch (err) { fail('сборка mp4 и обложек', err); }
}

// ── комплаенс ───────────────────────────────────────────────────────────────
try {
  const bad = checkCompliance({ title: 'Гарантированный доход и лечит всё', scenes: [{ text: '100% гарантия' }], platform: 'tiktok' });
  if (bad.ok) throw new Error('опасный текст прошёл проверку');
  const good = checkCompliance({ title: 'Как вести контент-план без выгорания', scenes: [{ text: 'Три шага' }], platform: 'reels' });
  if (!good.ok) throw new Error(`безобидный текст заблокирован: ${good.blocking.map((b) => b.id).join(',')}`);
  ok('правила площадок', `${bad.blocking.length} блокировок на опасном тексте, 0 на безопасном`);
} catch (err) { fail('правила площадок', err); }

// ── вирусный скор ───────────────────────────────────────────────────────────
try {
  const weak = scoreViral({ title: 'Новость', scenes: [{ text: 'Просто текст', seconds: 3 }], description: '', hashtags: [] });
  const strong = scoreViral({
    title: 'Почему ты теряешь охваты каждый день?',
    scenes: [
      { text: 'Почему ты теряешь охваты каждый день?', seconds: 4 },
      { text: '3 причины, которые видно в первые 2 секунды', seconds: 5 },
      { text: 'Вот что делать вместо этого', seconds: 5 },
      { text: 'Сохрани и проверь свой профиль — смотри до конца', seconds: 5 },
    ],
    description: 'Разбор на 20 секунд: хук, длина, темп. Сохрани, чтобы не потерять.',
    hashtags: ['reels', 'контент', 'продвижение', 'smm', 'охваты'],
  });
  if (!(strong.score > weak.score)) throw new Error(`сильный сценарий (${strong.score}) не выше слабого (${weak.score})`);
  if (!strong.factors?.length || !strong.advice) throw new Error('нет разбора по факторам');
  ok('вирусный скор', `сильный ${strong.score}, слабый ${weak.score}`);
} catch (err) { fail('вирусный скор', err); }

// ── деньги и прозрачность ───────────────────────────────────────────────────
try {
  const m = moneySummary({ days: 30 });
  if (typeof m.totals.profit !== 'number') throw new Error('нет прибыли в сводке');
  if (!m.byPlatform.length) throw new Error('нет разреза по площадкам — демо-данные неполные');
  ok('деньги', `${m.totals.profit} ${m.currency} прибыли, ROI ${m.totals.roi ?? '—'}%`);
} catch (err) { fail('деньги', err); }

// ── реклама: маркировка, модели оплаты, раздача ──────────────────────────────
try {
  const brand = { legal_name: 'ООО «Нордвинд».', inn: '7701234567' };
  const campaign = { brand_id: 'br_smoke', erid: '2VtzqxP9dKf', marking: 'erid', mention: '@nordwind',
    hashtags: ['#nordwind'], posts_target: 4, rate_cents: 4500000, model: 'fixed' };
  // бренд в демо-базе не тот, поэтому проверяем на реальной кампании из сида
  const real = adsOverview().campaigns.find((c) => c.erid);
  if (!real) throw new Error('в демо-данных нет кампании с erid');
  const disclosure = disclosureFor(real);
  if (!/^Реклама\./.test(disclosure)) throw new Error(`нет пометки «Реклама»: ${disclosure}`);
  if (!/erid:/.test(disclosure)) throw new Error(`нет erid в маркировке: ${disclosure}`);
  if (/\.\./.test(disclosure)) throw new Error(`двойная точка в маркировке: ${disclosure}`);
  const decorated = decorateCaption('Три вещи из капсулы', real);
  if (!decorated.includes(real.mention)) throw new Error('@бренд не добавлен');
  if (!/#реклама/.test(decorated) || !/erid:/.test(decorated)) throw new Error('маркировка не попала в описание');
  if (decorateCaption(decorated, real) !== decorated) throw new Error('описание дублирует маркировку при повторной обработке');
  ok('маркировка рекламы', disclosure.slice(0, 64));
} catch (err) { fail('маркировка рекламы', err); }

try {
  const fixed = revenueFor({ model: 'fixed', rate_cents: 4500000, posts_target: 4 }, { views: 5000 });
  const cpm = revenueFor({ model: 'cpm', rate_cents: 32000 }, { views: 10000 });
  const cpa = revenueFor({ model: 'cpa', rate_cents: 120000 }, { conversions: 3 });
  const barter = revenueFor({ model: 'barter', rate_cents: 0 }, { views: 99999 });
  if (fixed !== 1125000) throw new Error(`фикс за выход: ${fixed}`);
  if (cpm !== 320000) throw new Error(`CPM: ${cpm}`);
  if (cpa !== 360000) throw new Error(`CPA: ${cpa}`);
  if (barter !== 0) throw new Error(`бартер должен быть 0: ${barter}`);
  ok('модели оплаты', 'фикс / CPM / CPA / бартер');
} catch (err) { fail('модели оплаты', err); }

try {
  const o = adsOverview();
  if (!o.campaigns.length) throw new Error('демо-кампании не созданы');
  if (!(o.totals.revenue > 0)) throw new Error('нет начислений по кампаниям');
  if (!(o.totals.posts > 0)) throw new Error('нет выходов по кампаниям');
  const cpa = o.campaigns.find((c) => c.model === 'cpa');
  if (!cpa || !(cpa.stats.revenue > 0)) throw new Error('CPA-кампания без начислений: конверсии не учтены');
  const over = o.campaigns.find((c) => c.budget > 0 && c.stats.revenue > c.budget + 0.01);
  if (over) throw new Error(`${over.name}: начисления ${over.stats.revenue} больше бюджета ${over.budget}`);
  const pick = pickCampaign({});
  if (!pick?.stats?.canPost) {
    const why = o.campaigns.map((c) => `${c.name}:${c.status}/canPost=${c.stats.canPost}/today=${c.stats.todayPosts}/${c.stats.dailyCap}/left=${c.stats.postsLeft}/budget=${c.stats.budgetLeft}/expired=${c.stats.expired}`).join('; ');
    throw new Error(`автораздача не находит кампанию с доступным выходом (${why})`);
  }
  ok('реклама в экономике', `${o.totals.active} активных, ${o.totals.revenue} ₽ начислено, ${o.totals.posts} выходов`);
} catch (err) { fail('реклама в экономике', err); }

try {
  const campaign = { marking: 'erid', erid: '', brand_id: 'x' };
  const missing = checkCompliance({ title: 'Как я собрал капсулу', scenes: [{ text: 'Три вещи' }], description: 'Три вещи из капсулы без пометки', platform: 'tiktok', campaign });
  if (missing.ok) throw new Error('кампания без erid прошла проверку');
  const withErid = checkCompliance({ title: 'Как я собрал капсулу', scenes: [{ text: 'Три вещи' }], platform: 'tiktok',
    campaign: { marking: 'erid', erid: '2VtzqxP9dKf', brand_id: 'x' },
    description: 'Текст #реклама erid: 2VtzqxP9dKf' });
  if (!withErid.ok) throw new Error(`корректная маркировка заблокирована: ${withErid.blocking.map((b) => b.id).join(',')}`);
  ok('маркировка в комплаенсе', 'без erid — блок, с erid и пометкой — пропуск');
} catch (err) { fail('маркировка в комплаенсе', err); }

try {
  const t = transparency();
  if (!t.checks.length) throw new Error('нет проверок');
  ok('прозрачность', `${t.checks.length} проверок, ${t.quotas.length} площадки`);
} catch (err) { fail('прозрачность', err); }

// ── секреты аккаунтов ───────────────────────────────────────────────────────
try {
  process.env.PULSE_SECRET = process.env.PULSE_SECRET || 'smoke-test-secret-value';
  const token = 'act.1234567890abcdef';
  const enc = encryptSecret(token);
  if (!enc.startsWith('enc:v1:')) throw new Error('токен не зашифрован');
  if (enc.includes(token)) throw new Error('токен виден в шифротексте');
  if (decryptSecret(enc) !== token) throw new Error('токен не расшифровывается');
  ok('шифрование токенов', 'AES-256-GCM, обратимо');
} catch (err) { fail('шифрование токенов', err); }

// ── публикация: контракт адаптеров (demo-режим) ─────────────────────────────
try {
  const res = await providers.publish.send({
    platform: 'tiktok',
    account: { handle: 'pulse.studio', access_token: null },
    description: 'Тестовый ролик #pulse',
    videoPath: null,
    privacy: 'SELF_ONLY',
  });
  if (!res.externalId || !res.url) throw new Error('нет externalId/url');
  if (res.privacy !== 'SELF_ONLY') throw new Error('приватность не учтена');
  const ig = await providers.publish.send({ platform: 'reels', account: { handle: 'pulse' }, description: 'x', privacy: 'public' });
  if (!ig.url.includes('instagram.com')) throw new Error('нет ссылки Instagram');
  ok('адаптеры публикации', 'TikTok SELF_ONLY + Reels, контракт единый');
} catch (err) { fail('адаптеры публикации', err); }

// ── очередь: переживает падение процесса ────────────────────────────────────
try {
  const { enqueue, claimDue, recoverOrphans, jobStats } = await import('../src/core/queue.js');
  const { db, nowIso } = await import('../src/core/db.js');
  const jobId = enqueue('smoke.noop', { probe: 1 });
  const claimed = claimDue(10).filter((j) => j.id === jobId);
  if (claimed.length !== 1) throw new Error('задача не выдана воркеру');
  db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ?").run('2999-01-01T00:00:00.000Z', jobId);
  const recovered = recoverOrphans();
  const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
  if (row.status !== 'pending') throw new Error(`статус после рестарта: ${row.status}`);
  if (recovered < 1) throw new Error('recoverOrphans ничего не вернул');
  if (!jobStats().handlers.length) throw new Error('нет обработчиков');
  ok('очередь переживает рестарт', `возвращено задач: ${recovered}, lease сброшен`);
} catch (err) { fail('очередь переживает рестарт', err); }

// ── эпизоды не теряются: восстановление «зависшего» ролика ──────────────────
try {
  const { createEpisode, recoverEpisodeStates } = await import('../src/engine/pipeline.js');
  const { db, nowIso } = await import('../src/core/db.js');
  const project = db.prepare('SELECT id FROM projects LIMIT 1').get();
  const ep = createEpisode({ projectId: project.id, autopilot: 0 }).id;
  // имитируем падение процесса: статус «в очереди», задачи нет, время ушло
  db.prepare("UPDATE episodes SET status = 'queued', stage = 'idea', updated_at = ? WHERE id = ?")
    .run('2000-01-01T00:00:00.000Z', ep);
  db.prepare("DELETE FROM jobs WHERE payload LIKE ?").run(`%${ep}%`);
  const n = recoverEpisodeStates();
  const job = db.prepare("SELECT * FROM jobs WHERE payload LIKE ? AND status = 'pending'").get(`%${ep}%`);
  if (!job) throw new Error('зависший эпизод не вернулся в очередь');
  if (!String(job.payload).includes('episode')) throw new Error('создана задача не того типа');
  // при повторном вызове дубля быть не должно
  const before = db.prepare('SELECT COUNT(*) n FROM jobs WHERE payload LIKE ?').get(`%${ep}%`).n;
  recoverEpisodeStates();
  const after = db.prepare('SELECT COUNT(*) n FROM jobs WHERE payload LIKE ?').get(`%${ep}%`).n;
  if (after !== before) throw new Error('дубль задачи при повторном восстановлении');
  db.prepare('DELETE FROM episodes WHERE id = ?').run(ep);
  ok('зависшие ролики возвращаются в очередь', `восстановлено: ${n}, дублей нет`);
} catch (err) { fail('зависшие ролики возвращаются в очередь', err); }

// ── умное расписание ────────────────────────────────────────────────────────
try {
  const { planSlot, hourScores, bestHours, localParts, zonedToUtc } = await import('../src/engine/schedule.js');
  const { db } = await import('../src/core/db.js');
  const project = db.prepare('SELECT * FROM projects LIMIT 1').get();
  const plan = planSlot(project.id);
  const tz = plan.timezone;
  const local = localParts(new Date(plan.at), tz);
  if (local.hour < 9 || local.hour > 22) throw new Error(`слот вне окна публикаций: ${local.hour}:00`);
  if (new Date(plan.at).getTime() < Date.now()) throw new Error('слот в прошлом');
  if (!plan.reason || !plan.source) throw new Error('нет объяснения слота');
  // таймзона: 12:00 Москвы = 09:00 UTC
  const utc = zonedToUtc(2026, 10, 21, 12, 0, 'Europe/Moscow');
  if (utc.toISOString() !== '2026-10-21T09:00:00.000Z') throw new Error(`конверсия таймзоны: ${utc.toISOString()}`);
  const hours = hourScores('reels');
  if (hours.length !== 24) throw new Error('не 24 часа в профиле');
  const best = bestHours('reels', 2);
  if (!best.length) throw new Error('нет лучших часов');
  ok('умное расписание', `${plan.reason.slice(0, 34)}…, таймзона ${tz}`);
} catch (err) { fail('умное расписание', err); }

// ── прогноз прибыли ─────────────────────────────────────────────────────────
try {
  const { forecastEpisode, projectHealth } = await import('../src/engine/forecast.js');
  const { db } = await import('../src/core/db.js');
  const episode = db.prepare("SELECT * FROM episodes WHERE status = 'published' LIMIT 1").get();
  const f = forecastEpisode({ episode });
  if (!(f.expectedViews > 0)) throw new Error('нет прогноза охвата');
  if (Math.abs(f.profit - (f.revenue - f.cost)) > 0.02) throw new Error('прибыль не сходится с доходом и расходом');
  if (!f.factors.viral || !f.factors.hour || !f.factors.account) throw new Error('нет разложения факторов');
  const health = projectHealth(episode.project_id);
  if (!['scale', 'hold', 'fix', 'pause'].includes(health.action)) throw new Error('неизвестное решение по проекту');
  ok('прогноз прибыли', `${f.expectedViews} просм., ${f.profit} ₽, ROI ${f.roi}%`);
} catch (err) { fail('прогноз прибыли', err); }

// ── A/B закрывается решением ────────────────────────────────────────────────
try {
  const { db, nowIso } = await import('../src/core/db.js');
  const { evaluateAB, preferredVariant } = await import('../src/engine/abtest.js');
  const project = db.prepare('SELECT * FROM projects LIMIT 1').get();
  const ep = db.prepare("SELECT * FROM episodes WHERE status = 'published' LIMIT 1").get();
  // чистим прежние публикации эпизода, чтобы тест был детерминированным
  db.prepare('DELETE FROM publications WHERE episode_id = ?').run(ep.id);
  db.prepare("UPDATE episodes SET ab_test = 1, ab_winner = NULL, ab_meta = '{}', published_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 72 * 3600000).toISOString(), ep.id);
  const ins = db.prepare(`INSERT INTO publications (id, episode_id, project_id, account_id, platform, variant, status, published_at, views, clicks, target_views, created_at)
    VALUES (?, ?, ?, NULL, 'reels', ?, 'published', ?, ?, ?, ?, ?)`);
  ins.run('pb_smoke_a', ep.id, project.id, 'A', nowIso(), 5000, 60, 5000, nowIso());
  ins.run('pb_smoke_b', ep.id, project.id, 'B', nowIso(), 2000, 24, 2000, nowIso());
  const decided = evaluateAB();
  const row = db.prepare('SELECT ab_winner, ab_meta FROM episodes WHERE id = ?').get(ep.id);
  if (row.ab_winner !== 'A') throw new Error(`победитель не определён: ${row.ab_winner}`);
  const meta = JSON.parse(row.ab_meta || '{}');
  if (!(meta.lift > 30)) throw new Error('разница не посчитана');
  if (!decided.length) throw new Error('решение не попало в отчёт');
  const pref = preferredVariant(project.id);
  if (!['A', 'B'].includes(pref.variant)) throw new Error('нет предпочитаемого варианта');
  ok('A/B закрывается решением', `победил ${row.ab_winner}, разрыв ${meta.lift}%, CTR ${meta.ctrA}% / ${meta.ctrB}%`);
} catch (err) { fail('A/B закрывается решением', err); }

// ── веса вирусного скора обучаются ──────────────────────────────────────────
try {
  const { recalibrate, scoreViral } = await import('../src/engine/viral.js');
  const res = recalibrate({ minSamples: 8 });
  if (!res.ready) throw new Error(`мало данных для проверки: ${res.samples}`);
  const sum = Object.values(res.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.02) throw new Error(`веса не нормированы: ${sum}`);
  const report = scoreViral({
    title: 'Почему отдых не восстанавливает',
    scenes: [{ text: 'Почему 8 часов сна не спасут', seconds: 5 }, { text: 'Отдых — это смена режима', seconds: 6 }],
    description: 'Разбор привычек и отдыха: 3 шага и проверка на себе. Смотри до конца и напиши, что думаешь.',
    hashtags: ['#сон', '#отдых', '#привычки', '#психология', '#режим'],
  });
  if (report.weightsSource !== 'приоры (данных ещё мало)' && !/обучены/.test(report.weightsSource)) {
    throw new Error(`неизвестный источник весов: ${report.weightsSource}`);
  }
  ok('веса скора обучаются', `${res.samples} роликов, сильнейший фактор — ${Object.entries(res.weights).sort((a, b) => b[1] - a[1])[0][0]}`);
} catch (err) { fail('веса скора обучаются', err); }

// ── рост: портфель мультиплатформы ──────────────────────────────────────────
try {
  const { portfolio } = await import('../src/engine/growth.js');
  const p = portfolio();
  const labels = p.platforms.map((x) => x.label);
  for (const need of ['TikTok', 'Instagram Reels', 'YouTube Shorts']) {
    if (!labels.includes(need)) throw new Error(`нет площадки ${need}`);
  }
  if (p.totals.accounts < 6) throw new Error(`мало аккаунтов: ${p.totals.accounts}`);
  if (!(p.totals.followers > 0)) throw new Error('подписчики не собраны');
  if (!(p.totals.avgRetention >= 35 && p.totals.avgRetention <= 88)) {
    throw new Error(`удержание вне диапазона: ${p.totals.avgRetention}`);
  }
  const yt = p.platforms.find((x) => x.platform === 'youtube');
  if (!(yt.accounts >= 2)) throw new Error(`YouTube-аккаунтов ${yt.accounts}`);
  if (!yt.idealSec || yt.idealSec.length !== 2) throw new Error('нет окна длительности для Shorts');
  if (!(yt.retentionTarget > 0)) throw new Error('нет цели по удержанию для Shorts');
  ok('портфель роста', `${p.totals.accounts} аккаунтов, ${p.totals.followers} подписчиков, ${labels.join(' / ')}`);
} catch (err) { fail('портфель роста', err); }

// ── рост: лаборатория хуков ─────────────────────────────────────────────────
try {
  const { hookLab, scoreHook } = await import('../src/engine/growth.js');
  const lab = hookLab({ topic: 'привычки', platform: 'youtube' });
  if (lab.hooks.length < 7) throw new Error(`мало хуков: ${lab.hooks.length}`);
  if (lab.hooks.some((h) => h.text.includes('{topic}'))) throw new Error('плейсхолдер темы не подставлен');
  if (!(lab.best.score > 50)) throw new Error(`лучший хук слабый: ${lab.best.score}`);
  if (!lab.guidance.length) throw new Error('нет рекомендаций');
  const weak = scoreHook('ну вот, сегодня поговорим о разном', { platform: 'tiktok' });
  const strong = scoreHook('Одна ошибка в «привычках» убивает результат', { platform: 'tiktok' });
  if (!(strong.score > weak.score)) throw new Error('скоринг хуков не различает сильный и слабый');
  ok('лаборатория хуков', `${lab.hooks.length} шаблонов, лучший ${lab.best.score}/100, окно ${lab.best.fitsWindow ? 'укладывается' : 'длинноват'}`);
} catch (err) { fail('лаборатория хуков', err); }

// ── рост: монетизация по всем каналам ───────────────────────────────────────
try {
  const { monetizationPlan } = await import('../src/engine/growth.js');
  const m = monetizationPlan();
  const ids = m.programs.map((x) => x.id);
  for (const need of ['youtube-ypp-1', 'youtube-ypp-2', 'tiktok-rewards']) {
    if (!ids.includes(need)) throw new Error(`нет программы ${need}`);
  }
  if (m.programs.some((x) => !(x.progress >= 0 && x.progress <= 100))) throw new Error('прогресс вне 0–100');
  const rewards = m.programs.find((x) => x.id === 'tiktok-rewards');
  if (!rewards.regionLimited || !rewards.regionNote) throw new Error('региональные ограничения TikTok Rewards не показаны');
  if (!(m.totals.followers > 0)) throw new Error('подписчики не учтены в монетизации');
  ok('монетизация по каналам', `${m.programs.length} программ, YPP ${m.programs[0].progress}%, TikTok Rewards ${rewards.progress}% (${rewards.regionNote})`);
} catch (err) { fail('монетизация по каналам', err); }

// ── гейт публикации ─────────────────────────────────────────────────────────
try {
  const { publishGate } = await import('../src/engine/growth.js');
  const { db } = await import('../src/core/db.js');
  const ep = db.prepare("SELECT id FROM episodes WHERE status IN ('published','scheduled') LIMIT 1").get()
    || db.prepare('SELECT id FROM episodes LIMIT 1').get();
  const gate = publishGate(ep.id);
  if (!['go', 'fix', 'block'].includes(gate.verdict)) throw new Error(`неизвестный вердикт: ${gate.verdict}`);
  if (!(gate.score >= 0 && gate.score <= 100)) throw new Error('скор вне диапазона');
  if (!gate.retention || !gate.viral) throw new Error('нет разложения по удержанию и вирусности');
  if (gate.verdict === 'block' && !gate.blockers.length) throw new Error('блок без причин');
  ok('гейт публикации', `${gate.verdict}, ${gate.score}/100, ${gate.platformLabel}, удержание ${gate.retention.predictedCompletion}%`);
} catch (err) { fail('гейт публикации', err); }

// ── YouTube Shorts: адаптер и статистика ────────────────────────────────────
try {
  const { providers } = await import('../src/providers/index.js');
  const res = await providers.publish.send({
    platform: 'youtube',
    account: { handle: 'pulse.studio', access_token: null },
    title: 'Тестовый Shorts',
    description: 'Описание #pulse',
    privacy: 'private',
  });
  if (!String(res.url).includes('youtube.com/shorts/')) throw new Error(`ссылка Shorts: ${res.url}`);
  // без токена демо-режим честно возвращает null: подписчиков подменять нельзя,
  // pipeline в этом случае оставляет последнее известное значение из базы
  const audience = await providers.stats.audience({ platform: 'youtube', account: { handle: 'pulse.studio' } });
  if (audience !== null) throw new Error('демо-режим выдумал подписчиков без токена');
  const { privacyFor } = await import('../src/engine/pipeline.js');
  const { db } = await import('../src/core/db.js');
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'youtube_audited'").run();
  if (privacyFor('youtube') !== 'private') throw new Error('неаудированный проект публикует не приватно');
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'youtube_audited'").run();
  ok('YouTube Shorts', `${res.url.replace('https://', '')}, приватность соблюдена, аудитория без токена — null`);
} catch (err) { fail('YouTube Shorts', err); }

// ── квота учитывает A/B (два выхода за один заход) ──────────────────────────
try {
  const { pickAccount, accountQuota } = await import('../src/engine/pipeline.js');
  const { db, nowIso } = await import('../src/core/db.js');
  const acc = db.prepare("SELECT * FROM accounts WHERE platform = 'tiktok' AND status = 'healthy' LIMIT 1").get();
  if (!acc) throw new Error('нет tiktok-аккаунта для проверки');
  const day = nowIso().slice(0, 10);
  const cap = accountQuota(acc).cap;
  // остаток ровно один слот: одиночный пост можно, A/B (два) — нельзя
  db.prepare(`INSERT INTO accounts_daily (account_id, day, used) VALUES (?, ?, ?)
              ON CONFLICT(account_id, day) DO UPDATE SET used = excluded.used`).run(acc.id, day, Math.max(0, cap - 1));
  // останавливаем остальные аккаунты площадки, чтобы выбор был однозначным
  db.prepare("UPDATE accounts SET status = 'paused' WHERE platform = 'tiktok' AND id != ?").run(acc.id);
  const single = pickAccount('tiktok', null, 1);
  const pair = pickAccount('tiktok', null, 2);
  if (!single) throw new Error('последний слот не выдаётся одиночному посту');
  if (pair) throw new Error('A/B занял два слота при остатке один — лимит аккаунта превышен');
  // на warming-аккаунте лимит 1: A/B вообще не должен туда вставать
  const warm = db.prepare("SELECT * FROM accounts WHERE platform = 'tiktok' LIMIT 1").get();
  db.prepare("UPDATE accounts SET status = 'warmup' WHERE id = ?").run(warm.id);
  if (pickAccount('tiktok', null, 2)) throw new Error('A/B встал на прогреваемый аккаунт');
  ok('квота под A/B', `остаток 1 слот: одиночный пост — да, A/B — перенос`);
} catch (err) { fail('квота под A/B', err); }

// ── бренд-привязка: контент не уходит в чужой аккаунт ──────────────────────
try {
  const { pickAccount } = await import('../src/engine/pipeline.js');
  const { db } = await import('../src/core/db.js');
  const projects = db.prepare('SELECT * FROM projects ORDER BY name').all();
  if (projects.length < 2) throw new Error('мало проектов для проверки');
  const bounded = db.prepare('SELECT * FROM accounts WHERE project_id IS NOT NULL AND status = ?').all('healthy');
  if (!bounded.length) throw new Error('нет аккаунтов с брендом');
  for (const project of projects) {
    for (const platform of ['reels', 'tiktok', 'youtube']) {
      const acc = pickAccount(platform, project.id, 1);
      if (!acc) continue;
      if (acc.project_id && acc.project_id !== project.id) {
        throw new Error(`аккаунт @${acc.handle} чужого бренда отдан проекту ${project.name}`);
      }
    }
  }
  // у каждого проекта есть свой аккаунт хотя бы на одной площадке
  const owned = db.prepare('SELECT project_id, COUNT(*) n FROM accounts WHERE project_id IS NOT NULL GROUP BY project_id').all();
  if (owned.length !== projects.length) throw new Error(`бренды без аккаунтов: ${projects.length - owned.length}`);
  ok('бренд-привязка аккаунтов', `${owned.length} брендов, по ${Math.round(owned.reduce((a, x) => a + x.n, 0) / owned.length)} аккаунта на бренд`);
} catch (err) { fail('бренд-привязка аккаунтов', err); }

// ── контент-план строится из данных ─────────────────────────────────────────
try {
  const { contentPlan } = await import('../src/engine/growth.js');
  const plan = contentPlan({ days: 7 });
  if (plan.plan.length !== 7) throw new Error(`дней в плане: ${plan.plan.length}`);
  const slots = plan.plan.flatMap((d) => d.slots);
  if (!slots.length) throw new Error('план пустой');
  if (slots.some((x) => !x.hook || x.hook.includes('{topic}'))) throw new Error('в слоте нет готового хука');
  if (slots.some((x) => !/^\d{2}:\d{2}$/.test(x.time))) throw new Error('некорректное время слота');
  if (slots.some((x) => x.expectedViews <= 0)) throw new Error('нет прогноза охвата у слота');
  // Shorts нельзя ставить чаще, чем раз в день на бренд: алгоритм не любит поток
  const ytPerDay = Object.fromEntries(plan.plan.map((d) => [d.date, d.slots.filter((s) => s.platform === 'youtube').length]));
  if (Object.values(ytPerDay).some((n) => n > 3)) throw new Error('Shorts поставлены слишком часто');
  const hooks = new Set(slots.map((x) => x.hook));
  if (hooks.size < 5) throw new Error(`хуки не разнообразятся: ${hooks.size} уникальных`);
  if (!(plan.totals.expectedRevenue > 0)) throw new Error('план не считает доход');
  ok('контент-план', `${plan.totals.posts} слотов на 7 дней, охват ${plan.totals.expectedViews}, доход ${plan.totals.expectedRevenue} ₽`);
} catch (err) { fail('контент-план', err); }

// ── база знаний: числа совпадают с правилами площадок ───────────────────────
try {
  const { platformKnowledge } = await import('../src/engine/growth.js');
  const { PLATFORM_RULES } = await import('../src/engine/compliance.js');
  const k = platformKnowledge();
  if (k.platforms.length !== 3) throw new Error('не все площадки описаны');
  for (const pl of k.platforms) {
    if (pl.api.per24h !== PLATFORM_RULES[pl.platform].publishPer24h) {
      throw new Error(`${pl.platform}: лимит в базе ${pl.api.per24h} против правила ${PLATFORM_RULES[pl.platform].publishPer24h}`);
    }
    if (!pl.demotions.length) throw new Error(`${pl.platform}: нет списка демотиваций`);
    if (!pl.algorithm.hookWindowSec) throw new Error(`${pl.platform}: нет окна хука`);
  }
  const rewards = k.monetization.find((m) => m.id === 'tiktok-rewards');
  if (!/РФ|US/.test(rewards.region)) throw new Error('региональное ограничение не описано');
  if (!k.general.truth.length) throw new Error('нет честных границ');
  ok('база знаний', `${k.platforms.length} площадки, лимиты сверены с комплаенсом, ${k.monetization.length} программ монетизации`);
} catch (err) { fail('база знаний', err); }

// ── аудит платформы ─────────────────────────────────────────────────────────
try {
  const { platformAudit } = await import('../src/engine/growth.js');
  const a = platformAudit();
  if (!(a.score >= 0 && a.score <= 100)) throw new Error('скор вне диапазона');
  if (a.issues.some((i) => !i.title || !i.impact || !i.fix)) throw new Error('пункт без причины или действия');
  if (a.issues.some((i) => !['block', 'warn', 'info'].includes(i.severity))) throw new Error('неизвестная важность');
  const counts = ['block', 'warn', 'info'].reduce((acc, s) => acc + a.issues.filter((i) => i.severity === s).length, 0);
  if (counts !== a.issues.length) throw new Error('счётчики не сходятся');
  ok('аудит платформы', `${a.score}/100, ${a.counts.block} блок · ${a.counts.warn} внимание · ${a.counts.info} инфо`);
} catch (err) { fail('аудит платформы', err); }

// ── лимиты площадок считаются в одном месте ─────────────────────────────────
try {
  const { platformQuota } = await import('../src/engine/pipeline.js');
  const { platformCap, PLATFORM_API_LIMITS } = await import('../src/engine/limits.js');
  const { transparency } = await import('../src/engine/money.js');
  const { getSettings } = await import('../src/core/db.js');
  const settings = getSettings();
  const t = transparency();
  for (const platform of ['reels', 'tiktok', 'youtube']) {
    const q = platformQuota(platform);
    const cap = platformCap(platform, settings);
    if (q.cap !== cap) throw new Error(`${platform}: квота ${q.cap} ≠ расчёт ${cap}`);
    const row = t.quotas.find((x) => x.platform === platform);
    if (!row || row.cap !== cap) throw new Error(`${platform}: прозрачность показывает ${row?.cap}, движок — ${cap}`);
    if (cap > PLATFORM_API_LIMITS[platform].per24h) throw new Error(`${platform}: рабочий потолок выше лимита API`);
  }
  ok('лимиты в одном месте', 'пайплайн, прозрачность и гейт используют platformCap()');
} catch (err) { fail('лимиты в одном месте', err); }

// ── проект без аккаунтов не крутится в вечном переносе ─────────────────────
try {
  const { db, nowIso } = await import('../src/core/db.js');
  const { createEpisode } = await import('../src/engine/pipeline.js');
  const { enqueue, drain } = await import('../src/core/queue.js');
  const fsx = await import('node:fs');
  // берём реальный файл ролика из проверки рендера
  const videoFile = fsx.readdirSync(process.env.PULSE_MEDIA_DIR || '.', { recursive: true })
    .map(String).find((f) => f.endsWith('.mp4'));
  if (!videoFile) throw new Error('нет файла ролика для проверки');
  const pid = 'pr_smoke_noacc';
  db.prepare(`INSERT INTO projects (id, name, niche, autopilot, posts_per_day, created_at, updated_at)
    VALUES (?, 'SmokeNoAcc', 'тест', 1, 1, ?, ?)`).run(pid, nowIso(), nowIso());
  const ep = createEpisode({ projectId: pid, autopilot: 1 }).id;
  db.prepare("UPDATE episodes SET status = 'scheduled', video_path = ?, scheduled_at = ? WHERE id = ?")
    .run(videoFile, nowIso(), ep);
  const jobsBefore = db.prepare("SELECT COUNT(*) n FROM jobs WHERE payload LIKE ?").get(`%${ep}%`).n;
  enqueue('episode.publish', { episodeId: ep });
  await drain(3);
  const row = db.prepare('SELECT status, error FROM episodes WHERE id = ?').get(ep);
  if (row.status !== 'review') throw new Error(`статус после публикации без аккаунтов: ${row.status}`);
  if (!/аккаунт/i.test(row.error || '')) throw new Error(`непонятная ошибка: ${row.error}`);
  const jobsAfter = db.prepare("SELECT COUNT(*) n FROM jobs WHERE payload LIKE ? AND status = 'pending'").get(`%${ep}%`).n;
  if (jobsAfter > jobsBefore) throw new Error('создан повторный перенос — ролик будет висеть вечно');
  db.prepare('DELETE FROM episodes WHERE id = ?').run(ep);
  db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
  ok('проект без аккаунтов', 'ролик ушёл в проверку с понятной причиной, цикл переносов не создан');
} catch (err) { fail('проект без аккаунтов', err); }


// ── студия: движок сам собирает ролик под правила площадки ─────────────────
try {
  const { db } = await import('../src/core/db.js');
  const { studio, promotionDecision } = await import('../src/engine/creative.js');
  const { PLATFORM_API_LIMITS } = await import('../src/engine/limits.js');
  const project = db.prepare('SELECT * FROM projects ORDER BY created_at LIMIT 1').get();
  const product = db.prepare('SELECT * FROM products WHERE active = 1 LIMIT 1').get();

  const packs = {};
  for (const platform of ['tiktok', 'reels', 'youtube']) {
    const res = studio({ project, product, platform, durationSec: 34, promo: 'direct', count: 3 });
    packs[platform] = res;
    const best = res.best;
    if (res.candidates.length !== 3) throw new Error(`${platform}: кандидатов ${res.candidates.length}, а не 3`);
    const uniq = new Set(res.candidates.map((c) => c.hook));
    if (uniq.size < 2) throw new Error(`${platform}: варианты не различаются`);
    for (const c of res.candidates) {
      const total = c.scores.total;
      if (!(total >= 0 && total <= 100)) throw new Error(`${platform}: скор вне 0..100 — ${total}`);
      // 34-секундный ролик: сцена 3–6 с (длинные ролики допускают до 9 с)
      if (c.scenes.some((sc) => sc.seconds > 6 || sc.seconds < 1)) throw new Error(`${platform}: сцена вне 1–6 с`);
      const dur = c.scenes.reduce((a, sc) => a + sc.seconds, 0);
      if (dur > 42 || dur < 16) throw new Error(`${platform}: длительность ${dur} с вне 16–42`);
      // описание каждой площадки укладывается в её лимит символов
      for (const [pl, text] of Object.entries(c.captions)) {
        const max = PLATFORM_API_LIMITS[pl].description;
        if (!text || text.length > max) throw new Error(`${pl}: описание ${text?.length} > ${max}`);
      }
      if (c.captions.tiktok && /https?:\/\//.test(c.captions.tiktok)) throw new Error('TikTok: кликабельная ссылка в описании невозможна');
    }
    // UTM в комментарии — по площадке публикации, иначе переходы спишутся чужому каналу
    if (!new RegExp(`utm_source=${platform}`).test(best.pinnedComment || '')) throw new Error(`${platform}: закреплённый комментарий без UTM`);
  }
  const yt = packs.youtube.best;
  if (yt.captions.youtube.length > PLATFORM_API_LIMITS.youtube.description) throw new Error('YouTube: описание не влезло');
  if (yt.hashtags.length > 8) throw new Error('YouTube: слишком много тегов');
  ok('студия собирает пакет', `tiktok ${packs.tiktok.best.scores.total} · reels ${packs.reels.best.scores.total} · shorts ${yt.scores.total}, описания в лимитах`);

  // продажа дозируется: в свежем проекте первый ролик не продаёт
  const decision = promotionDecision({ project });
  if (!['direct', 'soft', 'none'].includes(decision.intensity)) throw new Error(`непонятное решение: ${decision.intensity}`);
  const promoShare = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN product_id IS NOT NULL THEN 1 ELSE 0 END) promo
    FROM episodes WHERE project_id = ? AND status = 'published'`).get(project.id);
  const share = promoShare.total ? promoShare.promo / promoShare.total : 0;
  if (share > 0.5) throw new Error(`продающих роликов ${Math.round(share * 100)}% — это уже спам, охват упадёт`);
  ok('продажа дозирована', `${Math.round(share * 100)}% роликов с продуктом · решение: ${decision.intensity}`);
} catch (err) { fail('студия собирает пакет', err); }

// ── креатив доезжает до очереди: сцены, описание, паспорт ─────────────────
try {
  const { db, nowIso } = await import('../src/core/db.js');
  const { createEpisode, touchEpisode } = await import('../src/engine/pipeline.js');
  const { studio } = await import('../src/engine/creative.js');
  const project = db.prepare('SELECT * FROM projects ORDER BY created_at LIMIT 1').get();
  const pack = studio({ project, platform: 'tiktok', durationSec: 30, promo: 'direct', count: 1 }).best;
  const ep = createEpisode({ projectId: project.id, title: pack.title });
  touchEpisode(ep.id, {
    scenes: JSON.stringify(pack.scenes), description: pack.captions.tiktok,
    promo: 'direct', caption_platform: 'tiktok', creative: JSON.stringify({ hook: pack.hook, scores: pack.scores }),
  });
  const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(ep.id);
  if (JSON.parse(row.scenes).length !== pack.scenes.length) throw new Error('сцены не сохранились');
  if (!row.description || row.promo !== 'direct') throw new Error('описание или решение о продаже потерялись');
  if (JSON.parse(row.creative).hook !== pack.hook) throw new Error('паспорт креатива не сохранён');
  db.prepare('DELETE FROM episodes WHERE id = ?').run(ep.id);
  ok('креатив доезжает до очереди', `хук «${pack.hook.slice(0, 40)}…», ${pack.scenes.length} сцен`);
} catch (err) { fail('креатив доезжает до очереди', err); }

// ── сериалы: библия → сезон → серия → аудит → рендер 16:9 ─────────────────
try {
  const serial = await import('../src/engine/serial.js');
  const { planVoiceSections } = await import('../src/engine/serialrender.js');
  const bible = serial.buildBible({ title: 'Смоук-сериал', genre: 'zombie' });
  if (!bible.characters?.length || !bible.world?.rule || !bible.disclosure) throw new Error('библия неполная');
  const series = { id: 'sr_smoke', title: 'Смоук-сериал', genre: 'zombie', episode_sec: 900, episodes_planned: 6, bible };
  const plan = serial.planSeason({ series });
  if (plan.episodes.length !== 6) throw new Error(`в плане ${plan.episodes.length} серий вместо 6`);

  // длительность должна сходиться к цели, темп — в коридоре живой речи
  for (const target of [600, 780, 900, 1200]) {
    const ep = serial.buildEpisode({ series, episodeNo: 2, targetSec: target });
    const drift = Math.abs(ep.durationSec - target) / target;
    if (drift > 0.05) throw new Error(`${target} с → ${ep.durationSec} с (расхождение ${Math.round(drift * 100)}%)`);
    if (ep.wpm < 120 || ep.wpm > 165) throw new Error(`темп ${ep.wpm} слов/мин вне 120–165`);
    if (ep.midRolls < 1) throw new Error('нет мид-роллов: серия не заработает');
    if (ep.authenticity.score < 85) throw new Error(`аудит оригинальности ${ep.authenticity.score}`);
    if (ep.scenes.some((s) => !s.text || !s.frame?.prompt)) throw new Error('у сцены нет текста или брифа кадра');
    if (new Set(ep.scenes.map((s) => s.text)).size !== ep.scenes.length) throw new Error('в серии есть дословные повторы');
    if (ep.chapters.at(-1).at >= ep.durationSec) throw new Error('глава за пределами длительности');
  }
  ok('сериал: сценарий и хронометраж', '600/780/900/1200 с, темп 120–165, мид-роллы, аудит ≥85');

  // аудит ловит шаблон: две серии с одинаковыми сценами — это масс-продакшн
  const epA = serial.buildEpisode({ series, episodeNo: 1, targetSec: 600 });
  const audit = serial.authenticityAudit({
    series, bible, scenes: epA.scenes, episodeNo: 2, plan: plan.episodes[1],
    wpm: epA.wpm, durationSec: epA.durationSec, midRolls: epA.midRolls,
    siblingScenes: epA.scenes.map((s) => s.text),
  });
  if (audit.similarity < 50 || audit.verdict === 'безопасно') throw new Error(`аудит не заметил повтор: ${audit.similarity}%`);
  ok('сериал: аудит ловит повторы', `похожесть ${audit.similarity}% → «${audit.verdict}»`);

  const sections = planVoiceSections({ scenes: epA.scenes });
  if (sections.length < 2) throw new Error('озвучка не разбита на секции');
  if (sections.some((x) => x.chars > 3200)) throw new Error('секция озвучки длиннее лимита TTS');
  ok('сериал: секции озвучки', `${sections.length} секций, максимум ${Math.max(...sections.map((x) => x.chars))} знаков`);

  const econ = serial.seriesEconomics({ series, episodes: [{ id: 'x', episode_no: 1, views: 20000 }], targetRub: 50000 });
  if (!econ.ypp.hoursLeft || !econ.target.viewsNeeded) throw new Error('экономика не считается');
  ok('сериал: экономика', `RPM ${serial.revenueForecast({ genre: 'zombie', minutes: 15, midRolls: 2 }).rpmRub} ₽, цель ${econ.target.viewsNeeded} просмотров`);
} catch (err) { fail('сериал: сценарий и хронометраж', err); }

try {
  const { planVoiceSections, buildTimeline, seriesRenderInfo } = await import('../src/engine/serialrender.js');
  const serial = await import('../src/engine/serial.js');
  const bible = serial.buildBible({ title: 'Смоук-кадр', genre: 'noir' });
  const series = { id: 'sr_smoke2', title: 'Смоук-кадр', genre: 'noir', episode_sec: 120, episodes_planned: 4, bible };
  const ep = serial.buildEpisode({ series, episodeNo: 1, targetSec: 120 });

  // тайминг: реальные длительности секций переопределяют сценарные секунды
  const sections = planVoiceSections({ scenes: ep.scenes.slice(0, 6) });
  const audioDurations = sections.map((s) => s.chars / 13);
  const timeline = buildTimeline({ scenes: ep.scenes.slice(0, 6), sections, audioDurations });
  const audioSum = audioDurations.reduce((a, b) => a + b, 0);
  if (Math.abs(timeline.durationSec - audioSum) > audioSum * 0.15) {
    throw new Error(`тайминг ${timeline.durationSec} с не сходится со звуком ${Math.round(audioSum)} с`);
  }
  ok('сериал: тайминг по озвучке', `${timeline.durationSec} с против ${Math.round(audioSum)} с звука`);

  const info = seriesRenderInfo();
  if (!info.available) throw new Error('рендер сериала недоступен');
  const { renderSeriesEpisode } = await import('../src/engine/serialrender.js');
  const short = serial.buildEpisode({ series: { ...series, episode_sec: 40 }, episodeNo: 1, targetSec: 40 });
  const scenes = short.scenes.slice(0, 3).map((s, i) => ({ ...s, seconds: 2 + i }));
  const out = await renderSeriesEpisode({
    series, episode: { id: 'se_smoke', episode_no: 1, title: 'Смоук' },
    scenes, frames: scenes.map((s) => s.frame), handle: 'pulse.studio',
    workId: 'smoke-series',
  });
  const size = fs.statSync(out.videoAbs).size;
  if (!out.ok || size < 50_000) throw new Error(`файл слишком мал: ${size}`);
  if (out.width !== 1920 || out.height !== 1080) throw new Error(`кадр не 16:9 1920×1080: ${out.width}×${out.height}`);
  if (!out.coverPaths?.A) throw new Error('обложка не собрана');
  const coverMeta = await (await import('node:module')).createRequire(import.meta.url)('sharp')(out.coverPaths.A.replace('/media', path.join(process.env.PULSE_MEDIA_DIR, ''))).metadata();
  if (coverMeta.width !== 1280 || coverMeta.height !== 720) throw new Error(`обложка не 1280×720: ${coverMeta.width}×${coverMeta.height}`);
  ok('сериал: рендер 16:9', `${out.width}×${out.height}, ${(size / 1048576).toFixed(1)} МБ, кадров ${out.scenes}, субтитров ${out.captions}`);

  const { renderSeriesCut } = await import('../src/engine/serialrender.js');
  const cut = await renderSeriesCut({ series, cut: { index: 1, seconds: 16, text: 'Крючок нарезки', title: 'Нарезка', scenery: 'city', episodeNo: 1 }, workId: 'smoke-series' });
  if (!cut.ok || cut.width !== 1080 || cut.height !== 1920) throw new Error('нарезка не вертикальная 1080×1920');
  ok('сериал: вертикальная нарезка', `${cut.seconds} с, ${(cut.bytes / 1024).toFixed(0)} КБ`);
} catch (err) { fail('сериал: рендер 16:9', err); }

// ── нарезки серии уходят в общий конвейер коротких роликов ─────────────────
try {
  const { db } = await import('../src/core/db.js');
  const ser = await import('../src/engine/series.js');
  const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
  const bible = ser.genres().length ? (await import('../src/engine/serial.js')).buildBible({ title: 'Нарезки', genre: 'mystery' }) : null;
  const series = ser.createSeries({ title: 'Нарезки', genre: 'mystery', projectId: project?.id, episodesPlanned: 4, episodeSec: 600 });
  const ep = ser.composeEpisode({ seriesId: series.id, episodeNo: 1, targetSec: 600 });
  const queued = ser.pushCutsToQueue(ep.id, { platform: 'reels', count: 2 });
  if (queued.length !== 2) throw new Error(`в очередь ушло ${queued.length} нарезок вместо 2`);
  const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(queued[0].episodeId);
  const scenes = JSON.parse(row.scenes);
  if (scenes.length < 2) throw new Error('у нарезки нет сцен');
  if (!/в профиле/i.test(row.description)) throw new Error('в описании нет призыва к полной серии');
  if (row.promo !== 'soft') throw new Error('нарезка не помечена как мягкая продажа');
  if (!JSON.parse(row.creative || '{}').seriesId) throw new Error('нарезка не знает, из какого она сериала');
  db.prepare('DELETE FROM episodes WHERE id IN (?, ?)').run(queued[0].episodeId, queued[1].episodeId);
  db.prepare('DELETE FROM series WHERE id = ?').run(series.id);
  ok('сериал: нарезки в очереди', `${queued.length} ролика, ${scenes.length} сцены, CTA на серию`);

} catch (err) { fail('сериал: нарезки в очереди', err); }

// ── длинный формат в общих деньгах: часы, RPM, путь к 4000 часов ───────────
try {
  const { db } = await import('../src/core/db.js');
  const ser = await import('../src/engine/series.js');
  const { moneySummary } = await import('../src/engine/money.js');
  const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
  const series = ser.createSeries({ title: 'Деньги серии', genre: 'noir', projectId: project?.id, episodesPlanned: 4, episodeSec: 720 });
  const ep = ser.composeEpisode({ seriesId: series.id, episodeNo: 1, targetSec: 720 });
  db.prepare("UPDATE series_episodes SET stage='published', views=25000, revenue_cents=625000, cost_cents=24900, duration_sec=720, published_at=? WHERE id=?").run(new Date().toISOString(), ep.id);
  const money = moneySummary({ days: 30 }).longform;
  if (money.episodes !== 1) throw new Error(`в деньгах ${money.episodes} длинных серий вместо 1`);
  if (money.views !== 25000 || Math.round(money.revenue) !== 6250) throw new Error(`просмотры/доход не сошлись: ${money.views}/${money.revenue}`);
  if (money.watchHours !== 2000) throw new Error(`часы просмотра ${money.watchHours} вместо 2000 (25000 × 12 мин × 0.4 avg)`);
  if (money.hoursToMonetization !== 2000) throw new Error(`до монетизации ${money.hoursToMonetization} ч вместо 2000`);
  if (Math.round(money.rpmAvg) !== 250) throw new Error(`RPM ${money.rpmAvg} вместо 250 ₽`);
  if (!money.top[0]?.seriesId) throw new Error('в топе серий нет ссылки на сериал');
  db.prepare('DELETE FROM series_episodes WHERE id = ?').run(ep.id);
  db.prepare('DELETE FROM series WHERE id = ?').run(series.id);
  ok('сериал: деньги длинного формата', `${money.episodes} серия, ${money.views} просмотров, ${money.watchHours} ч, RPM ${money.rpmAvg} ₽, до 4000 ч — ${money.hoursToMonetization} ч`);
} catch (err) { fail('сериал: деньги длинного формата', err); }



// ── расписание серий: своя задача в очереди, без вечного цикла ──────────────
try {
  const { db } = await import('../src/core/db.js');
  const ser = await import('../src/engine/series.js');
  const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
  const series = ser.createSeries({ title: 'Расписание', genre: 'zombie', projectId: project?.id, episodesPlanned: 3, episodeSec: 600 });
  const ep = ser.composeEpisode({ seriesId: series.id, episodeNo: 1, targetSec: 600 });

  let refused = false;
  try { ser.scheduleEpisode(ep.id); } catch { refused = true; }
  if (!refused) throw new Error('серия без файла попала в расписание');

  db.prepare("UPDATE series_episodes SET video_path = 'smoke.mp4', publish_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 60000).toISOString(), ep.id);
  const scheduled = ser.scheduleEpisode(ep.id);
  if (scheduled.stage !== 'scheduled') throw new Error(`стадия «${scheduled.stage}» вместо scheduled`);

  const first = ser.sweepDueSeriesEpisodes();
  const second = ser.sweepDueSeriesEpisodes();
  const jobs = db.prepare("SELECT COUNT(*) c FROM jobs WHERE type = 'series.publish' AND payload LIKE ?").get(`%${ep.id}%`).c;
  if (first !== 1) throw new Error(`планировщик взял ${first} серий вместо 1`);
  if (second !== 0 || jobs !== 1) throw new Error(`дубли задач: sweep=${second}, jobs=${jobs}`);

  db.prepare("DELETE FROM jobs WHERE type = 'series.publish' AND payload LIKE ?").run(`%${ep.id}%`);
  db.prepare('DELETE FROM series_episodes WHERE id = ?').run(ep.id);
  db.prepare('DELETE FROM series WHERE id = ?').run(series.id);
  ok('сериал: расписание серий', 'без файла отказ, с файлом — задача series.publish, дублей нет');
} catch (err) { fail('сериал: расписание серий', err); }

// ── публикация серии: demo-провайдер, плейлист и ссылка в описании ──────────
try {
  const { db } = await import('../src/core/db.js');
  const ser = await import('../src/engine/series.js');
  const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
  const series = ser.createSeries({ title: 'Публикация', genre: 'mystery', projectId: project?.id, episodesPlanned: 3, episodeSec: 600 });
  const ep = ser.composeEpisode({ seriesId: series.id, episodeNo: 1, targetSec: 600 });
  fs.writeFileSync(path.join(process.env.PULSE_MEDIA_DIR || path.join(tmp, 'media'), 'smoke-series.mp4'), Buffer.alloc(64 * 1024, 7));
  db.prepare('UPDATE series_episodes SET video_path = ?, duration_sec = 600 WHERE id = ?').run('smoke-series.mp4', ep.id);
  const out = await ser.publishEpisodeToYoutube(ep.id);
  if (!out.ok || !out.url) throw new Error('публикация не вернула ссылку');
  if (!/youtube\.com\/watch/.test(out.url)) throw new Error(`серия ушла не как обычное видео: ${out.url}`);
  if (!out.playlistId) throw new Error('плейлист не создан');
  const row = db.prepare('SELECT * FROM series_episodes WHERE id = ?').get(ep.id);
  if (row.stage !== 'published' || !row.external_id) throw new Error('серия не перешла в published');
  if (!new RegExp(out.playlistId).test(row.description)) throw new Error('в описании нет ссылки на плейлист');
  ok('сериал: публикация и плейлист', `${out.privacy}, плейлист ${out.playlistId.slice(0, 12)}…, ссылка в описании`);
  db.prepare('DELETE FROM series_episodes WHERE id = ?').run(ep.id);
  db.prepare('DELETE FROM series WHERE id = ?').run(series.id);
  fs.rmSync(path.join(process.env.PULSE_MEDIA_DIR || path.join(tmp, 'media'), 'smoke-series.mp4'), { force: true });
} catch (err) { fail('сериал: публикация и плейлист', err); }

// ── деплой: настройки, которые решают, поднимется ли сервис в облаке ────────
try {
  // Секрет должен создаться один раз и лежать на диске: иначе рестарт контейнера
  // разлогинивает всех и делает старые токены аккаунтов нечитаемыми.
  // Проверяем в отдельном процессе: выше тесты шифрования выставляют PULSE_SECRET.
  const { execFileSync } = await import('node:child_process');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const dir = path.join(tmp, 'boot-secret');
  const env = { ...process.env, PULSE_DATA_DIR: dir };
  delete env.PULSE_SECRET;
  const script = "import('./server/src/core/boot.js').then(m=>console.log(JSON.stringify({secret:m.appSecret(),created:m.boot.secretCreated})))";
  const first = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: root, env }).toString());
  const second = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: root, env }).toString());
  if (!first.created) throw new Error('секрет не создан при первом старте');
  if (second.created) throw new Error('секрет пересоздался при втором старте');
  if (first.secret !== second.secret) throw new Error('секрет изменился между запусками');
  if (!fs.existsSync(path.join(dir, '.pulse-secret'))) throw new Error('файл секрета не найден');
  const mode = fs.statSync(path.join(dir, '.pulse-secret')).mode & 0o777;
  if (mode !== 0o600) throw new Error(`права на .pulse-secret ${mode.toString(8)} вместо 600`);
  ok('деплой: секрет сессий переживает рестарт', `создан один раз, права 600, ${first.secret.length} символов`);
} catch (err) { fail('деплой: секрет сессий переживает рестарт', err); }

try {
  // PORT приоритетнее PULSE_PORT: так работает Railway/Render/Fly
  const { execFileSync } = await import('node:child_process');
  const script = "import('./server/src/core/boot.js').then(m=>console.log(m.boot.port))";
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),
    env: { ...process.env, PORT: '3000', PULSE_PORT: '8080', PULSE_DATA_DIR: path.join(tmp, 'boot-port') },
  }).toString().trim();
  if (out !== '3000') throw new Error(`порт из PORT=${out}, ожидали 3000`);
  ok('деплой: PORT от платформы', 'PORT=3000 перекрывает PULSE_PORT=8080');
} catch (err) { fail('деплой: PORT от платформы', err); }

try {
  // На публичном адресе пароль по умолчанию недопустим: он должен генерироваться.
  const { execFileSync } = await import('node:child_process');
  const dir = path.join(tmp, 'boot-hosted');
  const script = "import('./server/src/core/boot.js').then(m=>console.log(JSON.stringify({p:m.boot.passwordCreated,d:m.boot.passwordDefault,hosted:m.boot.hosted,pass:m.appPassword()})))";
  const run = () => JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),
    env: { ...process.env, RAILWAY_ENVIRONMENT: 'production', PULSE_DATA_DIR: dir, PULSE_PASSWORD: '' },
  }).toString().trim());
  const data = run();
  if (!data.hosted || !data.p || data.d) throw new Error(`на облаке пароль не сгенерирован: ${JSON.stringify(data)}`);
  const saved = fs.readFileSync(path.join(dir, 'first-login.txt'), 'utf8').trim();
  const fileMode = fs.statSync(path.join(dir, 'first-login.txt')).mode & 0o777;
  if (saved.length < 12) throw new Error('сгенерированный пароль короче 12 символов');
  if (fileMode !== 0o600) throw new Error(`права на first-login.txt ${fileMode.toString(8)} вместо 600`);
  // Рестарт контейнера не должен выдавать новый пароль — иначе владелец
  // остаётся без входа после каждого перезапуска.
  const again = run();
  if (again.p || again.pass !== data.pass) throw new Error('пароль меняется при рестарте контейнера');
  ok('деплой: пароль на публичном хостинге', 'сгенерирован один раз, права 600, рестарт его не меняет');
} catch (err) { fail('деплой: пароль на публичном хостинге', err); }

try {
  // ffmpeg должен находиться и без @ffmpeg-installer (системный бинарь в образе).
  const { resolveFfmpeg, ffmpegSource } = await import('../src/core/ffmpeg.js');
  const binary = resolveFfmpeg();
  if (!binary) throw new Error('ffmpeg не найден ни одним способом');
  ok('деплой: поиск ffmpeg', `${ffmpegSource(binary)} → ${binary}`);
} catch (err) { fail('деплой: поиск ffmpeg', err); }

try {
  const { db } = await import('../src/core/db.js');
  const { moneySummary } = await import('../src/engine/money.js');
  const before = moneySummary({ days: 7 });
  const dir = path.join(tmp, 'backups');
  process.env.PULSE_BACKUP_DIR = dir;
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['server/scripts/backup.mjs'], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),
    env: { ...process.env, PULSE_BACKUP_DIR: dir },
  });
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
  if (!files.length) throw new Error('бэкап не создан');
  const copy = new (await import('better-sqlite3')).default(path.join(dir, files[0]), { readonly: true });
  const projects = copy.prepare('SELECT COUNT(*) c FROM projects').get().c;
  copy.close();
  if (!projects) throw new Error('в бэкапе нет данных');
  if (!before) throw new Error('сводка денег не читается');
  ok('деплой: бэкап базы', `${files.length} копия, ${projects} проектов внутри`);
} catch (err) { fail('деплой: бэкап базы', err); }

// ── итерация 13: реальные аккаунты, нейро-кадры, реклама своих продуктов ────
try {
  const { oauthStatus, startFlow, redirectUri } = await import('../src/engine/oauth.js');
  const list = oauthStatus();
  if (list.length !== 3) throw new Error(`ожидались 3 площадки, получено ${list.length}`);
  for (const p of list) {
    const uri = redirectUri(p.id, 'https://pulse.example.com');
    if (!uri.endsWith(`/api/oauth/${p.id}/callback`)) throw new Error(`redirect URI для ${p.id}: ${uri}`);
    if (!Array.isArray(p.missing)) throw new Error(`нет списка нехватающих переменных для ${p.id}`);
  }
  // без ключей вход не начинается, но и не падает необъяснимо
  let message = '';
  try { startFlow('youtube', { origin: 'https://pulse.example.com' }); } catch (err) { message = String(err.message || err); }
  if (process.env.YOUTUBE_CLIENT_ID) { ok('oauth: площадки и redirect URI', '3 площадки, ключи заданы'); }
  else {
    if (!/YOUTUBE_CLIENT_ID/.test(message)) throw new Error(`неинформативная ошибка: ${message}`);
    ok('oauth: площадки и redirect URI', '3 площадки, 2 ключа на каждую');
  }
} catch (err) { fail('oauth: площадки и redirect URI', err); }

try {
  process.env.PULSE_IMAGES = 'on';
  const { framesStatus, imagePromptFor } = await import('../src/engine/frames.js');
  const st = framesStatus();
  if (!st.providers?.length) throw new Error('нет провайдеров картинок');
  const prompt = imagePromptFor({ text: 'мёртвый город в тумане', visual: 'city', palette: 'ash' }, { look: 'нуар, 35 мм' });
  if (typeof prompt !== 'string' || prompt.length < 40) throw new Error('промпт кадра не собирается');
  const { seriesRenderInfo } = await import('../src/engine/serialrender.js');
  const info = seriesRenderInfo();
  if (!info.frames || !['auto', 'neural', 'procedural'].includes(info.frames.mode)) throw new Error('режим кадров не отдаётся в UI');
  ok('кадры: провайдер, промпт, режим', `${st.active} · ${st.minGapSec} с · ${info.frames.mode}`);
} catch (err) { fail('кадры: провайдер, промпт, режим', err); }

try {
  const { db } = await import('../src/core/db.js');
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  // дубль ключа в ensureColumns молча затирает колонки — проверяем обе группы
  const series = cols('series');
  for (const c of ['project_id', 'season_plan', 'playlist_id', 'show_id', 'notes', 'auto_compose', 'auto_render', 'lookahead', 'frame_mode']) {
    if (!series.includes(c)) throw new Error(`в series нет колонки ${c}`);
  }
  const accounts = cols('accounts');
  for (const c of ['refresh_token', 'token_scope', 'topic', 'persona', 'language', 'visual_style']) {
    if (!accounts.includes(c)) throw new Error(`в accounts нет колонки ${c}`);
  }
  const products = cols('products');
  for (const c of ['placement', 'always']) if (!products.includes(c)) throw new Error(`в products нет колонки ${c}`);
  ok('схема: колонки итерации 13', 'series, accounts, products целы');
} catch (err) { fail('схема: колонки итерации 13', err); }

try {
  const { promotionDecision, studio } = await import('../src/engine/creative.js');
  const { db } = await import('../src/core/db.js');
  const project = db.prepare('SELECT * FROM projects ORDER BY created_at LIMIT 1').get();
  const base = { id: 'smoke-p1', name: 'Pulse Pro', url: 'https://pulse.studio/pro', pitch: 'студия в один клик' };

  // «в каждом ролике» — осознанный выбор владельца, правило 80/20 отключается
  const always = promotionDecision({ project, product: { ...base, always: 1 } });
  if (always.intensity !== 'direct' || always.share !== 1) throw new Error(`always=1 не даёт прямой показ: ${JSON.stringify(always)}`);

  // только видео: ссылки в описании нет — иначе площадка считает это спамом
  const vid = studio({ project, product: { ...base, placement: 'video' }, platform: 'tiktok', durationSec: 30, promo: 'direct', count: 1 }).best;
  if (String(vid.captions.tiktok).includes('pulse.studio')) throw new Error('при placement=video ссылка попала в описание');

  // только описание: продукта нет в сценах — кадр остаётся чистым
  const cap = studio({ project, product: { ...base, placement: 'caption' }, platform: 'reels', durationSec: 30, promo: 'direct', count: 1 }).best;
  const sceneText = JSON.stringify(cap.scenes || []);
  if (sceneText.includes('Pulse Pro')) throw new Error('при placement=caption продукт попал в сцены');
  ok('реклама: режимы показа продукта', 'video → без ссылки, caption → без сцены, always → прямой показ');
} catch (err) { fail('реклама: режимы показа продукта', err); }

try {
  const { seriesAutopilot, createSeries, seriesOverview } = await import('../src/engine/series.js');
  const { db, setSettings } = await import('../src/core/db.js');
  setSettings({ series_auto_compose: '1', series_lookahead: '2' });
  const created = createSeries({ title: 'Smoke: мёртвая станция', genre: 'zombie', episodesPlanned: 3, episodeSec: 600 });
  db.prepare('UPDATE series SET auto_compose = 1, lookahead = 2 WHERE id = ?').run(created.id);
  const before = db.prepare('SELECT COUNT(*) c FROM series_episodes WHERE series_id = ?').get(created.id).c;
  const dry = seriesAutopilot({ dryRun: true });
  const after = db.prepare('SELECT COUNT(*) c FROM series_episodes WHERE series_id = ?').get(created.id).c;
  if (after !== before) throw new Error('dryRun сочинил серии — GET не должен менять данные');
  const real = seriesAutopilot();
  const grown = db.prepare('SELECT COUNT(*) c FROM series_episodes WHERE series_id = ?').get(created.id).c;
  if (!real.composed && grown === before) throw new Error('автопилот не сочинил ни одной серии');
  const view = seriesOverview();
  if (!view.autopilot || !view.frames) throw new Error('обзор сериалов не отдаёт автопилот и кадры');
  db.prepare('DELETE FROM series_episodes WHERE series_id = ?').run(created.id);
  db.prepare('DELETE FROM series WHERE id = ?').run(created.id);
  ok('автопилот сериала', `dryRun без записи, реальный прогон +${grown - before} серий`);
} catch (err) { fail('автопилот сериала', err); }

try {
  // студия: чек-лист запуска считается из реальных данных
  const { oauthStatus } = await import('../src/engine/oauth.js');
  const { framesStatus } = await import('../src/engine/frames.js');
  const { providers } = await import('../src/providers/index.js');
  const status = { frames: framesStatus(), oauth: { platforms: oauthStatus() }, providers: providers.status() };
  if (!status.providers.llm?.length) throw new Error('провайдеры не отдают список моделей');
  if (!status.oauth.platforms.length) throw new Error('oauth-платформы не отдаются студии');
  ok('студия: состояние интеграций', `${status.oauth.platforms.length} площадки · ${status.frames.providers.length} картинок · ${status.providers.publish.length} публикаций`);
} catch (err) { fail('студия: состояние интеграций', err); }

try {
  // ИИ-слой: бесплатные провайдеры идут первыми, статус честный, озвучка бесплатная
  const llm = await import('../src/providers/llm.js');
  const saved = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = 'nvapi-smoke';
  const chain = llm.chain().map((p) => p.id);
  if (!chain.length) throw new Error('ключ задан, а цепочка пустая');
  if (chain[0] !== 'ollama' && chain[0] !== 'nvidia') throw new Error(`бесплатные провайдеры не первые: ${chain.join(',')}`);
  if (saved === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = saved;

  const status = llm.status();
  if (!Array.isArray(status.providers) || !status.providers.length) throw new Error('статус ИИ без провайдеров');
  if (!Array.isArray(status.chain)) throw new Error('статус ИИ без явной цепочки провайдеров');
  if (typeof status.callsToday !== 'number') throw new Error('статус ИИ без счётчика запросов за день');
  const nvidia = status.providers.find((p) => p.id === 'nvidia');
  if (!nvidia?.free) throw new Error('NVIDIA не помечен бесплатным');

  const edge = await import('../src/providers/tts/edge.js');
  if (!/^[A-F0-9]{64}$/.test(edge.secMsGec(new Date('2026-10-29T12:00:00Z').getTime()))) throw new Error('Sec-MS-GEC не sha256-hex');
  if (edge.secMsGec(1000) === edge.secMsGec(1000 + 5 * 60 * 1000 + 1)) throw new Error('окно 5 минут не двигает токен');
  if (!edge.escapeSsml('a & <b>').includes('&amp;')) throw new Error('SSML не экранируется');
  const parts = edge.splitText('Слово. '.repeat(900));
  if (parts.length < 2 || parts.some((x) => x.length > 2600)) throw new Error(`нарезка озвучки: ${parts.map((x) => x.length).join(',')}`);
  if (edge.resolveVoice('ru-female') !== 'ru-RU-SvetlanaNeural') throw new Error('голос ru-female не резолвится');

  const { providers } = await import('../src/providers/index.js');
  if (providers.tts.current() !== 'edge') throw new Error(`TTS по умолчанию не бесплатный: ${providers.tts.current()}`);
  if (!providers.video.providers().some((p) => p.id === 'nvidia')) throw new Error('нет видео-адаптера NVIDIA');
  ok('ИИ: цепочка, статус и бесплатная озвучка', `${chain[0]} → …, TTS edge, ${parts.length} частей по ≤2600 знаков`);
} catch (err) { fail('ИИ: цепочка, статус и бесплатная озвучка', err); }

try {
  // Серия: сценарий раскладывается по планам, аудит оригинальности считается
  const { createSeries, composeEpisode } = await import('../src/engine/series.js');
  const { db } = await import('../src/core/db.js');
  const created = createSeries({ title: 'Smoke: тихий город', genre: 'zombie', episodesPlanned: 3, episodeSec: 600 });
  try {
    const ep = composeEpisode({ seriesId: created.id, episodeNo: 1 });
    if (!ep?.scenes?.length) throw new Error('серия не собрана');
    if (!ep.script?.sections?.length) throw new Error('нет секций озвучки');
    const audit = ep.authenticity || ep.script.audit;
    if (!audit || typeof audit.score !== 'number') throw new Error('нет аудита оригинальности');
    const withText = ep.scenes.filter((x) => String(x.text || '').trim()).length;
    if (withText < ep.scenes.length * 0.5) throw new Error(`текст есть только в ${withText} из ${ep.scenes.length} сцен`);
    const frames = (ep.frames || []).length;
    if (!frames) throw new Error('фото-ряд не спланирован');
    ok('сериал: ИИ-текст и аудит', `${ep.scenes.length} планов, ${frames} кадров, секций ${ep.script.sections.length}, аудит ${audit.score}`);
  } finally {
    db.prepare('DELETE FROM series_episodes WHERE series_id = ?').run(created.id);
    db.prepare('DELETE FROM series WHERE id = ?').run(created.id);
  }
} catch (err) { fail('сериал: ИИ-текст и аудит', err); }

try {
  // Автопилот платформы: идеи добираются, ролик уходит в конвейер, источник честный
  const { enqueue, drain } = await import('../src/core/queue.js');
  const { db, nowIso, setSettings } = await import('../src/core/db.js');
  await import('../src/engine/pipeline.js');
  setSettings({ autopilot_global: '1' });
  const pid = 'pr_smoke_auto';
  db.prepare(`INSERT INTO projects (id, name, niche, autopilot, posts_per_day, created_at, updated_at)
    VALUES (?, 'SmokeAutopilot', 'тест конвейера', 1, 1, ?, ?)`).run(pid, nowIso(), nowIso());
  try {
    enqueue('autopilot.tick', {});
    // очередь уже наполнена задачами прошлых проверок — даём планировщику пройти её
    await drain(30);
    for (let i = 0; i < 20; i++) {
      const st = db.prepare("SELECT status FROM jobs WHERE type = 'autopilot.tick' ORDER BY created_at DESC LIMIT 1").get()?.status;
      if (st !== 'pending') break;
      await drain(30);
    }
    const ideas = db.prepare('SELECT source, COUNT(*) c FROM ideas WHERE project_id = ? GROUP BY source').all(pid);
    const total = ideas.reduce((a, r) => a + r.c, 0);
    if (!total) {
      const j = db.prepare("SELECT status, last_error FROM jobs WHERE type = 'autopilot.tick' ORDER BY created_at DESC LIMIT 1").get();
      throw new Error(`автопилот не добрал ни одной темы (джоба: ${j?.status || '—'} ${j?.last_error || ''})`);
    }
    if (ideas.some((r) => !['ai', 'template'].includes(r.source))) throw new Error(`неизвестный источник идей: ${ideas.map((r) => r.source).join(',')}`);
    const eps = db.prepare('SELECT COUNT(*) n FROM episodes WHERE project_id = ?').get(pid).n;
    if (!eps) throw new Error('автопилот не поставил ни одного ролика в конвейер');
    ok('автопилот платформы', `${total} тем (${ideas.map((r) => `${r.source}:${r.c}`).join(', ')}), ${eps} ролика в конвейере`);
  } finally {
    db.prepare('DELETE FROM episodes WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM ideas WHERE project_id = ?').run(pid);
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
  }
} catch (err) { fail('автопилот платформы', err); }

try {
  // Бесплатные ключи: GitHub Models и Cloudflare должны попадать в цепочку, но не врать
  const llm = await import('../src/providers/llm.js');
  const saved = { gh: process.env.GITHUB_TOKEN, cf: process.env.CLOUDFLARE_AI_TOKEN, acc: process.env.CLOUDFLARE_ACCOUNT_ID };
  process.env.GITHUB_TOKEN = 'ghp-smoke';
  process.env.CLOUDFLARE_AI_TOKEN = 'cf-smoke';
  const withoutAccount = llm.chain().map((p) => p.id);
  if (!withoutAccount.includes('github')) throw new Error('GitHub Models не попал в цепочку');
  if (withoutAccount.includes('cloudflare')) throw new Error('Cloudflare без account id считается готовым');
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acc-smoke';
  const withAccount = llm.chain().map((p) => p.id);
  if (!withAccount.includes('cloudflare')) throw new Error('Cloudflare не попал в цепочку с account id');
  const st = llm.status();
  for (const id of ['github', 'cloudflare']) {
    if (!st.providers.find((p) => p.id === id)?.free) throw new Error(`${id} не помечен бесплатным`);
  }
  if (saved.gh === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved.gh;
  if (saved.cf === undefined) delete process.env.CLOUDFLARE_AI_TOKEN; else process.env.CLOUDFLARE_AI_TOKEN = saved.cf;
  if (saved.acc === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = saved.acc;
  ok('бесплатные ключи: GitHub Models и Cloudflare', 'оба в цепочке, Cloudflare не врёт без account id');
} catch (err) { fail('бесплатные ключи: GitHub Models и Cloudflare', err); }

try {
  // Один клик «заработать»: включает автопилот, идемпотентен, честно перечисляет блокеры
  const { startAutopilot, stopAutopilot } = await import('../src/engine/launch.js');
  const { db, setSettings } = await import('../src/core/db.js');
  setSettings({ autopilot_global: '0', series_autopublish: '0', ads_enabled: '0', manual_review: '1' });
  db.prepare("UPDATE projects SET autopilot = 0").run();
  const first = startAutopilot();
  if (!first.changes.length) throw new Error('автопилот не изменил ни одной настройки');
  if (String(first.settings.autopilot_global) !== '1') throw new Error('autopilot_global не включился');
  if (String(first.settings.manual_review) !== '0') throw new Error('ручная проверка не снялась');
  if (db.prepare('SELECT COUNT(*) n FROM projects WHERE COALESCE(autopilot,0) = 0 AND archived = 0').get().n) {
    throw new Error('остались проекты без автопилота');
  }
  if (!Array.isArray(first.blockers)) throw new Error('блокеры не посчитаны');
  const second = startAutopilot();
  if (second.changes.length) throw new Error(`повторный запуск что-то меняет: ${second.changes.join(', ')}`);
  const stopped = stopAutopilot();
  if (String(stopped.settings.autopilot_global) !== '0') throw new Error('автопилот не остановился');
  startAutopilot();
  ok('запуск на деньги: один клик', `${first.changes.length} настроек, блокеров ${first.blockers.length}, повтор идемпотентен`);
} catch (err) { fail('запуск на деньги: один клик', err); }

try {
  // Проверка публичного адреса: отличает «не задан», «не отвечает» и «медиа сломано»
  const { publicUrlCheck } = await import('../src/engine/launch.js');
  const empty = await publicUrlCheck({ url: '' });
  if (empty.ok || !/не задан/.test(empty.reason)) throw new Error('пустой адрес не отловлен');

  const answered = await publicUrlCheck({
    url: 'https://pulse.example.com',
    fetchImpl: async (u) => ({ ok: true, status: 200, headers: { get: () => 'video/mp4' } }),
  });
  if (!answered.ok) throw new Error(`живой адрес признан мёртвым: ${answered.reason}`);
  if (!answered.note && !answered.media) throw new Error('нет ни заметки про медиа, ни результата медиа');

  const broken = await publicUrlCheck({
    url: 'https://pulse.example.com',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  if (broken.ok || !/не отвечает/.test(broken.reason)) throw new Error('недоступный адрес не отловлен');
  ok('проверка публичного адреса', 'пусто / недоступно / доступно — три разных ответа');
} catch (err) { fail('проверка публичного адреса', err); }

try {
  // Себестоимость по факту: бесплатные Edge/Flux/NVIDIA не должны давать «убыток»
  const { effectiveCosts, freeStack } = await import('../src/engine/costs.js');
  const { setSettings } = await import('../src/core/db.js');
  const c = effectiveCosts();
  const stack = freeStack();
  if (stack.tts.provider === 'edge' && c.tts !== 0) throw new Error(`Edge TTS, а озвучка стоит ${c.tts} ₽`);
  if (stack.video.free && c.video !== 0) throw new Error(`бесплатное видео, а цена ${c.video} ₽`);
  if (c.perVideo > 5) throw new Error(`себестоимость ролика на бесплатном стеке ${c.perVideo} ₽ — слишком много`);
  if (!c.note) throw new Error('нет пояснения, что бесплатно');
  // владелец платит за сервер — расчёт обязан вернуться к прайсу настроек
  setSettings({ powered_by_me: '1', cost_video: '45', cost_tts: '12', cost_llm: '8', cost_render: '1' });
  const paid = effectiveCosts();
  if (paid.perVideo < 60) throw new Error(`powered_by_me не вернул прайс: ${paid.perVideo}`);
  setSettings({ powered_by_me: '0' });
  ok('себестоимость по факту провайдеров', `бесплатный стек: ${c.perVideo} ₽ за ролик вместо ${paid.perVideo} ₽ по прайсу`);
} catch (err) { fail('себестоимость по факту провайдеров', err); }

try {
  // Telegram-сводка: отправка не бросает, ошибка площадки не рушит конвейер
  const notify = await import('../src/engine/notify.js');
  const cfg = notify.notifyConfig();
  if (cfg.configured) throw new Error('Telegram «настроен» без токена');
  const skipped = await notify.sendTelegram('тест', { fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }) });
  if (!skipped.skipped) throw new Error('без токена сообщение не помечено пропущенным');

  const data = notify.digestData();
  if (typeof data.published !== 'number' || !Array.isArray(data.blockers)) throw new Error('сводка собрана неверно');
  const text = notify.digestText(data);
  if (!/сводка/.test(text) || text.length < 40) throw new Error('текст сводки пустой');

  const sent = await notify.sendTelegram('<b>x</b>', {
    token: '1:test', chat: '42',
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  if (!sent.ok) throw new Error(`отправка не удалась: ${sent.reason}`);

  const broken = await notify.sendTelegram('x', {
    token: '1:test', chat: '42',
    fetchImpl: async () => { throw new Error('ETIMEDOUT'); },
  });
  if (broken.ok || !/ETIMEDOUT/.test(broken.reason)) throw new Error('ошибка сети не отловлена');
  ok('Telegram-сводка', `блокеров ${data.blockers.length}, отправка и ошибки обработаны`);
} catch (err) { fail('Telegram-сводка', err); }

try {
  // Ссылка продукта — единственное место, где трафик превращается в деньги.
  // Проверяем на своём локальном сервере: 200, 404, редирект на другой хост, мусор.
  const http = await import('node:http');
  const { checkLink, withUtm } = await import('../src/engine/linkcheck.js');
  const site = http.createServer((req, res) => {
    if (req.url === '/go') { res.writeHead(302, { location: `http://localhost:${site.address().port}/ok` }); return res.end(); }
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>ok</h1>'); }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('нет такой страницы');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;

  const live = await checkLink(`${base}/ok`);
  if (!live.ok || live.status !== 200) throw new Error(`живая ссылка не распознана: ${live.note}`);
  if (live.level === 'ok' && live.https) throw new Error('http-ссылка названа https');

  const dead = await checkLink(`${base}/missing`);
  if (dead.ok || dead.error !== 'not_found' || !/не найдена/.test(dead.note)) throw new Error('404 не отловлен');

  const moved = await checkLink(`${base}/go`);
  if (!moved.ok || !moved.redirected) throw new Error('редирект не отслежен');

  const junk = await checkLink('не ссылка вовсе');
  if (junk.ok || junk.error !== 'invalid_url') throw new Error('мусор принят за ссылку');

  const timeout = await checkLink('http://10.255.255.1/', { timeoutMs: 1200 });
  if (timeout.ok) throw new Error('недоступный адрес считается живым');

  const tagged = withUtm('https://example.com/p?x=1', { source: 'reels', medium: 'short', campaign: 'pro launch' });
  const parsed = new URL(tagged);
  if (parsed.searchParams.get('utm_source') !== 'reels' || parsed.searchParams.get('utm_campaign') !== 'pro launch') throw new Error('UTM собраны неверно');
  if (parsed.searchParams.get('x') !== '1') throw new Error('UTM затирают существующие параметры');

  site.close();
  ok('проверка ссылки продукта', 'живая / 404 / редирект / мусор / таймаут / UTM');
} catch (err) { fail('проверка ссылки продукта', err); }

try {
  // ИИ-роутер: живой HTTP к OpenAI-совместимому провайдеру, кэш и деградация.
  const http = await import('node:http');
  const llm = await import('../src/providers/llm.js');
  let hits = 0;
  const mock = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'mock-70b',
        choices: [{ message: { content: JSON.stringify({ scenes: [{ text: 'раз' }, { text: 'два' }] }) } }],
      }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.PULSE_AI = 'on';
  process.env.NVIDIA_API_KEY = 'smoke-key';
  process.env.NVIDIA_BASE_URL = `http://127.0.0.1:${mock.address().port}/v1`;
  process.env.NVIDIA_MODEL = 'mock-70b';

  const status = llm.status();
  if (!status.providers.some((p) => p.id === 'nvidia' && p.configured)) throw new Error('ключ не виден роутеру');
  if (status.chain[0] !== 'nvidia' && !status.chain.includes('nvidia')) throw new Error('провайдер не попал в цепочку');
  if (JSON.stringify(status).includes('smoke-key')) throw new Error('ключ утёк в статус');

  const first = await llm.completeJson({ prompt: 'смоук: верни сцены', maxTokens: 50 });
  if (!first.ok || first.data?.scenes?.length !== 2) throw new Error(`роутер не разобрал ответ: ${first.reason || 'нет данных'}`);
  const before = hits;
  const again = await llm.completeJson({ prompt: 'смоук: верни сцены', maxTokens: 50 });
  if (!again.cached || hits !== before) throw new Error('кэш не сработал: бесплатная квота тратится повторно');

  mock.close();
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_BASE_URL;
  delete process.env.NVIDIA_MODEL;

  // «Без ключа ИИ выключен» проверяем в чистом окружении: у владельца в .env
  // может лежать любой бесплатный ключ (например GITHUB_TOKEN), и тогда старая
  // версия теста падала не по делу. Ключи возвращаем как было.
  const keyEnvs = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY',
    'MISTRAL_API_KEY', 'GITHUB_TOKEN', 'CLOUDFLARE_AI_TOKEN', 'OPENAI_API_KEY'];
  const kept = Object.fromEntries(keyEnvs.map((k) => [k, process.env[k]]));
  for (const k of keyEnvs) delete process.env[k];
  try {
    if (llm.enabled()) throw new Error('без ключа ИИ остался включённым');
  } finally {
    for (const k of keyEnvs) {
      if (kept[k] === undefined) delete process.env[k]; else process.env[k] = kept[k];
    }
  }
  ok('ИИ-роутер', `${first.provider}/${first.model}, кэш и деградация работают`);
} catch (err) { fail('ИИ-роутер', err); }

try {
  // Один каталог данных: если задан только PULSE_DATA_DIR (так написано в .env.example),
  // база и медиа обязаны оказаться внутри него — иначе на Railway они вне тома
  // и исчезают после перезапуска.
  const saved = { data: process.env.PULSE_DATA_DIR, db: process.env.PULSE_DB_PATH, media: process.env.PULSE_MEDIA_DIR };
  const probeDir = path.join(tmp, 'paths-probe');
  process.env.PULSE_DATA_DIR = probeDir;
  delete process.env.PULSE_DB_PATH;
  delete process.env.PULSE_MEDIA_DIR;
  const probe = await import('../src/core/paths.js?probe=1');
  if (probe.DATA_DIR !== probeDir) throw new Error(`DATA_DIR ${probe.DATA_DIR}`);
  if (probe.DB_PATH !== path.join(probeDir, 'pulse.db')) throw new Error(`DB_PATH ${probe.DB_PATH} вне каталога данных`);
  if (probe.MEDIA_DIR !== path.join(probeDir, 'media')) throw new Error(`MEDIA_DIR ${probe.MEDIA_DIR} вне каталога данных`);
  probe.ensureDirs();
  if (!fs.existsSync(path.join(probeDir, 'media'))) throw new Error('каталог медиа не создан');

  // явные переменные главнее: раздельный том должен работать
  process.env.PULSE_MEDIA_DIR = path.join(tmp, 'media-elsewhere');
  process.env.PULSE_DB_PATH = path.join(tmp, 'db-elsewhere.db');
  const probe2 = await import('../src/core/paths.js?probe=2');
  if (probe2.MEDIA_DIR !== path.join(tmp, 'media-elsewhere')) throw new Error('PULSE_MEDIA_DIR не учтён');
  if (probe2.DB_PATH !== path.join(tmp, 'db-elsewhere.db')) throw new Error('PULSE_DB_PATH не учтён');
  process.env.PULSE_DATA_DIR = saved.data; process.env.PULSE_DB_PATH = saved.db; process.env.PULSE_MEDIA_DIR = saved.media;
  ok('каталог данных', 'база и медиа внутри PULSE_DATA_DIR, явные пути главнее');
} catch (err) { fail('каталог данных', err); }

try {
  // Паспорт ролика: в карточке должно быть видно, кто сделал каждый шаг —
  // модель или шаблон. Проверяем сам механизм (без сети и без ключей), иначе
  // тест зависел бы от того, подключён ли LLM.
  const { createEpisode } = await import('../src/engine/pipeline.js');
  const { aiPassport, scriptAuthor, markAi } = await import('../src/engine/aimeta.js');
  const { db } = await import('../src/core/db.js');

  const project = db.prepare('SELECT id FROM projects LIMIT 1').get();
  const ep = createEpisode({ projectId: project.id, autopilot: 0 }).id;

  // новый ролик: паспорта нет, но интерфейс не должен падать
  const fresh = aiPassport(db.prepare('SELECT ai_meta FROM episodes WHERE id = ?').get(ep).ai_meta);
  if (fresh.steps.length) throw new Error('у нового ролика уже есть шаги');
  if (scriptAuthor(db.prepare('SELECT ai_meta FROM episodes WHERE id = ?').get(ep).ai_meta) !== null) {
    throw new Error('автор сценария появился до сценария');
  }

  // шаги пишутся по мере конвейера; шаблон честно помечается, а не выдаётся за ИИ
  markAi(ep, 'idea', { provider: 'studio', model: 'автопилот' });
  markAi(ep, 'script', { provider: 'template', model: 'Content Brain', note: 'без языковой модели' });
  markAi(ep, 'voice', { provider: 'edge', model: 'ru-RU-DmitryNeural', note: '31 с' });
  markAi(ep, 'render', { provider: 'ffmpeg', model: '1080×1920 @ 30 fps', ms: 2400 });
  markAi(ep, 'footage', { provider: 'nvidia', demo: true, note: 'демо-режим' });

  const row = db.prepare('SELECT ai_meta FROM episodes WHERE id = ?').get(ep);
  const passport = aiPassport(row.ai_meta);
  const author = scriptAuthor(row.ai_meta);

  if (passport.steps.length !== 5) throw new Error(`шагов ${passport.steps.length}, ожидалось 5`);
  // порядок — как в конвейере, а не как записали
  const order = passport.steps.map((x) => x.id).join(',');
  if (order !== 'idea,script,voice,footage,render') throw new Error(`порядок шагов: ${order}`);
  if (passport.steps.find((x) => x.id === 'render').ms !== 2400) throw new Error('время рендера потерялось');
  if (passport.steps.find((x) => x.id === 'voice').providerLabel !== 'Edge TTS') throw new Error('нет человеческого имени провайдера');
  if (passport.steps.find((x) => x.id === 'footage').demo !== true) throw new Error('демо-шаг не помечен');
  if (!passport.models.includes('ru-RU-DmitryNeural')) throw new Error('модель озвучки не попала в сводку');
  if (passport.aiSteps !== 4) throw new Error(`машинных шагов ${passport.aiSteps}, ожидалось 4 (без шаблона)`);

  if (author.ai !== false) throw new Error('шаблон выдан за модель');
  if (author.label !== 'шаблон Content Brain' || author.short !== 'шаблон') throw new Error(`автор: ${author.label}`);

  // модель вместо шаблона — и подпись для строки очереди без префикса провайдера
  markAi(ep, 'script', { provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct' });
  const real = scriptAuthor(db.prepare('SELECT ai_meta FROM episodes WHERE id = ?').get(ep).ai_meta);
  if (real.ai !== true) throw new Error('модель не отличилась от шаблона');
  if (real.short !== 'llama-3.3-70b-instruct') throw new Error(`короткая подпись: ${real.short}`);

  // паспорт не должен ронять конвейер, если записи нет
  if (markAi('нет-такого-ролика', 'voice', { provider: 'edge' }) !== null) throw new Error('markAi не проверил ролик');

  db.prepare('DELETE FROM jobs WHERE payload LIKE ?').run(`%${ep}%`);
  db.prepare('DELETE FROM episodes WHERE id = ?').run(ep);
  ok('паспорт ролика', `5 шагов в порядке конвейера, шаблон ≠ модель, ${passport.aiSteps} машинных`);
} catch (err) { fail('паспорт ролика', err); }

try {
  // Каждый шаг конвейера обязан оставлять запись в паспорте. Проверка по коду:
  // если новый шаг забудут разметить, паспорт молча станет неполным.
  const src = fs.readFileSync(path.join(process.cwd(), 'server/src/engine/pipeline.js'), 'utf8');
  const missing = ['script', 'idea', 'voice', 'footage', 'render', 'publish']
    .filter((step) => !src.includes(`markAi(episodeId, '${step}'`));
  if (missing.length) throw new Error(`без паспорта остались шаги: ${missing.join(', ')}`);
  ok('паспорт: разметка шагов', 'идея, сценарий, озвучка, кадры, монтаж, публикация');
} catch (err) { fail('паспорт: разметка шагов', err); }

try {
  // Домен: кириллица, punycode, схема, путь, порт. Раньше `edu.каркастайги.рф`
  // возвращался как есть — без https — и панель ругалась «адрес без HTTPS» на
  // правильную настройку. Теперь любая форма приводится к рабочему виду.
  const { normalizeDomain, publicBase, publicPair, publicHint, originFromRequest } = await import('../src/core/publicurl.js');

  const uni = normalizeDomain('edu.каркастайги.рф');
  if (!uni.ascii || /Ѐ-ӿ/.test(uni.ascii)) throw new Error('кириллица не переведена в punycode');
  if (uni.url !== `https://${uni.ascii}`) throw new Error(`схема не добавлена: ${uni.url}`);
  if (uni.unicode !== 'edu.каркастайги.рф') throw new Error(`потерялось написание для человека: ${uni.unicode}`);

  // та же настройка, но человек добавил схему и слэш — результат не должен меняться
  const withScheme = normalizeDomain('https://edu.каркастайги.рф/');
  if (withScheme.url !== uni.url) throw new Error('https:// и слэш дают другой адрес');

  // punycode руками — тоже рабочий вариант, схема всё равно нужна
  const ascii = normalizeDomain(uni.ascii);
  if (ascii.url !== uni.url) throw new Error('punycode-запись разобралась иначе');

  // регистр и порт
  if (normalizeDomain('EDU.Каркастайги.РФ').url !== uni.url) throw new Error('регистр ломает домен');
  if (!normalizeDomain('localhost:8080').url.endsWith(':8080')) throw new Error('порт потерялся');
  if (normalizeDomain('http://localhost:8080').url !== 'http://localhost:8080') throw new Error('явный http не уважается');

  // мусор — понятная ошибка, а не молчаливая подстановка
  for (const bad of ['не домен', 'http://', 'домен']) {
    if (!normalizeDomain(bad).error) throw new Error(`мусор «${bad}» принят за домен`);
  }

  // PULSE_DOMAIN=localhost — дефолт Caddyfile, а не публичный адрес:
  // площадки не должны получить ссылку на localhost, а локальный вход не должен
  // превратиться в «облачный» со случайным паролем.
  const savedEnv = { pub: process.env.PULSE_PUBLIC_URL, dom: process.env.PULSE_DOMAIN };
  delete process.env.PULSE_PUBLIC_URL;
  process.env.PULSE_DOMAIN = 'localhost';
  const { isHosted } = await import('../src/core/publicurl.js');
  if (publicBase()) throw new Error('localhost стал публичным адресом');
  if (isHosted()) throw new Error('localhost признан облаком');
  delete process.env.PULSE_DOMAIN;
  if (savedEnv.pub !== undefined) process.env.PULSE_PUBLIC_URL = savedEnv.pub;
  if (savedEnv.dom !== undefined) process.env.PULSE_DOMAIN = savedEnv.dom;

  // и главное: панель больше не ругается на правильную настройку
  const savedUrl = process.env.PULSE_PUBLIC_URL;
  const savedDomain = process.env.PULSE_DOMAIN;
  delete process.env.PULSE_DOMAIN;
  process.env.PULSE_PUBLIC_URL = 'edu.каркастайги.рф';
  const base = publicBase();
  if (!base.startsWith('https://')) throw new Error(`publicBase без https: ${base}`);
  if (publicHint().error) throw new Error('на кириллицу снова ругаемся');
  const pair = publicPair();
  if (!pair.unicode || pair.unicode === pair.ascii) throw new Error('обе формы не отдаются интерфейсу');
  if (savedUrl === undefined) delete process.env.PULSE_PUBLIC_URL; else process.env.PULSE_PUBLIC_URL = savedUrl;
  if (savedDomain !== undefined) process.env.PULSE_DOMAIN = savedDomain;

  // redirect_uri OAuth: латиница даже если в Host пришла кириллица
  const fakeReq = {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'edu.каркастайги.рф' },
    protocol: 'http',
    get: () => 'edu.каркастайги.рф',
  };
  const origin = originFromRequest(fakeReq);
  if (/Ѐ-ӿ/.test(origin) || !origin.startsWith('https://')) throw new Error(`redirect_uri не латиницей: ${origin}`);

  ok('домен: кириллица и punycode', `${uni.unicode} → ${uni.ascii}`);
} catch (err) { fail('домен: кириллица и punycode', err); }

try {
  // Сессия в cookie: без неё на телефоне вход молча не срабатывал
  // (localStorage недоступен в приватном режиме и во встроенных браузерах).
  const { sessionCookie, clearCookie, parseCookies, cookieDomain, issueToken, verifyToken, SESSION_COOKIE } = await import('../src/modules/auth.js');

  const https = { headers: { 'x-forwarded-proto': 'https' }, secure: true };
  const http = { headers: {}, secure: false };
  const token = issueToken();
  if (!verifyToken(token)) throw new Error('токен не проверяется');

  const c = sessionCookie(https, token);
  for (const flag of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Secure', 'Max-Age=']) {
    if (!c.includes(flag)) throw new Error(`в cookie нет ${flag}`);
  }
  // значение cookie не должно ломать сам заголовок: base64url безопасен,
  // но проверяем не «сырой/не сырой», а что разделители не просочились
  const value = c.split(';')[0].split('=').slice(1).join('=');
  if (/[;,\s]/.test(value)) throw new Error(`значение cookie с недопустимыми символами: ${value}`);
  if (decodeURIComponent(value) !== token) throw new Error('значение cookie не совпадает с токеном');
  if (sessionCookie(http, token).includes('Secure')) throw new Error('Secure на http сломает вход локально');

  const parsed = parseCookies(`${SESSION_COOKIE}=${encodeURIComponent(token)}; другой=1`);
  if (parsed[SESSION_COOKIE] !== token) throw new Error('cookie не читается обратно');

  const cleared = clearCookie(https);
  if (!cleared.includes('Max-Age=0')) throw new Error('выход не стирает cookie');

  // кириллический cookie-домен должен превратиться в латиницу, иначе браузер
  // выбросит cookie и вход будет «слетать»
  const savedCd = process.env.PULSE_COOKIE_DOMAIN;
  process.env.PULSE_COOKIE_DOMAIN = 'edu.каркастайги.рф';
  const cd = cookieDomain();
  if (!cd || /Ѐ-ӿ/.test(cd)) throw new Error(`cookie-домен не переведён: ${cd}`);
  if (!sessionCookie(https, token).includes(`Domain=${cd}`)) throw new Error('домен не попал в cookie');
  if (savedCd === undefined) delete process.env.PULSE_COOKIE_DOMAIN; else process.env.PULSE_COOKIE_DOMAIN = savedCd;

  ok('сессия в cookie', 'HttpOnly + SameSite=Lax, Secure только на https, кириллический домен → punycode');
} catch (err) { fail('сессия в cookie', err); }

try {
  // Скрипты обновления и разбора домена: LF, shebang и реальный перевод домена.
  // Именно здесь раньше «ругался update.sh»: не-ASCII в sed и Caddy без punycode.
  const { execFileSync } = await import('node:child_process');
  for (const file of ['deploy/domain.sh', 'deploy/update.sh']) {
    const body = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    if (body.includes('\r')) throw new Error(`${file}: CRLF`);
    if (!body.startsWith('#!/')) throw new Error(`${file}: нет shebang`);
  }
  const sh = (code) => execFileSync('sh', ['-c', code], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  const asciiFromShell = sh('. deploy/domain.sh; pulse_to_ascii edu.каркастайги.рф');
  if (!/^xn--|^edu\.xn--/.test(asciiFromShell)) throw new Error(`shell не перевёл домен: ${asciiFromShell}`);
  const urlFromShell = sh('. deploy/domain.sh; pulse_public_url edu.каркастайги.рф');
  if (!urlFromShell.startsWith('https://')) throw new Error('shell не добавил схему');
  const sameForPunycode = sh(`. deploy/domain.sh; pulse_to_ascii ${asciiFromShell}`);
  if (sameForPunycode !== asciiFromShell) throw new Error('повторный перевод меняет домен');

  // Caddy получает домен из .env — там должен оказаться punycode
  const install = fs.readFileSync(path.join(process.cwd(), 'deploy/install.sh'), 'utf8');
  if (!install.includes('pulse_to_ascii')) throw new Error('install.sh не нормализует домен');
  const compose = fs.readFileSync(path.join(process.cwd(), 'docker-compose.yml'), 'utf8');
  if (!compose.includes('PULSE_DOMAIN')) throw new Error('compose не передаёт домен в Caddy');
  // entrypoint не может зависеть от каталога deploy: его нет в образе
  // (.dockerignore). В контейнере конвертер делает node.
  const entry = fs.readFileSync(path.join(process.cwd(), 'docker-entrypoint.sh'), 'utf8');
  if (!entry.includes('pulse_to_ascii')) throw new Error('entrypoint не переводит домен');
  if (entry.includes('pulse-domain.sh')) throw new Error('entrypoint ссылается на файл вне образа');
  const dockerignore = fs.readFileSync(path.join(process.cwd(), '.dockerignore'), 'utf8');
  if (/^deploy$/m.test(dockerignore) && entry.includes('deploy/')) {
    throw new Error('entrypoint читает deploy/, а каталог исключён из образа');
  }

  ok('скрипты: домен и обновление', `deploy/update.sh, install.sh и entrypoint переводят домен сами (${asciiFromShell})`);
} catch (err) { fail('скрипты: домен и обновление', err); }

try {
  // Кэш статики: index.html нельзя кэшировать, иначе после обновления телефон
  // открывает старую страницу с уже удалёнными файлами — «белый экран».
  const src = fs.readFileSync(path.join(process.cwd(), 'server/src/index.js'), 'utf8');
  if (!src.includes("res.set('Cache-Control', 'no-cache, must-revalidate')")) throw new Error('index.html кэшируется');
  if (!src.includes('immutable: true')) throw new Error('файлы с хешем не кэшируются надолго');
  const vite = fs.readFileSync(path.join(process.cwd(), 'web/vite.config.js'), 'utf8');
  if (!vite.includes('safari13')) throw new Error('сборка не рассчитана на старые телефоны');
  ok('телефон: кэш и совместимость', 'index.html без кэша, assets immutable, сборка под es2019/safari13');
} catch (err) { fail('телефон: кэш и совместимость', err); }

try {
  // Навигация: пять разделов, у каждого — вкладки, и у каждой вкладки есть экран.
  // Проверка ловит типичную ошибку рефакторинга: вкладку добавили в меню, а
  // компонент не подключили — получается пустой экран без ошибки в консоли.
  const nav = await import('../../web/src/lib/nav.js');
  const appSource = fs.readFileSync(path.join(process.cwd(), 'web/src/App.jsx'), 'utf8');
  if (nav.SECTIONS.length > 5) throw new Error(`разделов ${nav.SECTIONS.length} — меню снова разрастается`);

  const ids = new Set();
  for (const sec of nav.SECTIONS) {
    if (ids.has(sec.id)) throw new Error(`раздел ${sec.id} повторяется`);
    ids.add(sec.id);
    if (!sec.tabs.length) throw new Error(`у раздела ${sec.id} нет вкладок`);
    for (const tab of sec.tabs) {
      const key = `${sec.id}/${tab.id}`;
      if (!appSource.includes(`'${key}'`)) throw new Error(`вкладка ${key} есть в меню, но не подключена к экрану`);
    }
  }
  // старые адреса обязаны продолжать работать: их помнят закладки и письма
  for (const [legacy, [sec, tab]] of Object.entries(nav.LEGACY)) {
    const r = nav.resolveRoute(`#/${legacy}`);
    if (r.section !== sec || r.tab !== tab) throw new Error(`старый адрес #/${legacy} не разрешился`);
  }
  if (nav.resolveRoute('').section !== 'today') throw new Error('пустой адрес должен вести на «Сегодня»');
  if (nav.resolveRoute('#/money/ads').tab !== 'ads') throw new Error('вложенный адрес не разобрался');
  if (nav.resolveRoute('#/нет-такого').section !== 'today') throw new Error('мусорный адрес не должен ломать приложение');

  // Переводы строк: CRLF в shell-скриптах даёт "No such file or directory" и код 127
  // ещё до старта контейнера. Проверяем и файлы, и то, что Dockerfile это лечит.
  for (const file of ['docker-entrypoint.sh', 'deploy/install.sh', 'deploy/railway.sh', 'deploy/tunnel.sh', 'deploy/update.sh', 'deploy/domain.sh']) {
    const body = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    if (body.includes('\r')) throw new Error(`${file}: CRLF в shell-скрипте`);
    if (!body.startsWith('#!')) throw new Error(`${file}: нет shebang`);
  }
  const dockerfile = fs.readFileSync(path.join(process.cwd(), 'Dockerfile'), 'utf8');
  if (!dockerfile.includes("sed -i 's/\\r$//' /usr/local/bin/docker-entrypoint.sh")) {
    throw new Error('Dockerfile не защищён от CRLF в entrypoint');
  }
  const attrs = fs.readFileSync(path.join(process.cwd(), '.gitattributes'), 'utf8');
  if (!attrs.includes('*.sh text eol=lf')) throw new Error('.gitattributes не фиксирует LF для .sh');
  ok('навигация и переводы строк', `${nav.SECTIONS.length} разделов, ${Object.keys(nav.LEGACY).length} старых адресов живы, LF в скриптах`);
} catch (err) { fail('навигация и переводы строк', err); }

try {
  // База знаний: у каждой площадки есть лимиты API, поля, алгоритм, часы, демоции
  // и путь к деньгам. Экран «База знаний» не должен показывать пустоту.
  const { platformKnowledge } = await import('../src/engine/growth.js');
  const k = platformKnowledge();
  if (k.platforms.length !== 3) throw new Error(`площадок ${k.platforms.length}, ожидалось 3`);
  for (const pl of k.platforms) {
    if (!pl.api?.per24h) throw new Error(`${pl.platform}: нет лимита API`);
    if (!pl.fields?.captionMax) throw new Error(`${pl.platform}: нет лимита описания`);
    if (!pl.algorithm?.idealSec?.length) throw new Error(`${pl.platform}: нет идеальной длины`);
    if (!pl.demotions?.length) throw new Error(`${pl.platform}: нет списка демоций`);
    if (!pl.windows?.best?.length) throw new Error(`${pl.platform}: нет лучших часов`);
    if (!pl.api.official?.startsWith('https://')) throw new Error(`${pl.platform}: нет ссылки на документацию`);
  }
  if (!k.monetization.length) throw new Error('нет программ монетизации');
  for (const m of k.monetization) if (!m.changes) throw new Error(`${m.id}: не описаны ограничения`);
  if (!k.general?.economics?.length) throw new Error('нет экономики тысячи просмотров');
  if (!k.general?.firstWeek?.length) throw new Error('нет чек-листа первой недели');
  if (!k.general?.truth?.length) throw new Error('нет честных границ');
  ok('база знаний', `${k.platforms.length} площадки · ${k.monetization.length} программ · ${k.general.economics.length} строк экономики`);
} catch (err) { fail('база знаний', err); }

try {
  // Готовность хостинга: без тома на Railway — блокер, с томом и паролем — чисто.
  // Публичный адрес должен подхватываться из RAILWAY_PUBLIC_DOMAIN без настроек.
  const { deployReadiness, hostingPlatform, readinessLine } = await import('../src/engine/deploy.js');
  const { publicBase, publicHint, isHosted } = await import('../src/core/publicurl.js');

  if (publicBase({ RAILWAY_PUBLIC_DOMAIN: 'pulse-prod.up.railway.app' }) !== 'https://pulse-prod.up.railway.app') {
    throw new Error('адрес Railway не подхватился');
  }
  if (publicHint({ RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }).source !== 'RAILWAY_PUBLIC_DOMAIN') throw new Error('источник адреса не определён');
  if (publicBase({ RENDER_EXTERNAL_URL: 'https://pulse.onrender.com/' }) !== 'https://pulse.onrender.com') throw new Error('адрес Render не подхватился');
  if (publicBase({ FLY_APP_NAME: 'pulse' }) !== 'https://pulse.fly.dev') throw new Error('адрес Fly не подхватился');
  if (publicBase({}) !== '') throw new Error('без платформы адрес должен быть пустым');

  const bare = deployReadiness({ env: { RAILWAY_ENVIRONMENT: 'production', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app', PULSE_MODE: 'live' } });
  if (hostingPlatform({ RAILWAY_ENVIRONMENT: 'production' }) !== 'railway') throw new Error('платформа Railway не распознана');
  if (!bare.blockers.some((b) => b.id === 'disk')) throw new Error('отсутствие тома не помечено блокером');

  const ready = deployReadiness({
    env: {
      RAILWAY_ENVIRONMENT: 'production', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app',
      RAILWAY_VOLUME_MOUNT_PATH: path.join(tmp, 'data'), PULSE_DATA_DIR: process.env.PULSE_DATA_DIR,
      PULSE_MODE: 'live', PULSE_PASSWORD: 'strong-password-123',
    },
  });
  if (ready.platform !== 'railway') throw new Error('платформа не Railway');
  if (ready.publicUrl !== 'https://x.up.railway.app') throw new Error(`публичный адрес ${ready.publicUrl}`);
  if (!ready.checks.length) throw new Error('список проверок пуст');
  if (!/Хостинг/.test(readinessLine(ready))) throw new Error('строка для лога не собралась');
  ok('готовность хостинга', `${ready.counts.ok} ок · ${ready.counts.warn} предупр. · ${ready.counts.error} блокеров, адрес из платформы`);
} catch (err) { fail('готовность хостинга', err); }

try {
  // Конфиги развёртывания согласованы с кодом: healthcheck существует, порт берётся
  // из окружения, том монтируется, секреты не попадают в образ, оба режима compose на месте
  const root = process.cwd();
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const railway = JSON.parse(read('railway.json'));
  const compose = read('docker-compose.yml');
  const dockerfile = read('Dockerfile');
  const ignore = read('.dockerignore');

  if (railway.build?.builder !== 'DOCKERFILE') throw new Error('railway.json: builder не DOCKERFILE');
  if (railway.deploy?.healthcheckPath !== '/api/health') throw new Error('railway.json: healthcheck не /api/health');
  if (railway.deploy?.numReplicas !== 1) throw new Error('railway.json: должно быть ровно 1 реплика (SQLite)');
  if (!/api\.get\('\/health'/.test(read('server/src/modules/api.js'))) throw new Error('маршрута /api/health нет в api.js');

  for (const token of ['ffmpeg', 'tini', 'tzdata', 'HEALTHCHECK', 'EXPOSE 8080', 'docker-entrypoint.sh']) {
    if (!dockerfile.includes(token)) throw new Error(`Dockerfile: нет «${token}»`);
  }
  for (const token of ['node_modules', 'data', '.env']) {
    if (!ignore.split('\n').includes(token)) throw new Error(`.dockerignore: не исключён «${token}»`);
  }
  if (!compose.includes('profiles: ["tls"]')) throw new Error('compose: нет профиля tls');
  if (!compose.includes('./data:/app/data')) throw new Error('compose: том данных не смонтирован');
  if (!compose.includes('stop_grace_period')) throw new Error('compose: нет grace period для ffmpeg');
  if (!/api\.get\('\/deploy\/ready'/.test(read('server/src/modules/api.js'))) throw new Error('нет маршрута /api/deploy/ready');
  ok('конфиги развёртывания', 'railway.json · Dockerfile · compose (local + tls) · .dockerignore');
} catch (err) { fail('конфиги развёртывания', err); }

try {
  // Уборка медиа: старое удаляется, свежее остаётся, dryRun ничего не трогает
  const { MEDIA_DIR } = await import('../src/engine/render.js');
  const { pruneMedia, storageUsage } = await import('../src/engine/housekeeping.js');
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const oldFile = path.join(MEDIA_DIR, 'old-smoke.mp4');
  const newFile = path.join(MEDIA_DIR, 'new-smoke.mp4');
  fs.writeFileSync(oldFile, Buffer.alloc(2048));
  fs.writeFileSync(newFile, Buffer.alloc(1024));
  const old = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(oldFile, old, old);

  const usage = storageUsage();
  if (!usage.files) throw new Error('файлы не посчитались');
  if (!usage.staleFiles) throw new Error('старый файл не попал в «устаревшие»');

  const dry = pruneMedia({ days: 14, dryRun: true });
  if (!dry.removed || !fs.existsSync(oldFile)) throw new Error('dryRun удалил файл');

  const done = pruneMedia({ days: 14 });
  if (fs.existsSync(oldFile)) throw new Error('старый файл не удалён');
  if (!fs.existsSync(newFile)) throw new Error('свежий файл удалён по ошибке');
  if (!done.freedBytes) throw new Error('не посчитан освобождённый объём');
  fs.rmSync(newFile, { force: true });
  ok('уборка медиа', `старое удалено (${Math.round(done.freedBytes / 1024)} КБ), свежее на месте`);
} catch (err) { fail('уборка медиа', err); }

fs.rmSync(tmp, { recursive: true, force: true });

// ── отчёт ───────────────────────────────────────────────────────────────────
console.log('');
for (const r of results) {
  console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.extra ? ` — ${r.extra}` : ''}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${failed ? `ПРОВАЛЕНО: ${failed} из ${results.length}` : `Всё в порядке: ${results.length}/${results.length}`}\n`);

// В CI лог шага не всегда открывается, а annotations видно прямо в PR:
// печатаем каждую упавшую проверку строкой GitHub-Actions. Локально они
// выглядят как обычный текст и никому не мешают.
if (process.env.CI) {
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`::error title=Smoke: ${r.name}::${(r.extra || 'проверка не прошла').replace(/[\r\n]+/g, ' ')}`);
  }
}
process.exit(failed ? 1 : 0);
