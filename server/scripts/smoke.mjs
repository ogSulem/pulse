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

fs.rmSync(tmp, { recursive: true, force: true });

// ── отчёт ───────────────────────────────────────────────────────────────────
console.log('');
for (const r of results) {
  console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.extra ? ` — ${r.extra}` : ''}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${failed ? `ПРОВАЛЕНО: ${failed} из ${results.length}` : `Всё в порядке: ${results.length}/${results.length}`}\n`);
process.exit(failed ? 1 : 0);
