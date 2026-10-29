// ─────────────────────────────────────────────────────────────────────────────
// AI Content — единственное место, где промпты превращаются в контент.
//
// Принцип: ИИ никогда не «ломает» конвейер. Любая функция возвращает либо
// проверенный результат, либо null — тогда вызывающий код берёт шаблонный
// вариант (Content Brain). Поэтому ролик выходит даже при 429 у всех
// провайдеров, а с ключом — становится заметно живее.
//
// Что здесь есть:
//   • ideas()          — темы под нишу канала, с хуком и углом;
//   • shortPack()      — хук, сцены, описание и теги для короткого ролика;
//   • seriesNarration()— нарратив серии 8–20 минут по библии и арке сезона;
//   • seriesBible()    — мир, герои и правило мира для нового сериала.
//
// Все ответы проходят валидацию: длина, число сцен, кириллица, отсутствие
// обещаний дохода/лечения и «залипательных» призывов (за них снимают охват).
// ─────────────────────────────────────────────────────────────────────────────
import { complete, completeJson, enabled } from '../providers/llm.js';

const BANNED = [
  /гарантир\w*\s+(доход|прибыл|результат)/i,
  /заработ\w*\s+без\s+(вложений|риска)/i,
  /вылеч\w*/i,
  /100\s*%\s*(доход|прибыл|результат)/i,
  /подпис\w*ись\s+и\s+поставь\s+лайк/i,
];

const cyrillicShare = (text) => {
  const letters = String(text).match(/[A-Za-zА-Яа-яЁё]/g) || [];
  if (!letters.length) return 0;
  const cyr = letters.filter((c) => /[А-Яа-яЁё]/.test(c)).length;
  return cyr / letters.length;
};

const clean = (text, max = 400) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
const words = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

function looksRussian(text) {
  const value = String(text || '');
  return value.length > 12 && cyrillicShare(value) > 0.6;
}

function safeText(text, max = 400) {
  const value = clean(text, max);
  if (!value) return '';
  if (BANNED.some((re) => re.test(value))) return '';
  return value;
}

function personaLine(persona) {
  if (!persona) return '';
  if (typeof persona === 'string') return clean(persona, 200);
  const bits = [];
  if (persona.tone) bits.push(`тон: ${clean(persona.tone, 60)}`);
  if (persona.address) bits.push(`обращение: ${clean(persona.address, 40)}`);
  if (persona.avoid) bits.push(`избегать: ${clean(persona.avoid, 120)}`);
  if (persona.voice) bits.push(`голос: ${clean(persona.voice, 60)}`);
  return bits.join(', ');
}

const PLATFORM_HINT = {
  tiktok: 'TikTok: хук за 1.5 секунды, короткие фразы, без ссылок в тексте',
  reels: 'Reels: эмоция и ритм, титры читаются на ходу',
  youtube: 'YouTube Shorts: первые 3 слова = поисковый запрос, без кликбейта',
};

export function available() {
  return enabled();
}

/**
 * Идеи под нишу канала. Возвращает массив в форме, которую понимает
 * `ideas`-таблица: { title, hook, angle, format, tags[] }.
 */
export async function ideas({ project = {}, product = null, count = 6, topic = '', persona = null, exclude = [] } = {}) {
  if (!enabled()) return null;
  const niche = clean(topic || project.niche || project.name, 200);
  const formats = 'review, before-after, problem-solution, case, meme, listicle, pov, myth';
  const prompt = [
    `Придумай ${count} тем для коротких видео.`,
    `Канал: ${clean(project.name, 80)}. Ниша: ${niche}.`,
    project.description ? `Описание канала: ${clean(project.description, 300)}` : '',
    product ? `Продукт канала (упоминать только если тема про него): ${clean(product.name, 60)} — ${clean(product.pitch, 140)}` : '',
    personaLine(persona) ? `Персона канала — ${personaLine(persona)}` : '',
    exclude.length ? `Не повторяй темы: ${exclude.slice(0, 20).map((t) => clean(t, 80)).join('; ')}` : '',
    '',
    'Требования:',
    '- тема — конкретная ситуация или вопрос, а не «полезные советы»;',
    '- у каждой темы свой угол: личный опыт, разбор, ошибка, миф, сравнение;',
    '- никаких обещаний гарантированного дохода, лечения или «секретной схемы»;',
    '- не больше 9 слов в заголовке, хук — первая фраза ролика (до 12 слов);',
    `- format строго из списка: ${formats}.`,
    '',
    `Верни JSON: {"ideas":[{"title":"…","hook":"…","angle":"…","format":"…","tags":["…","…","…"]}]} — ровно ${count} идей.`,
  ].filter(Boolean).join('\n');

  const res = await completeJson({ prompt, maxTokens: 1600, temperature: 0.95, tag: 'ai.ideas' });
  if (!res.ok || !Array.isArray(res.data?.ideas)) return null;

  const out = res.data.ideas
    .map((row) => ({
      title: safeText(row.title, 100),
      hook: safeText(row.hook, 160),
      angle: safeText(row.angle, 180),
      format: ['review', 'before-after', 'problem-solution', 'case', 'meme', 'listicle', 'pov', 'myth'].includes(row.format) ? row.format : 'problem-solution',
      tags: (Array.isArray(row.tags) ? row.tags : []).map((t) => clean(t, 30).replace(/^#/, '')).filter(Boolean).slice(0, 6),
    }))
    .filter((row) => row.title && looksRussian(row.title) && words(row.title) <= 12);
  if (out.length < Math.min(3, count)) return null;
  return out.slice(0, count).map((row) => ({ ...row, hook: row.hook || row.title, source: 'ai' }));
}

/**
 * Пакет короткого ролика: хук, сцены, описание, теги.
 * Возвращает только тексты — тайминг, скоринг и правила площадок остаются
 * за движком (`creative.js`), чтобы ИИ не мог «сломать» комплаенс.
 */
export async function shortPack({
  project = {}, idea = {}, product = null, platform = 'reels',
  durationSec = 32, promo = 'none', topic = '', persona = null,
} = {}) {
  if (!enabled()) return null;
  const seconds = Math.max(16, Math.min(130, Number(durationSec) || 32));
  const sceneCount = Math.max(4, Math.min(7, Math.round(seconds / 6)));
  const totalWords = Math.round(seconds * 2.35);
  const prompt = [
    `Сценарий короткого ролика на ${seconds} секунд (${sceneCount} сцен, всего ~${totalWords} слов).`,
    `Площадка: ${PLATFORM_HINT[platform] || PLATFORM_HINT.reels}.`,
    `Канал: ${clean(topic || project.niche || project.name, 160)}.`,
    idea?.title ? `Тема: ${clean(idea.title, 140)}.` : '',
    idea?.angle ? `Угол подачи: ${clean(idea.angle, 160)}.` : '',
    project.description ? `О канале: ${clean(project.description, 240)}` : '',
    personaLine(persona) ? `Персона: ${personaLine(persona)}` : '',
    product && promo !== 'none'
      ? `Продукт: ${clean(product.name, 60)} — ${clean(product.pitch, 140)}. ${promo === 'direct' ? 'В конце — один прямой призыв (без навязчивости).' : 'Упомянуть мягко, один раз.'}`
      : 'Продукт не упоминать.',
    '',
    'Правила:',
    '- первая сцена — хук, который цепляет за 1.5 секунды и не повторяет заголовок;',
    '- каждая сцена — одна мысль, 10–20 слов, живая разговорная речь без канцелярита;',
    '- последняя сцена — вывод и естественный призыв (сохранить/посмотреть продолжение);',
    '- никаких гарантий дохода, лечения, «секретных схем», просьб ставить лайк;',
    '- не выдумывай цифры и факты, которых нет во входных данных;',
    '- теги — 6–8 штук, без решётки, строчными буквами.',
    '',
    'Верни JSON: {"title":"…","hook":"…","scenes":[{"text":"…","visual":"что в кадре"}],"caption":"…","hashtags":["…"]}',
  ].filter(Boolean).join('\n');

  const res = await completeJson({ prompt, maxTokens: 1400, temperature: 0.9, tag: 'ai.short' });
  if (!res.ok || !Array.isArray(res.data?.scenes)) return null;

  const scenes = res.data.scenes
    .map((s) => ({ text: safeText(s?.text, 260), visual: clean(s?.visual, 90) }))
    .filter((s) => s.text && looksRussian(s.text) && words(s.text) >= 4);
  if (scenes.length < 3) return null;

  const hook = safeText(res.data.hook, 160) || scenes[0].text;
  const caption = safeText(res.data.caption, 700);
  const hashtags = (Array.isArray(res.data.hashtags) ? res.data.hashtags : [])
    .map((t) => clean(t, 30).replace(/^#/, '').toLowerCase())
    .filter((t) => /^[a-zа-яё0-9_]{3,}$/i.test(t))
    .slice(0, 8);

  return {
    title: safeText(res.data.title, 100) || hook,
    hook,
    scenes,
    caption,
    hashtags,
    provider: res.provider,
    model: res.model,
    cached: Boolean(res.cached),
  };
}

/**
 * Нарратив серии длинного сериала. Модель пишет связный текст по абзацам —
 * по одному на сцену, чтобы тайминг и фото-ряд остались прежними.
 */
export async function seriesNarration({
  series = {}, bible = {}, planEntry = null, episodeNo = 1,
  paragraphs = 8, wordsPerParagraph = 60, siblings = [], persona = null,
} = {}) {
  if (!enabled()) return null;
  const bibleBrief = [
    `Мир: ${clean(bible.world?.place, 120)}. Правило мира: ${clean(bible.world?.rule, 200)}. Цена: ${clean(bible.world?.price, 160)}.`,
    bible.characters?.length
      ? `Герои: ${bible.characters.map((c) => `${clean(c.name, 40)} (${clean(c.role, 60)}; хочет ${clean(c.want, 80)}; боится ${clean(c.wound || c.fear, 80)})`).join('; ')}.`
      : '',
    bible.world?.secret ? `Секрет сезона (не раскрывать раньше времени): ${clean(bible.world.secret, 200)}` : '',
  ].filter(Boolean).join('\n');

  const header = [
    `Ты сценарист сериала «${clean(series.title, 80)}» (жанр: ${clean(series.genre, 40)}).`,
    bibleBrief,
    planEntry ? `Серия ${episodeNo}: «${clean(planEntry.title, 100)}». Логлайн: ${clean(planEntry.logline, 260)}. Поворот: ${clean(planEntry.twist || planEntry.cliffhanger, 200)}.` : `Серия ${episodeNo}.`,
    siblings.length ? `Не повторяй формулировки из прошлых серий: ${siblings.slice(0, 6).map((s) => clean(s, 90)).join(' | ')}` : '',
    personaLine(persona) ? `Голос рассказчика: ${personaLine(persona)}` : 'Голос рассказчика: спокойный, кинематографичный, от третьего лица.',
  ].filter(Boolean).join('\n');

  // Длинную серию одним запросом не написать: лимиты max_tokens и качество
  // падают к концу. Поэтому пишем «актами» по 6–8 абзацев, передавая модели
  // хвост предыдущего куска — так история остаётся связной.
  const BATCH = 8;
  const batches = Math.min(4, Math.ceil(paragraphs / BATCH));
  const perBatch = Math.ceil(paragraphs / batches);
  const all = [];
  let meta = { provider: null, model: null };
  let title = '';
  let thumb = '';
  let tags = [];
  let tail = '';

  for (let b = 0; b < batches; b += 1) {
    const prompt = [
      header,
      b > 0 ? `Уже написано (последние строки): «${clean(tail, 600)}». Продолжай ровно с этого места, не пересказывай.` : 'Это начало серии.',
      '',
      `Напиши ${perBatch} абзацев нарратива, по ~${wordsPerParagraph} слов каждый (это текст озвучки, не ремарки).`,
      'Требования:',
      '- каждый абзац — новый шаг истории: деталь обстановки, действие, реплика, поворот;',
      '- конкретные сенсорные детали (звук, свет, запах), без общих слов;',
      '- диалоги короткие, в кавычках-ёлочках;',
      b === batches - 1 ? '- в конце — обрыв на самом интересном месте, без спойлера следующей серии;' : '- не заканчивай историю, оставь напряжение;',
      '- без упоминаний, что это ИИ или сгенерированный текст;',
      '- никаких повторов одной и той же фразы между абзацами.',
      b === 0 ? '\nВерни JSON: {"title":"…","paragraphs":["…"],"thumb":"надпись для обложки (3–5 слов)","tags":["…"]}' : '\nВерни JSON: {"paragraphs":["…"]}',
    ].filter(Boolean).join('\n');

    const res = await completeJson({
      prompt,
      maxTokens: Math.min(6000, Math.round(perBatch * wordsPerParagraph * 3.2)),
      temperature: 0.95,
      cache: b === 0,
      tag: 'ai.series',
    });
    if (!res.ok || !Array.isArray(res.data?.paragraphs)) break;
    const chunk = res.data.paragraphs.map((p) => safeText(p, 1600)).filter((p) => p && words(p) >= 20);
    if (!chunk.length) break;
    all.push(...chunk);
    tail = chunk.slice(-2).join(' ').slice(-600);
    if (!meta.provider) meta = { provider: res.provider, model: res.model };
    if (b === 0) {
      title = safeText(res.data.title, 120);
      thumb = safeText(res.data.thumb, 60);
      tags = (Array.isArray(res.data.tags) ? res.data.tags : []).map((t) => clean(t, 30).replace(/^#/, '')).filter(Boolean).slice(0, 10);
    }
    if (all.length >= paragraphs) break;
  }

  // Модель может написать меньше абзацев — это нормально, если текста хватает
  // на 60% хронометража: остальное добьётся нарезкой предложений по сценам.
  if (all.length < Math.max(4, Math.floor(paragraphs * 0.6))) return null;
  return { title, paragraphs: all.slice(0, paragraphs + 4), thumb, tags, ...meta };
}

/** Мир сериала: место, правило, цена, три героя и секрет сезона. */
export async function seriesBible({ title = '', genre = 'zombie', premise = '', tone = 'cinematic' } = {}) {
  if (!enabled()) return null;
  const prompt = [
    `Придумай библию сериала «${clean(title, 80)}», жанр: ${clean(genre, 40)}, тон: ${clean(tone, 40)}.`,
    premise ? `Завязка: ${clean(premise, 400)}` : '',
    '',
    'Нужно:',
    '- место и время, одна деталь, которую видно в каждом кадре;',
    '- правило мира: что можно, что нельзя и что за это будет;',
    '- три героя: роль, профессия, желание, рана, тайна;',
    '- секрет сезона, который раскроется в финале;',
    '- визуальный стиль: палитра, свет, оптика.',
    'Без зомби-штампов «мозги и кровь», без шока ради шока. Ужас — через атмосферу и цену выбора.',
    '',
    'Верни JSON: {"world":{"place":"…","rule":"…","price":"…","secret":"…"},"characters":[{"name":"…","role":"…","job":"…","want":"…","fear":"…","secret":"…"}],"visual":{"palette":"ash|ink|ember|moss|rust|ice","look":"…"},"tagline":"…"}',
  ].filter(Boolean).join('\n');

  const res = await completeJson({ prompt, maxTokens: 1800, temperature: 0.95, tag: 'ai.bible' });
  if (!res.ok || !res.data?.world) return null;
  return res.data;
}
