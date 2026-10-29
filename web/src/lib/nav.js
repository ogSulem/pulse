// ─────────────────────────────────────────────────────────────────────────────
// Навигация Pulse: пять разделов вместо пятнадцати пунктов.
//
// Правило, по которому всё сгруппировано: раздел отвечает на вопрос, который
// человек реально задаёт. «Что делать сейчас» → Сегодня. «Откуда контент» →
// Создать. «Где аудитория» → Каналы. «Сколько заработал» → Деньги. «Как это
// настроено» → Настройки. Всё остальное — вкладки внутри раздела, а не отдельные
// строки в меню: 15 пунктов в сайдбаре не помогают зарабатывать, они заставляют
// каждый раз вспоминать, где что лежит.
//
// Старые адреса (#/queue, #/analytics, …) продолжают работать: они разрешаются
// в раздел и вкладку через LEGACY, поэтому все существующие ссылки и закладки
// живые — но меню их больше не показывает.
// ─────────────────────────────────────────────────────────────────────────────

export const SECTIONS = [
  {
    id: 'today',
    label: 'Сегодня',
    icon: 'grid',
    title: 'Сегодня',
    sub: 'Один следующий шаг, деньги и то, что мешает зарабатывать',
    tabs: [{ id: 'today', label: 'Сейчас', icon: 'zap' }],
  },
  {
    id: 'create',
    label: 'Создать',
    icon: 'film',
    title: 'Создать контент',
    sub: 'Студия, очередь, расписание, сериалы и темы — в одном месте',
    badge: 'active',
    tabs: [
      { id: 'studio', label: 'Студия', icon: 'rocket' },
      { id: 'queue', label: 'Очередь', icon: 'film' },
      { id: 'calendar', label: 'Расписание', icon: 'calendar' },
      { id: 'series', label: 'Сериалы', icon: 'sparkles' },
      { id: 'themes', label: 'Темы', icon: 'wand' },
    ],
  },
  {
    id: 'channels',
    label: 'Каналы',
    icon: 'at',
    title: 'Каналы и охваты',
    sub: 'Аккаунты, алгоритмы площадок, хуки и удержание',
    tabs: [
      { id: 'growth', label: 'Рост', icon: 'growth' },
      { id: 'accounts', label: 'Аккаунты', icon: 'at' },
      { id: 'trust', label: 'Правила', icon: 'shield' },
    ],
  },
  {
    id: 'money',
    label: 'Деньги',
    icon: 'target',
    title: 'Деньги',
    sub: 'Прибыль, аналитика, реклама и продукты — всё, что приносит доход',
    tabs: [
      { id: 'totals', label: 'Итоги', icon: 'target' },
      { id: 'analytics', label: 'Аналитика', icon: 'chart' },
      { id: 'ads', label: 'Реклама', icon: 'megaphone' },
      { id: 'products', label: 'Продукты', icon: 'package' },
    ],
  },
  {
    id: 'settings',
    label: 'Настройки',
    icon: 'settings',
    title: 'Настройки',
    sub: 'Режим, провайдеры, хостинг и журнал действий',
    tabs: [
      { id: 'main', label: 'Основное', icon: 'settings' },
      { id: 'hosting', label: 'Хостинг', icon: 'database' },
      { id: 'logs', label: 'Журнал', icon: 'terminal' },
    ],
  },
];

// Старые адреса → раздел/вкладка. Нужны, чтобы меню можно было сокращать, не
// ломая привычные ссылки из писем, закладок и подсказок внутри интерфейса.
export const LEGACY = {
  dashboard: ['today', 'today'],
  studio: ['create', 'studio'],
  queue: ['create', 'queue'],
  calendar: ['create', 'calendar'],
  series: ['create', 'series'],
  projects: ['create', 'themes'],
  growth: ['channels', 'growth'],
  accounts: ['channels', 'accounts'],
  transparency: ['channels', 'trust'],
  money: ['money', 'totals'],
  analytics: ['money', 'analytics'],
  ads: ['money', 'ads'],
  products: ['money', 'products'],
  settings: ['settings', 'main'],
  logs: ['settings', 'logs'],
};

/** Разбирает адрес вида #/money/ads в раздел и вкладку. Никогда не падает. */
export function resolveRoute(hash = '') {
  const raw = String(hash || '').replace(/^#\/?/, '').split('?')[0].replace(/\/+$/, '');
  if (!raw) return { section: 'today', tab: 'today', known: true };

  const [head, second] = raw.split('/');
  const section = SECTIONS.find((s) => s.id === head);
  if (section) {
    const tab = section.tabs.some((t) => t.id === second) ? second : section.tabs[0].id;
    return { section: section.id, tab, known: true };
  }

  const legacy = LEGACY[head];
  if (legacy) return { section: legacy[0], tab: legacy[1], known: false };

  return { section: 'today', tab: 'today', known: false };
}

/** Адрес для раздела и вкладки — единый формат во всём интерфейсе. */
export const routeHash = (section, tab) => (tab && tab !== SECTIONS.find((s) => s.id === section)?.tabs[0]?.id
  ? `#/${section}/${tab}`
  : `#/${section}`);

export const sectionById = (id) => SECTIONS.find((s) => s.id === id) || SECTIONS[0];
