import crypto from 'node:crypto';

export const uid = (prefix = '') =>
  prefix + crypto.randomBytes(8).toString('hex');

export const now = () => new Date().toISOString();

export const addMinutes = (iso, minutes) =>
  new Date(new Date(iso).getTime() + minutes * 60000).toISOString();

export const addDays = (iso, days) =>
  new Date(new Date(iso).getTime() + days * 86400000).toISOString();

export const parseJson = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const pick = (arr, rnd = Math.random) => arr[Math.floor(rnd() * arr.length)];

export const pickMany = (arr, count, rnd = Math.random) => {
  const copy = [...arr];
  const out = [];
  while (copy.length && out.length < count) {
    out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
  }
  return out;
};

// Детерминированный ПСЧ (mulberry32) — одинаковые сиды дают одинаковые обложки/метрики.
export function seededRandom(seedStr) {
  let h = 1779033703 ^ String(seedStr).length;
  for (let i = 0; i < String(seedStr).length; i++) {
    h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const slugify = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

export const fmtNum = (n) => {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'K';
  return String(Math.round(n));
};

export const nowIso = () => new Date().toISOString();
