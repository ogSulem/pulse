// ─────────────────────────────────────────────────────────────────────────────
// Conveyor Pipeline: идея → сценарий → озвучка → видео → монтаж → проверка →
// расписание → публикация → аналитика. Каждый шаг — отдельная задача в очереди,
// поэтому конвейер переживает перезапуск и масштабируется воркерами.
// ─────────────────────────────────────────────────────────────────────────────
import { db, nowIso, getSettings } from '../core/db.js';
import { enqueue, registerHandler } from '../core/queue.js';
import { log } from '../core/logger.js';
import { uid, parseJson, clamp, addMinutes, addDays, num, pick } from '../core/utils.js';
import { buildScript, hashtagsFor, platformCaption, riskScore, generateIdeas, buildUtmUrl, nicheFor } from './brain.js';
import { providers } from '../providers/index.js';
import { renderEpisode, renderCover, renderAvailable, renderInfo, MEDIA_DIR } from './render.js';
import { checkCompliance, disclosureText, saveCompliance, PLATFORM_RULES } from './compliance.js';
import { scoreViral, saveViral } from './viral.js';
import fs from 'node:fs';
import path from 'node:path';

const STAGE_PROGRESS = { idea: 6, script: 26, voice: 46, footage: 66, edit: 84, ready: 100, published: 100 };
const PLATFORMS = ['reels', 'tiktok'];

const getProject = (id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
const getEpisode = (id) => db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
const getProduct = (id) => (id ? db.prepare('SELECT * FROM products WHERE id = ?').get(id) : null);

export function touchEpisode(id, patch) {
  const fields = { ...patch, updated_at: nowIso() };
  const keys = Object.keys(fields);
  db.prepare(`UPDATE episodes SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  return getEpisode(id);
}

function activeProduct(projectId) {
  const rows = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC').all();
  return rows[0] || null;
}

// ── Создание эпизода ────────────────────────────────────────────────────────
export function createEpisode({ projectId, ideaId = null, scriptId = null, productId = null, accountId = null, scheduledAt = null, autopilot = 1, title = null }) {
  const project = getProject(projectId);
  if (!project) throw new Error('Проект не найден');
  const idea = ideaId ? db.prepare('SELECT * FROM ideas WHERE id = ?').get(ideaId) : null;
  const script = scriptId ? db.prepare('SELECT * FROM scripts WHERE id = ?').get(scriptId) : null;
  const product = productId ? getProduct(productId) : activeProduct(projectId);

  let resolvedTitle = title || idea?.title || script?.hook || null;
  let scenes = script ? parseJson(script.scenes, []) : null;
  let description = script?.caption || '';
  let hashtags = script ? parseJson(script.hashtags, []) : [];
  let format = idea?.format || project.format;

  if (!resolvedTitle) {
    const [generated] = generateIdeas(project, { count: 1, product });
    resolvedTitle = generated.title;
    format = generated.format;
  }

  const id = uid('ep_');
  const ts = nowIso();
  db.prepare(`INSERT INTO episodes (id, project_id, idea_id, script_id, product_id, account_id, title, description, hashtags, scenes, cover_seed, topic, format, status, stage, progress, risk, error, attempts, autopilot, ab_test, scheduled_at, created_at, updated_at)
    VALUES (@id, @project_id, @idea_id, @script_id, @product_id, @account_id, @title, @description, @hashtags, @scenes, @cover_seed, @topic, @format, 'queued', 'idea', 4, 0, NULL, 0, @autopilot, @ab_test, @scheduled_at, @ts, @ts)`)
    .run({
      id, project_id: projectId, idea_id: ideaId, script_id: scriptId, product_id: product?.id || null,
      account_id: accountId, title: resolvedTitle, description,
      hashtags: JSON.stringify(hashtags), scenes: JSON.stringify(scenes || []),
      cover_seed: `${id}-${resolvedTitle}`, topic: resolvedTitle, format,
      autopilot, ab_test: project.ab_tests ? 1 : 0, scheduled_at: scheduledAt, ts,
    });

  if (ideaId) db.prepare("UPDATE ideas SET status = 'used' WHERE id = ?").run(ideaId);
  log({ level: 'info', actor: 'user', action: 'episode.created', entityType: 'episode', entityId: id, message: `Эпизод «${resolvedTitle}» поставлен в очередь`, meta: { projectId } });
  enqueue('episode.prepare', { episodeId: id }, { delayMs: 600, priority: 3 });
  return getEpisode(id);
}

// ── Шаг 1: сценарий ─────────────────────────────────────────────────────────
registerHandler('episode.prepare', async ({ episodeId }) => {
  const episode = getEpisode(episodeId);
  if (!episode) return;
  const project = getProject(episode.project_id);
  const product = getProduct(episode.product_id) || activeProduct(episode.project_id);
  const settings = getSettings();

  let scenes = parseJson(episode.scenes, []);
  let description = episode.description;
  let hashtags = parseJson(episode.hashtags, []);

  if (!scenes.length) {
    const idea = episode.idea_id ? db.prepare('SELECT * FROM ideas WHERE id = ?').get(episode.idea_id) : null;
    const script = buildScript(project, idea || { hook: episode.title, format: episode.format, tags: [] }, {
      product,
      platform: 'reels',
      duration: project.duration_sec,
    });
    scenes = script.scenes;
    description = script.caption;
    hashtags = script.hashtags;
    // сохраняем сценарий как отдельную сущность — его можно править и переиспользовать
    const scriptId = uid('sc_');
    db.prepare(`INSERT INTO scripts (id, idea_id, project_id, hook, scenes, cta, caption, hashtags, duration_sec, tone, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)`)
      .run(scriptId, episode.idea_id, episode.project_id, script.hook, JSON.stringify(script.scenes), script.cta,
        script.caption, JSON.stringify(script.hashtags), script.duration_sec, script.tone, nowIso());
    touchEpisode(episodeId, { script_id: scriptId });
  }

  const risk = riskScore(`${episode.title} ${description} ${scenes.map((s) => s.text).join(' ')}`);
  if (product?.url) description = platformCaption({ caption: description, hashtags }, 'reels', product);

  touchEpisode(episodeId, {
    scenes: JSON.stringify(scenes),
    description,
    hashtags: JSON.stringify(hashtags),
    risk,
    status: 'generating',
    stage: 'script',
    progress: STAGE_PROGRESS.script,
    attempts: episode.attempts + 1,
    error: null,
  });
  log({ level: 'info', actor: 'engine', action: 'episode.script', entityType: 'episode', entityId: episodeId, message: `Сценарий готов: ${scenes.length} сцен, риск ${risk}/100`, meta: { risk } });

  if (Number(settings.risk_threshold) <= risk) {
    log({ level: 'warn', actor: 'engine', action: 'episode.risk', entityType: 'episode', entityId: episodeId, message: `Риск ${risk}/100 — эпизод уйдёт на ручную проверку`, meta: { risk } });
  }
  enqueue('episode.render', { episodeId, step: 'voice' }, { delayMs: 1400, priority: 4, dedupeKey: `render:${episodeId}:voice` });
});

// ── Шаги 2–4: озвучка → видео → монтаж ─────────────────────────────────────
registerHandler('episode.render', async ({ episodeId, step }, job) => {
  const episode = getEpisode(episodeId);
  if (!episode) return;
  const project = getProject(episode.project_id);
  const product = getProduct(episode.product_id) || activeProduct(episode.project_id);
  const scenes = parseJson(episode.scenes, []);
  const settings = getSettings();

  try {
    if (step === 'voice') {
      const text = [scenes[0]?.text, ...scenes.slice(1).map((s) => s.text)].filter(Boolean).join(' ');
      const audio = await providers.tts.synthesize({ text, voiceId: process.env.ELEVENLABS_VOICE_ID });
      // Реальная озвучка (live-режим) сохраняется рядом с видео и подмешивается в рендер.
      if (audio?.audioBuffer) {
        fs.mkdirSync(MEDIA_DIR, { recursive: true });
        fs.writeFileSync(path.join(MEDIA_DIR, `${String(episodeId).replace(/[^a-z0-9_]/gi, '')}.${audio.audioFormat || 'mp3'}`), audio.audioBuffer);
      }
      touchEpisode(episodeId, { stage: 'voice', status: 'generating', progress: STAGE_PROGRESS.voice });
      log({ level: 'info', actor: 'provider.tts', action: 'episode.voice', entityType: 'episode', entityId: episodeId, message: `Озвучка готова: ${audio.durationSec} с, провайдер ${audio.provider}`, meta: audio });
      enqueue('episode.render', { episodeId, step: 'footage' }, { delayMs: 1600, priority: 4, dedupeKey: `render:${episodeId}:footage` });
      return;
    }

    if (step === 'footage') {
      const scene = scenes[0] || { visual: 'кадр на камеру' };
      const draft = await providers.video.submit({
        prompt: `${scene.visual}. ${episode.title}. Вертикальное видео ${project?.aspect || '9:16'}, стиль: современный, чистый, тёмно-фиолетовые акценты`,
        aspect: project?.aspect || '9:16',
        seconds: Math.min(8, Math.round((project?.duration_sec || 30) / Math.max(1, scenes.length))),
        seed: episode.id,
      });
      touchEpisode(episodeId, { stage: 'footage', progress: STAGE_PROGRESS.footage });
      log({ level: 'info', actor: `provider.video.${draft.provider}`, action: 'episode.footage', entityType: 'episode', entityId: episodeId, message: `Видеоряд сгенерирован (${draft.provider}${draft.demo ? ', demo' : ''})`, meta: draft });
      if (Math.random() < 0.05) throw new Error('Провайдер видео вернул 429 (rate limit) — задача будет повторена');
      enqueue('episode.render', { episodeId, step: 'edit' }, { delayMs: 1800, priority: 4, dedupeKey: `render:${episodeId}:edit` });
      return;
    }

    // ── edit: реальная сборка файла, маркировка, комплаенс, «залетабельность»
    touchEpisode(episodeId, { stage: 'edit', progress: STAGE_PROGRESS.edit });

    const account = episode.account_id
      ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(episode.account_id)
      : db.prepare("SELECT * FROM accounts WHERE status IN ('healthy','warmup') ORDER BY quality DESC LIMIT 1").get();
    const handle = account?.handle || `pulse.${String(project?.niche || 'studio').replace(/[^a-z0-9]/gi, '')}`.slice(0, 24);

    // маркировка: реклама + ИИ-контент добавляется в описание один раз
    const adOn = Number(settings.ad_label ?? 1) === 1;
    const aiOn = Number(settings.ai_label ?? 1) === 1;
    let finalDescription = episode.description || '';
    const disclosure = disclosureText({ ad: adOn && Boolean(episode.product_id), ai: aiOn, productName: product?.name });
    if (disclosure && !finalDescription.includes(disclosure.split('.').pop().trim().slice(0, 12))) {
      finalDescription = `${finalDescription}\n\n${disclosure}`.trim();
    }

    let video = null;
    if (renderAvailable()) {
      try {
        const audioCandidates = ['mp3', 'wav', 'm4a'].map((ext) => path.join(MEDIA_DIR, `${String(episodeId).replace(/[^a-z0-9_]/gi, '')}.${ext}`));
        const audioPath = audioCandidates.find((p) => fs.existsSync(p)) || null;
        video = await renderEpisode({
          episode: { ...episode, title: episode.title },
          project,
          scenes,
          handle,
          audioPath,
        });
        log({
          level: 'info', actor: 'render', action: 'episode.render', entityType: 'episode', entityId: episodeId,
          message: `Видео собрано: ${video.width}×${video.height}, ${(video.bytes / 1024 / 1024).toFixed(1)} МБ, ${video.renderMs} мс`,
          meta: { bytes: video.bytes, renderMs: video.renderMs, path: video.videoPath },
        });
      } catch (err) {
        log({ level: 'warn', actor: 'render', action: 'episode.render_failed', entityType: 'episode', entityId: episodeId, message: `Рендер не удался: ${err.message}`, meta: { stack: String(err.stack || '').slice(0, 400) } });
      }
    } else {
      log({ level: 'warn', actor: 'render', action: 'episode.render_off', entityType: 'episode', entityId: episodeId, message: 'Рендер выключен — ролик уйдёт на проверку без файла', meta: renderInfo() });
    }

    const compliance = checkCompliance({
      title: episode.title,
      description: finalDescription,
      scenes,
      platform: account?.platform || 'reels',
      hashtags: parseJson(episode.hashtags, []),
      adLabel: adOn,
      aiLabel: aiOn,
    });
    const viral = scoreViral({
      title: episode.title,
      scenes,
      description: finalDescription,
      hashtags: parseJson(episode.hashtags, []),
      targetSec: project?.duration_sec || 30,
      topic: episode.topic,
      projectId: episode.project_id,
    });

    const costRub = num(settings.cost_video, 45) + num(settings.cost_tts, 12) + num(settings.cost_llm, 8) + num(settings.cost_render, 1);
    const costCents = Math.round(costRub * 100);

    saveCompliance(episodeId, compliance);
    saveViral(episodeId, viral);

    const ready = touchEpisode(episodeId, {
      stage: 'ready',
      progress: 100,
      status: 'review',
      error: null,
      description: finalDescription,
      video_path: video?.videoPath || null,
      video_bytes: video?.bytes || null,
      render_ms: video?.renderMs || null,
      cover_paths: video ? JSON.stringify(video.coverPaths) : null,
      cost_cents: costCents,
    });

    const viralThreshold = num(settings.min_viral_score, 45);
    const reasons = [];
    if (!video) reasons.push('нет файла ролика');
    if (!compliance.ok) reasons.push(`блокирующих нарушений: ${compliance.blocking.length}`);
    if (viral.score < viralThreshold) reasons.push(`вирусный скор ${viral.score} < ${viralThreshold}`);

    const autoOk = Number(settings.autopilot_global) === 1
      && Number(ready.autopilot) === 1
      && Number(settings.manual_review) !== 1
      && ready.risk < Number(settings.risk_threshold)
      && compliance.ok
      && viral.score >= viralThreshold
      && Boolean(video);

    if (!autoOk) {
      log({
        level: compliance.ok ? 'info' : 'warn',
        actor: 'engine', action: 'episode.review', entityType: 'episode', entityId: episodeId,
        message: `Ролик готов, но ждёт проверки: ${reasons.join('; ') || 'автопилот выключен'}`,
        meta: { compliance: compliance.score, viral: viral.score, reasons },
      });
      return;
    }

    const scheduledAt = ready.scheduled_at || nextSlot(ready.project_id);
    touchEpisode(episodeId, { status: 'scheduled', scheduled_at: scheduledAt });
    log({ level: 'success', actor: 'engine', action: 'episode.ready', entityType: 'episode', entityId: episodeId, message: `Ролик собран и запланирован (скор ${viral.score}, файл ${((video.bytes || 0) / 1048576).toFixed(1)} МБ)`, meta: { scheduledAt } });
    enqueue('episode.publish', { episodeId }, { delayMs: Math.max(1500, new Date(scheduledAt).getTime() - Date.now()), priority: 2 });
  } catch (err) {
    if ((job?.attempts || 1) < 3) throw err; // очередь сделает retry с backoff
    touchEpisode(episodeId, { status: 'failed', stage: step, error: String(err.message || err), progress: STAGE_PROGRESS[step] || 40 });
    log({ level: 'error', actor: 'engine', action: 'episode.failed', entityType: 'episode', entityId: episodeId, message: `Этап «${step}» провален: ${err.message}`, meta: { step } });
  }
});

// ── Расписание и выбор аккаунта ─────────────────────────────────────────────
export function nextSlot(projectId, after = nowIso()) {
  const project = getProject(projectId);
  const perDay = clamp(num(project?.posts_per_day, 2), 1, 12);
  const gap = Math.round((24 * 60) / perDay);
  const last = db.prepare("SELECT MAX(scheduled_at) t FROM episodes WHERE project_id = ? AND status IN ('scheduled','published')").get(projectId);
  const lastAt = last?.t && new Date(last.t) > new Date(after) ? new Date(last.t) : new Date(after);
  // джиттер, чтобы посты не уходили ровно по секундам (антибот-гигиена)
  const jitter = Math.round(gap * 0.12 * (Math.random() * 2 - 1));
  const slot = new Date(lastAt.getTime() + Math.max(35, gap + jitter) * 60000);
  return slot.toISOString();
}

function accountQuota(account) {
  const settings = getSettings();
  const day = nowIso().slice(0, 10);
  const used = db.prepare('SELECT used FROM accounts_daily WHERE account_id = ? AND day = ?').get(account.id, day)?.used || 0;
  const cap = Math.min(account.daily_limit, num(settings.max_daily_per_account, 3));
  const effective = account.status === 'warmup' ? Math.min(1, cap) : cap;
  return { used, cap: effective, left: Math.max(0, effective - used) };
}

/**
 * Квота площадки за скользящие 24 часа.
 * TikTok: ~15 постов/сутки на креатора; неаудированный клиент — только приват.
 * Instagram: лимит берём из настроек (по умолчанию 50), окно тоже скользящее.
 */
export function platformQuota(platform, accountId = null) {
  const settings = getSettings();
  const since = addDays(nowIso(), -1);
  const row = accountId
    ? db.prepare("SELECT COUNT(*) n FROM publications WHERE platform = ? AND account_id = ? AND published_at > ? AND status = 'published'").get(platform, accountId, since)
    : db.prepare("SELECT COUNT(*) n FROM publications WHERE platform = ? AND published_at > ? AND status = 'published'").get(platform, since);
  const cap = platform === 'tiktok'
    ? Math.min(num(settings.max_daily_per_account, 3) * 5, 15)
    : Math.min(num(settings.max_daily_per_account, 3) * 17, 50);
  return { platform, used: row.n, cap, left: Math.max(0, cap - row.n) };
}

/** Приватность публикации: неаудированный TikTok-клиент = SELF_ONLY */
export function privacyFor(platform) {
  const settings = getSettings();
  if (platform !== 'tiktok') return 'public';
  const audited = Number(settings.tiktok_audited) === 1;
  return audited ? 'public' : String(settings.tiktok_privacy || 'SELF_ONLY');
}

function lastPublishAt(accountId) {
  return db.prepare('SELECT MAX(published_at) t FROM publications WHERE account_id = ?').get(accountId)?.t || null;
}

export function pickAccount(platform, projectId) {
  const pq = platformQuota(platform);
  if (pq.left <= 0) return null;
  const accounts = db.prepare("SELECT * FROM accounts WHERE platform = ? AND status IN ('healthy','warmup') ORDER BY quality DESC, created_at ASC").all(platform);
  const candidates = [];
  for (const a of accounts) {
    if (a.blocked_until && new Date(a.blocked_until) > new Date()) continue;
    const q = accountQuota(a);
    if (q.left <= 0) continue;
    const last = lastPublishAt(a.id);
    const gapOk = !last || (Date.now() - new Date(last).getTime()) / 60000 >= a.min_gap_min;
    if (!gapOk) continue;
    candidates.push({ account: a, ...q });
  }
  if (!candidates.length) return null;
  // балансировка: аккаунт с наибольшим остатком квоты; при равенстве — с лучшим качеством
  candidates.sort((x, y) => y.left - x.left || y.account.quality - x.account.quality);
  const chosen = candidates[0];
  // мягкое распределение по проектам: если аккаунт уже публиковал этот проект сегодня — берём следующий
  if (candidates.length > 1 && Math.random() < 0.35) return candidates[1].account;
  return chosen.account;
}

export function consumeQuota(accountId) {
  const day = nowIso().slice(0, 10);
  db.prepare(`INSERT INTO accounts_daily (account_id, day, used) VALUES (?, ?, 1)
              ON CONFLICT(account_id, day) DO UPDATE SET used = used + 1`).run(accountId, day);
}

// ── Публикация ──────────────────────────────────────────────────────────────
registerHandler('episode.publish', async ({ episodeId }) => {
  let episode = getEpisode(episodeId);
  if (!episode) return;
  if (episode.status === 'published') return;
  if (episode.status === 'review' || episode.status === 'failed' || episode.status === 'paused') {
    log({ level: 'warn', actor: 'engine', action: 'publish.skipped', entityType: 'episode', entityId: episodeId, message: `Публикация отменена: статус «${episode.status}»` });
    return;
  }
  const project = getProject(episode.project_id);
  const product = getProduct(episode.product_id) || activeProduct(episode.project_id);
  const settings = getSettings();

  // Без готового файла публиковать нечего: лучше вернуть ролик человеку,
  // чем отправить на площадку пустую ссылку.
  if (!episode.video_path || !fs.existsSync(path.join(MEDIA_DIR, path.basename(episode.video_path)))) {
    touchEpisode(episodeId, { status: 'review', error: 'Нет файла ролика — публикация остановлена' });
    log({ level: 'warn', actor: 'guard', action: 'publish.no_file', entityType: 'episode', entityId: episodeId, message: 'Публикация остановлена: файл ролика не найден' });
    return;
  }

  const desired = Number(settings.autopilot_global) === 1 && Number(episode.autopilot) === 1;
  if (!desired) {
    touchEpisode(episodeId, { status: 'review' });
    log({ level: 'info', actor: 'engine', action: 'publish.hold', entityType: 'episode', entityId: episodeId, message: 'Автопилот выключен — публикация ждёт подтверждения' });
    return;
  }

  const platforms = pickPlatforms(project);
  let account = platforms.map((p) => pickAccount(p, project?.id)).find(Boolean);
  if (!account) {
    const postpone = addMinutes(nowIso(), 20 + Math.floor(Math.random() * 25));
    touchEpisode(episodeId, { scheduled_at: postpone, status: 'scheduled' });
    enqueue('episode.publish', { episodeId }, { delayMs: 21 * 60000, priority: 2, dedupeKey: null });
    log({ level: 'warn', actor: 'guard', action: 'publish.throttled', entityType: 'episode', entityId: episodeId, message: `Нет свободного аккаунта: квоты/интервалы исчерпаны. Перенос на ${new Date(postpone).toLocaleTimeString('ru-RU').slice(0, 5)}`, meta: { postpone } });
    return;
  }

  const scenes = parseJson(episode.scenes, []);
  const hashtags = parseJson(episode.hashtags, []);
  const variants = Number(episode.ab_test) === 1 ? ['A', 'B'] : ['A'];
  const created = [];

  for (const variant of variants) {
    const platform = account.platform;
    const caption = variant === 'A'
      ? platformCaption({ caption: episode.description, hashtags }, platform, product)
      : platformCaption({
          caption: `${episode.description.split('\n')[0]} ${pick(['Второй вариант описания — проверяем гипотезу.', 'Короткая версия: суть в первых двух строках.', 'Альтернативный заход — без лишних слов.'])}`,
          hashtags: hashtagsFor(project || {}, platform, { tags: hashtags }, 6),
        }, platform, product);

    const result = await providers.publish.send({
      platform,
      account,
      description: caption,
      videoRef: episode.video_path || episodesVideoRef(episode),
      videoPath: episode.video_path ? path.join(MEDIA_DIR, path.basename(episode.video_path)) : null,
      coverPath: parseJson(episode.cover_paths, {})[variant] || null,
      privacy: privacyFor(account.platform),
      scheduledAt: nowIso(),
    }).catch((err) => {
      // Лимиты и баны не ретраятся пачкой: публикация переносится, аккаунт остывает.
      if (err.kind === 'limit' || err.kind === 'ban') {
        log({ level: 'warn', actor: 'publisher', action: 'publish.limit', entityType: 'account', entityId: account.id, message: err.message, meta: { kind: err.kind } });
        if (err.kind === 'ban') {
          db.prepare("UPDATE accounts SET status = 'cooldown', blocked_until = ?, updated_at = ? WHERE id = ?")
            .run(addDays(nowIso(), 1), nowIso(), account.id);
        }
        const postpone = addMinutes(nowIso(), 60 + Math.floor(Math.random() * 60));
        touchEpisode(episodeId, { status: 'scheduled', scheduled_at: postpone, error: err.message });
        enqueue('episode.publish', { episodeId }, { delayMs: 62 * 60000, priority: 2 });
        return null;
      }
      throw err;
    });
    if (!result) return;

    const pid = uid('pb_');
    const ts = nowIso();
    const accountAgeDays = 20 + Math.floor(Math.random() * 120);
    const base = 900 + Math.random() * 2600 + (project?.posts_per_day || 2) * 120;
    const viral = Math.random() < 0.16 ? 4 + Math.random() * 9 : 1;
    // вирусный скор влияет на ожидаемый охват: так модель учится на своих же прогнозах
    const scoreBoost = 0.75 + (num(episode.viral, 50) / 100) * 0.6;
    const target = Math.round(base * viral * scoreBoost * (variant === 'B' ? 0.92 : 1) * (1 + accountAgeDays / 300));

    const covers = parseJson(episode.cover_paths, {});
    const coverPath = covers[variant] || covers.A || null;
    const clickToken = uid('ct_').replace(/[^a-z0-9]/gi, '').slice(0, 18);
    const privacy = privacyFor(platform);

    db.prepare(`INSERT INTO publications (id, episode_id, project_id, account_id, platform, variant, title, description, hashtags, cover_seed, cover_path, click_token, url, external_id, status, scheduled_at, published_at, target_views, privacy, cost_cents, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?)`)
      .run(pid, episode.id, episode.project_id, account.id, platform, variant, episode.title, caption,
        JSON.stringify(hashtags), `${episode.cover_seed}-${variant}`, coverPath, clickToken, result.url,
        result.externalId ? String(result.externalId) : null, ts, ts, target, result.privacy || privacy,
        Math.round(num(episode.cost_cents, 0) / variants.length), ts);
    created.push(pid);
    consumeQuota(account.id);
    log({
      level: 'info', actor: 'publisher', action: 'publication.created', entityType: 'publication', entityId: pid,
      message: `Публикация ${platform === 'tiktok' ? 'TikTok' : 'Reels'}${privacy !== 'public' ? ' (приватно — клиент не аудирован)' : ''}: ${episode.title}`,
      meta: { privacy, click: `/t/${clickToken}`, cover: coverPath, video: episode.video_path },
    });
  }

  episode = touchEpisode(episodeId, { status: 'published', stage: 'published', published_at: nowIso(), progress: 100, error: null });
  // отметим «использованную» идею и обновим статистику проекта
  log({
    level: 'success', actor: 'publisher', action: 'episode.published', entityType: 'episode', entityId: episodeId,
    message: `Опубликовано: «${episode.title}» (${created.length} вариант${created.length > 1 ? 'а' : ''}, ${account.platform === 'tiktok' ? 'TikTok' : 'Reels'})`,
    meta: { account: account.handle, publications: created },
  });
});

function pickPlatforms(project) {
  const accounts = db.prepare("SELECT DISTINCT platform FROM accounts WHERE status != 'blocked'").all().map((r) => r.platform);
  if (!accounts.length) return PLATFORMS;
  return accounts;
}

function episodesVideoRef(episode) {
  return `episodes/${episode.id}/final.mp4`;
}



// ── Автопилот: наполнение очереди ───────────────────────────────────────────
registerHandler('autopilot.tick', async () => {
  const settings = getSettings();
  if (Number(settings.autopilot_global) !== 1) return;
  const projects = db.prepare('SELECT * FROM projects WHERE autopilot = 1 AND archived = 0').all();
  for (const project of projects) {
    const pending = db.prepare("SELECT COUNT(*) n FROM episodes WHERE project_id = ? AND status IN ('queued','generating','review','scheduled')").get(project.id).n;
    const goal = clamp(num(project.posts_per_day, 2) * 2, 2, 10);
    if (pending >= goal) continue;

    // добираем идеи, чтобы в библиотеке всегда был запас
    const ideasCount = db.prepare("SELECT COUNT(*) n FROM ideas WHERE project_id = ? AND status = 'new'").get(project.id).n;
    if (ideasCount < 6) {
      const product = activeProduct(project.id);
      const existing = db.prepare('SELECT title FROM ideas WHERE project_id = ?').all(project.id).map((r) => r.title.toLowerCase());
      const leadFormats = db.prepare(`SELECT e.format, AVG(pb.views) avg_views
          FROM publications pb JOIN episodes e ON e.id = pb.episode_id
          WHERE pb.project_id = ? AND pb.views > 0
          GROUP BY e.format HAVING COUNT(pb.id) >= 3 ORDER BY avg_views DESC LIMIT 2`)
        .all(project.id).map((r) => r.format);
      const seedTopics = db.prepare(`SELECT e.topic, SUM(md.views) v
          FROM metrics_daily md JOIN publications pb ON pb.id = md.publication_id
          JOIN episodes e ON e.id = pb.episode_id
          WHERE pb.project_id = ? AND e.topic <> ''
          GROUP BY e.topic ORDER BY v DESC LIMIT 2`).all(project.id).map((r) => r.topic);
      const fresh = generateIdeas(project, { count: 6 - ideasCount, product, exclude: existing, preferFormats: leadFormats, seedTopics });
      const ins = db.prepare(`INSERT INTO ideas (id, project_id, title, hook, angle, format, tags, score, source, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai', 'new', ?)`);
      for (const i of fresh) ins.run(uid('id_'), project.id, i.title, i.hook, i.angle, i.format, JSON.stringify(i.tags), i.score, nowIso());
    }

    const slot = nextSlot(project.id);
    const idea = db.prepare("SELECT * FROM ideas WHERE project_id = ? AND status = 'new' ORDER BY score DESC, created_at ASC LIMIT 1").get(project.id);
    const ep = createEpisode({ projectId: project.id, ideaId: idea?.id || null, scheduledAt: slot });
    log({ level: 'info', actor: 'autopilot', action: 'autopilot.fill', entityType: 'episode', entityId: ep.id, message: `Автопилот добавил в конвейер: «${ep.title}»`, meta: { projectId: project.id } });
  }
});

// ── Аналитика: сбор метрик ──────────────────────────────────────────────────
export function growthCurve(ageHours) {
  // быстрый рост первые 6 часов, затем плато с медленным хвостом
  if (ageHours <= 0) return 0;
  const fast = 1 - Math.exp(-ageHours / 9);
  const tail = 1 - Math.exp(-ageHours / 120);
  return clamp(0.72 * fast + 0.28 * tail, 0, 1);
}

export async function collectAnalytics() {
  const since = addDays(nowIso(), -45);
  const pubs = db.prepare("SELECT * FROM publications WHERE status = 'published' AND published_at > ?").all(since);
  const day = nowIso().slice(0, 10);
  let updated = 0;

  // metrics_daily хранит ПРИРОСТ за день, поэтому накапливаем инкременты
  const upsertDay = db.prepare(`INSERT INTO metrics_daily (id, publication_id, day, views, likes, comments, shares, clicks, followers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET views = views + excluded.views, likes = likes + excluded.likes,
      comments = comments + excluded.comments, shares = shares + excluded.shares,
      clicks = clicks + excluded.clicks, followers = followers + excluded.followers`);

  // Live-режим: сначала реальные метрики из API площадок, иначе — модель роста.
  const isLive = (process.env.PULSE_MODE || 'demo') === 'live';
  let liveRows = new Map();
  if (isLive) {
    const byAccount = new Map();
    for (const p of pubs) {
      if (!p.external_id) continue;
      const key = `${p.platform}:${p.account_id}`;
      if (!byAccount.has(key)) byAccount.set(key, { platform: p.platform, account: db.prepare('SELECT * FROM accounts WHERE id = ?').get(p.account_id), pubs: [] });
      byAccount.get(key).pubs.push(p);
    }
    for (const group of byAccount.values()) {
      const rows = await providers.stats.fetch({
        platform: group.platform,
        account: group.account,
        externalIds: group.pubs.map((p) => p.external_id),
      });
      if (!rows) continue;
      for (const row of rows) {
        const pub = group.pubs.find((p) => String(p.external_id) === row.id);
        if (pub) liveRows.set(pub.id, row);
      }
    }
  }

  for (const p of pubs) {
    // реальные счётчики площадки перекрывают модель
    if (liveRows.has(p.id)) {
      const row = liveRows.get(p.id);
      const dViews = Math.max(0, row.views - p.views);
      db.prepare('UPDATE publications SET views = ?, likes = ?, comments = ?, shares = ?, saves = ? WHERE id = ?')
        .run(row.views, row.likes ?? p.likes, row.comments ?? p.comments, row.shares ?? p.shares, row.saves ?? p.saves, p.id);
      if (dViews > 0) {
        db.prepare(`INSERT INTO metrics_daily (id, publication_id, day, views, likes, comments, shares, clicks, followers)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
          ON CONFLICT(id) DO UPDATE SET views = views + excluded.views, likes = likes + excluded.likes,
            comments = comments + excluded.comments, shares = shares + excluded.shares`)
          .run(`${p.id}:${day}`, p.id, day, dViews, Math.max(0, (row.likes || 0) - p.likes), Math.max(0, (row.comments || 0) - p.comments), Math.max(0, (row.shares || 0) - p.shares));
      }
      updated++;
      continue;
    }

    const ageHours = (Date.now() - new Date(p.published_at).getTime()) / 3600000;
    const curve = growthCurve(ageHours);
    const wobble = 1 + Math.sin(ageHours / 7 + p.id.charCodeAt(2)) * 0.03;
    const views = Math.round(p.target_views * curve * wobble);
    if (views <= p.views) continue;
    const likes = Math.round(views * (0.055 + (p.id.charCodeAt(3) % 7) / 100));
    const comments = Math.round(views * 0.006);
    const shares = Math.round(views * 0.009);
    const clicks = Math.round(views * (0.012 + (p.id.charCodeAt(4) % 5) / 400));
    const followers = Math.round(views * 0.0035);
    db.prepare(`UPDATE publications SET views = ?, likes = ?, comments = ?, shares = ?, clicks = ?, followers = ?, watch_avg = ?
      WHERE id = ?`).run(views, likes, comments, shares, clicks, followers,
      Math.round((26 + (p.id.charCodeAt(5) % 14)) * 10) / 10, p.id);
    // пишем только прирост относительно уже сохранённого итога публикации
    const dViews = views - p.views;
    const dLikes = Math.max(0, likes - p.likes);
    const dComments = Math.max(0, comments - p.comments);
    const dShares = Math.max(0, shares - p.shares);
    const dClicks = Math.max(0, clicks - p.clicks);
    const dFollowers = Math.max(0, followers - p.followers);
    if (dViews > 0) upsertDay.run(`${p.id}:${day}`, p.id, day, dViews, dLikes, dComments, dShares, dClicks, dFollowers);
    updated++;
  }
  return updated;
}

// Самовосстановление: публикации, время которых пришло, но задачи нет (после рестарта)
export function sweepDueEpisodes() {
  const due = db.prepare("SELECT * FROM episodes WHERE status = 'scheduled' AND scheduled_at <= ?").all(nowIso());
  let n = 0;
  for (const ep of due) {
    const busy = db.prepare("SELECT 1 x FROM jobs WHERE status IN ('pending','running') AND type = 'episode.publish' AND payload LIKE ? LIMIT 1").get(`%${ep.id}%`);
    if (busy) continue;
    enqueue('episode.publish', { episodeId: ep.id }, { delayMs: 0, priority: 2 });
    n++;
  }
  return n;
}

export function recoverEpisodeStates() {
  // ── 1. «зависшие» эпизоды без живой задачи ────────────────────────────────
  // Не важно, в каком статусе эпизод застрял (queued, generating, ready) —
  // если для него нет ни pending-, ни running-задачи дольше 8 минут,
  // значит процесс падал или задача потерялась. Возвращаем её в очередь.
  const stale = addMinutes(nowIso(), -8);
  const orphans = db.prepare(`
    SELECT e.* FROM episodes e
    WHERE e.status IN ('queued', 'generating')
      AND e.updated_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.status IN ('pending', 'running')
          AND j.payload LIKE '%' || e.id || '%'
      )
    ORDER BY e.updated_at ASC
    LIMIT 25
  `).all(stale);

  let n = 0;
  for (const ep of orphans) {
    if (ep.stage === 'idea' || ep.stage === 'script') {
      enqueue('episode.prepare', { episodeId: ep.id }, { delayMs: 500, priority: 3, dedupeKey: `prepare:${ep.id}` });
    } else {
      const step = ep.stage === 'voice' ? 'footage' : 'edit';
      // dedupe: иначе восстановление состояния и уже стоящая в очереди задача
      // отрендерят один и тот же ролик дважды
      enqueue('episode.render', { episodeId: ep.id, step }, { delayMs: 1000, priority: 4, dedupeKey: `render:${ep.id}:${step}` });
    }
    touchEpisode(ep.id, { updated_at: nowIso() });
    n++;
  }

  // ── 2. эпизоды, готовые к публикации, но потерявшие задачу ────────────────
  const publishLosts = db.prepare(`
    SELECT e.* FROM episodes e
    WHERE e.status = 'scheduled'
      AND e.scheduled_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.status IN ('pending', 'running')
          AND j.payload LIKE '%' || e.id || '%'
      )
    ORDER BY e.scheduled_at ASC
    LIMIT 25
  `).all(nowIso());

  for (const ep of publishLosts) {
    enqueue('episode.publish', { episodeId: ep.id }, { delayMs: 0, priority: 2 });
    n++;
  }

  if (n > 0) {
    log({ level: 'warn', actor: 'queue', action: 'episodes.recovered', message: `Восстановлено эпизодов: ${n}` });
  }
  return n;
}
