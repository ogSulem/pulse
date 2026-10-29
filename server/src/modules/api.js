import express from 'express';
import { db, getSettings, setSettings, nowIso } from '../core/db.js';
import { enqueue, jobStats, drain, requeueDead, recoverStale } from '../core/queue.js';
import { log, recentLogs } from '../core/logger.js';
import { uid, parseJson, clamp, num, slugify, addDays, addMinutes, fmtNum } from '../core/utils.js';
import { FORMAT_LABELS, FORMATS, generateIdeas, hashtagsFor, coverSvg, nicheFor, riskScore, NICHES_LIST } from '../engine/brain.js';
import { createEpisode, nextSlot, nextSlotPlan, pickAccount, platformQuota, collectAnalytics, sweepDueEpisodes, recoverEpisodeStates, touchEpisode } from '../engine/pipeline.js';
import { scheduleInsights, bestHours, planSlot, upcomingSlots, localParts } from '../engine/schedule.js';
import { forecastEpisode, projectHealth, autopilotPolicy, rankEpisodes, recalculateAccountQuality } from '../engine/forecast.js';
import { evaluateAB, abSummary, preferredVariant } from '../engine/abtest.js';
import {
  adsOverview, campaignRow, campaignStats, createBrand, createCampaign, updateCampaign,
  payCampaign, attachCampaign, pickCampaign, autofillCampaigns, disclosureFor, decorateCaption,
} from '../engine/ads.js';
import { providers } from '../providers/index.js';
import { moneySummary, transparency, recordClick, recordConversion, simulateTraffic, rpmFor } from '../engine/money.js';
import {
  portfolio, accountPlaybook, trendRadar, hookLab, retentionPlan, monetizationPlan, publishGate,
  contentPlan, platformKnowledge, platformAudit, PLATFORM_PLAYBOOK,
} from '../engine/growth.js';
import { checkCompliance, PLATFORM_RULES, disclosureText, saveCompliance } from '../engine/compliance.js';
import { PLATFORM_LABELS, PLATFORM_API_LIMITS, PLATFORMS } from '../engine/limits.js';
import { studio, buildPackage, promotionDecision, PROMO_SHARE } from '../engine/creative.js';
import { encryptSecret, decryptSecret, maskSecret } from '../core/secrets.js';
import { scoreViral, saveViral, recalibrate } from '../engine/viral.js';
import { renderInfo, renderAvailable, MEDIA_DIR } from '../engine/render.js';
import {
  seriesOverview, genres as seriesGenres, listSeries, getSeries, createSeries, updateSeries, rebuildBible,
  planSeasonFor, composeEpisode, listEpisodes, getEpisode, updateEpisode, synthesizeEpisode, renderEpisodeById,
  recomposeEpisode, planEpisodeCuts, renderEpisodeCuts, publishEpisodeToYoutube, economics as seriesEconomicsView,
  refreshSeriesMetrics, pushCutsToQueue, scheduleEpisode,
} from '../engine/series.js';
import { buildEpisode } from '../engine/serial.js';
import fs from 'node:fs';
import path from 'node:path';
import { checkPassword, issueToken, verifyToken } from './auth.js';
import { oauthStatus, startFlow, finishFlow } from '../engine/oauth.js';
import { boot } from '../core/boot.js';
import { framesStatus } from '../engine/frames.js';
import { status as aiStatus } from '../providers/llm.js';
import { checkLink, withUtm } from '../engine/linkcheck.js';

export const api = express.Router();

const STATUS_LABELS = {
  queued: 'В очереди', generating: 'В генерации', review: 'На проверке',
  scheduled: 'Запланирован', published: 'Опубликован', failed: 'Ошибка', paused: 'Пауза',
};
const STAGE_LABELS = {
  idea: 'Идея', script: 'Сценарий', voice: 'Озвучка', footage: 'Видео',
  edit: 'Монтаж', ready: 'Готов', published: 'Опубликован',
};

const has = (row) => row && Object.keys(row).length > 0;
const projectRow = (p) => p && ({ ...p, autopilot: !!p.autopilot, ab_tests: !!p.ab_tests, archived: !!p.archived });
const episodeRow = (e) => e && ({
  ...e,
  scenes: parseJson(e.scenes, []),
  hashtags: parseJson(e.hashtags, []),
  autopilot: !!e.autopilot,
  ab_test: !!e.ab_test,
  cover_paths: parseJson(e.cover_paths, {}),
  compliance: parseJson(e.compliance, null),
  viral_meta: parseJson(e.viral_meta, null),
  creative: parseJson(e.creative, null),
  statusLabel: STATUS_LABELS[e.status] || e.status,
  stageLabel: STAGE_LABELS[e.stage] || e.stage,
});

function accountRow(a) {
  if (!a) return a;
  const { access_token: token, ...safe } = a;
  // hint = последние 4 знака реального токена; сам токен наружу не уходит никогда
  let hint = null;
  if (token) {
    try { hint = maskSecret(decryptSecret(token)); } catch { hint = '••••'; }
  }
  const expires = a.token_expires_at ? new Date(a.token_expires_at).getTime() : 0;
  a = {
    ...safe,
    persona: parseJson(a.persona, {}),
    has_token: Boolean(token),
    token_hint: hint,
    connected: Boolean(token),
    // понятное состояние вместо «connected: true» и молчаливых 401
    auth_state: !token ? 'none' : expires && expires < Date.now() ? 'expired' : 'ok',
    refreshable: Boolean(a.refresh_token),
    expires_at: a.token_expires_at || null,
  };
  const day = nowIso().slice(0, 10);
  const used = db.prepare('SELECT used FROM accounts_daily WHERE account_id = ? AND day = ?').get(a.id, day)?.used || 0;
  const settings = getSettings();
  const cap = Math.min(a.daily_limit, num(settings.max_daily_per_account, 3));
  return { ...a, used_today: used, cap, quota_left: Math.max(0, cap - used), load: cap ? Math.round((used / cap) * 100) : 0 };
}

// ─── Health / мета ──────────────────────────────────────────────────────────
api.get('/health', (_req, res) => {
  // frames в healthcheck: по нему видно до запуска серии, пойдёт нейро-ряд
  // или процедурные плашки (и жив ли провайдер картинок)
  res.json({
    ok: true,
    mode: process.env.PULSE_MODE || 'demo',
    uptimeSec: Math.round(process.uptime()),
    queue: jobStats(),
    frames: framesStatus(),
    // ai в healthcheck: видно, что модели реально подключены, даже если панель не открыта
    ai: (() => {
      try {
        const st = aiStatus();
        return { enabled: st.enabled, active: st.active, configured: st.providers.filter((p) => p.configured).length };
      } catch { return { enabled: false, active: null, configured: 0 }; }
    })(),
    version: '1.0.0',
  });
});

api.get('/meta', (_req, res) => {
  res.json({
    formats: FORMATS.map((id) => ({ id, label: FORMAT_LABELS[id] })),
    niches: NICHES_LIST,
    statuses: STATUS_LABELS,
    stages: STAGE_LABELS,
    providers: providers.status(),
  });
});

// ─── Covers (без авторизации: используются как <img src>) ───────────────────
api.get('/covers/:seed', (req, res) => {
  const seed = req.params.seed.replace(/\.svg$/, '');
  const title = String(req.query.title || '').slice(0, 90) || 'Pulse';
  const svg = coverSvg({ title, subtitle: req.query.sub || 'reel', seed, index: num(req.query.i, 0), hot: req.query.hot === '1' });
  res.set('Content-Type', 'image/svg+xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// ─── Публичные маршруты: короткие ссылки и postback ────────────────────────
// Короткая ссылка /t/:token обслуживается в index.js (до SPA-фолбэка),
// потому что она публичная и не должна проходить через авторизацию панели.

// POST /api/postback — уведомление о покупке от CPA-сети или платёжки.
api.post('/postback', (req, res) => {
  const settings = getSettings();
  const key = req.headers['x-pulse-key'] || req.query.key || req.body?.key;
  if (settings.postback_key && key !== settings.postback_key) {
    return res.status(401).json({ error: 'bad_key', message: 'Неверный ключ postback' });
  }
  const { click_id, clickId, token, value, status, external_id: externalId } = req.body || {};
  const result = recordConversion({ clickId: clickId || click_id, token, value, status: status || 'paid', externalId });
  if (!result) return res.status(404).json({ error: 'click_not_found', message: 'Клик не найден — проверьте click_id или token' });
  res.json({ ok: true, conversion: result });
});

// ─── Авторизация ────────────────────────────────────────────────────────────
const loginAttempts = new Map();
api.post('/auth/login', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const bucket = loginAttempts.get(ip) || { n: 0, reset: now + 60000 };
  if (now > bucket.reset) { bucket.n = 0; bucket.reset = now + 60000; }
  if (bucket.n >= 12) return res.status(429).json({ error: 'too_many_attempts', message: 'Слишком много попыток. Подождите минуту.' });
  const { password } = req.body || {};
  if (!checkPassword(password)) {
    bucket.n += 1;
    loginAttempts.set(ip, bucket);
    return res.status(401).json({ error: 'invalid_password', message: 'Неверный пароль' });
  }
  loginAttempts.delete(ip);
  res.json({ token: issueToken(), user: { name: 'Owner', role: 'owner' } });
});

// ─── OAuth каналов ──────────────────────────────────────────────────────────
// Колбэк вызывается браузером с площадки, поэтому он вне авторизации —
// защита в state (одноразовый, 10 минут) и PKCE.
api.get('/oauth/:platform/callback', async (req, res) => {
  const platform = String(req.params.platform || '');
  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    const done = await finishFlow(platform, { code: req.query.code, state: req.query.state, origin });
    log({ level: 'success', actor: 'oauth', action: 'account.connected', entityType: 'account', entityId: done.accountId, message: `@${done.handle} подключён через OAuth` });
    const qs = new URLSearchParams({ connected: done.accountId, handle: String(done.handle || ''), platform });
    return res.redirect(302, `/#/accounts?${qs.toString()}`);
  } catch (err) {
    log({ level: 'error', actor: 'oauth', action: 'oauth.failed', message: String(err.message || err).slice(0, 300) });
    const qs = new URLSearchParams({ error: String(err.message || err).slice(0, 200), platform });
    return res.redirect(302, `/#/accounts?${qs.toString()}`);
  }
});

// ─── Всё ниже требует авторизации ──────────────────────────────────────────
api.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized', message: 'Требуется вход в панель' });
  next();
});

api.get('/auth/me', (_req, res) => res.json({ user: { name: 'Owner', role: 'owner' }, mode: process.env.PULSE_MODE || 'demo' }));

// ─── Bootstrap: один запрос для первого рендера SPA ─────────────────────────
api.get('/bootstrap', (_req, res) => {
  // Режим — это переменная окружения, а не запись в базе: после переезда на live
  // панель должна сразу перестать показывать «демо», даже если база старая.
  const envMode = String(process.env.PULSE_MODE || 'demo') === 'live' ? 'live' : 'demo';
  const settings = { ...getSettings(), mode: envMode };
  const projects = db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY created_at ASC').all().map(projectRow);
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY platform, created_at').all().map(accountRow);
  const products = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
  const counts = db.prepare('SELECT status, COUNT(*) n FROM episodes GROUP BY status').all();
  const byStatus = Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, 0]));
  for (const c of counts) byStatus[c.status] = c.n;
  res.json({
    settings,
    projects,
    accounts,
    products,
    meta: {
      formats: FORMATS.map((id) => ({ id, label: FORMAT_LABELS[id] })),
      statuses: STATUS_LABELS,
      stages: STAGE_LABELS,
      providers: providers.status(),
    },
    pipeline: {
      ...byStatus,
      queue: jobStats(),
      active: db.prepare(`SELECT e.*, p.name project_name FROM episodes e LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.status IN ('queued','generating','review') ORDER BY e.updated_at DESC LIMIT 8`).all().map(episodeRow),
      upcoming: db.prepare(`SELECT e.*, p.name project_name FROM episodes e LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.status = 'scheduled' ORDER BY e.scheduled_at ASC LIMIT 6`).all().map(episodeRow),
    },
    episodes: db.prepare(`SELECT e.*, p.name project_name, p.color project_color FROM episodes e
      LEFT JOIN projects p ON p.id = e.project_id ORDER BY e.updated_at DESC LIMIT 12`).all().map(episodeRow),
    logs: recentLogs({ limit: 14 }),
  });
});

// ─── Проекты ────────────────────────────────────────────────────────────────
api.get('/projects', (_req, res) => {
  const rows = db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY created_at ASC').all().map(projectRow);
  res.json(rows.map((p) => ({ ...p, episodes: db.prepare('SELECT COUNT(*) n FROM episodes WHERE project_id = ?').get(p.id).n })));
});

api.post('/projects', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const niche = String(b.niche || b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'validation', message: 'Укажите название проекта' });
  const id = uid('pr_');
  const ts = nowIso();
  db.prepare(`INSERT INTO projects (id, name, niche, description, product_url, language, tone, format, aspect, duration_sec, autopilot, posts_per_day, ab_tests, color, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'ru', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, niche, String(b.description || ''), String(b.product_url || ''), String(b.tone || 'friendly'),
      FORMATS.includes(b.format) ? b.format : 'problem-solution', String(b.aspect || '9:16'),
      clamp(num(b.duration_sec, 32), 12, 60), b.autopilot === false ? 0 : 1,
      clamp(num(b.posts_per_day, 2), 1, 8), b.ab_tests === false ? 0 : 1,
      String(b.color || 'violet'), ts, ts);

  // «Простой старт»: сразу предлагаем первые темы под нишу
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const ideas = generateIdeas(project, { count: clamp(num(b.seed_ideas, 6), 3, 10) });
  const ins = db.prepare(`INSERT INTO ideas (id, project_id, title, hook, angle, format, tags, score, source, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai', 'new', ?)`);
  for (const i of ideas) ins.run(uid('id_'), id, i.title, i.hook, i.angle, i.format, JSON.stringify(i.tags), i.score, ts);

  log({ level: 'success', actor: 'user', action: 'project.created', entityType: 'project', entityId: id, message: `Проект «${name}» создан, предложено ${ideas.length} тем` });
  const createdIdeas = db.prepare("SELECT * FROM ideas WHERE project_id = ? AND status = 'new' ORDER BY score DESC").all(id);
  res.status(201).json({ ...projectRow(project), ideas: createdIdeas.map((i) => ({ ...i, tags: parseJson(i.tags, []) })) });
});

api.get('/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  res.json(projectRow(p));
});

api.patch('/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const allowed = ['name', 'niche', 'description', 'product_url', 'language', 'tone', 'format', 'aspect', 'duration_sec', 'autopilot', 'posts_per_day', 'ab_tests', 'archived', 'color'];
  const patch = { updated_at: nowIso() };
  for (const key of allowed) {
    if (key in (req.body || {})) patch[key] = typeof req.body[key] === 'boolean' ? (req.body[key] ? 1 : 0) : req.body[key];
  }
  db.prepare(`UPDATE projects SET ${Object.keys(patch).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id: p.id });
  log({ level: 'info', actor: 'user', action: 'project.updated', entityType: 'project', entityId: p.id, message: `Проект «${patch.name || p.name}» обновлён`, meta: Object.keys(patch) });
  res.json(projectRow(db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id)));
});

api.delete('/projects/:id', (req, res) => {
  db.prepare('UPDATE projects SET archived = 1, updated_at = ? WHERE id = ?').run(nowIso(), req.params.id);
  log({ level: 'warn', actor: 'user', action: 'project.archived', entityType: 'project', entityId: req.params.id, message: 'Проект отправлен в архив (данные сохранены)' });
  res.json({ ok: true });
});

// ─── Идеи ───────────────────────────────────────────────────────────────────
const ideaRow = (i) => ({ ...i, tags: parseJson(i.tags, []) });

// Форматы, которые исторически дают лучший средний охват в проекте.
// На них смещается часть новых тем — «похожее на то, что уже заходит».
function bestFormats(projectId, limit = 2) {
  const rows = db.prepare(`SELECT e.format, AVG(pb.views) avg_views
      FROM publications pb JOIN episodes e ON e.id = pb.episode_id
      WHERE pb.project_id = ? AND pb.views > 0
      GROUP BY e.format HAVING COUNT(pb.id) >= 3
      ORDER BY avg_views DESC LIMIT ?`).all(projectId, limit);
  return rows.map((r) => r.format);
}

api.get('/ideas', (req, res) => {
  const { projectId, status } = req.query;
  const where = [];
  const params = [];
  if (projectId) { where.push('project_id = ?'); params.push(projectId); }
  if (status) { where.push('status = ?'); params.push(status); }
  const rows = db.prepare(`SELECT * FROM ideas ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY score DESC, created_at DESC LIMIT 200`).all(...params);
  res.json(rows.map(ideaRow));
});

api.post('/ideas/generate', async (req, res) => {
  const { projectId, count = 6 } = req.body || {};
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'project_not_found' });
  const existing = db.prepare('SELECT title FROM ideas WHERE project_id = ?').all(projectId).map((r) => r.title.toLowerCase());
  const product = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();
  const preferFormats = bestFormats(projectId);
  // «похожие на то, что уже залетело»: темы-лидеры проекта как источник вариаций
  const seedTopics = db.prepare(`SELECT e.topic, SUM(md.views) v
      FROM metrics_daily md JOIN publications pb ON pb.id = md.publication_id
      JOIN episodes e ON e.id = pb.episode_id
      WHERE pb.project_id = ? AND e.topic <> ''
      GROUP BY e.topic ORDER BY v DESC LIMIT 3`).all(projectId).map((r) => r.topic);
  const want = clamp(num(count, 6), 1, 20);
  let ideas = null;
  let source = 'template';
  try {
    const aiContent = await import('../engine/ai.js');
    if (aiContent.available()) {
      const account = db.prepare("SELECT topic, persona FROM accounts WHERE project_id = ? ORDER BY quality DESC LIMIT 1").get(projectId);
      ideas = await aiContent.ideas({
        project, product, count: want, exclude: existing,
        topic: account?.topic || '', persona: account?.persona ? parseJson(account.persona, {}) : null,
      });
      if (ideas?.length) {
        source = 'ai';
        // те же оценки вирусности, что и у шаблонных тем: ИИ не должен попадать
        // в список «без скора», иначе сортировка в UI теряет смысл
        ideas = ideas.map((i) => ({
          ...i,
          score: Math.max(50, Math.min(98, Math.round(60 + (i.hook?.length || 40) / 3 + (i.tags?.length || 0) * 2))),
        }));
      }
    }
  } catch (err) {
    log({ level: 'warn', actor: 'ai', action: 'ideas.ai_failed', message: String(err.message || err).slice(0, 200) });
  }
  if (!ideas?.length) {
    ideas = generateIdeas(project, { count: want, product, exclude: existing, preferFormats, seedTopics });
  }
  const ins = db.prepare(`INSERT INTO ideas (id, project_id, title, hook, angle, format, tags, score, source, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`);
  const ts = nowIso();
  const ids = [];
  for (const i of ideas) {
    const id = uid('id_');
    ids.push(id);
    ins.run(id, projectId, i.title, i.hook, i.angle, i.format, JSON.stringify(i.tags), i.score, source, ts);
  }
  // отдаём ровно то, что легло в базу: с id, статусом и нормализованными тегами.
  // Иначе UI получал объекты без id и React ругался на ключи списка.
  const created = ids.length
    ? db.prepare(`SELECT * FROM ideas WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY score DESC`).all(...ids).map(ideaRow)
    : [];
  log({
    level: 'info', actor: 'engine', action: 'ideas.generated', entityType: 'project', entityId: projectId,
    message: preferFormats.length
      ? `Сгенерировано ${ideas.length} тем — с упором на форматы-лидеры: ${preferFormats.map((f) => FORMAT_LABELS[f] || f).join(', ')}`
      : `Сгенерировано ${ideas.length} новых тем`,
    meta: { count: ideas.length, preferFormats, seedTopics, source },
  });
  res.json({ created: created.length, source, ideas: created });
});

api.patch('/ideas/:id', (req, res) => {
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(req.params.id);
  if (!idea) return res.status(404).json({ error: 'not_found' });
  const patch = {};
  for (const k of ['title', 'hook', 'angle', 'format', 'status', 'score']) if (k in (req.body || {})) patch[k] = req.body[k];
  if (req.body?.tags) patch.tags = JSON.stringify(req.body.tags);
  if (Object.keys(patch).length) {
    db.prepare(`UPDATE ideas SET ${Object.keys(patch).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id: idea.id });
  }
  res.json(ideaRow(db.prepare('SELECT * FROM ideas WHERE id = ?').get(idea.id)));
});

api.post('/ideas/:id/episodes', (req, res) => {
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(req.params.id);
  if (!idea) return res.status(404).json({ error: 'not_found' });
  const episode = createEpisode({ projectId: idea.project_id, ideaId: idea.id, scheduledAt: req.body?.scheduledAt || null });
  log({ level: 'info', actor: 'user', action: 'idea.accepted', entityType: 'idea', entityId: idea.id, message: `Тема «${idea.title}» отправлена в конвейер` });
  res.status(201).json(episodeRow(episode));
});

api.delete('/ideas/:id', (req, res) => {
  db.prepare("UPDATE ideas SET status = 'rejected' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ─── Сценарии ───────────────────────────────────────────────────────────────
api.get('/scripts', (req, res) => {
  const rows = db.prepare(`SELECT * FROM scripts ${req.query.projectId ? 'WHERE project_id = ?' : ''} ORDER BY created_at DESC LIMIT 100`)
    .all(...(req.query.projectId ? [req.query.projectId] : []));
  res.json(rows.map((s) => ({ ...s, scenes: parseJson(s.scenes, []), hashtags: parseJson(s.hashtags, []) })));
});

api.patch('/scripts/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM scripts WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  const patch = {};
  for (const k of ['hook', 'cta', 'caption', 'tone', 'status']) if (k in (req.body || {})) patch[k] = req.body[k];
  if (req.body?.scenes) {
    const scenes = req.body.scenes.map((sc, i) => ({ ...sc, n: i + 1, seconds: clamp(num(sc.seconds, 5), 2, 15) }));
    patch.scenes = JSON.stringify(scenes);
    patch.duration_sec = scenes.reduce((a, b) => a + b.seconds, 0);
  }
  if (req.body?.hashtags) patch.hashtags = JSON.stringify(req.body.hashtags);
  if (Object.keys(patch).length) db.prepare(`UPDATE scripts SET ${Object.keys(patch).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id: s.id });
  log({ level: 'info', actor: 'user', action: 'script.updated', entityType: 'script', entityId: s.id, message: 'Сценарий отредактирован вручную' });
  const updated = db.prepare('SELECT * FROM scripts WHERE id = ?').get(s.id);
  res.json({ ...updated, scenes: parseJson(updated.scenes, []), hashtags: parseJson(updated.hashtags, []) });
});

// ─── Эпизоды ────────────────────────────────────────────────────────────────
api.get('/episodes', (req, res) => {
  const { status, projectId, limit = 60 } = req.query;
  const where = [];
  const params = [];
  if (status && status !== 'all') {
    if (status === 'active') where.push("e.status IN ('queued','generating','review','scheduled')");
    else { where.push('e.status = ?'); params.push(status); }
  }
  if (projectId) { where.push('e.project_id = ?'); params.push(projectId); }
  const rows = db.prepare(`SELECT e.*, p.name project_name, p.color project_color,
      (SELECT COUNT(*) FROM publications pb WHERE pb.episode_id = e.id) pubs,
      (SELECT c.name FROM campaigns c WHERE c.id = e.campaign_id) campaign_name,
      (SELECT b.name FROM campaigns c JOIN brands b ON b.id = c.brand_id WHERE c.id = e.campaign_id) campaign_brand
    FROM episodes e LEFT JOIN projects p ON p.id = e.project_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY COALESCE(e.scheduled_at, e.updated_at) DESC LIMIT ?`).all(...params, clamp(num(limit, 60), 1, 200));
  res.json(rows.map(episodeRow));
});

api.get('/episodes/:id', (req, res) => {
  const e = db.prepare(`SELECT e.*, p.name project_name, p.color project_color FROM episodes e
    LEFT JOIN projects p ON p.id = e.project_id WHERE e.id = ?`).get(req.params.id);
  if (!e) return res.status(404).json({ error: 'not_found' });
  const publications = db.prepare(`SELECT pb.*, a.handle, a.avatar_hue FROM publications pb
    LEFT JOIN accounts a ON a.id = pb.account_id WHERE pb.episode_id = ? ORDER BY pb.variant`).all(e.id)
    .map((p) => ({ ...p, hashtags: parseJson(p.hashtags, []) }));
  const script = e.script_id ? db.prepare('SELECT * FROM scripts WHERE id = ?').get(e.script_id) : null;
  res.json({
    ...episodeRow(e),
    publications,
    script: script ? { ...script, scenes: parseJson(script.scenes, []), hashtags: parseJson(script.hashtags, []) } : null,
    events: recentLogs({ entityId: e.id, limit: 40 }),
  });
});

api.post('/episodes', (req, res) => {
  const { projectId, ideaId, scriptId, scheduledAt, autopilot, title } = req.body || {};
  if (!db.prepare('SELECT 1 x FROM projects WHERE id = ?').get(projectId)) return res.status(404).json({ error: 'project_not_found' });
  const episode = createEpisode({ projectId, ideaId, scriptId, scheduledAt: scheduledAt || nextSlot(projectId), autopilot: autopilot === false ? 0 : 1, title });
  res.status(201).json(episodeRow(episode));
});

api.patch('/episodes/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'not_found' });
  const patch = { updated_at: nowIso() };
  for (const k of ['title', 'description', 'scheduled_at', 'topic', 'format']) if (k in (req.body || {})) patch[k] = req.body[k];
  if ('autopilot' in (req.body || {})) patch.autopilot = req.body.autopilot ? 1 : 0;
  if (req.body?.hashtags) patch.hashtags = JSON.stringify(req.body.hashtags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean));
  if (req.body?.scenes) {
    const scenes = req.body.scenes.map((s, i) => ({ ...s, n: i + 1, seconds: clamp(num(s.seconds, 5), 2, 15) }));
    patch.scenes = JSON.stringify(scenes);
  }
  if (patch.description) patch.risk = riskScore(`${patch.title || e.title} ${patch.description} ${(parseJson(patch.scenes || e.scenes, [])).map((s) => s.text).join(' ')}`);
  db.prepare(`UPDATE episodes SET ${Object.keys(patch).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id: e.id });
  log({ level: 'info', actor: 'user', action: 'episode.updated', entityType: 'episode', entityId: e.id, message: 'Ролик отредактирован перед публикацией', meta: Object.keys(patch) });

  // если сдвинули время публикации — переставляем задачу
  if (patch.scheduled_at && e.status === 'scheduled') {
    db.prepare("UPDATE jobs SET status = 'done' WHERE type = 'episode.publish' AND status = 'pending' AND payload LIKE ?").run(`%${e.id}%`);
    enqueue('episode.publish', { episodeId: e.id }, { delayMs: Math.max(1000, new Date(patch.scheduled_at).getTime() - Date.now()), priority: 2 });
  }
  res.json(episodeRow(db.prepare('SELECT * FROM episodes WHERE id = ?').get(e.id)));
});

api.post('/episodes/:id/action', (req, res) => {
  const e = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'not_found' });
  const action = String(req.body?.action || '');
  const actor = 'user';

  const dropJobs = () => db.prepare("UPDATE jobs SET status = 'done' WHERE status IN ('pending','running') AND payload LIKE ?").run(`%${e.id}%`);

  if (action === 'approve') {
    const scheduledAt = req.body?.scheduledAt || e.scheduled_at || nextSlot(e.project_id);
    touchEpisode(e.id, { status: 'scheduled', scheduled_at: scheduledAt, error: null });
    enqueue('episode.publish', { episodeId: e.id }, { delayMs: Math.max(1800, new Date(scheduledAt).getTime() - Date.now()), priority: 2 });
    log({ level: 'success', actor, action: 'episode.approved', entityType: 'episode', entityId: e.id, message: 'Ролик подтверждён и поставлен в расписание', meta: { scheduledAt } });
  } else if (action === 'publish_now') {
    touchEpisode(e.id, { status: 'scheduled', scheduled_at: nowIso(), error: null, autopilot: 1 });
    enqueue('episode.publish', { episodeId: e.id }, { delayMs: 1200, priority: 1 });
    log({ level: 'success', actor, action: 'episode.publish_now', entityType: 'episode', entityId: e.id, message: 'Публикация запущена вручную сейчас' });
  } else if (action === 'pause') {
    dropJobs();
    touchEpisode(e.id, { status: 'paused', autopilot: 0 });
    log({ level: 'warn', actor, action: 'episode.paused', entityType: 'episode', entityId: e.id, message: 'Ролик снят с конвейера (пауза)' });
  } else if (action === 'resume') {
    const scheduledAt = e.scheduled_at && new Date(e.scheduled_at) > new Date() ? e.scheduled_at : nextSlot(e.project_id);
    touchEpisode(e.id, { status: 'scheduled', autopilot: 1, scheduled_at: scheduledAt });
    enqueue('episode.publish', { episodeId: e.id }, { delayMs: Math.max(1500, new Date(scheduledAt).getTime() - Date.now()), priority: 2 });
    log({ level: 'info', actor, action: 'episode.resumed', entityType: 'episode', entityId: e.id, message: 'Ролик возвращён в конвейер' });
  } else if (action === 'retry') {
    dropJobs();
    touchEpisode(e.id, { status: 'queued', stage: 'idea', progress: 4, error: null, attempts: 0 });
    enqueue('episode.prepare', { episodeId: e.id }, { delayMs: 500, priority: 3 });
    log({ level: 'info', actor, action: 'episode.retry', entityType: 'episode', entityId: e.id, message: 'Повторный запуск конвейера для ролика' });
  } else if (action === 'reschedule') {
    const at = req.body?.scheduledAt;
    if (!at) return res.status(400).json({ error: 'validation', message: 'scheduledAt обязателен' });
    dropJobs();
    touchEpisode(e.id, { status: 'scheduled', scheduled_at: at });
    enqueue('episode.publish', { episodeId: e.id }, { delayMs: Math.max(1000, new Date(at).getTime() - Date.now()), priority: 2 });
    log({ level: 'info', actor, action: 'episode.rescheduled', entityType: 'episode', entityId: e.id, message: `Время публикации изменено`, meta: { at } });
  } else if (action === 'duplicate') {
    const copy = createEpisode({ projectId: e.project_id, ideaId: null, scriptId: e.script_id, scheduledAt: nextSlot(e.project_id), title: `${e.title} (v2)` });
    return res.json({ ok: true, episode: episodeRow(copy) });
  } else {
    return res.status(400).json({ error: 'unknown_action', message: `Неизвестное действие: ${action}` });
  }
  res.json({ ok: true, episode: episodeRow(db.prepare('SELECT * FROM episodes WHERE id = ?').get(e.id)) });
});

api.delete('/episodes/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'not_found' });
  db.prepare("UPDATE jobs SET status = 'done' WHERE status IN ('pending','running') AND payload LIKE ?").run(`%${e.id}%`);
  db.prepare('DELETE FROM episodes WHERE id = ?').run(e.id);
  log({ level: 'warn', actor: 'user', action: 'episode.deleted', entityType: 'episode', entityId: e.id, message: `Ролик «${e.title}» удалён из очереди` });
  res.json({ ok: true });
});

// ─── Конвейер ───────────────────────────────────────────────────────────────
api.post('/pipeline/run', async (req, res) => {
  const { projectId, count = 3, startInMinutes = 3 } = req.body || {};
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'project_not_found' });
  const created = [];
  for (let i = 0; i < clamp(num(count, 3), 1, 10); i++) {
    const idea = db.prepare("SELECT * FROM ideas WHERE project_id = ? AND status = 'new' ORDER BY score DESC LIMIT 1").get(projectId);
    const scheduledAt = i === 0 ? addMinutes(nowIso(), num(startInMinutes, 3)) : nextSlot(projectId);
    created.push(createEpisode({ projectId, ideaId: idea?.id || null, scheduledAt }));
  }
  log({ level: 'success', actor: 'user', action: 'pipeline.run', entityType: 'project', entityId: projectId, message: `Конвейер запущен: ${created.length} ролика в очереди`, meta: { count: created.length } });
  res.status(201).json({ started: created.length, episodes: created.map(episodeRow) });
});

api.get('/pipeline/status', (_req, res) => {
  const counts = db.prepare('SELECT status, COUNT(*) n FROM episodes GROUP BY status').all();
  const byStatus = Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, 0]));
  for (const c of counts) byStatus[c.status] = c.n;
  const stages = db.prepare("SELECT stage, COUNT(*) n FROM episodes WHERE status IN ('queued','generating') GROUP BY stage").all();
  const active = db.prepare(`SELECT e.*, p.name project_name FROM episodes e LEFT JOIN projects p ON p.id = e.project_id
    WHERE e.status IN ('queued','generating','review') ORDER BY e.updated_at DESC LIMIT 8`).all().map(episodeRow);
  const upcoming = db.prepare(`SELECT e.*, p.name project_name FROM episodes e LEFT JOIN projects p ON p.id = e.project_id
    WHERE e.status = 'scheduled' ORDER BY e.scheduled_at ASC LIMIT 6`).all().map(episodeRow);
  res.json({ byStatus, stages, queue: jobStats(), active, upcoming, providers: providers.status() });
});

api.post('/pipeline/drain', async (req, res) => {
  const limit = clamp(num(req.body?.limit, 12), 1, 24);
  // Рендер ролика занимает десятки секунд. Раньше запрос ждал всю пачку и
  // обрывался по таймауту, а интерфейс показывал «обработано 0» — будто ничего
  // не произошло. Теперь отвечаем сразу, а очередь крутится в фоне.
  const before = jobStats();
  if (req.body?.wait) {
    const processed = await drain(limit);
    return res.json({ processed, queue: jobStats(), waited: true });
  }
  const run = drain(limit)
    .then((processed) => {
      log({ level: 'info', actor: 'user', action: 'queue.drain', message: `Очередь прогнана: ${processed} задач`, meta: { processed } });
      return processed;
    })
    .catch((err) => log({ level: 'error', actor: 'user', action: 'queue.drain_failed', message: String(err.message || err) }));
  globalThis.__lastDrain = run;
  res.json({ started: true, limit, queue: before });
});

api.post('/pipeline/requeue', (_req, res) => {
  const n = requeueDead();
  const stale = recoverStale();
  const swept = sweepDueEpisodes();
  const revived = recoverEpisodeStates();
  log({ level: 'info', actor: 'user', action: 'queue.requeue', message: `Перезапуск dead-letter задач: ${n}, восстановлено: ${stale + swept + revived}` });
  res.json({ requeued: n, stale, swept, revived, queue: jobStats() });
});

// ─── Аккаунты ───────────────────────────────────────────────────────────────
api.get('/oauth/status', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  res.json({
    configured: oauthStatus().some((p) => p.configured),
    publicUrl: process.env.PULSE_PUBLIC_URL || '',
    platforms: oauthStatus().map((p) => ({ ...p, redirectUri: p.redirectUri || `${origin}/api/oauth/${p.id}/callback` })),
  });
});

api.get('/oauth/:platform/start', (req, res) => {
  try {
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json(startFlow(req.params.platform, { origin, accountId: req.query.accountId || null }));
  } catch (err) {
    res.status(400).json({ error: 'oauth_not_configured', message: String(err.message || err) });
  }
});

api.get('/accounts', (_req, res) => {
  res.json(db.prepare('SELECT * FROM accounts ORDER BY platform, created_at').all().map(accountRow));
});

api.post('/accounts', (req, res) => {
  const b = req.body || {};
  if (!b.handle) return res.status(400).json({ error: 'validation', message: 'Укажите @handle аккаунта' });
  const id = uid('ac_');
  const ts = nowIso();
  if (b.platform && !['reels', 'tiktok', 'youtube'].includes(b.platform)) {
    return res.status(400).json({ error: 'validation', message: 'Площадка должна быть reels, tiktok или youtube' });
  }
  const platform = b.platform || 'reels';
  const projectId = b.project_id && db.prepare('SELECT id FROM projects WHERE id = ?').get(b.project_id) ? b.project_id : null;
  db.prepare(`INSERT INTO accounts (id, platform, handle, display_name, avatar_hue, status, daily_limit, min_gap_min, window_start, window_end, timezone, quality, notes, project_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, platform, String(b.handle).replace(/^@/, ''), String(b.display_name || b.handle).replace(/^@/, ''),
      num(b.avatar_hue, Math.floor(Math.random() * 360)), String(b.status || 'warmup'),
      clamp(num(b.daily_limit, 3), 1, 10), clamp(num(b.min_gap_min, 90), 15, 720),
      String(b.window_start || '09:00'), String(b.window_end || '23:00'), String(b.timezone || 'Europe/Moscow'),
      clamp(num(b.quality, 70), 0, 100), String(b.notes || ''), projectId, ts, ts);
  log({ level: 'success', actor: 'user', action: 'account.added', entityType: 'account', entityId: id, message: `Аккаунт @${String(b.handle).replace(/^@/, '')} добавлен (${b.platform || 'reels'})` });
  res.status(201).json(accountRow(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)));
});

/**
 * Подключение аккаунта к площадке: токен шифруется и в открытом виде
 * не покидает сервер. Отдаём только факт подключения и ожидаемые права.
 */
api.post('/accounts/:id/connect', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'not_found', message: 'Аккаунт не найден' });
  const token = String(req.body?.token || '').trim();
  const externalId = String(req.body?.externalId || req.body?.external_id || '').trim();
  if (!token) return res.status(400).json({ error: 'validation', message: 'Вставьте access token аккаунта' });
  let encrypted;
  try {
    encrypted = encryptSecret(token);
  } catch (err) {
    return res.status(400).json({ error: 'no_secret', message: err.message });
  }
  db.prepare('UPDATE accounts SET access_token = ?, external_id = ?, token_expires_at = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(encrypted, externalId || account.external_id || null, req.body?.expiresAt || null, 'healthy', nowIso(), account.id);
  log({
    level: 'success', actor: 'user', action: 'account.connected', entityType: 'account', entityId: account.id,
    message: `@${account.handle} подключён к ${PLATFORM_PLAYBOOK[account.platform]?.label || account.platform} (токен зашифрован)`,
    meta: { platform: account.platform, externalId: externalId || null },
  });
  res.json(accountRow(db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id)));
});

api.delete('/accounts/:id/connect', (req, res) => {
  db.prepare('UPDATE accounts SET access_token = NULL, external_id = NULL, updated_at = ? WHERE id = ?').run(nowIso(), req.params.id);
  log({ level: 'warn', actor: 'user', action: 'account.disconnected', entityType: 'account', entityId: req.params.id, message: 'Токен аккаунта удалён' });
  res.json({ ok: true });
});

api.patch('/accounts/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not_found' });
  const patch = { updated_at: nowIso() };
  for (const k of ['handle', 'display_name', 'status', 'daily_limit', 'min_gap_min', 'window_start', 'window_end', 'timezone', 'quality', 'notes', 'blocked_until', 'topic', 'language', 'visual_style']) {
    if (k in (req.body || {})) patch[k] = req.body[k];
  }
  // бренд-привязка: пустая строка = универсальный аккаунт, значение = конкретный проект
  if ('project_id' in (req.body || {})) {
    const pid = req.body.project_id;
    patch.project_id = pid && db.prepare('SELECT id FROM projects WHERE id = ?').get(pid) ? pid : null;
  }
  if ('platform' in (req.body || {}) && ['reels', 'tiktok', 'youtube'].includes(req.body.platform)) patch.platform = req.body.platform;
  if ('persona' in (req.body || {})) patch.persona = JSON.stringify(req.body.persona || {});
  if (patch.status === 'blocked' && !patch.blocked_until) patch.blocked_until = addDays(nowIso(), 7);
  if (patch.status && patch.status !== 'blocked') patch.blocked_until = null;
  db.prepare(`UPDATE accounts SET ${Object.keys(patch).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id: a.id });
  log({
    level: patch.status === 'blocked' ? 'error' : 'info', actor: 'user', action: 'account.updated', entityType: 'account', entityId: a.id,
    message: patch.status === 'blocked' ? `Аккаунт @${a.handle} помечен как заблокированный — нагрузка перераспределена` : `Аккаунт @${a.handle} обновлён`,
    meta: patch,
  });
  res.json(accountRow(db.prepare('SELECT * FROM accounts WHERE id = ?').get(a.id)));
});

api.delete('/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  log({ level: 'warn', actor: 'user', action: 'account.deleted', entityType: 'account', entityId: req.params.id, message: 'Аккаунт удалён' });
  res.json({ ok: true });
});

// ─── Продукты / партнёрские ссылки ──────────────────────────────────────────
api.get('/products', (_req, res) => res.json(db.prepare('SELECT * FROM products ORDER BY created_at DESC').all()));

api.post('/products', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.url) return res.status(400).json({ error: 'validation', message: 'Нужны название и ссылка' });
  const id = uid('pd_');
  const placement = ['video', 'caption', 'both'].includes(b.placement) ? b.placement : 'both';
  db.prepare(`INSERT INTO products (id, name, url, pitch, proof, template, utm_source, utm_medium, utm_campaign, active, placement, always, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, b.name, b.url, String(b.pitch || ''), String(b.proof || ''), String(b.template || 'review'),
      String(b.utm_source || 'reels'), String(b.utm_medium || 'short'), String(b.utm_campaign || slugify(b.name) || 'pulse'),
      b.active === false ? 0 : 1, placement, b.always ? 1 : 0, nowIso());
  log({ level: 'success', actor: 'user', action: 'product.added', entityType: 'product', entityId: id, message: `Продукт «${b.name}» добавлен в продвижение` });
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

api.patch('/products/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const patch = {};
  for (const k of ['name', 'url', 'pitch', 'proof', 'template', 'utm_source', 'utm_medium', 'utm_campaign']) if (k in (req.body || {})) patch[k] = req.body[k];
  if ('placement' in (req.body || {})) {
    patch.placement = ['video', 'caption', 'both'].includes(req.body.placement) ? req.body.placement : 'both';
  }
  if ('always' in (req.body || {})) patch.always = req.body.always ? 1 : 0;
  if ('active' in (req.body || {})) patch.active = req.body.active ? 1 : 0;
  if (Object.keys(patch).length) db.prepare(`UPDATE products SET ${Object.keys(patch).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id: p.id });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(p.id));
});

api.delete('/products/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Проверка ссылки глазами зрителя: GET с сервера, редиректы, таймаут 8 с.
// Возвращает 200 всегда, когда проверка состоялась: «ссылка битая» — это результат,
// а не ошибка запроса. Панель показывает вердикт и ссылку с UTM.
api.post('/products/:id/check', async (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const target = String(req.body?.url || p.url || '').trim();
  if (!target) return res.status(400).json({ error: 'validation', message: 'У продукта нет ссылки' });
  const result = await checkLink(target, { timeoutMs: num(req.body?.timeoutMs, 8000) });
  const link = withUtm(target, { source: p.utm_source, medium: p.utm_medium, campaign: p.utm_campaign });
  // вердикт остаётся в карточке продукта: не нужно проверять заново, чтобы вспомнить,
  // что ссылка сломана — и видно, когда её проверяли в последний раз
  db.prepare('UPDATE products SET link_checked_at = ?, link_status = ?, link_level = ?, link_note = ? WHERE id = ?')
    .run(nowIso(), result.status, result.level, String(result.note || ''), p.id);
  if (result.level !== 'ok') {
    log({
      level: result.level === 'warn' ? 'warn' : 'error', actor: 'user', action: 'product.link_checked',
      entityType: 'product', entityId: p.id,
      message: `Ссылка «${p.name}»: ${result.note}`,
      meta: { status: result.status, level: result.level, ms: result.ms },
    });
  }
  res.json({ ...result, productId: p.id, link, checkedAt: nowIso() });
});

// ─── Реклама: бренды, кампании, маркировка и деньги ─────────────────────────
// ─── Рост: портфель аккаунтов, тренды, хуки, удержание, монетизация ─────────
api.get('/growth/overview', (req, res) => {
  const days = clamp(num(req.query.days, 30), 7, 90);
  let ads = null;
  try { ads = adsOverview(); } catch { ads = null; }
  res.json({
    portfolio: portfolio(),
    trends: trendRadar({ days }),
    monetization: monetizationPlan(),
    ads: ads ? { totals: ads.totals, campaigns: ads.campaigns.length } : null,
    audit: platformAudit(),
    platforms: PLATFORM_PLAYBOOK,
  });
});

// План на неделю: что, во сколько и на какой аккаунт выйдет
api.get('/growth/plan', (req, res) => {
  const days = clamp(num(req.query.days, 7), 1, 28);
  const projectId = req.query.projectId && req.query.projectId !== 'all' ? req.query.projectId : null;
  res.json(contentPlan({ days, projectId }));
});

// База знаний: лимиты, алгоритмы, монетизация — с числами и ссылками на доки площадок
api.get('/growth/knowledge', (_req, res) => {
  res.json(platformKnowledge());
});

// Аудит: что мешает охвату и деньгам прямо сейчас, с действиями
api.get('/growth/audit', (_req, res) => {
  res.json(platformAudit());
});

api.get('/growth/trends', (req, res) => {
  res.json(trendRadar({ days: clamp(num(req.query.days, 30), 7, 90) }));
});

api.get('/growth/hooks', (req, res) => {
  const episode = req.query.episodeId ? db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.query.episodeId) : null;
  const project = req.query.projectId && req.query.projectId !== 'all'
    ? db.prepare('SELECT * FROM projects WHERE id = ?').get(req.query.projectId)
    : episode?.project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(episode.project_id) : null;
  const topic = req.query.topic || episode?.topic || episode?.title || project?.niche || '';
  const platform = String(req.query.platform || 'reels');
  res.json({ ...hookLab({ topic, platform, niche: project?.niche || '' }), episodeId: episode?.id || null });
});

api.post('/growth/retention', (req, res) => {
  const b = req.body || {};
  const episode = b.episodeId ? db.prepare('SELECT * FROM episodes WHERE id = ?').get(b.episodeId) : null;
  const scenes = b.scenes || (episode ? parseJson(episode.scenes, []) : []);
  res.json(retentionPlan({
    scenes,
    title: b.title || episode?.title || '',
    description: b.description ?? episode?.description ?? '',
    platform: b.platform || 'reels',
    durationSec: b.durationSec || null,
    hashtags: b.hashtags || (episode ? parseJson(episode.hashtags, []) : null),
  }));
});

api.get('/growth/monetization', (_req, res) => res.json(monetizationPlan()));

api.get('/growth/playbook/:accountId', (req, res) => {
  const plan = accountPlaybook(req.params.accountId);
  if (!plan) return res.status(404).json({ error: 'not_found', message: 'Аккаунт не найден' });
  res.json(plan);
});

// ─── Студия: движок сам собирает ролик — хук, сцены, описание, обложку ──────
// Возвращает не «один сценарий», а 3 кандидата с оценками и объяснением,
// почему выбран именно этот: охват, удержание, комплаенс.
api.get('/studio/options', (_req, res) => {
  const projects = db.prepare('SELECT id, name, niche, format, duration_sec, tone FROM projects WHERE archived = 0 ORDER BY name').all();
  const products = db.prepare('SELECT id, name, url, pitch, proof, template, active FROM products ORDER BY created_at DESC').all();
  res.json({
    projects,
    products,
    platforms: PLATFORMS.map((p) => ({ id: p, label: PLATFORM_LABELS[p], limits: PLATFORM_API_LIMITS[p] })),
    promoShare: PROMO_SHARE,
  });
});

api.post('/studio', (req, res) => {
  const b = req.body || {};
  const project = b.projectId
    ? db.prepare('SELECT * FROM projects WHERE id = ?').get(b.projectId)
    : db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY created_at LIMIT 1').get();
  if (!project) return res.status(404).json({ error: 'project_not_found', message: 'Сначала создайте проект' });

  const idea = b.ideaId ? db.prepare('SELECT * FROM ideas WHERE id = ?').get(b.ideaId) : null;
  const platform = PLATFORMS.includes(b.platform) ? b.platform : 'reels';
  const durationSec = clamp(num(b.durationSec, project.duration_sec || 30), 12, 90);

  // продажу решает не пользователь, а правило 80/20 — но можно переопределить
  // продажу обычно решает правило 80/20, но человек может переопределить
  const manual = b.promo && b.promo !== 'auto';
  const decision = manual
    ? { intensity: b.promo, product: null, share: 0, reason: b.promo === 'none' ? 'Продажа отключена вручную' : 'Уровень продажи выбран вручную' }
    : promotionDecision({ project });
  const fallbackProduct = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();
  const product = decision.intensity === 'none' ? null
    : (b.productId
      ? db.prepare('SELECT * FROM products WHERE id = ?').get(b.productId)
      : (decision.product || (manual ? fallbackProduct : null)));

  const pack = studio({
    project, idea: idea || {}, product, platform, durationSec,
    promo: decision.intensity, campaign: b.campaignId ? db.prepare('SELECT * FROM campaigns WHERE id = ?').get(b.campaignId) : null,
    count: clamp(num(b.count, 3), 1, 3),
  });
  res.json({
    project: { id: project.id, name: project.name, niche: project.niche },
    platform,
    durationSec,
    promo: { ...decision, product: product ? { id: product.id, name: product.name } : null },
    ...pack,
  });
});

// Поставить готовый пакет в очередь: сцены, описание и паспорт креатива
// сохраняются на эпизоде, чтобы рендер и публикация ничего не придумывали заново.
api.post('/studio/queue', (req, res) => {
  const b = req.body || {};
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(b.projectId);
  if (!project) return res.status(404).json({ error: 'project_not_found' });
  const platform = PLATFORMS.includes(b.platform) ? b.platform : 'reels';
  const promo = ['direct', 'soft', 'none'].includes(b.promo) ? b.promo : 'none';
  // продающий ролик без продукта — это потерянный CTA. Если продукт не выбрали,
  // берём тот, что движок предложил бы сам.
  const product = promo === 'none'
    ? null
    : (b.productId
      ? db.prepare('SELECT * FROM products WHERE id = ?').get(b.productId)
      : (promotionDecision({ project }).product
        || db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get()));

  let pack = b.package;
  if (!pack?.scenes?.length) {
    // клиент мог не передать пакет (например, из плана) — собираем заново
    pack = buildPackage({
      project,
      idea: b.ideaId ? db.prepare('SELECT * FROM ideas WHERE id = ?').get(b.ideaId) : {},
      product, platform, durationSec: clamp(num(b.durationSec, project.duration_sec || 30), 12, 90),
      promo, attempt: 0,
    });
  }

  const scheduledAt = b.scheduledAt || nextSlot(project.id);
  const episode = createEpisode({
    projectId: project.id, ideaId: b.ideaId || null, title: pack.title || null,
    scheduledAt, autopilot: b.autopilot === false ? 0 : 1,
  });
  // фиксируем креатив: сцены = титры, описание = под выбранную площадку
  touchEpisode(episode.id, {
    scenes: JSON.stringify(pack.scenes),
    description: pack.captions?.[platform] || pack.caption || '',
    caption_platform: platform,
    hashtags: JSON.stringify(pack.hashtags || []),
    format: pack.format || project.format,
    topic: pack.topic || pack.title || '',
    product_id: product?.id || null,
    promo,
    creative: JSON.stringify({
      hook: pack.hook, hookScore: pack.hookScore, format: pack.format,
      formatLabel: pack.formatLabel, scores: pack.scores, warnings: pack.warnings,
      alternativeHooks: pack.alternativeHooks, coverText: pack.coverText,
      pinnedComment: pack.pinnedComment, captions: pack.captions,
      product: pack.product,
    }),
  });
  log({
    level: 'info', actor: 'user', action: 'studio.queue', entityType: 'episode', entityId: episode.id,
    message: `Из студии в очередь: «${pack.hook || pack.title}» · ${PLATFORM_LABELS[platform]}`,
    meta: { scores: pack.scores, promo, product: product?.name || null, platform },
  });
  res.status(201).json(episodeRow(db.prepare('SELECT * FROM episodes WHERE id = ?').get(episode.id)));
});

// Пересобрать креатив уже созданного ролика (человек не согласен с хуком/описанием)
api.post('/episodes/:id/package/regenerate', (req, res) => {
  const e = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'not_found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(e.project_id);
  const platform = PLATFORMS.includes(req.body?.platform) ? req.body.platform : (e.caption_platform || 'reels');
  const promo = ['direct', 'soft', 'none'].includes(req.body?.promo) ? req.body.promo : (e.promo || 'none');
  const product = promo === 'none' ? null : (e.product_id ? db.prepare('SELECT * FROM products WHERE id = ?').get(e.product_id) : null);
  const pack = studio({
    project, idea: { title: e.topic || e.title, format: e.format },
    product, platform, durationSec: parseJson(e.scenes, []).reduce((s, x) => s + num(x.seconds, 0), 0) || project.duration_sec,
    promo, count: 3,
  });
  const best = pack.best;
  touchEpisode(e.id, {
    scenes: JSON.stringify(best.scenes),
    description: best.captions?.[platform] || best.caption || e.description,
    caption_platform: platform,
    hashtags: JSON.stringify(best.hashtags || []),
    promo,
    creative: JSON.stringify({
      hook: best.hook, hookScore: best.hookScore, format: best.format, formatLabel: best.formatLabel,
      scores: best.scores, warnings: best.warnings, alternativeHooks: best.alternativeHooks,
      coverText: best.coverText, pinnedComment: best.pinnedComment, captions: best.captions, product: best.product,
    }),
    risk: riskScore(`${best.title} ${best.caption}`),
  });
  log({
    level: 'info', actor: 'user', action: 'studio.regenerate', entityType: 'episode', entityId: e.id,
    message: `Креатив пересобран: «${best.hook}» · скор ${best.scores.total}/100`,
  });
  res.json({ episode: episodeRow(db.prepare('SELECT * FROM episodes WHERE id = ?').get(e.id)), candidates: pack.candidates, guidance: pack.guidance });
});

api.get('/episodes/:id/gate', (req, res) => {
  const gate = publishGate(req.params.id);
  if (!gate) return res.status(404).json({ error: 'not_found', message: 'Ролик не найден' });
  res.json(gate);
});

api.get('/ads/overview', (_req, res) => {
  res.json(adsOverview());
});

api.get('/brands', (_req, res) => res.json(db.prepare('SELECT * FROM brands ORDER BY created_at DESC').all()));

api.post('/brands', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'validation', message: 'Нужно название бренда' });
  const brand = createBrand({
    name: b.name, legalName: b.legalName || b.legal_name || '', inn: b.inn || '',
    contact: b.contact || '', notes: b.notes || '',
  });
  res.status(201).json(brand);
});

api.get('/campaigns', (_req, res) => {
  const rows = db.prepare(`SELECT c.*, b.name brand_name, b.legal_name, b.inn, p.name project_name
    FROM campaigns c JOIN brands b ON b.id = c.brand_id LEFT JOIN projects p ON p.id = c.project_id
    ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, c.ends_at IS NULL, c.ends_at ASC`).all();
  res.json(rows.map((c) => ({ ...campaignRow(c), stats: campaignStats(c.id) })));
});

api.get('/campaigns/:id', (req, res) => {
  const c = db.prepare(`SELECT c.*, b.name brand_name, b.legal_name, b.inn FROM campaigns c
    JOIN brands b ON b.id = c.brand_id WHERE c.id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'not_found', message: 'Кампания не найдена' });
  const posts = db.prepare(`SELECT cp.*, e.title, e.status episode_status, pb.url, pb.platform
    FROM campaign_posts cp LEFT JOIN episodes e ON e.id = cp.episode_id
    LEFT JOIN publications pb ON pb.id = cp.publication_id
    WHERE cp.campaign_id = ? ORDER BY cp.created_at DESC`).all(c.id);
  const episodes = db.prepare(`SELECT id, title, status, scheduled_at FROM episodes
    WHERE campaign_id = ? ORDER BY created_at DESC LIMIT 20`).all(c.id);
  res.json({ ...campaignRow(c), stats: campaignStats(c.id), posts, episodes, disclosure: disclosureFor(c) });
});

api.post('/campaigns', (req, res) => {
  try {
    const campaign = createCampaign(req.body || {});
    res.status(201).json({ ...campaignRow(campaign), stats: campaignStats(campaign.id) });
  } catch (err) {
    res.status(400).json({ error: 'validation', message: String(err.message || err) });
  }
});

api.patch('/campaigns/:id', (req, res) => {
  try {
    const campaign = updateCampaign(req.params.id, req.body || {});
    res.json({ ...campaignRow(campaign), stats: campaignStats(campaign.id) });
  } catch (err) {
    res.status(400).json({ error: 'validation', message: String(err.message || err) });
  }
});

api.delete('/campaigns/:id', (req, res) => {
  // сначала снимаем спонсора с роликов, иначе останутся висящие ссылки и старая маркировка
  db.prepare("UPDATE episodes SET campaign_id = NULL, ad_disclosure = '' WHERE campaign_id = ?").run(req.params.id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  log({ level: 'info', actor: 'user', action: 'campaign.deleted', entityType: 'campaign', entityId: req.params.id, message: 'Кампания удалена' });
  res.json({ ok: true });
});

api.post('/campaigns/:id/pay', (req, res) => {
  try {
    const amount = req.body?.amount;
    if (!amount) return res.status(400).json({ error: 'validation', message: 'Нужна сумма оплаты' });
    const campaign = payCampaign(req.params.id, amount);
    res.json({ ok: true, ...campaignRow(campaign), stats: campaignStats(campaign.id) });
  } catch (err) {
    res.status(400).json({ error: 'validation', message: String(err.message || err) });
  }
});

api.post('/campaigns/:id/attach', (req, res) => {
  try {
    const episodeId = req.body?.episodeId || req.body?.episode_id;
    if (!episodeId) return res.status(400).json({ error: 'validation', message: 'Нужен episodeId' });
    const result = attachCampaign(episodeId, req.params.id, { force: Boolean(req.body?.force) });
    res.json({ ok: true, ...result, stats: campaignStats(req.params.id) });
  } catch (err) {
    res.status(400).json({ error: 'validation', message: String(err.message || err) });
  }
});

api.delete('/episodes/:id/campaign', (req, res) => {
  attachCampaign(req.params.id, null);
  res.json({ ok: true });
});

api.post('/ads/autofill', (req, res) => {
  const filled = autofillCampaigns({ limit: clamp(num(req.body?.limit, 5), 1, 20) });
  res.json({ ok: true, filled, pick: pickCampaign({})?.campaign?.name || null });
});

api.get('/episodes/:id/campaign', (req, res) => {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'not_found' });
  const campaign = episode.campaign_id ? db.prepare(`SELECT c.*, b.name brand_name, b.legal_name, b.inn
    FROM campaigns c JOIN brands b ON b.id = c.brand_id WHERE c.id = ?`).get(episode.campaign_id) : null;
  res.json({
    campaign: campaign ? { ...campaignRow(campaign), stats: campaignStats(campaign.id) } : null,
    disclosure: campaign ? disclosureFor(campaign) : '',
    preview: campaign ? decorateCaption(episode.description || '', campaign) : (episode.description || ''),
  });
});

// ─── Интеллект: когда публиковать, сколько это принесёт, что выиграл A/B ────
api.get('/insights/schedule', (req, res) => {
  const projectId = req.query.projectId && req.query.projectId !== 'all' ? req.query.projectId : null;
  const project = projectId ? db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) : null;
  const target = project || db.prepare('SELECT * FROM projects WHERE archived = 0 LIMIT 1').get();
  res.json({
    ...scheduleInsights({ days: clamp(num(req.query.days, 45), 7, 120) }),
    plan: target ? planSlot(target.id) : null,
    upcoming: upcomingSlots(6).map((u) => ({ ...u, localTime: `${String(localParts(new Date(u.scheduled_at), getSettings().timezone || 'UTC').hour).padStart(2, '0')}:${String(localParts(new Date(u.scheduled_at), getSettings().timezone || 'UTC').minute).padStart(2, '0')}` })),
  });
});

api.get('/insights/forecast', (req, res) => {
  const episode = req.query.episodeId ? db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.query.episodeId) : null;
  if (!episode) return res.status(404).json({ error: 'not_found', message: 'Ролик не найден' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(episode.project_id);
  const account = episode.account_id ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(episode.account_id) : null;
  res.json(forecastEpisode({ episode, project, account, scheduledAt: episode.scheduled_at }));
});

api.get('/insights/growth', (req, res) => {
  const projects = db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY created_at ASC').all();
  res.json({
    projects: projects.map((p) => ({ projectId: p.id, name: p.name, postsPerDay: p.posts_per_day, ...projectHealth(p.id, { days: clamp(num(req.query.days, 14), 3, 90) }) })),
    ab: abSummary(),
    accounts: recalculateAccountQuality({ apply: false }),
    ranked: rankEpisodes({ limit: 8 }).map((r) => ({ episodeId: r.episodeId, title: r.title, status: r.status, profit: r.forecast.profit, roi: r.forecast.roi, views: r.forecast.expectedViews })),
  });
});

api.post('/insights/apply-policy', (_req, res) => {
  const result = autopilotPolicy({ apply: true });
  res.json({ ok: true, projects: result.map((p) => ({ projectId: p.projectId, name: p.name, postsPerDay: p.postsPerDay, changed: p.changed, action: p.health.action, reason: p.health.reason })) });
});

api.get('/abtest/summary', (req, res) => {
  const projectId = req.query.projectId && req.query.projectId !== 'all' ? req.query.projectId : null;
  res.json({ ...abSummary({ projectId }), preferred: projectId ? preferredVariant(projectId) : null });
});

api.post('/insights/recalibrate', (_req, res) => {
  const result = recalibrate();
  res.json({ ok: true, ...result });
});

api.post('/abtest/evaluate', (_req, res) => {
  const decided = evaluateAB();
  res.json({ ok: true, decided: decided.length, results: decided.map((d) => ({ episodeId: d.episodeId, title: d.title, winner: d.winner, lift: d.lift, ctrA: d.ctrA, ctrB: d.ctrB })) });
});

// ─── Аналитика ──────────────────────────────────────────────────────────────
api.get('/analytics/overview', (req, res) => {
  const days = clamp(num(req.query.days, 14), 3, 90);
  const projectId = req.query.projectId && req.query.projectId !== 'all' ? req.query.projectId : null;
  const since = addDays(nowIso(), -days).slice(0, 10);
  const today = nowIso().slice(0, 10);

  const pubsFilter = projectId ? 'AND pb.project_id = ?' : '';
  const params = projectId ? [projectId] : [];

  // Дневные ряды
  const series = db.prepare(`SELECT md.day,
      SUM(md.views) views, SUM(md.likes) likes, SUM(md.comments) comments, SUM(md.shares) shares,
      SUM(md.clicks) clicks, SUM(md.followers) followers
    FROM metrics_daily md JOIN publications pb ON pb.id = md.publication_id
    WHERE md.day >= ? AND md.day <= ? ${pubsFilter}
    GROUP BY md.day ORDER BY md.day ASC`).all(since, today, ...params);

  const dayMap = new Map(series.map((s) => [s.day, s]));
  const filled = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(nowIso(), -i).slice(0, 10);
    const row = dayMap.get(day) || { day, views: 0, likes: 0, comments: 0, shares: 0, clicks: 0, followers: 0 };
    filled.push({ ...row, label: day.slice(5).replace('-', '.') });
  }

  const totals = filled.reduce((acc, d) => ({
    views: acc.views + d.views, likes: acc.likes + d.likes, comments: acc.comments + d.comments,
    shares: acc.shares + d.shares, clicks: acc.clicks + d.clicks, followers: acc.followers + d.followers,
  }), { views: 0, likes: 0, comments: 0, shares: 0, clicks: 0, followers: 0 });

  const published = db.prepare(`SELECT COUNT(*) n FROM publications pb WHERE pb.published_at >= ? ${pubsFilter}`)
    .get(addDays(nowIso(), -days), ...params).n;

  // Сравнение с предыдущим периодом
  const prevSince = addDays(nowIso(), -days * 2).slice(0, 10);
  const prevUntil = addDays(nowIso(), -days).slice(0, 10);
  const prev = db.prepare(`SELECT COALESCE(SUM(md.views),0) views, COALESCE(SUM(md.clicks),0) clicks, COALESCE(SUM(md.followers),0) followers
    FROM metrics_daily md JOIN publications pb ON pb.id = md.publication_id
    WHERE md.day >= ? AND md.day < ? ${pubsFilter}`).get(prevSince, prevUntil, ...params);

  const pct = (cur, before) => (before > 0 ? Math.round(((cur - before) / before) * 1000) / 10 : cur > 0 ? 100 : 0);

  const byProject = db.prepare(`SELECT p.id, p.name, p.color,
      COUNT(DISTINCT pb.id) posts, COUNT(DISTINCT pb.episode_id) episodes,
      COALESCE(SUM(md.views),0) views, COALESCE(SUM(md.clicks),0) clicks, COALESCE(SUM(md.followers),0) followers
    FROM metrics_daily md
    JOIN publications pb ON pb.id = md.publication_id
    JOIN projects p ON p.id = pb.project_id
    WHERE md.day >= ? AND md.day <= ?
    GROUP BY p.id ORDER BY SUM(md.views) DESC`).all(since, today);

  const byFormat = db.prepare(`SELECT COALESCE(e.format, 'unknown') format, COUNT(DISTINCT pb.id) posts,
      COALESCE(SUM(md.views),0) views, COALESCE(AVG(md.views),0) avg_day_views
    FROM metrics_daily md
    JOIN publications pb ON pb.id = md.publication_id
    JOIN episodes e ON e.id = pb.episode_id
    WHERE md.day >= ? AND md.day <= ? ${projectId ? 'AND pb.project_id = ?' : ''}
    GROUP BY e.format ORDER BY SUM(md.views) DESC`).all(since, today, ...params)
    .map((r) => ({ ...r, label: FORMAT_LABELS[r.format] || r.format, avg_views: Math.round(r.views / Math.max(1, r.posts)) }));

  const byTheme = db.prepare(`SELECT e.topic theme, COALESCE(e.format,'unknown') format, COUNT(DISTINCT pb.id) posts,
      COALESCE(SUM(md.views),0) views, COALESCE(SUM(md.clicks),0) clicks
    FROM metrics_daily md
    JOIN publications pb ON pb.id = md.publication_id
    JOIN episodes e ON e.id = pb.episode_id
    WHERE md.day >= ? AND md.day <= ? ${projectId ? 'AND pb.project_id = ?' : ''}
    GROUP BY e.topic ORDER BY SUM(md.views) DESC LIMIT 8`).all(since, today, ...params)
    .map((r) => ({ ...r, avg_views: Math.round(r.views / Math.max(1, r.posts)) }));

  const top = db.prepare(`SELECT pb.id, pb.title, pb.platform, pb.variant, pb.cover_seed, pb.url, pb.published_at,
      pb.account_id, e.topic, e.format, p.name project_name, a.handle,
      COALESCE(SUM(md.views),0) views, COALESCE(SUM(md.clicks),0) clicks,
      COALESCE(SUM(md.likes),0) likes, COALESCE(SUM(md.shares),0) shares
    FROM metrics_daily md
    JOIN publications pb ON pb.id = md.publication_id
    JOIN episodes e ON e.id = pb.episode_id
    LEFT JOIN projects p ON p.id = pb.project_id
    LEFT JOIN accounts a ON a.id = pb.account_id
    WHERE md.day >= ? AND md.day <= ? ${projectId ? 'AND pb.project_id = ?' : ''}
    GROUP BY pb.id ORDER BY SUM(md.views) DESC LIMIT 6`).all(since, today, ...params)
    .map((p) => ({ ...p, hashtags: [], ctr: p.views ? Math.round((p.clicks / p.views) * 1000) / 10 : 0 }));

  // A/B-тесты: сравниваем варианты одного эпизода по просмотрам за период
  const ab = db.prepare(`SELECT pb.episode_id, e.title,
      MAX(CASE WHEN pb.variant = 'A' THEN v.views END) a_views,
      MAX(CASE WHEN pb.variant = 'B' THEN v.views END) b_views,
      MAX(CASE WHEN pb.variant = 'A' THEN v.clicks END) a_clicks,
      MAX(CASE WHEN pb.variant = 'B' THEN v.clicks END) b_clicks,
      MAX(CASE WHEN pb.variant = 'A' THEN v.cover_seed END) a_cover,
      MAX(CASE WHEN pb.variant = 'B' THEN v.cover_seed END) b_cover
    FROM publications pb
    JOIN episodes e ON e.id = pb.episode_id
    JOIN (SELECT md.publication_id publication_id, SUM(md.views) views, SUM(md.clicks) clicks, MAX(p2.cover_seed) cover_seed
          FROM metrics_daily md JOIN publications p2 ON p2.id = md.publication_id
          WHERE md.day >= ? AND md.day <= ? GROUP BY publication_id) v ON v.publication_id = pb.id
    ${projectId ? 'WHERE pb.project_id = ?' : ''}
    GROUP BY pb.episode_id HAVING a_views IS NOT NULL AND b_views IS NOT NULL
    ORDER BY (COALESCE(a_views,0) + COALESCE(b_views,0)) DESC LIMIT 6`).all(since, today, ...params);

  res.json({
    days,
    totals: {
      ...totals,
      posts: published,
      avgViews: published ? Math.round(totals.views / published) : 0,
      engagement: totals.views ? Math.round(((totals.likes + totals.comments + totals.shares) / totals.views) * 1000) / 10 : 0,
      ctr: totals.views ? Math.round((totals.clicks / totals.views) * 1000) / 10 : 0,
      viewsChange: pct(totals.views, prev.views),
      clicksChange: pct(totals.clicks, prev.clicks),
      followersChange: pct(totals.followers, prev.followers),
    },
    series: filled,
    byProject,
    byFormat,
    byTheme,
    top,
    intelligence: {
      bestHours: bestHours(projectId ? null : 'reels', 3),
      schedule: scheduleInsights().platforms.map((p) => ({ platform: p.platform, best: p.best, learned: p.learned, samples: p.samples })),
      ab: abSummary({ projectId }),
      weights: (() => {
        const meta = (() => { try { return JSON.parse(getSettings().viral_weights || 'null'); } catch { return null; } })();
        return meta ? { source: 'learned', samples: meta.samples, weights: meta.weights, lift: meta.lift } : { source: 'prior' };
      })(),
    },
    ab: ab.map((r) => {
      const a = r.a_views || 0;
      const b = r.b_views || 0;
      const winner = b > a ? 'B' : 'A';
      const best = Math.max(a, b);
      const worst = Math.min(a, b);
      return { ...r, winner, lift: worst ? Math.round(((best - worst) / worst) * 100) : 0, deltaPct: a ? Math.round(((b - a) / a) * 1000) / 10 : 0 };
    }),
  });
});

api.get('/analytics/publications', (req, res) => {
  const limit = clamp(num(req.query.limit, 60), 1, 300);
  const projectId = req.query.projectId && req.query.projectId !== 'all' ? req.query.projectId : null;
  const rows = db.prepare(`SELECT pb.*, e.topic, e.format, p.name project_name, p.color project_color, a.handle
    FROM publications pb JOIN episodes e ON e.id = pb.episode_id
    LEFT JOIN projects p ON p.id = pb.project_id LEFT JOIN accounts a ON a.id = pb.account_id
    ${projectId ? 'WHERE pb.project_id = ?' : ''}
    ORDER BY pb.published_at DESC LIMIT ?`).all(...(projectId ? [projectId] : []), limit);
  res.json(rows.map((p) => ({
    ...p, hashtags: parseJson(p.hashtags, []),
    ctr: p.views ? Math.round((p.clicks / p.views) * 1000) / 10 : 0,
    engagement: p.views ? Math.round(((p.likes + p.comments + p.shares) / p.views) * 1000) / 10 : 0,
  })));
});

// ─── Логи ───────────────────────────────────────────────────────────────────
api.get('/logs', (req, res) => {
  const limit = clamp(num(req.query.limit, 80), 1, 500);
  const rows = recentLogs({ limit, level: req.query.level, entityId: req.query.entityId });
  const q = String(req.query.q || '').toLowerCase();
  res.json(rows.filter((r) => !q || `${r.message} ${r.action} ${r.actor}`.toLowerCase().includes(q))
    .map((r) => ({ ...r, meta: parseJson(r.meta, {}) })));
});

// ─── Настройки ──────────────────────────────────────────────────────────────
// ─── Деньги: доход, расход, ROI ────────────────────────────────────────────
api.get('/money', (req, res) => {
  const days = clamp(num(req.query.days, 30), 1, 365);
  const projectId = req.query.projectId && req.query.projectId !== 'all' ? req.query.projectId : null;
  if (req.query.simulate === '1') simulateTraffic({ budget: 500 });
  res.json(moneySummary({ days, projectId }));
});

// ─── Живой лимит площадки ──────────────────────────────────────────────────
api.get('/accounts/:id/limit', async (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'not_found' });
  const limit = await providers.stats.limit({ platform: account.platform, account });
  if (!limit) {
    // Локальный ответ должен быть таким же, как у движка: считаем фактические
    // публикации за 24 ч и рабочий потолок Pulse, а не абстрактный лимит API.
    const pq = platformQuota(account.platform);
    return res.json({
      platform: account.platform,
      label: PLATFORM_LABELS[account.platform] || account.platform,
      connected: Boolean(account.access_token),
      limit: { total: pq.cap, used: pq.used, left: pq.left, window_sec: 86400, apiLimit: PLATFORM_API_LIMITS[account.platform].per24h },
      source: 'локальный расчёт',
      note: !account.access_token
        ? 'Подключите токен, чтобы видеть точный остаток из API площадки'
        : account.platform === 'tiktok'
          ? 'TikTok не отдаёт остаток лимита через API: считаем по фактическим публикациям за 24 ч'
          : PLATFORM_API_LIMITS[account.platform].note,
    });
  }
  res.json({ platform: account.platform, connected: true, limit, source: 'api' });
});

// ─── ИИ: кто пишет тексты, ключ живой или нет ───────────────────────────────
api.get('/ai/status', async (_req, res) => {
  const llm = await import('../providers/llm.js');
  res.json(llm.status());
});

api.post('/ai/test', async (_req, res) => {
  try {
    const llm = await import('../providers/llm.js');
    const result = await llm.selfTest();
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(400).json({ ok: false, reason: String(err.message || err) });
  }
});

// Пересобрать тексты серии моделью: сцены, тайминг и фото-ряд не меняются,
// меняется только нарратив — поэтому это безопасная операция «в один клик».
api.post('/series/episodes/:id/ai', async (req, res) => {
  try {
    const { aiComposeEpisode } = await import('../engine/series.js');
    const result = await aiComposeEpisode(req.params.id);
    if (!result) return res.status(409).json({ error: 'ai_unavailable', message: 'ИИ недоступен: нет ключа провайдера или выключен PULSE_AI' });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'ai_compose_failed', message: String(err.message || err) });
  }
});

// ─── Запуск на деньги: одна кнопка и честная проверка адреса ────────────────
// Не «мастер настройки на пять экранов», а две операции, которые действительно
// отделяют «панель показывает данные» от «контент выходит и приносит деньги».
api.post('/launch/start', async (req, res) => {
  try {
    const { startAutopilot } = await import('../engine/launch.js');
    const result = startAutopilot({
      render: req.body?.render === true,
      review: req.body?.review === true,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'launch_failed', message: String(err.message || err) });
  }
});

api.post('/launch/stop', async (_req, res) => {
  try {
    const { stopAutopilot } = await import('../engine/launch.js');
    res.json(stopAutopilot());
  } catch (err) {
    res.status(400).json({ error: 'launch_failed', message: String(err.message || err) });
  }
});

// Проверяем именно сетевой ответ, а не наличие переменной: Instagram тянет
// видео по этому адресу, и «локально открывается» здесь не считается.
api.post('/launch/check-url', async (req, res) => {
  try {
    const { publicUrlCheck } = await import('../engine/launch.js');
    const result = await publicUrlCheck({ url: req.body?.url || null });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(400).json({ ok: false, reason: String(err.message || err) });
  }
});

// ─── Уведомления: суточная сводка в Telegram (бесплатно) ────────────────────
api.get('/notify/status', async (_req, res) => {
  try {
    const notify = await import('../engine/notify.js');
    res.json({ ...notify.notifyConfig(), lastDigestAt: getSettings().last_digest_at || null });
  } catch (err) {
    res.status(400).json({ configured: false, error: String(err.message || err) });
  }
});

api.post('/notify/test', async (_req, res) => {
  try {
    const notify = await import('../engine/notify.js');
    if (!notify.notifyEnabled()) return res.status(400).json({ ok: false, ...notify.notifyConfig() });
    const result = await notify.sendTelegram('Pulse: проверка связи. Сводка будет приходить сюда каждый день.');
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    res.status(400).json({ ok: false, reason: String(err.message || err) });
  }
});

// force=1 — отправить сводку немедленно (кнопка «Отправить сейчас»)
api.post('/notify/digest', async (req, res) => {
  try {
    const notify = await import('../engine/notify.js');
    if (!notify.notifyEnabled()) return res.status(400).json({ ok: false, ...notify.notifyConfig() });
    const result = await notify.sendDigest({ force: req.body?.force === true });
    res.status(result.ok ? 200 : 409).json({ ...result, data: undefined });
  } catch (err) {
    res.status(400).json({ ok: false, reason: String(err.message || err) });
  }
});

// ─── Студия: одно место, где видно «что настроено и что делать дальше» ─────
// Это не дашборд ради дашборда: каждый пункт — действие, без которого контент
// не выйдет или не заработает.
api.get('/studio/overview', (req, res) => {
  const settings = getSettings();
  const mode = String(process.env.PULSE_MODE || 'demo') === 'live' ? 'live' : 'demo';
  const accounts = db.prepare('SELECT * FROM accounts').all();
  const connected = accounts.filter((a) => a.access_token);
  const withTopic = accounts.filter((a) => a.topic);
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const series = db.prepare("SELECT * FROM series WHERE status <> 'archived'").all();
  const episodes = db.prepare('SELECT stage, COUNT(*) n FROM series_episodes GROUP BY stage').all();
  const shorts = db.prepare("SELECT COUNT(*) n FROM episodes WHERE status = 'published'").get().n;
  const oauth = oauthStatus();
  const frames = framesStatus();

  const steps = [
    {
      id: 'account', done: connected.length > 0, weight: 3,
      title: 'Подключить канал',
      text: 'YouTube, TikTok или Instagram. Вход через OAuth одной кнопкой — или вставить токен вручную.',
      action: { label: 'Аккаунты', to: '#/accounts' },
    },
    {
      id: 'topic', done: withTopic.length > 0, weight: 2,
      title: 'Задать тему канала',
      text: 'Тема — это лицо канала: «зомби-истории», «нейро-разборы», «мой продукт». Конвейер пишет под неё.',
      action: { label: 'Открыть аккаунты', to: '#/accounts' },
    },
    {
      id: 'product', done: products.length > 0, weight: 1,
      title: 'Добавить свой продукт',
      text: 'Ссылка, оффер и где показывать: в видео, в описании или везде. Маркировка рекламы ставится сама.',
      action: { label: 'Продукты', to: '#/products' },
    },
    {
      id: 'content', done: series.length > 0 || shorts > 0, weight: 2,
      title: 'Запустить контент',
      text: 'Сериал 8–20 минут с фото-рядом или короткие ролики с автопилотом — на выбор.',
      action: { label: 'Сериалы', to: '#/series' },
    },
    {
      id: 'live', done: mode === 'live', weight: 3,
      title: 'Перейти в live',
      text: 'В demo всё симулируется. Для реальных публикаций нужны PULSE_MODE=live, ключи провайдеров и OAuth-приложения площадок.',
      action: { label: 'Настройки', to: '#/settings' },
    },
  ];
  const totalWeight = steps.reduce((a, s2) => a + s2.weight, 0);
  const doneWeight = steps.filter((s2) => s2.done).reduce((a, s2) => a + s2.weight, 0);

  res.json({
    mode,
    progress: Math.round((doneWeight / totalWeight) * 100),
    steps,
    nextStep: steps.find((s2) => !s2.done) || null,
    stats: {
      accounts: accounts.length,
      connected: connected.length,
      withTopic: withTopic.length,
      products: products.length,
      series: series.length,
      seriesEpisodes: episodes.reduce((a, r) => a + r.n, 0),
      shortsPublished: shorts,
    },
    integrations: {
      frames,
      oauth,
      ai: (() => {
        try { return aiStatus(); } catch { return { enabled: false, providers: [] }; }
      })(),
      providers: providers.status(),
      render: renderInfo(),
      settings: {
        series_frames: settings.series_frames || 'auto',
        series_auto_compose: settings.series_auto_compose ?? '1',
        series_auto_render: settings.series_auto_render ?? '0',
        series_autopublish: settings.series_autopublish ?? '1',
        // состояние «включено ли зарабатывание»: без этих ключей студия врала,
        // показывая чек-лист, но не показывая, идёт ли автопилот прямо сейчас
        autopilot_global: settings.autopilot_global ?? '0',
        manual_review: settings.manual_review ?? '0',
        ads_enabled: settings.ads_enabled ?? '1',
        min_viral_score: settings.min_viral_score ?? '70',
      },
    },
    secrets: {
      passwordIsDefault: !process.env.PULSE_PASSWORD && !boot.passwordCreated,
      publicUrl: process.env.PULSE_PUBLIC_URL || '',
    },
  });
});

// ─── Прозрачность: что сделано, что ждёт человека, какие лимиты ─────────────
api.get('/transparency', (_req, res) => {
  res.json({
    ...transparency(),
    render: renderInfo(),
    frames: framesStatus(),
    platformRules: PLATFORM_RULES,
    endpoints: {
      click: '/t/:token',
      postback: 'POST /api/postback',
      media: '/media/*',
    },
  });
});

// ─── Проверка ролика до публикации (комплаенс + «залетит ли») ──────────────
api.post('/episodes/:id/check', (req, res) => {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'not_found', message: 'Эпизод не найден' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(episode.project_id);
  const settings = getSettings();
  const scenes = parseJson(episode.scenes, []);
  const description = req.body?.description ?? episode.description;
  const hashtags = req.body?.hashtags ?? parseJson(episode.hashtags, []);
  const platform = req.body?.platform || 'reels';
  const compliance = checkCompliance({
    title: episode.title, description, scenes, platform, hashtags,
    adLabel: Number(settings.ad_label) === 1, aiLabel: Number(settings.ai_label) === 1,
  });
  const viral = scoreViral({
    title: episode.title, scenes, description, hashtags,
    targetSec: project?.duration_sec || 30, topic: episode.topic, projectId: episode.project_id,
  });
  // сохраняем результат — проверка должна быть видна в списке и в «Прозрачности»
  saveCompliance(episode.id, compliance);
  saveViral(episode.id, viral);
  touchEpisode(episode.id, { description });
  res.json({ compliance, viral, disclosure: disclosureText({ ad: Boolean(episode.product_id), ai: Number(settings.ai_label) === 1 }) });
});

// ─── Быстрое редактирование описания и тегов перед публикацией ─────────────
api.patch('/episodes/:id/caption', (req, res) => {
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
  if (!episode) return res.status(404).json({ error: 'not_found', message: 'Эпизод не найден' });
  const description = String(req.body?.description ?? episode.description).slice(0, 2400);
  const hashtags = Array.isArray(req.body?.hashtags) ? req.body.hashtags.slice(0, 30) : parseJson(episode.hashtags, []);
  touchEpisode(episode.id, { description, hashtags: JSON.stringify(hashtags) });
  log({ level: 'info', actor: 'user', action: 'episode.caption', entityType: 'episode', entityId: episode.id, message: 'Описание обновлено перед публикацией' });
  res.json({ ok: true, description, hashtags });
});

api.get('/settings', (_req, res) => res.json({ ...getSettings(), providers: providers.status() }));

api.patch('/settings', (req, res) => {
  const allowed = [
    'autopilot_global', 'manual_review', 'risk_threshold', 'max_daily_per_account', 'timezone',
    // площадки
    'tiktok_audited', 'tiktok_privacy', 'youtube_audited', 'ai_label', 'ad_label', 'min_viral_score', 'ads_enabled',
    // деньги и себестоимость
    'currency', 'rpm_reels', 'rpm_tiktok', 'rpm_youtube', 'conv_rate', 'ctr_estimate', 'product_price', 'product_margin',
    'cost_video', 'cost_tts', 'cost_llm', 'cost_render', 'postback_key',
    // честная себестоимость: '1' — считаем по прайсу из настроек, '0' — по факту провайдеров
    'powered_by_me',
  ];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = String(req.body[k]);
  const next = setSettings(patch);
  log({ level: 'info', actor: 'user', action: 'settings.updated', entityType: 'settings', message: 'Настройки конвейера изменены', meta: patch });
  res.json(next);
});

// ─── Экспорт / бэкап ────────────────────────────────────────────────────────
const csvEscape = (v) => {
  const s = v == null ? '' : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows, columns) => {
  const head = columns.map((c) => c.title).join(';');
  const body = rows.map((r) => columns.map((c) => csvEscape(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(';')).join('\n');
  return '\uFEFF' + head + '\n' + body;
};

api.get('/export/:type', (req, res) => {
  const type = req.params.type.replace(/\.csv$/, '');
  const stamp = nowIso().slice(0, 10);
  let csv = '';
  if (type === 'ideas') {
    csv = toCsv(db.prepare('SELECT i.*, p.name project FROM ideas i LEFT JOIN projects p ON p.id = i.project_id ORDER BY i.created_at DESC').all(), [
      { title: 'ID', value: 'id' }, { title: 'Проект', value: 'project' }, { title: 'Тема', value: 'title' },
      { title: 'Хук', value: 'hook' }, { title: 'Формат', value: 'format' }, { title: 'Оценка', value: 'score' },
      { title: 'Статус', value: 'status' }, { title: 'Создана', value: 'created_at' },
    ]);
  } else if (type === 'episodes') {
    csv = toCsv(db.prepare('SELECT e.*, p.name project FROM episodes e LEFT JOIN projects p ON p.id = e.project_id ORDER BY e.created_at DESC').all(), [
      { title: 'ID', value: 'id' }, { title: 'Проект', value: 'project' }, { title: 'Название', value: 'title' },
      { title: 'Формат', value: 'format' }, { title: 'Статус', value: 'status' }, { title: 'Этап', value: 'stage' },
      { title: 'Риск', value: 'risk' }, { title: 'Публикация', value: 'scheduled_at' }, { title: 'Опубликовано', value: 'published_at' },
      { title: 'Описание', value: (r) => (r.description || '').replace(/\s+/g, ' ') },
    ]);
  } else if (type === 'publications' || type === 'analytics') {
    csv = toCsv(db.prepare(`SELECT pb.*, e.title, e.topic, e.format, p.name project, a.handle FROM publications pb
      JOIN episodes e ON e.id = pb.episode_id LEFT JOIN projects p ON p.id = pb.project_id LEFT JOIN accounts a ON a.id = pb.account_id
      ORDER BY pb.published_at DESC`).all(), [
      { title: 'ID', value: 'id' }, { title: 'Проект', value: 'project' }, { title: 'Ролик', value: 'title' },
      { title: 'Тема', value: 'topic' }, { title: 'Площадка', value: 'platform' }, { title: 'Аккаунт', value: 'handle' },
      { title: 'Вариант', value: 'variant' }, { title: 'Просмотры', value: 'views' }, { title: 'Лайки', value: 'likes' },
      { title: 'Комменты', value: 'comments' }, { title: 'Репосты', value: 'shares' }, { title: 'Клики', value: 'clicks' },
      { title: 'CTR %', value: (r) => (r.views ? Math.round((r.clicks / r.views) * 1000) / 10 : 0) },
      { title: 'Подписчики', value: 'followers' }, { title: 'Опубликовано', value: 'published_at' },
    ]);
  } else if (type === 'scripts') {
    csv = toCsv(db.prepare('SELECT * FROM scripts ORDER BY created_at DESC').all(), [
      { title: 'ID', value: 'id' }, { title: 'Хук', value: 'hook' },
      { title: 'Сцены', value: (r) => parseJson(r.scenes, []).map((s) => `${s.n}. ${s.text} [${s.visual}]`).join(' | ') },
      { title: 'CTA', value: 'cta' }, { title: 'Описание', value: (r) => (r.caption || '').replace(/\s+/g, ' ') },
      { title: 'Хештеги', value: (r) => parseJson(r.hashtags, []).map((t) => '#' + t).join(' ') },
      { title: 'Создан', value: 'created_at' },
    ]);
  } else {
    return res.status(400).json({ error: 'unknown_export', message: 'Доступно: ideas, episodes, scripts, analytics, publications' });
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="pulse-${type}-${stamp}.csv"`);
  res.send(csv);
});

api.get('/backup', (_req, res) => {
  const dump = {
    exported_at: nowIso(),
    version: '1.0.0',
    settings: getSettings(),
    projects: db.prepare('SELECT * FROM projects').all(),
    accounts: db.prepare('SELECT * FROM accounts').all(),
    products: db.prepare('SELECT * FROM products').all(),
    ideas: db.prepare('SELECT * FROM ideas').all(),
    scripts: db.prepare('SELECT * FROM scripts').all(),
    episodes: db.prepare('SELECT * FROM episodes').all(),
    publications: db.prepare('SELECT * FROM publications').all(),
    metrics_daily: db.prepare('SELECT * FROM metrics_daily').all(),
  };
  log({ level: 'info', actor: 'user', action: 'backup.export', message: 'Выгружен полный бэкап данных' });
  res.set('Content-Disposition', `attachment; filename="pulse-backup-${nowIso().slice(0, 10)}.json"`);
  res.json(dump);
});

// ─── Демо-утилиты (полезны на стенде) ───────────────────────────────────────
api.post('/demo/reseed', async (_req, res) => {
  const { reseed } = await import('../seed/seed.js');
  await reseed();
  res.json({ ok: true, message: 'Демо-данные пересозданы' });
});

// ─── Сериалы: длинные истории 10–20 минут ──────────────────────────────────
// Отдельный продукт рядом с короткими роликами: своя библия, сезон, серии,
// фото-ряд 16:9, мид-роллы и публикация в плейлист по порядку.

api.get('/series', (_req, res) => {
  res.json(seriesOverview());
});

api.get('/series/genres', (_req, res) => {
  res.json({ genres: seriesGenres() });
});

api.post('/series', (req, res) => {
  try {
    const series = createSeries({
      title: req.body?.title,
      genre: req.body?.genre,
      premise: req.body?.premise,
      tone: req.body?.tone,
      projectId: req.body?.projectId || req.body?.project_id || null,
      episodesPlanned: req.body?.episodes_planned,
      episodeSec: req.body?.episode_sec,
    });
    res.status(201).json(series);
  } catch (err) {
    res.status(400).json({ error: 'series_create_failed', message: String(err.message || err) });
  }
});

api.get('/series/:id', (req, res) => {
  const series = getSeries(req.params.id);
  if (!series) return res.status(404).json({ error: 'not_found', message: 'Сериал не найден' });
  res.json({ ...series, economics: seriesEconomicsView(req.params.id) });
});

api.patch('/series/:id', (req, res) => {
  try {
    res.json(updateSeries(req.params.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: 'series_update_failed', message: String(err.message || err) });
  }
});

api.post('/series/:id/bible', async (req, res) => {
  try {
    // AI=off в теле — принудительно шаблонная библия (например, для сравнения)
    const useAi = req.body?.ai !== false;
    const rebuilt = rebuildBible(req.params.id, { variant: num(req.body?.variant, 0) });
    if (useAi) {
      const { aiBible } = await import('../engine/series.js');
      const enriched = await aiBible(req.params.id).catch((err) => {
        log({ level: 'warn', actor: 'ai', action: 'series.bible_failed', message: String(err.message || err).slice(0, 200) });
        return null;
      });
      if (enriched) return res.json(enriched);
    }
    res.json(rebuilt);
  } catch (err) {
    res.status(400).json({ error: 'bible_failed', message: String(err.message || err) });
  }
});

api.post('/series/:id/plan', (req, res) => {
  try {
    const plan = planSeasonFor(req.params.id, {
      startAt: req.body?.startAt || null,
      perWeek: clamp(num(req.body?.perWeek, 2), 1, 3),
    });
    res.json({ ok: true, plan, series: getSeries(req.params.id) });
  } catch (err) {
    res.status(400).json({ error: 'plan_failed', message: String(err.message || err) });
  }
});

api.get('/series/:id/episodes', (req, res) => {
  const series = db.prepare('SELECT id FROM series WHERE id = ?').get(req.params.id);
  if (!series) return res.status(404).json({ error: 'not_found', message: 'Сериал не найден' });
  res.json({ episodes: listEpisodes(req.params.id) });
});

api.post('/series/:id/episodes', (req, res) => {
  try {
    const series = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id);
    if (!series) return res.status(404).json({ error: 'not_found', message: 'Сериал не найден' });
    const nextNo = db.prepare('SELECT COALESCE(MAX(episode_no),0)+1 n FROM series_episodes WHERE series_id = ?').get(req.params.id).n;
    const episodeNo = clamp(num(req.body?.episodeNo, nextNo), 1, 12);
    const ep = composeEpisode({
      seriesId: req.params.id,
      episodeNo,
      targetSec: req.body?.targetSec || series.episode_sec,
      variant: num(req.body?.variant, 0),
    });
    res.status(201).json(ep);
  } catch (err) {
    res.status(400).json({ error: 'episode_failed', message: String(err.message || err) });
  }
});

// предпросмотр сценария без сохранения: «покажи, что получится»
api.post('/series/:id/preview', (req, res) => {
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id);
  if (!series) return res.status(404).json({ error: 'not_found', message: 'Сериал не найден' });
  try {
    const ep = buildEpisode({
      series,
      episodeNo: clamp(num(req.body?.episodeNo, 1), 1, 12),
      targetSec: req.body?.targetSec || series.episode_sec,
      variant: num(req.body?.variant, 0),
    });
    res.json(ep);
  } catch (err) {
    res.status(400).json({ error: 'preview_failed', message: String(err.message || err) });
  }
});

api.get('/series/episodes/:id', (req, res) => {
  const ep = getEpisode(req.params.id);
  if (!ep) return res.status(404).json({ error: 'not_found', message: 'Серия не найдена' });
  res.json(ep);
});

api.patch('/series/episodes/:id', (req, res) => {
  try {
    res.json(updateEpisode(req.params.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: 'episode_update_failed', message: String(err.message || err) });
  }
});

api.post('/series/episodes/:id/recompose', (req, res) => {
  try {
    res.json(recomposeEpisode(req.params.id, { variant: req.body?.variant ?? null }));
  } catch (err) {
    res.status(400).json({ error: 'recompose_failed', message: String(err.message || err) });
  }
});

api.post('/series/episodes/:id/voice', async (req, res) => {
  try {
    res.json(await synthesizeEpisode(req.params.id, { voiceId: req.body?.voiceId || null }));
  } catch (err) {
    res.status(400).json({ error: 'voice_failed', message: String(err.message || err) });
  }
});

// Рендер идёт минутами: по умолчанию запускаем в фоне и отдаём job, а с
// ?wait=1 — ждём результат (нужно для проверки и для слабых серий).
api.post('/series/episodes/:id/render', async (req, res) => {
  const id = req.params.id;
  const ep = getEpisode(id);
  if (!ep) return res.status(404).json({ error: 'not_found', message: 'Серия не найдена' });
  const wait = String(req.query.wait || req.body?.wait || '') === '1';
  const task = renderEpisodeById(id).catch((err) => {
    log({ level: 'error', actor: 'series', action: 'episode.render_failed', entityType: 'series_episode', entityId: id, message: String(err.message || err) });
    return { ok: false, message: String(err.message || err) };
  });
  if (!wait) {
    res.status(202).json({ ok: true, accepted: true, message: 'Сборка серии запущена в фоне', episodeId: id });
    return;
  }
  const out = await task;
  if (!out.ok) return res.status(400).json({ error: 'render_failed', message: out.message || 'Сборка не удалась' });
  res.json(out);
});

api.post('/series/episodes/:id/cuts', (req, res) => {
  try {
    res.json({ ok: true, cuts: planEpisodeCuts(req.params.id, { count: num(req.body?.count, 3) }) });
  } catch (err) {
    res.status(400).json({ error: 'cuts_failed', message: String(err.message || err) });
  }
});

// нарезки уходят в общий конвейер: дальше их публикует обычная очередь
api.post('/series/episodes/:id/cuts/queue', (req, res) => {
  try {
    const created = pushCutsToQueue(req.params.id, {
      platform: req.body?.platform || 'reels',
      count: req.body?.count ? num(req.body.count, 3) : null,
    });
    res.status(201).json({ ok: true, queued: created.length, episodes: created });
  } catch (err) {
    res.status(400).json({ error: 'cuts_queue_failed', message: String(err.message || err) });
  }
});

api.post('/series/episodes/:id/cuts/render', async (req, res) => {
  try {
    const cuts = await renderEpisodeCuts(req.params.id);
    res.json({ ok: true, cuts });
  } catch (err) {
    res.status(400).json({ error: 'cuts_render_failed', message: String(err.message || err) });
  }
});

api.post('/series/episodes/:id/schedule', (req, res) => {
  try {
    res.json(scheduleEpisode(req.params.id, { publishAt: req.body?.publishAt || null }));
  } catch (err) {
    res.status(400).json({ error: 'schedule_failed', message: String(err.message || err) });
  }
});

api.post('/series/episodes/:id/publish', async (req, res) => {
  try {
    const out = await publishEpisodeToYoutube(req.params.id, { privacy: req.body?.privacy || null });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: 'publish_failed', message: String(err.message || err) });
  }
});

api.post('/series/metrics/refresh', async (_req, res) => {
  try {
    res.json(await refreshSeriesMetrics());
  } catch (err) {
    res.status(400).json({ error: 'metrics_failed', message: String(err.message || err) });
  }
});

api.get('/series/:id/economics', (req, res) => {
  try {
    res.json(seriesEconomicsView(req.params.id, { targetRub: num(req.query.targetRub, 50000) }));
  } catch (err) {
    res.status(400).json({ error: 'economics_failed', message: String(err.message || err) });
  }
});

api.use((req, res) => res.status(404).json({ error: 'not_found', message: `Нет маршрута ${req.method} ${req.path}` }));
api.use((err, _req, res, _next) => {
  log({ level: 'error', actor: 'api', action: 'api.error', message: String(err.message || err) });
  res.status(500).json({ error: 'server_error', message: String(err.message || 'Внутренняя ошибка') });
});
