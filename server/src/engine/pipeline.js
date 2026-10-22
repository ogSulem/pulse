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
import { planSlot, nextSlotIso } from './schedule.js';
import { forecastEpisode, autopilotPolicy, recalculateAccountQuality } from './forecast.js';
import {
  attachCampaign, decorateCaption, disclosureFor, recordDelivery, syncCampaignMetrics,
  autofillCampaigns, campaignStats, pickCampaign,
} from './ads.js';
import { preferredVariant, evaluateAB } from './abtest.js';
import { checkCompliance, disclosureText, saveCompliance, PLATFORM_RULES } from './compliance.js';
import { scoreViral, saveViral, recalibrate } from './viral.js';
import { studio, promotionDecision } from './creative.js';
import fs from 'node:fs';
import path from 'node:path';

const STAGE_PROGRESS = { idea: 6, script: 26, voice: 46, footage: 66, edit: 84, ready: 100, published: 100 };
import { PLATFORMS, PLATFORM_LABELS, platformCap, PLATFORM_API_LIMITS } from './limits.js';

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
  // promo фиксируется на этапе сценария: в 3 из 4 роликов продажи нет.
  // Старые эпизоды без флага ведут себя как раньше: есть product_id — продаём.
  const promoMode = episode.promo || (episode.product_id ? 'direct' : 'none');
  const product = promoMode === 'none'
    ? null
    : (getProduct(episode.product_id) || activeProduct(episode.project_id));
  const settings = getSettings();

  let scenes = parseJson(episode.scenes, []);
  let description = episode.description;
  let hashtags = parseJson(episode.hashtags, []);

  // ── Креатив: хук по окну свайпа, структура сцен, описание под площадку ────
  // Раньше сценарий собирался один раз по шаблону. Теперь движок делает несколько
  // кандидатов и берёт лучший по вирусности, удержанию и комплаенсу — и решает,
  // уместна ли в этом ролике продажа продукта.
  let creative = null;
  let promo = episode.promo || null;
  const generatedFresh = !scenes.length;
  if (generatedFresh) {
    const idea = episode.idea_id ? db.prepare('SELECT * FROM ideas WHERE id = ?').get(episode.idea_id) : null;
    const decision = promotionDecision({ project, product });
    promo = decision.intensity;
    const chosenProduct = decision.intensity === 'none' ? null : decision.product;
    const pack = studio({
      project,
      idea: idea || { title: episode.title, format: episode.format },
      product: chosenProduct,
      platform: 'reels',
      durationSec: project.duration_sec,
      promo: decision.intensity,
      count: 3,
    });
    creative = pack.best;
    scenes = creative.scenes;
    description = creative.caption;
    hashtags = creative.hashtags;
    if (creative.title && (!episode.title || episode.title.length < 8)) touchEpisode(episodeId, { title: creative.title });
    // продукт фиксируем на эпизоде: публикация не должна решать это заново
    touchEpisode(episodeId, { product_id: chosenProduct?.id || null });

    const scriptId = uid('sc_');
    db.prepare(`INSERT INTO scripts (id, idea_id, project_id, hook, scenes, cta, caption, hashtags, duration_sec, tone, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)`)
      .run(scriptId, episode.idea_id, episode.project_id, creative.hook, JSON.stringify(scenes),
        String(scenes[scenes.length - 1]?.text || ''), creative.caption, JSON.stringify(hashtags),
        creative.durationSec, project?.tone || 'friendly', nowIso());
    touchEpisode(episodeId, { script_id: scriptId });
    log({
      level: 'info', actor: 'creative', action: 'creative.package', entityType: 'episode', entityId: episodeId,
      message: `Креатив собран: «${creative.hook}» · скор ${creative.scores.total}/100 · продажа: ${promo === 'direct' ? 'прямая' : promo === 'soft' ? 'мягкая' : 'без продажи'}`,
      meta: { scores: creative.scores, format: creative.format, promo, product: chosenProduct?.name || null },
    });
  }

  const risk = riskScore(`${episode.title} ${description} ${scenes.map((s) => s.text).join(' ')}`);
  // Описание из креативного пакета уже собрано по правилам каждой площадки
  // (CTA, ссылка, теги). Повторно оборачивать его platformCaption нельзя:
  // получались две ссылки и два блока тегов в одном описании.
  // оборачиваем только сценарий, собранный здесь же; готовый текст из студии
  // уже содержит CTA и теги под нужную площадку
  if (generatedFresh && !creative && product?.url) description = platformCaption({ caption: description, hashtags }, 'reels', product);

  touchEpisode(episodeId, {
    scenes: JSON.stringify(scenes),
    description,
    hashtags: JSON.stringify(hashtags),
    promo: promo || 'none',
    ...(creative ? { creative: JSON.stringify({
      hook: creative.hook, hookScore: creative.hookScore, format: creative.format,
      formatLabel: creative.formatLabel, scores: creative.scores, warnings: creative.warnings,
      alternativeHooks: creative.alternativeHooks, coverText: creative.coverText,
      pinnedComment: creative.pinnedComment, captions: creative.captions,
      product: creative.product,
    }) } : {}),
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

    // ── реклама: если ролик ещё без спонсора, пробуем взять кампанию ────────
    // Это происходит до рендера, чтобы маркировка попала в описание и проверку.
    let campaign = episode.campaign_id ? db.prepare('SELECT * FROM campaigns WHERE id = ?').get(episode.campaign_id) : null;
    if (!campaign) {
      const picked = pickCampaign({ projectId: episode.project_id });
      if (picked) {
        try {
          attachCampaign(episodeId, picked.campaign.id);
          campaign = picked.campaign;
          log({
            level: 'info', actor: 'ads', action: 'campaign.auto_attach', entityType: 'episode', entityId: episodeId,
            message: `Автопилот взял кампанию «${campaign.name}» (${campaign.model})`,
            meta: { campaignId: campaign.id, postsLeft: picked.stats.postsLeft },
          });
        } catch (err) {
          log({ level: 'warn', actor: 'ads', action: 'campaign.attach_failed', message: String(err.message || err) });
        }
      }
    }
    if (campaign) {
      finalDescription = decorateCaption(finalDescription, campaign);
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
      campaign,
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
      // храним базовое описание: маркировку и спонсорский блок добавляет
      // публикация, иначе при каждом рендере они дублировались бы в тексте
      description: episode.description,
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
// Умное расписание живёт в engine/schedule.js (окна аккаунтов, таймзона,
// пики площадок и собственные данные по часам). Здесь — совместимый фасад.
export function nextSlot(projectId, after = nowIso()) {
  return nextSlotIso(projectId, after);
}

/** Слот + объяснение, почему именно это время */
export function nextSlotPlan(projectId, after = nowIso()) {
  return planSlot(projectId, { after });
}

/** Остаток дневной квоты аккаунта: used/cap/left с учётом прогрева. */
export function accountQuota(account) {
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
  // TikTok — ~15 постов/сутки на креатора; Reels — 50 API-постов в окне 24 ч;
  // YouTube — 100 загрузок в сутки на проект, но алгоритму нужен ровный темп,
  // поэтому держим собственный потолок заметно ниже лимита API.
  const cap = platformCap(platform, settings);
  return { platform, used: row.n, cap, left: Math.max(0, cap - row.n) };
}

/** Приватность публикации: неаудированный TikTok-клиент = SELF_ONLY */
export function privacyFor(platform) {
  const settings = getSettings();
  if (platform === 'tiktok') {
    const audited = Number(settings.tiktok_audited) === 1;
    return audited ? 'public' : String(settings.tiktok_privacy || 'SELF_ONLY');
  }
  // Неаудированный проект Google загружает только приватно — это правило площадки,
  // а не осторожность Pulse. Публично включается осознанно, в настройках.
  if (platform === 'youtube') {
    return Number(settings.youtube_audited) === 1 ? 'public' : 'private';
  }
  return 'public';
}

function lastPublishAt(accountId) {
  return db.prepare('SELECT MAX(published_at) t FROM publications WHERE account_id = ?').get(accountId)?.t || null;
}

/**
 * `need` — сколько выходов (постов) уйдёт на этом аккаунте прямо сейчас.
 * A/B-тест публикует два варианта, значит и квоты нужно два слота: иначе
 * аккаунт с остатком «1» молча превышал собственный дневной лимит.
 */
export function pickAccount(platform, projectId, need = 1) {
  const pq = platformQuota(platform);
  if (pq.left < need) return null;
  // Бренд-привязка: аккаунт ведёт один проект. Контент FitFlow не должен уходить
  // в аккаунт Momentum — это разные бренды и разные подписчики. Универсальные
  // аккаунты (project_id IS NULL) подходят любому проекту.
  // Без проекта (диагностика, ручной выбор) ограничений нет — фильтруем только когда
  // известно, чей это контент.
  const accounts = db.prepare(`SELECT * FROM accounts
      WHERE platform = ? AND status IN ('healthy','warmup')
        ${projectId ? 'AND (project_id IS NULL OR project_id = ?)' : ''}
      ORDER BY quality DESC, created_at ASC`).all(...(projectId ? [platform, projectId] : [platform]));
  const candidates = [];
  for (const a of accounts) {
    if (a.blocked_until && new Date(a.blocked_until) > new Date()) continue;
    const q = accountQuota(a);
    if (q.left < need) continue;
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
  // статус «published» не блокирует: если добавили вторую площадку, ролик
  // должен доехать и туда. Дубли отсекает карта уже опубликованных площадок.
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

  // ── Кому публикуем: по одному свободному аккаунту на каждую площадку ──────
  // Раньше ролик уходил только на одну площадку — половина охвата терялась.
  const already = new Map(db.prepare(
    "SELECT platform, COUNT(*) n FROM publications WHERE episode_id = ? AND status = 'published' GROUP BY platform"
  ).all(episodeId).map((r) => [r.platform, r.n]));

  // Аккаунты именно этого бренда (или универсальные). Если их нет вовсе —
  // переносить публикацию бессмысленно: ролик будет висеть в очереди вечно.
  const brandAccounts = db.prepare(`SELECT platform FROM accounts
      WHERE status IN ('healthy','warmup') AND (project_id IS NULL OR project_id = ?)`).all(project?.id || null);
  if (!brandAccounts.length) {
    touchEpisode(episodeId, { status: 'review', error: 'У проекта нет аккаунтов — добавьте аккаунт и привяжите к бренду' });
    log({
      level: 'warn', actor: 'guard', action: 'publish.no_account', entityType: 'episode', entityId: episodeId,
      message: `Публикация остановлена: у проекта «${project?.name || '—'}» нет активных аккаунтов`,
    });
    return;
  }

  const pending = pickPlatforms(project).filter((p) => !already.has(p));
  // A/B гоняем только когда публикуем на одну площадку: иначе это удвоение
  // квоты, а не эксперимент. На второй площадке сразу выходит лучший стиль.
  const abTwo = Number(episode.ab_test) === 1 && pending.length === 1;
  const need = abTwo ? 2 : 1;
  const targets = [];
  const missing = [];
  for (const platform of pending) {
    const acc = pickAccount(platform, project?.id, need);
    if (acc) targets.push({ platform, account: acc });
    else missing.push(platform);
  }

  // всё уже опубликовано — второй раз не публикуем
  if (!targets.length && !missing.length) return;

  if (!targets.length) {
    const postpone = addMinutes(nowIso(), 20 + Math.floor(Math.random() * 25));
    touchEpisode(episodeId, { scheduled_at: postpone, status: 'scheduled', error: `Нет свободной квоты: ${missing.join(', ')}` });
    enqueue('episode.publish', { episodeId }, { delayMs: 21 * 60000, priority: 2 });
    log({ level: 'warn', actor: 'guard', action: 'publish.throttled', entityType: 'episode', entityId: episodeId, message: `Нет свободного аккаунта: ${missing.join(', ')}. Перенос на ${new Date(postpone).toLocaleTimeString('ru-RU').slice(0, 5)}`, meta: { postpone, missing } });
    return;
  }

  const hashtags = parseJson(episode.hashtags, []);
  const preferred = preferredVariant(project?.id);
  const created = [];
  const blocked = [];

  for (const [index, target] of targets.entries()) {
    const { platform, account } = target;
    // A/B гоняем только когда публикуем на одну площадку: иначе это удвоение
    // квоты, а не эксперимент. На второй площадке сразу выходит лучший стиль.
    const variants = abTwo && targets.length === 1 ? ['A', 'B'] : [preferred.variant];

    for (const variant of variants) {
      const campaign = episode.campaign_id ? db.prepare('SELECT * FROM campaigns WHERE id = ?').get(episode.campaign_id) : null;
      const baseCaption = buildCaption({ episode, project, product, platform, variant, hashtags });
      const marked = withDisclosure(baseCaption, disclosureText({
        // если есть спонсорская кампания, её маркировка (erid) уже содержит
        // слово «Реклама» — второй такой строки не добавляем
        ad: !campaign && Number(settings.ad_label ?? 1) === 1 && Boolean(episode.product_id),
        ai: Number(settings.ai_label ?? 1) === 1,
        productName: product?.name,
      }));
      const caption = campaign ? decorateCaption(marked, campaign) : marked;
      const result = await providers.publish.send({
        platform,
        account,
        description: caption,
        title: episode.title,
        hashtags,
        videoRef: episode.video_path || episodesVideoRef(episode),
        videoPath: episode.video_path ? path.join(MEDIA_DIR, path.basename(episode.video_path)) : null,
        coverPath: parseJson(episode.cover_paths, {})[variant] || null,
        privacy: privacyFor(platform),
        scheduledAt: nowIso(),
      }).catch((err) => {
        // Лимиты и баны не ретраятся пачкой: публикация переносится, аккаунт остывает.
        if (err.kind === 'limit' || err.kind === 'ban') {
          log({ level: 'warn', actor: 'publisher', action: 'publish.limit', entityType: 'account', entityId: account.id, message: err.message, meta: { kind: err.kind } });
          if (err.kind === 'ban') {
            db.prepare("UPDATE accounts SET status = 'cooldown', blocked_until = ?, updated_at = ? WHERE id = ?")
              .run(addDays(nowIso(), 1), nowIso(), account.id);
          }
          blocked.push(platform);
          return null;
        }
        throw err;
      });
      if (!result) break; // на этой площадке стоп, остальные площадки не страдают

      const pid = uid('pb_');
      const ts = nowIso();
      const covers = parseJson(episode.cover_paths, {});
      const coverPath = covers[variant] || covers.A || null;
      const clickToken = uid('ct_').replace(/[^a-z0-9]/gi, '').slice(0, 18);
      const privacy = privacyFor(platform);

      // ожидаемый охват считает модель (медиана проекта × скор × час × аккаунт),
      // а не случайное число: потом эту же цифру видно в прогнозе ролика
      const forecast = forecastEpisode({ episode, project, account, platform, scheduledAt: nowIso() });

      db.prepare(`INSERT INTO publications (id, episode_id, project_id, account_id, platform, variant, title, description, hashtags, cover_seed, cover_path, click_token, url, external_id, status, scheduled_at, published_at, target_views, privacy, cost_cents, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?)`)
        .run(pid, episode.id, episode.project_id, account.id, platform, variant, episode.title, caption,
          JSON.stringify(hashtags), `${episode.cover_seed}-${variant}`, coverPath, clickToken, result.url,
          result.externalId ? String(result.externalId) : null, ts, ts, forecast.expectedViews, result.privacy || privacy,
          Math.round(num(episode.cost_cents, 0) / Math.max(1, variants.length * targets.length)), ts);
      created.push(pid);
      consumeQuota(account.id);
      // TikTok: внешняя ссылка в описании не кликабельна — ведём через
      // закреплённый комментарий, это единственный рабочий путь к продукту.
      const pinned = parseJson(episode.creative, null)?.pinnedComment;
      if (pinned && platform === 'tiktok' && providers.publish.comment) {
        await providers.publish.comment({ platform, account, externalId: result.externalId, text: pinned })
          .then(() => log({
            level: 'info', actor: 'publisher', action: 'publication.pinned', entityType: 'publication', entityId: pid,
            message: 'Закреплённый комментарий со ссылкой на продукт опубликован',
          }))
          .catch((err) => log({ level: 'warn', actor: 'publisher', action: 'publication.pinned_failed', entityType: 'publication', entityId: pid, message: String(err.message || err) }));
      }
      // ── спонсорский учёт: каждый выход фиксируется отдельно (A/B — тоже) ──
      if (campaign) {
        recordDelivery({ campaignId: campaign.id, episodeId, publicationId: pid, views: 0, clicks: 0 });
      }
      log({
        level: 'info', actor: 'publisher', action: 'publication.created', entityType: 'publication', entityId: pid,
        message: `Публикация ${PLATFORM_LABELS[platform] || platform}${privacy !== 'public' ? ' (приватно — клиент не аудирован)' : ''}: ${episode.title}`,
        meta: { privacy, click: `/t/${clickToken}`, cover: coverPath, video: episode.video_path, forecast: forecast.expectedViews },
      });
    }
  }

  // ── Итог: сколько площадок закрыто, что осталось ──────────────────────────
  const remaining = [...missing, ...blocked].filter(Boolean);
  if (created.length) {
    const lastForecast = forecastEpisode({ episode, project, platform: targets[0].platform, scheduledAt: nowIso() });
    touchEpisode(episodeId, {
      forecast: JSON.stringify(lastForecast),
      cost_cents: num(episode.cost_cents, 0),
    });
  }

  if (created.length && !remaining.length) {
    episode = touchEpisode(episodeId, { status: 'published', stage: 'published', published_at: nowIso(), progress: 100, error: null });
    log({
      level: 'success', actor: 'publisher', action: 'episode.published', entityType: 'episode', entityId: episodeId,
      message: `Опубликовано: «${episode.title}» — ${new Set(targets.map((t) => t.platform)).size} площадк${targets.length > 1 ? 'и' : 'а'}, ${created.length} публикаци${created.length > 1 ? 'и' : 'я'}`,
      meta: { publications: created, platforms: targets.map((t) => `${t.platform}@${t.account.handle}`) },
    });
    return;
  }

  const postpone = addMinutes(nowIso(), 30 + Math.floor(Math.random() * 20));
  touchEpisode(episodeId, {
    status: 'scheduled',
    scheduled_at: postpone,
    error: remaining.length ? `Ждём квоту: ${remaining.join(', ')}` : null,
  });
  enqueue('episode.publish', { episodeId }, { delayMs: 32 * 60000, priority: 2 });
  log({
    level: created.length ? 'info' : 'warn', actor: 'publisher', action: 'publish.partial', entityType: 'episode', entityId: episodeId,
    message: created.length
      ? `Опубликовано частично (${created.length}), остались площадки: ${remaining.join(', ')} — повтор через ~30 мин`
      : `Публикация перенесена: ${remaining.join(', ') || 'нет аккаунта'}`,
    meta: { created, remaining },
  });
});

/** Маркировка рекламы и ИИ — ровно один раз, без повторов при пересборке */
function withDisclosure(caption, disclosure) {
  const text = String(caption || '').trim();
  if (!disclosure) return text;
  const hasAi = /создано с помощью ИИ/i.test(text);
  const hasAd = /(^|\s)Реклама\./.test(text) || /\berid\s*:/i.test(text);
  const needAi = /ИИ/.test(disclosure) && !hasAi;
  const needAd = /Реклама/.test(disclosure) && !hasAd;
  if (!needAi && !needAd) return text;
  const parts = [];
  if (needAd) parts.push(disclosure.match(/Реклама[^.]*\./)?.[0] || 'Реклама.');
  if (needAi) parts.push('Видео создано с помощью ИИ.');
  return `${text}\n\n${parts.join(' ')}`.trim();
}

/**
 * Описание под площадку. Если для эпизода собран креативный пакет, берём готовый
 * текст именно этой площадки: у TikTok ссылку в описании не кликнуть, у Reels
 * работает кликабельная ссылка, у YouTube — короткое описание и теги.
 * Вариант B — «второй заход» для A/B, а не копия.
 */
function buildCaption({ episode, project, product, platform, variant, hashtags }) {
  const pack = parseJson(episode.creative, null);
  if (variant !== 'B' && pack?.captions?.[platform]) {
    return String(pack.captions[platform]).slice(0, PLATFORM_API_LIMITS[platform]?.description || 2200);
  }
  if (variant !== 'B') {
    return platformCaption({ caption: episode.description, hashtags }, platform, product);
  }
  const firstLine = String(episode.description || '').split('\n')[0];
  return platformCaption({
    caption: `${firstLine} ${pick(['Проверяем короткую версию — суть в двух строках.', 'Короткий заход: только главное.', 'Альтернативный вариант без лишних слов.'])}`,
    hashtags: hashtagsFor(project || {}, platform, { tags: hashtags }, 6),
  }, platform, product);
}

function pickPlatforms(project) {
  // Площадка участвует, только если есть аккаунт, который реально может
  // публиковать И ведёт этот бренд. Иначе ролик FitFlow бесконечно ждал бы
  // свободный TikTok-аккаунт, который принадлежит другому бренду.
  const rows = db.prepare(`SELECT DISTINCT platform FROM accounts
      WHERE status IN ('healthy','warmup') AND (project_id IS NULL OR project_id = ?)`)
    .all(project?.id || null);
  const accounts = rows.map((r) => r.platform);
  if (!accounts.length) return PLATFORMS;
  return accounts;
}

function episodesVideoRef(episode) {
  return `episodes/${episode.id}/final.mp4`;
}



// ── Автопилот: наполнение очереди ───────────────────────────────────────────
registerHandler('autopilot.tick', async () => {
  const settings = getSettings();

  // Раз в час: закрываем A/B-тесты и корректируем интенсивность по деньгам.
  // Это не «магия»: каждое решение попадает в журнал с причиной и ROI.
  if (Date.now() - Number(globalThis.__lastSmartLoop || 0) > 3600000) {
    globalThis.__lastSmartLoop = Date.now();
    try {
      const decided = evaluateAB();
      const policy = autopilotPolicy({ apply: true });
      recalculateAccountQuality({ apply: true });
      // веса вирусного скора пересчитываются на новых роликах (если их достаточно)
      const weights = recalibrate();
      const scaled = policy.filter((p) => p.changed);
      if (decided.length || scaled.length) {
        log({
          level: 'info', actor: 'autopilot', action: 'autopilot.smart', entityType: 'system',
          message: `Умный цикл: закрыто A/B — ${decided.length}, изменено темпов — ${scaled.length}, веса скора — ${weights.ready ? 'обновлены' : 'приоры'}`,
          meta: { decided: decided.map((d) => `${d.title}: ${d.winner}`), scaled: scaled.map((p) => `${p.name}: ${p.postsPerDay}/день`) },
        });
      }
    } catch (err) {
      log({ level: 'warn', actor: 'autopilot', action: 'autopilot.smart_failed', message: String(err.message || err) });
    }
  }

  if (Number(settings.autopilot_global) !== 1) return;

  // реклама: раздаём активные кампании по роликам, у которых ещё нет спонсора
  try {
    const filled = autofillCampaigns({ limit: 4 });
    if (filled.length) {
      log({
        level: 'info', actor: 'ads', action: 'campaign.autofill', entityType: 'system',
        message: `Кампании разложены по роликам: ${filled.map((f) => f.name).join(', ')}`, meta: { filled },
      });
    }
  } catch (err) {
    log({ level: 'warn', actor: 'ads', action: 'campaign.autofill_failed', message: String(err.message || err) });
  }
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

    const plan = nextSlotPlan(project.id);
    const idea = db.prepare("SELECT * FROM ideas WHERE project_id = ? AND status = 'new' ORDER BY score DESC, created_at ASC LIMIT 1").get(project.id);
    const ep = createEpisode({ projectId: project.id, ideaId: idea?.id || null, scheduledAt: plan.at });
    log({
      level: 'info', actor: 'autopilot', action: 'autopilot.fill', entityType: 'episode', entityId: ep.id,
      message: `Автопилот добавил в конвейер: «${ep.title}» — ${plan.reason}`,
      meta: { projectId: project.id, slot: plan.at, hour: plan.hour, source: plan.source },
    });
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

  // Подписчики на аккаунтах: в live — из API канала, в demo — накопленный прирост
  const followerDelta = new Map();
  if (isLive) {
    for (const a of db.prepare('SELECT * FROM accounts').all()) {
      const audience = await providers.stats.audience({ platform: a.platform, account: a }).catch(() => null);
      if (audience && Number.isFinite(audience.followers)) {
        db.prepare("UPDATE accounts SET followers = ?, followers_source = 'api', followers_updated_at = ? WHERE id = ?")
          .run(audience.followers, nowIso(), a.id);
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
    // удержание в demo: база площадки + качество аккаунта + «зашло ли» ролик.
    // Формула та же по смыслу, что и в seed, поэтому графики сходятся.
    const accountQuality = db.prepare('SELECT quality FROM accounts WHERE id = ?').get(p.account_id)?.quality ?? 75;
    const baseRetention = p.platform === 'youtube' ? 52 : p.platform === 'tiktok' ? 46 : 50;
    const retained = clamp(baseRetention + (accountQuality - 70) * 0.25 + (p.id.charCodeAt(5) % 12) + 4, 35, 88);
    db.prepare(`UPDATE publications SET views = ?, likes = ?, comments = ?, shares = ?, clicks = ?, followers = ?, watch_avg = ?
      WHERE id = ?`).run(views, likes, comments, shares, clicks, followers, Math.round(retained * 10) / 10, p.id);
    // пишем только прирост относительно уже сохранённого итога публикации
    const dViews = views - p.views;
    const dLikes = Math.max(0, likes - p.likes);
    const dComments = Math.max(0, comments - p.comments);
    const dShares = Math.max(0, shares - p.shares);
    const dClicks = Math.max(0, clicks - p.clicks);
    const dFollowers = Math.max(0, followers - p.followers);
    if (dViews > 0) upsertDay.run(`${p.id}:${day}`, p.id, day, dViews, dLikes, dComments, dShares, dClicks, dFollowers);
    if (!isLive) followerDelta.set(p.account_id, (followerDelta.get(p.account_id) || 0) + dFollowers);
    updated++;
  }
  // в demo подписчики аккаунта растут из факта: сколько подписок принесли наши ролики
  for (const [accountId, delta] of followerDelta) {
    if (!accountId || !delta) continue;
    db.prepare("UPDATE accounts SET followers = COALESCE(followers,0) + ?, followers_updated_at = ? WHERE id = ?")
      .run(delta, nowIso(), accountId);
  }

  // спонсорские деньги считаются из тех же фактических просмотров
  try {
    syncCampaignMetrics();
  } catch { /* метрики рекламы не должны ломать сбор аналитики */ }

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
