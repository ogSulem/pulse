// ─────────────────────────────────────────────────────────────────────────────
// Себестоимость по факту провайдеров.
//
// Зачем отдельный модуль. В настройках лежат «средние по рынку» ставки: 45 ₽ за
// видеоряд, 12 ₽ за озвучку ролика, 20 ₽ за 1000 знаков серии. Но если озвучка
// идёт через Edge TTS, кадры — через Pollinations, LLM — по бесплатному ключу
// NVIDIA, реальная себестоимость ролика равна нулю. Считать по прайсу
// ElevenLabs в такой конфигурации — значит показывать владельцу убыток там, где
// его нет, и прятать прибыль. Поэтому ставки берутся из настроек, но обнуляются
// для тех провайдеров, которые в текущей конфигурации бесплатны.
//
// Ручная правда важнее автоматики: если владелец выставил `powered_by_me = 1`
// (например, платит за GPU-сервер), множители не трогаем.
// ─────────────────────────────────────────────────────────────────────────────
import { getSettings } from '../core/db.js';
import { num } from '../core/utils.js';
import * as llm from '../providers/llm.js';

const env = process.env;

/** Бесплатные провайдеры по умолчанию: Edge TTS, Pollinations, NVIDIA NIM. */
export function freeStack() {
  const ttsProvider = (env.TTS_PROVIDER || 'edge').toLowerCase();
  const imageProvider = (env.PULSE_IMAGE_PROVIDER || 'pollinations').toLowerCase();
  const videoProvider = (env.VIDEO_PROVIDER || 'nvidia').toLowerCase();

  let llmProvider = null;
  let llmFree = false;
  try {
    llmProvider = llm.current();
    const info = llm.status().providers.find((p) => p.id === llmProvider);
    // нет ни одного ключа → работает встроенный Content Brain: платить не за что
    llmFree = !llmProvider || Boolean(info?.free);
  } catch { /* пустой статус не ломает расчёт */ }

  return {
    tts: { provider: ttsProvider, free: ttsProvider === 'edge' },
    images: { provider: imageProvider, free: imageProvider === 'pollinations' },
    video: { provider: videoProvider, free: videoProvider === 'nvidia' || videoProvider === 'off' },
    llm: { provider: llmProvider, free: llmFree },
  };
}

/**
 * Ставки для расчёта денег. Всё в рублях: видео — за ролик, озвучка — за 1000
 * знаков, LLM — за ролик, рендер — за минуту готового видео.
 */
export function effectiveCosts() {
  const s = getSettings();
  const stack = freeStack();
  const manual = String(s.powered_by_me || '0') === '1';

  const video = manual || !stack.video.free ? num(s.cost_video, 45) : 0;
  const tts = manual || !stack.tts.free ? num(s.cost_tts, 12) : 0;
  const llmRub = manual || !stack.llm.free ? num(s.cost_llm, 8) : 0;
  const render = num(s.cost_render, 1);

  const ttsPer1000 = manual || !stack.tts.free ? num(s.cost_tts_1000, 20) : 0;
  const renderPerMin = num(s.cost_render_min, 6);

  const zeroed = [];
  if (!video) zeroed.push('видео');
  if (!tts) zeroed.push('озвучка');
  if (!llmRub) zeroed.push('тексты');
  if (!stack.images.free) zeroed.push('кадры платные');

  return {
    // короткий ролик
    video,
    tts,
    llm: llmRub,
    render,
    perVideo: Math.round((video + tts + llmRub + render) * 100) / 100,
    // длинная серия
    ttsPer1000,
    renderPerMin,
    llmPerEpisode: llmRub,
    stack,
    zeroed,
    note: zeroed.length
      ? `Бесплатно сейчас: ${zeroed.filter((z) => z !== 'кадры платные').join(', ') || 'ничего'}`
      : 'Все провайдеры платные — себестоимость по прайсу настроек',
  };
}
