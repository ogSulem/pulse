// ─────────────────────────────────────────────────────────────────────────────
// Provider Layer — единственное место, где платформа знает про внешние API.
// Движки взаимозаменяемы: адаптер реализует контракт и регистрируется в реестре.
// demo-адаптеры работают без ключей, live-адаптеры вызывают реальные API.
// ─────────────────────────────────────────────────────────────────────────────
import { log } from '../core/logger.js';
import fs from 'node:fs';
import { decryptSecret } from '../core/secrets.js';
import tiktok from './social/tiktok.js';
import instagram from './social/instagram.js';
import youtube from './social/youtube.js';

const env = process.env;
const MODE = () => process.env.PULSE_MODE || 'demo';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── LLM (идеи/сценарии/описания) ────────────────────────────────────────────
const llm = {
  name: 'local-brain',
  async complete({ prompt, system }) {
    if (MODE() !== 'live' || !env.OPENAI_API_KEY) return null; // → fallback на Content Brain
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system || 'Ты продюсер коротких видео. Отвечай JSON без markdown.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.85,
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return JSON.parse(data.choices?.[0]?.message?.content || '{}');
  },
};

// ── Видео-генерация ─────────────────────────────────────────────────────────
// Контракт: submit(job) → { externalId }, poll(externalId) → { status, url, thumb }
// Адаптеры: NVIDIA(NIM/Cosmos), Runway, Luma, Pika, Replicate.
const video = {
  current() {
    return env.VIDEO_PROVIDER || 'nvidia';
  },
  providers() {
    return [
      { id: 'nvidia', label: 'NVIDIA NIM / Cosmos', keyEnv: 'NVIDIA_API_KEY', live: Boolean(env.NVIDIA_API_KEY) },
      { id: 'runway', label: 'Runway Gen-4', keyEnv: 'RUNWAY_API_KEY', live: Boolean(env.RUNWAY_API_KEY) },
      { id: 'luma', label: 'Luma Dream Machine', keyEnv: 'LUMA_API_KEY', live: Boolean(env.LUMA_API_KEY) },
      { id: 'pika', label: 'Pika', keyEnv: 'PIKA_API_KEY', live: Boolean(env.PIKA_API_KEY) },
      { id: 'replicate', label: 'Replicate (любая модель)', keyEnv: 'REPLICATE_API_TOKEN', live: Boolean(env.REPLICATE_API_TOKEN) },
    ];
  },
  async submit({ prompt, aspect = '9:16', seconds = 5, seed }) {
    const provider = this.current();
    if (MODE() !== 'live' || !this.providers().find((p) => p.id === provider)?.live) {
      await sleep(120);
      return { externalId: `demo_${seed}_${Date.now()}`, provider, demo: true };
    }
    if (provider === 'runway') {
      const res = await fetch('https://api.dev.runwayml.com/v1/text_to_video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.RUNWAY_API_KEY}`,
          'X-Runway-Version': '2024-11-06',
        },
        body: JSON.stringify({ model: 'gen4_turbo', promptText: prompt, ratio: aspect, duration: seconds }),
      });
      if (!res.ok) throw new Error(`Runway ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return { externalId: data.id, provider, demo: false };
    }
    if (provider === 'replicate') {
      const res = await fetch('https://api.replicate.com/v1/predictions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Token ${env.REPLICATE_API_TOKEN}` },
        body: JSON.stringify({ version: env.REPLICATE_VIDEO_VERSION, input: { prompt, aspect_ratio: aspect } }),
      });
      if (!res.ok) throw new Error(`Replicate ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return { externalId: data.id, provider, demo: false };
    }
    // NVIDIA NIM / Luma / Pika подключаются по тому же контракту:
    // POST endpoint → { id } → poll(GET /status/{id}).
    throw new Error(`Адаптер ${provider} не сконфигурирован: добавьте ключ и endpoint в providers/index.js`);
  },
};

// ── TTS ─────────────────────────────────────────────────────────────────────
const tts = {
  providers() {
    return [
      { id: 'elevenlabs', label: 'ElevenLabs Multilingual v2', keyEnv: 'ELEVENLABS_API_KEY', live: Boolean(env.ELEVENLABS_API_KEY) },
      { id: 'openai', label: 'OpenAI TTS', keyEnv: 'OPENAI_API_KEY', live: Boolean(env.OPENAI_API_KEY) },
      { id: 'system', label: 'Системный синтез (demo)', keyEnv: null, live: true },
    ];
  },
  async synthesize({ text, voiceId }) {
    const provider = env.TTS_PROVIDER || 'elevenlabs';
    if (MODE() !== 'live' || provider === 'system' || !env.ELEVENLABS_API_KEY) {
      await sleep(90);
      return { provider: 'demo', audioUrl: null, durationSec: Math.max(4, Math.round(text.split(/\s+/).length / 2.6)) };
    }
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId || env.ELEVENLABS_VOICE_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': env.ELEVENLABS_API_KEY },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
    });
    if (!res.ok) throw new Error(`TTS ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      provider,
      audioBytes: buf.length,
      audioBuffer: buf,                       // сохраняется в data/media/<episode>.mp3
      audioFormat: 'mp3',
      durationSec: Math.max(4, Math.round(text.split(/\s+/).length / 2.6)),
    };
  },
};

// ── Публикация ──────────────────────────────────────────────────────────────
// Meta Graph API (Reels) / TikTok Content Posting API.
const tokenOf = (account) => (account?.access_token ? decryptSecret(account.access_token) : null);

const publicUrl = () => String(env.PULSE_PUBLIC_URL || '').replace(/\/$/, '');

/**
 * Реальная публикация через официальные API площадок.
 * В demo-режиме возвращает предсказуемую заглушку, но контракт тот же:
 * { externalId, url, publishedAt, privacy }.
 */
const publish = {
  async send({ platform, account, description, title, hashtags = [], videoPath, coverPath, privacy, scheduledAt }) {
    const demo = MODE() !== 'live';
    const token = tokenOf(account);

    if (platform === 'tiktok') {
      if (demo || !token) {
        await sleep(180);
        return {
          externalId: `tt_demo_${Math.random().toString(36).slice(2, 10)}`,
          url: `https://www.tiktok.com/@${String(account?.handle || 'pulse').replace('@', '')}/video/${Math.floor(Math.random() * 9e17)}`,
          privacy: privacy || 'SELF_ONLY',
          demo: true,
        };
      }
      if (!videoPath || !fs.existsSync(videoPath)) throw new Error('TikTok: нет файла ролика для загрузки');
      const title = String(description).split('\n')[0].slice(0, 150) + ' ' + (String(description).match(/#[^\s#]+/g) || []).slice(0, 6).join(' ');
      const { publishId } = await tiktok.uploadVideo({
        token,
        filePath: videoPath,
        title: title.trim(),
        privacy: privacy || 'SELF_ONLY',
      });
      const done = await tiktok.waitForPublish({ token, publishId });
      const postId = Array.isArray(done.postIds) ? done.postIds[0] : done.postIds;
      return {
        externalId: postId ? String(postId) : publishId,
        publishId,
        url: postId ? `https://www.tiktok.com/@${String(account?.handle || '').replace('@', '')}/video/${postId}` : '',
        privacy: privacy || 'SELF_ONLY',
        demo: false,
      };
    }

    if (platform === 'youtube') {
      if (demo || !token) {
        await sleep(180);
        return {
          externalId: `yt_demo_${Math.random().toString(36).slice(2, 12)}`,
          url: `https://www.youtube.com/shorts/${Math.random().toString(36).slice(2, 12)}`,
          privacy: privacy || 'private',
          demo: true,
        };
      }
      if (!videoPath || !fs.existsSync(videoPath)) throw new Error('YouTube: нет файла ролика для загрузки');
      const firstLine = String(description || '').split('\n')[0].replace(/#\S+/g, '').trim();
      const { videoId, url, privacy: used } = await youtube.uploadVideo({
        token,
        filePath: videoPath,
        title: title || firstLine || 'Pulse',
        description,
        tags: hashtags,
        privacy: privacy || 'private',
      });
      return { externalId: videoId, url, privacy: used, demo: false };
    }

    // Instagram Reels
    if (demo || !token) {
      await sleep(180);
      return {
        externalId: `ig_demo_${Math.random().toString(36).slice(2, 10)}`,
        url: `https://www.instagram.com/reel/${Math.random().toString(36).slice(2, 12)}/`,
        demo: true,
      };
    }
    const igUserId = account?.external_id;
    if (!igUserId) throw new Error('Instagram: у аккаунта не указан IG user id');
    const base = publicUrl();
    if (!base) throw new Error('Instagram: задайте PULSE_PUBLIC_URL — площадка забирает видео по публичной ссылке');
    const fileName = String(videoPath).split('/').pop();
    const coverName = coverPath ? String(coverPath).split('/').pop() : null;

    const limit = await instagram.publishingLimit({ token, igUserId });
    if (limit.left <= 0) {
      const err = new Error(`Instagram: исчерпан лимит публикаций (${limit.used}/${limit.total} за 24 ч)`);
      err.kind = 'limit';
      throw err;
    }

    const { creationId } = await instagram.createReel({
      token,
      igUserId,
      videoUrl: `${base}/media/${fileName}`,
      coverUrl: coverName ? `${base}/media/${coverName}` : null,
      caption: description,
    });
    const { mediaId } = await instagram.publishReel({ token, igUserId, creationId });
    return {
      externalId: String(mediaId),
      creationId,
      url: `https://www.instagram.com/reel/${mediaId}/`,
      demo: false,
    };
  },
};

/**
 * Закреплённый комментарий — так продукт попадает к зрителю там, где ссылка
 * в описании не кликабельна (TikTok). В demo-режиме просто фиксируем факт.
 */
publish.comment = async ({ platform, account, externalId, text }) => {
  if (platform !== 'tiktok') return { skipped: true };
  const token = tokenOf(account);
  if (MODE() !== 'live' || !token) return { demo: true, commentId: `cm_demo_${Math.random().toString(36).slice(2, 8)}` };
  return tiktok.comment({ token, videoId: externalId, text });
};

/** Счётчики опубликованных роликов из API площадок (live-режим). */
const stats = {
  async fetch({ platform, account, externalIds = [] }) {
    const token = tokenOf(account);
    if (!token || !externalIds.length) return null;
    try {
      if (platform === 'tiktok') {
        const rows = await tiktok.videoStats({ token, videoIds: externalIds });
        return rows.length ? rows : null;
      }
      if (platform === 'reels') {
        const row = await instagram.mediaStats({ token, mediaId: externalIds[0] });
        return [{ id: externalIds[0], ...row }];
      }
      if (platform === 'youtube') {
        const rows = await youtube.videoStats({ token, videoIds: externalIds });
        return rows.length ? rows : null;
      }
    } catch (err) {
      log({ level: 'warn', actor: 'provider.stats', action: 'stats.failed', message: `${platform}: метрики не получены — ${err.message}` });
      return null;
    }
    return null;
  },
  async limit({ platform, account }) {
    const token = tokenOf(account);
    if (!token) return null;
    try {
      if (platform === 'reels' && account?.external_id) {
        return await instagram.publishingLimit({ token, igUserId: account.external_id });
      }
    } catch {
      return null;
    }
    return null;
  },
  /** Подписчики канала: нужны портфелю и прогрессу монетизации */
  async audience({ platform, account }) {
    const token = tokenOf(account);
    if (!token) return null;
    try {
      if (platform === 'youtube') return await youtube.channelStats({ token });
    } catch (err) {
      log({ level: 'warn', actor: 'provider.stats', action: 'audience.failed', message: `${platform}: подписчики не получены — ${err.message}` });
    }
    return null;
  },
};

export const providers = {
  llm,
  video,
  tts,
  publish,
  stats,
  status() {
    return {
      mode: MODE(),
      video: video.providers().map((p) => ({ ...p, active: p.id === video.current() })),
      tts: tts.providers().map((p) => ({ ...p, active: p.id === (env.TTS_PROVIDER || 'elevenlabs') })),
      llm: [{ id: 'openai', label: 'OpenAI', live: Boolean(env.OPENAI_API_KEY), active: Boolean(env.OPENAI_API_KEY) }],
      publish: [
        { id: 'meta', label: 'Meta Graph API (Reels)', live: Boolean(env.META_APP_ID), active: Boolean(env.META_APP_ID) },
        { id: 'tiktok', label: 'TikTok Content Posting API', live: Boolean(env.TIKTOK_CLIENT_KEY), active: Boolean(env.TIKTOK_CLIENT_KEY) },
        { id: 'youtube', label: 'YouTube Data API v3 (видео и серии)', live: Boolean(env.YOUTUBE_CLIENT_ID), active: Boolean(env.YOUTUBE_CLIENT_ID) },
      ],
    };
  },
};

export function providerError(message) {
  log({ level: 'error', actor: 'provider', action: 'provider.error', message });
}
