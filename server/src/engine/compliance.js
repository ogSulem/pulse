// ─────────────────────────────────────────────────────────────────────────────
// Compliance — проверка ролика по правилам площадок ДО публикации.
//
// Задача не «обойти модерацию», а не выпустить контент, который её нарушает:
// обещания дохода и здоровья, запрещённые категории, кликбейт, непомеченная
// реклама. Часть правил — жёсткие блокировки (blocking), часть — предупреждения
// (warn). Блокировка переводит ролик в ручную проверку, а не удаляет.
//
// Источники: Community Guidelines TikTok и Meta, правила рекламы, требования
// к маркировке рекламы и AI-контента. Значения консервативные: лучше отправить
// на проверку, чем получить ограничение аккаунта.
// ─────────────────────────────────────────────────────────────────────────────
import { db } from '../core/db.js';

const RULES = [
  // ── финансы: обещания дохода ──────────────────────────────────────────────
  { id: 'fin-guarantee', severity: 'block', re: /(гарантирован\w*\s+(доход|прибыл|процент|результат)|доход\s+без\s+риск|безрисков\w+\s+доход|100\s*%\s*(доход|прибыл|гарант))/i, reason: 'Обещание гарантированного дохода — прямое нарушение правил финансового контента' },
  { id: 'fin-getrich', severity: 'warn', re: /(разбогате\w+|заработа\w+\s+(за|на)\s+\d+\s*(дн|недел|час)|пассивн\w+\s+доход)/i, reason: 'Формулировка «лёгких денег»: площадки понижают охват и могут ограничить аккаунт' },
  { id: 'fin-crypto', severity: 'warn', re: /(крипт\w+|токен\w*|инвест\w+\s+совет|сигнал\w+\s+по\s+рынк)/i, reason: 'Финансовые советы и крипто-темы требуют дисклеймера и часто ограничиваются' },

  // ── здоровье ──────────────────────────────────────────────────────────────
  { id: 'health-cure', severity: 'block', re: /(лечит|излечива\w+|вылеч\w+|гарантированн\w+\s+результат\s+в\s+медицин|избавит\s+от\s+(болезн|диагноз))/i, reason: 'Медицинские обещания лечения — запрещены без лицензии и подтверждений' },
  { id: 'health-weight', severity: 'warn', re: /(похуде\w+\s+(на\s+)?\d+\s*кг\s+за|сбросить\s+\d+\s*кг\s+за\s+\d+\s*(дн|недел))/i, reason: 'Обещание быстрого похудения: риск ограничения и жалоб' },
  { id: 'health-meds', severity: 'block', re: /(препарат\w*|лекарств\w*|дозировк\w+|антибиотик\w*)/i, reason: 'Упоминание препаратов и дозировок требует медицинской проверки' },

  // ── площадки: кликбейт и вовлечение ──────────────────────────────────────
  { id: 'eng-bait', severity: 'warn', re: /(подпишись\s+или|лайкни\s+если|напиши\s+«?\d»?\s+в\s+коммент|коммент\w*\s+«?\d»?)/i, reason: 'Явный «engagement bait» — площадки снижают охват таких роликов' },
  { id: 'clickbait', severity: 'warn', re: /(шок|вы\s+не\s+поверите|это\s+изменит\s+всё|секрет\w*\s+котор\w+\s+скрыва\w+)/i, reason: 'Кликбейт: обещание в тексте не должно расходиться с содержанием' },

  // ── реклама и маркировка ─────────────────────────────────────────────────
  { id: 'ad-hidden', severity: 'warn', re: /(промокод|скидк\w+\s+\d+%|купи\s+сейчас|закажи\s+по\s+ссылк)/i, reason: 'Признаки рекламы: нужна маркировка (Pulse добавит её сам, если включено)' },

  // ── опасный контент ──────────────────────────────────────────────────────
  { id: 'danger', severity: 'block', re: /(взрывчат|оружие|наркотик|самоубийств|суицид)/i, reason: 'Запрещённая категория контента' },
  { id: 'minor', severity: 'block', re: /(ребен|ребён|детск\w+\s+контент|школьник)/i, reason: 'Контент с детьми требует особого режима — публикуйте только вручную' },
];

// Лимиты площадок (актуальные на момент написания; проверяются при публикации)
export const PLATFORM_RULES = {
  reels: {
    label: 'Instagram Reels',
    captionMax: 2200,
    hashtagsRecommended: 8,
    hashtagsMax: 30,
    videoMaxSec: 900,
    videoMaxBytes: 300 * 1024 * 1024,
    publishPer24h: 100,          // лимит API, фактически в UI держим меньший
    apiCallsPerUser: '4800 × показы / 24 ч',
    notes: [
      'Один API-пост = 1 единица лимита на публикацию (Reels, фото, карусель).',
      'Окно лимита скользящее 24 часа, а не «до полуночи».',
      'Публикация идёт через media container → media_publish; контейнер живёт 24 часа.',
    ],
  },
  tiktok: {
    label: 'TikTok',
    captionMax: 2200,
    hashtagsRecommended: 6,
    hashtagsMax: 20,
    videoMaxSec: 600,
    videoMaxBytes: 4 * 1024 * 1024 * 1024,
    publishPer24h: 15,           // ~15 постов/сутки на аккаунт, общий для всех клиентов
    apiCallsPerUser: '6 init/мин, 30 status/мин',
    notes: [
      'Неаудированный клиент публикует только приватно (SELF_ONLY) и максимум на 5 аккаунтов в сутки.',
      'После аудита снимается ограничение приватности и поднимается лимит активных креаторов.',
      'Публикация: init → upload → status до PUBLISH_COMPLETE.',
    ],
  },
};

const strip = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ');

/**
 * Проверяет текст ролика и возвращает отчёт.
 * severity: 'block' — нельзя планировать автоматически, 'warn' — можно, но с предупреждением.
 */
export function checkCompliance({ title = '', description = '', scenes = [], platform = 'reels', hashtags = [], adLabel = true, aiLabel = true }) {
  const haystack = strip([title, description, ...(scenes || []).map((s) => s.text || s)].join(' '));
  const findings = RULES.filter((r) => r.re.test(haystack)).map((r) => ({
    id: r.id,
    severity: r.severity,
    reason: r.reason,
    match: (haystack.match(r.re) || [])[0] || '',
  }));

  const rules = PLATFORM_RULES[platform] || PLATFORM_RULES.reels;
  const caption = String(description || '');
  if (caption.length > rules.captionMax) {
    findings.push({ id: 'caption-length', severity: 'block', reason: `Описание длиннее лимита ${rules.label} (${rules.captionMax} символов)`, match: `${caption.length}` });
  }
  if ((hashtags || []).length > rules.hashtagsMax) {
    findings.push({ id: 'hashtags-count', severity: 'warn', reason: `Слишком много хештегов: рекомендуем ${rules.hashtagsRecommended}–${rules.hashtagsMax}`, match: String((hashtags || []).length) });
  }
  if (adLabel && /(промокод|скидк|купи|закажи)/i.test(haystack) && !/реклама|ad\b|партнёрск|партнерск/i.test(haystack)) {
    findings.push({ id: 'ad-disclosure', severity: 'warn', reason: 'Есть признаки рекламы, но нет пометки — Pulse добавит её в описание', match: 'ad' });
  }

  const blocking = findings.filter((f) => f.severity === 'block');
  const warnings = findings.filter((f) => f.severity === 'warn');
  return {
    ok: blocking.length === 0,
    score: Math.max(0, 100 - blocking.length * 40 - warnings.length * 12),
    blocking,
    warnings,
    findings,
    platform,
    limits: rules,
    checked_at: new Date().toISOString(),
    labels: { ad: adLabel, ai: aiLabel },
  };
}

/** Текст маркировки, который добавляется в описание */
export function disclosureText({ ad, ai, productName }) {
  const parts = [];
  if (ad) parts.push(`Реклама${productName ? `: ${productName}` : ''}.`);
  if (ai) parts.push('Видео создано с помощью ИИ.');
  return parts.join(' ');
}

export function saveCompliance(episodeId, report) {
  db.prepare('UPDATE episodes SET compliance = ? WHERE id = ?').run(JSON.stringify(report), episodeId);
}
