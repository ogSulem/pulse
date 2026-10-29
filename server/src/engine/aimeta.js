// ─────────────────────────────────────────────────────────────────────────────
// Паспорт ролика: кто именно его сделал.
//
// В платформе много ИИ (сценарий, озвучка, кадры, рендер), и раньше это было
// видно только в журнале: «озвучка провайдер demo», «видеоряд сгенерирован
// (pollinations)». В карточке ролика нельзя было ответить на простой вопрос —
// «а этот текст кто писал, модель или шаблон?».
//
// Теперь каждый шаг конвейера оставляет короткую запись: кто сделал, чем и за
// сколько. Хранится в episodes.ai_meta (JSON), отдаётся в API как `ai`.
// Список шагов фиксированный: так интерфейс не ломается, когда добавляется
// новый провайдер.
// ─────────────────────────────────────────────────────────────────────────────
import { db, nowIso } from '../core/db.js';
import { parseJson } from '../core/utils.js';

/** Шаги паспорта в том порядке, в котором они происходят. */
export const AI_STEPS = [
  { id: 'idea', label: 'Идея', actor: 'ИИ или библиотека тем' },
  { id: 'script', label: 'Сценарий', actor: 'языковая модель' },
  { id: 'voice', label: 'Озвучка', actor: 'синтез речи' },
  { id: 'footage', label: 'Видеоряд', actor: 'генерация видео/кадров' },
  { id: 'render', label: 'Монтаж', actor: 'ffmpeg' },
  { id: 'publish', label: 'Публикация', actor: 'API площадки' },
];

// Провайдеры хранятся техническими id (их удобно сравнивать в коде), а человеку
// показываем нормальное имя: «шаблон», «NVIDIA NIM», «демо-провайдер».
const PROVIDER_LABELS = {
  template: 'шаблон',
  studio: 'Pulse',
  'idea-library': 'библиотека тем',
  demo: 'демо',
  nvidia: 'NVIDIA NIM',
  openai: 'OpenAI',
  runway: 'Runway',
  luma: 'Luma',
  pika: 'Pika',
  replicate: 'Replicate',
  cloudflare: 'Cloudflare AI',
  pollinations: 'Pollinations',
  minimax: 'MiniMax',
  azure: 'Azure Speech',
  piper: 'Piper (локально)',
  edge: 'Edge TTS',
  ffmpeg: 'ffmpeg',
  'platform-api': 'API площадки',
  'instagram-api': 'Instagram API',
  'tiktok-api': 'TikTok API',
  'youtube-api': 'YouTube API',
};

/**
 * Дописывает шаг паспорта. Не бросает исключений: паспорт не должен ронять
 * конвейер, если запись не удалась.
 */
export function markAi(episodeId, step, data = {}) {
  try {
    const row = db.prepare('SELECT ai_meta FROM episodes WHERE id = ?').get(episodeId);
    if (!row) return null;
    const meta = parseJson(row.ai_meta, {});
    meta[step] = { ...(meta[step] || {}), ...data, at: nowIso() };
    db.prepare('UPDATE episodes SET ai_meta = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(meta), nowIso(), episodeId);
    return meta;
  } catch {
    return null;
  }
}

/** Паспорт ролика: только заполненные шаги, в порядке конвейера. */
export function aiPassport(meta) {
  const data = typeof meta === 'string' ? parseJson(meta, {}) : (meta || {});
  const steps = AI_STEPS
    .filter((s) => data[s.id])
    .map((s) => ({
      id: s.id,
      label: s.label,
      provider: data[s.id].provider || '',
      providerLabel: PROVIDER_LABELS[data[s.id].provider] || data[s.id].provider || '',
      model: data[s.id].model || '',
      note: data[s.id].note || '',
      ms: data[s.id].ms || null,
      at: data[s.id].at || null,
      demo: Boolean(data[s.id].demo),
    }));
  // Короткая строка для карточки в очереди: «llama-3.3-70b · edge» и т.п.
  const models = steps.filter((s) => s.model).map((s) => s.model);
  return {
    steps,
    // сколько шагов сделано машиной без шаблонов (для честной подписи)
    aiSteps: steps.filter((s) => s.provider && s.provider !== 'template').length,
    models,
    summary: models.slice(0, 2).join(' · ') || (steps.some((s) => s.provider === 'template') ? 'шаблон' : ''),
  };
}

/** Модель/провайдер сценария — самое частое, что спрашивают. */
export function scriptAuthor(meta) {
  const data = typeof meta === 'string' ? parseJson(meta, {}) : (meta || {});
  const s = data.script || {};
  if (!s.provider) return null;
  // `short` — для строки в очереди: там нет места под «meta/llama-3.3-70b-instruct»
  if (s.provider === 'template') return { label: 'шаблон Content Brain', short: 'шаблон', model: null, ai: false };
  const model = s.model || null;
  return { label: s.provider, model, short: model ? model.replace(/^[a-z0-9_-]+\//i, '') : s.provider, ai: true };
}
