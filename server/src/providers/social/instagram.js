// ─────────────────────────────────────────────────────────────────────────────
// Instagram Reels — публикация через Graph API.
//
// Поток:
//   1. GET  /{ig-user-id}/content_publishing_limit   → сколько постов осталось
//   2. POST /{ig-user-id}/media  (media_type=REELS, video_url, caption, cover_url)
//   3. GET  /{creation-id}?fields=status_code        → ждём FINISHED
//   4. POST /{ig-user-id}/media_publish              → публикация
//
// Особенности, которые Pulse учитывает:
//   • окно лимита — скользящие 24 часа, лимит берём из API, а не «на глаз»;
//   • контейнер живёт 24 часа, дольше ждать нельзя;
//   • ошибка code 9 / subcode 2207042 (лимит) не ретраится — публикация переносится;
//   • видео должно быть доступно по публичному URL (PULSE_PUBLIC_URL).
// ─────────────────────────────────────────────────────────────────────────────
const GRAPH = 'https://graph.facebook.com/v21.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describeError(payload, status) {
  const err = payload?.error || {};
  const code = err.code;
  const subcode = err.error_subcode;
  const error = new Error(`Instagram: ${err.message || `HTTP ${status}`}`);
  error.code = code;
  error.subcode = subcode;
  // 9 / 2207042 — исчерпан лимит публикаций; 4 / 80003 — рейт-лимит приложения
  error.kind = (code === 9 && subcode === 2207042) ? 'limit' : code === 4 ? 'rate' : code === 190 ? 'auth' : 'api';
  error.retryable = error.kind === 'rate';
  return error;
}

async function graph(path, { token, method = 'GET', body, params = {} } = {}) {
  const url = new URL(`${GRAPH}${path}`);
  const search = body ? body : params;
  const isGet = method === 'GET';
  if (isGet) for (const [k, v] of Object.entries({ ...search, access_token: token })) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: isGet ? undefined : { 'Content-Type': 'application/json' },
    body: isGet ? undefined : JSON.stringify({ ...search, access_token: token }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.error) throw describeError(payload, res.status);
  return payload;
}

/** Сколько публикаций осталось в скользящем окне 24 ч. */
export async function publishingLimit({ token, igUserId }) {
  const data = await graph(`/${igUserId}/content_publishing_limit`, { token, params: { fields: 'quota_usage,config' } });
  const row = data?.data?.[0] || {};
  const total = Number(row?.config?.quota_total) || 50;
  const used = Number(row?.quota_usage) || 0;
  return { used, total, left: Math.max(0, total - used) };
}

/** Создаёт контейнер Reels и ждёт готовности видео. */
export async function createReel({ token, igUserId, videoUrl, caption = '', coverUrl = null, shareToFeed = true }) {
  const params = {
    media_type: 'REELS',
    video_url: videoUrl,
    caption: String(caption).slice(0, 2200),
    share_to_feed: shareToFeed ? 'true' : 'false',
  };
  if (coverUrl) params.cover_url = coverUrl;
  const created = await graph(`/${igUserId}/media`, { token, method: 'POST', params });
  const creationId = created?.id;
  if (!creationId) throw new Error('Instagram не вернул creation_id');

  const started = Date.now();
  let delay = 3000;
  while (Date.now() - started < 5 * 60 * 1000) {
    const status = await graph(`/${creationId}`, { token, params: { fields: 'status_code,status' } });
    if (status?.status_code === 'FINISHED') return { creationId };
    if (status?.status_code === 'ERROR') throw new Error(`Instagram: видео не обработано (${status.status || 'unknown'})`);
    await sleep(delay);
    delay = Math.min(delay * 1.3, 15000);
  }
  throw new Error('Instagram: контейнер не готов за 5 минут — публикация будет повторена');
}

export async function publishReel({ token, igUserId, creationId }) {
  const res = await graph(`/${igUserId}/media_publish`, { token, method: 'POST', params: { creation_id: creationId } });
  return { mediaId: res?.id };
}

/** Метрики опубликованного Reels. */
export async function mediaStats({ token, mediaId }) {
  const data = await graph(`/${mediaId}/insights`, {
    token,
    params: { metric: 'plays,likes,comments,shares,saved' },
  });
  const pick = (name) => Number(data?.data?.find((m) => m.name === name)?.values?.[0]?.value) || 0;
  return { views: pick('plays'), likes: pick('likes'), comments: pick('comments'), shares: pick('shares'), saves: pick('saved') };
}

export default { publishingLimit, createReel, publishReel, mediaStats };
