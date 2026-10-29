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
// ─────────────────────────────────────────────────────────────────────────────

const stripSlashes = (value) => String(value || '').trim().replace(/\/+$/, '');

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
  if (env.RAILWAY_PUBLIC_DOMAIN) return 'RAILWAY_PUBLIC_DOMAIN';
  if (env.RENDER_EXTERNAL_URL || env.RENDER_EXTERNAL_HOSTNAME) return 'RENDER_EXTERNAL_URL';
  if (env.FLY_APP_NAME) return 'FLY_APP_NAME';
  if (env.KOYEB_APP_NAME) return 'KOYEB_APP_NAME';
  return '';
}

/** Публичный адрес с протоколом и без завершающего слэша. '' — если неизвестен. */
export function publicBase(env = process.env) {
  const explicit = stripSlashes(env.PULSE_PUBLIC_URL);
  if (explicit) return explicit;
  const domain = hostedDomain(env);
  return domain ? `https://${domain}` : '';
}

/** Публичный адрес медиа: именно его забирает Instagram при публикации Reels. */
export function mediaBase(env = process.env) {
  const base = publicBase(env);
  return base ? `${base}/media` : '';
}

/** Запущено ли на облачном хостинге (там дефолтный пароль недопустим). */
export function isHosted(env = process.env) {
  return Boolean(
    env.RAILWAY_ENVIRONMENT
    || env.RAILWAY_PUBLIC_DOMAIN
    || env.RENDER
    || env.RENDER_EXTERNAL_URL
    || env.FLY_APP_NAME
    || env.KOYEB_APP_NAME
    || stripSlashes(env.PULSE_PUBLIC_URL),
  );
}

/** Человеческое объяснение, откуда адрес — для панели и логов. */
export function publicHint(env = process.env) {
  const source = publicSource(env);
  const base = publicBase(env);
  if (!source) {
    return {
      url: '',
      source: '',
      note: 'Публичный адрес не известен: задайте PULSE_PUBLIC_URL или запустите deploy/tunnel.sh — без него Instagram и TikTok не смогут забрать видео.',
    };
  }
  const auto = source !== 'PULSE_PUBLIC_URL';
  return {
    url: base,
    source,
    note: auto
      ? `Адрес взят автоматически из ${source}: ${base}. Переопределяется переменной PULSE_PUBLIC_URL.`
      : `Адрес задан вручную через PULSE_PUBLIC_URL: ${base}.`,
  };
}
