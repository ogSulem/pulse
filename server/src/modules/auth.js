import crypto from 'node:crypto';

const SECRET = process.env.PULSE_SECRET || 'pulse-dev-secret-change-me';
const PASSWORD = process.env.PULSE_PASSWORD || 'pulse';
const TTL_MS = 1000 * 60 * 60 * 24 * 14;

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

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  const session = verifyToken(token);
  if (!session) return res.status(401).json({ error: 'unauthorized', message: 'Требуется вход в панель' });
  req.session = session;
  next();
}
