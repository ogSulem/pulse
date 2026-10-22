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

fs.rmSync(tmp, { recursive: true, force: true });

// ── отчёт ───────────────────────────────────────────────────────────────────
console.log('');
for (const r of results) {
  console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.extra ? ` — ${r.extra}` : ''}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${failed ? `ПРОВАЛЕНО: ${failed} из ${results.length}` : `Всё в порядке: ${results.length}/${results.length}`}\n`);
process.exit(failed ? 1 : 0);
