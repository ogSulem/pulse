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
  seedBase();
  ok('демо-данные');
} catch (err) { fail('демо-данные', err); }

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

fs.rmSync(tmp, { recursive: true, force: true });

// ── отчёт ───────────────────────────────────────────────────────────────────
console.log('');
for (const r of results) {
  console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.extra ? ` — ${r.extra}` : ''}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${failed ? `ПРОВАЛЕНО: ${failed} из ${results.length}` : `Всё в порядке: ${results.length}/${results.length}`}\n`);
process.exit(failed ? 1 : 0);
