export const fmt = (n) => {
  const num = Number(n) || 0;
  if (Math.abs(num) >= 1_000_000) return (num / 1_000_000).toFixed(num >= 10_000_000 ? 0 : 1).replace('.0', '').replace('.', ',') + 'M';
  if (Math.abs(num) >= 1_000) return (num / 1_000).toFixed(num >= 10_000 ? 0 : 1).replace('.0', '').replace('.', ',') + 'K';
  return String(Math.round(num)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
};

export const full = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0));

export const money = (n, currency = '₽', digits = 0) => {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const text = abs >= 1000
    ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(v)
    : new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits ? 2 : 0, maximumFractionDigits: digits ? 2 : 0 }).format(v);
  return `${text} ${currency}`;
};
export const moneyShort = (n, currency = '₽') => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace('.', ',')} млн ${currency}`;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)} тыс ${currency}`;
  return money(v, currency);
};
export const bytes = (n) => {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} ГБ`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} МБ`;
  if (v >= 1024) return `${Math.round(v / 1024)} КБ`;
  return `${v} Б`;
};
export const pct = (n, digits = 1) => `${Number(n || 0).toFixed(digits).replace('.', ',')}%`;

export const signed = (n, suffix = '%') => {
  const v = Number(n || 0);
  return `${v > 0 ? '+' : ''}${String(v.toFixed(1)).replace('.', ',')}${suffix}`;
};

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export const dateShort = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

export const dateFull = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`;
};

export const time = (iso) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
};

export const dateTime = (iso) => (iso ? `${dateShort(iso)}, ${time(iso)}` : '—');

export const relative = (iso) => {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const min = Math.round(abs / 60000);
  const label =
    min < 1 ? 'только что'
      : min < 60 ? `${min} мин`
        : min < 1440 ? `${Math.round(min / 60)} ч`
          : `${Math.round(min / 1440)} дн`;
  if (label === 'только что') return label;
  return future ? `через ${label}` : `${label} назад`;
};

export const durationLabel = (sec) => {
  const s = Math.round(Number(sec) || 0);
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
};

export const plural = (n, one, few, many) => {
  const abs = Math.abs(Number(n) || 0) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
};

export const STATUS_META = {
  queued: { label: 'В очереди', tone: 'muted' },
  generating: { label: 'В генерации', tone: 'accent', pulse: true },
  review: { label: 'На проверке', tone: 'warn' },
  scheduled: { label: 'Запланирован', tone: 'info' },
  published: { label: 'Опубликован', tone: 'success' },
  failed: { label: 'Ошибка', tone: 'danger' },
  paused: { label: 'Пауза', tone: 'muted' },
};

export const ACCOUNT_STATUS = {
  healthy: { label: 'Активен', tone: 'success' },
  warmup: { label: 'Прогрев', tone: 'info' },
  cooldown: { label: 'Охлаждение', tone: 'warn' },
  blocked: { label: 'Заблокирован', tone: 'danger' },
};

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

export const PRODUCT_TEMPLATES = [
  { id: 'review', label: 'Обзор', hint: 'Честный разбор продукта: плюсы, минусы, для кого' },
  { id: 'before-after', label: 'До / после', hint: 'Результат и путь к нему за 30 дней' },
  { id: 'problem-solution', label: 'Проблема → решение', hint: 'Боль аудитории и то, что её закрывает' },
  { id: 'case', label: 'Кейс', hint: 'Было / сделали / получили, с цифрами' },
  { id: 'meme', label: 'Мем / новость', hint: 'Ситуация, в которой все узнают себя' },
];

export const fmtDateTimeLocal = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
