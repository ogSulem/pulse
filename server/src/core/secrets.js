// ─────────────────────────────────────────────────────────────────────────────
// Secrets — токены аккаунтов не лежат в базе открытым текстом.
//
// AES-256-GCM с ключом, производным от PULSE_SECRET. Формат строки:
//   enc:v1:<iv base64>:<tag base64>:<ciphertext base64>
// Если PULSE_SECRET не задан, шифрование недоступно — и мы честно об этом
// говорим, а не сохраняем токен как есть.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';

function key() {
  const secret = process.env.PULSE_SECRET || '';
  if (secret.length < 8) throw new Error('PULSE_SECRET не задан или слишком короткий — токены подключить нельзя');
  return crypto.createHash('sha256').update(`${secret}::pulse-tokens`).digest();
}

export function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(payload) {
  if (!payload) return null;
  if (!String(payload).startsWith(PREFIX)) return payload; // старые/ручные значения
  const [, , ivB64, tagB64, dataB64] = String(payload).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export const isEncrypted = (value) => String(value || '').startsWith(PREFIX);
export const maskSecret = (value) => (value ? `••••${String(value).slice(-4)}` : null);
