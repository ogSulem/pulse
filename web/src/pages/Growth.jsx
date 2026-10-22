import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon, { PlatformIcon } from '../components/Icons.jsx';
import { Badge, Field, Modal, Progress, Segmented, Empty, ScoreRing, useToast } from '../components/ui.jsx';
import { fmt, money, pct, platformLabel } from '../lib/format.js';

const STATUS = {
  healthy: { label: 'активен', tone: 'success' },
  warmup: { label: 'прогрев', tone: 'warn' },
  cooldown: { label: 'охлаждение', tone: 'warn' },
  blocked: { label: 'блокировка', tone: 'danger' },
};

const TREND_STATUS = {
  hot: { label: 'снимай сейчас', tone: 'success' },
  rising: { label: 'тестируй', tone: 'accent' },
  steady: { label: 'в ротации', tone: 'muted' },
  cooling: { label: 'остывает', tone: 'danger' },
};

const VERDICT = {
  go: { label: 'можно публиковать', tone: 'success' },
  fix: { label: 'лучше доработать', tone: 'warn' },
  block: { label: 'публикация заблокирована', tone: 'danger' },
};

const TONE_COLOR = { success: 'var(--green)', warn: 'var(--amber)', muted: 'var(--muted)', accent: 'var(--violet-2)', danger: 'var(--red)' };

export default function Growth() {
  const { data, refresh } = useApp();
  const toast = useToast();
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState('tiktok');
  const [topic, setTopic] = useState('');
  const [hooks, setHooks] = useState(null);
  const [hookBusy, setHookBusy] = useState(false);
  const [plan, setPlan] = useState(null);
  const [gate, setGate] = useState(null);
  const [gateBusy, setGateBusy] = useState(false);
  const [episodeId, setEpisodeId] = useState('');

  const load = async () => {
    try {
      setOverview(await api.growthOverview({ days: 30 }));
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не удалось загрузить рост', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!overview || topic) return;
    const p = data.projects?.[0];
    setTopic(p?.niche || p?.name || 'короткие видео');
    setPlatform(p?.format?.includes('shorts') ? 'youtube' : 'tiktok');
  }, [overview]);

  const loadHooks = async () => {
    setHookBusy(true);
    try {
      const res = await api.growthHooks({ topic: topic || 'короткие видео', platform });
      setHooks(res);
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не получилось собрать хуки', text: err.message });
    } finally { setHookBusy(false); }
  };

  useEffect(() => { if (topic) loadHooks(); }, [platform]);

  const openPlan = async (account) => {
    try {
      setPlan({ loading: true, account });
      setPlan(await api.growthPlaybook(account.id));
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не удалось открыть план', text: err.message });
      setPlan(null);
    }
  };

  const runGate = async (id) => {
    if (!id) return;
    setGateBusy(true);
    try {
      setGate(await api.episodeGate(id));
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка проверки', text: err.message });
    } finally { setGateBusy(false); }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.push({ tone: 'success', title: 'Скопировано', text: 'Хук готов к вставке в сценарий' });
    } catch {
      toast.push({ tone: 'info', title: 'Скопируйте вручную', text });
    }
  };

  const portfolio = overview?.portfolio;
  const totals = portfolio?.totals || {};
  const accounts = portfolio?.accounts || [];
  const trends = overview?.trends?.trends || [];
  const monetization = overview?.monetization;
  const episodes = data.episodes || [];
  const attention = accounts.filter((a) => a.health < 70);

  const platformCards = useMemo(() => portfolio?.platforms || [], [portfolio]);

  return (
    <div className="page">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="card pad-lg" style={{ background: 'linear-gradient(125deg, rgba(124,58,237,.22), rgba(12,8,18,.25) 58%)', borderColor: 'rgba(167,139,250,.24)' }}>
        <div className="row-between wrap" style={{ gap: 18 }}>
          <div style={{ flex: '1 1 380px', minWidth: 260 }}>
            <Badge tone="accent" dot>портфель и охваты</Badge>
            <h2 style={{ fontSize: 22, fontWeight: 790, letterSpacing: '-0.035em', marginTop: 10 }}>
              Аккаунты, которые растут
            </h2>
            <p className="dim" style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.6, maxWidth: 570 }}>
              Reels, TikTok и Shorts в одном портфеле: у каждого аккаунта свой темп, окно публикаций и план прогрева.
              Pulse считает удержание по площадкам, подсказывает хуки под алгоритм и показывает, сколько осталось до монетизации.
            </p>
            <div className="row wrap" style={{ gap: 8, marginTop: 14 }}>
              <a className="btn btn-primary" href="#/accounts"><Icon name="at" size={15} />Аккаунты и квоты</a>
              <a className="btn btn-ghost" href="#/ads"><Icon name="megaphone" size={14} />Реклама</a>
              <a className="btn btn-ghost" href="#/money"><Icon name="target" size={14} />Деньги</a>
            </div>
          </div>
          <div className="row wrap" style={{ gap: 26 }}>
            <div className="hr-stat"><span className="v">{fmt(totals.followers || 0)}</span><span className="l">подписчиков</span></div>
            <div className="hr-stat"><span className="v">{fmt(totals.views30 || 0)}</span><span className="l">охват за 30 дней</span></div>
            <div className="hr-stat"><span className="v">{totals.avgRetention || 0}%</span><span className="l">среднее удержание</span></div>
          </div>
        </div>
      </div>

      {loading && <div className="skeleton" style={{ height: 120 }} />}

      {/* ── KPI ──────────────────────────────────────────────────────────── */}
      <div className="page-grid grid-4">
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Аккаунтов в работе</span><span className="kpi-icon"><Icon name="at" size={14} /></span></div>
          <div className="kpi-value">{totals.active || 0} <small>из {totals.accounts || 0}</small></div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{attention.length ? `${attention.length} требуют внимания` : 'все в норме'}</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Охват за 7 дней</span><span className="kpi-icon"><Icon name="eye" size={14} /></span></div>
          <div className="kpi-value">{fmt(totals.views7 || 0)}</div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{totals.posts7 || 0} публикаций</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Ёмкость на сегодня</span><span className="kpi-icon"><Icon name="calendar" size={14} /></span></div>
          <div className="kpi-value">{totals.capacityPerDay || 0} <small>постов</small></div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>план {totals.demandPerDay || 0}/день · запас {totals.headroom || 0}</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">До монетизации</span><span className="kpi-icon"><Icon name="coins" size={14} /></span></div>
          <div className="kpi-value" style={{ fontSize: 22 }}>
            {monetization?.programs?.find((p) => p.id === 'youtube-ypp-1')?.etaText || '—'}
          </div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>YPP ранний доступ</span></div>
        </div>
      </div>

      {/* ── Портфель по площадкам ────────────────────────────────────────── */}
      <div className="card pad-lg">
        <div className="card-head">
          <div>
            <h2>Портфель аккаунтов</h2>
            <p>Подписчики, охват и удержание — по каждому аккаунту</p>
          </div>
          <Badge tone="muted">{accounts.length}</Badge>
        </div>

        {!loading && !accounts.length && (
          <Empty icon="at" title="Аккаунтов пока нет" text="Добавьте первый аккаунт — Pulse построит для него план прогрева и темп."
            action={<a className="btn btn-primary btn-sm" href="#/accounts"><Icon name="plus" size={14} />Добавить</a>} />
        )}

        <div className="page-grid grid-2" style={{ marginBottom: 14 }}>
          {platformCards.map((pl) => (
            <div className="card" key={pl.platform} style={{ background: 'rgba(255,255,255,.02)' }}>
              <div className="row-between" style={{ marginBottom: 10 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span style={{ color: 'var(--violet-2)' }}><PlatformIcon platform={pl.platform} size={16} /></span>
                  <b style={{ fontSize: 13 }}>{pl.label}</b>
                  <Badge tone="muted">{pl.accounts}</Badge>
                </div>
                <Badge tone={pl.retention >= pl.retentionTarget ? 'success' : 'warn'}>
                  удержание {pl.retention || 0}% / норма {pl.retentionTarget}%
                </Badge>
              </div>
              <div className="row wrap" style={{ gap: 20 }}>
                <div><div style={{ fontSize: 15, fontWeight: 740 }}>{fmt(pl.followers)}</div><div style={{ fontSize: 10, color: 'var(--muted)' }}>подписчиков</div></div>
                <div><div style={{ fontSize: 15, fontWeight: 740 }}>{fmt(pl.views30)}</div><div style={{ fontSize: 10, color: 'var(--muted)' }}>охват 30 дн.</div></div>
                <div><div style={{ fontSize: 15, fontWeight: 740 }}>{pl.idealSec[0]}–{pl.idealSec[1]} с</div><div style={{ fontSize: 10, color: 'var(--muted)' }}>оптимальная длина</div></div>
                <div><div style={{ fontSize: 15, fontWeight: 740 }}>{pl.capacity}</div><div style={{ fontSize: 10, color: 'var(--muted)' }}>слотов сегодня</div></div>
              </div>
            </div>
          ))}
        </div>

        <div className="col" style={{ gap: 8 }}>
          {accounts.map((a) => {
            const st = STATUS[a.status] || STATUS.healthy;
            return (
              <div key={a.id} className="card flat" style={{ padding: 13 }}>
                <div className="row-between wrap" style={{ gap: 12 }}>
                  <div className="row" style={{ gap: 11, minWidth: 0, flex: '1 1 280px' }}>
                    <span style={{ width: 38, height: 38, borderRadius: 11, background: 'rgba(139,92,246,.14)', display: 'grid', placeItems: 'center', border: '1px solid rgba(167,139,250,.22)', flex: 'none' }}>
                      <PlatformIcon platform={a.platform} size={16} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <b style={{ fontSize: 13 }}>@{a.handle}</b>
                        <Badge tone={st.tone} dot={a.status === 'healthy'}>{st.label}</Badge>
                        {a.connected ? <Badge tone="info">API</Badge> : <Badge tone="muted">без токена</Badge>}
                        {a.projectName ? <Badge tone="accent">{a.projectName}</Badge> : <Badge tone="muted">универсальный</Badge>}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>
                        {a.platformLabel} · {a.window} · интервал {a.minGapMin} мин · здоровье {a.health}/100
                      </div>
                      <div style={{ fontSize: 11.5, color: TONE_COLOR[a.nextAction.tone] || 'var(--muted)', marginTop: 5 }}>
                        <Icon name={a.nextAction.tone === 'success' ? 'check' : 'arrowUpRight'} size={11} style={{ verticalAlign: -1 }} /> {a.nextAction.text}
                      </div>
                    </div>
                  </div>

                  <div className="row wrap" style={{ gap: 18 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{fmt(a.followers)}</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>подписчиков</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{fmt(a.views30)}</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>охват 30 дн.</div>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: 86 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }} className={a.retention >= a.retentionTarget ? 'tone-green' : 'tone-amber'}>
                        {a.retention || 0}%
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>удержание / {a.retentionTarget}%</div>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: 70 }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{a.usedToday}/{a.dailyLimit}</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>квота</div>
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={() => openPlan(a)}>
                      <Icon name="growth" size={13} />План
                    </button>
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <Progress value={Math.min(100, Math.round(((a.retention || 0) / Math.max(1, a.retentionTarget)) * 100))} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Радар трендов ─────────────────────────────────────────────────── */}
      <div className="page-grid grid-2">
        <div className="card pad-lg">
          <div className="card-head">
            <div>
              <h2>Что снимать сейчас</h2>
              <p>Свои данные за 30 дней + правила алгоритмов 2026</p>
            </div>
            <Icon name="flame" size={16} style={{ color: 'var(--violet-2)' }} />
          </div>
          <div className="col" style={{ gap: 8 }}>
            {trends.slice(0, 6).map((t) => {
              const st = TREND_STATUS[t.status] || TREND_STATUS.steady;
              return (
                <div key={t.id} style={{ padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 10 }}>
                  <div className="row-between" style={{ gap: 8 }}>
                    <div className="row" style={{ gap: 7, minWidth: 0 }}>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      <b style={{ fontSize: 12.5 }} className="truncate">{t.label}</b>
                    </div>
                    {t.evidence?.n > 0 && (
                      <span style={{ fontSize: 10.5, color: t.evidence.lift >= 1 ? 'var(--green)' : 'var(--muted)', flex: 'none' }}>
                        ×{t.evidence.lift} на {t.evidence.n} роликах
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.5 }}>{t.why}</div>
                  <div className="row wrap" style={{ gap: 5, marginTop: 6 }}>
                    {t.platforms.map((p) => (
                      <span key={p} className="badge muted" style={{ fontSize: 9.5 }}>{platformLabel(p)}</span>
                    ))}
                    <button className="link-btn" style={{ fontSize: 10.5, marginLeft: 'auto' }}
                      onClick={() => copy(t.hook.replace('{topic}', topic || 'тема'))}>
                      взять хук <Icon name="copy" size={10} />
                    </button>
                  </div>
                </div>
              );
            })}
            {!trends.length && <div className="empty-inline">Пока нет данных — опубликуйте несколько роликов</div>}
          </div>

          {(overview?.trends?.own?.formats || []).length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="card-sub" style={{ marginBottom: 6 }}>Ваши форматы по охвату</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {overview.trends.own.formats.map((f) => (
                  <Badge key={f.key} tone={f.lift >= 1.1 ? 'success' : f.lift < 0.9 ? 'danger' : 'muted'}>
                    {f.key} ×{f.lift} · {f.n}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Лаборатория хуков ──────────────────────────────────────────── */}
        <div className="card pad-lg">
          <div className="card-head">
            <div>
              <h2>Лаборатория хуков</h2>
              <p>Первые {platformLabel(platform) === 'YouTube Shorts' ? '2' : '1.3'} секунды решают охват</p>
            </div>
            <Icon name="zap" size={16} style={{ color: 'var(--violet-2)' }} />
          </div>

          <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
            <Segmented
              size="sm"
              options={[{ value: 'tiktok', label: 'TikTok' }, { value: 'reels', label: 'Reels' }, { value: 'youtube', label: 'Shorts' }]}
              value={platform}
              onChange={(v) => { setPlatform(v); }}
            />
          </div>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadHooks()}
              placeholder="Тема ролика: привычки, тренировки, аналитика…" />
            <button className="btn btn-primary" onClick={loadHooks} disabled={hookBusy}>
              <Icon name="sparkles" size={14} />{hookBusy ? '…' : 'Собрать'}
            </button>
          </div>

          {hooks?.best && (
            <div style={{ padding: 12, borderRadius: 12, background: 'rgba(139,92,246,.1)', border: '1px solid rgba(167,139,250,.26)', marginBottom: 10 }}>
              <div className="row-between" style={{ marginBottom: 6 }}>
                <Badge tone="success" dot>лучший хук · {hooks.best.score}/100</Badge>
                <button className="link-btn" style={{ fontSize: 10.5 }} onClick={() => copy(hooks.best.text)}>
                  <Icon name="copy" size={11} />копировать
                </button>
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.4 }}>«{hooks.best.text}»</div>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
                {hooks.best.type} · {hooks.best.readableSec} с на озвучку · {hooks.best.fitsWindow ? 'успевает до свайпа' : 'длинновато для первой секунды'}
              </div>
            </div>
          )}

          <div className="col" style={{ gap: 6 }}>
            {(hooks?.hooks || []).slice(0, 5).map((h, i) => (
              <div key={h.id} className="row-between" style={{ gap: 10, padding: '7px 9px', border: '1px solid var(--line)', borderRadius: 9 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, lineHeight: 1.4 }}>{h.text}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{h.type} · {h.why}</div>
                </div>
                <div className="row" style={{ gap: 6, flex: 'none' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: h.score >= 60 ? 'var(--green)' : h.score >= 45 ? 'var(--amber)' : 'var(--muted)' }}>{h.score}</span>
                  <button className="link-btn" style={{ fontSize: 10 }} onClick={() => copy(h.text)}><Icon name="copy" size={10} /></button>
                </div>
              </div>
            ))}
            {!hooks && !hookBusy && <div className="empty-inline">Введите тему — соберём 7 вариантов и оценим каждый</div>}
          </div>

          {(hooks?.guidance || []).length > 0 && (
            <div className="col" style={{ gap: 5, marginTop: 10 }}>
              {hooks.guidance.map((g) => (
                <div key={g} className="row" style={{ gap: 6, fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  <Icon name="info" size={11} style={{ marginTop: 2, flex: 'none' }} />{g}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Проверка ролика ──────────────────────────────────────────────── */}
      <div className="card pad-lg">
        <div className="card-head">
          <div>
            <h2>Проверка перед публикацией</h2>
            <p>Правила, удержание, вирусный скор, квота и маркировка — в одном вердикте</p>
          </div>
          <Badge tone="muted">гейт</Badge>
        </div>

        <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
          <select className="select" style={{ maxWidth: 420 }} value={episodeId}
            onChange={(e) => { setEpisodeId(e.target.value); runGate(e.target.value); }}>
            <option value="">Выберите ролик…</option>
            {episodes.slice(0, 40).map((e) => (
              <option key={e.id} value={e.id}>{e.title}</option>
            ))}
          </select>
          <button className="btn btn-ghost" onClick={() => runGate(episodeId)} disabled={!episodeId || gateBusy}>
            <Icon name="shield" size={14} />{gateBusy ? 'Проверяем…' : 'Проверить'}
          </button>
        </div>

        {!gate && <div className="empty-inline">Вердикт покажет, что мешает охвату, и что исправить первым</div>}

        {gate && (
          <div className="col" style={{ gap: 12 }}>
            <div className="row wrap" style={{ gap: 16, alignItems: 'center' }}>
              <ScoreRing value={gate.score} size={62} />
              <div style={{ flex: '1 1 240px' }}>
                <Badge tone={(VERDICT[gate.verdict] || VERDICT.fix).tone} dot>{(VERDICT[gate.verdict] || VERDICT.fix).label}</Badge>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.55 }}>
                  готовность {gate.score}/100 ·
                  {gate.platformLabel} · вирусный скор {gate.viral.score} · удержание ≈{gate.retention.predictedCompletion}% (цель {gate.retention.targetCompletion}%) · прогноз {fmt(gate.forecast.expectedViews)} просмотров · квота {gate.quota.used}/{gate.quota.cap}
                </div>
              </div>
            </div>

            {[...gate.blockers, ...gate.warnings].slice(0, 5).map((b) => (
              <div key={b.id} className="row" style={{ gap: 8, padding: '8px 10px', borderRadius: 9, border: `1px solid ${gate.blockers.includes(b) ? 'rgba(244,63,94,.3)' : 'var(--line)'}`, background: gate.blockers.includes(b) ? 'rgba(244,63,94,.06)' : 'transparent' }}>
                <Icon name={gate.blockers.includes(b) ? 'alert' : 'info'} size={13} style={{ color: gate.blockers.includes(b) ? 'var(--red)' : 'var(--muted)', marginTop: 1 }} />
                <div>
                  <div style={{ fontSize: 11.5 }}>{b.text}</div>
                  {b.fix && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>→ {b.fix}</div>}
                </div>
              </div>
            ))}

            <div className="page-grid grid-2">
              {gate.retention.checks.map((c) => (
                <div key={c.id} className="row" style={{ gap: 7, fontSize: 11, color: c.ok ? 'var(--muted)' : 'var(--text-2)' }}>
                  <Icon name={c.ok ? 'check' : 'alert'} size={12} style={{ color: c.ok ? 'var(--green)' : 'var(--amber)', marginTop: 2, flex: 'none' }} />
                  <span>{c.text}{!c.ok && c.fix ? ` — ${c.fix}` : ''}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Монетизация ──────────────────────────────────────────────────── */}
      <div className="card pad-lg">
        <div className="card-head">
          <div>
            <h2>Путь к деньгам</h2>
            <p>Пороги площадок, сроки по текущей скорости и то, что уже приносит доход</p>
          </div>
          {monetization && <Badge tone="success">{money(monetization.income.brandMonthly + monetization.income.productMonthly)}/мес</Badge>}
        </div>

        <div className="page-grid grid-2">
          {(monetization?.programs || []).map((p) => (
            <div key={p.id} className="card" style={{ background: 'rgba(255,255,255,.02)' }}>
              <div className="row-between" style={{ alignItems: 'flex-start', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6, marginBottom: 5, flexWrap: 'wrap' }}>
                    {p.platform && <Badge tone="accent">{platformLabel(p.platform)}</Badge>}
                    {p.ready ? <Badge tone="success" dot>пороги выполнены</Badge> : <Badge tone="muted">{p.progress}%</Badge>}
                    {p.regionLimited && <Badge tone="danger">не для РФ</Badge>}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>{p.reward}</div>
                </div>
                <div style={{ textAlign: 'right', flex: 'none' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>{p.etaText}</div>
                  <div style={{ fontSize: 9.5, color: 'var(--muted)' }}>до порога</div>
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <Progress value={p.progress} />
              </div>

              <div className="col" style={{ gap: 4, marginTop: 9 }}>
                {p.requirements.map((r) => (
                  <div key={r.label} className="row-between" style={{ fontSize: 10.5 }}>
                    <span style={{ color: r.done ? 'var(--green)' : 'var(--muted)' }}>
                      {r.done ? '✓ ' : ''}{r.label}
                    </span>
                    <span style={{ color: r.done ? 'var(--green)' : 'var(--text-2)' }}>
                      {fmt(r.current)} / {fmt(r.target)}
                    </span>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 8, lineHeight: 1.55 }}>{p.note}</div>
            </div>
          ))}
        </div>

        {monetization && (
          <div className="row wrap" style={{ gap: 20, marginTop: 12 }}>
            <div className="hr-stat"><span className="v">{money(monetization.income.brandMonthly)}</span><span className="l">бренды (30 дн.)</span></div>
            <div className="hr-stat"><span className="v">{money(monetization.income.productMonthly)}</span><span className="l">прибыль с продукта</span></div>
            <div className="hr-stat"><span className="v">{fmt(monetization.totals.views7PerDay)}</span><span className="l">просмотров в день</span></div>
            <div className="hr-stat"><span className="v">{fmt(monetization.totals.followers)}</span><span className="l">подписчиков всего</span></div>
          </div>
        )}
        <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 10, lineHeight: 1.6 }}>
          {monetization?.income?.note}
        </p>
      </div>

      {/* ── Модалка плана аккаунта ───────────────────────────────────────── */}
      <Modal
        open={Boolean(plan)}
        onClose={() => setPlan(null)}
        title={plan?.account ? `План для @${plan.account.handle}` : 'План аккаунта'}
        subtitle={plan?.account ? `${plan.account.platformLabel}${plan.account.projectName ? ` · ${plan.account.projectName}` : ' · универсальный'} · фаза «${plan.phaseLabel}»` : ''}
        wide
      >
        {plan?.loading && <div className="skeleton" style={{ height: 120 }} />}
        {plan && !plan.loading && (
          <div className="col" style={{ gap: 14 }}>
            <div className="row wrap" style={{ gap: 18 }}>
              <div className="hr-stat"><span className="v">{plan.cadence.daily}</span><span className="l">постов в день</span></div>
              <div className="hr-stat"><span className="v">{plan.cadence.weekly}</span><span className="l">в неделю</span></div>
              <div className="hr-stat"><span className="v">{plan.stats.posts30}</span><span className="l">за 30 дней</span></div>
              <div className="hr-stat"><span className="v">{plan.benchmarks.hookWindowSec} с</span><span className="l">окно хука</span></div>
            </div>

            {plan.issues.length > 0 && (
              <div className="col" style={{ gap: 5 }}>
                {plan.issues.map((i) => (
                  <div key={i.text} className="row" style={{ gap: 7, fontSize: 11.5, color: TONE_COLOR[i.tone] || 'var(--text-2)' }}>
                    <Icon name="alert" size={12} style={{ marginTop: 2, flex: 'none' }} />{i.text}
                  </div>
                ))}
              </div>
            )}

            <div>
              <div className="card-sub" style={{ marginBottom: 6 }}>Лестница темпа</div>
              <div className="col" style={{ gap: 5 }}>
                {plan.ramp.map((r) => (
                  <div key={r.day} className="row" style={{ gap: 9, fontSize: 11.5 }}>
                    <Badge tone="muted">{r.day} дн.</Badge>
                    <b style={{ minWidth: 42 }}>{r.posts} пост.</b>
                    <span style={{ color: 'var(--muted)', lineHeight: 1.5 }}>{r.why}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="card-sub" style={{ marginBottom: 6 }}>Правила ведения</div>
              <div className="col" style={{ gap: 5 }}>
                {plan.rules.map((r) => (
                  <div key={r} className="row" style={{ gap: 7, fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
                    <Icon name="check" size={12} style={{ color: 'var(--green)', marginTop: 2, flex: 'none' }} />{r}
                  </div>
                ))}
              </div>
            </div>

            <div className="notice">
              <Icon name="info" size={14} />
              <span style={{ fontSize: 11, lineHeight: 1.55 }}>
                Ориентиры {plan.account.platformLabel}: длина {plan.benchmarks.idealSec[0]}–{plan.benchmarks.idealSec[1]} с,
                досмотр {Math.round(plan.benchmarks.completionTarget * 100)}%, сигналы — {plan.benchmarks.signals.join(', ')}.
              </span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
