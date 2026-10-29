import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon from '../components/Icons.jsx';
import { Badge, Progress } from '../components/ui.jsx';
import { fmt, money, relative } from '../lib/format.js';
import { routeHash } from '../lib/nav.js';

// ─────────────────────────────────────────────────────────────────────────────
// «Сегодня» — единственный экран, который нужен каждый день.
//
// Раньше вместо него был дашборд из десяти блоков: конвейер, KPI, деньги,
// проверки, графики, лучшие ролики, события, нагрузка аккаунтов. Всё правда
// полезное, но человек утром задаёт один вопрос: «что мне сделать, чтобы это
// заработало». Поэтому здесь три ответа и ничего больше:
//   1. деньги за 30 дней одной цифрой (и честная пометка demo/live);
//   2. блокеры, которые прямо сейчас мешают деньгам, — первый крупно;
//   3. одно следующее действие.
// Всё остальное доступно, но в других разделах — по одному клику.
// ─────────────────────────────────────────────────────────────────────────────

const HOSTING_LABEL = { railway: 'Railway', render: 'Render', fly: 'Fly.io', koyeb: 'Koyeb', 'self-hosted': 'свой сервер' };

export default function Today({ onLaunch }) {
  const { data, refreshLight } = useApp();
  const [moneyData, setMoneyData] = useState(null);
  const [audit, setAudit] = useState(null);
  const [ready, setReady] = useState(null);
  const [pipeline, setPipeline] = useState(null);
  const [chain, setChain] = useState(null);

  useEffect(() => {
    api.aiChain().then(setChain).catch(() => {});
    api.deployReady().then(setReady).catch(() => {});
    api.growthAudit().then(setAudit).catch(() => {});
    api.pipelineStatus().then(setPipeline).catch(() => {});
  }, []);

  useEffect(() => {
    api.money({ days: 30 }).then(setMoneyData).catch(() => {});
  }, [data.pipeline?.published]);

  const settings = data.settings || {};
  const isDemo = (settings.mode || 'demo') !== 'live';
  const totals = moneyData?.totals || {};
  const live = data.pipeline || {};
  const accounts = data.accounts || [];
  const products = data.products || [];

  // ── Что мешает зарабатывать: блокеры хостинга, аудит площадок и пустые шаги
  const blockers = useMemo(() => {
    const list = [];
    (ready?.checks || [])
      .filter((c) => c.level === 'error')
      .forEach((c) => list.push({ id: `deploy-${c.id}`, level: 'blocker', title: c.title, detail: c.detail, fix: c.fix, to: routeHash('settings', 'hosting') }));
    (audit?.issues || [])
      .filter((i) => i.severity === 'block')
      .forEach((i) => list.push({ id: `audit-${i.id}`, level: 'blocker', title: i.title, detail: i.impact, fix: i.fix, to: i.action?.to || routeHash('channels', 'growth') }));
    if (isDemo) list.push({
      id: 'mode', level: 'warn', title: 'Демо-режим: цифры симулированы',
      detail: 'Реальных публикаций и выплат нет — платформа показывает сценарий, а не факт.',
      fix: 'PULSE_MODE=live в переменных, затем «Запустить конвейер».', to: routeHash('settings', 'main'),
    });
    if (!accounts.some((a) => a.auth_state === 'ok')) list.push({
      id: 'accounts', level: 'blocker', title: 'Нет подключённого канала',
      detail: 'Без OAuth-подключения публикация уходит в никуда: ролики собираются, но аудитории не видят.',
      fix: 'Каналы → Аккаунты → «Подключить» у нужного аккаунта.', to: routeHash('channels', 'accounts'),
    });
    if (!products.length) list.push({
      id: 'product', level: 'warn', title: 'Нечего продавать из роликов',
      detail: 'Охваты без продукта не превращаются в деньги: нет ссылки, нет кликов, нет продаж.',
      fix: 'Деньги → Продукты → добавить ссылку и цену.', to: routeHash('money', 'products'),
    });
    (audit?.issues || [])
      .filter((i) => i.severity === 'warn')
      .slice(0, 3)
      .forEach((i) => list.push({ id: `warn-${i.id}`, level: 'warn', title: i.title, detail: i.impact, fix: i.fix, to: i.action?.to || routeHash('channels', 'growth') }));
    return list;
  }, [ready, audit, isDemo, accounts, products]);

  // ── Одно следующее действие: самая важная вещь, которую можно сделать сейчас
  const next = useMemo(() => {
    const hard = blockers.filter((b) => b.level === 'blocker');
    if (hard.length) {
      return {
        title: hard[0].title,
        text: hard[0].detail,
        fix: hard[0].fix,
        to: hard[0].to,
        cta: 'Исправить',
        tone: 'danger',
      };
    }
    if (Number(live.review) > 0) {
      return {
        title: `Подтвердить ${live.review} ${live.review === 1 ? 'ролик' : 'ролика'}`,
        text: 'Pulse собрал ролики и остановился: публикация ждёт вашего «да». Одна кнопка — и дальше всё само.',
        to: routeHash('create', 'queue'),
        cta: 'Открыть очередь',
        tone: 'warn',
      };
    }
    if (String(settings.autopilot_global) !== '1') {
      return {
        title: 'Включить автопилот',
        text: 'Всё настроено, но конвейер стоит на паузе: ролики не выходят сами. Один клик — и поедет по расписанию.',
        action: 'autopilot',
        cta: 'Включить',
        tone: 'accent',
      };
    }
    if (!(live.queue?.pending || 0) && !(live.scheduled || 0)) {
      return {
        title: 'Запустить следующую партию',
        text: 'Очередь пустая, расписание тоже. Pulse может собрать новую партию роликов прямо сейчас.',
        action: 'launch',
        cta: 'Запустить конвейер',
        tone: 'accent',
      };
    }
    return {
      title: 'Всё работает само',
      text: `Автопилот включён, ${live.scheduled || 0} публикаций в расписании, ${live.queue?.pending ?? 0} задач в очереди. Проверьте разбор хуков и удержания, чтобы поднять охват.`,
      to: routeHash('channels', 'growth'),
      cta: 'Разбор охватов',
      tone: 'success',
    };
  }, [blockers, live, settings]);

  const startAutopilot = async () => {
    await api.updateSettings({ autopilot_global: '1' }).catch(() => {});
    refreshLight();
  };

  const steps = [
    { id: 'mode', done: !isDemo, label: 'Боевой режим', hint: 'PULSE_MODE=live', to: routeHash('settings', 'main') },
    { id: 'channel', done: accounts.some((a) => a.auth_state === 'ok'), label: 'Канал подключён', hint: `${accounts.filter((a) => a.auth_state === 'ok').length} из ${accounts.length}`, to: routeHash('channels', 'accounts') },
    { id: 'product', done: products.length > 0, label: 'Продукт со ссылкой', hint: products.length ? `${products.length} в работе` : 'нечего продавать', to: routeHash('money', 'products') },
    { id: 'ai', done: Boolean(ready?.checks?.find((c) => c.id === 'ai' && c.level === 'ok')), label: 'ИИ подключён', hint: 'бесплатный ключ', to: routeHash('settings', 'main') },
    { id: 'hosting', done: Boolean(ready?.ok), label: 'Хостинг готов', hint: ready?.ok ? 'том и адрес в порядке' : 'есть блокеры', to: routeHash('settings', 'hosting') },
  ];

  const recent = (data.logs || []).slice(0, 6);

  return (
    <div className="page">
      {/* ── Один шаг ────────────────────────────────────────────────────── */}
      <div className="card pad-lg" style={{
        background: 'linear-gradient(125deg, rgba(124,58,237,.24), rgba(12,8,18,.25) 62%)',
        borderColor: 'rgba(167,139,250,.26)',
      }}>
        <div className="row-between" style={{ gap: 10, marginBottom: 12 }}>
          <Badge tone={next.tone === 'danger' ? 'danger' : next.tone === 'warn' ? 'warn' : next.tone === 'success' ? 'success' : 'accent'} dot>
            следующий шаг
          </Badge>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {ready ? `${HOSTING_LABEL[ready.platform] || ready.platform}${ready.hosted ? '' : ' · локально'}` : 'проверяем хостинг'} · {isDemo ? 'demo' : 'live'}
          </span>
        </div>
        <h1 style={{ fontSize: 26, lineHeight: 1.18, fontWeight: 790, letterSpacing: '-0.04em', maxWidth: 620 }}>{next.title}</h1>
        <p className="dim" style={{ fontSize: 12.5, marginTop: 9, maxWidth: 620, lineHeight: 1.6 }}>{next.text}</p>
        {next.fix && <div className="mono" style={{ fontSize: 10.5, color: 'var(--violet-3)', marginTop: 8, wordBreak: 'break-word' }}>{next.fix}</div>}
        <div className="row wrap" style={{ gap: 8, marginTop: 16 }}>
          {next.action === 'autopilot' && <button className="btn btn-primary" onClick={startAutopilot}><Icon name="play" size={15} />{next.cta}</button>}
          {next.action === 'launch' && <button className="btn btn-primary" onClick={onLaunch}><Icon name="zap" size={15} />{next.cta}</button>}
          {next.to && <a className="btn btn-primary" href={next.to}><Icon name={next.tone === 'danger' ? 'alert' : 'chevronRight'} size={15} />{next.cta}</a>}
          {next.to && <a className="btn btn-ghost" href={routeHash('create', 'queue')}><Icon name="film" size={14} />Очередь</a>}
        </div>
      </div>

      {/* ── Деньги одной строкой ────────────────────────────────────────── */}
      <div className="card money-band">
        <div className="money-band-main">
          <div className="eyebrow">прибыль за 30 дней</div>
          <div className="money-band-value">{money(totals.profit || 0, moneyData?.currency)}</div>
          <div className="money-band-sub">
            доход {money(totals.revenue || 0, moneyData?.currency)} · расход {money(totals.cost || 0, moneyData?.currency)}
            {totals.roi != null && <> · ROI {Math.round(totals.roi)}%</>}
            {isDemo && <span style={{ color: 'var(--amber)' }}> · симуляция</span>}
          </div>
        </div>
        <div className="money-band-stats">
          <div><span>Просмотры</span><b>{fmt(totals.views || 0)}</b></div>
          <div><span>Клики</span><b>{fmt(totals.clicks || 0)}</b></div>
          <div><span>Покупки</span><b>{totals.conversions || 0}</b></div>
          <div><span>Прибыль/ролик</span><b>{money(totals.profitPerVideo || 0, moneyData?.currency)}</b></div>
        </div>
        <a className="btn btn-soft btn-sm" href={routeHash('money')}><Icon name="target" size={14} />Все деньги</a>
      </div>

      {/* ── Пять шагов: видно, где мы ───────────────────────────────────── */}
      <div className="card pad-lg">
        <div className="card-head">
          <div>
            <h2>Путь к первым деньгам</h2>
            <p>Пять условий, без которых конвейер собирает ролики, но не приносит денег</p>
          </div>
          <Badge tone={steps.every((s) => s.done) ? 'success' : 'muted'}>{steps.filter((s) => s.done).length}/5</Badge>
        </div>
        <div className="step-grid">
          {steps.map((s, i) => (
            <a className={`step-card ${s.done ? 'done' : ''}`} key={s.id} href={s.to}>
              <span className="step-num">{s.done ? <Icon name="check" size={12} /> : i + 1}</span>
              <span style={{ minWidth: 0 }}>
                <span className="step-label">{s.label}</span>
                <span className="step-hint">{s.hint}</span>
              </span>
            </a>
          ))}
        </div>
      </div>

      {/* ── Что мешает + что происходит ─────────────────────────────────── */}
      <div className="page-grid grid-2-1">
        <div className="card pad-lg">
          <div className="card-head">
            <div>
              <h2>Что мешает зарабатывать</h2>
              <p>Каждый пункт — с действием, а не с советом</p>
            </div>
            <Badge tone={blockers.some((b) => b.level === 'blocker') ? 'danger' : blockers.length ? 'warn' : 'success'}>
              {blockers.length ? `${blockers.length} ${blockers.length === 1 ? 'пункт' : 'пунктов'}` : 'чисто'}
            </Badge>
          </div>
          {blockers.length === 0 ? (
            <div className="row" style={{ gap: 8, fontSize: 12, color: 'var(--green)' }}>
              <Icon name="check" size={13} />Блокеров нет: режим, каналы, продукт и площадки в порядке.
            </div>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {blockers.slice(0, 5).map((b) => (
                <a key={b.id} href={b.to} style={{ textDecoration: 'none', color: 'inherit', padding: '10px 12px', border: `1px solid ${b.level === 'blocker' ? 'rgba(251,113,133,.32)' : 'rgba(251,191,36,.26)'}`, borderRadius: 11, background: b.level === 'blocker' ? 'rgba(251,113,133,.06)' : 'rgba(251,191,36,.05)' }}>
                  <div className="row" style={{ gap: 7, alignItems: 'flex-start' }}>
                    <Icon name={b.level === 'blocker' ? 'x' : 'alert'} size={12} style={{ marginTop: 2, flex: 'none', color: b.level === 'blocker' ? 'var(--red)' : 'var(--amber)' }} />
                    <div>
                      <b style={{ fontSize: 11.5 }}>{b.title}</b>
                      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, marginTop: 2 }}>{b.detail}</div>
                      {b.fix && <div style={{ fontSize: 10.5, color: 'var(--violet-3)', marginTop: 4 }}>{b.fix}</div>}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-title">
              <h3>Конвейер</h3>
              <a className="link-btn" href={routeHash('create', 'queue')}>очередь <Icon name="chevronRight" size={12} /></a>
            </div>
            <div className="row wrap" style={{ gap: 18 }}>
              <div className="hr-stat"><span className="v">{(pipeline?.active || []).length}</span><span className="l">в работе</span></div>
              <div className="hr-stat"><span className="v">{live.review || 0}</span><span className="l">ждут «да»</span></div>
              <div className="hr-stat"><span className="v">{live.scheduled || 0}</span><span className="l">в расписании</span></div>
              <div className="hr-stat"><span className="v">{live.queue?.pending ?? 0}</span><span className="l">задач</span></div>
            </div>
            {(pipeline?.active || []).slice(0, 2).map((e) => (
              <div key={e.id} style={{ marginTop: 10 }}>
                <div className="row-between" style={{ fontSize: 11.5, gap: 8 }}>
                  <span className="truncate">{e.title}</span>
                  <span style={{ color: 'var(--muted)' }}>{e.progress}%</span>
                </div>
                <Progress value={e.progress} striped={e.status === 'generating'} style={{ marginTop: 5 }} />
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card-title">
              <h3>События</h3>
              <a className="link-btn" href={routeHash('settings', 'logs')}>журнал <Icon name="chevronRight" size={12} /></a>
            </div>
            <div className="feed">
              {recent.map((l) => (
                <div className="feed-item" key={l.id}>
                  <span className={`feed-icon ${l.level}`}>
                    <Icon name={l.level === 'error' ? 'alert' : l.level === 'warn' ? 'info' : l.level === 'success' ? 'check' : 'zap'} size={12} />
                  </span>
                  <div className="feed-body">
                    <div className="feed-text">{l.message}</div>
                    <div className="feed-time">{relative(l.ts)}</div>
                  </div>
                </div>
              ))}
              {recent.length === 0 && <p className="muted" style={{ fontSize: 11.5 }}>Пока тихо.</p>}
            </div>
          </div>
        </div>
      </div>

      {/* Как это работает — свёрнуто: нужно один раз, но важно, чтобы было под рукой */}
      {chain && (
        <details className="how-card">
          <summary>
            <Icon name="info" size={14} />
            <span>Как это работает: {chain.automated} шагов делает машина, человек — по желанию</span>
            <Icon name="chevronDown" size={14} style={{ marginLeft: 'auto' }} />
          </summary>
          <div className="how-grid">
            {chain.steps.map((st) => (
              <div className="how-step" key={st.id}>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <b style={{ fontSize: 12 }}>{st.label}</b>
                  <span style={{ fontSize: 10.5, color: st.live ? 'var(--green)' : 'var(--muted)' }}>
                    {st.human ? 'человек по желанию' : st.live ? 'готово' : 'не подключено'}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.45 }}>{st.tool}</div>
                {/* резервный вариант показываем только там, где он реально отличается:
                    иначе это тот же текст дважды и лишний шум */}
                {!st.live && !st.human && st.fallback && (
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, lineHeight: 1.45 }}>{st.fallback}</div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
