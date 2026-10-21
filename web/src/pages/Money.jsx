import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon, { PlatformIcon } from '../components/Icons.jsx';
import { Badge, Segmented, AreaChart, Empty, Kpi, ScoreRing } from '../components/ui.jsx';
import { fmt, full, money, moneyShort, pct, relative } from '../lib/format.js';

const RANGES = [
  { value: 7, label: '7 дней' },
  { value: 30, label: '30 дней' },
  { value: 90, label: '90 дней' },
];

function Flow({ label, value, hint, icon, tone }) {
  return (
    <div className="flow-step">
      <div className={`flow-icon ${tone}`}><Icon name={icon} size={16} /></div>
      <div style={{ minWidth: 0 }}>
        <div className="flow-value">{value}</div>
        <div className="flow-label">{label}</div>
        {hint && <div className="flow-hint">{hint}</div>}
      </div>
    </div>
  );
}

export default function Money() {
  const { data } = useApp();
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState('all');
  const [money_, setMoney] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.money({ days, projectId }).then((res) => { if (alive) setMoney(res); }).catch(() => {}).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days, projectId, data.pipeline?.published]);

  const t = money_?.totals;
  const currency = money_?.currency || '₽';
  const series = money_?.series || [];
  const projects = data.projects || [];

  return (
    <div className="page">
      {/* ── Заголовок и период ─────────────────────────────────────────── */}
      <div className="row-between wrap" style={{ gap: 14, alignItems: 'flex-end' }}>
        <div>
          <div className="eyebrow">юнит-экономика</div>
          <h1 className="page-h1">Деньги</h1>
          <p className="page-sub">
            Доход из двух каналов — реклама площадок и продажи по ссылкам. Расход — себестоимость роликов.
            Ничего не «нарисовано»: каждая цифра складывается из записей в базе.
          </p>
        </div>
        <div className="row wrap" style={{ gap: 10 }}>
          <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="all">Все проекты</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <Segmented value={days} onChange={setDays} options={RANGES} />
        </div>
      </div>

      {/* ── Hero: прибыль ───────────────────────────────────────────────── */}
      <div className="money-hero">
        <div className="money-hero-main">
          <div className="eyebrow" style={{ opacity: 0.75 }}>чистая прибыль за {days} дней</div>
          <div className="money-big">{t ? money(t.profit, currency) : '—'}</div>
          <div className="money-sub">
            {t ? (
              <>
                <span className="tone-green">+{money(t.revenue, currency)}</span> доход
                <span className="dot-sep" />
                <span className="tone-rose">−{money(t.cost, currency)}</span> расход
                <span className="dot-sep" />
                <span>ROI {t.roi == null ? '—' : `${full(t.roi)}%`}</span>
              </>
            ) : 'считаем…'}
          </div>
          <div className="money-hero-bars">
            <div className="money-bar">
              <div className="money-bar-label"><span>Реклама площадок</span><b>{t ? money(t.revenueAds, currency) : '—'}</b></div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${t && t.revenue ? Math.round((t.revenueAds / t.revenue) * 100) : 0}%`, background: 'linear-gradient(90deg,#a78bfa,#c4b5fd)' }} /></div>
            </div>
            <div className="money-bar">
              <div className="money-bar-label"><span>Продажи по ссылкам</span><b>{t ? money(t.revenueConv, currency) : '—'}</b></div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${t && t.revenue ? Math.round((t.revenueConv / t.revenue) * 100) : 0}%`, background: 'linear-gradient(90deg,#34d399,#6ee7b7)' }} /></div>
            </div>
            <div className="money-bar">
              <div className="money-bar-label"><span>Себестоимость производства</span><b>{t ? money(t.cost, currency) : '—'}</b></div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${t && t.revenue ? Math.min(100, Math.round((t.cost / t.revenue) * 100)) : 0}%`, background: 'linear-gradient(90deg,#fb7185,#fda4af)' }} /></div>
            </div>
          </div>
        </div>
        <div className="money-hero-side">
          <div className="profit-ring">
            <ScoreRing value={t?.marginPct || 0} size={112} label="маржа" />
            <div className="profit-ring-text">
              <div>{t ? pct(t.marginPct, 0) : '—'}</div>
              <span>доля прибыли в доходе</span>
            </div>
          </div>
          <div className="mini-kv">
            <div><span>Доход на ролик</span><b>{t ? money(t.profitPerVideo, currency) : '—'}</b></div>
            <div><span>Себестоимость ролика</span><b>{t ? money(t.costPerVideo, currency) : '—'}</b></div>
            <div><span>RPM факт</span><b>{t ? money(t.rpmAvg, currency) : '—'}</b></div>
            <div><span>Окупаемость</span><b>{t?.roi == null ? '—' : `${full(t.roi)}%`}</b></div>
          </div>
        </div>
      </div>

      {/* ── KPI ─────────────────────────────────────────────────────────── */}
      <div className="grid-4">
        <Kpi label="Просмотры" value={t ? fmt(t.views) : '—'} sub="за период, по всем площадкам" icon="eye" />
        <Kpi label="Клики" value={t ? fmt(t.clicks) : '—'} sub={`CTR ${t ? pct(t.ctr, 2) : '—'}`} icon="target" />
        <Kpi label="Покупки" value={t ? full(t.conversions) : '—'} sub={`CR ${t ? pct(t.cr, 2) : '—'}`} icon="package" />
        <Kpi label="Доход с клика" value={t ? money(t.epc, currency, 2) : '—'} sub="средний EPC" icon="flame" />
      </div>

      <div className="grid-2-1">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Доход по дням</div>
              <div className="card-sub">реклама + продажи, в {currency}</div>
            </div>
            <div className="legend">
              <span><i style={{ background: '#a78bfa' }} />реклама</span>
              <span><i style={{ background: '#34d399' }} />продажи</span>
            </div>
          </div>
          {series.length > 1
            ? <AreaChart data={series} height={240} valueFormat={(v) => moneyShort(v, currency)}
                series={[{ key: 'ads', color: '#a78bfa', label: 'Реклама' }, { key: 'convRevenue', color: '#34d399', label: 'Продажи' }]} />
            : <Empty icon="chart" title="Пока нет данных" text="Как только выйдут первые ролики — здесь появится динамика" />}
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">Воронка</div></div>
          <div className="flow">
            <Flow icon="eye" tone="violet" value={t ? fmt(t.views) : '—'} label="Просмотры" hint="органика Reels / TikTok" />
            <div className="flow-link" />
            <Flow icon="target" tone="cyan" value={t ? fmt(t.clicks) : '—'} label="Клики" hint={t ? `CTR ${pct(t.ctr, 2)}` : ''} />
            <div className="flow-link" />
            <Flow icon="package" tone="green" value={t ? full(t.conversions) : '—'} label="Покупки" hint={t ? `CR ${pct(t.cr, 2)} · EPC ${money(t.epc, currency, 2)}` : ''} />
          </div>
          <div className="hr" />
          <div className="mini-kv tight">
            <div><span>Цена продукта</span><b>{money(money_?.assumptions?.price, currency)}</b></div>
            <div><span>Маржа с продажи</span><b>{money((money_?.assumptions?.price || 0) * (money_?.assumptions?.margin || 0), currency)}</b></div>
            <div><span>Конверсия клик → покупка</span><b>{pct(money_?.assumptions?.convRate, 1)}</b></div>
          </div>
        </div>
      </div>

      {/* ── Разрезы ─────────────────────────────────────────────────────── */}
      <div className="grid-2">
        <div className="card">
          <div className="card-head"><div className="card-title">По площадкам</div><Badge tone="muted">24 ч окно</Badge></div>
          <div className="money-table">
            <div className="money-row head">
              <span>Площадка</span><span>Просмотры</span><span>Доход</span><span>Расход</span><span>Прибыль</span><span>ROI</span>
            </div>
            {(money_?.byPlatform || []).map((p) => (
              <div className="money-row" key={p.id}>
                <span className="row" style={{ gap: 8 }}><PlatformIcon platform={p.id} size={16} />{p.name}</span>
                <span>{fmt(p.views)}</span>
                <span>{money(p.revenue, currency)}</span>
                <span className="dim">{money(p.cost, currency)}</span>
                <span className={p.profit >= 0 ? 'tone-green' : 'tone-rose'}>{money(p.profit, currency)}</span>
                <span>{p.roi == null ? '—' : `${full(p.roi)}%`}</span>
              </div>
            ))}
            {!(money_?.byPlatform || []).length && <div className="empty-inline">Нет публикаций за период</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">По проектам</div></div>
          <div className="money-table">
            <div className="money-row head">
              <span>Проект</span><span>Просмотры</span><span>Доход</span><span>Расход</span><span>Прибыль</span><span>ROI</span>
            </div>
            {(money_?.byProject || []).map((p) => (
              <div className="money-row" key={p.id}>
                <span className="truncate">{p.name}</span>
                <span>{fmt(p.views)}</span>
                <span>{money(p.revenue, currency)}</span>
                <span className="dim">{money(p.cost, currency)}</span>
                <span className={p.profit >= 0 ? 'tone-green' : 'tone-rose'}>{money(p.profit, currency)}</span>
                <span>{p.roi == null ? '—' : `${full(p.roi)}%`}</span>
              </div>
            ))}
            {!(money_?.byProject || []).length && <div className="empty-inline">Нет публикаций за период</div>}
          </div>
        </div>
      </div>

      {/* ── Лучшие и слабые ролики ──────────────────────────────────────── */}
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Ролики по прибыли</div>
            <div className="card-sub">слева — что окупается, справа — что тянет вниз</div>
          </div>
        </div>
        <div className="grid-2">
          <div>
            <div className="list-label tone-green"><Icon name="activity" size={14} /> Лучшие</div>
            {(money_?.top || []).slice(0, 5).map((p) => (
              <div className="money-item" key={p.id}>
                <div className="money-item-main">
                  <div className="money-item-title truncate">{p.title}</div>
                  <div className="money-item-meta">
                    <PlatformIcon platform={p.platform} size={13} />
                    {fmt(p.views)} просмотров · CTR {pct(p.ctr, 2)} · {p.privacy === 'public' ? 'публично' : 'приватно'}
                  </div>
                </div>
                <div className="money-item-value">
                  <b className="tone-green">{money(p.profit, currency)}</b>
                  <span>RPM {money(p.rpm, currency)}</span>
                </div>
              </div>
            ))}
            {!(money_?.top || []).length && <div className="empty-inline">Пока нет роликов с просмотрами</div>}
          </div>
          <div>
            <div className="list-label tone-rose"><Icon name="alert" size={14} /> Требуют внимания</div>
            {(money_?.worst || []).map((p) => (
              <div className="money-item" key={p.id}>
                <div className="money-item-main">
                  <div className="money-item-title truncate">{p.title}</div>
                  <div className="money-item-meta">{fmt(p.views)} просмотров · {p.conversions} покупок · {relative(p.publishedAt)}</div>
                </div>
                <div className="money-item-value">
                  <b className={p.profit >= 0 ? 'tone-green' : 'tone-rose'}>{money(p.profit, currency)}</b>
                  <span>окупаемость</span>
                </div>
              </div>
            ))}
            {!(money_?.worst || []).length && <div className="empty-inline">Всё в порядке</div>}
          </div>
        </div>
      </div>

      {/* ── Допущения ───────────────────────────────────────────────────── */}
      <div className="card assumptions">
        <div className="card-head">
          <div>
            <div className="card-title">Из чего считается доход</div>
            <div className="card-sub">все ставки — в настройках, меняются без перезапуска</div>
          </div>
          <a className="btn btn-ghost btn-sm" href="#/settings"><Icon name="settings" size={14} /> Настроить</a>
        </div>
        <div className="assumption-grid">
          <div><span>RPM Reels</span><b>{money(money_?.assumptions?.rpmReels, currency)}</b><em>за 1000 просмотров</em></div>
          <div><span>RPM TikTok</span><b>{money(money_?.assumptions?.rpmTiktok, currency)}</b><em>за 1000 просмотров</em></div>
          <div><span>Себестоимость ролика</span><b>{money(money_?.assumptions?.costPerVideo, currency)}</b><em>видео + TTS + LLM + рендер</em></div>
          <div><span>Конверсия</span><b>{pct(money_?.assumptions?.convRate, 1)}</b><em>клик → покупка</em></div>
        </div>
        <p className="assumption-note">{money_?.assumptions?.note}</p>
      </div>
    </div>
  );
}
