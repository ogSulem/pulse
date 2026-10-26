// ─────────────────────────────────────────────────────────────────────────────
// Сериалы: сервисный слой между движком сценария, рендером и деньгами.
//
// Один сериал = библия + сезон + серии. Здесь:
//   • создание сериала и правка библии (мир, герои, правила, дисклеймер);
//   • план сезона и генерация сценария серии с аудитом оригинальности;
//   • озвучка секциями (лимиты TTS) и сборка видео 16:9 фото-рядом;
//   • вертикальные нарезки, которые приводят зрителя из Shorts в сериал;
//   • публикация на YouTube обычным видео с добавлением в плейлист сезона;
//   • экономика: часы для YPP, путь к цели по деньгам, окупаемость серии.
//
// Ничего не «делается само» в фоне: каждое действие запускается явно из UI,
// потому что рендер 15-минутной серии — это минуты CPU, а не секунды.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { db, getSettings, nowIso } from '../core/db.js';
import { uid, num, clamp, parseJson, addDays } from '../core/utils.js';
import { log } from '../core/logger.js';
import { enqueue } from '../core/queue.js';
import { providers } from '../providers/index.js';
import { SERIES_GENRES, SERIES_GENRES_LIST, buildBible, planSeason, buildEpisode, authenticityAudit, seriesEconomics, planCuts, revenueForecast } from './serial.js';
import { planVoiceSections, renderSeriesEpisode, renderSeriesCut, seriesRenderInfo } from './serialrender.js';
import { MEDIA_DIR } from './render.js';
import { createEpisode, touchEpisode, nextSlot } from './pipeline.js';
import { decryptSecret } from '../core/secrets.js';

const STAGES = {
  planned: 'План',
  script: 'Сценарий',
  voice: 'Озвучка',
  render: 'Сборка',
  review: 'На проверке',
  scheduled: 'Запланирован',
  published: 'Опубликован',
  failed: 'Ошибка',
};

const safeId = (id) => String(id || '').replace(/[^a-z0-9_]/gi, '');

export function seriesRow(s, { withEpisodes = false } = {}) {
  if (!s) return null;
  const bible = parseJson(s.bible, {});
  const plan = parseJson(s.season_plan, {});
  const row = {
    ...s,
    bible,
    season_plan: plan,
    genre_label: SERIES_GENRES[s.genre]?.label || s.genre,
    rpm_range: SERIES_GENRES[s.genre]?.rpm || [120, 260],
    episodes_planned: num(s.episodes_planned, 6),
    episode_sec: num(s.episode_sec, 900),
    minutes: Math.round(num(s.episode_sec, 900) / 60),
    episodes_ready: db.prepare("SELECT COUNT(*) c FROM series_episodes WHERE series_id = ? AND stage IN ('review','scheduled','published')").get(s.id)?.c || 0,
    episodes_total: db.prepare('SELECT COUNT(*) c FROM series_episodes WHERE series_id = ?').get(s.id)?.c || 0,
    published: db.prepare("SELECT COUNT(*) c FROM series_episodes WHERE series_id = ? AND stage = 'published'").get(s.id)?.c || 0,
    views: db.prepare('SELECT COALESCE(SUM(views),0) v FROM series_episodes WHERE series_id = ?').get(s.id)?.v || 0,
    revenue_cents: db.prepare('SELECT COALESCE(SUM(revenue_cents),0) v FROM series_episodes WHERE series_id = ?').get(s.id)?.v || 0,
  };
  if (withEpisodes) row.episode_list = listEpisodes(s.id);
  return row;
}

export function episodeRow(e) {
  if (!e) return null;
  return {
    ...e,
    script: parseJson(e.script, {}),
    scenes: parseJson(e.scenes, []),
    chapters: parseJson(e.chapters, []),
    cuts: parseJson(e.cuts, []),
    tags: parseJson(e.tags, []),
    title_variants: parseJson(e.title_variants, []),
    scores: parseJson(e.scores, {}),
    authenticity: parseJson(e.authenticity, {}),
    forecast: parseJson(e.forecast, {}),
    frames: parseJson(e.frames, []),
    cover_paths: parseJson(e.cover_paths, {}),
    stage_label: STAGES[e.stage] || e.stage,
    minutes: Math.round((num(e.duration_sec, 0) / 60) * 10) / 10,
    revenue_rub: Math.round(num(e.revenue_cents, 0) / 100),
    // ссылка на опубликованное видео: без неё карточка серии бесполезна после выхода
    url: e.external_id ? `https://www.youtube.com/watch?v=${e.external_id}` : null,
  };
}

export function listSeries({ projectId = null } = {}) {
  const rows = projectId
    ? db.prepare('SELECT * FROM series WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
    : db.prepare('SELECT * FROM series ORDER BY created_at DESC').all();
  return rows.map((r) => seriesRow(r));
}

export function getSeries(id) {
  return seriesRow(db.prepare('SELECT * FROM series WHERE id = ?').get(id), { withEpisodes: true });
}

export function listEpisodes(seriesId) {
  return db.prepare('SELECT * FROM series_episodes WHERE series_id = ? ORDER BY episode_no ASC').all(seriesId).map(episodeRow);
}

export function getEpisode(id) {
  return episodeRow(db.prepare('SELECT * FROM series_episodes WHERE id = ?').get(id));
}

export function genres() {
  return SERIES_GENRES_LIST;
}

/** Создание сериала: библия строится сразу, чтобы UI показал мир и героев. */
export function createSeries({ title, genre = 'zombie', premise = '', tone = 'cinematic', projectId = null, episodesPlanned = 6, episodeSec = 900, startAt = null }) {
  const cleanTitle = String(title || '').trim().slice(0, 120);
  if (!cleanTitle) throw new Error('Нужно название сериала');
  const g = SERIES_GENRES[genre] ? genre : 'zombie';
  const bible = buildBible({ title: cleanTitle, genre: g, premise, tone });
  const id = uid('sr_');
  const now = nowIso();
  const episodes_planned = clamp(num(episodesPlanned, 6), 3, 8);
  const episode_sec = clamp(num(episodeSec, 900), 480, 1800);
  db.prepare(`INSERT INTO series (id, project_id, title, genre, premise, tone, bible, season, episodes_planned, episode_sec, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'draft', ?, ?)`).run(
    id, projectId, cleanTitle, g, String(premise || '').slice(0, 1200), tone, JSON.stringify(bible), episodes_planned, episode_sec, now, now,
  );
  log({ level: 'info', actor: 'series', action: 'series.create', entityType: 'series', entityId: id, message: `Сериал «${cleanTitle}» (${g})`, meta: { episodes_planned, episode_sec } });
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(id);
  planSeasonFor(id, { startAt });
  return getSeries(id);
}

export function updateSeries(id, patch = {}) {
  const current = db.prepare('SELECT * FROM series WHERE id = ?').get(id);
  if (!current) throw new Error('Сериал не найден');
  const allowed = ['title', 'genre', 'premise', 'tone', 'status', 'playlist_id', 'show_id', 'project_id', 'notes'];
  const sets = [];
  const args = [];
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    sets.push(`${key} = ?`);
    args.push(patch[key]);
  }
  if (patch.episodes_planned !== undefined) {
    sets.push('episodes_planned = ?');
    args.push(clamp(num(patch.episodes_planned, 6), 3, 8));
  }
  if (patch.episode_sec !== undefined) {
    sets.push('episode_sec = ?');
    args.push(clamp(num(patch.episode_sec, 900), 480, 1800));
  }
  if (patch.bible !== undefined) {
    sets.push('bible = ?');
    args.push(JSON.stringify(patch.bible));
  }
  if (!sets.length) return getSeries(id);
  sets.push('updated_at = ?');
  args.push(nowIso(), id);
  db.prepare(`UPDATE series SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getSeries(id);
}

/** Пересобрать библию с нуля (новая вариация мира при том же названии). */
export function rebuildBible(id, { variant = 0 } = {}) {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(id);
  if (!s) throw new Error('Сериал не найден');
  const bible = buildBible({ title: `${s.title}${variant ? ` ${variant}` : ''}`, genre: s.genre, premise: s.premise, tone: s.tone });
  bible.title = s.title;
  db.prepare('UPDATE series SET bible = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(bible), nowIso(), id);
  return getSeries(id);
}

export function planSeasonFor(id, { startAt = null, perWeek = 2 } = {}) {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(id);
  if (!s) throw new Error('Сериал не найден');
  const plan = planSeason({ series: s, startAt, perWeek });
  db.prepare('UPDATE series SET season_plan = ?, cadence = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(plan), plan.cadence, nowIso(), id);
  return plan;
}

function episodeSlotDate(seriesId, episodeNo) {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
  const plan = parseJson(s?.season_plan, {});
  const planned = plan.episodes?.find((e) => e.number === episodeNo)?.publishAt;
  return planned || addDays(nowIso(), (episodeNo - 1) * 3);
}

/**
 * Сценарий серии. Сравниваем с уже готовыми сериями сезона: дословные повторы
 * между сериями — главный признак масс-продакшна, за который в 2026 снимают
 * монетизацию.
 */
export function composeEpisode({ seriesId, episodeNo = 1, targetSec = null, variant = 0 }) {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!s) throw new Error('Сериал не найден');
  const bible = parseJson(s.bible, {});
  const plan = parseJson(s.season_plan, {})?.episodes ? parseJson(s.season_plan, {}) : planSeason({ series: s });

  const siblings = db.prepare("SELECT scenes FROM series_episodes WHERE series_id = ? AND episode_no <> ?").all(seriesId, episodeNo);
  const siblingScenes = siblings.flatMap((r) => parseJson(r.scenes, []).map((x) => x.text)).filter(Boolean);

  const ep = buildEpisode({ series: s, episodeNo, targetSec: targetSec || s.episode_sec, bible, seasonPlan: plan, variant });
  const audit = authenticityAudit({
    series: s, bible, scenes: ep.scenes, episodeNo, plan: plan.episodes?.[episodeNo - 1],
    wpm: ep.wpm, durationSec: ep.durationSec, midRolls: ep.midRolls, siblingScenes,
  });
  const sections = planVoiceSections({ scenes: ep.scenes });

  const existing = db.prepare('SELECT * FROM series_episodes WHERE series_id = ? AND episode_no = ?').get(seriesId, episodeNo);
  const now = nowIso();
  const payload = {
    title: ep.title,
    logline: ep.logline,
    arc: plan.episodes?.[episodeNo - 1]?.arc || '',
    script: JSON.stringify({
      ...ep,
      sections,
      variant,
      siblingSimilarity: audit.similarity,
    }),
    scenes: JSON.stringify(ep.scenes),
    chapters: JSON.stringify(ep.chapters),
    duration_sec: ep.durationSec,
    words: ep.words,
    wpm: ep.wpm,
    mid_rolls: ep.midRolls,
    rolls_at: JSON.stringify(ep.rollsAt),
    description: ep.description,
    tags: JSON.stringify(ep.tags),
    thumb_text: ep.thumbText,
    title_variants: JSON.stringify(ep.titleVariants),
    scores: JSON.stringify(ep.scores),
    authenticity: JSON.stringify(audit),
    forecast: JSON.stringify(ep.forecast),
    disclosure: ep.disclosure,
    frames: JSON.stringify(ep.frames),
    stage: 'script',
    error: null,
    updated_at: now,
  };

  if (existing) {
    const sets = Object.keys(payload).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE series_episodes SET ${sets} WHERE id = ?`).run(...Object.values(payload), existing.id);
    return getEpisode(existing.id);
  }
  const id = uid('se_');
  const keys = ['id', 'series_id', 'project_id', 'episode_no', 'publish_at', 'created_at', ...Object.keys(payload)];
  const values = [id, seriesId, s.project_id || null, episodeNo, episodeSlotDate(seriesId, episodeNo), now, ...Object.values(payload)];
  db.prepare(`INSERT INTO series_episodes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...values);
  log({ level: 'info', actor: 'series', action: 'episode.compose', entityType: 'series_episode', entityId: id, message: `Серия ${episodeNo} «${ep.title}»: ${Math.round(ep.durationSec / 60)} мин, аудит ${audit.score}`, meta: { wpm: ep.wpm, midRolls: ep.midRolls } });
  return getEpisode(id);
}

export function updateEpisode(id, patch = {}) {
  const current = db.prepare('SELECT * FROM series_episodes WHERE id = ?').get(id);
  if (!current) throw new Error('Серия не найдена');
  const allowed = ['title', 'description', 'thumb_text', 'publish_at', 'stage', 'tags', 'title_variants', 'script', 'scenes'];
  const sets = [];
  const args = [];
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    const value = typeof patch[key] === 'object' ? JSON.stringify(patch[key]) : patch[key];
    sets.push(`${key} = ?`);
    args.push(value);
  }
  if (!sets.length) return getEpisode(id);
  sets.push('updated_at = ?');
  args.push(nowIso(), id);
  db.prepare(`UPDATE series_episodes SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getEpisode(id);
}

function seriesBudget(settings) {
  // Себестоимость серии считаем по факту: длинная озвучка дороже короткой
  // пропорционально числу знаков, а рендер 15 минут CPU-тяжёлый.
  return {
    voiceRubPer1000: num(settings.cost_tts_1000, 180),
    renderRubPerMin: num(settings.cost_render_min, 6),
    llmRub: num(settings.cost_llm, 8),
  };
}

/** Озвучка: секции → mp3 в data/media. В demo-режиме тайминг считается по словам. */
export async function synthesizeEpisode(id, { voiceId = null } = {}) {
  const ep = getEpisode(id);
  if (!ep) throw new Error('Серия не найдена');
  const script = ep.script || {};
  const sections = Array.isArray(script.sections) && script.sections.length
    ? script.sections
    : planVoiceSections({ scenes: ep.scenes });

  const voice = voiceId || process.env.TTS_VOICE_ID || 'ru-narrator';
  const results = [];
  for (const [i, section] of sections.entries()) {
    const res = await providers.tts.synthesize({ text: section.text, voiceId: voice });
    let file = null;
    if (res.audioBuffer) {
      file = path.join(MEDIA_DIR, `${safeId(id)}-v${i + 1}.mp3`);
      fs.writeFileSync(file, res.audioBuffer);
    }
    results.push({ index: i, chars: section.chars, provider: res.provider, audioPath: file, estimateSec: res.durationSec });
  }

  const settings = getSettings();
  const budget = seriesBudget(settings);
  const chars = sections.reduce((a, s) => a + String(s.text || '').length, 0);
  const voiceRub = Math.round((chars / 1000) * budget.voiceRubPer1000);
  const renderRub = Math.round((num(ep.duration_sec, 900) / 60) * budget.renderRubPerMin);
  const costCents = Math.round((voiceRub + renderRub + budget.llmRub) * 100);
  const audioSec = results.reduce((a, r) => a + num(r.estimateSec, 0), 0);

  const nextScript = { ...script, sections: sections.map((s, i) => ({ ...s, audioPath: results[i].audioPath, provider: results[i].provider })) };
  db.prepare('UPDATE series_episodes SET script = ?, audio_path = ?, audio_sec = ?, cost_cents = ?, stage = ?, error = NULL, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(nextScript), results[0]?.audioPath || null, audioSec, costCents, 'voice', nowIso(), id);

  log({
    level: 'info', actor: 'series', action: 'episode.voice', entityType: 'series_episode', entityId: id,
    message: `Озвучка серии: ${sections.length} секций, ${chars} знаков, ${results[0]?.provider || 'demo'}${results[0]?.audioPath ? '' : ' (без файла: демо-режим)'}`,
    meta: { chars, audioSec, costCents },
  });

  return { ok: true, sections: results.length, chars, audioSec, costCents, files: results.filter((r) => r.audioPath).length, demo: results.every((r) => !r.audioPath) };
}

/** Сборка серии: фото-ряд 16:9 + субтитры + озвучка, если она уже есть. */
export async function renderEpisodeById(id, { onProgress = null } = {}) {
  const ep = getEpisode(id);
  if (!ep) throw new Error('Серия не найдена');
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(ep.series_id);
  const info = seriesRenderInfo();
  if (!info.available) throw new Error('Рендер недоступен: нет ffmpeg/sharp в окружении');

  const script = ep.script || {};
  const sections = Array.isArray(script.sections) ? script.sections : [];
  const audioPaths = sections.map((s) => s.audioPath).filter((p) => p && fs.existsSync(p));

  db.prepare("UPDATE series_episodes SET stage = 'render', error = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id);
  try {
    const out = await renderSeriesEpisode({
      series: { ...series, genre_label: SERIES_GENRES[series.genre]?.label },
      episode: ep,
      scenes: ep.scenes,
      frames: ep.frames,
      sections,
      audioPaths,
      handle: series.handle || 'pulse',
      coverText: ep.thumb_text || series.title,
      workId: id,
      onProgress,
    });
    db.prepare(`UPDATE series_episodes SET video_path = ?, video_bytes = ?, render_ms = ?, cover_paths = ?, stage = 'review', error = NULL, updated_at = ? WHERE id = ?`)
      .run(out.videoPath, out.bytes, out.renderMs, JSON.stringify(out.coverPaths), nowIso(), id);
    log({ level: 'info', actor: 'series', action: 'episode.render', entityType: 'series_episode', entityId: id, message: `Серия собрана: ${out.width}×${out.height}, ${(out.bytes / 1048576).toFixed(1)} МБ, ${Math.round(out.renderMs / 1000)} с`, meta: { durationSec: out.durationSec, scenes: out.scenes, audio: out.audio } });
    return { ok: true, ...out, episode: getEpisode(id) };
  } catch (err) {
    db.prepare("UPDATE series_episodes SET stage = 'failed', error = ?, updated_at = ? WHERE id = ?").run(String(err.message || err).slice(0, 500), nowIso(), id);
    log({ level: 'error', actor: 'series', action: 'episode.render_failed', entityType: 'series_episode', entityId: id, message: `Сборка не удалась: ${err.message}` });
    throw err;
  }
}

/** Регенерация сценария (другая вариация текста) с повторным аудитом. */
export function recomposeEpisode(id, { variant = null } = {}) {
  const ep = getEpisode(id);
  if (!ep) throw new Error('Серия не найдена');
  const script = ep.script || {};
  const nextVariant = variant ?? num(script.variant, 0) + 1;
  return composeEpisode({ seriesId: ep.series_id, episodeNo: ep.episode_no, targetSec: num(ep.duration_sec, 900), variant: nextVariant });
}

/** Нарезки: план + сборка вертикальных клипов. */
export function planEpisodeCuts(id, { count = 3 } = {}) {
  const ep = getEpisode(id);
  if (!ep) throw new Error('Серия не найдена');
  const cuts = planCuts({ episode: { scenes: ep.scenes, cutSec: 28 }, count: clamp(num(count, 3), 1, 5) });
  const enriched = cuts.map((c) => {
    const scene = ep.scenes.find((s) => s.n === ep.scenes.find((x) => x.text === c.text)?.n) || ep.scenes[0] || {};
    return {
      ...c,
      episodeNo: ep.episode_no,
      scenery: scene.frame?.scenery || scene.visual || 'city',
      text: c.text,
    };
  });
  db.prepare('UPDATE series_episodes SET cuts = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(enriched), nowIso(), id);
  return enriched;
}

export async function renderEpisodeCuts(id, { onProgress = null } = {}) {
  const ep = getEpisode(id);
  if (!ep) throw new Error('Серия не найдена');
  if (!ep.cuts?.length) planEpisodeCuts(id);
  const fresh = getEpisode(id);
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(fresh.series_id);
  const info = seriesRenderInfo();
  if (!info.available) throw new Error('Рендер недоступен: нет ffmpeg/sharp');

  const done = [];
  for (const cut of fresh.cuts) {
    const out = await renderSeriesCut({
      series: { ...series, title: series.title },
      cut,
      paletteIndex: 0,
      handle: 'pulse',
      workId: fresh.id,
    });
    done.push({
      ...cut,
      videoPath: out.videoPath,
      bytes: out.bytes,
      width: out.width,
      height: out.height,
      seconds: out.seconds,
      caption: `${cut.title}\n\nПолная серия — в профиле.`,
    });
    onProgress?.({ phase: 'cuts', done: done.length, total: fresh.cuts.length });
  }
  db.prepare('UPDATE series_episodes SET cuts = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(done), nowIso(), id);
  log({ level: 'info', actor: 'series', action: 'episode.cuts', entityType: 'series_episode', entityId: id, message: `Нарезки собраны: ${done.length}` });
  return done;
}

/**
 * Нарезки → обычная очередь коротких роликов.
 *
 * Это главный источник трафика для сериала: вертикальный клип ловит зрителя в
 * Shorts/TikTok, а в описании и на экране — «полная серия в профиле». Дальше
 * ролик живёт своей жизнью: креатив, комплаенс, лимиты площадок и публикация
 * берутся из существующего конвейера, дублировать его здесь нельзя.
 */
export function pushCutsToQueue(id, { platform = 'reels', count = null, startAt = null } = {}) {
  const ep = getEpisode(id);
  if (!ep) throw new Error('Серия не найдена');
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(ep.series_id);
  const projectId = series.project_id
    || db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get()?.id;
  if (!projectId) throw new Error('Нет проекта: нарезкам нужен бренд для описания и ссылок');

  let cuts = ep.cuts || [];
  if (!cuts.length) cuts = planEpisodeCuts(id, { count: count || 3 });
  const picked = count ? cuts.slice(0, count) : cuts;

  const created = [];
  let slot = startAt || nowIso();
  for (const cut of picked) {
    const scenes = splitCutScenes(cut);
    const episode = createEpisode({
      projectId,
      title: cut.title?.slice(0, 90) || `Сериал «${series.title}»: серия ${ep.episode_no}`,
      scheduledAt: slot,
    });
    touchEpisode(episode.id, {
      scenes: JSON.stringify(scenes),
      description: cutCaption({ series, ep, cut }),
      hashtags: JSON.stringify(['сериал', 'история', 'shorts', 'нарезка']),
      caption_platform: platform,
      promo: 'soft',
      creative: JSON.stringify({ source: 'series', seriesId: series.id, episodeId: ep.id, cut: cut.index }),
    });
    created.push({ episodeId: episode.id, title: cut.title, scenes: scenes.length });
    slot = nextSlot(projectId, slot);
  }

  log({
    level: 'info', actor: 'series', action: 'cuts.queued', entityType: 'series_episode', entityId: id,
    message: `Нарезки в очереди: ${created.length} роликов на площадку ${platform}`,
    meta: { count: created.length, platform },
  });
  return created;
}

function splitCutScenes(cut) {
  // Нарезка должна начинаться с крючка и кончаться призывом: два-три титра
  // держат 20–30 секунд, больше — и это уже не нарезка, а вторая серия.
  const text = String(cut.text || '').trim();
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const hook = sentences[0] || text.slice(0, 80);
  const rest = sentences.slice(1).join(' ');
  const body = rest || text.slice(80, 200);
  const tail = `Полная серия — ${cut.episodeNo || 1} в профиле.`;
  const total = Math.max(15, Math.min(60, num(cut.seconds, 28)));
  const parts = [
    { text: hook, weight: 0.34 },
    { text: body, weight: 0.46 },
    { text: tail, weight: 0.2 },
  ].filter((p) => p.text);
  const sum = parts.reduce((a, p) => a + p.weight, 0);
  return parts.map((p, i) => ({
    text: p.text.slice(0, 220),
    seconds: Math.max(2.5, Math.round(((total * p.weight) / sum) * 10) / 10),
    index: i,
    role: i === 0 ? 'hook' : i === parts.length - 1 ? 'cta' : 'body',
  }));
}

function cutCaption({ series, ep, cut }) {
  return [
    cut.title || `Сериал «${series.title}»`,
    '',
    `Серия ${ep.episode_no}${ep.title ? ` · ${ep.title}` : ''} — целиком в профиле, все серии идут по порядку в плейлисте «${series.title}».`,
    '',
    ep.disclosure || 'Художественная история. Текст и озвучка созданы с помощью ИИ; персонажи вымышлены.',
  ].join('\n');
}

function youtubeAccount(projectId = null) {
  const rows = projectId
    ? db.prepare("SELECT * FROM accounts WHERE platform = 'youtube' AND status IN ('healthy','warmup') AND (project_id = ? OR project_id IS NULL) ORDER BY quality DESC").all(projectId)
    : db.prepare("SELECT * FROM accounts WHERE platform = 'youtube' AND status IN ('healthy','warmup') ORDER BY quality DESC").all();
  return rows.find((a) => a.access_token) || rows[0] || null;
}

function publicUrl() {
  return String(process.env.PULSE_PUBLIC_URL || '').replace(/\/$/, '');
}

/**
 * Публикация серии. Длинное видео уходит обычной загрузкой (не Shorts), затем
 * попадает в плейлист сезона. Плейлист создаётся автоматически при первой
 * публикации — это и есть «Shows»: серии идут по порядку, автоплей следующий.
 */
/**
 * Ставим серию в расписание: серия должна быть собрана (есть файл), иначе
 * расписание бессмысленно — рендер идёт минутами и не может ждать дедлайна.
 */
export function scheduleEpisode(id, { publishAt = null } = {}) {
  const ep = getEpisode(id);
  if (!ep) throw new Error('Серия не найдена');
  if (!ep.video_path) throw new Error('Сначала соберите серию: без файла публиковать нечего');
  const at = publishAt || ep.publish_at || nowIso();
  db.prepare("UPDATE series_episodes SET stage = 'scheduled', publish_at = ?, error = NULL, updated_at = ? WHERE id = ?")
    .run(at, nowIso(), id);
  log({ level: 'info', actor: 'series', action: 'episode.scheduled', entityType: 'series_episode', entityId: id, message: `Серия ${ep.episode_no} в расписании на ${at}` });
  return getEpisode(id);
}

/**
 * Планировщик серий. Работает как sweepDueEpisodes для коротких роликов:
 * пришло время — ставим задачу публикации в общую очередь, а не публикуем
 * внутри тика (загрузка файла может идти минутами).
 * Выключается настройкой series_autopublish = 0.
 */
export function sweepDueSeriesEpisodes({ now = nowIso() } = {}) {
  const settings = getSettings();
  if (num(settings.series_autopublish, 1) !== 1) return 0;
  const due = db.prepare(`SELECT id, episode_no FROM series_episodes
      WHERE stage = 'scheduled' AND publish_at <= ? AND video_path IS NOT NULL AND COALESCE(external_id, '') = ''
      ORDER BY publish_at ASC LIMIT 12`).all(now);
  let n = 0;
  const busyStmt = db.prepare(`SELECT 1 x FROM jobs WHERE status IN ('pending','running')
      AND type = 'series.publish' AND payload LIKE ? LIMIT 1`);
  for (const ep of due) {
    // задача уже стоит — не плодим вторую копию каждые 20 секунд
    if (busyStmt.get(`%${ep.id}%`)) continue;
    enqueue('series.publish', { episodeId: ep.id }, { priority: 3, dedupeKey: `series-publish:${ep.id}` });
    n++;
  }
  return n;
}

export async function publishEpisodeToYoutube(id, { privacy = null } = {}) {
  const ep = getEpisode(id);
  if (!ep) throw new Error('Серия не найдена');
  if (!ep.video_path) throw new Error('Нет собранного видео: сначала соберите серию');
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(ep.series_id);
  const settings = getSettings();
  const account = youtubeAccount(series.project_id);
  if (!account) throw new Error('Нет YouTube-аккаунта: подключите канал в разделе «Аккаунты»');

  const abs = path.join(MEDIA_DIR, path.basename(ep.video_path));
  if (!fs.existsSync(abs)) throw new Error('Файл серии не найден на диске');

  // Маркировка: ИИ-контент и «вымышленная история» обязательны в описании,
  // а чекбокс «altered or synthetic content» YouTube ставит только в Студии —
  // поэтому возвращаем напоминание прямо в ответе.
  const disclosure = ep.disclosure || 'Художественная история. Текст и озвучка созданы с помощью ИИ под редакцией автора; персонажи вымышлены.';
  const privacyStatus = privacy || (num(settings.youtube_audited, 0) ? 'public' : 'private');

  const token = account.access_token ? decryptSecret(account.access_token) : null;
  // В demo-режиме площадка не вызывается вообще: как и для коротких роликов,
  // провайдер возвращает правдоподобную заглушку. Иначе кнопка «Опубликовать»
  // падала бы у каждого, кто просто открыл панель и нажал её.
  const demo = String(process.env.PULSE_MODE || 'demo') !== 'live' || !token;
  const { uploadVideo, createPlaylist } = await import('../providers/social/youtube.js');

  let playlistId = series.playlist_id || null;
  if (!playlistId && demo) {
    playlistId = `PL_demo_${(series.id || '').replace(/[^a-z0-9]/gi, '').slice(-10) || 'pulse'}`;
    db.prepare('UPDATE series SET playlist_id = ?, updated_at = ? WHERE id = ?').run(playlistId, nowIso(), series.id);
  }
  if (!playlistId) {
    try {
      const pl = await createPlaylist({
        token,
        title: `${series.title} — все серии`,
        description: `${series.bible ? parseJson(series.bible, {}).premise || '' : ''}\n\nСерии по порядку.`,
        privacy: privacyStatus === 'public' ? 'public' : 'unlisted',
      });
      playlistId = pl.playlistId;
      db.prepare('UPDATE series SET playlist_id = ?, updated_at = ? WHERE id = ?').run(playlistId, nowIso(), series.id);
    } catch (err) {
      log({ level: 'warn', actor: 'series', action: 'playlist.failed', message: `Плейлист не создан: ${err.message}` });
    }
  }

  // Плейлист — это не украшение: он тянет следующую серию автоплеем и
  // добавляет сессии. Ссылку кладём в описание, чтобы зритель мог уйти в
  // сериал с любого места, а не искать канал.
  const playlistUrl = playlistId ? `https://www.youtube.com/playlist?list=${playlistId}` : null;
  const description = [
    ep.description || '',
    playlistUrl ? `Все серии по порядку: ${playlistUrl}` : '',
    disclosure,
  ].filter(Boolean).join('\n\n').trim();

  const uploaded = demo ? {
    videoId: `yt_demo_${Math.random().toString(36).slice(2, 12)}`,
    url: `https://www.youtube.com/watch?v=yt_demo_${Math.random().toString(36).slice(2, 10)}`,
    privacy: privacyStatus,
    demo: true,
  } : await uploadVideo({
    token,
    filePath: abs,
    title: ep.title,
    description,
    tags: ep.tags,
    privacy: privacyStatus,
    format: 'long',
    playlistId,
  });

  // Сохраняем ровно то описание, которое ушло на площадку: в нём ссылка на
  // плейлист и маркировка, и именно его увидит пользователь в карточке серии.
  db.prepare('UPDATE series_episodes SET stage = ?, published_at = ?, external_id = ?, description = ?, error = NULL, updated_at = ? WHERE id = ?')
    .run('published', nowIso(), uploaded.videoId, description, nowIso(), id);

  log({
    level: 'info', actor: 'series', action: 'episode.published', entityType: 'series_episode', entityId: id,
    message: `Серия ${ep.episode_no} опубликована: ${uploaded.url}${uploaded.inPlaylist ? ' (в плейлисте)' : ''}`,
    meta: { videoId: uploaded.videoId, playlistId, privacy: uploaded.privacy },
  });

  return {
    ok: true,
    url: uploaded.url,
    videoId: uploaded.videoId,
    privacy: uploaded.privacy,
    playlistId,
    inPlaylist: uploaded.inPlaylist,
    checklist: [
      'В YouTube Studio отметьте «Изменённый или синтетический контент» — через API это поле недоступно.',
      'Проверьте, что главы в описании начинаются с 0:00 — тогда YouTube сам покажет их таймкоды.',
      'Добавьте сериал в раздел Shows (нужен YPP): серии будут идти по порядку без ручной правки.',
    ],
  };
}

/** Деньги сериала: что уже есть и что нужно, чтобы выйти на цель. */
export function economics(seriesId, { targetRub = 50000 } = {}) {
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!series) throw new Error('Сериал не найден');
  const episodes = db.prepare('SELECT * FROM series_episodes WHERE series_id = ? ORDER BY episode_no ASC').all(seriesId);
  const settings = getSettings();
  const rpm = num(settings.rpm_youtube_long, 190);
  const econ = seriesEconomics({ series, episodes: episodes.map((e) => ({ ...e, rpm: num(e.rpm, rpm) })), targetRub });
  const costCents = episodes.reduce((a, e) => a + num(e.cost_cents, 0), 0);
  const profit = econ.totalRevenueRub - Math.round(costCents / 100);
  const forecast = revenueForecast({ genre: series.genre, minutes: num(series.episode_sec, 900) / 60, midRolls: 2 });
  const perEpisodeCost = episodes.length ? Math.round(costCents / 100 / episodes.length) : 0;
  const breakevenViews = perEpisodeCost ? Math.ceil((perEpisodeCost * 1000) / Math.max(1, rpm)) : null;

  return {
    ...econ,
    costRub: Math.round(costCents / 100),
    profitRub: profit,
    margin: econ.totalRevenueRub ? Math.round((profit / econ.totalRevenueRub) * 100) : 0,
    perEpisodeCost,
    breakevenViews,
    rpm,
    forecast,
    plan: {
      perWeek: parseJson(series.season_plan, {}).cadence || '2 серии в неделю',
      minutesPerEpisode: Math.round(num(series.episode_sec, 900) / 60),
      longForm: 'Длинные серии включают мид-роллы: RPM в 2–3 раза выше Shorts того же канала.',
    },
    advice: [
      `Окупаемость одной серии — ${breakevenViews ? `${breakevenViews.toLocaleString('ru-RU')} просмотров` : 'считать после первой публикации'}.`,
      econ.ypp.hoursLeft > 0
        ? `До YPP осталось ${econ.ypp.hoursLeft.toLocaleString('ru-RU')} часов просмотра — это ${Math.ceil(econ.ypp.hoursLeft / Math.max(1, Math.round((num(series.episode_sec, 900) / 60) * 0.4)))} серий при текущем досмотре.`
        : 'Порог 4000 часов просмотра пройден — заявку в YPP можно подавать.',
      `При ${Math.round(num(series.episode_sec, 900) / 60)} минутах и ${forecast.midRolls} мид-роллах RPM ориентир ${rpm} ₽ за 1000 просмотров.`,
    ],
  };
}

/**
 * Метрики опубликованных серий. В live-режиме берём реальные счётчики YouTube,
 * в demo — модель роста по возрасту публикации, чтобы деньги сериала были
 * осмысленными, а не нулевыми до первого реального просмотра.
 */
export async function refreshSeriesMetrics() {
  const settings = getSettings();
  const rpm = num(settings.rpm_youtube_long, 190);
  const rows = db.prepare("SELECT * FROM series_episodes WHERE stage = 'published'").all();
  if (!rows.length) return { updated: 0 };

  const isLive = (process.env.PULSE_MODE || 'demo') === 'live';
  let live = new Map();
  if (isLive) {
    const byAccount = new Map();
    for (const e of rows) {
      if (!e.external_id) continue;
      const series = db.prepare('SELECT project_id FROM series WHERE id = ?').get(e.series_id);
      const account = youtubeAccount(series?.project_id);
      if (!account?.access_token) continue;
      const key = account.id;
      if (!byAccount.has(key)) byAccount.set(key, { account, rows: [] });
      byAccount.get(key).rows.push(e);
    }
    const { videoStats } = await import('../providers/social/youtube.js');
    for (const group of byAccount.values()) {
      try {
        const token = decryptSecret(group.account.access_token);
        const stats = await videoStats({ token, videoIds: group.rows.map((e) => e.external_id) });
        for (const stat of stats || []) {
          const row = group.rows.find((e) => String(e.external_id) === String(stat.id));
          if (row) live.set(row.id, stat);
        }
      } catch (err) {
        log({ level: 'warn', actor: 'series', action: 'metrics.failed', message: `Метрики YouTube не получены: ${err.message}` });
      }
    }
  }

  let updated = 0;
  const now = Date.now();
  for (const e of rows) {
    let views = num(e.views, 0);
    if (live.has(e.id)) {
      views = num(live.get(e.id).views, views);
    } else if (!isLive) {
      // модель: суточный прирост затухает, у длинных серий «хвост» длиннее
      const publishedAt = new Date(e.published_at || e.updated_at || nowIso()).getTime();
      const days = Math.max(0, (now - publishedAt) / 86400000);
      const base = 900 + (Number(String(e.id).replace(/\D/g, '').slice(-3)) || 500);
      const curve = Math.round(base * (1 - Math.exp(-days / 2.2)) * 42);
      views = Math.max(views, curve);
    }
    if (views === num(e.views, 0)) continue;
    const revenueCents = Math.round((views / 1000) * rpm * 100 * (num(e.mid_rolls, 0) > 1 ? 1.35 : 1));
    db.prepare('UPDATE series_episodes SET views = ?, rpm = ?, revenue_cents = ?, updated_at = ? WHERE id = ?')
      .run(views, rpm, revenueCents, nowIso(), e.id);
    updated += 1;
  }
  if (updated) {
    log({ level: 'info', actor: 'series', action: 'metrics.refresh', message: `Метрики сериалов обновлены: ${updated} серий`, meta: { updated } });
  }
  return { updated, live: isLive };
}

/** Сводка по всем сериалам для страницы. */
export function seriesOverview() {
  const rows = listSeries();
  const episodes = db.prepare('SELECT * FROM series_episodes').all().map(episodeRow);
  const settings = getSettings();
  const rpm = num(settings.rpm_youtube_long, 190);
  const totalRevenue = episodes.reduce((a, e) => a + num(e.revenue_cents, 0), 0) / 100;
  const watchHours = episodes.reduce((a, e) => a + (num(e.views, 0) * (num(e.duration_sec, 0) / 60) * 0.4) / 60, 0);
  return {
    series: rows,
    genres: SERIES_GENRES_LIST,
    render: seriesRenderInfo(),
    totals: {
      series: rows.length,
      episodes: episodes.length,
      published: episodes.filter((e) => e.stage === 'published').length,
      ready: episodes.filter((e) => ['review', 'scheduled'].includes(e.stage)).length,
      minutes: Math.round(episodes.reduce((a, e) => a + num(e.duration_sec, 0), 0) / 60),
      views: episodes.reduce((a, e) => a + num(e.views, 0), 0),
      revenueRub: Math.round(totalRevenue),
      watchHours: Math.round(watchHours),
      rpm,
      hoursToMonetization: Math.max(0, Math.round(4000 - watchHours)),
    },
    pipeline: [
      { id: 'bible', label: 'Библия', hint: 'Мир, герои, правило мира и секрет сезона — фундамент, который не даёт сериям расползтись.' },
      { id: 'season', label: 'Сезон', hint: '4–8 серий с аркой: у каждой свой поворот и свой обрыв. Это и есть «сериал», а не набор видео.' },
      { id: 'script', label: 'Сценарий', hint: '12 битов, главы с таймкодами, мид-роллы на границах актов, аудит оригинальности.' },
      { id: 'voice', label: 'Озвучка', hint: 'Секции по ~3000 знаков: голос не рвётся, тайминг сцен считается по реальному звуку.' },
      { id: 'render', label: 'Фото-ряд', hint: '1920×1080, свой кадр на каждую сцену, субтитры отдельным слоем.' },
      { id: 'publish', label: 'YouTube', hint: 'Обычное видео + плейлист по порядку + маркировка ИИ. Shorts-нарезки — отдельно, для трафика.' },
    ],
  };
}

export { STAGES, SERIES_GENRES, MEDIA_DIR };
