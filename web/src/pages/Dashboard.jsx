import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon, { PlatformIcon } from '../components/Icons.jsx';
import { Badge, Kpi, Progress, AreaChart, BarList, Segmented, Sparkline, Empty } from '../components/ui.jsx';
import EpisodeDrawer from '../components/EpisodeDrawer.jsx';
import { fmt, dateShort, time, relative, STATUS_META, FORMAT_LABELS, plural, ACCOUNT_STATUS, money, pct, bytes, platformLabel } from '../lib/format.js';

const STAGE_ORDER = [
  { key: 'idea', label: 'Идея', icon: 'sparkles' },
  { key: 'script', label: 'Сценарий', icon: 'edit' },
  { key: 'voice', label: 'Озвучка', icon: 'mic' },
  { key: 'footage', label: 'Видео', icon: 'film' },
  { key: 'edit', label: 'Монтаж', icon: 'scissors' },
  { key: 'published', label: 'Опубликовано', icon: 'check' },
];

export default function Dashboard({ onLaunch }) {
  const { data, refreshLight } = useApp();
  const [analytics, setAnalytics] = useState(null);
  const [metric, setMetric] = useState('views');
  const [days, setDays] = useState(14);
  const [selected, setSelected] = useState(null);
  const [moneyData, setMoneyData] = useState(null);
  const [checks, setChecks] = useState(null);

  useEffect(() => {
    api.analytics({ days }).then(setAnalytics).catch(() => {});
  }, [days, data.pipeline]);

  useEffect(() => {
    api.money({ days: 30 }).then(setMoneyData).catch(() => {});
    api.transparency().then(setChecks).catch(() => {});
  }, [data.pipeline?.published]);

  const totals = analytics?.totals;
  const series = analytics?.series || [];
  const pipeline = data.pipeline || {};
  const active = (pipeline.active || []).filter((e) => ['generating', 'queued', 'review'].includes(e.status));

  const stageCounts = useMemo(() => {
    const byStage = {};
    (pipeline.active || []).forEach((e) => { byStage[e.stage] = (byStage[e.stage] || 0) + 1; });
    return STAGE_ORDER.map((s) => ({ ...s, value: byStage[s.key] || 0 }));
  }, [pipeline.active]);

  const todayViews = series.length ? Number(series[series.length - 1].views) || 0 : 0;
  const yesterdayViews = series.length > 1 ? Number(series[series.length - 2].views) || 0 : 0;
  const todayPosts = Number(pipeline.published) || 0;
  const scheduled = Number(pipeline.scheduled) || 0;
  const review = Number(pipeline.review) || 0;

  const bestProduct = data.products?.[0];
  const quota = (data.accounts || []).filter((a) => a.status !== 'blocked');
  const quotaTotal = quota.reduce((a, x) => a + x.cap, 0);
  const quotaUsed = quota.reduce((a, x) => a + x.used_today, 0);

  const spark = (key) => series.slice(-10).map((d) => Number(d[key]) || 0);
  const chartSeries = metric === 'views'
    ? [{ key: 'views', color: '#a78bfa', label: 'Просмотры' }, { key: 'clicks', color: '#67e8f9', label: 'Клики' }]
    : metric === 'engagement'
      ? [{ key: 'likes', color: '#f0abfc', label: 'Лайки' }, { key: 'shares', color: '#a78bfa', label: 'Репосты' }]
      : [{ key: 'followers', color: '#6ee7b7', label: 'Подписчики' }];

  return (
    <div className="page">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="card pad-lg" style={{
        background: 'linear-gradient(120deg, rgba(124,58,237,.22), rgba(139,92,246,.06) 45%, rgba(12,8,18,.2))',
        borderColor: 'rgba(167,139,250,.24)',
      }}>
        <div className="row-between wrap" style={{ gap: 20, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 260, flex: '1 1 320px' }}>
            <div className="row" style={{ gap: 8, marginBottom: 10 }}>
              <Badge tone="accent" dot live>движок активен</Badge>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{dateShort(new Date().toISOString())} · {time(new Date().toISOString())}</span>
            </div>
            <h1 style={{ fontSize: 27, lineHeight: 1.16, fontWeight: 790, letterSpacing: '-0.045em', maxWidth: 560 }}>
              {active.length > 0 ? (
                <>Конвейер собирает <span className="gradient-text">{active.length} {plural(active.length, 'ролик', 'ролика', 'роликов')}</span> прямо сейчас</>
              ) : (
                <>Конвейер готов к <span className="gradient-text">новой партии</span> роликов</>
              )}
            </h1>
            <p className="dim" style={{ fontSize: 12.5, marginTop: 9, maxWidth: 520, lineHeight: 1.6 }}>
              {review > 0
                ? `${review} ${plural(review, 'ролик ждёт', 'ролика ждут', 'роликов ждут')} вашего подтверждения — остальное Pulse сделает сам.`
                : 'Сценарии, озвучка, видеоряд и публикация идут без вашего участия. Вы контролируете только то, что важно.'}
            </p>
            <div className="row wrap" style={{ gap: 8, marginTop: 16 }}>
              <button className="btn btn-primary" onClick={onLaunch}><Icon name="zap" size={15} />Запустить конвейер</button>
              <a className="btn" href="#/queue"><Icon name="film" size={15} />Открыть очередь</a>
              <a className="btn btn-ghost" href="#/analytics"><Icon name="chart" size={15} />Аналитика</a>
            </div>
          </div>

          <div style={{ flex: '1 1 300px', minWidth: 260 }}>
            <div className="stages" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
              {STAGE_ORDER.slice(0, 3).map((s) => (
                <div className={`stage ${s.value ? 'active' : ''}`} key={s.key}>
                  <div className="stage-top"><Icon name={s.icon} size={12} />{s.label}</div>
                  <div className="stage-num">{s.value}</div>
                </div>
              ))}
              {STAGE_ORDER.slice(3).map((s) => (
                <div className={`stage ${s.value ? 'active' : ''}`} key={s.key}>
                  <div className="stage-top"><Icon name={s.icon} size={12} />{s.label}</div>
                  <div className="stage-num">{s.key === 'published' ? todayPosts : s.value}</div>
                </div>
              ))}
            </div>
            <div className="row" style={{ gap: 14, marginTop: 12, fontSize: 11.5, color: 'var(--muted)' }}>
              <span><Icon name="clock" size={12} style={{ verticalAlign: -2 }} /> {scheduled} в расписании</span>
              <span><Icon name="database" size={12} style={{ verticalAlign: -2 }} /> {pipeline.queue?.pending ?? 0} задач в очереди</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── KPI ──────────────────────────────────────────────────────────── */}
      <div className="page-grid grid-4">
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Просмотры · 14 дней</span><span className="kpi-icon"><Icon name="eye" size={14} /></span></div>
          <div className="kpi-value">{fmt(totals?.views)}</div>
          <div className="kpi-foot">
            <span className={`trend ${(totals?.viewsChange || 0) >= 0 ? 'up' : 'down'}`}>
              <Icon name={(totals?.viewsChange || 0) >= 0 ? 'arrowUpRight' : 'arrowDown'} size={11} />
              {totals?.viewsChange || 0}%
            </span>
            <Sparkline values={spark('views')} />
          </div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Клики на продукт</span><span className="kpi-icon"><Icon name="link" size={14} /></span></div>
          <div className="kpi-value">{fmt(totals?.clicks)} <small>CTR {String(totals?.ctr || 0).replace('.', ',')}%</small></div>
          <div className="kpi-foot">
            <span className={`trend ${(totals?.clicksChange || 0) >= 0 ? 'up' : 'down'}`}>
              <Icon name={(totals?.clicksChange || 0) >= 0 ? 'arrowUpRight' : 'arrowDown'} size={11} />
              {totals?.clicksChange || 0}%
            </span>
            <Sparkline values={spark('clicks')} color="#67e8f9" />
          </div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Подписчики</span><span className="kpi-icon"><Icon name="user" size={14} /></span></div>
          <div className="kpi-value">{fmt(totals?.followers)}</div>
          <div className="kpi-foot">
            <span className={`trend ${(totals?.followersChange || 0) >= 0 ? 'up' : 'down'}`}>
              <Icon name={(totals?.followersChange || 0) >= 0 ? 'arrowUpRight' : 'arrowDown'} size={11} />
              {totals?.followersChange || 0}%
            </span>
            <Sparkline values={spark('followers')} color="#6ee7b7" />
          </div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Публикации</span><span className="kpi-icon"><Icon name="film" size={14} /></span></div>
          <div className="kpi-value">{totals?.posts || 0} <small>за период</small></div>
          <div className="kpi-foot">
            <span className="trend flat"><Icon name="activity" size={11} />в среднем {fmt(totals?.avgViews)} просмотров</span>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>сегодня</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{fmt(todayViews)} <span style={{ fontSize: 10, color: 'var(--muted)' }}>просм.</span></div>
            </div>
          </div>
        </div>
      </div>


      {/* ── Деньги: одна строка, по которой всё понятно ───────────────────── */}
      {moneyData && (
        <div className="card money-band">
          <div className="money-band-main">
            <div className="eyebrow">прибыль за 30 дней</div>
            <div className="money-band-value">{money(moneyData.totals.profit, moneyData.currency)}</div>
            <div className="money-band-sub">
              доход {money(moneyData.totals.revenue, moneyData.currency)} · расход {money(moneyData.totals.cost, moneyData.currency)}
              {moneyData.totals.roi != null && <> · ROI {Math.round(moneyData.totals.roi)}%</>}
              {moneyData.totals.revenueSponsor > 0 && <> · в т.ч. <a href="#/ads" style={{ textDecoration: 'underline', textUnderlineOffset: 2 }}>спонсоры {money(moneyData.totals.revenueSponsor, moneyData.currency)}</a></>}
            </div>
          </div>
          <div className="money-band-stats">
            <div><span>RPM факт</span><b>{money(moneyData.totals.rpmAvg, moneyData.currency)}</b></div>
            <div><span>CTR</span><b>{pct(moneyData.totals.ctr, 2)}</b></div>
            <div><span>Покупки</span><b>{moneyData.totals.conversions}</b></div>
            <div><span>Прибыль/ролик</span><b>{money(moneyData.totals.profitPerVideo, moneyData.currency)}</b></div>
          </div>
          <a className="btn btn-soft btn-sm" href="#/money"><Icon name="target" size={14} />Открыть деньги</a>
        </div>
      )}

      {/* ── Прозрачность: что требует человека ───────────────────────────── */}
      {checks && (checks.blocked.length > 0 || checks.lowViral.length > 0) && (
        <div className="card checks-band">
          <div className="row-between" style={{ gap: 12, marginBottom: 10 }}>
            <div>
              <div className="card-title" style={{ marginBottom: 2 }}>Требует вашего решения</div>
              <div className="card-sub">Pulse не публикует то, что нарушает правила или вряд ли зайдёт — проверьте и решите</div>
            </div>
            <a className="link-btn" href="#/transparency">все проверки <Icon name="chevronRight" size={12} /></a>
          </div>
          <div className="checks-band-grid">
            {checks.blocked.slice(0, 3).map((b) => (
              <button className="check-chip danger" key={b.id} onClick={() => setSelected(b.id)}>
                <Icon name="alert" size={13} />
                <span className="truncate">{b.title}</span>
                <em>{b.compliance?.blocking?.[0]?.id}</em>
              </button>
            ))}
            {checks.lowViral.slice(0, 3).map((v) => (
              <button className="check-chip warn" key={v.id} onClick={() => setSelected(v.id)}>
                <Icon name="flame" size={13} />
                <span className="truncate">{v.title}</span>
                <em>скор {v.viral}</em>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Chart + formats ──────────────────────────────────────────────── */}
      <div className="page-grid grid-2-1">
        <div className="card pad-lg">
          <div className="card-head">
            <div>
              <h2>Динамика конвейера</h2>
              <p>Просмотры и клики по дням · последние {days} дней</p>
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <Segmented size="sm" value={days} onChange={setDays} options={[{ value: 7, label: '7д' }, { value: 14, label: '14д' }, { value: 30, label: '30д' }]} />
              <Segmented size="sm" value={metric} onChange={setMetric}
                options={[{ value: 'views', label: 'Охват' }, { value: 'engagement', label: 'Реакции' }, { value: 'followers', label: 'Подписки' }]} />
            </div>
          </div>
          {series.length ? (
            <AreaChart
              data={series}
              series={chartSeries}
              height={252}
              todayIndex={series.length - 1}
            />
          ) : <div className="skeleton" style={{ height: 252 }} />}
          <div className="row" style={{ gap: 14, marginTop: 12, justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div className="legend">
              {chartSeries.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
            </div>
            <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>сегодня — неполный день · {fmt(yesterdayViews)} вчера</span>
          </div>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-title">
              <h3>Что заходит</h3>
              <a className="link-btn" href="#/analytics">все форматы <Icon name="chevronRight" size={12} /></a>
            </div>
            {analytics?.byFormat?.length ? (
              <BarList items={analytics.byFormat.slice(0, 5)} valueKey="views" labelKey="label" />
            ) : <div className="skeleton" style={{ height: 130 }} />}
            <div className="divider" />
            <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.55 }}>
              Топ-тема: <b style={{ color: 'var(--text)' }}>{analytics?.byTheme?.[0]?.theme || '—'}</b>
              {analytics?.byTheme?.[0] ? ` · ${fmt(analytics.byTheme[0].views)} просмотров` : ''}
            </div>
          </div>

          <div className="card">
            <div className="card-title"><h3>Продукт в работе</h3><Icon name="package" size={14} style={{ color: 'var(--muted)' }} /></div>
            {bestProduct ? (
              <>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{bestProduct.name}</div>
                <p className="muted" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.5 }}>{bestProduct.pitch || 'Интеграция в каждый сценарий'}</p>
                <div className="row" style={{ gap: 8, marginTop: 12 }}>
                  <span className="hashtag">utm_source={bestProduct.utm_source}</span>
                  <span className="hashtag">utm_campaign={bestProduct.utm_campaign}</span>
                </div>
                <div className="row-between" style={{ marginTop: 14 }}>
                  <div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>клики</div>
                    <div style={{ fontSize: 16, fontWeight: 750 }}>{fmt(totals?.clicks)}</div>
                  </div>
                  <a className="btn btn-soft btn-sm" href="#/products">Настроить <Icon name="arrowUpRight" size={12} /></a>
                </div>
              </>
            ) : <Empty icon="package" title="Продукт не добавлен" text="Добавьте ссылку — Pulse подставит её в сценарии и описания." />}
          </div>
        </div>
      </div>

      {/* ── Live conveyor ────────────────────────────────────────────────── */}
      <div className="card pad-lg">
        <div className="card-head">
          <div>
            <h2>Живой конвейер</h2>
            <p>Что происходит с роликами прямо сейчас</p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => { api.drain().then(refreshLight); }}><Icon name="play" size={13} />Прогнать очередь</button>
            <a className="btn btn-sm" href="#/queue">Все ролики <Icon name="chevronRight" size={12} /></a>
          </div>
        </div>

        <div className="stages" style={{ marginBottom: 16 }}>
          {STAGE_ORDER.map((s, i) => {
            const item = stageCounts[i];
            return (
              <div className={`stage ${item.value ? 'active' : ''}`} key={s.key}>
                <div className="stage-top"><Icon name={s.icon} size={12} />{item.label}</div>
                <div className="stage-num">{s.key === 'published' ? todayPosts : item.value}</div>
                {i < STAGE_ORDER.length - 1 && <span className="stage-arrow"><Icon name="chevronRight" size={13} /></span>}
              </div>
            );
          })}
        </div>

        <div className="col" style={{ gap: 7 }}>
          {active.slice(0, 5).map((e) => (
            <button key={e.id} className="episode-row" style={{ textAlign: 'left', border: '1px solid var(--line)' }} onClick={() => setSelected(e.id)}>
              <span className="ep-cover"><img src={api.coverUrl(e.cover_seed, e.title, e.format)} alt="" /></span>
              <span style={{ minWidth: 0 }}>
                <span className="episode-title clamp-2" style={{ display: 'block' }}>{e.title}</span>
                <span className="episode-sub">
                  {e.project_name} · {FORMAT_LABELS[e.format] || e.format}
                  {e.status === 'review' && <Badge tone="warn">нужно подтверждение</Badge>}
                </span>
                <Progress value={e.progress} striped={e.status === 'generating'} style={{ marginTop: 7, maxWidth: 320 }} />
              </span>
              <span className="hide-md"><Badge tone={STATUS_META[e.status]?.tone || 'muted'} dot>{STATUS_META[e.status]?.label || e.status}</Badge></span>
              <span className="hide-md" style={{ fontSize: 10.5, color: 'var(--muted)' }}>{e.stageLabel} · {e.progress}%</span>
              <span className="hide-md" style={{ fontSize: 10.5, color: 'var(--muted)' }}>{relative(e.updated_at)}</span>
            </button>
          ))}
          {active.length === 0 && (
            <Empty icon="film" title="Конвейер свободен" text="Все ролики опубликованы или ждут своего слота. Можно запустить новую партию."
              action={<button className="btn btn-primary btn-sm" onClick={onLaunch}><Icon name="zap" size={13} />Запустить</button>} />
          )}
        </div>
      </div>

      {/* ── Top reels + feed ─────────────────────────────────────────────── */}
      <div className="page-grid grid-2-1">
        <div className="card pad-lg">
          <div className="card-head">
            <div>
              <h2>Лучшие ролики</h2>
              <p>Больше всего просмотров за период</p>
            </div>
            <a className="link-btn" href="#/analytics">Аналитика <Icon name="chevronRight" size={12} /></a>
          </div>
          <div className="reels-strip">
            {(analytics?.top || []).slice(0, 6).map((p, i) => (
              <button key={p.id} className="reel-card" style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer' }}
                onClick={() => p.episode_id && setSelected(p.episode_id)}>
                <div className="cover">
                  <img src={api.coverUrl(p.cover_seed, p.title, p.format, `&i=${i}`)} alt="" />
                  <span className="cover-badge"><PlatformIcon platform={p.platform} size={9} />{platformLabel(p.platform)}</span>
                  <span className="cover-metric">
                    <span><Icon name="eye" size={10} />{fmt(p.views)}</span>
                    <span>{p.ctr}%</span>
                  </span>
                </div>
                <div className="reel-meta">
                  <span className="reel-title clamp-2">{p.title}</span>
                  <span className="reel-sub">{FORMAT_LABELS[p.format] || p.format} · {p.project_name}</span>
                </div>
              </button>
            ))}
            {!analytics?.top?.length && <div className="skeleton" style={{ height: 200, gridColumn: 'span 3' }} />}
          </div>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-title">
              <h3>События</h3>
              <a className="link-btn" href="#/logs">журнал <Icon name="chevronRight" size={12} /></a>
            </div>
            <div className="feed">
              {(data.logs || []).slice(0, 9).map((l) => (
                <div className="feed-item" key={l.id}>
                  <span className={`feed-icon ${l.level}`}>
                    <Icon name={l.level === 'error' ? 'alert' : l.level === 'warn' ? 'info' : l.level === 'success' ? 'check' : 'zap'} size={12} />
                  </span>
                  <div className="feed-body">
                    <div className="feed-text">{l.message}</div>
                    <div className="feed-time">{relative(l.ts)} · {l.actor}</div>
                  </div>
                </div>
              ))}
              {!data.logs?.length && <p className="muted" style={{ fontSize: 12 }}>Пока тихо.</p>}
            </div>
          </div>

          <div className="card">
            <div className="card-title"><h3>Нагрузка аккаунтов</h3><span className="sub">{quotaUsed}/{quotaTotal} слотов</span></div>
            <div className="col" style={{ gap: 11 }}>
              {(data.accounts || []).slice(0, 4).map((a) => {
                const pct = a.cap ? Math.round((a.used_today / a.cap) * 100) : 0;
                const st = ACCOUNT_STATUS[a.status] || ACCOUNT_STATUS.healthy;
                return (
                  <div key={a.id}>
                    <div className="row-between" style={{ marginBottom: 5 }}>
                      <span className="row" style={{ gap: 6, fontSize: 12, fontWeight: 600, minWidth: 0 }}>
                        <PlatformIcon platform={a.platform} size={13} />
                        <span className="truncate">@{a.handle}</span>
                      </span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <div className={`quota ${pct >= 100 ? 'full' : pct >= 70 ? 'high' : ''}`}>
                      <div className="quota-bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
                      <span style={{ fontSize: 10.5, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{a.used_today}/{a.cap}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <a className="btn btn-ghost btn-sm btn-block" href="#/accounts" style={{ marginTop: 14 }}>Управлять аккаунтами</a>
          </div>
        </div>
      </div>

      <EpisodeDrawer episodeId={selected} onClose={() => setSelected(null)} onChange={refreshLight} />
    </div>
  );
}
