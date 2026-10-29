// ─────────────────────────────────────────────────────────────────────────────
// Image providers — «нейросетевой фото-ряд» для сериалов.
//
// Контракт простой: generate({ prompt, width, height, seed }) → буфер картинки.
// Всё остальное (кэш, троттлинг, откат на процедурный кадр) — в engine/frames.js.
//
// Провайдеры (по цене и доступности):
//   • pollinations — Flux без ключа и без регистрации. Анонимный тариф ~1 запрос
//     в 15 секунд, бесплатные модели не тарифицируются. Лучший старт: 0 ₽.
//   • cloudflare   — Workers AI (FLUX schnell) на бесплатном тарифе 10k Neurons/день,
//     нужны account id + token, зато стабильнее и без водяного знака.
//   • replicate    — FLUX schnell/dev по запросу, платно за картинку.
//   • openai       — gpt-image-1 / dall-e-3.
//   • stability    — SD 3.5 core.
// ─────────────────────────────────────────────────────────────────────────────
import { log } from '../core/logger.js';

const env = process.env;
const MODE = () => process.env.PULSE_MODE || 'demo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROVIDERS = [
  { id: 'pollinations', label: 'Pollinations · Flux (без ключа)', keyEnv: null, free: true, minGapSec: 15, model: 'flux' },
  { id: 'cloudflare', label: 'Cloudflare Workers AI · FLUX', keyEnv: 'CLOUDFLARE_AI_TOKEN', free: true, minGapSec: 1, model: 'flux-1-schnell' },
  { id: 'replicate', label: 'Replicate · FLUX schnell', keyEnv: 'REPLICATE_API_TOKEN', free: false, minGapSec: 1, model: 'flux-schnell' },
  { id: 'openai', label: 'OpenAI · gpt-image-1', keyEnv: 'OPENAI_API_KEY', free: false, minGapSec: 1, model: 'gpt-image-1' },
  { id: 'stability', label: 'Stability · SD 3.5', keyEnv: 'STABILITY_API_KEY', free: false, minGapSec: 1, model: 'sd3.5-core' },
];

const configured = (p) => Boolean(p.keyEnv ? env[p.keyEnv] : true);
const current = () => {
  const wanted = String(env.PULSE_IMAGE_PROVIDER || '').trim();
  if (wanted && PROVIDERS.some((p) => p.id === wanted)) return wanted;
  // по умолчанию: сначала бесплатный без ключа, затем платные с ключом
  const keyed = PROVIDERS.find((p) => p.keyEnv && configured(p));
  return keyed?.id || 'pollinations';
};

async function pollinations({ prompt, width, height, seed }) {
  const params = new URLSearchParams({
    width: String(width), height: String(height), seed: String(seed || 1),
    model: env.PULSE_IMAGE_MODEL || 'flux', nologo: 'true', enhance: 'true',
    referrer: 'pulsestudio',
  });
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
  const res = await fetch(url, { headers: { Accept: 'image/jpeg,image/png,image/*' } });
  if (!res.ok) throw new Error(`Pollinations ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const type = res.headers.get('content-type') || '';
  if (!/image\//.test(type)) throw new Error(`Pollinations вернул не картинку: ${type}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: type };
}

async function cloudflare({ prompt, width, height, seed }) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_AI_TOKEN;
  if (!account || !token) throw new Error('Cloudflare: нужны CLOUDFLARE_ACCOUNT_ID и CLOUDFLARE_AI_TOKEN');
  const model = env.PULSE_CF_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell';
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, width, height, seed: seed || 1, steps: 6 }),
  });
  if (!res.ok) throw new Error(`Cloudflare ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const type = res.headers.get('content-type') || '';
  if (/application\/json/.test(type)) {
    const data = await res.json();
    const b64 = data?.result?.image;
    if (!b64) throw new Error('Cloudflare: в ответе нет изображения');
    return { buffer: Buffer.from(b64, 'base64'), contentType: 'image/jpeg' };
  }
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: type || 'image/jpeg' };
}

async function replicate({ prompt, width, height, seed }) {
  const token = env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('Replicate: нужен REPLICATE_API_TOKEN');
  const create = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait=60' },
    body: JSON.stringify({
      input: {
        prompt,
        aspect_ratio: width > height ? '16:9' : '9:16',
        output_format: 'jpg',
        seed: seed || 1,
        num_outputs: 1,
      },
    }),
  });
  if (!create.ok) throw new Error(`Replicate ${create.status}: ${(await create.text()).slice(0, 160)}`);
  let data = await create.json();
  for (let i = 0; i < 40 && data.status && !['succeeded', 'failed', 'canceled'].includes(data.status); i += 1) {
    await sleep(2000);
    const poll = await fetch(`https://api.replicate.com/v1/predictions/${data.id}`, { headers: { Authorization: `Bearer ${token}` } });
    data = await poll.json();
  }
  if (data.status !== 'succeeded') throw new Error(`Replicate: ${data.status || 'нет статуса'} ${data.error || ''}`.slice(0, 200));
  const url = Array.isArray(data.output) ? data.output[0] : data.output;
  const img = await fetch(url);
  if (!img.ok) throw new Error(`Replicate: картинка недоступна (${img.status})`);
  return { buffer: Buffer.from(await img.arrayBuffer()), contentType: img.headers.get('content-type') || 'image/jpeg' };
}

async function openai({ prompt, width, height }) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error('OpenAI: нужен OPENAI_API_KEY');
  // gpt-image-1 поддерживает 1024×1024, 1536×1024, 1024×1536 — берём ближайший
  const size = width > height ? '1536x1024' : height > width ? '1024x1536' : '1024x1024';
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt, size, n: 1 }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI: в ответе нет изображения');
  return { buffer: Buffer.from(b64, 'base64'), contentType: 'image/png' };
}

async function stability({ prompt, width, height }) {
  const key = env.STABILITY_API_KEY;
  if (!key) throw new Error('Stability: нужен STABILITY_API_KEY');
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('aspect_ratio', width > height ? '16:9' : '9:16');
  form.append('output_format', 'jpeg');
  const res = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, Accept: 'image/*' },
    body: form,
  });
  if (!res.ok) throw new Error(`Stability ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'image/jpeg' };
}

const ADAPTERS = { pollinations, cloudflare, replicate, openai, stability };

/** Полный стиль кадра: модель не должна дорисовывать текст — его ставит рендер. */
export function stylizePrompt(prompt) {
  return [
    String(prompt || '').trim(),
    'cinematic film still, photorealistic, dramatic lighting, shallow depth of field, 35mm, grain',
    'no text, no watermark, no caption, no logo',
  ].filter(Boolean).join(', ');
}

export const image = {
  providers: () => PROVIDERS.map((p) => ({ ...p, configured: configured(p), active: p.id === current() })),
  current,
  provider: (id = null) => PROVIDERS.find((p) => p.id === (id || current())) || PROVIDERS[0],
  available() {
    const p = this.provider();
    return configured(p);
  },
  /** В demo картинки не запрашиваются, пока пользователь не включит кадры явно. */
  enabled() {
    if (!this.available()) return false;
    if (env.PULSE_IMAGES === 'off') return false;
    if (env.PULSE_IMAGES === 'on') return true;
    return MODE() === 'live';
  },
  minGapSec() {
    return Number(env.PULSE_IMAGE_MIN_GAP_SEC || this.provider().minGapSec || 1);
  },
  async generate({ prompt, width = 1280, height = 720, seed = 1, provider = null }) {
    const p = this.provider(provider);
    if (!configured(p)) throw new Error(`${p.label}: нет ключа (${p.keyEnv})`);
    const fn = ADAPTERS[p.id];
    if (!fn) throw new Error(`Провайдер изображений ${p.id} не реализован`);
    const started = Date.now();
    const out = await fn({ prompt: stylizePrompt(prompt), width, height, seed });
    if (!out.buffer?.length) throw new Error(`${p.label}: пустой ответ`);
    log({
      level: 'info', actor: `provider.image.${p.id}`, action: 'image.generated',
      message: `Кадр сгенерирован: ${p.label}, ${width}×${height}, ${Math.round((Date.now() - started) / 1000)} с`,
      meta: { provider: p.id, bytes: out.buffer.length, ms: Date.now() - started },
    });
    return { ...out, provider: p.id, demo: false, ms: Date.now() - started };
  },
  status() {
    return {
      enabled: this.enabled(),
      mode: MODE(),
      active: current(),
      minGapSec: this.minGapSec(),
      providers: this.providers(),
    };
  },
};
