// ─────────────────────────────────────────────────────────────────────────────
// Публичный адрес панели — один источник правды.
//
// Зачем отдельный модуль. Публичный адрес нужен в пяти местах (OAuth redirect,
// публикация Reels/TikTok ссылкой, плейлист серий, проверка «открывается ли
// снаружи», подсказки в интерфейсе). Раньше каждое место читало
// `PULSE_PUBLIC_URL` само, и на облаке это давало тихую поломку: сервис уже
// доступен по адресу `xxx.up.railway.app`, но Instagram получал ошибку
// «задайте PULSE_PUBLIC_URL» — то есть человек должен был вручную продублировать
// адрес, который платформа и так знает.
//
// Теперь: явная переменная главнее всего, а если её нет — берём адрес, который
// выдала платформа хостинга. Кода нуль, а «просто задеплой» действительно
// работает без настройки.
//
// Отдельно про домены. Человек пишет адрес так, как его видит: `edu.каркастайги.рф`.
// Раньше это значение уходило в интерфейс как есть и панель ругалась «Адрес без
// HTTPS» — при том что человек просто не добавил `https://`. А если он вручную
// переводил домен в `xn--…`, ругательство оставалось: схема-то всё ещё не задана.
// Теперь любая форма записи приводится к одному виду: схема добавляется сама,
// кириллица переводится в punycode (именно его понимают Caddy, Let's Encrypt и
// API площадок), а исходное написание сохраняется для показа человеку.
// ─────────────────────────────────────────────────────────────────────────────

import { domainToASCII, domainToUnicode } from 'node:url';

const stripSlashes = (value) => String(value || '').trim().replace(/\/+$/, '');

// Разрешённые имена: обычный домен, localhost, IP. Всё остальное — ошибка с
// понятным текстом, а не тихий пропуск в конвейер.
// Лейбл домена: обычный или punycode (xn--…). Зона тоже бывает punycode —
// у .рф это как раз `xn--p1ai`, и раньше такая зона считалась «не доменом».
const LABEL = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?|xn--[a-z0-9]{2,59})';
const HOST_OK = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+${LABEL}$|^localhost$|^\\d{1,3}(?:\\.\\d{1,3}){3}$`);

/**
 * Приводит домен к рабочему виду. Никогда не бросает.
 *
 * Принимает: `edu.каркастайги.рф`, `xn--…`, `https://домен/путь`, `ДОМЕН:8443`,
 * `www.domain.com/some/path`. Возвращает разбор, а не строку, потому что
 * интерфейсу нужны обе формы: латиница для конфигов и кириллица для человека.
 *
 * @returns {{raw:string, ascii:string, unicode:string, url:string, scheme:string,
 *            host:string, port:string, path:string, error:string}}
 */
export function normalizeDomain(input) {
  const raw = String(input || '').trim();
  const empty = { raw, ascii: '', unicode: '', url: '', scheme: '', host: '', port: '', path: '', error: '' };
  if (!raw) return empty;

  // Схема: если человек написал http:// — уважаем (локальные стенды), иначе https.
  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : '';
  let rest = schemeMatch ? raw.slice(schemeMatch[0].length) : raw;
  // Логин в адресе (user@host) — не наш случай, но пусть не ломает разбор.
  rest = rest.replace(/^[^@/]*@/, '');

  let url;
  try {
    // URL сам делает IDN → punycode, разбирает порт и путь.
    url = new URL(`${scheme || 'https'}://${rest}`);
  } catch {
    return { ...empty, error: 'Не похоже на адрес: нужен домен вида edu.example.ru' };
  }

  const host = String(url.hostname || '').toLowerCase();
  const port = String(url.port || '');
  const finalScheme = scheme === 'http' ? 'http' : 'https';

  if (!host) return { ...empty, error: 'В адресе нет домена' };
  if (!HOST_OK.test(host)) {
    // Кириллица, которая не перевелась (например «домен.рф» без зоны) — сюда же
    return { ...empty, error: `«${host}» не домен: нужен адрес вида edu.example.ru или русскими буквами с зоной .рф/.com` };
  }

  const asciiHost = domainToASCII(host) || host;
  const unicodeHost = domainToUnicode(asciiHost) || asciiHost;
  const netloc = port ? `${asciiHost}:${port}` : asciiHost;
  return {
    raw,
    ascii: netloc,
    unicode: port ? `${unicodeHost}:${port}` : unicodeHost,
    url: `${finalScheme}://${netloc}`,
    scheme: finalScheme,
    host: asciiHost,
    port,
    path: url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '',
    error: '',
  };
}

/**
 * Адрес из переменной окружения/настроек, приведённый к рабочему виду.
 * Пусто — если не задан; `error` — если задан и не разобрался.
 */
export function configuredDomain(env = process.env) {
  // Явный PULSE_PUBLIC_URL уважаем в любом виде (человек мог поставить
  // http://localhost:8080 для проверки туннеля). А PULSE_DOMAIN=localhost —
  // это дефолт Caddyfile для локального стенда, а не публичный адрес.
  const explicit = stripSlashes(env.PULSE_PUBLIC_URL);
  if (explicit) return normalizeDomain(explicit);
  const raw = stripSlashes(env.PULSE_DOMAIN);
  if (!raw) return normalizeDomain('');
  const parsed = normalizeDomain(raw);
  if (parsed.host === 'localhost') return normalizeDomain('');
  return parsed;
}

/** Домен, который выдала платформа хостинга (без протокола), либо ''. */
export function hostedDomain(env = process.env) {
  // Railway: сервисный или пользовательский домен, вида pulse.up.railway.app
  if (env.RAILWAY_PUBLIC_DOMAIN) return stripSlashes(env.RAILWAY_PUBLIC_DOMAIN).replace(/^https?:\/\//i, '');
  // Render: полный URL окружения и отдельно хост
  if (env.RENDER_EXTERNAL_URL) return stripSlashes(env.RENDER_EXTERNAL_URL).replace(/^https?:\/\//i, '');
  if (env.RENDER_EXTERNAL_HOSTNAME) return stripSlashes(env.RENDER_EXTERNAL_HOSTNAME);
  // Fly: домен собирается из имени приложения
  if (env.FLY_APP_NAME) return `${stripSlashes(env.FLY_APP_NAME)}.fly.dev`;
  // Koyeb
  if (env.KOYEB_APP_NAME) return `${stripSlashes(env.KOYEB_APP_NAME)}.koyeb.app`;
  return '';
}

/** Откуда взят адрес: для честной подсказки в интерфейсе. */
export function publicSource(env = process.env) {
  if (stripSlashes(env.PULSE_PUBLIC_URL)) return 'PULSE_PUBLIC_URL';
  if (stripSlashes(env.PULSE_DOMAIN)) return 'PULSE_DOMAIN';
  if (env.RAILWAY_PUBLIC_DOMAIN) return 'RAILWAY_PUBLIC_DOMAIN';
  if (env.RENDER_EXTERNAL_URL || env.RENDER_EXTERNAL_HOSTNAME) return 'RENDER_EXTERNAL_URL';
  if (env.FLY_APP_NAME) return 'FLY_APP_NAME';
  if (env.KOYEB_APP_NAME) return 'KOYEB_APP_NAME';
  return '';
}

/** Публичный адрес с протоколом и без завершающего слэша. '' — если неизвестен. */
export function publicBase(env = process.env) {
  const own = configuredDomain(env);
  if (own.ascii) return own.url;
  const domain = hostedDomain(env);
  return domain ? (normalizeDomain(domain).url || '') : '';
}

/**
 * Пара «как в конфигах / как человеку». Нужна интерфейсу: в .env и Caddy идёт
 * латиница (xn--…), а в подписи — привычное написание.
 */
export function publicPair(env = process.env) {
  const own = configuredDomain(env);
  if (own.ascii) {
    return {
      source: publicSource(env),
      url: own.url,
      ascii: own.ascii,
      unicode: own.unicode,
      isUnicodeInput: /[^\x20-\x7E]/.test(own.raw.replace(/^https?:\/\//i, '')),
      error: '',
      note: own.error,
    };
  }
  const domain = hostedDomain(env);
  const auto = domain ? normalizeDomain(domain) : null;
  if (!auto || !auto.ascii) {
    return { source: publicSource(env), url: '', ascii: '', unicode: '', isUnicodeInput: false, error: own.error, note: own.error };
  }
  return { source: publicSource(env), url: auto.url, ascii: auto.ascii, unicode: auto.unicode, isUnicodeInput: false, error: '', note: '' };
}

/** Публичный адрес медиа: именно его забирает Instagram при публикации Reels. */
export function mediaBase(env = process.env) {
  const base = publicBase(env);
  return base ? `${base}/media` : '';
}

/** Запущено ли на облачном хостинге (там дефолтный пароль недопустим). */
const isLoopback = (value) => {
  const d = normalizeDomain(stripSlashes(value));
  return !d.host || d.host === 'localhost' || d.host.startsWith('127.');
};

export function isHosted(env = process.env) {
  return Boolean(
    env.RAILWAY_ENVIRONMENT
    || env.RAILWAY_PUBLIC_DOMAIN
    || env.RENDER
    || env.RENDER_EXTERNAL_URL
    || env.FLY_APP_NAME
    || env.KOYEB_APP_NAME
    || stripSlashes(env.PULSE_PUBLIC_URL)
    // свой домен — тоже признак публичного хостинга, но localhost им не является:
    // иначе локально панель сгенерирует случайный пароль и вход «сломается»
    || (stripSlashes(env.PULSE_DOMAIN) && !isLoopback(env.PULSE_DOMAIN)),
  );
}

/** Человеческое объяснение, откуда адрес — для панели и логов. */
export function publicHint(env = process.env) {
  const pair = publicPair(env);
  if (!pair.ascii) {
    return {
      url: '',
      source: pair.source,
      ascii: '',
      unicode: '',
      error: pair.error || '',
      note: pair.error
        ? `Публичный адрес задан, но не разобрался: ${pair.error}`
        : 'Публичный адрес не известен: задайте PULSE_PUBLIC_URL или запустите deploy/tunnel.sh — без него Instagram и TikTok не смогут забрать видео.',
    };
  }
  const auto = pair.source !== 'PULSE_PUBLIC_URL' && pair.source !== 'PULSE_DOMAIN';
  const unicodeNote = pair.unicode && pair.unicode !== pair.ascii
    ? ` Кириллица переведена в латиницу (${pair.ascii}) — именно её понимают Caddy, Let's Encrypt и API площадок.`
    : '';
  return {
    url: pair.url,
    source: pair.source,
    ascii: pair.ascii,
    unicode: pair.unicode,
    error: '',
    note: auto
      ? `Адрес взят автоматически из ${pair.source}: ${pair.url}. Переопределяется переменной PULSE_PUBLIC_URL.${unicodeNote}`
      : `Адрес задан вручную: ${pair.url}.${unicodeNote}`,
  };
}

/**
 * Адрес для redirect_uri OAuth — всегда латиницей и без мусора.
 * Площадки сравнивают его посимвольно: кириллический хост в Host-заголовке
 * (так бывает за нестандартным прокси) ломает вход в канал.
 */
export function originFromRequest(req, env = process.env) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const scheme = forwarded || req.protocol || 'http';
  const hostRaw = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  const host = normalizeDomain(hostRaw);
  if (host.ascii) return `${scheme === 'http' ? 'http' : 'https'}://${host.ascii}`;
  return publicBase(env) || `${scheme}://${hostRaw}`;
}
