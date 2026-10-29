// ─────────────────────────────────────────────────────────────────────────────
// Уведомления в Telegram — бесплатно и без единого рубля.
//
// Зачем: автопилот работает сутками, но владелец не сидит в панели. Без канала
// связи «тихо сломалось» выглядит как «всё хорошо»: закончился ключ, площадка
// отклонила публикацию, квота аккаунта выбрана. Telegram Bot API бесплатен,
// бот создаётся за минуту у @BotFather, токен хранится в .env.
//
// Модуль сознательно ничего не знает про сеть в тестах: fetch подменяется.
// ─────────────────────────────────────────────────────────────────────────────
import { db, getSettings, nowIso, setSettings } from '../core/db.js';
import { log } from '../core/logger.js';
import { num } from '../core/utils.js';

const env = process.env;

export function notifyConfig() {
  const token = env.PULSE_TELEGRAM_BOT_TOKEN || '';
  const chat = env.PULSE_TELEGRAM_CHAT_ID || '';
  return {
    configured: Boolean(token && chat),
    hasToken: Boolean(token),
    hasChat: Boolean(chat),
    note: !token
      ? 'Создайте бота у @BotFather и положите токен в PULSE_TELEGRAM_BOT_TOKEN'
      : !chat
        ? 'Напишите боту любое сообщение и узнайте chat_id: api.telegram.org/bot<token>/getUpdates'
        : 'Уведомления включены',
  };
}

export function notifyEnabled() {
  return notifyConfig().configured;
}

/** Одно сообщение в Telegram. Никогда не бросает: сводка не важнее конвейера. */
export async function sendTelegram(text, { token = null, chat = null, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const cfg = notifyConfig();
  const botToken = token || env.PULSE_TELEGRAM_BOT_TOKEN;
  const chatId = chat || env.PULSE_TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return { ok: false, reason: 'Telegram не настроен', skipped: true };

  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      const reason = data?.description || `Telegram ${res.status}`;
      log({ level: 'warn', actor: 'notify', action: 'telegram.failed', message: String(reason).slice(0, 200) });
      return { ok: false, reason };
    }
    log({ level: 'info', actor: 'notify', action: 'telegram.sent', message: `Уведомление отправлено (${cfg.configured ? 'настроено' : 'тест'})`, meta: { chars: String(text).length } });
    return { ok: true };
  } catch (err) {
    const reason = String(err.message || err).slice(0, 200);
    log({ level: 'warn', actor: 'notify', action: 'telegram.failed', message: reason });
    return { ok: false, reason };
  }
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Суточная сводка: что вышло, сколько просмотров и денег, что ждёт человека,
 * что сломалось. Ровно то, что владелец спросил бы сам.
 */
export function digestData({ hours = 24 } = {}) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const settings = getSettings();

  const published = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(views),0) views, COALESCE(SUM(clicks),0) clicks
      FROM publications WHERE status = 'published' AND published_at >= ?`).get(since);
  const scheduled = db.prepare("SELECT COUNT(*) n FROM episodes WHERE status = 'scheduled'").get().n;
  const review = db.prepare("SELECT COUNT(*) n FROM episodes WHERE status = 'review'").get().n;
  const failedJobs = db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'dead' AND updated_at >= ?").get(since).n;
  const publishedSeries = db.prepare("SELECT COUNT(*) n FROM series_episodes WHERE stage = 'published' AND updated_at >= ?").get(since).n;

  const money = db.prepare(`SELECT COALESCE(SUM(cp.revenue_cents),0) n FROM campaign_posts cp WHERE cp.created_at >= ?`).get(since).n;
  const convs = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(value_cents),0) s FROM conversions WHERE ts >= ?`).get(since);

  const blockers = [];
  if (!db.prepare("SELECT COUNT(*) n FROM accounts WHERE COALESCE(access_token,'') <> ''").get().n) {
    blockers.push('ни один аккаунт не подключён через OAuth');
  }
  if (!db.prepare('SELECT COUNT(*) n FROM products WHERE active = 1').get().n) blockers.push('нет активного продукта');
  if (String(settings.autopilot_global) !== '1') blockers.push('автопилот выключен');

  const deadJobs = db.prepare(`SELECT type, last_error FROM jobs WHERE status = 'dead' ORDER BY updated_at DESC LIMIT 3`).all();

  return {
    since,
    published: published.n,
    views: published.views,
    clicks: published.clicks,
    seriesPublished: publishedSeries,
    scheduled,
    review,
    failedJobs,
    campaignRevenue: money / 100,
    conversions: convs.n,
    conversionRevenue: (convs.s || 0) / 100,
    blockers,
    deadJobs,
  };
}

/** HTML-текст сводки: годится и для Telegram, и для экрана «Прозрачность». */
export function digestText(data = digestData()) {
  const rub = (v) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
  const total = data.campaignRevenue + data.conversionRevenue;
  const lines = [
    '<b>Pulse · сводка за сутки</b>',
    `Вышло роликов: ${data.published}${data.seriesPublished ? `, серий: ${data.seriesPublished}` : ''}`,
    `Просмотры: ${data.views.toLocaleString('ru-RU')} · клики: ${data.clicks.toLocaleString('ru-RU')}`,
    `Деньги: ${rub(total)} (кампании ${rub(data.campaignRevenue)}, продажи ${rub(data.conversionRevenue)})`,
    `В расписании: ${data.scheduled} · на проверке: ${data.review}`,
  ];
  if (data.failedJobs) lines.push(`⚠️ Упало задач: ${data.failedJobs}`);
  if (data.blockers.length) lines.push(`⛔️ Мешает заработать: ${esc(data.blockers.join('; '))}`);
  if (data.deadJobs.length) {
    lines.push('<b>Последние ошибки:</b>');
    for (const j of data.deadJobs) lines.push(`• ${esc(j.type)}: ${esc(String(j.last_error || '').slice(0, 120))}`);
  }
  return lines.join('\n');
}

/** Отправить сводку и запомнить время — чтобы не дублировать при рестартах. */
export async function sendDigest({ fetchImpl = fetch, force = false } = {}) {
  const settings = getSettings();
  const last = settings.last_digest_at ? new Date(settings.last_digest_at).getTime() : 0;
  if (!force && Date.now() - last < 20 * 3600000) return { ok: false, skipped: true, reason: 'сводка уже уходила меньше 20 часов назад' };
  const data = digestData();
  const text = digestText(data);
  const res = await sendTelegram(text, { fetchImpl });
  if (res.ok) setSettings({ last_digest_at: nowIso() });
  return { ...res, text, data };
}

/** Нужно ли отправлять сводку прямо сейчас (вызывается планировщиком). */
export function digestDue({ hour = 10 } = {}) {
  if (!notifyEnabled()) return false;
  const settings = getSettings();
  const last = settings.last_digest_at ? new Date(settings.last_digest_at).getTime() : 0;
  if (Date.now() - last < 20 * 3600000) return false;
  const tzHour = Number(new Date().toLocaleString('en-GB', { timeZone: settings.timezone || 'Europe/Moscow', hour: '2-digit', hour12: false }));
  return tzHour >= num(hour, 10);
}
