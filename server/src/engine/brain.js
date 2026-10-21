// ─────────────────────────────────────────────────────────────────────────────
// Content Brain — генерация идей, сценариев, описаний и хештегов.
// В demo-режиме работает локально (без внешних ключей), в live-режиме
// подменяется LLM-адаптером (см. providers/llm.js) с той же сигнатурой.
// ─────────────────────────────────────────────────────────────────────────────
import { pick, pickMany, seededRandom } from '../core/utils.js';

const FORMATS = ['review', 'before-after', 'problem-solution', 'case', 'meme', 'listicle', 'pov', 'myth'];

export const FORMAT_LABELS = {
  review: 'Обзор',
  'before-after': 'До / после',
  'problem-solution': 'Проблема → решение',
  case: 'Кейс',
  meme: 'Мем / новость',
  listicle: 'Подборка',
  pov: 'POV',
  myth: 'Разрушаем миф',
};

// Библиотека ниш: темы, боли, визуальные приёмы, хештеги.
const NICHES = [
  {
    key: 'ai-saas',
    match: ['saas', 'нейросет', 'искусственн', 'контент', 'автоматизац', 'digital', 'pulse', 'smm', 'монетизац'],
    topics: [
      'как я собираю 30 роликов за вечер без монтажёра',
      'один сценарий — три площадки: как не сгореть',
      'почему автопостинг убивает охваты (и как это чинится)',
      'нейросети, которые реально делают работу за тебя',
      'мой стек инструментов для контент-конвейера',
      'что будет с контентом, когда каждый сможет генерировать видео',
      '3 ошибки в прогреве перед запуском продукта',
      'как выбрать нишу, в которой не придётся врать',
      'секрет стабильных охватов: не количество, а ритм',
      'разбор: почему ролик с 200 просмотров принёс 4 продажи',
    ],
    pains: ['ручной монтаж съедает вечер', 'идеи заканчиваются на третий день', 'алгоритм не прощает пропусков', 'подрядчики дорого и долго'],
    visuals: ['скринкаст дашборда', 'макром крупным планом', 'таймлапс рабочего стола', 'разговор в кадре', 'скриншот чата с ИИ', 'инфографика 3 шага'],
    tags: ['контент', 'нейросети', 'искусственныйинтеллект', 'маркетинг', 'smm', 'автоматизация', 'продуктивность'],
  },
  {
    key: 'fitness',
    match: ['фитнес', 'тренировк', 'спорт', 'тело', 'похудет', 'мышц', 'питани', 'fit'],
    topics: [
      'почему тренировки не работают без сна',
      '5 минут растяжки, которые спасают спину',
      'до/после: 12 недель без диет и запретов',
      'белок: сколько реально нужно и где взять',
      'тренировка, которую можно сделать в офисе',
      'разрушаем миф: кардио не сжигает жир само по себе',
      'что съесть до и после тренировки',
      'ошибка в приседаниях, из-за которой болит поясница',
    ],
    pains: ['нет времени на зал', 'мотивация кончается через неделю', 'непонятно, что есть', 'болит спина от сидячей работы'],
    visuals: ['до/после в одном кадре', 'крупный план упражнения', 'таймер тренировки', 'еда на столе сверху', 'чек-лист на экране'],
    tags: ['фитнес', 'тренировка', 'здоровье', 'похудение', 'спорт', 'питание', 'тело'],
  },
  {
    key: 'finance',
    match: ['финанс', 'деньг', 'инвест', 'бюджет', 'доход', 'крипт', 'бизнес', 'экономик'],
    topics: [
      'правило 3 конвертов, которое реально работает',
      'как за 20 минут навести порядок в личном бюджете',
      'что я перестал покупать — и стал спокойнее',
      'куда уходят деньги: разбор на реальном примере',
      'простая система подушки безопасности',
      'как считать стоимость часа своей жизни',
      'почему «просто больше зарабатывай» — плохой совет',
    ],
    pains: ['деньги заканчиваются до зарплаты', 'страшно смотреть в приложение банка', 'нет ясной цели', 'инвестиции кажутся казино'],
    visuals: ['график на экране', 'конверты/карточки руками', 'таблица расходов', 'скриншот приложения'],
    tags: ['финансы', 'бюджет', 'деньги', 'инвестиции', 'накопления', 'саморазвитие'],
  },
  {
    key: 'marketing',
    match: ['маркетинг', 'продаж', 'реклам', 'клиент', 'воронк', 'трафик', 'b2b', 'бренд'],
    topics: [
      'первый экран лендинга, который держит внимание',
      '3 сообщения клиенту, после которых он отвечает',
      'как считать окупаемость контента без гаданий',
      'хук, который работает в любой нише',
      'оффер, который не стыдно показывать',
      'почему реклама не окупается: 4 причины',
      'как из одного кейса сделать 20 роликов',
    ],
    pains: ['дорогие лиды', 'клиенты не отвечают', 'непонятно, что работает', 'контент есть, продаж нет'],
    visuals: ['скриншот объявления', 'разбор лендинга маркером', 'график конверсий', 'диалог в мессенджере'],
    tags: ['маркетинг', 'продажи', 'реклама', 'smm', 'трафик', 'бизнес'],
  },
  {
    key: 'psychology',
    match: ['психолог', 'отношен', 'привычк', 'мозг', 'терапи', 'выгорани', 'сон'],
    topics: [
      'почему отдых не восстанавливает',
      'одна фраза, которая снимает тревогу',
      'как перестать откладывать: метод 2 минут',
      'границы без скандала: 3 реплики',
      'что на самом деле значит «нет сил»',
      'утренний ритуал, который не требует силы воли',
    ],
    pains: ['выгорание', 'тревога перед задачами', 'нет границ в общении', 'прокрастинация'],
    visuals: ['разговор на камеру', 'текст на экране', 'спокойный b-roll: окно, чай', 'схема 2 шага'],
    tags: ['психология', 'привычки', 'саморазвитие', 'выгорание', 'осознанность', 'отношения'],
  },
  {
    key: 'generic',
    match: [],
    topics: [
      'одна привычка, которая изменила мой день',
      'как упростить то, что кажется сложным',
      '3 вещи, которые я понял за последний год',
      'ошибка новичка, которую все повторяют',
      'что делать, когда всё идёт не по плану',
      'как выбрать между «надо» и «хочу»',
      'мой чек-лист на неделю',
    ],
    pains: ['слишком много задач', 'нет ясности', 'страшно начинать', 'не хватает времени'],
    visuals: ['кадр на камеру', 'b-roll улицы', 'скриншот заметок', 'крупный план деталей'],
    tags: ['лайфхаки', 'продуктивность', 'мотивация', 'жизнь'],
  },
];

export function nicheFor(project = {}) {
  const hay = `${project.niche || ''} ${project.name || ''} ${project.description || ''} ${project.product_url || ''}`.toLowerCase();
  // не «первое совпадение», а максимальный вес: длинные корни важнее коротких.
  // Иначе «продуктивность» уводит проект про привычки в нишу SaaS.
  let best = null;
  let bestScore = 0;
  for (const n of NICHES) {
    let score = 0;
    for (const m of n.match) {
      if (m && hay.includes(m)) score += Math.min(4, Math.max(1, Math.floor(m.length / 4)));
    }
    if (score > bestScore) { best = n; bestScore = score; }
  }
  return best || NICHES[NICHES.length - 1];
}

const TEMPLATE_HOOKS = {
  review: ['Я месяц тестировал {thing}. Вот честный итог.', '{thing}: 3 вещи, которые я бы хотел знать раньше.', 'Стоит ли {thing} своих денег? Разбираем без рекламы.'],
  'before-after': ['Мой результат за 30 дней: было → стало.', 'До и после. Без фильтров и волшебства.', 'Что изменилось, когда я убрал одну привычку.'],
  'problem-solution': ['Ты теряешь на этом каждый день. И даже не замечаешь.', 'Одна проблема, которая крадёт 2 часа в день.', 'Почему это не работает — и что работает вместо.'],
  case: ['Кейс: как мы это сделали.', 'Цифры, а не обещания: разбор одного эксперимента.', 'Кейс на 30 секунд: было, сделали, получили.'],
  meme: ['Когда в очередной раз слышишь «просто делай контент».', 'POV: ты снова переписываешь сценарий в 2 ночи.', 'Мем, который слишком хорошо описывает этот день.'],
  listicle: ['3 инструмента, которые я использую каждый день.', '5 привычек, которые стоят 10 минут.', 'Подборка, которую я сохранил бы сам.'],
  pov: ['POV: ты наконец выстроил систему.', 'POV: первый ролик залетел.', 'POV: смотришь на очередь постов и понимаешь — работает.'],
  myth: ['Миф, в который я верил 3 года.', 'Это неправда. И вот почему.', 'Разрушаем самый популярный совет в этой теме.'],
};

const CTA_BANK = [
  'Сохрани, чтобы не потерять.',
  'Ссылка в профиле — там всё по шагам.',
  'Напиши «старт» в комментариях, расскажу подробнее.',
  'Забери шаблон по ссылке в описании.',
  'Подпишись, если нужен продолжение разбора.',
];

const CAPTION_BANK = [
  'Разобрали без воды, по шагам.',
  'Сохраняй, пригодится.',
  'Второй пункт — самый недооценённый.',
  'Система важнее героических рывков.',
  'Проверено на себе, не теория.',
];

const RISK_WORDS = [
  { w: 'гарант', r: 26 }, { w: 'доход', r: 14 }, { w: 'заработ', r: 18 }, { w: 'инвест', r: 16 },
  { w: 'крипт', r: 20 }, { w: 'похуд', r: 18 }, { w: 'за неделю', r: 16 }, { w: 'за 3 дня', r: 18 },
  { w: 'лечен', r: 22 }, { w: 'лекарств', r: 24 }, { w: 'ставить', r: 26 }, { w: 'займ', r: 24 },
  { w: '100%', r: 18 }, { w: 'врач', r: 12 }, { w: 'депозит', r: 16 }, { w: 'прибыль', r: 10 },
];

export function riskScore(text = '') {
  const hay = String(text).toLowerCase();
  let score = 4;
  for (const { w, r } of RISK_WORDS) if (hay.includes(w)) score += r;
  if (/[A-ZА-Я]{6,}/.test(String(text))) score += 3;
  return Math.min(96, score);
}

const TITLE_VARIATIONS = [
  (t) => t,
  (t) => `Разбор: ${t}`,
  (t) => `${t} — честный опыт`,
  (t) => `3 ошибки: ${t}`,
  (t) => `${t}. Что бы я сделал иначе`,
  (t) => `Коротко: ${t}`,
  (t) => `Проверено на себе: ${t}`,
  (t) => `${t} — без воды`,
];

const cleanBase = (t) => String(t)
  .replace(/^\s*(разбор|коротко|3 ошибки|проверено на себе)\s*:\s*/i, '')
  .replace(/\s*[—–-]\s*(честный опыт|без воды|что бы я сделал иначе)\s*$/i, '')
  .trim();

const capitalize = (t) => t.replace(/^[а-яa-z]/, (c) => c.toUpperCase());

const shuffle = (arr) => {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

export function generateIdeas(project, { count = 6, product = null, exclude = [], preferFormats = [], seedTopics = [] } = {}) {
  const niche = nicheFor(project);
  const out = [];
  const used = new Set(exclude.map((t) => String(t).toLowerCase()));
  const preferredFormats = preferFormats.filter((f) => FORMATS.includes(f));
  const basePool = [...new Set([
    ...seedTopics.map((t) => cleanBase(t)),
    ...niche.topics.map((t) => cleanBase(t)),
  ].filter(Boolean))];
  const thing = product?.name || project.name || 'этот подход';

  // волны: сначала «чистые» заголовки, затем 1–2 вариации на тему.
  // Так библиотека растёт без десятка однотипных «Разбор: Разбор:».
  let waves = 0;
  while (out.length < count && waves < 6) {
    waves++;
    const bases = shuffle(basePool);
    for (const base of bases) {
      if (out.length >= count) break;
      const variants = waves === 1
        ? [(t) => t]
        : shuffle(TITLE_VARIATIONS).filter((v) => v !== TITLE_VARIATIONS[0]).slice(0, 2);
      let added = 0;
      for (const variant of variants) {
        if (out.length >= count || added >= 2) break;
        const title = capitalize(variant(base).trim());
        const key = title.toLowerCase();
        if (used.has(key)) continue;
        used.add(key);
        added++;

        // половину тем отдаём форматам, которые уже дали лучший средний охват
        const format = preferredFormats.length && Math.random() < 0.5
          ? pick(preferredFormats)
          : pick(FORMATS.filter((f) => f !== 'myth' || Math.random() > 0.6));
        const hooks = TEMPLATE_HOOKS[format] || TEMPLATE_HOOKS['problem-solution'];
        const hook = pick(hooks).split('{thing}').join(thing);
        const pain = pick(niche.pains);
        const rnd = seededRandom(key + format + out.length);
        const score = Math.round(
          46 + rnd() * 40
          + (format === 'problem-solution' ? 5 : 0)
          + (preferredFormats.includes(format) ? 7 : 0)
        );
        out.push({
          title,
          hook,
          angle: `Боль: ${pain}. Показываем путь к результату через личный опыт и конкретику.`,
          format,
          tags: pickMany(niche.tags, 3),
          score: Math.min(99, score),
          source: 'ai',
        });
      }
    }
  }
  return out;
}

const asTagList = (value) => {
  if (Array.isArray(value)) return value.filter((t) => typeof t === 'string' && t.length > 1);
  if (typeof value === 'string') {
    // из БД теги приходят JSON-строкой; на всякий случай поддерживаем и «#тег #тег»
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return asTagList(parsed);
    } catch { /* не JSON */ }
    return value.split(/[\s,]+/).filter((t) => t.length > 1);
  }
  return [];
};

export function hashtagsFor(project, platform = 'reels', idea = {}, limit = 8) {
  const niche = nicheFor(project);
  const base = platform === 'tiktok'
    ? ['рек', 'врек', 'fyp', 'тикток', 'рекомендации', 'тренд']
    : ['reels', 'рилс', 'reelsinstagram', 'shorts', 'тренды'];
  const tags = pickMany([...niche.tags, ...asTagList(idea?.tags), ...base], Math.min(limit, 10));
  return [...new Set(tags)].slice(0, limit);
}

export function buildScript(project, idea, { product = null, platform = 'reels', tone, duration = 32 } = {}) {
  const niche = nicheFor(project);
  const format = idea?.format || project.format || 'problem-solution';
  const productBlock = product && product.name
    ? {
        name: product.name,
        pitch: product.pitch || 'решает задачу за пару минут',
        url: buildUtmUrl(product, platform),
      }
    : null;

  const pain = pick(niche.pains);
  const visuals = pickMany(niche.visuals, 6);
  const hook = idea?.hook || pick(TEMPLATE_HOOKS[format] || TEMPLATE_HOOKS['problem-solution']).replace('{thing}', product?.name || project.name);
  const cta = productBlock
    ? pick([`Ссылка на ${productBlock.name} — в описании.`, `Попробуй ${productBlock.name}: ссылка в профиле.`, 'Ссылка в описании — забирай и повторяй.'])
    : pick(CTA_BANK);

  const bodies = {
    review: [
      `Смотри, что реально внутри: ${productBlock ? productBlock.pitch : 'три функции, о которых никто не говорит'}.`,
      'Первое впечатление — «ещё один сервис». Второе — «почему я не начал раньше».',
      'Минус тоже есть, о нём ниже, без рекламного глянца.',
    ],
    'before-after': [
      `До: ${pain}. Каждый день одно и то же.`,
      'Изменил одну вещь — не количество усилий, а порядок действий.',
      `Через 30 дней: ${productBlock ? 'результат держится сам, потому что процесс больше не держится на силе воли' : 'стало спокойнее и в два раза быстрее'}.`,
    ],
    'problem-solution': [
      `Проблема: ${pain}.`,
      'Обычно советуют «просто делай больше». Это не работает, потому что растёт не результат, а усталость.',
      `Решение: убрать решения из головы и передать их системе${productBlock ? ` — например, ${productBlock.name}` : ''}.`,
      'Три шага: собрал → проверил → отпустил в работу.',
    ],
    case: [
      'Было: ноль системы, всё на энтузиазме.',
      'Сделали: разложили процесс на этапы и убрали ручные действия.',
      `Получили: ${productBlock ? productBlock.pitch : 'стабильный результат без ежедневного героизма'}.`,
      'Главное — не инструмент, а последовательность.',
    ],
    meme: [
      'Все: «контент должен быть спонтанным».',
      'Я в 2 ночи: «утверди сценарий, пожалуйста».',
      productBlock ? `С ${productBlock.name} спонтанным остаётся только вдохновение.` : 'С системой спонтанным остаётся только вдохновение.',
    ],
    listicle: [
      'Первый пункт экономит время сразу.',
      'Второй — самый недооценённый.',
      'Третий объясняет, почему первые два не работают в одиночку.',
    ],
    pov: [
      'POV: ты больше не начинаешь день с вопроса «что снимать».',
      'Очередь уже собрана, сценарии проверены, посты стоят по слотам.',
      'Ты просто смотришь на цифры.',
    ],
    myth: [
      'Миф: чтобы получать охваты, надо публиковать каждый день.',
      'Правда: алгоритму важен не объём, а удержание.',
      'Проверка: один точный ролик в 2 дня обгоняет семь слабых.',
    ],
  };

  const bodyLines = bodies[format] || bodies['problem-solution'];
  const sceneCount = Math.max(3, Math.min(5, bodyLines.length + 1));
  const per = Math.max(4, Math.round((duration - 4) / sceneCount));
  const scenes = [
    { n: 1, text: hook, visual: visuals[0] || 'кадр на камеру', seconds: Math.min(6, per) },
    ...bodyLines.slice(0, sceneCount - 2).map((line, i) => ({
      n: i + 2,
      text: line,
      visual: visuals[(i + 1) % visuals.length],
      seconds: per,
    })),
    { n: sceneCount, text: cta, visual: productBlock ? `карточка ${productBlock.name} + ссылка` : 'финальный кадр + подпись', seconds: Math.min(6, per) },
  ];

  return {
    hook,
    scenes,
    cta,
    caption: `${pick(CAPTION_BANK)} ${hook} ${productBlock ? `\n\n${productBlock.name} — ${productBlock.pitch}. ${productBlock.url}` : ''}`.trim(),
    hashtags: hashtagsFor(project, platform, idea),
    duration_sec: scenes.reduce((sum, s) => sum + s.seconds, 0),
    tone: tone || project.tone || 'friendly',
  };
}

export function buildUtmUrl(product, platform = 'reels', extra = {}) {
  if (!product?.url) return '';
  try {
    const url = new URL(product.url);
    url.searchParams.set('utm_source', extra.source || product.utm_source || platform);
    url.searchParams.set('utm_medium', extra.medium || product.utm_medium || 'short');
    url.searchParams.set('utm_campaign', extra.campaign || product.utm_campaign || 'pulse');
    if (extra.content) url.searchParams.set('utm_content', extra.content);
    return url.toString();
  } catch {
    return product.url;
  }
}

export function platformCaption(script, platform, product = null) {
  const tagLine = (script.hashtags || []).map((t) => `#${t.replace(/^#/, '')}`).join(' ');
  const cta = platform === 'tiktok'
    ? 'Ссылка в профиле · сохрани, чтобы попробовать'
    : 'Ссылка в описании · сохрани пост';
  const productLine = product?.url ? `\n\n${product.name}: ${buildUtmUrl(product, platform)}` : '';
  return `${script.caption || ''}${productLine}\n\n${cta}\n${tagLine}`.trim();
}

export const COVER_PALETTES = [
  ['#7C3AED', '#2B1055', '#F5F3FF'],
  ['#A855F7', '#1B1130', '#FDF4FF'],
  ['#6366F1', '#101024', '#EEF2FF'],
  ['#8B5CF6', '#0B0713', '#EDE9FE'],
  ['#C084FC', '#22103F', '#FFFFFF'],
  ['#4C1D95', '#120A21', '#F5F3FF'],
];

export function coverSvg({ title = 'Pulse', subtitle = '', seed = 'pulse', index = 0, hot = false }) {
  const rnd = seededRandom(seed + index);
  const palette = COVER_PALETTES[Math.abs(Math.floor(rnd() * COVER_PALETTES.length)) % COVER_PALETTES.length];
  const [c1, c2, fg] = palette;
  const words = String(title).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > 13) {
      if (line) lines.push(line.trim());
      line = w;
    } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line.trim());
  const shown = lines.slice(0, 4);
  const fs = shown.length >= 3 ? 58 : 68;
  const startY = 300 - ((shown.length - 1) * fs * 0.56);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="960" viewBox="0 0 540 960">
  <defs>
    <radialGradient id="g1" cx="20%" cy="8%" r="90%">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="60%" stop-color="${c2}"/>
      <stop offset="100%" stop-color="#07050C"/>
    </radialGradient>
    <linearGradient id="g2" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="46"/></filter>
  </defs>
  <rect width="540" height="960" fill="url(#g1)"/>
  <circle cx="${120 + rnd() * 300}" cy="${180 + rnd() * 200}" r="180" fill="${c1}" opacity="0.5" filter="url(#blur)"/>
  <circle cx="${420 - rnd() * 260}" cy="${760 + rnd() * 100}" r="160" fill="#FFFFFF" opacity="0.09" filter="url(#blur)"/>
  <rect x="0" y="0" width="540" height="960" fill="url(#g2)" opacity="0.5"/>
  <text x="48" y="96" font-family="Inter, Arial, sans-serif" font-size="19" letter-spacing="5" fill="${fg}" fill-opacity="0.62">PULSE · ${esc((subtitle || 'REEL').toUpperCase()).slice(0, 22)}</text>
  <g font-family="Inter, Arial, sans-serif" font-weight="800" font-size="${fs}" fill="${fg}">
    ${shown.map((l, i) => `<text x="48" y="${startY + i * fs * 1.12}">${esc(l)}</text>`).join('\n    ')}
  </g>
  <rect x="48" y="${startY + shown.length * fs * 1.12 + 24}" width="${90 + rnd() * 60}" height="6" rx="3" fill="${fg}" opacity="0.75"/>
  <g transform="translate(48, 852)">
    <rect width="${hot ? 128 : 104}" height="34" rx="17" fill="#FFFFFF" fill-opacity="0.14"/>
    <text x="16" y="23" font-family="Inter, Arial, sans-serif" font-size="15" fill="${fg}" fill-opacity="0.9">${hot ? '● В тренде' : '● Pulse'}</text>
  </g>
  <text x="492" y="884" text-anchor="end" font-family="Inter, Arial, sans-serif" font-size="15" fill="${fg}" fill-opacity="0.5">9:16 · ${esc(String(seed).slice(-4))}</text>
</svg>`;
}

export const NICHES_LIST = NICHES.map(({ key, topics, tags }) => ({ key, topics: topics.slice(0, 5), tags: tags.slice(0, 4) }));
export { FORMATS, CTA_BANK };
