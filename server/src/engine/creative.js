// ─────────────────────────────────────────────────────────────────────────────
// Креативный движок: собирает полный пакет ролика — хук, сцены, титры, описание
// под каждую площадку, обложку, закреплённый комментарий — и выбирает лучший
// вариант из нескольких по тем же метрикам, что видит автопилот (вирусность,
// удержание, комплаенс).
//
// Это не «генератор случайного текста»: каждая сцена имеет роль в структуре,
// хук ограничен окном свайпа площадки, описание собирается по правилам площадки,
// а продажа продукта включается по расписанию (80/20), а не в каждом ролике.
// ─────────────────────────────────────────────────────────────────────────────
import { clamp, num, seededRandom, pick, parseJson } from '../core/utils.js';
import { db } from '../core/db.js';
import { PLATFORM_API_LIMITS } from './limits.js';
import { nicheFor, hashtagsFor, buildUtmUrl, FORMAT_LABELS } from './brain.js';
import { hookLab, retentionPlan, PLATFORM_PLAYBOOK } from './growth.js';
import { scoreViral } from './viral.js';
import { checkCompliance } from './compliance.js';
import { log } from '../core/logger.js';

const words = (s) => String(s || '').split(/\s+/).filter(Boolean).length;

// ── Структура ролика по формату ──────────────────────────────────────────────
// Каждая сцена: роль → как её собрать. Текст сцены — это титр на экране,
// поэтому он короткий: 6–14 слов, иначе рендер уожмёт его до нечитаемого.
const SHAPES = {
  'problem-solution': ['pain', 'why', 'fix', 'proof', 'close'],
  'before-after': ['before', 'turn', 'after', 'proof', 'close'],
  case: ['before', 'what', 'result', 'lesson', 'close'],
  listicle: ['hook2', 'item1', 'item2', 'item3', 'close'],
  myth: ['myth', 'truth', 'proof', 'how', 'close'],
  review: ['inside', 'plus', 'minus', 'verdict', 'close'],
  pov: ['pov', 'scene', 'turn', 'result', 'close'],
  meme: ['all', 'me', 'turn', 'close'],
};

const LEAD = /^(почему|как|что|зачем|когда|сколько|разбор|коротко|итог)[:\s]+/i;

/** Короткая тема из заголовка: без «почему/как», без висячих предлогов */
export function topicOf(title, fallback = '') {
  let text = String(title || '').replace(/[«»"]/g, '').trim();
  while (LEAD.test(text)) text = text.replace(LEAD, '');
  const parts = text.split(/\s+/).filter(Boolean);
  const out = [];
  for (const w of parts) {
    if (out.length >= 4) break;
    if (out.length && `${out.join(' ')} ${w}`.length > 34) break;
    out.push(w);
  }
  const clean = out.join(' ').replace(/[,:;—–-]+$/, '').trim();
  return clean.length >= 4 ? clean : String(fallback || 'короткие видео').slice(0, 34);
}

const q = (s) => `«${s}»`;

/**
 * Тексты сцен. Возвращает массив {role, text} — длительность считается отдельно.
 * Формулировки без обещаний дохода и без медицинских утверждений: это и требование
 * площадок, и защита от блокировки по комплаенсу.
 */
function sceneTexts(role, ctx) {
  const { topic, niche, product, rnd, reach } = ctx;
  const pain = pick(niche.pains, rnd);
  const visual = pick(niche.visuals, rnd);
  const fix2 = pick([
    'убрать решение из головы и передать его системе',
    'считать не усилия, а повторяемость',
    'сначала ритм, потом объём',
    'заменить мотивацию на чек-лист',
  ], rnd);
  // «3 шага» согласовано всегда: случайное число давало «5 шага»
  const steps = 3;
  switch (role) {
    // у каждой роли — несколько формулировок: одинаковый текст во всех роликах
    // бренда убивает и охват, и доверие («я это уже видел»)
    case 'pain': return pick([
      `${pain[0].toUpperCase()}${pain.slice(1)} — и это не лень`,
      `Дело не в мотивации: ${pain}`,
      `${pain[0].toUpperCase()}${pain.slice(1)}. Знакомо?`,
      `Ты не ленивый — просто ${pain}`,
    ], rnd);
    case 'why': return pick([
      'Совет «просто делай больше» растит не результат, а усталость',
      'Мозг выбирает простое действие, а не важное — это не характер',
      'Проблема не в дисциплине, а в отсутствии системы',
      'Чем сильнее давишь на себя, тем быстрее откат',
    ], rnd);
    case 'fix': return pick([
      `${steps} шага: собрать → проверить → отпустить в работу`,
      'Сначала ритм: 3 выхода в неделю в одно и то же окно',
      'Один ролик — одна мысль, остальное уходит в следующий',
      'Заменить мотивацию на чек-лист из трёх пунктов',
    ], rnd);
    case 'proof': return pick([
      `Через ${2 + Math.floor(rnd() * 3)} недели видно, работает ли система`,
      'Первые 7 дней — самые сложные, дальше идёт по инерции',
      'Через месяц ты не вспомнишь, что было тяжело',
      'Стабильность видна на третьей неделе, а не на второй день',
    ], rnd);
    case 'before': return `До: ${pain}. Каждый день одно и то же`;
    case 'turn': return `Изменил одну вещь — не объём, а порядок: ${fix2}`;
    case 'after': return 'После: то же время, но без ежедневного героизма';
    case 'what': return `Сделали: ${fix2}`;
    case 'result': return product ? `Получили: ${product.pitch}` : 'Получили стабильный результат без ручного труда';
    case 'lesson': return 'Главное — не инструмент, а последовательность';
    case 'hook2': return 'Первый пункт экономит вечер';
    case 'item1': return '1. Начни с ритма: 3 выхода в неделю, но всегда в своё окно';
    case 'item2': return '2. Один ролик — одна мысль. Вторую вынеси в следующий';
    case 'item3': return '3. Смотри на досмотр, а не на лайки: лайк не досматривает';
    case 'myth': return `Миф: ${q(topic)} — это про силу воли`;
    case 'truth': return 'Правда: работает система, а не героизм';
    case 'how': return `${steps} шага: убрать лишнее, зафиксировать ритм, проверить неделю`;
    case 'inside': return `Внутри: ${product?.pitch || pick(niche.topics, rnd)}`;
    case 'plus': return 'Плюс: первый результат видно уже на первой неделе';
    case 'minus': return 'Минус честный: без привычки система не поедет';
    case 'verdict': return 'Вывод: берите, если нужен процесс, а не волшебная кнопка';
    case 'pov': return `POV: ты снова открываешь ${q(topic)} в 23:40`;
    case 'scene': return 'Вокруг тишина, в голове — список из двадцати задач';
    case 'all': return 'Все: «контент должен быть спонтанным»';
    case 'me': return 'Я: «утверди сценарий, пожалуйста»';
    case 'close': {
      if (!product) return 'Сохрани, чтобы попробовать. Продолжение — в следующем';
      // у TikTok внешние ссылки не кликабельны: ведём в профиль, а не «в описание»
      const where = ctx.platform === 'tiktok' ? 'в профиле' : 'в описании';
      return `${product.name} — ссылка ${where}. Сохрани, чтобы не искать`;
    }
    default: return visual;
  }
}

/**
 * Сколько сцен нужно, чтобы честно набрать длину. Короткий ролик — 5–6 сцен,
 * длинный (Creator Rewards, > 60 с) — до 9 сцен: растягивать одну мысль на 12 с
 * нельзя, зритель уйдёт, а добавлять новые — можно.
 */
// Резервные роли для длинных роликов: добавляем только то, чего ещё нет в
// структуре, иначе «fix» и «how» скажут одно и то же двумя сценами подряд.
const EXTRA_ROLES = ['item1', 'item2', 'item3', 'minus', 'plus', 'verdict', 'how'];

function planShape(shape, total, hookSec) {
  const maxScene = total > 44 ? 9 : 6;
  const body = shape.filter((r) => r !== 'close');
  const tail = shape.includes('close') ? ['close'] : [];
  const roles = [...body];
  const redundant = roles.includes('fix') || roles.includes('how') ? ['how'] : [];
  const pool = EXTRA_ROLES.filter((r) => !roles.includes(r) && !redundant.includes(r));
  const needBody = Math.max(roles.length - 1 + tail.length, Math.ceil((total - hookSec) / maxScene));
  while (roles.length - 1 + tail.length < needBody && pool.length) roles.push(pool.shift());
  return { roles: [...roles, ...tail], maxScene };
}


/**
 * Тема для хука: сначала голова заголовка («Белок», «5 минут растяжки»),
 * потому что она про конкретный ролик; тег и ниша — запасной вариант.
 */
function hookSubject(tags, title, niche, fallback) {
  const META = new Set(['разбор', 'коротко', 'итог', 'вывод', 'миф', 'правда', 'ошибка', 'ошибки', 'до', 'после', 'плюсы', 'минусы']);
  let head = String(title || '').split(':')[0].replace(/[«»"]/g, '').trim();
  // «Коротко: одна фраза…» — после split(':') остаётся служебное слово: снимаем
  for (let i = 0; i < 3 && LEAD.test(head); i++) head = head.replace(LEAD, '').trim();
  const words = head.split(/\s+/).filter(Boolean);
  const first = (words[0] || '').toLowerCase();
  // глагол («перестать», «разрушаем»), ярлык формата («до/после»), цифра в начале
  // и служебные слова — не тема: «Почему перестать не работает?» звучит как баг
  const verbish = /(ть|ться|тся|лся|лась|лись|ишь|ешь|ем|им|ут|ют|ат|ят)$/i.test(first);
  const label = /[/|]/.test(head);
  const numeric = /^\d/.test(head);
  const meta = META.has(first);
  const short = words.length <= 3 && head.length <= 26 && !verbish && !label && !numeric && !meta;
  // тег вида «искусственныйинтеллект» в хуке читается как опечатка
  const tag = (tags || []).find((t) => String(t).length >= 3 && String(t).length <= 14);
  return (short && head) ? head : (tag || niche || fallback);
}

/** Тайминг: хук укладывается в окно свайпа, остальное — примерно равными сценами */
function timing(count, total, platform) {
  const pb = PLATFORM_PLAYBOOK[platform] || PLATFORM_PLAYBOOK.reels;
  const hookSec = Math.round(Math.min(pb.hookWindowSec + 1.2, 3.2) * 10) / 10;
  const maxScene = total > 44 ? 9 : 6;
  // финальный CTA не держим на экране дольше 4.5 с: это призыв, а не сцена
  const closeCap = 4.5;
  const rest = Math.max(count - 1, 1);
  const perScene = clamp((total - hookSec) / rest, 3, maxScene);
  const scenes = Array.from({ length: rest }, () => Math.round(perScene * 10) / 10);
  if (count > 2) {
    const last = scenes.pop();
    const capped = Math.min(last, closeCap);
    // остаток от CTA раздаём остальным сценам, чтобы длина осталась честной
    let leftover = Math.round((last - capped) * 10) / 10;
    for (let i = 0; i < scenes.length && leftover > 0; i++) {
      const room = maxScene - scenes[i];
      if (room <= 0) continue;
      const add = Math.min(room, leftover);
      scenes[i] = Math.round((scenes[i] + add) * 10) / 10;
      leftover = Math.round((leftover - add) * 10) / 10;
    }
    scenes.push(Math.round(capped * 10) / 10);
  }
  return [hookSec, ...scenes];
}

// ── Описание под площадку ────────────────────────────────────────────────────
function captionFor(platform, { hook, texts, hashtags, product, productUrl, promo, topic, project }) {
  // placement: video — продукт только в кадре, caption — только в описании,
  // both — и там, и там. Раньше выбора не было и ссылка лезла везде.
  const placement = product?.placement || 'both';
  if (product && placement === 'video') product = null;
  const tags = hashtags.map((t) => `#${String(t).replace(/^#/, '')}`);
  const tight = { tiktok: tags.slice(0, 8), reels: tags.slice(0, 8), youtube: tags.slice(0, 5) };
  const link = product && productUrl && promo === 'direct' ? productUrl : '';
  const softMention = product && promo === 'soft' && platform !== 'tiktok' ? `\n\n${product.name} — ${product.pitch}.` : '';

  if (platform === 'youtube') {
    // Shorts: первые строки читает поиск, ссылка кликабельна, тегов мало
    const body = [
      `${hook}`,
      '',
      `Коротко: ${texts.slice(0, 2).join(' · ') || topic}.`,
      link ? `Ссылка: ${link}` : '',
      softMention.trim(),
      '',
      'Досмотри до конца — там развязка.',
      tight.youtube.join(' '),
    ].filter((l) => l !== '').join('\n').trim();
    return body.slice(0, 4600);
  }

  if (platform === 'tiktok') {
    // TikTok не делает ссылки кликабельными: ведём в профиль, просим сохранить.
    // При мягком упоминании ссылку не подталкиваем — только называем продукт.
    const productLine = product
      ? (promo === 'direct' ? `${product.name} — ссылка в профиле.` : `${product.name} — если захочется быстрее.`)
      : '';
    return [
      `${hook}`,
      '',
      `Суть: ${texts.slice(0, 2).join(' · ')}`,
      productLine,
      'Сохрани, чтобы попробовать.',
      '',
      tight.tiktok.join(' '),
    ].filter((l) => l !== '').join('\n').trim();
  }

  // Reels: ссылка кликабельна, сохраняет пост
  return [
    `${hook}`,
    '',
    `Суть: ${texts.filter(Boolean).slice(1, 3).join(' · ')}`,
    link ? `${product.name}: ${link}` : softMention.trim(),
    'Сохрани пост — пригодится.',
    '',
    tight.reels.join(' '),
  ].filter((l) => l !== '').join('\n').trim();
}

/**
 * Заголовок для YouTube и карточки ролика (≤ 100 символов).
 * Раньше он собирался из ниши проекта, поэтому у всех роликов одного бренда
 * был одинаковый заголовок — для поиска YouTube это минус. Теперь в основу
 * идёт сам хук: у каждого варианта он свой.
 */
function titleFor(source, topic) {
  const clean = String(source || topic || '').trim().replace(/[.!?]+$/, '');
  const t = clean.charAt(0).toUpperCase() + clean.slice(1);
  const full = t.length <= 84 ? `${t} — разбор без воды` : t;
  return full.length <= 100 ? full : `${full.slice(0, 97).trimEnd()}…`;
}

/**
 * Собирает пакет. Один кандидат — это один хук + одна структура сцен.
 * `attempt` меняет и хук, и формулировки, чтобы варианты реально отличались.
 */
export function buildPackage({
  project = {}, idea = {}, product = null, platform = 'reels',
  durationSec = null, promo = 'soft', attempt = 0, campaign = null, count = 3,
} = {}) {
  const niche = nicheFor(project);
  const topic = topicOf(idea.title || idea.topic || project.niche || project.name, project.name);
  const pb = PLATFORM_PLAYBOOK[platform] || PLATFORM_PLAYBOOK.reels;
  // Потолок длины — тот, что реально может отрендерить платформа. Иначе
  // просьба «сделай 65 с для Creator Rewards» молча превращалась в 42 с.
  const cap = clamp(num(process.env.PULSE_RENDER_MAX_SEC, 42), 16, 120);
  const requested = num(durationSec, project.duration_sec || 32);
  const total = clamp(requested, 16, cap);
  const cappedByRender = requested > cap;
  const rnd = seededRandom(`${topic}-${platform}-${attempt}-${project.id || project.name || ''}`);

  // Тема для хука — короткое существительное (тег идеи или ниша), а не обрубок
  // заголовка: из «5 минут растяжки» получалось «Почему 5 минут не работает?».
  // tags в SQLite — это TEXT с JSON: без parseJson в хук попадал символ «[»
  const ideaTags = Array.isArray(idea.tags) ? idea.tags : parseJson(idea.tags, []);
  const hookSource = hookSubject(ideaTags, idea.title, project.niche, topic);
  const lab = hookLab({ topic: hookSource, platform, niche: project.niche || '' });
  // приоритет — хук, который успевает прозвучать до свайпа; среди них уже по силе
  const fitting = lab.hooks.filter((h) => h.fitsWindow);
  const ranked = [...fitting.sort((a, b) => b.score - a.score), ...lab.hooks.filter((h) => !h.fitsWindow).sort((a, b) => b.score - a.score)];
  // Внутри топ-3 выбираем по «отпечатку» идеи: у каждого ролика свой угол, иначе
  // весь аккаунт начинался бы одинаковой фразой. Качество при этом не падает.
  const top = ranked.filter((h) => h.fitsWindow).slice(0, 3);
  const pool = top.length ? top : ranked.slice(0, 3);
  const print = [...String(idea.id || idea.title || topic)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 100003, 7);
  const hookPick = pool[(print + attempt) % pool.length] || lab.best;
  const format = SHAPES[idea.format] ? idea.format : (SHAPES[project.format] ? project.format : 'problem-solution');
  const shape = SHAPES[format];
  const ctx = { topic, niche, product, rnd, platform };

  const planned = planShape(shape, total, Math.min(pb.hookWindowSec + 1.2, 3.2));
  const body = planned.roles.map((role) => ({ role, text: sceneTexts(role, ctx) }));
  const seconds = timing(planned.roles.length + 1, total, platform);
  const scenes = [{ n: 1, role: 'hook', text: hookPick.text, seconds: seconds[0], visual: pick(niche.visuals, rnd) }]
    .concat(body.map((b, i) => ({
      n: i + 2,
      role: b.role,
      text: b.text,
      seconds: seconds[i + 1] || 5,
      visual: pick(niche.visuals, rnd),
    })));

  const durationSecFinal = Math.round(scenes.reduce((s, x) => s + x.seconds, 0));
  // в описание идут только содержательные строки: без «Миф:», «1.» и CTA-хвоста
  const texts = scenes
    .filter((sc) => !['hook', 'close'].includes(sc.role))
    .map((sc) => sc.text.replace(/^(миф|правда|до|после|внутри|плюс|минус|вывод|сделали|получили|главное|итог)\s*:\s*/i, '').replace(/^\d+[.)]\s*/, '').trim())
    .filter((t) => t.length > 12);

  // У каждой площадки свои теги, своя длина описания и своя метка UTM:
  // иначе переходы с одного канала записывались бы другому.
  const packFor = (pl) => {
    const url = product?.url ? buildUtmUrl(product, pl, { source: pl, content: idea.id || 'pulse' }) : '';
    const tags = hashtagsFor(project, pl, { tags: idea.tags || niche.tags }, pl === 'youtube' ? 5 : 8);
    return { caption: captionFor(pl, { hook: hookPick.text, texts, hashtags: tags, product, productUrl: url, promo, topic, project }), tags, url };
  };
  const packs = { tiktok: packFor('tiktok'), reels: packFor('reels'), youtube: packFor('youtube') };
  for (const pl of Object.keys(packs)) {
    const cap = packs[pl].caption;
    const max = PLATFORM_API_LIMITS[pl]?.description || 2200;
    if (cap.length > max) packs[pl].caption = cap.slice(0, max).trimEnd();
  }
  const hashtags = packs[platform].tags;
  const productUrl = packs[platform].url;
  // ссылка в описании — только если placement это разрешает
  const captionProduct = product && (product.placement || 'both') !== 'video' ? product : null;
  const caption = packs[platform].caption;

  const title = titleFor(idea.title || hookPick.text, topic);
  const viral = scoreViral({
    title,
    scenes: scenes.map((s) => ({ text: s.text, seconds: s.seconds })),
    description: caption,
    hashtags,
    targetSec: durationSecFinal,
    topic,
    projectId: project.id,
  });
  const retention = retentionPlan({
    scenes: scenes.map((s) => ({ text: s.text, seconds: s.seconds })),
    title,
    description: caption,
    platform,
    durationSec: durationSecFinal,
    hashtags,
  });
  const compliance = checkCompliance({
    title,
    description: caption,
    scenes: scenes.map((s) => ({ text: s.text })),
    platform,
    hashtags,
    campaign,
  });

  const retentionRatio = retention.targetCompletion > 0 ? retention.predictedCompletion / retention.targetCompletion : 0;
  const complianceScore = compliance.blocking?.length ? 30 : (compliance.score ?? 90);
  const total_ = Math.round(
    clamp(hookPick.score, 0, 100) * 0.3
    + clamp(viral.score, 0, 100) * 0.3
    + clamp(retentionRatio * 100, 0, 100) * 0.25
    + clamp(complianceScore, 0, 100) * 0.15,
  );

  return {
    id: `${platform}-${attempt}-${hookPick.id}`,
    format,
    formatLabel: FORMAT_LABELS[format] || format,
    platform,
    platformLabel: pb.label,
    topic,
    title,
    hook: hookPick.text,
    hookType: hookPick.type,
    hookScore: hookPick.score,
    fitsWindow: hookPick.fitsWindow,
    scenes,
    durationSec: durationSecFinal,
    caption,
    captions: { tiktok: packs.tiktok.caption, reels: packs.reels.caption, youtube: packs.youtube.caption },
    hashtagsByPlatform: { tiktok: packs.tiktok.tags, reels: packs.reels.tags, youtube: packs.youtube.tags },
    hashtags,
    coverText: hookPick.text.split(/\s+/).slice(0, 5).join(' '),
    pinnedComment: captionProduct && promo === 'direct'
      ? `${product.name}: ${packs[platform].url || product.url}`.slice(0, PLATFORM_API_LIMITS.tiktok?.comment || 150)
      : null,
    product: product ? { id: product.id, name: product.name, intensity: promo, placement: product.placement || 'both', url: (captionProduct ? productUrl : '') || product.url || '' } : null,
    scores: {
      total: total_,
      hook: hookPick.score,
      viral: viral.score,
      retention: retention.predictedCompletion,
      retentionTarget: retention.targetCompletion,
      compliance: complianceScore,
    },
    checks: retention.checks,
    warnings: [
      ...(cappedByRender ? [{
        severity: 'warn',
        text: `Нужно ${Math.round(requested)} с, но рендер ограничен ${cap} с — поднимите PULSE_RENDER_MAX_SEC, иначе Creator Rewards недоступен`,
      }] : []),
      ...(compliance.blocking || []).map((b) => ({ severity: 'block', text: b.reason })),
      ...(hookPick.fitsWindow ? [] : [{ severity: 'warn', text: `Хук ${hookPick.readableSec} с — длиннее окна свайпа ${pb.hookWindowSec} с` }]),
      ...(durationSecFinal > pb.idealSec[1] ? [{ severity: 'warn', text: `Длительность ${durationSecFinal} с выше оптимума ${pb.idealSec[1]} с — досмотр упадёт` }] : []),
    ],
    alternativeHooks: lab.hooks.slice(0, 4).map((h) => ({ text: h.text, score: h.score, type: h.type })),
  };
}

/**
 * Студия: несколько кандидатов, отсортированных по итоговому скору.
 * Именно это вызывает автопилот и экран «Студия».
 */
// ─────────────────────────────────────────────────────────────────────────────
// ИИ-усиление готового пакета. Шаблон остаётся страховкой: модель приносит
// только тексты (хук, сцены, теги), а тайминг, скоринг, комплаенс и правила
// площадок считает движок. Если модель недоступна — возвращаем пакет как есть.
// ─────────────────────────────────────────────────────────────────────────────
export async function enrichPackage(pack, ctx = {}) {
  if (!pack) return pack;
  const {
    project = {}, idea = {}, product = null, platform = pack.platform,
    durationSec = pack.durationSec, promo = 'none', topic = pack.topic, persona = null,
  } = ctx;

  let ai = null;
  try {
    const mod = await import('./ai.js');
    ai = await mod.shortPack({ project, idea, product, platform, durationSec, promo, topic, persona });
  } catch (err) {
    log({ level: 'warn', actor: 'ai', action: 'creative.enrich_failed', message: String(err.message || err) });
    return pack;
  }
  if (!ai) return pack;

  const pb = PLATFORM_PLAYBOOK[platform] || PLATFORM_PLAYBOOK.reels;
  const total = Math.max(16, Number(durationSec) || pack.durationSec || 32);
  const seconds = timing(ai.scenes.length, total, platform);
  const niche = nicheFor(project);
  const rnd = seededRandom(`${topic}-${platform}-ai-${idea.id || idea.title || ''}`);
  const scenes = ai.scenes.map((s, i) => ({
    n: i + 1,
    role: i === 0 ? 'hook' : i === ai.scenes.length - 1 ? 'close' : 'body',
    text: s.text,
    seconds: seconds[i] || Math.max(3, Math.round(total / ai.scenes.length)),
    visual: s.visual || pick(niche.visuals, rnd),
  }));
  const durationSecFinal = Math.round(scenes.reduce((a, s) => a + s.seconds, 0));
  const hook = ai.hook || scenes[0].text;

  const url = product?.url ? buildUtmUrl(product, platform, { source: platform, content: idea.id || 'pulse' }) : '';
  const tags = ai.hashtags.length ? ai.hashtags : hashtagsFor(project, platform, { tags: idea.tags || niche.tags }, platform === 'youtube' ? 5 : 8);
  const texts = scenes
    .filter((sc) => !['hook', 'close'].includes(sc.role))
    .map((sc) => sc.text.replace(/^\d+[.)]\s*/, '').trim())
    .filter((t) => t.length > 12);
  const caption = captionFor(platform, { hook, texts, hashtags: tags, product, productUrl: url, promo, topic, project });
  const max = PLATFORM_API_LIMITS[platform]?.description || 2200;
  const captionFinal = caption.length > max ? caption.slice(0, max).trimEnd() : caption;

  const title = (ai.title && ai.title.length > 12 ? ai.title : titleFor(idea.title || hook, topic)).slice(0, 100);
  const viral = scoreViral({
    title, scenes: scenes.map((s) => ({ text: s.text, seconds: s.seconds })),
    description: captionFinal, hashtags: tags, targetSec: durationSecFinal, topic, projectId: project.id,
  });
  const retention = retentionPlan({
    scenes: scenes.map((s) => ({ text: s.text, seconds: s.seconds })),
    title, description: captionFinal, platform, durationSec: durationSecFinal, hashtags: tags,
  });
  const compliance = checkCompliance({
    title, description: captionFinal, scenes: scenes.map((s) => ({ text: s.text })), platform, hashtags: tags,
  });
  const retentionRatio = retention.targetCompletion > 0 ? retention.predictedCompletion / retention.targetCompletion : 0;
  const complianceScore = compliance.blocking?.length ? 30 : (compliance.score ?? 90);
  const total_ = Math.round(
    clamp(pack.hookScore ?? 70, 0, 100) * 0.3
    + clamp(viral.score, 0, 100) * 0.3
    + clamp(retentionRatio * 100, 0, 100) * 0.25
    + clamp(complianceScore, 0, 100) * 0.15,
  );

  return {
    ...pack,
    ai: { provider: ai.provider, model: ai.model, cached: ai.cached },
    title,
    hook,
    scenes,
    durationSec: durationSecFinal,
    caption: captionFinal,
    captions: { ...(pack.captions || {}), [platform]: captionFinal },
    hashtags: tags,
    hashtagsByPlatform: { ...(pack.hashtagsByPlatform || {}), [platform]: tags },
    coverText: hook.split(/\s+/).slice(0, 5).join(' '),
    scores: { ...(pack.scores || {}), total: total_, viral: viral.score, retention: retention.predictedCompletion, compliance: complianceScore },
    warnings: [
      ...(pack.warnings || []).filter((w) => w.severity !== 'warn' || !String(w.text || '').includes('Хук')),
      ...(compliance.blocking || []).map((b) => ({ severity: 'block', text: b.reason })),
    ],
  };
}

export function studio({
  project = {}, idea = {}, product = null, platform = 'reels',
  durationSec = null, promo = 'soft', count = 3, campaign = null,
} = {}) {
  // В кадре продукт появляется только если это разрешено настройкой продукта
  // (placement: video | both). При «только в описании» сцены остаются чистыми.
  const sceneProduct = product && (product.placement || 'both') !== 'caption' ? product : null;
  const packages = [];
  for (let attempt = 0; attempt < clamp(count, 1, 5); attempt++) {
    packages.push(buildPackage({ project, idea, product: sceneProduct, platform, durationSec, promo, attempt, campaign }));
  }
  packages.sort((a, b) => b.scores.total - a.scores.total);
  const best = packages[0];
  return {
    platform,
    platformLabel: best.platformLabel,
    topic: best.topic,
    best,
    // «кандидаты» — то же, что packages: три варианта, отсортированные по скору
    candidates: packages,
    packages,
    guidance: [
      `Хук должен прозвучать за ${PLATFORM_PLAYBOOK[platform]?.hookWindowSec || 1.3} с — иначе зритель уходит до смысла.`,
      `Длительность держим ${PLATFORM_PLAYBOOK[platform]?.idealSec.join('–')} с: ${PLATFORM_PLAYBOOK[platform]?.retentionBench}.`,
      'Одна сцена — одна мысль: титр читается 2–3 секунды, длиннее — зритель не успевает.',
      'Последняя фраза возвращает к первой: это даёт пересмотр, а пересмотр — охват.',
      'Продажа — не в каждом ролике: 1 прямой CTA на 3–4 полезных.',
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Продажа продукта: когда продавать, а когда просто быть полезным.
// Правило 80/20 — не догма: если продаж нет давно, доля прямых CTA растёт,
// но не выше 1 ролика из 2, иначе падает досмотр и охват.
// ─────────────────────────────────────────────────────────────────────────────
export const PROMO_SHARE = { min: 0.15, target: 0.25, max: 0.5 };

export function promotionDecision({ project, product = null, days = 14 } = {}) {
  if (!project?.id) return { intensity: 'none', product: null, reason: 'Проект не выбран', share: 0 };
  const prod = product || dbProduct(project.id);
  if (!prod) return { intensity: 'none', product: null, reason: 'У проекта нет активного продукта', share: 0 };
  // «всегда» — осознанный выбор владельца (свой продукт/свой канал):
  // правило 80/20 отключается, но маркировка рекламы остаётся обязательной.
  if (Number(prod.always) === 1) {
    return { intensity: 'direct', product: prod, share: 1, reason: 'Продукт помечен «в каждом ролике»', productId: prod.id };
  }

  const since = new Date(Date.now() - days * 86400000).toISOString();
  const total = dbCount(`SELECT COUNT(*) n FROM episodes WHERE project_id = ? AND status = 'published' AND published_at >= ?`, project.id, since);
  // промо-роликом считаем тот, где продукт был привязан (прямой CTA), а не «упомянут»
  const promo = dbCount(`SELECT COUNT(*) n FROM episodes WHERE project_id = ? AND status = 'published' AND published_at >= ? AND product_id = ?`, project.id, since, prod.id);
  const share = total ? promo / total : 0;

  // Если роликов ещё мало — начинаем с пользы: первый ролик не должен продавать.
  if (total < 2) {
    return { intensity: 'soft', product: prod, share, reason: 'Новый проект: сначала польза, продажа — со второго ролика', productId: prod.id };
  }
  if (share < PROMO_SHARE.min) {
    return {
      intensity: 'direct', product: prod, share,
      reason: `Прямых предложений ${promo} из ${total} за ${days} дн. — пора напомнить о продукте`,
      productId: prod.id,
    };
  }
  if (share < PROMO_SHARE.target) {
    return {
      intensity: 'soft', product: prod, share,
      reason: `Продающих роликов ${Math.round(share * 100)}% — держим мягкое упоминание без давления`,
      productId: prod.id,
    };
  }
  return {
    intensity: 'none', product: null, share,
    reason: `Продающих роликов уже ${Math.round(share * 100)}% — этот выпуск делаем без продажи`,
    productId: null,
  };
}

const dbCount = (sql, ...args) => db.prepare(sql).get(...args)?.n || 0;

function dbProduct(projectId) {
  // у продуктов нет жёсткой привязки к проекту: берём продукт проекта через эпизоды,
  // иначе — активный продукт платформы (он продвигается по всем каналам)
  const own = db.prepare(`SELECT p.* FROM products p
      JOIN episodes e ON e.product_id = p.id
      WHERE e.project_id = ? AND p.active = 1
      GROUP BY p.id ORDER BY COUNT(*) DESC LIMIT 1`).get(projectId);
  return own || db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();
}
