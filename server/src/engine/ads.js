// ─────────────────────────────────────────────────────────────────────────────
// Реклама: бренд-кампании, маркировка и деньги от спонсоров.
//
// Три вещи, без которых «заработок на рекламе» — это переписка в мессенджере:
//   1. кампания как данные: бюджет, модель оплаты (fixed/cpm/cpa/бартер),
//      цель по выходам, окно дат, бриф, обязательный @бренд и хештеги;
//   2. маркировка: erid-токен ОРД + текст «Реклама. <юрлицо>», который
//      подставляется в описание автоматически и проверяется до публикации;
//   3. учёт: сколько выходов сделано, сколько бюджета израсходовано и сколько
//      денег реально пришло — по каждой кампании и по каждому ролику.
//
// Кампании раздаются автоматически: активная кампания с остатком бюджета и
// выходов прикрепляется к следующему ролику проекта. Дневной кэп не даёт
// вывалить все интеграции в один день.
// ─────────────────────────────────────────────────────────────────────────────
import { db, getSettings, nowIso } from '../core/db.js';
import { log } from '../core/logger.js';
import { uid, num, clamp, addDays, parseJson } from '../core/utils.js';

const MODELS = ['fixed', 'cpm', 'cpa', 'barter'];
const STATUSES = ['draft', 'active', 'paused', 'done'];

export const CAMPAIGN_MODEL_LABELS = {
  fixed: 'фикс за ролик',
  cpm: 'за 1000 показов',
  cpa: 'за конверсию',
  barter: 'бартер',
};

const dayKey = (iso) => String(iso || '').slice(0, 10);

export function campaignRow(c) {
  if (!c) return c;
  return {
    ...c,
    hashtags: parseJson(c.hashtags, []),
    modelLabel: CAMPAIGN_MODEL_LABELS[c.model] || c.model,
    budget: round2(c.budget_cents / 100),
    rate: round2(c.rate_cents / 100),
    paid: round2((c.paid_cents || 0) / 100),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Оплата за один выход по модели кампании */
export function revenueFor(campaign, { views = 0, clicks = 0, conversions = 0 } = {}) {
  if (!campaign) return 0;
  const rate = num(campaign.rate_cents, 0);
  if (campaign.model === 'cpm') return Math.round((views / 1000) * rate);
  if (campaign.model === 'cpa') return Math.round(conversions * rate);
  if (campaign.model === 'barter') return 0;
  // fixed: фикс делится между выходами, чтобы сумма по кампании не превысила договор
  const posts = Math.max(1, num(campaign.posts_target, 1));
  return Math.round(rate / posts);
}

/** Текст маркировки рекламы по требованиям ОРД + правила площадок */
export function disclosureFor(campaign, settings = getSettings()) {
  if (!campaign) return '';
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(campaign.brand_id);
  // «ООО «Нордвинд».» — двойная точка выглядит как ошибка, снимаем хвостовую
  const clean = (v) => String(v || '').trim().replace(/[.\s]+$/, '');
  const legal = clean(brand?.legal_name) || clean(brand?.name) || 'рекламодатель';
  const parts = ['Реклама'];
  if (clean(brand?.legal_name)) parts.push(clean(brand.legal_name));
  else parts.push(legal);
  if (brand?.inn) parts.push(`ИНН ${brand.inn}`);
  if (campaign.erid) parts.push(`erid: ${campaign.erid}`);
  const text = parts.join('. ');
  // если маркировка выключена явно (бартер/собственный продукт) — только пометка
  if (campaign.marking === 'none') return 'Реклама';
  if (campaign.marking === 'brand') return `${text}`;
  return text;
}

/** Дополняет описание: бриф-хештеги, @бренд, маркировка. Идемпотентно. */
export function decorateCaption(caption, campaign, settings = getSettings()) {
  if (!campaign) return caption;
  let text = String(caption || '').trim();
  const extras = [];

  const mention = String(campaign.mention || '').trim();
  if (mention && !text.toLowerCase().includes(mention.toLowerCase())) extras.push(mention);

  const brandTags = parseJson(campaign.hashtags, []).filter(Boolean);
  const hasTag = (tag) => new RegExp(`(^|\\s)${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i').test(text);
  const missingTags = brandTags.filter((t) => !hasTag(t));
  if (missingTags.length) extras.push(missingTags.join(' '));

  // пометка «реклама» обязательна для всех моделей, кроме явного «none»
  if (campaign.marking !== 'none' && !/(^|\s)(реклама|ad)(\s|\.|$)/i.test(text)) {
    extras.push('#реклама');
  }

  const disclosure = disclosureFor(campaign, settings);
  if (disclosure && !text.includes(disclosure)) extras.push(disclosure);

  return [text, ...extras.filter(Boolean)].filter(Boolean).join('\n\n');
}

// ── Метрики кампании ────────────────────────────────────────────────────────
export function campaignStats(campaignId) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return null;
  const agg = db.prepare(`SELECT COUNT(*) posts, COUNT(DISTINCT episode_id) episodes,
      COALESCE(SUM(revenue_cents),0) revenue, COALESCE(SUM(views),0) views, COALESCE(SUM(clicks),0) clicks
    FROM campaign_posts WHERE campaign_id = ?`).get(campaignId);
  // расход — только себестоимость роликов, которые реально вышли в этой кампании
  const spend = db.prepare(`SELECT COALESCE(SUM(e.cost_cents),0) c FROM episodes e
    WHERE e.campaign_id = ? AND EXISTS (SELECT 1 FROM campaign_posts cp WHERE cp.episode_id = e.id AND cp.campaign_id = ?)`)
    .get(campaignId, campaignId).c || 0;
  const budget = num(campaign.budget_cents, 0);
  const revenue = agg.revenue || 0;
  const postsLeft = Math.max(0, num(campaign.posts_target, 0) - (agg.posts || 0));
  const budgetLeft = budget > 0 ? Math.max(0, budget - revenue) : null;
  const today = dayKey(nowIso());
  const todayPosts = db.prepare('SELECT COUNT(*) n FROM campaign_posts WHERE campaign_id = ? AND substr(created_at,1,10) = ?')
    .get(campaignId, today).n;
  return {
    campaignId,
    posts: agg.posts || 0,
    episodes: agg.episodes || 0,
    views: agg.views || 0,
    clicks: agg.clicks || 0,
    revenue: round2(revenue / 100),
    paid: round2(num(campaign.paid_cents, 0) / 100),
    receivable: round2(Math.max(0, revenue - num(campaign.paid_cents, 0)) / 100),
    spend: round2(spend / 100),
    profit: round2((revenue - spend) / 100),
    roi: spend > 0 ? Math.round(((revenue - spend) / spend) * 100) : null,
    postsLeft,
    postsTarget: num(campaign.posts_target, 0),
    budgetLeft: budgetLeft === null ? null : round2(budgetLeft / 100),
    todayPosts,
    dailyCap: num(campaign.daily_cap, 1),
    cpm: agg.views > 0 ? round2((revenue / 100) / (agg.views / 1000)) : 0,
    cpc: agg.clicks > 0 ? round2((revenue / 100) / agg.clicks) : 0,
    expired: Boolean(campaign.ends_at && new Date(campaign.ends_at) < new Date()),
    canPost: campaign.status === 'active' && postsLeft > 0
      && (budgetLeft === null || budgetLeft > 0)
      && todayPosts < num(campaign.daily_cap, 1)
      && !(campaign.ends_at && new Date(campaign.ends_at) < new Date())
      && !(campaign.starts_at && new Date(campaign.starts_at) > new Date()),
  };
}

/** Выбор кампании для следующего ролика: активная, с остатком, ближайшая к дедлайну */
export function pickCampaign({ projectId = null } = {}) {
  const rows = db.prepare(`SELECT * FROM campaigns WHERE status = 'active'
      AND (project_id IS NULL OR project_id = ?)
    ORDER BY (ends_at IS NULL), ends_at ASC, created_at ASC`).all(projectId);
  for (const campaign of rows) {
    const stats = campaignStats(campaign.id);
    if (stats?.canPost) return { campaign, stats };
  }
  return null;
}

/** Прикрепить кампанию к ролику (или снять — campaignId = null) */
export function attachCampaign(episodeId, campaignId, { force = false } = {}) {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
  if (!episode) throw new Error('Ролик не найден');
  if (!campaignId) {
    db.prepare("UPDATE episodes SET campaign_id = NULL, ad_disclosure = '', updated_at = ? WHERE id = ?").run(nowIso(), episodeId);
    return { ok: true, campaign: null };
  }
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) throw new Error('Кампания не найдена');
  const stats = campaignStats(campaignId);
  if (!force && !stats.canPost) {
    throw new Error(`Кампания исчерпана: ${stats.postsLeft === 0 ? 'все выходы сделаны' : stats.budgetLeft === 0 ? 'бюджет израсходован' : stats.todayPosts >= stats.dailyCap ? 'дневной лимит выходов' : 'кампания не активна'}`);
  }
  const disclosure = disclosureFor(campaign);
  db.prepare('UPDATE episodes SET campaign_id = ?, ad_disclosure = ?, updated_at = ? WHERE id = ?')
    .run(campaignId, disclosure, nowIso(), episodeId);
  log({
    level: 'info', actor: 'ads', action: 'campaign.attached', entityType: 'episode', entityId: episodeId,
    message: `Ролик привязан к кампании «${campaign.name}»: ${CAMPAIGN_MODEL_LABELS[campaign.model]}${disclosure ? `, маркировка «${disclosure}»` : ''}`,
    meta: { campaignId, model: campaign.model, disclosure },
  });
  return { ok: true, campaign: campaignRow(campaign), disclosure, stats };
}

/** Зафиксировать выход (идемпотентно по паре кампания + публикация) */
export function recordDelivery({ campaignId, episodeId, publicationId = null, views = 0, clicks = 0, conversions = 0 }) {
  if (!campaignId || !episodeId) return null;
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return null;
  const existing = publicationId
    ? db.prepare('SELECT * FROM campaign_posts WHERE campaign_id = ? AND publication_id = ?').get(campaignId, publicationId)
    : db.prepare('SELECT * FROM campaign_posts WHERE campaign_id = ? AND episode_id = ? AND publication_id IS NULL').get(campaignId, episodeId);
  const revenue = revenueFor(campaign, { views, clicks, conversions });
  if (existing) {
    db.prepare('UPDATE campaign_posts SET revenue_cents = ?, views = ?, clicks = ? WHERE id = ?')
      .run(revenue, views, clicks, existing.id);
    return existing.id;
  }
  const id = uid('cp_');
  db.prepare(`INSERT INTO campaign_posts (id, campaign_id, episode_id, publication_id, revenue_cents, views, clicks, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, campaignId, episodeId, publicationId, revenue, views, clicks, nowIso());
  const after = campaignStats(campaignId);
  if (after.posts >= after.postsTarget && campaign.status === 'active') {
    db.prepare("UPDATE campaigns SET status = 'done', updated_at = ? WHERE id = ?").run(nowIso(), campaignId);
    log({ level: 'success', actor: 'ads', action: 'campaign.done', entityType: 'campaign', entityId: campaignId, message: `Кампания «${campaign.name}» выполнена: ${after.posts}/${after.postsTarget} выходов` });
  }
  return id;
}

/** Обновление метрик выходов из фактической аналитики */
export function syncCampaignMetrics() {
  const rows = db.prepare(`SELECT cp.*, pb.views pb_views, pb.clicks pb_clicks, c.model, c.rate_cents, c.posts_target, c.budget_cents,
      (SELECT COUNT(*) FROM conversions v WHERE v.publication_id = cp.publication_id) convs
    FROM campaign_posts cp
    LEFT JOIN publications pb ON pb.id = cp.publication_id
    JOIN campaigns c ON c.id = cp.campaign_id
    ORDER BY cp.created_at ASC`).all();
  let updated = 0;
  // бюджет — потолок начислений: считаем остаток по кампании, чтобы CPA не улетел за контракт
  const left = new Map();
  for (const row of rows) {
    if (!row.publication_id) continue;
    if (!left.has(row.campaign_id)) left.set(row.campaign_id, num(row.budget_cents, 0) || Infinity);
    const views = row.pb_views || 0;
    const clicks = row.pb_clicks || 0;
    let revenue = revenueFor({ model: row.model, rate_cents: row.rate_cents, posts_target: row.posts_target },
      { views, clicks, conversions: row.convs || 0 });
    const remaining = left.get(row.campaign_id);
    if (remaining !== Infinity && revenue > remaining) revenue = Math.max(0, remaining);
    left.set(row.campaign_id, remaining === Infinity ? Infinity : remaining - revenue);
    if (revenue !== row.revenue_cents || views !== row.views) {
      db.prepare('UPDATE campaign_posts SET revenue_cents = ?, views = ?, clicks = ? WHERE id = ?')
        .run(revenue, views, clicks, row.id);
      updated++;
    }
  }
  return updated;
}

/**
 * Автораздача: прикрепляет кампании к роликам, которые ещё не вышли и не имеют
 * спонсора. Работает по одному выходу на кампанию в сутки, не чаще дневного кэпа.
 */
export function autofillCampaigns({ limit = 5 } = {}) {
  const settings = getSettings();
  if (String(settings.ads_enabled ?? '1') !== '1') return [];
  const episodes = db.prepare(`SELECT * FROM episodes
      WHERE campaign_id IS NULL AND status IN ('queued','generating','review','scheduled')
      ORDER BY scheduled_at ASC LIMIT ?`).all(limit);
  const attached = [];
  for (const ep of episodes) {
    const picked = pickCampaign({ projectId: ep.project_id });
    if (!picked) break;
    try {
      attachCampaign(ep.id, picked.campaign.id);
      attached.push({ episodeId: ep.id, campaignId: picked.campaign.id, name: picked.campaign.name });
    } catch { /* кампания закончилась между проверками — идём к следующей */ }
  }
  return attached;
}

/** Сводка для экрана «Реклама» */
export function adsOverview() {
  const campaigns = db.prepare(`SELECT c.*, b.name brand_name, b.legal_name, b.inn, p.name project_name
    FROM campaigns c JOIN brands b ON b.id = c.brand_id
    LEFT JOIN projects p ON p.id = c.project_id
    ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, c.ends_at IS NULL, c.ends_at ASC`).all();

  const rows = campaigns.map((c) => ({ ...campaignRow(c), stats: campaignStats(c.id) }));
  const active = rows.filter((r) => r.status === 'active');
  const revenue = rows.reduce((a, r) => a + (r.stats.revenue || 0), 0);
  const paid = rows.reduce((a, r) => a + (r.stats.paid || 0), 0);
  const spend = rows.reduce((a, r) => a + (r.stats.spend || 0), 0);
  const budget = rows.reduce((a, r) => a + (r.budget || 0), 0);
  const views = rows.reduce((a, r) => a + (r.stats.views || 0), 0);
  const missingErid = rows.filter((r) => r.marking === 'erid' && !r.erid && r.status !== 'done');

  return {
    campaigns: rows,
    totals: {
      active: active.length,
      all: rows.length,
      revenue: round2(revenue),
      paid: round2(paid),
      receivable: round2(Math.max(0, revenue - paid)),
      spend: round2(spend),
      profit: round2(revenue - spend),
      roi: spend > 0 ? Math.round(((revenue - spend) / spend) * 100) : null,
      budget: round2(budget),
      budgetLeft: round2(Math.max(0, budget - revenue)),
      views,
      cpm: views > 0 ? round2(revenue / (views / 1000)) : 0,
      posts: rows.reduce((a, r) => a + (r.stats.posts || 0), 0),
    },
    risks: missingErid.map((r) => ({
      campaignId: r.id, name: r.name,
      text: `Нет erid — публикация с этой кампанией не пройдёт проверку маркировки`,
    })),
    deadlines: rows
      .filter((r) => r.status === 'active' && r.ends_at)
      .sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at))
      .slice(0, 4)
      .map((r) => ({ campaignId: r.id, name: r.name, endsAt: r.ends_at, postsLeft: r.stats.postsLeft, days: Math.ceil((new Date(r.ends_at) - Date.now()) / 86400000) })),
  };
}

// ── CRUD, используемый API и демо-данными ───────────────────────────────────
export function createBrand({ name, legalName = '', inn = '', contact = '', notes = '' }) {
  if (!name) throw new Error('Нужно название бренда');
  const id = uid('br_');
  db.prepare(`INSERT INTO brands (id, name, legal_name, inn, contact, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, legalName, inn, contact, notes, nowIso());
  return db.prepare('SELECT * FROM brands WHERE id = ?').get(id);
}

export function createCampaign(input) {
  // бренд ищется по имени: вторая кампания того же бренда не создаёт дубль юрлица
  const existingBrand = !input.brandId && input.brandName
    ? db.prepare('SELECT * FROM brands WHERE lower(name) = lower(?)').get(String(input.brandName).trim())
    : null;
  const brandId = input.brandId
    || existingBrand?.id
    || (input.brandName ? createBrand({ name: input.brandName, legalName: input.legalName || '', inn: input.inn || '' }).id : null);
  const brand = brandId ? db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId) : null;
  if (!brand) throw new Error('Нужен бренд кампании');
  const model = MODELS.includes(input.model) ? input.model : 'fixed';
  const status = STATUSES.includes(input.status) ? input.status : 'draft';
  const id = uid('cm_');
  const ts = nowIso();
  db.prepare(`INSERT INTO campaigns (id, brand_id, project_id, name, model, budget_cents, rate_cents, posts_target,
      starts_at, ends_at, status, brief, mention, link_url, hashtags, erid, marking, daily_cap, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, brand.id, input.projectId || null, input.name || `Интеграция ${brand.name}`, model,
      Math.round(num(input.budget, 0) * 100), Math.round(num(input.rate, 0) * 100),
      clamp(num(input.postsTarget, 1), 1, 100), input.startsAt || null, input.endsAt || null, status,
      String(input.brief || ''), String(input.mention || ''), String(input.linkUrl || ''),
      JSON.stringify(Array.isArray(input.hashtags) ? input.hashtags : String(input.hashtags || '').split(/[\s,]+/).filter(Boolean)),
      String(input.erid || ''), ['erid', 'brand', 'none'].includes(input.marking) ? input.marking : 'erid',
      clamp(num(input.dailyCap, 1), 1, 10), ts, ts);
  log({
    level: 'success', actor: 'user', action: 'campaign.created', entityType: 'campaign', entityId: id,
    message: `Кампания «${input.name || brand.name}»: ${CAMPAIGN_MODEL_LABELS[model]}, ${clamp(num(input.postsTarget, 1), 1, 100)} выходов`,
    meta: { brand: brand.name, budget: num(input.budget, 0), model },
  });
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
}

export function updateCampaign(id, patch = {}) {
  const current = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!current) throw new Error('Кампания не найдена');
  const fields = {};
  const map = {
    name: 'name', brief: 'brief', mention: 'mention', link_url: 'linkUrl', erid: 'erid',
    project_id: 'projectId', starts_at: 'startsAt', ends_at: 'endsAt',
  };
  for (const [col, key] of Object.entries(map)) if (key in patch) fields[col] = patch[key];
  if ('status' in patch && STATUSES.includes(patch.status)) fields.status = patch.status;
  if ('model' in patch && MODELS.includes(patch.model)) fields.model = patch.model;
  if ('marking' in patch && ['erid', 'brand', 'none'].includes(patch.marking)) fields.marking = patch.marking;
  if ('budget' in patch) fields.budget_cents = Math.round(num(patch.budget, 0) * 100);
  if ('rate' in patch) fields.rate_cents = Math.round(num(patch.rate, 0) * 100);
  if ('postsTarget' in patch) fields.posts_target = clamp(num(patch.postsTarget, 1), 1, 100);
  if ('dailyCap' in patch) fields.daily_cap = clamp(num(patch.dailyCap, 1), 1, 10);
  if ('hashtags' in patch) fields.hashtags = JSON.stringify(Array.isArray(patch.hashtags) ? patch.hashtags : String(patch.hashtags || '').split(/[\s,]+/).filter(Boolean));
  if ('paid' in patch) fields.paid_cents = Math.round(num(patch.paid, 0) * 100);
  if (!Object.keys(fields).length) return current;
  const set = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE campaigns SET ${set}, updated_at = @ts WHERE id = @id`).run({ ...fields, ts: nowIso(), id });
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
}

export function payCampaign(id, amount) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!campaign) throw new Error('Кампания не найдена');
  const cents = Math.round(num(amount, 0) * 100);
  if (!cents) throw new Error('Нужна сумма');
  if (cents < 0) throw new Error('Сумма оплаты должна быть положительной');
  db.prepare('UPDATE campaigns SET paid_cents = paid_cents + ?, updated_at = ? WHERE id = ?').run(cents, nowIso(), id);
  log({
    level: 'success', actor: 'user', action: 'campaign.payment', entityType: 'campaign', entityId: id,
    message: `Оплата по кампании «${campaign.name}»: +${round2(cents / 100)}`, meta: { amount: round2(cents / 100) },
  });
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
}

export const adsUtils = { addDays, dayKey, MODELS, STATUSES };
