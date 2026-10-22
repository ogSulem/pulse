// ─────────────────────────────────────────────────────────────────────────────
// TikTok Content Posting API — реальная публикация.
//
// Поток строго по документации:
//   1. POST /v2/post/publish/video/init/   → publish_id + upload_url
//   2. PUT  upload_url (Content-Range)     → файл уезжает в TikTok
//   3. POST /v2/post/publish/status/fetch/ → ждём PUBLISH_COMPLETE
//
// Важные ограничения, которые Pulse соблюдает сам:
//   • неаудированный клиент публикует только SELF_ONLY, аккаунт должен быть приватным;
//   • 6 init-запросов в минуту на токен;
//   • ошибки spam_risk_* не ретраятся — публикация откладывается, аккаунт остывает.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';

const BASE = 'https://open.tiktokapis.com/v2';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const TIKTOK_ERRORS = {
  spam_risk_too_many_posts: { retry: false, kind: 'limit', message: 'TikTok: слишком много постов за сутки — публикация отложена' },
  spam_risk_user_banned_from_posting: { retry: false, kind: 'ban', message: 'TikTok: аккаунту запрещена публикация — нужен ручной разбор' },
  reached_active_user_cap: { retry: false, kind: 'limit', message: 'TikTok: достигнут лимит активных креаторов (5 на неаудированный клиент)' },
  unaudited_client_can_only_post_to_private_accounts: { retry: false, kind: 'privacy', message: 'TikTok: клиент не аудирован — публикация возможна только в приватный аккаунт' },
  access_token_invalid: { retry: false, kind: 'auth', message: 'TikTok: токен недействителен — переподключите аккаунт' },
  rate_limit_exceeded: { retry: true, kind: 'rate', message: 'TikTok: превышен лимит запросов (6/мин) — повтор позже' },
};

function describeError(payload) {
  const code = payload?.error?.code || payload?.error?.code_str || 'unknown';
  const desc = payload?.error?.message || '';
  const known = TIKTOK_ERRORS[String(code)] || TIKTOK_ERRORS[String(payload?.error?.code_str)];
  const error = new Error(known?.message || `TikTok API: ${code}${desc ? ` — ${desc}` : ''}`);
  error.kind = known?.kind || 'api';
  error.retryable = known?.retry ?? false;
  error.code = code;
  return error;
}

async function api(path, { token, method = 'POST', body }) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!res.ok) {
    const err = describeError(payload);
    err.status = res.status;
    if (res.status === 429) { err.retryable = true; err.kind = 'rate'; }
    throw err;
  }
  // TikTok отвечает 200 даже на ошибки — проверяем error.code
  if (payload?.error && payload.error.code && payload.error.code !== 'ok') throw describeError(payload);
  return payload;
}

/**
 * Загружает файл одним куском (до 64 МБ, чего хватает для роликов Pulse)
 * и возвращает publish_id.
 */
export async function uploadVideo({ token, filePath, title, privacy = 'SELF_ONLY', coverTimestampMs = 0 }) {
  const size = fs.statSync(filePath).size;
  if (size > 64 * 1024 * 1024) throw new Error('Файл больше 64 МБ — разбейте загрузку на чанки');

  const init = await api('/post/publish/video/init/', {
    token,
    body: {
      post_info: {
        title: String(title || '').slice(0, 2200),
        privacy_level: privacy,
        disable_duplicate: false,
        video_cover_timestamp_ms: coverTimestampMs,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: size,
        total_chunk_count: 1,
      },
    },
  });

  const publishId = init?.data?.publish_id;
  const uploadUrl = init?.data?.upload_url;
  if (!publishId || !uploadUrl) throw new Error('TikTok не вернул publish_id/upload_url');

  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(size),
      'Content-Range': `bytes 0-${size - 1}/${size}`,
    },
    body: fs.readFileSync(filePath),
  });
  if (!upload.ok) {
    const details = await upload.text();
    throw new Error(`TikTok upload ${upload.status}: ${details.slice(0, 200)}`);
  }

  return { publishId };
}

/** Ждёт финального статуса публикации. */
export async function waitForPublish({ token, publishId, timeoutMs = 180000 }) {
  const started = Date.now();
  let delay = 2000;
  while (Date.now() - started < timeoutMs) {
    const status = await api('/post/publish/status/fetch/', { token, body: { publish_id: publishId } });
    const state = status?.data?.status;
    if (state === 'PUBLISH_COMPLETE') {
      return { status: state, postIds: status.data.publicaly_available_post_id || status.data.post_id || [] };
    }
    if (state === 'FAILED') {
      const reason = status?.data?.fail_reason || 'unknown';
      const err = new Error(TIKTOK_ERRORS[reason]?.message || `TikTok: публикация не удалась (${reason})`);
      err.retryable = Boolean(TIKTOK_ERRORS[reason]?.retry);
      throw err;
    }
    await sleep(delay);
    delay = Math.min(delay * 1.4, 10000);
  }
  throw new Error('TikTok: публикация не завершилась за 3 минуты — статус проверится позже');
}

/**
 * Комментарий под своим видео. Единственный кликабельный путь к продукту:
 * внешние ссылки в описании TikTok не работают. Права: video.comment.publish.
 */
export async function comment({ token, videoId, text }) {
  if (!videoId) throw new Error('TikTok: нет id видео для комментария');
  const payload = await api('/comment/publish/', {
    token,
    body: { video_id: String(videoId), text: String(text || '').slice(0, 150) },
  });
  return { commentId: payload?.data?.comment_id || null };
}

/** Счётчики опубликованного видео (для аналитики в live-режиме). */
export async function videoStats({ token, videoIds = [] }) {
  if (!videoIds.length) return [];
  const fields = 'id,title,create_time,view_count,like_count,comment_count,share_count';
  const res = await fetch(`${BASE}/video/query/?fields=${encodeURIComponent(fields)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: { video_ids: videoIds.slice(0, 20) } }),
  });
  if (!res.ok) throw new Error(`TikTok stats ${res.status}`);
  const payload = await res.json();
  if (payload?.error?.code && payload.error.code !== 'ok') throw describeError(payload);
  return (payload?.data?.videos || []).map((v) => ({
    id: String(v.id),
    views: Number(v.view_count) || 0,
    likes: Number(v.like_count) || 0,
    comments: Number(v.comment_count) || 0,
    shares: Number(v.share_count) || 0,
  }));
}

export default { uploadVideo, waitForPublish, videoStats, comment };
