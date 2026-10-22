// ─────────────────────────────────────────────────────────────────────────────
// Лимиты площадок — единственный источник правды.
// Раньше потолки были продублированы в четырёх местах (пайплайн, прозрачность,
// гейт публикации, API аккаунта) и расходились: например, гейт показывал 50 для
// Shorts, а публикация упиралась в 20. Теперь считаем здесь.
// ─────────────────────────────────────────────────────────────────────────────
import { num } from '../core/utils.js';

export const PLATFORMS = ['reels', 'tiktok', 'youtube'];

export const PLATFORM_LABELS = {
  reels: 'Instagram Reels',
  tiktok: 'TikTok',
  youtube: 'YouTube Shorts',
};

export const platformLabel = (platform) => PLATFORM_LABELS[platform] || platform;

/**
 * Технические лимиты API площадок (не наши настройки) — факты, на которые
 * опирается расчёт. Порядок величин проверен по документации площадок на 2026 год.
 */
export const PLATFORM_API_LIMITS = {
  tiktok: {
    per24h: 15, initPerMin: 6,
    description: 2200, comment: 150, hashtags: 8,
    note: 'Content Posting API: ~15 постов/24 ч на креатора, 6 init/мин; ссылки в описании не кликабельны',
  },
  reels: {
    per24h: 50, initPerMin: 25,
    description: 2200, comment: 2200, hashtags: 30,
    note: 'Instagram Graph API: 50 публикаций в скользящие 24 ч, ссылка в описании кликабельна',
  },
  youtube: {
    per24h: 100, initPerMin: 6,
    description: 5000, title: 100, tags: 4600, hashtags: 15,
    note: 'YouTube Data API: 100 videos.insert в сутки (квота проекта, сброс в полночь PT); заголовок ≤100, описание ≤5000 байт',
  },
};

/**
 * Рабочий потолок Pulse: заметно ниже технического лимита, потому что алгоритму
 * нужен ровный темп, а не выжигание квоты за час. Зависит от настроенного темпа
 * на аккаунт (`max_daily_per_account`).
 */
export function platformCap(platform, settings) {
  const perAccount = num(settings?.max_daily_per_account, 3);
  const hard = PLATFORM_API_LIMITS[platform]?.per24h || 50;
  const soft = platform === 'tiktok'
    ? perAccount * 5
    : platform === 'youtube'
      ? perAccount * 5
      : perAccount * 17;
  return Math.min(soft, hard);
}
