// ─────────────────────────────────────────────────────────────────────────────
// OAuth-подключение каналов вместо ручного копирования токенов.
//
// Владелец жмёт «Войти через YouTube» → уходит на страницу площадки → возвращается
// в панель уже подключённым. Что внутри:
//   • PKCE (S256) — обязателен для TikTok, безопасен и для остальных;
//   • state в памяти на 10 минут: колбэк без своего state не принимается,
//     иначе чужой код можно подсунуть в нашу сессию;
//   • обмен кода на токены + запрос профиля канала, чтобы сразу знать @handle
//     и external_id — без этого публикация потом падает «не указан id»;
//   • refresh_token: живёт в базе зашифрованным, а публикация сама обновляет
//     протухший доступ (иначе через час канал «отваливается»).
//
// Приложения создаются один раз в кабинетах площадок, ключи кладутся в env:
//   YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET
//   TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET
//   META_APP_ID / META_APP_SECRET (Instagram через Facebook Login)
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { db, nowIso } from '../core/db.js';
import { uid } from '../core/utils.js';
import { encryptSecret, decryptSecret } from '../core/secrets.js';
import { log } from '../core/logger.js';
import { publicBase as publicBaseOf } from '../core/publicurl.js';

const env = process.env;

export const OAUTH = {
  youtube: {
    label: 'YouTube',
    accountPlatform: 'youtube',
    clientId: () => env.YOUTUBE_CLIENT_ID || env.GOOGLE_CLIENT_ID || '',
    clientSecret: () => env.YOUTUBE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
    ],
    extraAuth: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    docs: 'https://console.cloud.google.com/apis/credentials → OAuth client (Web) → YouTube Data API v3',
    note: 'Без аудита проекта видео уходят приватными. Работает и для сериалов, и для Shorts.',
  },
  tiktok: {
    label: 'TikTok',
    accountPlatform: 'tiktok',
    clientId: () => env.TIKTOK_CLIENT_KEY || '',
    clientSecret: () => env.TIKTOK_CLIENT_SECRET || '',
    authorize: 'https://www.tiktok.com/v2/auth/authorize/',
    token: 'https://open.tiktokapis.com/v2/oauth/token/',
    scopes: ['user.info.basic', 'video.publish', 'video.upload'],
    extraAuth: {},
    authQueryKey: 'client_key',
    docs: 'https://developers.tiktok.com/apps → Content Posting API → Login Kit',
    note: 'Неаудированный клиент публикует только приватно (SELF_ONLY) и не больше 5 креаторов в сутки.',
  },
  reels: {
    label: 'Instagram',
    accountPlatform: 'reels',
    clientId: () => env.META_APP_ID || '',
    clientSecret: () => env.META_APP_SECRET || '',
    authorize: 'https://www.facebook.com/v21.0/dialog/oauth',
    token: 'https://graph.facebook.com/v21.0/oauth/access_token',
    scopes: ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'],
    extraAuth: {},
    docs: 'https://developers.facebook.com/apps → Instagram Graph API + Facebook Login',
    note: 'Нужен профессиональный (Business/Creator) аккаунт Instagram, привязанный к странице Facebook.',
  },
};

const pending = new Map(); // state → { platform, verifier, createdAt }

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const pkcePair = () => {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
};

export function publicBase() {
  // адрес берётся из core/publicurl.js: явная переменная или домен платформы
  return publicBaseOf(env);
}

export function redirectUri(platform, origin = null) {
  const base = publicBase() || String(origin || '').replace(/\/+$/, '');
  // без домена и origin абсолютный адрес не собрать: пусть UI подставит origin запроса
  if (!base) return null;
  return `${base}/api/oauth/${platform}/callback`;
}

export function oauthStatus() {
  return Object.entries(OAUTH).map(([id, cfg]) => ({
    id,
    label: cfg.label,
    configured: Boolean(cfg.clientId() && cfg.clientSecret()),
    redirectUri: redirectUri(id),
    scopes: cfg.scopes,
    docs: cfg.docs,
    note: cfg.note,
    missing: [
      cfg.clientId() ? null : id === 'tiktok' ? 'TIKTOK_CLIENT_KEY' : id === 'youtube' ? 'YOUTUBE_CLIENT_ID' : 'META_APP_ID',
      cfg.clientSecret() ? null : id === 'tiktok' ? 'TIKTOK_CLIENT_SECRET' : id === 'youtube' ? 'YOUTUBE_CLIENT_SECRET' : 'META_APP_SECRET',
    ].filter(Boolean),
  }));
}

/** Ссылка на страницу согласия. Без настроенного приложения — понятная ошибка. */
export function startFlow(platform, { origin = null, accountId = null } = {}) {
  const cfg = OAUTH[platform];
  if (!cfg) throw new Error(`Площадка ${platform} не поддерживает вход через OAuth`);
  const clientId = cfg.clientId();
  if (!clientId || !cfg.clientSecret()) {
    throw new Error(`Вход через ${cfg.label} не настроен: добавьте ${platform === 'tiktok' ? 'TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET' : platform === 'youtube' ? 'YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET' : 'META_APP_ID / META_APP_SECRET'} в переменные окружения`);
  }
  const { verifier, challenge } = pkcePair();
  const state = b64url(crypto.randomBytes(18));
  pending.set(state, { platform, verifier, accountId, createdAt: Date.now() });
  // старые state не держим: вход занимает секунды
  for (const [key, value] of pending) if (Date.now() - value.createdAt > 10 * 60 * 1000) pending.delete(key);

  const params = new URLSearchParams({
    response_type: 'code',
    [cfg.authQueryKey || 'client_id']: clientId,
    redirect_uri: redirectUri(platform, origin),
    scope: cfg.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...cfg.extraAuth,
  });
  return { url: `${cfg.authorize}?${params.toString()}`, state, platform, redirectUri: redirectUri(platform, origin) };
}

async function postForm(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const detail = data?.error_description || data?.error?.message || data?.message || text.slice(0, 240);
    throw new Error(`${res.status}: ${detail}`);
  }
  return data || {};
}

async function exchange(platform, { code, verifier, origin }) {
  const cfg = OAUTH[platform];
  const body = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(platform, origin),
    client_id: cfg.clientId(),
    client_secret: cfg.clientSecret(),
    code_verifier: verifier,
  };
  if (platform === 'tiktok') {
    body.client_key = cfg.clientId();
    delete body.client_id;
  }
  const data = await postForm(cfg.token, body);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: Number(data.expires_in || 0),
    refreshExpiresIn: Number(data.refresh_expires_in || 0),
    scope: data.scope || cfg.scopes.join(' '),
    raw: data,
  };
}

/** Профиль канала: @handle + external_id нужны публикации, а не «для красоты». */
/** Meta: короткоживущий токен меняем на долгоживущий (60 дней) — иначе вход «слетает». */
async function extendMeta({ token, clientId, clientSecret }) {
  const url = new URL('https://graph.facebook.com/v21.0/oauth/access_token');
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('client_secret', clientSecret);
  url.searchParams.set('fb_exchange_token', token);
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data.access_token ? { accessToken: data.access_token, expiresIn: Number(data.expires_in || 0) } : null;
}

async function profile(platform, token) {
  if (platform === 'youtube') {
    const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`YouTube профиль: ${res.status} ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const ch = data.items?.[0];
    if (!ch) throw new Error('YouTube: у аккаунта нет канала — создайте канал и повторите вход');
    return {
      handle: ch.snippet?.customUrl || ch.snippet?.title || ch.id,
      displayName: ch.snippet?.title || ch.id,
      externalId: ch.id,
      followers: Number(ch.statistics?.subscriberCount || 0),
      avatarUrl: ch.snippet?.thumbnails?.default?.url || null,
    };
  }
  if (platform === 'tiktok') {
    const res = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username,follower_count', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`TikTok профиль: ${res.status} ${(await res.text()).slice(0, 160)}`);
    const data = (await res.json())?.data?.user || {};
    return {
      handle: data.username || data.display_name || data.open_id,
      displayName: data.display_name || data.username || 'TikTok',
      externalId: data.open_id || data.union_id,
      followers: Number(data.follower_count || 0),
      avatarUrl: data.avatar_url || null,
    };
  }
  // Instagram: сначала страницы, потом привязанный ig business account
  const pages = await fetch(`https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,followers_count,profile_picture_url}&access_token=${encodeURIComponent(token)}`);
  if (!pages.ok) throw new Error(`Instagram профиль: ${pages.status} ${(await pages.text()).slice(0, 160)}`);
  const list = (await pages.json())?.data || [];
  const page = list.find((p) => p.instagram_business_account);
  const ig = page?.instagram_business_account;
  if (!ig) throw new Error('Instagram: не найден бизнес-аккаунт, привязанный к странице Facebook');
  return {
    handle: ig.username || ig.id,
    displayName: ig.username || page.name || 'Instagram',
    externalId: ig.id,
    pageId: page.id,
    // публикация Reels идёт от имени страницы: page token переживает user token
    pageToken: page.access_token || null,
    followers: Number(ig.followers_count || 0),
    avatarUrl: ig.profile_picture_url || null,
  };
}

/** Колбэк площадки: обмен кода, профиль канала, создание/обновление аккаунта. */
export async function finishFlow(platform, { code, state, origin = null }) {
  const cfg = OAUTH[platform];
  if (!cfg) throw new Error('Неизвестная площадка');
  const flow = pending.get(state);
  if (!flow || flow.platform !== platform) throw new Error('Сессия входа истекла — начните подключение заново');
  pending.delete(state);
  if (!code) throw new Error('Площадка не вернула код авторизации');

  const tokens = await exchange(platform, { code, verifier: flow.verifier, origin });
  if (!tokens.accessToken) throw new Error('Площадка не вернула access token');
  // Meta отдаёт токен на час-два: без обмена на долгоживущий канал «отвалится» через день
  if (platform === 'reels') {
    const long = await extendMeta({ token: tokens.accessToken, clientId: cfg.clientId(), clientSecret: cfg.clientSecret() }).catch(() => null);
    if (long) {
      tokens.accessToken = long.accessToken;
      tokens.expiresIn = long.expiresIn || 60 * 24 * 3600;
    }
  }
  const who = await profile(platform, tokens.accessToken);
  let expiresAt = tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : null;

  // Для Instagram сохраняем page token: публикация Reels идёт от имени страницы,
  // а user token до неё не дотягивается.
  const storedToken = who.pageToken || tokens.accessToken;
  if (who.pageToken) expiresAt = null;
  const encrypted = encryptSecret(storedToken);
  const refresh = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null;

  // Ищем аккаунт: сначала по external_id, потом по @handle, иначе создаём.
  let account = who.externalId
    ? db.prepare('SELECT * FROM accounts WHERE platform = ? AND external_id = ?').get(platform, who.externalId)
    : null;
  if (!account && who.handle) {
    account = db.prepare("SELECT * FROM accounts WHERE platform = ? AND (handle = ? OR lower(handle) = lower(?))")
      .get(platform, String(who.handle).replace(/^@/, ''), String(who.handle).replace(/^@/, ''));
  }
  if (flow.accountId) {
    account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(flow.accountId) || account;
  }

  const now = nowIso();
  if (account) {
    db.prepare(`UPDATE accounts SET handle = ?, display_name = ?, access_token = ?, refresh_token = ?,
        token_scope = ?, token_expires_at = ?, external_id = ?, followers = ?, followers_updated_at = ?,
        followers_source = 'api', status = 'healthy', auth_note = 'oauth', updated_at = ? WHERE id = ?`)
      .run(String(who.handle || account.handle).replace(/^@/, ''), who.displayName || account.display_name,
        encrypted, refresh, tokens.scope, expiresAt, who.externalId || account.external_id,
        who.followers || account.followers || 0, now, now, account.id);
  } else {
    account = { id: uid('ac_') };
    db.prepare(`INSERT INTO accounts (id, platform, handle, display_name, avatar_hue, status, daily_limit, min_gap_min,
        window_start, window_end, timezone, quality, notes, access_token, refresh_token, token_scope, token_expires_at,
        external_id, followers, followers_updated_at, followers_source, auth_note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'healthy', 3, 90, '09:00', '23:00', 'Europe/Moscow', 75, '', ?, ?, ?, ?, ?, ?, ?, 'api', 'oauth', ?, ?)`)
      .run(account.id, platform, String(who.handle || 'канал').replace(/^@/, ''), who.displayName || 'Канал',
        Math.floor(Math.random() * 360), encrypted, refresh, tokens.scope, expiresAt, who.externalId || null,
        who.followers || 0, now, now, now);
  }

  log({
    level: 'success', actor: 'oauth', action: 'account.oauth', entityType: 'account', entityId: account.id,
    message: `@${who.handle} подключён через ${cfg.label}${tokens.refreshToken ? ' (с автообновлением токена)' : ''}`,
    meta: { platform, externalId: who.externalId || null, scopes: tokens.scope },
  });
  return { accountId: account.id, platform, handle: who.handle, followers: who.followers || 0, refreshable: Boolean(tokens.refreshToken) };
}

/** Обновление протухшего токена перед публикацией. Возвращает новый access token либо исходный. */
export async function ensureFreshToken(account) {
  if (!account?.access_token) return null;
  const expires = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  // запас 3 минуты: загрузка видео идёт минутами, токен не должен истечь в процессе
  if (!expires || expires - Date.now() > 3 * 60 * 1000) return decryptSecret(account.access_token);
  if (!account.refresh_token) return decryptSecret(account.access_token);

  const platform = account.platform;
  const cfg = OAUTH[platform];
  if (!cfg) return decryptSecret(account.access_token);
  try {
    const raw = decryptSecret(account.refresh_token);
    const body = platform === 'tiktok'
      ? { grant_type: 'refresh_token', refresh_token: raw, client_key: cfg.clientId(), client_secret: cfg.clientSecret() }
      : platform === 'youtube'
        ? { grant_type: 'refresh_token', refresh_token: raw, client_id: cfg.clientId(), client_secret: cfg.clientSecret() }
        : { grant_type: 'fb_exchange_token', client_id: cfg.clientId(), client_secret: cfg.clientSecret(), fb_exchange_token: raw };
    const data = await postForm(cfg.token, body);
    if (!data.access_token) throw new Error('площадка не вернула новый токен');
    const expiresAt = data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : null;
    // TikTok и Google при обновлении могут выдать новый refresh_token — старый после
    // этого недействителен, поэтому сохраняем ротацию, а не только access token.
    if (data.refresh_token) {
      db.prepare('UPDATE accounts SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ? WHERE id = ?')
        .run(encryptSecret(data.access_token), encryptSecret(data.refresh_token), expiresAt, nowIso(), account.id);
    } else {
      db.prepare('UPDATE accounts SET access_token = ?, token_expires_at = ?, updated_at = ? WHERE id = ?')
        .run(encryptSecret(data.access_token), expiresAt, nowIso(), account.id);
    }
    log({ level: 'info', actor: 'oauth', action: 'account.refreshed', entityType: 'account', entityId: account.id, message: `Токен @${account.handle} обновлён автоматически` });
    return data.access_token;
  } catch (err) {
    log({
      level: 'warn', actor: 'oauth', action: 'account.refresh_failed', entityType: 'account', entityId: account.id,
      message: `Не удалось обновить токен @${account.handle}: ${String(err.message || err).slice(0, 200)}`,
    });
    return decryptSecret(account.access_token);
  }
}
