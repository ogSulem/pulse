// ─────────────────────────────────────────────────────────────────────────────
// YouTube Shorts — публикация через Data API v3 (videos.insert).
//
// Особенности, которые Pulse соблюдает сам:
//   • отдельного «Shorts API» нет: вертикальное видео ≤ 3 минут YouTube сам
//     считает Shorts — поэтому кадр 1080×1920 и лимит длительности проверяются
//     в комплаенсе, а не «на глаз»;
//   • у videos.insert своя квота: 100 загрузок в сутки на проект (не 10 000 units);
//   • неаудированный проект Google может загружать только приватные видео —
//     поэтому privacy по умолчанию `private`, пока в настройках не включён аудит;
//   • resumable upload: чанки кратны 256 КБ, последний — остаток;
//   • лимиты метаданных: заголовок 100 символов, описание 5000 байт, теги 500.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';

const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const DATA = 'https://www.googleapis.com/youtube/v3';
const CHUNK = 8 * 1024 * 1024; // кратно 256 КБ

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const YOUTUBE_ERRORS = {
  quotaExceeded: { retry: false, kind: 'limit', message: 'YouTube: суточная квота API исчерпана — публикация перенесена на завтра' },
  uploadLimitExceeded: { retry: false, kind: 'limit', message: 'YouTube: исчерпан лимит загрузок (100/сутки на проект)' },
  rateLimitExceeded: { retry: true, kind: 'rate', message: 'YouTube: слишком много запросов — повтор позже' },
  invalidCredentials: { retry: false, kind: 'auth', message: 'YouTube: токен недействителен — переподключите аккаунт' },
  authError: { retry: false, kind: 'auth', message: 'YouTube: нужно заново авторизовать канал (OAuth)' },
  forbidden: { retry: false, kind: 'ban', message: 'YouTube: канал не может публиковать — проверьте ограничения' },
};

function describeError(payload, status) {
  const reason = payload?.error?.errors?.[0]?.reason || payload?.error?.status || 'unknown';
  const message = payload?.error?.message || '';
  const known = YOUTUBE_ERRORS[reason];
  const error = new Error(known?.message || `YouTube API: ${reason}${message ? ` — ${message}` : ''}`);
  error.kind = known?.kind || (status === 401 ? 'auth' : 'api');
  error.retryable = known?.retry ?? false;
  error.reason = reason;
  return error;
}

async function parse(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

/** Нормализует метаданные под жёсткие лимиты YouTube. */
export function normalizeMeta({ title, description, tags = [] }) {
  const cleanTitle = String(title || '')
    .replace(/\s+/g, ' ')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 100);
  let desc = String(description || '');
  // описание ограничено 5000 байт (в UTF-8 кириллица — 2 байта на символ)
  while (Buffer.byteLength(desc, 'utf8') > 5000) desc = desc.slice(0, -50);
  // теги: не больше 500 символов суммарно, каждый — без решётки
  const out = [];
  let used = 0;
  for (const tag of tags) {
    const t = String(tag || '').replace(/^#/, '').replace(/[,\s]+/g, '').slice(0, 30);
    if (!t) continue;
    if (used + t.length + 1 > 500) break;
    out.push(t);
    used += t.length + 1;
  }
  return { title: cleanTitle || 'Pulse', description: desc, tags: out };
}

/**
 * Загружает видео целиком через resumable-сессию.
 * Возвращает { videoId, privacy, url }.
 */
export async function uploadVideo({ token, filePath, title, description, tags = [], privacy = 'private', madeForKids = false, categoryId = '22', onProgress }) {
  if (!token) throw new Error('YouTube: нет токена доступа');
  if (!fs.existsSync(filePath)) throw new Error('YouTube: нет файла ролика для загрузки');
  const size = fs.statSync(filePath).size;
  if (!size) throw new Error('YouTube: файл ролика пустой');

  const meta = normalizeMeta({ title, description, tags });
  const initRes = await fetch(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(size),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify({
      snippet: { ...meta, categoryId },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: Boolean(madeForKids) },
    }),
  });
  if (!initRes.ok) throw describeError(await parse(initRes), initRes.status);
  const sessionUrl = initRes.headers.get('location');
  if (!sessionUrl) throw new Error('YouTube: не выдал upload-сессию');

  const fd = fs.openSync(filePath, 'r');
  try {
    let offset = 0;
    let result = null;
    while (offset < size) {
      const len = Math.min(CHUNK, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const res = await fetch(sessionUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(len),
          'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}`,
        },
        body: buf,
      });
      // 308 = «продолжай» (в том числе при обрыве связи)
      if (res.status === 308) {
        offset += len;
        onProgress?.(Math.min(1, offset / size));
        continue;
      }
      if (!res.ok) throw describeError(await parse(res), res.status);
      result = await parse(res);
      offset += len;
      onProgress?.(1);
    }
    const videoId = result?.id;
    if (!videoId) throw new Error('YouTube: загрузка завершилась без идентификатора видео');
    return { videoId, privacy, url: `https://www.youtube.com/shorts/${videoId}` };
  } finally {
    fs.closeSync(fd);
  }
}

/** Статистика по видео (1 unit за вызов, до 50 id). */
export async function videoStats({ token, videoIds = [] }) {
  const ids = videoIds.filter(Boolean).slice(0, 50);
  if (!token || !ids.length) return [];
  const url = new URL(`${DATA}/videos`);
  url.searchParams.set('part', 'statistics');
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('maxResults', '50');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw describeError(await parse(res), res.status);
  const data = await parse(res);
  return (data.items || []).map((item) => ({
    id: item.id,
    views: Number(item.statistics?.viewCount) || 0,
    likes: Number(item.statistics?.likeCount) || 0,
    comments: Number(item.statistics?.commentCount) || 0,
    shares: 0, // YouTube не отдаёт shares через Data API
  }));
}

/** Подписчики канала (нужны для портфеля и прогресса монетизации). */
export async function channelStats({ token }) {
  if (!token) return null;
  const url = new URL(`${DATA}/channels`);
  url.searchParams.set('part', 'statistics,snippet');
  url.searchParams.set('mine', 'true');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw describeError(await parse(res), res.status);
  const data = await parse(res);
  const item = data.items?.[0];
  if (!item) return null;
  return {
    id: item.id,
    title: item.snippet?.title || '',
    followers: Number(item.statistics?.subscriberCount) || 0,
    videos: Number(item.statistics?.videoCount) || 0,
    views: Number(item.statistics?.viewCount) || 0,
  };
}

/** Можно ли загружать публично: неаудированный проект — только private. */
export async function uploadAllowed({ token }) {
  if (!token) return { live: false, reason: 'нет токена' };
  try {
    const channel = await channelStats({ token });
    return { live: true, channel };
  } catch (err) {
    return { live: false, reason: err.message };
  }
}

export default { uploadVideo, videoStats, channelStats, normalizeMeta, uploadAllowed };
