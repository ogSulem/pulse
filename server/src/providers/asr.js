// ─────────────────────────────────────────────────────────────────────────────
// Распознавание речи для нарезки.
//
// Зачем: «интересный кусок» — это почти всегда разговор (реплика, признание,
// шутка), а не смена плана. Субтитры есть далеко не у всех файлов, поэтому
// платформа умеет слышать сама: вырезает 20–45-секундное окно, отправляет его
// в Whisper и получает текст с таймингами.
//
// Провайдеры — только бесплатные и OpenAI-совместимые:
//   1. Groq (whisper-large-v3-turbo) — быстро, щедрый бесплатный лимит;
//   2. OpenAI (whisper-1) — если ключ уже есть.
// Нет ключа — нарезка продолжается без текста: моменты выбираются по сценам,
// тишине и репликам из субтитров. Честно и без «тихой» деградации: в интерфейсе
// видно, откуда взялся текст.
// ─────────────────────────────────────────────────────────────────────────────
import '../core/net.js';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../core/logger.js';

const PROVIDERS = [
  {
    id: 'groq',
    label: 'Groq Whisper',
    base: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    model: process.env.GROQ_ASR_MODEL || 'whisper-large-v3-turbo',
    note: 'бесплатно, ~8 часов аудио в сутки',
  },
  {
    id: 'openai',
    label: 'OpenAI Whisper',
    base: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    model: process.env.OPENAI_ASR_MODEL || 'whisper-1',
    note: 'платно, включается только если ключ уже есть',
  },
];

const keyOf = (p) => String(process.env[p.keyEnv] || '').trim();

export function asrChain() {
  return PROVIDERS.filter((p) => keyOf(p));
}

export function asrStatus() {
  const chain = asrChain();
  return {
    enabled: chain.length > 0,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      configured: Boolean(keyOf(p)),
      model: p.model,
      note: p.note,
    })),
  };
}

/**
 * Распознать короткий файл (mp3/m4a/wav до ~2 МБ).
 * Возвращает { ok, text } — текст без таймингов: окно и так 20–45 секунд,
 * а привязка к словам нужна только для субтитров, которых здесь нет.
 */
export async function transcribe(file, { language = 'ru', timeoutMs = 120000 } = {}) {
  const chain = asrChain();
  if (!chain.length) return { ok: false, reason: 'asr_disabled' };
  if (!file || !fs.existsSync(file)) return { ok: false, reason: 'file_missing' };
  const stat = fs.statSync(file);
  if (stat.size > 24 * 1024 * 1024) return { ok: false, reason: 'file_too_big' };

  const errors = [];
  for (const provider of chain) {
    try {
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), path.basename(file));
      form.append('model', provider.model);
      form.append('response_format', 'json');
      form.append('temperature', '0');
      if (language) form.append('language', language);

      const res = await fetch(`${provider.base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${keyOf(provider)}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status} ${String(data?.error?.message || data?.message || '').slice(0, 160)}`);
      const text = String(data.text || '').trim();
      if (!text) throw new Error('пустой ответ');
      log({
        level: 'info', actor: 'ai', action: 'asr.transcribed',
        message: `Речь распознана: ${provider.label}, ${text.length} знаков`,
        meta: { provider: provider.id, model: provider.model },
      });
      return { ok: true, text, provider: provider.id, model: provider.model };
    } catch (err) {
      errors.push(`${provider.id}: ${String(err.message || err).slice(0, 160)}`);
      log({
        level: 'warn', actor: 'ai', action: 'asr.provider_failed',
        message: `Распознавание не удалось (${provider.label}): ${String(err.message || err).slice(0, 200)}`,
      });
    }
  }
  return { ok: false, reason: errors.join(' | ') || 'asr_failed' };
}

export { PROVIDERS as ASR_PROVIDERS };
