// ─────────────────────────────────────────────────────────────────────────────
// Запуск «на деньги» без вложений.
//
// Две вещи, которые нельзя сделать «потом», потому что без них платформа просто
// красиво выглядит:
//   1) автопилот должен быть включён целиком — иначе контент выходит, только пока
//      владелец сидит в панели;
//   2) публичный адрес должен реально открываться из интернета — Instagram и TikTok
//      забирают видео по ссылке, и «локально работает» здесь не считается.
// Ни один из этих шагов не требует денег: автопилот — настройка, публичный адрес —
// бесплатный туннель (см. deploy/tunnel.sh).
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { db, getSettings, setSettings, nowIso } from '../core/db.js';
import { log } from '../core/logger.js';
import { publicBase as publicBaseOf } from '../core/publicurl.js';
import { DATA_DIR } from '../core/boot.js';

const MEDIA_DIR = process.env.PULSE_MEDIA_DIR || path.join(DATA_DIR, 'media');

/**
 * Включает всё, что можно включить без денег и без ручной работы.
 * Идемпотентно: повторный вызов перечисляет только реально изменённое.
 */
export function startAutopilot({ render = false, review = false } = {}) {
  const before = getSettings();
  const patch = {};
  const changes = [];

  const set = (key, value, label) => {
    if (String(before[key] ?? '') === String(value)) return;
    patch[key] = String(value);
    changes.push(label);
  };

  set('autopilot_global', 1, 'Автопилот платформы: ролики выходят каждый день');
  set('series_autopublish', 1, 'Серии публикуются по расписанию сами');
  set('ads_enabled', 1, 'Бренд-кампании раздаются автоматически');
  set('manual_review', review ? 1 : 0, review ? 'Ручная проверка каждого ролика' : 'Публикация без ручного подтверждения');
  set('ai_label', 1, 'Маркировка ИИ-контента включена');
  set('ad_label', 1, 'Маркировка рекламы включена');
  if (render) set('series_auto_render', 1, 'Сборка серий без человека');

  if (Object.keys(patch).length) setSettings(patch);

  // Проекты: без autopilot = 1 автопилот не берёт их в работу вообще.
  let projects = 0;
  for (const p of db.prepare('SELECT id FROM projects WHERE archived = 0 AND COALESCE(autopilot, 0) = 0').all()) {
    db.prepare('UPDATE projects SET autopilot = 1, updated_at = ? WHERE id = ?').run(nowIso(), p.id);
    projects += 1;
  }

  // Сериалы: подтягиваем запас серий до трёх — сериал не должен «замолчать».
  let series = 0;
  for (const s of db.prepare('SELECT id, auto_compose, lookahead FROM series').all()) {
    if (Number(s.auto_compose) === 1 && Number(s.lookahead || 0) >= 3) continue;
    db.prepare('UPDATE series SET auto_compose = 1, lookahead = MAX(COALESCE(lookahead, 3), 3) WHERE id = ?').run(s.id);
    series += 1;
  }

  // Чего не хватает — честно и по-русски. Это и есть «что мешает заработать».
  const connected = db.prepare("SELECT COUNT(*) n FROM accounts WHERE COALESCE(access_token, '') <> ''").get().n;
  const withoutTopic = db.prepare("SELECT COUNT(*) n FROM accounts WHERE COALESCE(topic, '') = ''").get().n;
  const products = db.prepare('SELECT COUNT(*) n FROM products WHERE active = 1').get().n;
  const seriesCount = db.prepare('SELECT COUNT(*) n FROM series').get().n;

  const blockers = [];
  if (!connected) blockers.push({ id: 'account', text: 'Ни один аккаунт не подключён — публиковать некуда', action: '#/accounts' });
  if (!products) blockers.push({ id: 'product', text: 'Нет активного продукта — трафику некуда идти', action: '#/products' });
  if (withoutTopic) blockers.push({ id: 'topic', text: `${withoutTopic} аккаунт(ов) без темы: контент будет «средним»`, action: '#/accounts' });
  if (!seriesCount) blockers.push({ id: 'series', text: 'Нет сериала: длинный формат даёт RPM в 2–3 раза выше Shorts', action: '#/series' });

  log({
    level: changes.length ? 'success' : 'info',
    actor: 'autopilot',
    action: 'autopilot.start',
    message: changes.length
      ? `Полный автопилот включён: ${changes.length} настроек, ${projects} проектов, ${series} сериалов`
      : 'Полный автопилот уже включён — менять нечего',
    meta: { changes, projects, series, blockers: blockers.map((b) => b.id) },
  });

  return {
    ok: true,
    changes,
    projects,
    series,
    blockers,
    settings: getSettings(),
  };
}

/** Выключить то, что включил startAutopilot: остановка публикаций без потери контента. */
export function stopAutopilot() {
  const before = getSettings();
  const patch = {};
  const changes = [];
  if (String(before.autopilot_global) !== '0') { patch.autopilot_global = '0'; changes.push('Автопилот платформы выключен'); }
  if (String(before.series_autopublish) !== '0') { patch.series_autopublish = '0'; changes.push('Автопубликация серий выключена'); }
  if (Object.keys(patch).length) setSettings(patch);
  log({
    level: 'warn', actor: 'autopilot', action: 'autopilot.stop',
    message: changes.length ? 'Автопилот остановлен вручную' : 'Автопилот уже был выключен',
    meta: { changes },
  });
  return { ok: true, changes, settings: getSettings() };
}

/**
 * Проверка публичного адреса: открывается ли панель снаружи и отдаётся ли медиа.
 * Именно на этот адрес Instagram тянет видео, поэтому проверяем не «домен задан»,
 * а реальный ответ по сети.
 */
export async function publicUrlCheck({ url = null, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const base = String(url || publicBaseOf(process.env) || '').trim().replace(/\/+$/, '');
  if (!base) {
    return {
      ok: false,
      url: '',
      reason: 'публичный адрес не задан и платформа его не сообщила',
      hint: 'На Railway/Render/Fly адрес подставляется сам (RAILWAY_PUBLIC_DOMAIN и аналоги). Локально: deploy/tunnel.sh — бесплатный https без домена.',
    };
  }
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, url: base, reason: 'адрес должен начинаться с http:// или https://', hint: 'Укажите полный URL, например https://pulse.example.com' };
  }

  const started = Date.now();
  let health = null;
  try {
    const res = await fetchImpl(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    health = { status: res.status, ok: res.ok };
    if (!res.ok) {
      return { ok: false, url: base, health, reason: `панель ответила ${res.status}`, hint: 'Проверьте, что туннель/прокси смотрит на этот же порт' };
    }
  } catch (err) {
    return {
      ok: false, url: base, health: null, ms: Date.now() - started,
      reason: `адрес не отвечает: ${String(err.message || err).slice(0, 120)}`,
      hint: 'Снаружи адрес недоступен: закройте фаервол, поднимите туннель или проверьте DNS.',
    };
  }

  // Медиа: берём любой готовый файл — площадки качают видео именно по /media/...
  let media = null;
  try {
    const files = fs.existsSync(MEDIA_DIR) ? fs.readdirSync(MEDIA_DIR).filter((f) => /\.(mp4|mp3|jpg|png)$/i.test(f)) : [];
    if (files.length) {
      const sample = files.sort((a, b) => fs.statSync(path.join(MEDIA_DIR, b)).mtimeMs - fs.statSync(path.join(MEDIA_DIR, a)).mtimeMs)[0];
      const res = await fetchImpl(`${base}/media/${encodeURIComponent(sample)}`, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
      media = { file: sample, status: res.status, ok: res.ok, type: res.headers?.get?.('content-type') || null };
    }
  } catch (err) {
    media = { ok: false, error: String(err.message || err).slice(0, 120) };
  }

  const ms = Date.now() - started;
  const problems = [];
  if (media && !media.ok) problems.push(`медиа отдаётся с кодом ${media.status}`);

  return {
    ok: !problems.length,
    url: base,
    health,
    media,
    ms,
    // панель снаружи видна — это главное; медиа проверяется, когда есть что проверять
    note: !media
      ? 'Панель открывается снаружи. Готовых файлов пока нет — медиа проверим после первой сборки ролика.'
      : null,
    reason: problems.length ? problems.join('; ') : null,
    hint: problems.length
      ? 'Instagram/TikTok не смогут забрать видео по этому адресу. Проверьте проксирование /media и публичный адрес.'
      : 'Адрес открывается снаружи — Reels и TikTok смогут забрать видео по ссылке.',
    checkedAt: nowIso(),
  };
}
