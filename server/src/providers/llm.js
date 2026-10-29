// ─────────────────────────────────────────────────────────────────────────────
// LLM Layer — «ИИ, где только можно»: один контракт, много провайдеров.
//
// Зачем свой слой, а не один SDK: бесплатные тарифы 2026 живут месяцами, а не
// годами, и у каждого свои лимиты. Платформа не должна зависеть от одного
// вендора, поэтому здесь:
//   • OpenAI-совместимый вызов для всех (NVIDIA NIM, Groq, Gemini, Cerebras,
//     OpenRouter, Mistral, OpenAI) — меняется только base_url и ключ;
//   • очередь-фолбэк: 429/5xx/таймаут → следующий провайдер, а не падение ролика;
//   • бюджет запросов на провайдера (RPM/RPD): бесплатные тарифы не любят
//     «долбим, пока не ответит»;
//   • кэш на диске по хэшу промпта: повторная генерация того же сценария не
//     тратит квоту (а она — главный дефицит бесплатных тарифов);
//   • JSON-режим с починкой ответа: модели любят оборачивать JSON в ```json.
//
// Порядок по умолчанию — «сначала бесплатное и лучшее для русского текста».
// Переопределяется: PULSE_LLM_ORDER="gemini,groq", PULSE_LLM_PROVIDER=groq.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../core/boot.js';
import { log } from '../core/logger.js';

const CACHE_DIR = path.join(DATA_DIR, 'ai-cache');

const PROVIDERS = [
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    base: 'https://integrate.api.nvidia.com/v1',
    keyEnv: 'NVIDIA_API_KEY',
    modelEnv: 'NVIDIA_MODEL',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    free: true,
    rpm: 40,
    docs: 'build.nvidia.com → Get API Key (nvapi-…)',
    note: '100+ открытых моделей, 40 запросов/мин, карта не нужна',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    altKeyEnv: 'GOOGLE_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-2.5-flash',
    free: true,
    rpm: 10,
    docs: 'aistudio.google.com/apikey',
    note: 'сильный русский, контекст до 1M — удобно для серии на 15 минут',
  },
  {
    id: 'groq',
    label: 'Groq',
    base: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    defaultModel: 'openai/gpt-oss-120b',
    free: true,
    rpm: 30,
    rpd: 1000,
    docs: 'console.groq.com/keys',
    note: 'самая быстрая выдача — хорошо для конвейера роликов',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    base: 'https://api.cerebras.ai/v1',
    keyEnv: 'CEREBRAS_API_KEY',
    modelEnv: 'CEREBRAS_MODEL',
    defaultModel: 'gpt-oss-120b',
    free: true,
    rpm: 5,
    docs: 'cloud.cerebras.ai',
    note: 'быстрая, но лимиты ниже',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free-модели)',
    base: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    defaultModel: 'deepseek/deepseek-chat-v3.1:free',
    free: true,
    rpm: 20,
    rpd: 50,
    docs: 'openrouter.ai/keys',
    note: '50 запросов в день: страховка, а не основной канал',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    base: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    modelEnv: 'MISTRAL_MODEL',
    defaultModel: 'mistral-small-latest',
    free: true,
    docs: 'console.mistral.ai',
    note: 'бесплатный эксперимент-план',
  },
  {
    id: 'github',
    label: 'GitHub Models',
    base: 'https://models.github.ai/inference',
    keyEnv: 'GITHUB_TOKEN',
    altKeyEnv: 'GITHUB_MODELS_TOKEN',
    modelEnv: 'GITHUB_MODEL',
    defaultModel: 'openai/gpt-4o-mini',
    free: true,
    rpm: 10,
    rpd: 150,
    docs: 'github.com/settings/tokens → fine-grained token, права models:read',
    note: 'бесплатно с обычным GitHub-токеном: ключ уже есть у любого разработчика',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    // OpenAI-совместимый эндпоинт живёт внутри аккаунта — собираем адрес на месте
    base: () => (process.env.CLOUDFLARE_ACCOUNT_ID
      ? `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`
      : 'https://api.cloudflare.com/client/v4/accounts//ai/v1'),
    keyEnv: 'CLOUDFLARE_AI_TOKEN',
    modelEnv: 'CLOUDFLARE_MODEL',
    defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    free: true,
    rpm: 30,
    rpd: 300,
    docs: 'dash.cloudflare.com → Workers AI (10 000 нейронов/день)',
    note: '10 000 нейронов в день бесплатно; тот же токен, что и для картинок',
  },
  {
    id: 'ollama',
    label: 'Ollama / свой сервер',
    base: 'http://127.0.0.1:11434/v1',
    keyEnv: null,
    modelEnv: 'OLLAMA_MODEL',
    defaultModel: 'qwen2.5:14b-instruct',
    free: true,
    enabledEnv: 'PULSE_OLLAMA',
    docs: 'ollama.com → ollama pull qwen2.5:14b-instruct',
    note: 'локально и бесплатно, без квот: нужен свой сервер с моделью',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    base: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o-mini',
    free: false,
    docs: 'platform.openai.com/api-keys',
    note: 'платно, но предсказуемо — последний в цепочке',
  },
];

const keyOf = (p) => {
  if (!p.keyEnv) return p.enabledEnv && String(process.env[p.enabledEnv] || '').toLowerCase() === 'on' ? 'local' : '';
  // Cloudflare без account id не сможет обратиться к модели — не притворяемся, что ключ рабочий
  if (p.id === 'cloudflare' && !process.env.CLOUDFLARE_ACCOUNT_ID) return '';
  return process.env[p.keyEnv] || (p.altKeyEnv ? process.env[p.altKeyEnv] : '') || '';
};

/**
 * Базовый URL провайдера. Переопределяется для самохостинга (vLLM, LM Studio,
 * Ollama) и корпоративных прокси: `<ID>_BASE_URL` или общий PULSE_LLM_BASE_URL
 * (общий применяется только к активному провайдеру, иначе ломался бы фолбэк).
 */
const baseOf = (p) => {
  const override = process.env[`${p.id.toUpperCase()}_BASE_URL`];
  if (override) return override;
  return typeof p.base === 'function' ? p.base() : p.base;
};
const modelOf = (p) => process.env[p.modelEnv] || p.defaultModel;

/**
 * Окно запросов на провайдера: держим RPM и дневной бюджет.
 *
 * Дневной счётчик переживает рестарт (`data/ai-cache/usage.json`). Без этого
 * контейнер, поднятый после падения, заново тратил бы бесплатную квоту — а у
 * OpenRouter/Groq дневной лимит маленький и восстанавливается только к утру.
 */
const USAGE_FILE = path.join(CACHE_DIR, 'usage.json');
const budget = new Map(); // id → { minuteStart, minuteCount, day, dayCount }

(() => {
  try {
    const saved = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    const day = new Date().toISOString().slice(0, 10);
    for (const [id, rec] of Object.entries(saved || {})) {
      if (rec?.day === day) budget.set(id, { minuteStart: Date.now(), minuteCount: 0, day, dayCount: Number(rec.dayCount) || 0 });
    }
  } catch { /* файла ещё нет — это нормально */ }
})();

let usageDirty = false;
function saveBudget() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const out = {};
    for (const [id, b] of budget) out[id] = { day: b.day, dayCount: b.dayCount };
    fs.writeFileSync(USAGE_FILE, JSON.stringify(out));
    usageDirty = false;
  } catch (err) {
    log({ level: 'warn', actor: 'provider.llm', action: 'usage.save_failed', message: String(err.message || err).slice(0, 160) });
  }
}

function takeBudget(p) {
  const now = Date.now();
  const day = new Date().toISOString().slice(0, 10);
  let b = budget.get(p.id);
  if (!b || b.day !== day) { b = { minuteStart: now, minuteCount: 0, day, dayCount: 0 }; budget.set(p.id, b); }
  if (now - b.minuteStart > 60000) { b.minuteStart = now; b.minuteCount = 0; }
  if (p.rpm && b.minuteCount >= p.rpm) return { ok: false, reason: `лимит ${p.rpm} запросов/мин` };
  if (p.rpd && b.dayCount >= p.rpd) return { ok: false, reason: `дневной лимит ${p.rpd} запросов` };
  b.minuteCount += 1;
  b.dayCount += 1;
  // запись на диск — не на каждый вызов: раз в 10 запросов достаточно и дешевле
  usageDirty = true;
  if (b.dayCount % 10 === 0 || b.dayCount === 1 || b.dayCount === p.rpd) saveBudget();
  return { ok: true };
}

/** Включено ли ИИ. В demo — только по явному PULSE_AI=on (чтобы тесты были офлайн). */
export function enabled() {
  if (String(process.env.PULSE_AI || '').toLowerCase() === 'off') return false;
  const anyKey = PROVIDERS.some((p) => keyOf(p));
  if (!anyKey) return false;
  if (process.env.PULSE_AI === 'on') return true;
  return (process.env.PULSE_MODE || 'demo') === 'live';
}

/** Цепочка провайдеров: явный выбор → порядок из env → порядок по умолчанию. */
export function chain() {
  const forced = String(process.env.PULSE_LLM_PROVIDER || '').trim();
  const order = String(process.env.PULSE_LLM_ORDER || '').split(',').map((s) => s.trim()).filter(Boolean);
  let list = PROVIDERS.filter((p) => keyOf(p));
  if (forced) list = [...list.filter((p) => p.id === forced), ...list.filter((p) => p.id !== forced)];
  const globalBase = String(process.env.PULSE_LLM_BASE_URL || '').trim();
  if (globalBase && list.length) list[0] = { ...list[0], base: globalBase };
  if (order.length) {
    const rank = (p) => (order.includes(p.id) ? order.indexOf(p.id) : order.length + PROVIDERS.findIndex((x) => x.id === p.id));
    list = [...list].sort((a, b) => rank(a) - rank(b));
  }
  return list;
}

export function current() {
  return chain()[0]?.id || null;
}

export function status() {
  return {
    enabled: enabled(),
    mode: (process.env.PULSE_MODE || 'demo') === 'live' ? 'live' : 'demo',
    active: current(),
    cached: cacheSize(),
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      model: modelOf(p),
      keyEnv: p.keyEnv,
      configured: Boolean(keyOf(p)),
      free: p.free,
      rpm: p.rpm || null,
      rpd: p.rpd || null,
      callsToday: budget.get(p.id)?.day === new Date().toISOString().slice(0, 10) ? budget.get(p.id).dayCount : 0,
      note: p.note,
      docs: p.docs,
      active: p.id === current(),
    })),
  };
}

// ── Кэш ─────────────────────────────────────────────────────────────────────
function cacheKey(payload) {
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function cacheSize() {
  try { return fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

function cacheGet(key, ttlMs) {
  try {
    const file = path.join(CACHE_DIR, `${key}.json`);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function cacheSet(key, value) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
  } catch { /* кэш не критичен */ }
}

// ── HTTP ────────────────────────────────────────────────────────────────────
async function chat(provider, { system, prompt, json, temperature, maxTokens, timeoutMs }) {
  const body = {
    model: modelOf(provider),
    messages: [
      { role: 'system', content: system || 'Ты продюсер и сценарист вирусного контента. Пиши по-русски, без markdown.' },
      { role: 'user', content: prompt },
    ],
    temperature: temperature ?? 0.85,
    max_tokens: maxTokens ?? 2000,
  };
  if (json) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 90000);
  try {
    const res = await fetch(`${baseOf(provider)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keyOf(provider)}`,
        // OpenRouter просит представиться; остальные игнорируют
        'HTTP-Referer': process.env.PULSE_PUBLIC_URL || 'https://github.com/ogSulem/pulse',
        'X-Title': 'Pulse Studio',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      const err = new Error(`${provider.label} ${res.status}: ${text}`);
      err.status = res.status;
      // 429 и 5xx — повод попробовать другого; 401/403 — ключ неверный
      err.fallback = res.status === 429 || res.status >= 500;
      throw err;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${provider.label}: пустой ответ модели`);
    return { text, model: body.model, usage: data.usage || null };
  } finally {
    clearTimeout(timer);
  }
}

/** Достаём JSON из ответа модели: ```json … ```, лишний текст вокруг, висячие запятые. */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const openChar = s[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        const chunk = s.slice(start, i + 1).replace(/,\s*([}\]])/g, '$1');
        try { return JSON.parse(chunk); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Один запрос к модели с фолбэком по цепочке провайдеров.
 * Никогда не бросает: возвращает { ok, text } или { ok: false, reason }.
 * Вызывающий код обязан иметь шаблонный ответ — контент не должен вставать.
 */
export async function complete({
  prompt, system = null, json = false, temperature = 0.85, maxTokens = 2000,
  timeoutMs = 90000, cacheTtlSec = 7 * 24 * 3600, cache = true, tag = 'llm',
} = {}) {
  if (!enabled()) return { ok: false, reason: 'ai_disabled' };
  if (!prompt) return { ok: false, reason: 'empty_prompt' };

  const key = cacheKey({ prompt, system, json, temperature, maxTokens, model: current() });
  if (cache && cacheTtlSec > 0) {
    const hit = cacheGet(key, cacheTtlSec * 1000);
    if (hit) return { ...hit, cached: true };
  }

  const errors = [];
  for (const provider of chain()) {
    const ok = takeBudget(provider);
    if (!ok.ok) { errors.push(`${provider.id}: ${ok.reason}`); continue; }
    try {
      const res = await chat(provider, { system, prompt, json, temperature, maxTokens, timeoutMs });
      const out = { ok: true, text: res.text, provider: provider.id, model: res.model, usage: res.usage };
      if (cache && cacheTtlSec > 0) cacheSet(key, out);
      log({
        level: 'info', actor: 'ai', action: `${tag}.generated`,
        message: `ИИ: ${provider.label} (${res.model}), ${String(res.text).length} знаков`,
        meta: { provider: provider.id, model: res.model, usage: res.usage },
      });
      return out;
    } catch (err) {
      errors.push(`${provider.id}: ${String(err.message || err).slice(0, 160)}`);
      log({
        level: 'warn', actor: 'ai', action: `${tag}.provider_failed`,
        message: `ИИ-провайдер ${provider.label} не ответил: ${String(err.message || err).slice(0, 200)}`,
        meta: { fallback: Boolean(err.fallback) },
      });
      // жёсткая ошибка ключа — этого провайдера больше не трогаем в этом запросе
      continue;
    }
  }
  return { ok: false, reason: errors.length ? errors.join(' | ') : 'no_provider' };
}

/** То же, но сразу объект. Если модель вернула мусор — один повтор с уточнением. */
export async function completeJson(options = {}) {
  const first = await complete({ ...options, json: true });
  if (!first.ok) return first;
  const parsed = extractJson(first.text);
  if (parsed) return { ...first, data: parsed };
  if (options.retryJsonFix === false) return { ...first, ok: false, reason: 'bad_json', data: null };
  const retry = await complete({
    ...options,
    cache: false,
    temperature: 0.2,
    prompt: `${options.prompt}\n\nВАЖНО: верни только валидный JSON без пояснений и без markdown.`,
  });
  const fixed = retry.ok ? extractJson(retry.text) : null;
  if (!fixed) return { ok: false, reason: 'bad_json', text: retry.text || first.text, data: null };
  return { ...retry, data: fixed };
}

/** Дешёвая проверка «ключ живой» для кнопки в настройках. */
export async function selfTest() {
  if (!enabled()) {
    const anyKey = PROVIDERS.some((p) => keyOf(p));
    return { ok: false, reason: anyKey ? 'ИИ выключен в demo: задайте PULSE_AI=on или PULSE_MODE=live' : 'нет ни одного ключа LLM (NVIDIA_API_KEY, GEMINI_API_KEY, GROQ_API_KEY…)' };
  }
  const started = Date.now();
  const res = await complete({
    prompt: 'Ответь одним словом: работает?',
    system: 'Отвечай одним словом по-русски.',
    maxTokens: 20,
    cache: false,
    tag: 'ai.selftest',
  });
  return res.ok
    ? { ok: true, provider: res.provider, model: res.model, ms: Date.now() - started, text: String(res.text).slice(0, 80) }
    : { ok: false, reason: res.reason };
}

export { PROVIDERS as LLM_PROVIDERS, CACHE_DIR as AI_CACHE_DIR };
