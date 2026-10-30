// ─────────────────────────────────────────────────────────────────────────────
// «Готов ли я к публичному хостингу» — самопроверка развёртывания.
//
// Проблема, которую это решает. На Railway/Render/Fly контейнер живёт в
// эфемерной файловой системе: пока не подключён том, база и ролики исчезают при
// каждом рестарте, при этом панель выглядит здоровой и конвейер бодро публикует
// «в никуда». Аналогично молча ломаются: дефолтный пароль на публичном адресе,
// неизвестный публичный URL (Instagram не может забрать видео), отсутствующий
// ffmpeg (рендер падает на первом ролике), несколько реплик на одном SQLite.
//
// Здесь всё это собирается в один список с уровнями ok | warn | error и
// конкретным действием «что сделать». Модуль ничего не бросает и ничего не
// меняет — его можно звать из UI, из healthcheck и из CI.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from '../core/boot.js';
import { publicBase, publicHint, isHosted, publicSource, publicPair, normalizeDomain } from '../core/publicurl.js';
import { renderInfo, MEDIA_DIR } from './render.js';
import { notifyConfig } from './notify.js';
import { status as llmStatus } from '../providers/llm.js';
import { getSettings } from '../core/db.js';
import { storageUsage } from './housekeeping.js';

const env = process.env;

/** Платформа хостинга — по её переменным, без угадывания по домену. */
export function hostingPlatform(e = env) {
  if (e.RAILWAY_ENVIRONMENT || e.RAILWAY_PUBLIC_DOMAIN || e.RAILWAY_SERVICE_ID) return 'railway';
  if (e.RENDER || e.RENDER_EXTERNAL_URL) return 'render';
  if (e.FLY_APP_NAME) return 'fly';
  if (e.KOYEB_APP_NAME) return 'koyeb';
  return 'self-hosted';
}

function freeSpaceGb(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    return null;
  }
}

function canWrite(dir) {
  try {
    const probe = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

const check = (id, level, title, detail, fix = null) => ({ id, level, title, detail, fix });

/**
 * @returns {{
 *   platform: string, hosted: boolean, ok: boolean,
 *   counts: {ok:number, warn:number, error:number},
 *   blockers: Array<{id:string,title:string}>,
 *   publicUrl: string, publicSource: string, mediaUrl: string,
 *   dataDir: string, checks: Array<{id:string,level:'ok'|'warn'|'error',title:string,detail:string,fix:string|null}>
 * }}
 */
export function deployReadiness({ env: e = env } = {}) {
  const checks = [];
  const platform = hostingPlatform(e);
  const hosted = isHosted(e);
  const dataDir = DATA_DIR;
  // том Railway — отдельная переменная; PULSE_DATA_DIR из Dockerfile про том ничего не говорит
  const railwayVolume = String(e.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
  const localVolume = String(e.PULSE_DATA_DIR || '').trim();
  const dataInside = (mount) => path.resolve(dataDir).startsWith(path.resolve(mount));

  // ── 1. постоянный диск ────────────────────────────────────────────────────
  if (platform === 'railway' && !railwayVolume) {
    checks.push(check(
      'disk', 'error', 'Том не подключён',
      'Railway держит файловую систему эфемерной: без тома база и видео исчезнут при каждом рестарте, а конвейер продолжит «публиковать».',
      'railway volume add --mount-path /app/data  (в дашборде: Settings → Volumes → /app/data)',
    ));
  } else if (railwayVolume && !dataInside(railwayVolume)) {
    checks.push(check(
      'disk', 'warn', 'Данные вне тома',
      `Том примонтирован в ${railwayVolume}, а данные пишутся в ${dataDir} — после рестарта они пропадут.`,
      'Приведите PULSE_DATA_DIR к каталогу тома (на Railway это /app/data).',
    ));
  } else if (platform === 'render') {
    checks.push(check(
      'disk', 'warn', 'Проверьте диск Render',
      `Данные пишутся в ${dataDir}. На плане free диск не подключается — база обнулится при деплое.`,
      'Render → Disks → mount path /app/data (нужен платный план), либо Railway/Oracle Always Free.',
    ));
  } else if (!canWrite(dataDir)) {
    checks.push(check(
      'disk', 'error', 'Нет записи в каталог данных',
      `Каталог ${dataDir} недоступен для записи: база не создастся, конвейер не стартует.`,
      'Проверьте права тома: sudo chown -R 1000:1000 data (для docker compose).',
    ));
  } else {
    const free = freeSpaceGb(dataDir);
    if (free !== null && free < 1) {
      checks.push(check(
        'disk', 'warn', 'Мало места на диске',
        `Свободно ${free} ГБ. Один вертикальный ролик — 3–8 МБ, серия 8–15 минут — 60–150 МБ.`,
        'Увеличьте том (Railway: Settings → Volumes) или почистите data/media.',
      ));
    } else {
      const where = railwayVolume || localVolume || dataDir;
      checks.push(check(
        'disk', 'ok', 'Данные на постоянном диске',
        `${where}${railwayVolume ? ' (том Railway)' : ''}, свободно ${free ?? '—'} ГБ`,
      ));
    }
  }

  // ── 2. вход в панель ──────────────────────────────────────────────────────
  const password = String(e.PULSE_PASSWORD || '');
  if (!password) {
    checks.push(check(
      'auth', hosted ? 'error' : 'warn', 'Пароль не задан',
      hosted
        ? 'На публичном адресе Pulse сгенерирует случайный пароль и напечатает его в лог первого старта (data/first-login.txt). Это безопасно, но пароль лучше задать самому — лог видят все, у кого есть доступ к деплою.'
        : 'Локально работает пароль по умолчанию «pulse». Перед публикацией задайте свой.',
      'PULSE_PASSWORD=<длинный пароль> в переменных окружения (Railway → Variables).',
    ));
  } else if (password.length < 8 || password === 'pulse') {
    checks.push(check('auth', 'warn', 'Слабый пароль', 'Короткий пароль подбирается ботом за минуты.', 'Сделайте пароль 16+ символов: openssl rand -base64 24.'));
  } else {
    checks.push(check('auth', 'ok', 'Вход защищён паролем', `Пароль задан (${password.length} символов)`));
  }

  // ── 3. публичный адрес ────────────────────────────────────────────────────
  const hint = publicHint(e);
  const pair = publicPair(e);
  if (hint.error) {
    // Адрес задан, но не разобрался. Раньше это выглядело как «адрес без HTTPS»
    // и человек шёл переписывать домен в punycode руками — теперь говорим прямо,
    // что писать и в каком виде.
    checks.push(check(
      'public_url', 'error', 'Публичный адрес не разобрался',
      `${hint.error}. Кириллицу переводить вручную не нужно: панель делает это сама.`,
      'В PULSE_DOMAIN / PULSE_PUBLIC_URL пишите домен как в браузере: edu.каркастайги.рф — схему https:// и латиницу (xn--…) добавим сами.',
    ));
  } else if (!hint.url) {
    checks.push(check(
      'public_url', 'warn', 'Публичный адрес неизвестен',
      'YouTube публикует файлом и это переживёт, но Instagram и TikTok забирают видео по ссылке — без адреса они не работают.',
      'Railway/Render/Fly подставляют адрес сами; свой сервер — PULSE_DOMAIN=ваш.домен; локально — deploy/tunnel.sh (бесплатный https).',
    ));
  } else if (!/^https:\/\//i.test(hint.url)) {
    checks.push(check('public_url', 'warn', 'Адрес без HTTPS', `${hint.url} — площадки требуют https для скачивания видео.`, 'Включите HTTPS (Railway даёт его из коробки) или Caddy: docker compose --profile tls up -d.'));
  } else {
    checks.push(check('public_url', 'ok', 'Публичный адрес есть', hint.note));
  }

  // ── 3b. кириллический домен ───────────────────────────────────────────────
  // Отдельная проверка, потому что это самый частый случай «панель ругается, а
  // я всё сделал правильно»: домен верный, но в конфигах нужен punycode.
  if (pair.ascii && pair.unicode && pair.unicode !== pair.ascii) {
    checks.push(check(
      'domain_idn', 'ok', 'Домен с кириллицей',
      `В браузере — ${pair.unicode}, в конфигах — ${pair.ascii}. Обе формы рабочие, менять ничего не нужно.`,
    ));
  }
  // Cookie сессии: если домен задан явно, он должен быть латиницей — иначе браузер
  // молча выбросит cookie и вход будет «слетать» (главная причина «не заходит»).
  const cookieDomainRaw = String(e.PULSE_COOKIE_DOMAIN || '').trim();
  if (cookieDomainRaw) {
    const cd = normalizeDomain(cookieDomainRaw);
    checks.push(cd.ascii
      ? check('cookie_domain', 'ok', 'Cookie привязаны к домену', `PULSE_COOKIE_DOMAIN=${cd.ascii}${cd.unicode !== cd.ascii ? ` (${cd.unicode})` : ''}`)
      : check('cookie_domain', 'warn', 'Cookie-домен не разобрался', `PULSE_COOKIE_DOMAIN=${cookieDomainRaw}: ${cd.error}. Cookie уйдут на текущий хост — вход работать будет.`, 'Оставьте PULSE_COOKIE_DOMAIN пустым или укажите домен вида edu.example.ru.'));
  }

  // ── 4. режим работы ───────────────────────────────────────────────────────
  const mode = String(e.PULSE_MODE || 'demo');
  checks.push(mode === 'live'
    ? check('mode', 'ok', 'Режим live', 'Публикации уходят в реальные каналы, деньги считаются по фактическим событиям.')
    : check('mode', 'warn', 'Демо-режим', 'Публикации имитируются, выплат нет — так удобно смотреть панель, но денег это не принесёт.', 'PULSE_MODE=live, когда каналы подключены.'));

  // ── 5. рендер ─────────────────────────────────────────────────────────────
  const r = renderInfo();
  if (!r.available) {
    checks.push(check('render', 'error', 'Рендер недоступен', `ffmpeg=${r.ffmpeg}, sharp=${r.sharp}, шрифты=${r.fonts}. Ролики не соберутся.`, 'В образе ffmpeg ставится автоматически; на своём сервере — apt-get install ffmpeg.'));
  } else {
    checks.push(check('render', 'ok', 'Рендер готов', `${r.width}×${r.height} @ ${r.fps} fps, ffmpeg ${r.ffmpegSource || 'системный'}`));
  }
  if (!canWrite(MEDIA_DIR)) {
    checks.push(check('media', 'error', 'Нет записи в каталог медиа', `${MEDIA_DIR} недоступен: рендер упадёт на сохранении файла.`, 'Смонтируйте том на каталог данных целиком (/app/data).'));
  } else if (hint.url) {
    checks.push(check('media', 'ok', 'Медиа доступно по публичному адресу', `${hint.url}/media — именно этот адрес забирает Instagram`));
  }

  // ── 5b. сколько места осталось ────────────────────────────────────────────
  let storage = null;
  try {
    storage = storageUsage();
    const mb = (bytes) => `${Math.round((bytes || 0) / 1024 ** 2)} МБ`;
    if (storage.freeBytes !== null && storage.freeBytes < 500 * 1024 ** 2) {
      checks.push(check(
        'storage', 'error', 'Почти нет места',
        `Свободно ${mb(storage.freeBytes)}: следующий рендер упадёт с ENOSPC. Медиа занимает ${mb(storage.bytes)}.`,
        'POST /api/storage/prune — убрать файлы старше порога; на Railway увеличьте том (Settings → Volumes).',
      ));
    } else if (storage.staleFiles > 20) {
      checks.push(check(
        'storage', 'warn', 'Есть что убрать',
        `${storage.staleFiles} файлов старше ${storage.retentionDays} дн. на ${mb(storage.staleBytes)}.`,
        'POST /api/storage/prune (или «Почистить медиа» в студии) — уборка идёт и сама, раз в 6 часов.',
      ));
    } else {
      checks.push(check('storage', 'ok', 'Место под медиа', `${mb(storage.bytes)} занято, свободно ${mb(storage.freeBytes)}`));
    }
  } catch {
    checks.push(check('storage', 'warn', 'Не удалось посчитать место', `Каталог ${MEDIA_DIR} недоступен.`, null));
  }

  // ── 6. ИИ и уведомления ───────────────────────────────────────────────────
  let ai = { enabled: false, active: null, chain: [] };
  try { ai = llmStatus(); } catch { /* провайдеры могут быть не инициализированы */ }
  checks.push(ai.enabled
    ? check('ai', 'ok', 'ИИ включён', `Активная модель: ${ai.active}. Цепочка: ${(ai.chain || []).join(' → ') || '—'}`)
    : check('ai', 'warn', 'ИИ работает на встроенном движке', 'Без ключа сценарии пишет Content Brain: рабочие, но шаблонные. Один бесплатный ключ заметно поднимает качество.', 'NVIDIA_API_KEY (build.nvidia.com), GITHUB_TOKEN, GEMINI_API_KEY или GROQ_API_KEY + PULSE_AI=on.'));

  let tg = { configured: false, note: '' };
  try { tg = notifyConfig(); } catch { /* пусто */ }
  checks.push(tg.configured
    ? check('telegram', 'ok', 'Сводки приходят в Telegram', 'Раз в сутки после 10:00 по часовому поясу панели.')
    : check('telegram', 'warn', 'Нет канала уведомлений', 'Автопилот работает сутками — о поломках нужно узнавать не из тишины.', 'PULSE_TELEGRAM_BOT_TOKEN и PULSE_TELEGRAM_CHAT_ID (@BotFather, 2 минуты).'));

  // ── 7. окружение, в котором легко ошибиться ───────────────────────────────
  const replicas = Number(e.RAILWAY_REPLICA_COUNT || e.WEB_CONCURRENCY || 1) || 1;
  if (replicas > 1) {
    checks.push(check('replicas', 'warn', 'Несколько реплик на SQLite', `Реплик ${replicas}: два процесса на одной базе дают блокировки и дубли публикаций.`, 'Оставьте 1 реплику — вертикальный масштаб дешевле и безопаснее для SQLite.'));
  }
  try {
    const settings = getSettings();
    if (String(settings.autopilot_global ?? '0') === '1') {
      checks.push(check('autopilot', 'ok', 'Автопилот включён', 'Конвейер сам ставит ролики и публикует по расписанию.'));
    } else {
      checks.push(check('autopilot', 'warn', 'Автопилот выключен', 'Ничего не выходит само: платформа ждёт ручного запуска.', 'Студия → Включить полный автопилот.'));
    }
  } catch {
    checks.push(check('autopilot', 'warn', 'Настройки недоступны', 'Не удалось прочитать базу настроек — проверьте каталог данных.', null));
  }
  if (!e.PULSE_SECRET && !fs.existsSync(path.join(dataDir, '.pulse-secret'))) {
    checks.push(check('secret', 'warn', 'Секрет сессий не сохранён', 'При потере файла секрета все сессии сбрасываются (это лечится перезаходом).', 'PULSE_SECRET=<openssl rand -hex 32> и постоянный том.'));
  }

  const counts = checks.reduce((acc, c) => ({ ...acc, [c.level]: (acc[c.level] || 0) + 1 }), { ok: 0, warn: 0, error: 0 });
  const blockers = checks.filter((c) => c.level === 'error').map((c) => ({ id: c.id, title: c.title }));

  return {
    platform,
    hosted,
    ok: counts.error === 0,
    counts,
    blockers,
    publicUrl: publicBase(e),
    // то же самое, но привычными буквами — для подписи в интерфейсе
    publicUrlUnicode: pair.unicode || '',
    publicUrlAscii: pair.ascii || '',
    domainError: hint.error || '',
    publicSource: publicSource(e),
    mediaUrl: hint.url ? `${hint.url}/media` : '',
    dataDir,
    storage,
    env: {
      node: process.version,
      arch: process.arch,
      platformOs: os.type(),
      mode,
      replicas,
    },
    checks,
  };
}

/** Короткая строка для лога при старте — видно сразу, что не так на хостинге. */
export function readinessLine(result = deployReadiness()) {
  const { counts, blockers } = result;
  if (!counts.error && !counts.warn) return `Хостинг: всё в порядке (${counts.ok} проверок)`;
  const first = blockers[0];
  return `Хостинг: ok ${counts.ok}, предупреждений ${counts.warn}, ошибок ${counts.error}${first ? ` — ${first.title}` : ''}`;
}
