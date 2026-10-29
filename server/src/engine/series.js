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
import { effectiveCosts } from './costs.js';
import { enqueue } from '../core/queue.js';
import { ensureFreshToken } from './oauth.js';
import { providers } from '../providers/index.js';
import { SERIES_GENRES, SERIES_GENRES_LIST, buildBible, planSeason, buildEpisode, authenticityAudit, seriesEconomics, planCuts, revenueForecast } from './serial.js';
import { planVoiceSections, renderSeriesEpisode, renderSeriesCut, seriesRenderInfo } from './serialrender.js';
import { MEDIA_DIR } from './render.js';
import { framesStatus } from './frames.js';
import * as aiContent from './ai.js';
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
  // автопилот сериала: сочинять серии заранее и (опционально) собирать видео без человека
  for (const key of ['auto_compose', 'auto_render']) {
    if (patch[key] === undefined) continue;
    sets.push(`${key} = ?`);
    args.push(patch[key] ? 1 : 0);
  }
  if (patch.lookahead !== undefined) {
    sets.push('lookahead = ?');
    args.push(clamp(num(patch.lookahead, 3), 1, 6));
  }
  if (patch.frame_mode !== undefined) {
    sets.push('frame_mode = ?');
    args.push(['auto', 'neural', 'procedural'].includes(patch.frame_mode) ? patch.frame_mode : 'auto');
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
 * Библия сериала, написанная моделью. Шаблонная библия остаётся основой:
 * ИИ перекрывает только те поля, которые реально приносит (мир, герои, стиль).
 * Возвращает обновлённый сериал или null, если модель недоступна.
 */
export async function aiBible(seriesId) {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!s) throw new Error('Сериал не найден');
  if (!aiContent.available()) return null;
  const base = parseJson(s.bible, {}) || {};
  const draft = await aiContent.seriesBible({ title: s.title, genre: s.genre, premise: s.premise, tone: s.tone });
  if (!draft?.world) return null;

  const palettes = ['ash', 'ink', 'ember', 'moss', 'rust', 'ice'];
  const merged = {
    ...base,
    ai: { provider: draft.provider || 'llm', model: draft.model || null },
    tagline: draft.tagline || base.tagline || '',
    premise: base.premise,
    world: {
      ...(base.world || {}),
      ...Object.fromEntries(Object.entries(draft.world || {}).filter(([, v]) => typeof v === 'string' && v.trim())),
      ...(draft.world?.secret ? { secret: draft.world.secret } : {}),
    },
    characters: Array.isArray(draft.characters) && draft.characters.length
      ? draft.characters.slice(0, 4).map((c, i) => ({
        name: String(c.name || `Герой ${i + 1}`).slice(0, 40),
        role: String(c.role || (i === 0 ? 'герой' : i === 1 ? 'союзник' : 'антагонист')).slice(0, 30),
        gender: /[ая]$/i.test(String(c.name || '')) ? 'f' : 'm',
        profession: String(c.job || '').slice(0, 60),
        want: String(c.want || '').slice(0, 120),
        wound: String(c.fear || '').slice(0, 120),
        secret: String(c.secret || '').slice(0, 140),
      }))
      : base.characters,
    visual: {
      ...(base.visual || {}),
      palette: palettes.includes(draft.visual?.palette) ? draft.visual.palette : (base.visual?.palette || 'ash'),
      look: String(draft.visual?.look || base.visual?.look || '').slice(0, 200),
    },
  };
  db.prepare('UPDATE series SET bible = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), nowIso(), seriesId);
  log({ level: 'info', actor: 'ai', action: 'series.bible', entityType: 'series', entityId: seriesId, message: `Библия «${s.title}» написана ИИ: ${merged.world?.place || '—'}` });
  return getSeries(seriesId);
}

/**
 * Переписать нарратив серии моделью. Сетка сцен, фото-ряд, тайминг и аудит
 * остаются прежними — меняется только текст озвучки (и, если повезёт, название).
 * Так серия получает живую речь без риска сломать рендер.
 */
export async function aiComposeEpisode(id) {
  const ep = getEpisode(id);
  if (!ep) throw new Error('Серия не найдена');
  if (!aiContent.available()) return null;
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(ep.series_id);
  if (!s) throw new Error('Сериал не найден');
  const bible = parseJson(s.bible, {});
  const plan = parseJson(s.season_plan, {});
  const planEntry = (plan.episodes || []).find((e) => e.number === ep.episode_no) || null;
  const scenes = Array.isArray(ep.scenes) ? ep.scenes : [];
  if (scenes.length < 4) return null;

  const durationSec = num(ep.duration_sec, num(s.episode_sec, 900));
  // Речь в озвучке идёт ~2.35 слова в секунду. Модель пишет кусками по ~120 слов
  // (это её «естественный» абзац), а по сценам текст раскладываем сами — иначе
  // 65 сцен требовали бы 65 абзацев и модель бы не уложилась в ответ.
  const totalWords = Math.round(durationSec * 2.35);
  const paragraphs = clamp(Math.round(totalWords / 120), 5, 26);
  const wordsPerParagraph = Math.max(60, Math.round(totalWords / paragraphs));

  const siblings = db.prepare('SELECT scenes FROM series_episodes WHERE series_id = ? AND episode_no <> ?')
    .all(ep.series_id, ep.episode_no)
    .flatMap((r) => parseJson(r.scenes, []).map((x) => String(x.text || '').slice(0, 90)))
    .filter(Boolean);

  const draft = await aiContent.seriesNarration({
    series: s, bible, planEntry, episodeNo: ep.episode_no,
    paragraphs, wordsPerParagraph, siblings: siblings.slice(0, 8),
  });
  if (!draft?.paragraphs?.length) return null;

  // ── раскладка по сценам: предложение за предложением, пропорционально времени
  let sentences = draft.paragraphs
    .join(' ')
    .match(/[^.!?…]+[.!?…]+[»"']?|[^.!?…]+$/g)
    ?.map((x) => x.trim())
    .filter((x) => x.length > 2) || [];
  if (sentences.length < 5) return null;
  // Сцен в длинной серии много (кадр каждые 8–12 секунд), а предложений меньше.
  // Длинные фразы делим по запятым/тире — так у каждой сцены есть свой текст,
  // и субтитр не растягивается на пол-экрана.
  const countW = (t) => String(t).trim().split(/\s+/).filter(Boolean).length;
  let guard = 0;
  while (sentences.length < scenes.length && guard++ < 500) {
    let idx = -1;
    let max = 0;
    for (let i = 0; i < sentences.length; i += 1) {
      const w = countW(sentences[i]);
      if (w > max) { max = w; idx = i; }
    }
    if (idx < 0 || max < 8) break;
    const parts = sentences[idx].split(/(?<=[,;:—–])\s+/);
    if (parts.length < 2) {
      // запятых нет — режем по середине, ближе к пробелу
      const words = sentences[idx].split(' ');
      const mid = Math.ceil(words.length / 2);
      sentences.splice(idx, 1, words.slice(0, mid).join(' '), words.slice(mid).join(' '));
    } else {
      sentences.splice(idx, 1, ...parts);
    }
  }

  const countWords = (t) => String(t).trim().split(/\s+/).filter(Boolean).length;
  const totalSec = scenes.reduce((a, sc) => a + num(sc.seconds, 5), 0) || scenes.length;
  const budget = scenes.map((sc) => (countWords(sentences.join(' ')) * num(sc.seconds, 5)) / totalSec);
  const nextScenes = scenes.map((sc) => ({ ...sc }));
  let si = 0;
  let acc = 0;
  for (let i = 0; i < sentences.length && si < nextScenes.length; i += 1) {
    if (!nextScenes[si].aiText) nextScenes[si].aiText = '';
    nextScenes[si].aiText += (nextScenes[si].aiText ? ' ' : '') + sentences[i];
    acc += countWords(sentences[i]);
    // сцена заполнена — переходим к следующей (последняя забирает остаток)
    if (acc >= budget[si] && si < nextScenes.length - 1) { si += 1; acc = 0; }
  }
  // Сцене без своего куска текста оставляем пустую строку: кадр показывается,
  // а narration идёт непрерывно. Хвост шаблонного текста здесь был бы хуже —
  // зритель услышал бы другую историю.
  for (const sc of nextScenes) {
    if (sc.aiText) { sc.text = sc.aiText.trim(); sc.ai = true; }
    else if (String(sc.text || '').trim()) { sc.text = ''; sc.ai = true; }
    delete sc.aiText;
  }

  const script = {
    ...(ep.script || {}),
    scenes: nextScenes,
    sections: planVoiceSections({ scenes: nextScenes }),
    ai: { provider: draft.provider || 'llm', model: draft.model || null },
  };
  const words = nextScenes.reduce((a, sc) => a + countWords(sc.text), 0);
  const wpm = Math.round((words / Math.max(1, durationSec)) * 60);

  const audit = authenticityAudit({
    series: s, bible, scenes: nextScenes, episodeNo: ep.episode_no,
    plan: planEntry, wpm, durationSec, midRolls: num(ep.mid_rolls, 0), siblingScenes: siblings,
  });

  db.prepare(`UPDATE series_episodes SET script = ?, scenes = ?, words = ?, wpm = ?, authenticity = ?,
      title = COALESCE(NULLIF(?, ''), title), thumb_text = COALESCE(NULLIF(?, ''), thumb_text), updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(script), JSON.stringify(nextScenes), words, wpm, JSON.stringify(audit),
      String(draft.title || '').slice(0, 120), String(draft.thumb || '').slice(0, 60), nowIso(), id);

  log({
    level: 'info', actor: 'ai', action: 'series.episode_ai', entityType: 'series_episode', entityId: id,
    message: `Серия ${ep.episode_no} переписана ИИ: ${words} слов, ${wpm} слов/мин, аудит ${audit.score}`,
    meta: { provider: draft.provider, model: draft.model, similarity: audit.similarity, paragraphs },
  });
  return { ok: true, words, wpm, audit, episode: getEpisode(id) };
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
  // Свой продукт в описании серии: серия выходит раз в неделю, поэтому мягкое
  // упоминание уместно всегда, а прямая ссылка — через выпуск.
  ep.description = withProduct(ep.description, { episodeNo });
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
  const costs = effectiveCosts();
  return {
    // Edge TTS в текущей конфигурации бесплатен → озвучка серии не стоит ничего
    voiceRubPer1000: costs.ttsPer1000,
    renderRubPerMin: costs.renderPerMin,
    llmRub: costs.llmPerEpisode,
  };
}

/** Озвучка: секции → mp3 в data/media. В demo-режиме тайминг считается по словам. */
export async function synthesizeEpisode(id, { voiceId = null } = {}) {
  const ep = getEpisode(id);
  if (!ep) throw new Error('Серия не найдена');
  const script = ep.script || {};
  // ИИ-текст до озвучки: переписывать после синтеза бессмысленно — звук уже готов.
  let current = ep;
  if (!script.ai && aiContent.available()) {
    try {
      const upgraded = await aiComposeEpisode(id);
      if (upgraded?.episode) current = upgraded.episode;
    } catch (err) {
      log({ level: 'warn', actor: 'ai', action: 'series.ai_failed', entityType: 'series_episode', entityId: id, message: `ИИ-текст не применён: ${String(err.message || err).slice(0, 160)}` });
    }
  }
  const finalScript = current.script || script;
  const sections = Array.isArray(finalScript.sections) && finalScript.sections.length
    ? finalScript.sections
    : planVoiceSections({ scenes: current.scenes });

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

  const nextScript = { ...finalScript, sections: sections.map((s, i) => ({ ...s, audioPath: results[i].audioPath, provider: results[i].provider })) };
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
      frameMode: series.frame_mode || null,
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
 * Свой продукт в описании серии. Продукт с placement='video' в текст не
 * попадает — он должен звучать в кадре; ссылка идёт с UTM, чтобы в «Деньгах»
 * было видно, что привела именно серия.
 */
function withProduct(description, { episodeNo = 1 } = {}) {
  const product = db.prepare(`SELECT * FROM products WHERE active = 1
      ORDER BY CASE WHEN always = 1 THEN 0 ELSE 1 END, created_at DESC LIMIT 1`).get();
  if (!product || (product.placement || 'both') === 'video') return description;
  const link = Number(product.always) === 1 || episodeNo % 2 === 1;
  const sep = product.url.includes('?') ? '&' : '?';
  const utm = `${product.url}${sep}utm_source=youtube&utm_medium=series&utm_campaign=${encodeURIComponent(product.utm_campaign || 'pulse')}&utm_content=ep${episodeNo}`;
  const line = link
    ? `${product.name} — ${product.pitch || 'то, чем пользуюсь сам'}: ${utm}`
    : `${product.name} — если захочется так же.`;
  return `${description}\n\n———\n${line}`.trim();
}

/**
 * Автопилот сериала: держит N серий готовыми впереди.
 *
 * Сочинять сценарий — секунды, собирать видео — десятки минут, поэтому шаги
 * разделены: `series_auto_compose` (включено) пишет сценарии заранее,
 * `series_auto_render` (выключено) дополнительно ставит сборку в очередь.
 * Так на слабом сервере можно планировать сезон, а рендерить ночью.
 */
export function seriesAutopilot({ dryRun = false } = {}) {
  const settings = getSettings();
  if (num(settings.series_auto_compose, 1) !== 1) return { composed: 0, queued: 0, planned: [], dryRun };
  const lookahead = clamp(num(settings.series_lookahead, 3), 1, 8);
  const rows = db.prepare("SELECT * FROM series WHERE status IN ('draft','active') ORDER BY created_at ASC").all();
  let composed = 0;
  let queued = 0;
  const planned = [];

  for (const series of rows) {
    if (num(series.auto_compose, 1) !== 1) continue;
    const total = clamp(num(series.episodes_planned, 6), 3, 8);
    const existing = db.prepare('SELECT episode_no, stage FROM series_episodes WHERE series_id = ?').all(series.id);
    const ready = existing.filter((e) => ['script', 'voice', 'render', 'review', 'scheduled', 'published'].includes(e.stage)).length;
    const target = Math.min(total, ready + lookahead);
    for (let no = 1; no <= target; no += 1) {
      if (existing.some((e) => e.episode_no === no)) continue;
      if (dryRun) { planned.push({ seriesId: series.id, title: series.title, episodeNo: no }); continue; }
      try {
        composeEpisode({ seriesId: series.id, episodeNo: no });
        composed += 1;
      } catch (err) {
        log({ level: 'warn', actor: 'series', action: 'autopilot.compose_failed', entityType: 'series', entityId: series.id, message: `Серия ${no} не сочинена: ${String(err.message || err).slice(0, 160)}` });
      }
    }

    const wantsRender = num(series.auto_render, 0) === 1 || num(settings.series_auto_render, 0) === 1;
    if (wantsRender) {
      const scripts = db.prepare(`SELECT id, episode_no FROM series_episodes
          WHERE series_id = ? AND stage = 'script' AND (error IS NULL OR error = '')
            AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.status IN ('pending','running')
              AND j.type = 'series.render' AND j.payload LIKE '%' || series_episodes.id || '%')
          ORDER BY episode_no ASC LIMIT 1`).all(series.id);
      for (const ep of scripts) {
        if (dryRun) { planned.push({ seriesId: series.id, title: series.title, episodeNo: ep.episode_no, render: true }); continue; }
        enqueue('series.render', { episodeId: ep.id }, { priority: 5, dedupeKey: `series-render:${ep.id}` });
        queued += 1;
      }
    }
  }
  if (!dryRun && (composed || queued)) {
    log({ level: 'info', actor: 'series', action: 'autopilot.series', entityType: 'system', message: `Автопилот сериалов: сочинено ${composed} серий, в сборку ${queued}` });
  }
  return { composed, queued, planned, dryRun };
}

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

  // токен OAuth обновляем перед загрузкой: серия идёт на YouTube минутами
  const token = (await ensureFreshToken(account).catch(() => null))
    || (account.access_token ? decryptSecret(account.access_token) : null);
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
    frames: framesStatus(),
    autopilot: {
      enabled: String(getSettings().series_auto_compose || '1') === '1',
      render: rows.filter((r) => r.auto_render).map((r) => r.id),
      lookahead: num(getSettings().series_lookahead, 3),
      due: (() => {
        try { return seriesAutopilot({ dryRun: true }); } catch { return null; }
      })(),
    },
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
