import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken } from './lib/api.js';
import Icon, { Logo } from './components/Icons.jsx';
import { Badge, ToastProvider, useToast } from './components/ui.jsx';
import { plural } from './lib/format.js';
import { SECTIONS, resolveRoute, routeHash, sectionById } from './lib/nav.js';
import Login from './pages/Login.jsx';
import Today from './pages/Today.jsx';
import Studio from './pages/Studio.jsx';
import Queue from './pages/Queue.jsx';
import Calendar from './pages/Calendar.jsx';
import Series from './pages/Series.jsx';
import Projects from './pages/Projects.jsx';
import Analytics from './pages/Analytics.jsx';
import Money from './pages/Money.jsx';
import Growth from './pages/Growth.jsx';
import Accounts from './pages/Accounts.jsx';
import Transparency from './pages/Transparency.jsx';
import Products from './pages/Products.jsx';
import Ads from './pages/Ads.jsx';
import Logs from './pages/Logs.jsx';
import Settings from './pages/Settings.jsx';
import HostingCard from './components/HostingCard.jsx';
import LaunchModal from './components/LaunchModal.jsx';

// Пятнадцать пунктов в сайдбаре — это не удобство, а ежедневный поиск «где что
// лежит». Меню теперь из пяти разделов (см. lib/nav.js), внутри раздела —
// вкладки. Старые адреса вроде #/money/analytics работают: они разрешаются в пару
// «раздел/вкладка», поэтому ссылки и закладки не ломаются.
const ROUTE_TITLES = {
  'today/today': ['Сегодня', 'Один следующий шаг, деньги и то, что мешает зарабатывать'],
  'create/studio': ['Студия', 'Запуск: каналы, темы, продукты, ИИ и автопилот'],
  'create/queue': ['Очередь роликов', 'Каждый этап, статус и ручные правки'],
  'create/calendar': ['Расписание', 'Слоты по аккаунтам и площадкам'],
  'create/series': ['Сериалы', 'Длинные истории: библия, сезон, фото-ряд, мид-роллы'],
  'create/themes': ['Темы и идеи', 'Ниша, продукт и генерация идей'],
  'channels/growth': ['Рост и охваты', 'Алгоритмы площадок, хуки, удержание, монетизация'],
  'channels/accounts': ['Аккаунты', 'Подключение, квоты и защита от блокировок'],
  'channels/trust': ['Правила', 'Что автоматизировано, где нужен человек, какие лимиты'],
  'money/totals': ['Деньги', 'Доход, расход, ROI и окупаемость каждого ролика'],
  'money/analytics': ['Аналитика', 'Просмотры, CTR, подписчики и эффективность тем'],
  'money/ads': ['Реклама и бренды', 'Кампании, маркировка ОРД и спонсорские деньги'],
  'money/products': ['Продукты', 'Ссылки, UTM и шаблоны интеграции'],
  'settings/main': ['Настройки', 'Режим, провайдеры, правила конвейера'],
  'settings/hosting': ['Хостинг', 'Том, адрес, пароль, место на диске'],
  'settings/logs': ['Журнал', 'Что произошло и когда — по каждому ролику'],
};

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

const currentRoute = () => resolveRoute(window.location.hash);

// Хостинг — отдельная вкладка настроек: это разовая проверка, а не ежедневный
// экран. Раньше она стояла в Студии рядом с «Запустить» и мешала.
function SettingsHosting() {
  return (
    <div className="page">
      <HostingCard />
      <div className="notice">
        <Icon name="info" size={14} />
        <span>
          Чек-лист по шагам, тарифы и разбор сбоев — в{' '}
          <a className="link-btn" href="https://github.com/ogSulem/pulse/blob/main/docs/RAILWAY.md" target="_blank" rel="noreferrer">docs/RAILWAY.md <Icon name="arrowUpRight" size={10} /></a>
          . Всё, что можно проверить кодом, платформа проверяет сама и показывает здесь с готовым действием.
        </span>
      </div>
    </div>
  );
}

function Shell({ data, refresh, refreshLight, loading }) {
  const [route, setRoute] = useState(currentRoute());
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'dark');
  const [launch, setLaunch] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const onHash = () => { setRoute(currentRoute()); setMenuOpen(false); window.scrollTo({ top: 0 }); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (hash) => { window.location.hash = hash; };
  const section = sectionById(route.section);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pulse.theme', next); } catch {}
  };

  const activeCount = (data.pipeline?.queued || 0) + (data.pipeline?.generating || 0);
  const reviewCount = data.pipeline?.review || 0;
  const badgeValue = (kind) => (kind === 'review' ? reviewCount : kind === 'active' ? activeCount : 0);
  // заголовок вкладки; описание раздела живёт в самом экране, а не в шапке
  const meta = { title: (ROUTE_TITLES[`${route.section}/${route.tab}`] || [section.title])[0] };

  // Один экран на пару «раздел/вкладка». Ничего не грузится заранее: вкладка
  // открывается по клику, поэтому первый экран остаётся быстрым.
  const screens = {
    'today/today': <Today onLaunch={() => setLaunch(true)} />,
    'create/studio': <Studio />,
    'create/queue': <Queue onLaunch={() => setLaunch(true)} />,
    'create/calendar': <Calendar />,
    'create/series': <Series />,
    'create/themes': <Projects />,
    'channels/growth': <Growth />,
    'channels/accounts': <Accounts />,
    'channels/trust': <Transparency />,
    'money/totals': <Money />,
    'money/analytics': <Analytics />,
    'money/ads': <Ads />,
    'money/products': <Products />,
    'settings/main': <Settings refresh={refresh} />,
    'settings/hosting': <SettingsHosting />,
    'settings/logs': <Logs />,
  };
  const page = screens[`${route.section}/${route.tab}`] || screens['today/today'];

  const queue = data.pipeline?.queue || {};

  return (
    <div className="app">
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <a className="brand" href="#/" onClick={() => setMenuOpen(false)}>
          <Logo size={34} />
          <div>
            <div className="brand-name">Pulse</div>
            <div className="brand-sub">content engine</div>
          </div>
        </a>

        {/* Пять разделов. Внутри раздела — вкладки: так в меню не бывает
            пятнадцати строк, а всё нужное остаётся в одном клике. */}
        <nav className="col" style={{ gap: 2 }}>
          {SECTIONS.map((sec) => {
            const active = sec.id === route.section;
            return (
              <div key={sec.id}>
                <button
                  className={`nav-item ${active ? 'active' : ''}`}
                  onClick={() => go(routeHash(sec.id))}
                >
                  <Icon name={sec.icon} size={16} />
                  {sec.label}
                  {sec.badge && badgeValue(sec.badge) > 0 && <span className={`nav-badge ${sec.badge}`}>{badgeValue(sec.badge)}</span>}
                </button>
                {active && sec.tabs.length > 1 && (
                  <div className="nav-sub">
                    {sec.tabs.map((t) => (
                      <button
                        key={t.id}
                        className={`nav-sub-item ${route.tab === t.id ? 'on' : ''}`}
                        onClick={() => go(routeHash(sec.id, t.id))}
                      >
                        {t.label}
                        {t.id === 'queue' && reviewCount > 0 && <span className="nav-badge review">{reviewCount}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <div className="mode-card">
            <div className="mode-line">
              <span>Режим</span>
              <b style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 5, height: 5, borderRadius: 9, background: 'var(--green)', boxShadow: '0 0 8px var(--green)' }} />
                {(data.settings?.mode || 'demo') === 'live' ? 'live' : 'demo'}
              </b>
            </div>
            <div className="mode-line"><span>В очереди</span><b>{queue.pending ?? 0}</b></div>
            <div className="mode-line"><span>Автопилот</span><b>{String(data.settings?.autopilot_global) === '1' ? 'вкл' : 'выкл'}</b></div>
          </div>
          <div className="user-card">
            <div className="avatar">PS</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 650 }}>Owner</div>
              <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>Pulse Studio</div>
            </div>
            <button className="btn btn-ghost btn-icon" title="Тема" onClick={toggleTheme}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
            </button>
            <button className="btn btn-ghost btn-icon" title="Выйти" onClick={() => { setToken(null); window.location.reload(); }}>
              <Icon name="logout" size={15} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="mobile-bar">
          <button className="btn btn-ghost btn-icon" onClick={() => setMenuOpen(true)} aria-label="Меню"><Icon name="menu" /></button>
          <Logo size={26} />
          <span style={{ fontWeight: 750, letterSpacing: '-0.02em' }}>Pulse</span>
          <div style={{ marginLeft: 'auto' }}>
            <button className="btn btn-primary btn-sm" onClick={() => setLaunch(true)}><Icon name="plus" size={14} />Запуск</button>
          </div>
        </div>

        {section.tabs.length > 1 && (
          <div className="section-tabs">
            {section.tabs.map((t) => (
              <button
                key={t.id}
                className={`section-tab ${route.tab === t.id ? 'on' : ''}`}
                onClick={() => go(routeHash(section.id, t.id))}
              >
                <Icon name={t.icon} size={13} />{t.label}
              </button>
            ))}
          </div>
        )}

        <header className="topbar">
          {/* Одна строка: где я и что происходит. Подзаголовок раздела убран —
              он дублировал вкладки и заголовок самого экрана. */}
          <div>
            <div className="topbar-title">{meta.title}</div>
            <div className="topbar-sub">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 5, height: 5, borderRadius: 9, background: activeCount ? 'var(--violet-2)' : 'var(--green)', boxShadow: `0 0 8px ${activeCount ? 'var(--violet-2)' : 'var(--green)'}` }} />
                {activeCount ? `${activeCount} ${plural(activeCount, 'ролик', 'ролика', 'роликов')} в работе` : 'конвейер свободен'}
              </span>
              {reviewCount > 0 && <span>· {reviewCount} ждут подтверждения</span>}
            </div>
          </div>
          <div className="topbar-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => { refreshLight(); toast.push({ title: 'Данные обновлены', tone: 'info' }); }} title="Обновить">
              <Icon name="refresh" size={14} className={loading ? 'spin' : ''} />
            </button>
            <button className={`btn btn-sm ${String(data.settings?.autopilot_global) === '1' ? 'btn-soft' : ''}`}
              onClick={async () => {
                const next = String(data.settings?.autopilot_global) === '1' ? '0' : '1';
                await api.updateSettings({ autopilot_global: next });
                refresh();
                toast.push({ title: next === '1' ? 'Автопилот включён' : 'Автопилот на паузе', tone: next === '1' ? 'success' : 'info', text: next === '1' ? 'Новые ролики будут выходить по расписанию' : 'Конвейер остановит публикации, черновики останутся' });
              }}>
              <Icon name={String(data.settings?.autopilot_global) === '1' ? 'pause' : 'play'} size={13} />
              {String(data.settings?.autopilot_global) === '1' ? 'Пауза' : 'Продолжить'}
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setLaunch(true)}>
              <Icon name="zap" size={14} />Запустить конвейер
            </button>
          </div>
        </header>

        {/* Честная рамка: в demo цифры и публикации симулированы. Без этой
            строки легко решить, что панель уже зарабатывает. */}
        {(data.settings?.mode || 'demo') !== 'live' && !loading && (
          <div className="demo-strip">
            <Icon name="info" size={14} />
            <span>
              <b>Демо-режим.</b> Ролики и доход симулируются. Для заработка: <code>PULSE_MODE=live</code>,
              каналы и ключи — дальше всё считает автопилот.
            </span>
            <a className="link-btn" href="#/settings/main">Настройки <Icon name="arrowUpRight" size={11} /></a>
          </div>
        )}

        {loading && !data.projects.length ? (
          <div className="page">
            <div className="page-grid grid-4">{[0, 1, 2, 3].map((i) => <div className="skeleton" key={i} style={{ height: 128 }} />)}</div>
            <div className="skeleton" style={{ height: 320 }} />
          </div>
        ) : (
          page
        )}
      </div>

      <LaunchModal open={launch} onClose={() => setLaunch(false)} onDone={() => { refresh(); window.location.hash = '#/create/queue'; }} />
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [data, setData] = useState({ projects: [], accounts: [], products: [], settings: {}, pipeline: {}, episodes: [], logs: [] });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.bootstrap();
      setData(res);
    } catch (err) {
      if (err.status === 401) setAuthed(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshLight = useCallback(async () => {
    try {
      const [pipeline, episodes, logs, projects, settings] = await Promise.all([
        api.pipelineStatus(), api.episodes({ limit: 14 }), api.logs({ limit: 16 }), api.projects(), api.settings(),
      ]);
      setData((prev) => ({ ...prev, pipeline: { ...pipeline.byStatus, queue: pipeline.queue, active: pipeline.active, upcoming: pipeline.upcoming }, episodes, logs, projects, settings }));
    } catch (err) {
      if (err.status === 401) setAuthed(false);
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    load().then(() => refreshLight());
    const t = setInterval(refreshLight, 6000);
    return () => clearInterval(t);
  }, [authed, load, refreshLight]);

  useEffect(() => {
    const onUnauth = () => setAuthed(false);
    window.addEventListener('pulse:unauthorized', onUnauth);
    return () => window.removeEventListener('pulse:unauthorized', onUnauth);
  }, []);

  const value = useMemo(() => ({ data, refresh: load, refreshLight, loading }), [data, load, refreshLight, loading]);

  if (!authed) {
    return (
      <ToastProvider>
        <Login onSuccess={() => { setAuthed(true); setLoading(true); }} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <AppCtx.Provider value={value}>
        <Shell data={data} refresh={load} refreshLight={refreshLight} loading={loading} />
      </AppCtx.Provider>
    </ToastProvider>
  );
}
