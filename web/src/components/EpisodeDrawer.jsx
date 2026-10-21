import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import { Drawer, Badge, Progress, Field, Confirm, useToast } from './ui.jsx';
import Icon, { PlatformIcon } from './Icons.jsx';
import {
  STATUS_META, fmt, dateTime, durationLabel, relative, fmtDateTimeLocal, bytes, money, pct,
} from '../lib/format.js';

const RISK = (risk) => (risk >= 70 ? 'danger' : risk >= 55 ? 'warn' : 'success');


/* ── Проверка: правила площадок, скор и быстрая правка описания ─────────── */
function CheckPanel({ episode, onRefresh }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState(episode.description || '');
  const [tags, setTags] = useState((episode.hashtags || []).join(' '));

  useEffect(() => {
    setCaption(episode.description || '');
    setTags((episode.hashtags || []).join(' '));
  }, [episode.id, episode.description]);

  const compliance = episode.compliance;
  const viral = episode.viral_meta;

  const recheck = async () => {
    setBusy(true);
    try {
      await api.checkEpisode(episode.id, {
        description: caption,
        hashtags: tags.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean),
      });
      toast.push({ tone: 'success', title: 'Проверка обновлена' });
      await onRefresh();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не удалось проверить', text: err.message });
    } finally { setBusy(false); }
  };

  const saveCaption = async () => {
    setBusy(true);
    try {
      await api.patchCaption(episode.id, {
        description: caption,
        hashtags: tags.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean),
      });
      toast.push({ tone: 'success', title: 'Описание сохранено', text: 'Применится к следующей публикации' });
      await onRefresh();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не сохранено', text: err.message });
    } finally { setBusy(false); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      {!compliance && !viral && (
        <div className="notice">Проверка ещё не выполнялась — запустите её, чтобы увидеть правила и прогноз.</div>
      )}

      {viral && (
        <div className="check-block">
          <div className="check-block-head">
            <span><Icon name="flame" size={14} /> «Залетит ли»</span>
            <span className="score-pill" data-grade={viral.grade}>{viral.score}/100</span>
          </div>
          <div className="col" style={{ gap: 9, marginTop: 10 }}>
            {(viral.factors || []).map((f) => (
              <div key={f.id}>
                <div className="factor-row">
                  <span>{f.label}</span>
                  <b>{f.value}</b>
                </div>
                <div className="bar-track" style={{ height: 5 }}>
                  <div className="bar-fill" style={{
                    width: `${f.value}%`,
                    background: f.value >= 70 ? 'linear-gradient(90deg,#34d399,#6ee7b7)' : f.value >= 45 ? 'linear-gradient(90deg,#fbbf24,#fcd34d)' : 'linear-gradient(90deg,#fb7185,#fda4af)',
                  }} />
                </div>
                <div className="field-hint" style={{ marginTop: 4 }}>{f.detail}</div>
              </div>
            ))}
          </div>
          {viral.advice?.length > 0 && (
            <ul className="advice-list">
              {viral.advice.map((a) => <li key={a}>{a}</li>)}
            </ul>
          )}
          <div className="field-hint" style={{ marginTop: 8 }}>{viral.confidence}</div>
        </div>
      )}

      {compliance && (
        <div className="check-block">
          <div className="check-block-head">
            <span><Icon name="shield" size={14} /> Правила площадки</span>
            <span className="score-pill" data-grade={compliance.ok ? 'high' : 'low'}>{compliance.ok ? 'проходит' : 'блок'}</span>
          </div>
          {compliance.blocking?.length > 0 && (
            <div className="col" style={{ gap: 8, marginTop: 10 }}>
              {compliance.blocking.map((b) => (
                <div className="finding danger" key={b.id}>
                  <Icon name="alert" size={13} />
                  <div><b>{b.reason}</b>{b.match ? <span className="mono"> «{b.match}»</span> : null}</div>
                </div>
              ))}
            </div>
          )}
          {compliance.warnings?.length > 0 && (
            <div className="col" style={{ gap: 8, marginTop: 10 }}>
              {compliance.warnings.map((w) => (
                <div className="finding warn" key={w.id}>
                  <Icon name="info" size={13} />
                  <div><b>{w.reason}</b>{w.match ? <span className="mono"> «{w.match}»</span> : null}</div>
                </div>
              ))}
            </div>
          )}
          {!compliance.blocking?.length && !compliance.warnings?.length && (
            <div className="finding ok" style={{ marginTop: 10 }}><Icon name="check" size={13} /><div>Нарушений не найдено</div></div>
          )}
          <div className="mini-kv tight" style={{ marginTop: 12 }}>
            <div><span>Площадка</span><b>{compliance.platform === 'tiktok' ? 'TikTok' : 'Reels'}</b></div>
            <div><span>Лимит описания</span><b>{compliance.limits?.captionMax} симв.</b></div>
            <div><span>Маркировка</span><b>{compliance.labels?.ad ? 'реклама' : '—'} / {compliance.labels?.ai ? 'AI' : '—'}</b></div>
          </div>
        </div>
      )}

      <Field label="Описание и хештеги" hint="Быстрая правка перед публикацией — без пересборки ролика">
        <textarea className="textarea" value={caption} onChange={(e) => setCaption(e.target.value)} style={{ minHeight: 96 }} />
        <input className="input" style={{ marginTop: 8 }} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#теги через пробел" />
      </Field>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={recheck}><Icon name="shield" size={13} />Перепроверить</button>
        <button className="btn btn-soft btn-sm" disabled={busy} onClick={saveCaption}><Icon name="check" size={13} />Сохранить описание</button>
      </div>
    </div>
  );
}

export default function EpisodeDrawer({ episodeId, onClose, onChange }) {
  const { refreshLight } = useApp();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('content');
  const [forecast, setForecast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ title: '', description: '', hashtags: '', scenes: [] });
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!episodeId) { setForecast(null); return; }
    let alive = true;
    api.forecast(episodeId).then((res) => { if (alive) setForecast(res); }).catch(() => {});
    return () => { alive = false; };
  }, [episodeId]);

  const load = async () => {
    if (!episodeId) return;
    try {
      const res = await api.episode(episodeId);
      setData(res);
      setDraft({
        title: res.title,
        description: res.description || '',
        hashtags: (res.hashtags || []).join(' '),
        scenes: res.scenes || [],
      });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не удалось открыть ролик', text: err.message });
    }
  };

  useEffect(() => { setData(null); setTab('content'); setConfirmDelete(false); load(); }, [episodeId]);

  const action = async (name, extra) => {
    setBusy(true);
    try {
      await api.episodeAction(episodeId, name, extra);
      const map = {
        approve: 'Ролик подтверждён и поставлен в расписание',
        publish_now: 'Публикация запущена',
        pause: 'Ролик снят с конвейера',
        resume: 'Ролик возвращён в конвейер',
        retry: 'Ролик запущен заново',
        reschedule: 'Время публикации изменено',
        duplicate: 'Создана копия ролика',
      };
      toast.push({ tone: 'success', title: map[name] || 'Готово' });
      await load();
      refreshLight();
      onChange?.();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.updateEpisode(episodeId, {
        title: draft.title,
        description: draft.description,
        hashtags: draft.hashtags.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean),
        scenes: draft.scenes,
      });
      toast.push({ tone: 'success', title: 'Изменения сохранены' });
      await load();
      refreshLight();
      onChange?.();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не сохранено', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await api.deleteEpisode(episodeId);
    toast.push({ tone: 'info', title: 'Ролик удалён' });
    refreshLight();
    onClose();
  };

  const status = data ? STATUS_META[data.status] || { label: data.status, tone: 'muted' } : null;
  const pubs = data?.publications || [];
  const views = pubs.reduce((a, p) => a + p.views, 0);
  const clicks = pubs.reduce((a, p) => a + p.clicks, 0);
  const dirty = useMemo(() => {
    if (!data) return false;
    return draft.title !== data.title
      || draft.description !== (data.description || '')
      || draft.hashtags !== (data.hashtags || []).join(' ')
      || JSON.stringify(draft.scenes) !== JSON.stringify(data.scenes || []);
  }, [draft, data]);

  return (
    <>
      <Drawer
        open={Boolean(episodeId)}
        onClose={onClose}
        title={data?.title || 'Загрузка…'}
        subtitle={data ? `${data.project_name || 'Проект'} · ${data.format || ''} · риск ${data.risk}/100` : ''}
        actions={data && (
          <button className="btn btn-ghost btn-icon" title="Удалить" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" size={16} />
          </button>
        )}
      >
        {!data ? (
          <div className="col" style={{ gap: 12 }}>
            <div className="skeleton" style={{ height: 190 }} />
            <div className="skeleton" style={{ height: 80 }} />
            <div className="skeleton" style={{ height: 120 }} />
          </div>
        ) : (
          <>
            <div className="row" style={{ gap: 14, alignItems: 'flex-start', marginBottom: 16 }}>
              {data.video_path ? (
                <div className="media-thumb" style={{ width: 122 }}>
                  <video src={data.video_path} poster={data.cover_paths?.A} muted playsInline preload="metadata" controls />
                </div>
              ) : (
                <div className="cover" style={{ width: 92, flex: 'none' }}>
                  <img src={data.cover_paths?.A || api.coverUrl(data.cover_seed, data.title, data.format, '&i=0')} alt="" />
                </div>
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
                  <Badge tone={status.tone} dot live={status.pulse}>{status.label}</Badge>
                  <Badge tone="muted">{data.stageLabel}</Badge>
                  <Badge tone={RISK(data.risk)}>риск {data.risk}</Badge>
                  {data.viral ? <Badge tone={data.viral >= 65 ? 'success' : data.viral >= 45 ? 'warn' : 'danger'}>скор {data.viral}</Badge> : null}
                  {data.compliance ? <Badge tone={data.compliance.ok ? 'success' : 'danger'}>{data.compliance.ok ? 'правила ок' : 'нарушение'}</Badge> : null}
                  {data.ab_test ? <Badge tone="accent">A/B</Badge> : null}
                </div>
                <Progress value={data.progress} striped={data.status === 'generating'} />
                <div className="row" style={{ gap: 12, marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
                  <span>{data.progress}%</span>
                  {data.scheduled_at && <span><Icon name="clock" size={11} style={{ verticalAlign: -1 }} /> {dateTime(data.scheduled_at)}</span>}
                  {data.error && <span style={{ color: 'var(--red)' }} className="truncate">{data.error}</span>}
                </div>
                {data.video_bytes ? (
                  <div className="media-meta">
                    <Icon name="film" size={12} /> {data.video_path?.split('/').pop()} · {bytes(data.video_bytes)} · рендер {Math.round((data.render_ms || 0) / 1000)} с
                    <a href={data.video_path} target="_blank" rel="noreferrer" className="link-btn">скачать</a>
                  </div>
                ) : null}
                {forecast && !pubs.length && (
                  <div className="col" style={{ gap: 4, marginTop: 10, padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 10, background: 'rgba(139,92,246,.07)' }}>
                    <div className="row-between" style={{ gap: 8 }}>
                      <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--violet-3)', fontWeight: 700 }}>прогноз</span>
                      <span style={{ fontSize: 10, color: 'var(--muted)' }}>медиана {fmt(forecast.factors.baseline)} · {forecast.factors.baselineSource === 'project' ? 'свой проект' : forecast.factors.baselineSource === 'platform' ? 'площадка' : 'фолбэк'}</span>
                    </div>
                    <div className="row wrap" style={{ gap: 14, fontSize: 11 }}>
                      <span><b>{fmt(forecast.expectedViews)}</b> <span style={{ color: 'var(--muted)' }}>просмотров</span></span>
                      <span><b>{money(forecast.revenue, forecast.currency)}</b> <span style={{ color: 'var(--muted)' }}>доход</span></span>
                      <span><b className={forecast.profit >= 0 ? 'tone-green' : 'tone-rose'}>{money(forecast.profit, forecast.currency)}</b> <span style={{ color: 'var(--muted)' }}>прибыль · ROI {forecast.roi}%</span></span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                      скор {forecast.factors.viral.score} × {forecast.factors.viral.factor} · час {String(forecast.factors.hour.local).padStart(2, '0')}:00 × {forecast.factors.hour.score} · аккаунт × {forecast.factors.account.factor}
                    </div>
                  </div>
                )}
                {pubs.length > 0 && (
                  <div className="hr-stats" style={{ marginTop: 12 }}>
                    <div className="hr-stat"><span className="v">{fmt(views)}</span><span className="l">просмотры</span></div>
                    <div className="hr-stat"><span className="v">{fmt(clicks)}</span><span className="l">клики</span></div>
                    <div className="hr-stat"><span className="v">{views ? ((clicks / views) * 100).toFixed(1).replace('.', ',') : 0}%</span><span className="l">ctr</span></div>
                  </div>
                )}
              </div>
            </div>

            <div className="row wrap" style={{ gap: 6, marginBottom: 16 }}>
              {data.status === 'review' && (
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => action('approve')}><Icon name="check" size={13} />Подтвердить</button>
              )}
              {(data.status === 'review' || data.status === 'scheduled' || data.status === 'paused') && (
                <button className="btn btn-soft btn-sm" disabled={busy} onClick={() => action('publish_now')}><Icon name="zap" size={13} />Опубликовать сейчас</button>
              )}
              {data.status === 'failed' && (
                <button className="btn btn-soft btn-sm" disabled={busy} onClick={() => action('retry')}><Icon name="refresh" size={13} />Повторить</button>
              )}
              {['scheduled', 'queued', 'generating', 'review'].includes(data.status) && (
                <button className="btn btn-sm" disabled={busy} onClick={() => action('pause')}><Icon name="pause" size={13} />Пауза</button>
              )}
              {data.status === 'paused' && (
                <button className="btn btn-sm" disabled={busy} onClick={() => action('resume')}><Icon name="play" size={13} />Вернуть</button>
              )}
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => action('duplicate')}><Icon name="copy" size={13} />Дублировать</button>
            </div>

            <div className="row" style={{ gap: 4, marginBottom: 14, borderBottom: '1px solid var(--line)' }}>
              {[
                { id: 'content', label: 'Контент' },
                { id: 'check', label: 'Проверка' },
                { id: 'pubs', label: `Публикации${pubs.length ? ` · ${pubs.length}` : ''}` },
                { id: 'events', label: 'События' },
              ].map((t) => (
                <button key={t.id} onClick={() => setTab(t.id)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: '8px 10px 10px',
                    fontSize: 12.5, fontWeight: 600,
                    color: tab === t.id ? 'var(--text)' : 'var(--muted)',
                    borderBottom: tab === t.id ? '2px solid var(--violet-2)' : '2px solid transparent',
                  }}>{t.label}</button>
              ))}
            </div>

            {tab === 'content' && (
              <div className="col" style={{ gap: 14 }}>
                <Field label="Заголовок ролика">
                  <input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                </Field>

                <Field label="Сценарий по сценам" hint="Текст озвучки и визуальный план. Время можно править — тайминг пересчитается.">
                  <div className="col" style={{ gap: 8 }}>
                    {draft.scenes.map((s, i) => (
                      <div className="scene-row" key={i}>
                        <span className="scene-n">{i + 1}</span>
                        <textarea className="textarea" style={{ minHeight: 58, fontSize: 12.5 }} value={s.text}
                          onChange={(e) => {
                            const next = [...draft.scenes];
                            next[i] = { ...next[i], text: e.target.value };
                            setDraft({ ...draft, scenes: next });
                          }} />
                        <input className="input hide-sm" style={{ fontSize: 11.5 }} value={s.visual || ''} placeholder="визуал"
                          onChange={(e) => {
                            const next = [...draft.scenes];
                            next[i] = { ...next[i], visual: e.target.value };
                            setDraft({ ...draft, scenes: next });
                          }} />
                        <div className="row hide-sm" style={{ gap: 4 }}>
                          <input className="input" type="number" min="2" max="15" value={s.seconds}
                            onChange={(e) => {
                              const next = [...draft.scenes];
                              next[i] = { ...next[i], seconds: Number(e.target.value) };
                              setDraft({ ...draft, scenes: next });
                            }} />
                          <span style={{ fontSize: 10, color: 'var(--muted)' }}>с</span>
                        </div>
                        <button className="btn btn-ghost btn-icon" title="Удалить сцену"
                          onClick={() => setDraft({ ...draft, scenes: draft.scenes.filter((_, idx) => idx !== i) })}>
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                    ))}
                    <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}
                      onClick={() => setDraft({ ...draft, scenes: [...draft.scenes, { n: draft.scenes.length + 1, text: '', visual: 'кадр на камеру', seconds: 5 }] })}>
                      <Icon name="plus" size={13} />Добавить сцену
                    </button>
                  </div>
                </Field>

                <Field label="Описание для публикации" hint="Ссылка с UTM подставляется автоматически при публикации">
                  <textarea className="textarea" style={{ minHeight: 120, fontSize: 12.5 }} value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </Field>

                <Field label="Хештеги" hint="Через пробел. Для Reels и TikTok наборы разные — Pulse подставит площадочные при публикации.">
                  <input className="input" value={draft.hashtags} onChange={(e) => setDraft({ ...draft, hashtags: e.target.value })} />
                </Field>

                <div className="form-grid">
                  <Field label="Публикация">
                    <input className="input" type="datetime-local" defaultValue={fmtDateTimeLocal(data.scheduled_at)}
                      onChange={(e) => {
                        const iso = new Date(e.target.value).toISOString();
                        action('reschedule', { scheduledAt: iso });
                      }} />
                  </Field>
                  <Field label="Автопилот для ролика">
                    <div className="row" style={{ height: 40 }}>
                      <button
                        className={`toggle ${data.autopilot ? 'on' : ''}`}
                        onClick={async () => {
                          await api.updateEpisode(episodeId, { autopilot: !data.autopilot });
                          load(); refreshLight();
                        }}
                      />
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{data.autopilot ? 'публикуется автоматически' : 'ждёт подтверждения'}</span>
                    </div>
                  </Field>
                </div>

                {data.script && (
                  <div className="notice">
                    <Icon name="wand" size={15} />
                    <span>Сценарий сохранён в библиотеке · {durationLabel(data.script.duration_sec)} · {data.script.scenes.length} сцен</span>
                  </div>
                )}

                <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost" disabled={!dirty || busy} onClick={() => setDraft({
                    title: data.title, description: data.description || '', hashtags: (data.hashtags || []).join(' '), scenes: data.scenes || [],
                  })}>Сбросить</button>
                  <button className="btn btn-primary" disabled={!dirty || busy} onClick={save}><Icon name="check" size={14} />Сохранить</button>
                </div>
              </div>
            )}

            {tab === 'check' && (
              <CheckPanel episode={data} onRefresh={load} />
            )}

            {tab === 'pubs' && (
              <div className="col" style={{ gap: 10 }}>
                {pubs.length === 0 && (
                  <div className="notice">
                    <Icon name="clock" size={15} />
                    <span>Ролик ещё не опубликован. Публикации появятся здесь после выхода.</span>
                  </div>
                )}
                {pubs.map((p) => (
                  <div className="card flat" key={p.id} style={{ padding: 13 }}>
                    <div className="row-between" style={{ marginBottom: 10 }}>
                      <div className="row" style={{ gap: 8 }}>
                        <span style={{ color: 'var(--violet-2)' }}><PlatformIcon platform={p.platform} size={15} /></span>
                        <b style={{ fontSize: 12.5 }}>{p.platform === 'tiktok' ? 'TikTok' : 'Reels'}</b>
                        <span className="muted" style={{ fontSize: 11.5 }}>@{p.handle || '—'}</span>
                        <Badge tone={p.variant === 'B' ? 'accent' : 'muted'}>вариант {p.variant}</Badge>
                      </div>
                      {p.url && <a className="link-btn" href={p.url} target="_blank" rel="noreferrer">Открыть <Icon name="arrowUpRight" size={12} /></a>}
                    </div>
                    <div className="row wrap" style={{ gap: 16 }}>
                      {[
                        ['Просмотры', fmt(p.views), 'eye'],
                        ['Лайки', fmt(p.likes), 'heart'],
                        ['Репосты', fmt(p.shares), 'share'],
                        ['Клики', fmt(p.clicks), 'link'],
                        ['CTR', `${p.views ? ((p.clicks / p.views) * 100).toFixed(1).replace('.', ',') : 0}%`, 'target'],
                      ].map(([label, val, icon]) => (
                        <div key={label} className="col" style={{ gap: 3 }}>
                          <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>{label}</span>
                          <span style={{ fontSize: 13.5, fontWeight: 700, display: 'flex', gap: 4, alignItems: 'center' }}><Icon name={icon} size={12} style={{ color: 'var(--muted)' }} />{val}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 10 }}>
                      {dateTime(p.published_at)} · покрытие {Math.round((p.views / Math.max(1, p.target_views)) * 100)}% от прогноза
                    </div>
                  </div>
                ))}

                {pubs.length > 1 && (() => {
                  const a = pubs.find((p) => p.variant === 'A');
                  const b = pubs.find((p) => p.variant === 'B');
                  if (!a || !b) return null;
                  const winner = b.views > a.views ? 'B' : 'A';
                  return (
                    <div className="notice accent" style={{ alignItems: 'flex-start' }}>
                      <Icon name="target" size={16} style={{ marginTop: 1 }} />
                      <div>
                        <b>A/B-тест: побеждает вариант {winner}</b><br />
                        A — {fmt(a.views)} просмотров · B — {fmt(b.views)} просмотров.
                        Разница {Math.abs(Math.round(((b.views - a.views) / Math.max(1, a.views)) * 100))}%.
                        Pulse учтёт результат при подборе следующих тем и обложек.
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {tab === 'events' && (
              <div className="timeline">
                {(data.events || []).length === 0 && <p className="muted" style={{ fontSize: 12 }}>Событий пока нет.</p>}
                {(data.events || []).map((e, i, arr) => (
                  <div className="timeline-item" key={e.id}>
                    <div className="timeline-rail">
                      <span className="timeline-dot" style={{ background: e.level === 'error' ? 'var(--red)' : e.level === 'warn' ? 'var(--amber)' : e.level === 'success' ? 'var(--green)' : 'var(--violet-2)' }} />
                      {i < arr.length - 1 && <span className="timeline-line" />}
                    </div>
                    <div className="timeline-content">
                      <div className="timeline-title">{e.message}</div>
                      <div className="timeline-meta">{relative(e.ts)} · {e.actor} · {e.action}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Drawer>

      <Confirm
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        title="Удалить ролик?"
        text="Задачи в очереди будут отменены, опубликованное останется в статистике."
      />
    </>
  );
}
