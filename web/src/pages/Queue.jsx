import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon, { PlatformIcon } from '../components/Icons.jsx';
import { Badge, Progress, Empty, useToast } from '../components/ui.jsx';
import EpisodeDrawer from '../components/EpisodeDrawer.jsx';
import { fmt, dateTime, relative, STATUS_META, FORMAT_LABELS, plural } from '../lib/format.js';

const FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'active', label: 'В работе' },
  { id: 'review', label: 'На проверке' },
  { id: 'scheduled', label: 'В расписании' },
  { id: 'published', label: 'Опубликованы' },
  { id: 'failed', label: 'Ошибки' },
];

export default function Queue({ onLaunch }) {
  const { data, refreshLight } = useApp();
  const toast = useToast();
  const [filter, setFilter] = useState('active');
  const [projectId, setProjectId] = useState('all');
  const [episodes, setEpisodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const params = { limit: 120 };
      if (filter !== 'all') params.status = filter;
      if (projectId !== 'all') params.projectId = projectId;
      setEpisodes(await api.episodes(params));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filter, projectId, data.pipeline]);

  const counts = data.pipeline || {};
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? episodes.filter((e) => `${e.title} ${e.project_name}`.toLowerCase().includes(q)) : episodes;
  }, [episodes, query]);

  const quickApprove = async (e, ev) => {
    ev.stopPropagation();
    try {
      await api.episodeAction(e.id, 'approve');
      toast.push({ tone: 'success', title: 'Ролик подтверждён', text: 'Уйдёт в ближайший свободный слот' });
      load(); refreshLight();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    }
  };

  return (
    <div className="page">
      <div className="card pad-lg">
        <div className="row-between wrap" style={{ gap: 12, marginBottom: 14 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            {FILTERS.map((f) => {
              const n = f.id === 'active'
                ? (counts.queued || 0) + (counts.generating || 0)
                : f.id === 'all' ? Object.values(counts).filter((v) => typeof v === 'number').reduce((a, b) => a + b, 0) - (counts.queue ? 0 : 0)
                  : counts[f.id];
              return (
                <button key={f.id} className={`chip ${filter === f.id ? 'active' : ''}`} onClick={() => setFilter(f.id)}>
                  {f.label}{n ? <span style={{ opacity: 0.65 }}>{n}</span> : null}
                </button>
              );
            })}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <div style={{ position: 'relative' }}>
              <Icon name="search" size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--muted)' }} />
              <input className="input" style={{ paddingLeft: 32, width: 190 }} placeholder="Поиск по роликам" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <select className="select" style={{ width: 170 }} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="all">Все проекты</option>
              {data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button className="btn btn-primary btn-sm" onClick={onLaunch}><Icon name="plus" size={14} />Новые ролики</button>
          </div>
        </div>

        <div className="col" style={{ gap: 7 }}>
          {loading && !filtered.length && [0, 1, 2, 3].map((i) => <div className="skeleton" key={i} style={{ height: 68 }} />)}

          {filtered.map((e) => {
            const st = STATUS_META[e.status] || { label: e.status, tone: 'muted' };
            const pub = e.status === 'published';
            return (
              <div key={e.id} className="episode-row" role="button" tabIndex={0}
                onClick={() => setSelected(e.id)}
                onKeyDown={(ev) => ev.key === 'Enter' && setSelected(e.id)}>
                <span className="ep-cover">
                  <img src={e.cover_paths?.A || api.coverUrl(e.cover_seed, e.title, e.format)} alt="" loading="lazy" />
                  {e.video_path && <span className="ep-play"><Icon name="play" size={9} /></span>}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="episode-title clamp-2" style={{ display: 'block' }}>{e.title}</span>
                  <span className="episode-sub">
                    <Badge tone={st.tone} dot live={st.pulse}>{st.label}</Badge>
                    <span className="hide-md">{e.project_name}</span>
                    <span className="hide-md" style={{ opacity: 0.5 }}>·</span>
                    <span className="hide-md">{FORMAT_LABELS[e.format] || e.format}</span>
                    {e.viral > 0 && <Badge tone={e.viral >= 65 ? 'success' : e.viral >= 45 ? 'warn' : 'danger'}>скор {e.viral}</Badge>}
                    {e.compliance && !e.compliance.ok && <Badge tone="danger"><Icon name="shield" size={10} /> правила</Badge>}
                    {e.risk >= 55 && <Badge tone={e.risk >= 70 ? 'danger' : 'warn'}>риск {e.risk}</Badge>}
                  </span>
                  {!pub && <Progress value={e.progress} striped={e.status === 'generating'} style={{ marginTop: 7, maxWidth: 340 }} />}
                </span>
                <span className="hide-md" style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600 }}>
                    {pub ? 'опубликован' : e.scheduled_at ? 'публикация' : 'этап'}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
                    {pub ? dateTime(e.published_at) : e.scheduled_at ? dateTime(e.scheduled_at) : e.stageLabel}
                  </span>
                </span>
                <span className="hide-md" style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {e.video_bytes ? `${(e.video_bytes / 1048576).toFixed(1)} МБ` : pub ? `${e.pubs} ${plural(e.pubs, 'площадка', 'площадки', 'площадок')}` : `${e.progress}%`}
                </span>
                <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                  {e.status === 'review' && (
                    <button className="btn btn-soft btn-sm" onClick={(ev) => quickApprove(e, ev)} title="Подтвердить">
                      <Icon name="check" size={13} />
                    </button>
                  )}
                  {e.status === 'failed' && (
                    <button className="btn btn-sm" title="Повторить"
                      onClick={async (ev) => { ev.stopPropagation(); await api.episodeAction(e.id, 'retry'); toast.push({ title: 'Ролик перезапущен' }); load(); refreshLight(); }}>
                      <Icon name="refresh" size={13} />
                    </button>
                  )}
                  <Icon name="chevronRight" size={15} style={{ color: 'var(--muted)' }} />
                </span>
              </div>
            );
          })}

          {!loading && !filtered.length && (
            <Empty icon="film" title="Здесь пока пусто" text="Запустите конвейер — Pulse придумает темы и соберёт первые ролики."
              action={<button className="btn btn-primary btn-sm" onClick={onLaunch}><Icon name="zap" size={13} />Запустить конвейер</button>} />
          )}
        </div>
      </div>

      <div className="page-grid grid-3">
        <div className="card">
          <div className="card-title"><h3>Как читать статусы</h3><Icon name="info" size={14} style={{ color: 'var(--muted)' }} /></div>
          <div className="col" style={{ gap: 9 }}>
            {Object.entries(STATUS_META).map(([key, meta]) => (
              <div className="row" key={key} style={{ gap: 8 }}>
                <Badge tone={meta.tone} dot>{meta.label}</Badge>
                <span className="muted" style={{ fontSize: 11 }}>
                  {key === 'queued' && 'ждёт обработчик, задача в очереди'}
                  {key === 'generating' && 'идут этапы: сценарий → озвучка → видео → монтаж'}
                  {key === 'review' && 'нужно ваше подтверждение (риск или ручной режим)'}
                  {key === 'scheduled' && 'стоит в расписании, ждёт слот аккаунта'}
                  {key === 'published' && 'опубликован, метрики собираются'}
                  {key === 'failed' && 'исчерпаны попытки, смотрите ошибку'}
                  {key === 'paused' && 'снят с конвейера вручную'}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-title"><h3>Очередь задач</h3><Badge tone="muted">{data.pipeline?.queue?.pending ?? 0}</Badge></div>
          <div className="hr-stats">
            <div className="hr-stat"><span className="v">{data.pipeline?.queue?.pending ?? 0}</span><span className="l">в ожидании</span></div>
            <div className="hr-stat"><span className="v">{data.pipeline?.queue?.running ?? 0}</span><span className="l">в работе</span></div>
            <div className="hr-stat"><span className="v">{data.pipeline?.queue?.done ?? 0}</span><span className="l">выполнено</span></div>
            <div className="hr-stat"><span className="v">{data.pipeline?.queue?.dead ?? 0}</span><span className="l">dead-letter</span></div>
          </div>
          <div className="notice" style={{ marginTop: 14 }}>
            <Icon name="shield" size={15} />
            <span>Каждая задача имеет lease и до 4 попыток с экспоненциальной задержкой. При перезапуске контейнера ничего не теряется.</span>
          </div>
          <button className="btn btn-sm btn-block" style={{ marginTop: 12 }}
            onClick={async () => { const r = await api.requeue(); toast.push({ title: 'Очередь восстановлена', text: `Перезапущено: ${r.requeued}, восстановлено: ${r.stale + r.swept + r.revived}`, tone: 'success' }); refreshLight(); }}>
            <Icon name="refresh" size={13} />Восстановить очередь
          </button>
        </div>
        <div className="card">
          <div className="card-title"><h3>Площадки</h3></div>
          <div className="col" style={{ gap: 10 }}>
            {['reels', 'tiktok'].map((platform) => {
              const list = (data.accounts || []).filter((a) => a.platform === platform);
              const cap = list.reduce((a, x) => a + x.cap, 0);
              const used = list.reduce((a, x) => a + x.used_today, 0);
              return (
                <div key={platform} className="card flat" style={{ padding: 12 }}>
                  <div className="row-between" style={{ marginBottom: 8 }}>
                    <span className="row" style={{ gap: 7, fontSize: 12.5, fontWeight: 650 }}>
                      <PlatformIcon platform={platform} size={14} />{platform === 'tiktok' ? 'TikTok' : 'Instagram Reels'}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>{list.length} акк.</span>
                  </div>
                  <div className="quota">
                    <div className="quota-bar"><i style={{ width: `${cap ? Math.min(100, (used / cap) * 100) : 0}%` }} /></div>
                    <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{used}/{cap}</span>
                  </div>
                </div>
              );
            })}
            <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.55 }}>
              Лимиты на публикации в день и минимальный интервал защищают аккаунты от перегрузки.
            </div>
          </div>
        </div>
      </div>

      <EpisodeDrawer episodeId={selected} onClose={() => setSelected(null)} onChange={() => { load(); refreshLight(); }} />
    </div>
  );
}
