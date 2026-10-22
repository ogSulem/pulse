import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon, { PlatformIcon } from '../components/Icons.jsx';
import { Badge, Empty } from '../components/ui.jsx';
import EpisodeDrawer from '../components/EpisodeDrawer.jsx';
import { time, dateShort, STATUS_META, plural, platformLabel } from '../lib/format.js';

const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

const dayKey = (iso) => new Date(iso).toISOString().slice(0, 10);

export default function Calendar() {
  const { data, refreshLight } = useApp();
  const [episodes, setEpisodes] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sched, setSched] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [scheduled, published] = await Promise.all([
        api.episodes({ status: 'scheduled', limit: 100 }),
        api.episodes({ status: 'published', limit: 40 }),
      ]);
      setEpisodes([...scheduled, ...published]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [data.pipeline]);

  useEffect(() => {
    let alive = true;
    api.scheduleInsights().then((res) => { if (alive) setSched(res); }).catch(() => {});
    return () => { alive = false; };
  }, [data.pipeline?.published]);

  const days = useMemo(() => {
    const out = [];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    for (let i = -1; i < 6; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      out.push(d);
    }
    return out;
  }, []);

  const byDay = useMemo(() => {
    const map = new Map();
    for (const e of episodes) {
      const iso = e.status === 'published' ? e.published_at : e.scheduled_at;
      if (!iso) continue;
      const k = dayKey(iso);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(e);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.status === 'published' ? a.published_at : a.scheduled_at) - new Date(b.status === 'published' ? b.published_at : b.scheduled_at));
    }
    return map;
  }, [episodes]);

  const today = dayKey(new Date().toISOString());
  const scheduledCount = episodes.filter((e) => e.status === 'scheduled').length;

  return (
    <div className="page">
      <div className="page-grid grid-4">
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">В расписании</span><span className="kpi-icon"><Icon name="calendar" size={14} /></span></div>
          <div className="kpi-value">{scheduledCount}</div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>ближайшие 7 дней</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Опубликовано сегодня</span><span className="kpi-icon"><Icon name="check" size={14} /></span></div>
          <div className="kpi-value">{(byDay.get(today) || []).filter((e) => e.status === 'published').length}</div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>по всем проектам</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Свободные слоты</span><span className="kpi-icon"><Icon name="clock" size={14} /></span></div>
          <div className="kpi-value">
            {Math.max(0, (data.accounts || []).filter((a) => a.status !== 'blocked').reduce((acc, a) => acc + a.cap, 0) - (data.accounts || []).reduce((acc, a) => acc + a.used_today, 0))}
          </div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>на аккаунтах сегодня</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Автопилот</span><span className="kpi-icon"><Icon name="zap" size={14} /></span></div>
          <div className="kpi-value" style={{ fontSize: 20 }}>
            {String(data.settings?.autopilot_global) === '1' ? 'Активен' : 'На паузе'}
          </div>
          <div className="kpi-foot">
            <Badge tone={String(data.settings?.autopilot_global) === '1' ? 'success' : 'muted'} dot>
              {String(data.settings?.autopilot_global) === '1' ? 'публикует сам' : 'только вручную'}
            </Badge>
          </div>
        </div>
      </div>

      {/* ── Умное расписание: когда публиковать и почему ─────────────── */}
      <div className="card pad-lg">
        <div className="card-head">
          <div>
            <h2>Умное расписание</h2>
            <p>
              Часы публикаций: приоры площадок + факт ваших охватов по локальному времени.
              {sched?.timezone ? ` Таймзона — ${sched.timezone}.` : ''}
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Badge tone="accent" dot>{(sched?.platforms || []).some((p) => p.learned) ? 'учится на ваших данных' : 'приоры площадок'}</Badge>
          </div>
        </div>

        <div className="col" style={{ gap: 14 }}>
          {(sched?.platforms || []).map((p) => {
            const bestHours = new Set((p.best || []).map((b) => b.hour));
            return (
              <div key={p.platform} style={{ display: 'grid', gridTemplateColumns: '132px 1fr', gap: 14, alignItems: 'center' }}>
                <div>
                  <div className="row" style={{ gap: 6 }}>
                    <PlatformIcon platform={p.platform} size={14} />
                    <b style={{ fontSize: 12.5 }}>{platformLabel(p.platform)}</b>
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>
                    {p.learned ? `${p.samples} наблюдений` : p.label}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 44 }}>
                  {p.hours.map((h) => {
                    const isBest = bestHours.has(h.hour);
                    const height = Math.max(6, Math.round((h.score / 1.2) * 40));
                    const night = h.hour < 7 || h.hour > 22;
                    return (
                      <div key={h.hour} title={`${String(h.hour).padStart(2, '0')}:00 — скор ${h.score}${h.samples ? `, ${h.samples} постов` : ''}`}
                        style={{ flex: 1, height, borderRadius: 3,
                          background: isBest ? 'linear-gradient(180deg,#c4b5fd,#7c3aed)' : night ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.16)',
                          opacity: isBest ? 1 : 0.9 }} />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="row-between wrap" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)', gap: 10 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
            <Icon name="clock" size={13} style={{ verticalAlign: '-2px', marginRight: 6, color: 'var(--violet-2)' }} />
            {sched?.plan?.reason || 'Следующий слот рассчитается, когда появятся свободные окна'}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>
            {sched?.plan ? `следующий слот: ${new Date(sched.plan.at).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · источник: ${sched.plan.source === 'data' ? 'ваши данные' : 'приор'}` : ''}
          </div>
        </div>
      </div>

      <div className="card pad-lg">
        <div className="card-head">
          <div>
            <h2>Неделя публикаций</h2>
            <p>Слоты распределяются по аккаунтам с учётом лимитов и минимальных интервалов</p>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <span className="legend"><span><i style={{ background: 'var(--violet-2)' }} />запланировано</span></span>
            <span className="legend"><span><i style={{ background: 'var(--green)' }} />опубликовано</span></span>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(138px, 1fr))', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
          {days.map((d) => {
            const k = dayKey(d.toISOString());
            const list = byDay.get(k) || [];
            const isToday = k === today;
            const isPast = k < today;
            return (
              <div key={k} style={{
                borderRadius: 14,
                border: `1px solid ${isToday ? 'rgba(167,139,250,.4)' : 'var(--line)'}`,
                background: isToday ? 'rgba(139,92,246,.09)' : 'var(--surface)',
                padding: 9,
                minHeight: 300,
                opacity: isPast && !isToday ? 0.72 : 1,
              }}>
                <div className="row-between" style={{ marginBottom: 9, paddingBottom: 8, borderBottom: '1px solid var(--line)' }}>
                  <div>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.1em', color: isToday ? 'var(--violet-3)' : 'var(--muted)', fontWeight: 700 }}>
                      {isToday ? 'сегодня' : WD[d.getDay()]}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 750, letterSpacing: '-0.02em' }}>{d.getDate()}</div>
                  </div>
                  {list.length > 0 && <span style={{ fontSize: 10, color: 'var(--muted)' }}>{list.length}</span>}
                </div>

                <div className="col" style={{ gap: 6 }}>
                  {list.map((e) => {
                    const iso = e.status === 'published' ? e.published_at : e.scheduled_at;
                    const st = STATUS_META[e.status] || {};
                    return (
                      <button key={e.id} onClick={() => setSelected(e.id)} style={{
                        textAlign: 'left', cursor: 'pointer', padding: '7px 8px', borderRadius: 9,
                        border: '1px solid var(--line)', background: 'rgba(255,255,255,.03)',
                        display: 'flex', gap: 7, alignItems: 'flex-start',
                      }}>
                        <span style={{ fontSize: 10, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', marginTop: 1 }}>{time(iso)}</span>
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span className="clamp-2" style={{ display: 'block', fontSize: 10.5, lineHeight: 1.35, fontWeight: 600 }}>{e.title}</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                            <span style={{ width: 5, height: 5, borderRadius: 9, background: e.status === 'published' ? 'var(--green)' : 'var(--violet-2)' }} />
                            <span style={{ fontSize: 9.5, color: 'var(--muted)' }}>{e.project_name}</span>
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {!list.length && (
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', textAlign: 'center', padding: '18px 0', border: '1px dashed var(--line)', borderRadius: 9 }}>
                      свободно
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {loading && <div className="skeleton" style={{ height: 60, marginTop: 12 }} />}
      </div>

      <div className="page-grid grid-2">
        <div className="card">
          <div className="card-title"><h3>Правила планирования</h3><Icon name="shield" size={14} style={{ color: 'var(--muted)' }} /></div>
          <div className="col" style={{ gap: 10, fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon name="clock" size={14} style={{ color: 'var(--violet-2)', marginTop: 2 }} />
              <span>Минимальный интервал между постами одного аккаунта — 90–140 минут (настраивается).</span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon name="target" size={14} style={{ color: 'var(--violet-2)', marginTop: 2 }} />
              <span>Дневная квота на аккаунт: 2–3 публикации. При исчерпании задача переносится, а не форсируется.</span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon name="layers" size={14} style={{ color: 'var(--violet-2)', marginTop: 2 }} />
              <span>Слоты двигаются с джиттером ±12% — публикации не выглядят как бот-расписание.</span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon name="at" size={14} style={{ color: 'var(--violet-2)', marginTop: 2 }} />
              <span>Нагрузка уходит на аккаунт с наибольшим остатком квоты и лучшим качеством.</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title"><h3>Скоро выйдут</h3><a className="link-btn" href="#/queue">в очередь <Icon name="chevronRight" size={12} /></a></div>
          <div className="col" style={{ gap: 8 }}>
            {episodes.filter((e) => e.status === 'scheduled' && e.scheduled_at).sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at)).slice(0, 5).map((e) => (
              <button key={e.id} onClick={() => setSelected(e.id)} className="row" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', gap: 10, textAlign: 'left' }}>
                <span className="ep-cover" style={{ width: 30, aspectRatio: '9/16', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--line)', flex: 'none' }}>
                  <img src={api.coverUrl(e.cover_seed, e.title, e.format)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="truncate" style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>{e.title}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{dateShort(e.scheduled_at)} · {time(e.scheduled_at)} · {e.project_name}</span>
                </span>
                <Icon name="chevronRight" size={14} style={{ color: 'var(--muted)' }} />
              </button>
            ))}
            {!episodes.some((e) => e.status === 'scheduled') && <Empty icon="calendar" title="Расписание пустое" text="Запустите конвейер — слоты заполнятся автоматически." />}
          </div>
        </div>
      </div>

      <EpisodeDrawer episodeId={selected} onClose={() => setSelected(null)} onChange={() => { load(); refreshLight(); }} />
    </div>
  );
}
