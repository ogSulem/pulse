import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon, { PlatformIcon } from '../components/Icons.jsx';
import { Badge, AreaChart, BarList, Segmented, Donut, Empty, Modal } from '../components/ui.jsx';
import { fmt, full, dateShort, time, FORMAT_LABELS, pct } from '../lib/format.js';

export default function Analytics() {
  const { data } = useApp();
  const [days, setDays] = useState(14);
  const [projectId, setProjectId] = useState('all');
  const [metric, setMetric] = useState('views');
  const [overview, setOverview] = useState(null);
  const [publications, setPublications] = useState([]);
  const [tab, setTab] = useState('tables');
  const [abOpen, setAbOpen] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      api.analytics({ days, projectId }),
      api.publications({ limit: 80, projectId }),
    ]).then(([o, p]) => {
      if (!alive) return;
      setOverview(o);
      setPublications(p);
    }).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [days, projectId, data.pipeline]);

  const series = overview?.series || [];
  const totals = overview?.totals;
  const chartSeries = metric === 'views'
    ? [{ key: 'views', color: '#a78bfa', label: 'Просмотры' }, { key: 'clicks', color: '#67e8f9', label: 'Клики' }]
    : metric === 'engagement'
      ? [{ key: 'likes', color: '#f0abfc', label: 'Лайки' }, { key: 'shares', color: '#a78bfa', label: 'Репосты' }]
      : [{ key: 'followers', color: '#6ee7b7', label: 'Подписчики' }];

  const donutSegments = useMemo(() => {
    const palette = ['#a78bfa', '#67e8f9', '#f0abfc', '#6ee7b7', '#fbbf24', '#fb7185'];
    return (overview?.byProject || []).map((p, i) => ({ label: p.name, value: p.views, color: palette[i % palette.length] }));
  }, [overview]);

  const exportList = [
    { type: 'analytics', label: 'Статистика публикаций' },
    { type: 'episodes', label: 'Ролики и статусы' },
    { type: 'ideas', label: 'Темы' },
    { type: 'scripts', label: 'Сценарии' },
  ];

  const WEIGHT_LABELS = {
    hook: 'хук', length: 'длина', pace: 'темп', retention: 'удержание', caption: 'описание', novelty: 'новизна',
  };
  const bestWeightLabel = (w) => {
    const entries = Object.entries(w.weights || {});
    if (!entries.length) return 'хук';
    const [key] = entries.sort((a, b) => b[1] - a[1])[0];
    return WEIGHT_LABELS[key] || key;
  };

  return (
    <div className="page">
      <div className="card">
        <div className="row-between wrap" style={{ gap: 12 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <Segmented value={days} onChange={setDays} options={[{ value: 7, label: '7 дней' }, { value: 14, label: '14 дней' }, { value: 30, label: '30 дней' }]} />
            <select className="select" style={{ width: 180 }} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="all">Все проекты</option>
              {data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {exportList.map((e) => (
              <a key={e.type} className="btn btn-sm" href={api.exportUrl(e.type)} title={e.label}>
                <Icon name="download" size={13} />{e.type === 'analytics' ? 'CSV' : e.type}
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className="page-grid grid-4">
        {[
          { label: 'Просмотры', value: fmt(totals?.views), trend: totals?.viewsChange, icon: 'eye', sub: null },
          { label: 'Средний охват ролика', value: fmt(totals?.avgViews), icon: 'activity', sub: `${totals?.posts || 0} публикаций` },
          { label: 'CTR на продукт', value: pct(totals?.ctr || 0), trend: totals?.clicksChange, icon: 'target', sub: `${fmt(totals?.clicks)} кликов` },
          { label: 'Подписчики', value: fmt(totals?.followers), trend: totals?.followersChange, icon: 'user', sub: `вовлечённость ${pct(totals?.engagement || 0)}` },
        ].map((k) => (
          <div className="card kpi" key={k.label}>
            <div className="kpi-top"><span className="kpi-label">{k.label}</span><span className="kpi-icon"><Icon name={k.icon} size={14} /></span></div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-foot">
              {k.trend !== undefined ? (
                <span className={`trend ${k.trend > 0 ? 'up' : k.trend < 0 ? 'down' : 'flat'}`}>
                  <Icon name={k.trend > 0 ? 'arrowUpRight' : k.trend < 0 ? 'arrowDown' : 'minus'} size={11} />{k.trend}%
                </span>
              ) : <span />}
              {k.sub && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{k.sub}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="page-grid grid-2-1">
        <div className="card pad-lg">
          <div className="card-head">
            <div>
              <h2>Охват по дням</h2>
              <p>{dateShort(series[0]?.day)} — {dateShort(series[series.length - 1]?.day)} · клики показывают, сколько трафика ушло на продукт</p>
            </div>
            <Segmented size="sm" value={metric} onChange={setMetric}
              options={[{ value: 'views', label: 'Охват' }, { value: 'engagement', label: 'Реакции' }, { value: 'followers', label: 'Подписки' }]} />
          </div>
          {loading && !series.length ? <div className="skeleton" style={{ height: 280 }} /> : (
            <AreaChart data={series} series={chartSeries} height={286} todayIndex={series.length - 1} />
          )}
          <div className="legend" style={{ marginTop: 12 }}>
            {chartSeries.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
          </div>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-title"><h3>Распределение охвата</h3></div>
            <div className="row" style={{ gap: 18, alignItems: 'center' }}>
              <Donut segments={donutSegments} centerValue={fmt(totals?.views)} centerLabel="просмотры" />
              <div className="col" style={{ gap: 8, flex: 1, minWidth: 0 }}>
                {donutSegments.map((s) => (
                  <div className="row-between" key={s.label} style={{ fontSize: 11.5 }}>
                    <span className="row" style={{ gap: 6, minWidth: 0 }}>
                      <i style={{ width: 7, height: 7, borderRadius: 2, background: s.color, flex: 'none' }} />
                      <span className="truncate" style={{ color: 'var(--text-2)' }}>{s.label}</span>
                    </span>
                    <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(s.value)}</b>
                  </div>
                ))}
                {!donutSegments.length && <span className="muted" style={{ fontSize: 11.5 }}>Нет данных</span>}
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-title"><h3>Эффективность форматов</h3></div>
            {overview?.byFormat?.length
              ? <BarList items={overview.byFormat} valueKey="views" labelKey="label" />
              : <span className="muted" style={{ fontSize: 11.5 }}>Недостаточно данных</span>}
          </div>

          <div className="card">
            <div className="card-title">
              <h3>Чему научилась модель</h3>
              <span className="sub">{overview?.intelligence?.weights?.source === 'learned' ? 'на ваших данных' : 'приоры'}</span>
            </div>
            {overview?.intelligence?.weights?.source === 'learned' ? (
              <>
                <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.55, marginBottom: 8 }}>
                  Веса вирусного скора пересчитаны на {overview.intelligence.weights.samples} роликах:
                  сильнее всего с охватом связан признак «{bestWeightLabel(overview.intelligence.weights)}».
                </div>
                <div className="col" style={{ gap: 5 }}>
                  {Object.entries(overview.intelligence.weights.weights || {}).map(([k, w]) => (
                    <div key={k} className="row" style={{ gap: 8, alignItems: 'center' }}>
                      <span style={{ width: 96, fontSize: 10.5, color: 'var(--muted)' }}>{WEIGHT_LABELS[k] || k}</span>
                      <span style={{ flex: 1, height: 5, borderRadius: 4, background: 'rgba(255,255,255,.08)' }}>
                        <span style={{ display: 'block', width: `${Math.round(w * 260)}%`, maxWidth: '100%', height: '100%', borderRadius: 4, background: 'linear-gradient(90deg,#8b5cf6,#c4b5fd)' }} />
                      </span>
                      <b style={{ fontSize: 10.5, minWidth: 34, textAlign: 'right' }}>{Math.round(w * 100)}%</b>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <span className="muted" style={{ fontSize: 11.5 }}>
                Пока используются приоры. После 12 опубликованных роликов веса пересчитаются по фактическому охвату.
              </span>
            )}
            {overview?.intelligence?.schedule?.length ? (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)', fontSize: 11, color: 'var(--text-2)' }}>
                Лучшие часы: {overview.intelligence.schedule.map((s) => `${s.platform === 'tiktok' ? 'TikTok' : 'Reels'} ${s.best.slice(0, 2).map((b) => `${String(b.hour).padStart(2, '0')}:00`).join(', ')}`).join(' · ')}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 6 }}>
        {[{ id: 'tables', label: 'Разрезы' }, { id: 'ab', label: `A/B-тесты · ${overview?.ab?.length || 0}` }, { id: 'posts', label: 'Все публикации' }].map((t) => (
          <button key={t.id} className={`chip ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === 'tables' && (
        <div className="page-grid grid-2">
          <div className="card">
            <div className="card-title"><h3>По темам</h3><span className="sub">сортировка по охвату</span></div>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Тема</th><th>Формат</th><th className="num">Постов</th><th className="num">Просмотры</th><th className="num">Клики</th></tr></thead>
                <tbody>
                  {(overview?.byTheme || []).map((t, i) => (
                    <tr key={i}>
                      <td className="strong" style={{ maxWidth: 230 }}><span className="clamp-2">{t.theme}</span></td>
                      <td>{FORMAT_LABELS[t.format] || t.format}</td>
                      <td className="num">{t.posts}</td>
                      <td className="num strong">{fmt(t.views)}</td>
                      <td className="num">{fmt(t.clicks)}</td>
                    </tr>
                  ))}
                  {!overview?.byTheme?.length && <tr><td colSpan="5"><Empty icon="chart" title="Нет данных за период" text="Попробуйте увеличить диапазон или запустить публикации." /></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <div className="card-title"><h3>По проектам</h3><span className="sub">сравнение</span></div>
            <div className="col" style={{ gap: 14 }}>
              {(overview?.byProject || []).map((p) => {
                const max = Math.max(1, ...(overview?.byProject || []).map((x) => x.views));
                return (
                  <div key={p.id}>
                    <div className="row-between" style={{ marginBottom: 6 }}>
                      <span className="row" style={{ gap: 7 }}>
                        <span style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--violet-2)' }} />
                        <b style={{ fontSize: 12.5 }}>{p.name}</b>
                        <span className="muted" style={{ fontSize: 11 }}>{p.posts} публ.</span>
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 700 }}>{fmt(p.views)}</span>
                    </div>
                    <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(4, (p.views / max) * 100)}%` }} /></div>
                    <div className="row" style={{ gap: 14, marginTop: 5, fontSize: 10.5, color: 'var(--muted)' }}>
                      <span>CTR {p.views ? ((p.clicks / p.views) * 100).toFixed(1).replace('.', ',') : 0}%</span>
                      <span>+{fmt(p.followers)} подписчиков</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="divider" />
            <div className="notice">
              <Icon name="sparkles" size={15} />
              <span>Pulse подбирает похожие темы у форматов с лучшим средним охватом. Следующая партия роликов будет опираться на эти данные.</span>
            </div>
          </div>
        </div>
      )}

      {tab === 'ab' && (
        <div className="page-grid grid-2">
          {(overview?.ab || []).map((t) => (
            <div className="card hoverable" key={t.episode_id} style={{ cursor: 'pointer' }} onClick={() => setAbOpen(t)}>
              <div className="card-title">
                <h3 className="clamp-2" style={{ maxWidth: 300 }}>{t.title}</h3>
                <Badge tone="accent">победитель {t.winner}</Badge>
              </div>
              <div className="row" style={{ gap: 10 }}>
                {[
                  { v: 'A', views: t.a_views, cover: t.a_cover, win: t.winner === 'A' },
                  { v: 'B', views: t.b_views, cover: t.b_cover, win: t.winner === 'B' },
                ].map((side) => (
                  <div key={side.v} style={{ flex: 1, minWidth: 0 }}>
                    <div className="cover" style={{ aspectRatio: '9/16' }}>
                      <img src={api.coverUrl(side.cover || `${t.episode_id}-${side.v}`, t.title, `вариант ${side.v}`)} alt="" />
                      {side.win && <span className="cover-badge" style={{ background: 'var(--violet)', color: '#fff' }}>лучший</span>}
                      <span className="cover-metric"><span>{side.v}</span><span><Icon name="eye" size={10} />{fmt(side.views)}</span></span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="row-between" style={{ marginTop: 12, fontSize: 11.5, color: 'var(--muted)' }}>
                <span>Разница охвата</span>
                <b style={{ color: 'var(--violet-3)' }}>{t.lift}%</b>
              </div>
            </div>
          ))}
          {!overview?.ab?.length && (
            <div className="card" style={{ gridColumn: 'span 2' }}>
              <Empty icon="target" title="A/B-тестов пока нет" text="Включите A/B в настройках проекта — Pulse будет публиковать два варианта описания и обложки на одном аккаунте." />
            </div>
          )}
        </div>
      )}

      {tab === 'posts' && (
        <div className="card pad-lg">
          <div className="card-title"><h3>Публикации</h3><span className="sub">{publications.length} последних</span></div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Ролик</th><th>Площадка</th><th className="num">Просмотры</th><th className="num">Лайки</th>
                  <th className="num">Репосты</th><th className="num">Клики</th><th className="num">CTR</th><th>Дата</th>
                </tr>
              </thead>
              <tbody>
                {publications.slice(0, 40).map((p) => (
                  <tr key={p.id}>
                    <td style={{ maxWidth: 320 }}>
                      <div className="row" style={{ gap: 8 }}>
                        <span className="ep-cover" style={{ width: 26, aspectRatio: '9/16', borderRadius: 4, overflow: 'hidden', flex: 'none', border: '1px solid var(--line)' }}>
                          <img src={api.coverUrl(p.cover_seed, p.title, p.format)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <span className="truncate strong" style={{ display: 'block', maxWidth: 300 }}>{p.title}</span>
                          <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{p.project_name} · вариант {p.variant}</span>
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <PlatformIcon platform={p.platform} size={13} />@{p.handle}
                      </span>
                    </td>
                    <td className="num strong">{fmt(p.views)}</td>
                    <td className="num">{fmt(p.likes)}</td>
                    <td className="num">{fmt(p.shares)}</td>
                    <td className="num">{fmt(p.clicks)}</td>
                    <td className="num">{pct(p.ctr || 0)}</td>
                    <td style={{ fontSize: 11, color: 'var(--muted)' }}>{dateShort(p.published_at)}</td>
                  </tr>
                ))}
                {!publications.length && <tr><td colSpan="8"><Empty icon="film" title="Публикаций нет" text="Опубликуйте первый ролик — здесь появится статистика." /></td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal open={Boolean(abOpen)} onClose={() => setAbOpen(null)} title={abOpen?.title} subtitle={`A/B-тест · разница охвата ${abOpen?.lift || 0}%`} wide>
        {abOpen && (
          <div className="col" style={{ gap: 16 }}>
            <div className="row" style={{ gap: 12, alignItems: 'stretch' }}>
              {[
                { v: 'A', views: abOpen.a_views, clicks: abOpen.a_clicks, cover: abOpen.a_cover },
                { v: 'B', views: abOpen.b_views, clicks: abOpen.b_clicks, cover: abOpen.b_cover },
              ].map((side) => (
                <div key={side.v} className="card flat" style={{ flex: 1, padding: 12 }}>
                  <div className="cover" style={{ marginBottom: 10 }}>
                    <img src={api.coverUrl(side.cover || `${abOpen.episode_id}-${side.v}`, abOpen.title, `вариант ${side.v}`)} alt="" />
                  </div>
                  <div className="row-between">
                    <b style={{ fontSize: 13 }}>Вариант {side.v}</b>
                    {abOpen.winner === side.v && <Badge tone="success">победил</Badge>}
                  </div>
                  <div className="hr-stats" style={{ marginTop: 8 }}>
                    <div className="hr-stat"><span className="v">{fmt(side.views)}</span><span className="l">просмотры</span></div>
                    <div className="hr-stat"><span className="v">{fmt(side.clicks)}</span><span className="l">клики</span></div>
                  </div>
                </div>
              ))}
            </div>
            <div className="notice accent">
              <Icon name="sparkles" size={15} />
              <span>Вывод: лучше сработал вариант <b>{abOpen.winner}</b>. Pulse учтёт обложку и формулировку при генерации следующих роликов этой темы.</span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
