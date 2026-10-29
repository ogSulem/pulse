// ─────────────────────────────────────────────────────────────────────────────
// Provider Layer — единственное место, где платформа знает про внешние API.
// Движки взаимозаменяемы: адаптер реализует контракт и регистрируется в реестре.
// demo-адаптеры работают без ключей, live-адаптеры вызывают реальные API.
// ─────────────────────────────────────────────────────────────────────────────
import { log } from '../core/logger.js';
import { publicBase as publicBaseOf } from '../core/publicurl.js';
import fs from 'node:fs';
import { decryptSecret } from '../core/secrets.js';
import tiktok from './social/tiktok.js';
import instagram from './social/instagram.js';
import youtube from './social/youtube.js';
import * as llmRouter from './llm.js';

const { status: llmStatus } = llmRouter;

const env = process.env;
const MODE = () => process.env.PULSE_MODE || 'demo';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── LLM (идеи/сценарии/описания) ────────────────────────────────────────────
// Единственная точка выхода в модели: мультироутер providers/llm.js.
// Он сам перебирает бесплатные провайдеры (NVIDIA NIM → Gemini → Groq → Cerebras
// → OpenRouter → Mistral → OpenAI → локальная Ollama), держит кэш и бюджет RPM.
// Контракт для движков прежний: complete() → объект или null (→ Content Brain).
const llm = {
  name: 'pulse-llm-router',
  enabled() {
    try { return llmStatus().enabled; } catch { return false; }
  },
  status() {
    try { return llmStatus(); } catch { return { enabled: false, providers: [] }; }
  },
  async complete({ prompt, system, temperature = 0.85, maxTokens = 1400, tag = 'engine' } = {}) {
    try {
      const res = await llmRouter.completeJson({ prompt, system, temperature, maxTokens, tag });
      return res?.ok ? res.data || null : null;
    } catch (err) {
      log({ level: 'warn', actor: 'provider.llm', action: 'llm.failed', message: `LLM недоступен: ${String(err.message || err).slice(0, 160)}` });
      return null;
    }
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
    // NVIDIA NIM: у Cosmos текст-в-видео синхронный (ответ = mp4 в base64),
    // у платформенных моделей — async с id. Поддерживаем оба вида ответа.
    if (provider === 'nvidia') {
      const base = env.NVIDIA_VIDEO_BASE_URL || 'https://ai.api.nvidia.com/v1';
      const model = env.NVIDIA_VIDEO_MODEL || 'nvidia/cosmos-1.0-diffusion-7b-text2world';
      const res = await fetch(`${base}/genai/${model}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.NVIDIA_API_KEY}` },
        body: JSON.stringify({
          prompt,
          aspect_ratio: aspect,
          duration: Math.max(2, Math.min(10, Number(seconds) || 5)),
          seed: Number(seed) || 0,
        }),
      });
      if (!res.ok) throw new Error(`NVIDIA video ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const type = String(res.headers.get('content-type') || '');
      if (type.includes('video/') || type.includes('application/octet-stream')) {
        // синхронный ответ: сразу кладём mp4 в кэш и отдаём «externalId» как file:путь
        const buf = Buffer.from(await res.arrayBuffer());
        const dir = env.PULSE_MEDIA_DIR || 'data/media';
        fs.mkdirSync(dir, { recursive: true });
        const file = `${dir}/nvidia-${String(seed || Date.now())}.mp4`;
        fs.writeFileSync(file, buf);
        return { externalId: `file:${file}`, provider, demo: false, url: null };
      }
      const data = await res.json();
      const b64 = data?.artifacts?.[0]?.base64 || data?.video?.base64 || data?.data?.[0]?.b64_json;
      if (b64) {
        const dir = env.PULSE_MEDIA_DIR || 'data/media';
        fs.mkdirSync(dir, { recursive: true });
        const file = `${dir}/nvidia-${String(seed || Date.now())}.mp4`;
        fs.writeFileSync(file, Buffer.from(b64, 'base64'));
        return { externalId: `file:${file}`, provider, demo: false, url: null };
      }
      const id = data?.id || data?.request_id || data?.job?.id;
      if (!id) throw new Error('NVIDIA video: в ответе нет ни файла, ни id задачи');
      return { externalId: String(id), provider, demo: false };
    }
    if (provider === 'luma') {
      const res = await fetch('https://api.lumalabs.ai/dream-machine/v1/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LUMA_API_KEY}` },
        body: JSON.stringify({ prompt, aspect_ratio: aspect, loop: false }),
      });
      if (!res.ok) throw new Error(`Luma ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return { externalId: data.id, provider, demo: false };
    }
    if (provider === 'pika') {
      // Pika живёт на fal.ai — единый контракт queue → status
      const res = await fetch('https://queue.fal.run/fal-ai/pika/v2/text-to-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Key ${env.PIKA_API_KEY}` },
        body: JSON.stringify({ prompt, aspect_ratio: aspect }),
      });
      if (!res.ok) throw new Error(`Pika ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return { externalId: data.request_id, provider, demo: false };
    }
    throw new Error(`Адаптер ${provider} не сконфигурирован: добавьте ключ и endpoint в providers/index.js`);
  },
};

// ── TTS ─────────────────────────────────────────────────────────────────────
// Порядок честный: сначала бесплатное и хорошее (Edge), затем платное.
// Edge TTS — нейронные голоса Microsoft без ключа: 15 минут серии стоят 0 ₽.
const ttsProviders = () => [
  { id: 'edge', label: 'Edge TTS (бесплатно, без ключа)', keyEnv: null, live: true, free: true },
  { id: 'elevenlabs', label: 'ElevenLabs Multilingual v2', keyEnv: 'ELEVENLABS_API_KEY', live: Boolean(env.ELEVENLABS_API_KEY), free: false },
  { id: 'openai', label: 'OpenAI TTS', keyEnv: 'OPENAI_API_KEY', live: Boolean(env.OPENAI_API_KEY), free: false },
  { id: 'system', label: 'Системный синтез (demo)', keyEnv: null, live: true, free: true },
];

const ttsCurrent = () => {
  const wanted = env.TTS_PROVIDER;
  if (wanted && ttsProviders().some((p) => p.id === wanted)) return wanted;
  // По умолчанию — бесплатный Edge, если только не выбрано другое явно
  return 'edge';
};

const tts = {
  current: ttsCurrent,
  providers: ttsProviders,
  async synthesize({ text, voiceId = null, rate = 0 } = {}) {
    const provider = ttsCurrent();
    const live = MODE() === 'live' || env.PULSE_TTS === 'on';
    const voice = voiceId || env.TTS_VOICE_ID || null;

    if (!live || provider === 'system' || String(env.PULSE_TTS).toLowerCase() === 'off') {
      await sleep(90);
      return { provider: 'demo', audioUrl: null, audioFormat: 'mp3', durationSec: Math.max(4, Math.round(String(text).split(/\s+/).length / 2.6)) };
    }

    if (provider === 'edge') {
      const edge = await import('./tts/edge.js');
      const out = await edge.synthesize({ text, voiceId: voice, rate });
      return { ...out, audioUrl: null };
    }

    if (provider === 'elevenlabs') {
      if (!env.ELEVENLABS_API_KEY) throw new Error('ElevenLabs: нужен ELEVENLABS_API_KEY');
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice || env.ELEVENLABS_VOICE_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': env.ELEVENLABS_API_KEY },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
      });
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        provider, audioBytes: buf.length, audioBuffer: buf, audioFormat: 'mp3',
        durationSec: Math.max(4, Math.round(String(text).length / 15)),
      };
    }

    // OpenAI TTS: дешевле ElevenLabs и с приличным русским (gpt-4o-mini-tts)
    if (!env.OPENAI_API_KEY) throw new Error('OpenAI TTS: нужен OPENAI_API_KEY');
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
        voice: env.OPENAI_TTS_VOICE || 'alloy',
        input: String(text).slice(0, 4000),
        response_format: 'mp3',
      }),
    });
    if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      provider: 'openai', audioBytes: buf.length, audioBuffer: buf, audioFormat: 'mp3',
      durationSec: Math.max(3, Math.round(String(text).length / 15)),
    };
  },
};

// ── Публикация ──────────────────────────────────────────────────────────────
// Meta Graph API (Reels) / TikTok Content Posting API.
// Готовый к публикации токен. Публикация получает уже обновлённый (см. oauth.ensureFreshToken),
// поэтому здесь достаточно расшифровать то, что пришло.
const tokenOf = (account) => (account?.access_token ? decryptSecret(account.access_token) : null);

const publicUrl = () => publicBaseOf(env);

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
    if (!base) throw new Error('Instagram: нужен публичный адрес — площадка забирает видео по ссылке. На Railway он подставляется сам, локально запустите deploy/tunnel.sh');
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
      tts: tts.providers().map((p) => ({ ...p, active: p.id === tts.current() })),
      llm: (() => {
        try {
          const st = llmStatus();
          return st.providers.filter((p) => p.configured || p.free).map((p) => ({
            id: p.id, label: p.label, model: p.model, live: p.configured, active: p.active,
          }));
        } catch {
          return [{ id: 'openai', label: 'OpenAI', live: Boolean(env.OPENAI_API_KEY), active: Boolean(env.OPENAI_API_KEY) }];
        }
      })(),
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
