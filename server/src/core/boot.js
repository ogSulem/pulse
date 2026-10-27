// ─────────────────────────────────────────────────────────────────────────────
// Boot: то, что должно быть решено до первого запроса.
//
// На публичном хостинге (Railway, Render, Fly, Oracle) нельзя полагаться на
// значения по умолчанию из репозитория: секрет подписи сессий и пароль входа
// известны всем, кто видел код. Поэтому:
//   • PULSE_SECRET берётся из переменной окружения, иначе генерируется один раз
//     и сохраняется в data/.pulse-secret (0600) — рестарт не разлогинивает;
//   • на облачных платформах пароль по умолчанию не «pulse», а случайный,
//     он печатается в лог один раз и лежит в data/first-login.txt (0600);
//   • локально (без облачных переменных) остаётся «pulse», чтобы npm start
//     после клонирования работал без настройки;
//   • порт читается из PORT — Railway/Render/Fly передают именно его.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.PULSE_DATA_DIR || path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Платформы, где сервис заведомо доступен из интернета.
const HOSTED = Boolean(
  process.env.RAILWAY_ENVIRONMENT
  || process.env.RENDER
  || process.env.FLY_APP_NAME
  || process.env.KOYEB_APP_NAME
  || process.env.PULSE_PUBLIC_URL,
);

const SECRET_FILE = path.join(DATA_DIR, '.pulse-secret');
const PASSWORD_FILE = path.join(DATA_DIR, 'first-login.txt');

function writePrivate(file, value) {
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* файловая система без chmod */ }
}

function readPrivate(file) {
  try {
    return String(fs.readFileSync(file, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

// ── секрет подписи токенов ───────────────────────────────────────────────────
let secret = String(process.env.PULSE_SECRET || '').trim();
let secretCreated = false;
if (!secret) {
  const saved = readPrivate(SECRET_FILE);
  if (saved && saved.length >= 16) {
    secret = saved;
  } else {
    secret = crypto.randomBytes(32).toString('hex');
    writePrivate(SECRET_FILE, secret);
    secretCreated = true;
  }
}

// ── пароль входа в панель ────────────────────────────────────────────────────
let password = String(process.env.PULSE_PASSWORD || '').trim();
let passwordCreated = false;
let passwordDefault = false;
const savedPassword = password ? null : readPrivate(PASSWORD_FILE);
if (!password && savedPassword && savedPassword.length >= 8) {
  // Пароль уже выдавали при первом деплое: рестарт не должен его менять,
  // иначе после каждого перезапуска владелец остаётся без входа.
  password = savedPassword;
} else if (!password) {
  if (HOSTED) {
    // 4 блока по 4 символа без похожих букв: легко ввести руками с телефона
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    password = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('')).join('-');
    writePrivate(PASSWORD_FILE, password);
    passwordCreated = true;
  } else {
    password = 'pulse';
    passwordDefault = true;
  }
}

const port = Number(process.env.PORT || process.env.PULSE_PORT || 8080);
const mode = String(process.env.PULSE_MODE || 'demo') === 'live' ? 'live' : 'demo';

export const boot = {
  dataDir: DATA_DIR,
  hosted: HOSTED,
  port,
  mode,
  secretCreated,
  passwordCreated,
  passwordDefault,
  passwordFile: passwordCreated ? PASSWORD_FILE : null,
  secretFile: secretCreated ? SECRET_FILE : null,
};

export const appSecret = () => secret;
export const appPassword = () => password;

/**
 * Одна строка в лог при старте: всё, что нужно знать владельцу после деплоя.
 * Пароль печатается только когда он сгенерирован нами — заданный вручную
 * в логах не появляется.
 */
export function bootBanner() {
  const lines = [];
  lines.push(`  → http://0.0.0.0:${port}  (режим: ${mode}${HOSTED ? ', публичный хостинг' : ''})`);
  if (passwordCreated) {
    lines.push(`  → Пароль сгенерирован: ${password}  (сохранён в ${PASSWORD_FILE})`);
    lines.push('    Смените его: задайте PULSE_PASSWORD в переменных окружения.');
  } else if (passwordDefault) {
    lines.push('  → Пароль по умолчанию «pulse». Перед публикацией задайте PULSE_PASSWORD.');
  }
  if (secretCreated) {
    lines.push(`  → Секрет подписи сгенерирован и сохранён в ${SECRET_FILE} (данные не потеряются при рестарте)`);
  }
  return lines.join('\n');
}
