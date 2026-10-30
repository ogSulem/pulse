import crypto from 'node:crypto';
import { appPassword, appSecret } from '../core/boot.js';
import { normalizeDomain } from '../core/publicurl.js';

// Секрет и пароль решает boot.js: на публичном хостинге это случайные значения,
// а не известные всем дефолты из репозитория.
const SECRET = appSecret();
const PASSWORD = appPassword();
const TTL_MS = 1000 * 60 * 60 * 24 * 14;

/**
 * Сессия живёт в двух местах сразу: в localStorage (заголовок Bearer) и в
 * HttpOnly-cookie. Это не избыточность, а ремонт реальной поломки.
 *
 * На телефоне localStorage бывает недоступен: приватный режим Safari, «Блокировать
 * все cookie», встроенные браузеры Telegram/Instagram. Тогда вход выглядел так:
 * пароль верный, экран мигает и снова форма — токен не сохранился, следующий
 * запрос уходит без него и получает 401. Со стороны — «с телефона не заходит».
 *
 * Cookie ставит сервер: она переживает перезагрузку и не зависит от JS-хранилища.
 * Bearer остаётся главным (обратная совместимость и API-клиенты), cookie — вторым.
 */
export const SESSION_COOKIE = 'pulse_session';
export const SESSION_MAX_AGE = Math.floor(TTL_MS / 1000);

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function issueToken() {
  const payload = b64url(JSON.stringify({ sub: 'owner', iat: Date.now(), exp: Date.now() + TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function checkPassword(password) {
  if (typeof password !== 'string') return false;
  const a = Buffer.from(password.padEnd(64).slice(0, 64));
  const b = Buffer.from(PASSWORD.padEnd(64).slice(0, 64));
  return crypto.timingSafeEqual(a, b) && password === PASSWORD;
}

/* ── Cookie ──────────────────────────────────────────────────────────────── */

/** Разбор Cookie-заголовка без зависимости cookie-parser (он тут не нужен). */
export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isSecureRequest = (req) => {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https' || Boolean(req.secure);
};

/**
 * Домен cookie. Если человек задал PULSE_COOKIE_DOMAIN кириллицей — переводим в
 * латиницу: браузер сравнивает домен побайтно и unicode-cookie просто выбросит
 * (после чего вход «не держится» и выглядит как поломка платформы).
 */
export function cookieDomain(env = process.env) {
  const raw = String(env.PULSE_COOKIE_DOMAIN || '').trim();
  if (!raw) return '';
  const d = normalizeDomain(raw);
  return d.host || '';
}

/** Cookie с токеном сессии. Одна функция — чтобы флаги не разъезжались. */
export function sessionCookie(req, token, { maxAge = SESSION_MAX_AGE, env = process.env } = {}) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  const domain = cookieDomain(env);
  if (domain) parts.push(`Domain=${domain}`);
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

/** Стирание cookie: Max-Age=0 и те же Path/Domain, иначе браузер её не найдёт. */
export function clearCookie(req, { env = process.env } = {}) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  const domain = cookieDomain(env);
  if (domain) parts.push(`Domain=${domain}`);
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

/** Токен из запроса: сначала заголовок, потом cookie, потом ?token= (для ссылок). */
export function tokenFromRequest(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE]) return cookies[SESSION_COOKIE];
  return req.query?.token;
}

export function authMiddleware(req, res, next) {
  const session = verifyToken(tokenFromRequest(req));
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Требуется вход в панель' });
  req.session = session;
  next();
}
