// ─────────────────────────────────────────────────────────────────────────────
// Provider Layer — единственное место, где платформа знает про внешние API.
// Движки взаимозаменяемы: адаптер реализует контракт и регистрируется в реестре.
// demo-адаптеры работают без ключей, live-адаптеры вызывают реальные API.
// ─────────────────────────────────────────────────────────────────────────────
import { log } from '../core/logger.js';

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
    return { provider, audioBytes: buf.length, durationSec: Math.max(4, Math.round(text.split(/\s+/).length / 2.6)) };
  },
};

// ── Публикация ──────────────────────────────────────────────────────────────
// Meta Graph API (Reels) / TikTok Content Posting API.
const publish = {
  async send({ platform, account, description, videoRef, scheduledAt }) {
    if (MODE() !== 'live' || !account?.token) {
      await sleep(150);
      return {
        externalId: `${platform}_${Math.random().toString(36).slice(2, 10)}`,
        url: platform === 'tiktok'
          ? `https://www.tiktok.com/@${String(account?.handle || 'pulse').replace('@', '')}/video/${Math.floor(Math.random() * 9e17)}`
          : `https://www.instagram.com/reel/${Math.random().toString(36).slice(2, 12)}/`,
        demo: true,
      };
    }
    // В live-режиме: 1) upload media container, 2) poll status, 3) publish.
    // Токены аккаунтов хранятся в Vault/секретах и передаются только сюда.
    throw new Error('live-публикация требует настроенного Vault и OAuth-токена аккаунта');
  },
};

export const providers = {
  llm,
  video,
  tts,
  publish,
  status() {
    return {
      mode: MODE(),
      video: video.providers().map((p) => ({ ...p, active: p.id === video.current() })),
      tts: tts.providers().map((p) => ({ ...p, active: p.id === (env.TTS_PROVIDER || 'elevenlabs') })),
      llm: [{ id: 'openai', label: 'OpenAI', live: Boolean(env.OPENAI_API_KEY), active: Boolean(env.OPENAI_API_KEY) }],
      publish: [
        { id: 'meta', label: 'Meta Graph API (Reels)', live: Boolean(env.META_APP_ID), active: Boolean(env.META_APP_ID) },
        { id: 'tiktok', label: 'TikTok Content Posting API', live: Boolean(env.TIKTOK_CLIENT_KEY), active: Boolean(env.TIKTOK_CLIENT_KEY) },
      ],
    };
  },
};

export function providerError(message) {
  log({ level: 'error', actor: 'provider', action: 'provider.error', message });
}
