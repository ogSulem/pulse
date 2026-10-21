import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken } from './lib/api.js';
import Icon, { Logo } from './components/Icons.jsx';
import { Badge, ToastProvider, useToast } from './components/ui.jsx';
import { plural } from './lib/format.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Projects from './pages/Projects.jsx';
import Queue from './pages/Queue.jsx';
import Calendar from './pages/Calendar.jsx';
import Analytics from './pages/Analytics.jsx';
import Money from './pages/Money.jsx';
import Transparency from './pages/Transparency.jsx';
import Accounts from './pages/Accounts.jsx';
import Products from './pages/Products.jsx';
import Logs from './pages/Logs.jsx';
import Settings from './pages/Settings.jsx';
import LaunchModal from './components/LaunchModal.jsx';

const NAV = [
  { section: 'Производство' },
  { id: 'dashboard', label: 'Обзор', icon: 'grid', hash: '#/' },
  { id: 'queue', label: 'Очередь роликов', icon: 'film', hash: '#/queue', badge: 'active' },
  { id: 'calendar', label: 'Расписание', icon: 'calendar', hash: '#/calendar' },
  { id: 'projects', label: 'Проекты и темы', icon: 'sparkles', hash: '#/projects' },
  { section: 'Результат' },
  { id: 'analytics', label: 'Аналитика', icon: 'chart', hash: '#/analytics' },
  { id: 'money', label: 'Деньги', icon: 'target', hash: '#/money' },
  { id: 'products', label: 'Продвижение', icon: 'package', hash: '#/products' },
  { id: 'accounts', label: 'Аккаунты', icon: 'at', hash: '#/accounts' },
  { section: 'Доверие' },
  { id: 'transparency', label: 'Прозрачность', icon: 'shield', hash: '#/transparency', badge: 'review' },
  { id: 'logs', label: 'Журнал', icon: 'terminal', hash: '#/logs' },
  { id: 'settings', label: 'Настройки', icon: 'settings', hash: '#/settings' },
];

const TITLES = {
  dashboard: { title: 'Обзор', sub: 'Конвейер, публикации и результат в одном экране' },
  queue: { title: 'Очередь роликов', sub: 'Каждый этап, статус и ручные правки' },
  calendar: { title: 'Расписание публикаций', sub: 'Слоты по аккаунтам и площадкам' },
  projects: { title: 'Проекты и темы', sub: 'Ниша, продукт и генерация идей' },
  analytics: { title: 'Аналитика', sub: 'Просмотры, CTR, подписчики и эффективность тем' },
  money: { title: 'Деньги', sub: 'Доход, расход, ROI и окупаемость каждого ролика' },
  transparency: { title: 'Прозрачность', sub: 'Что автоматизировано, где нужен человек и какие лимиты' },
  products: { title: 'Продвижение продукта', sub: 'Шаблоны интеграции, ссылки и UTM' },
  accounts: { title: 'Аккаунты и квоты', sub: 'Распределение нагрузки и защита от блокировок' },
  logs: { title: 'Журнал действий', sub: 'Что произошло и когда — по каждому ролику' },
  settings: { title: 'Настройки', sub: 'Провайдеры, режим, риски, бэкап' },
};

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

const routeId = () => {
  const h = (window.location.hash || '#/').replace(/^#\/?/, '').split('?')[0];
  return h === '' ? 'dashboard' : h;
};

function Shell({ data, refresh, refreshLight, loading }) {
  const [route, setRoute] = useState(routeId());
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'dark');
  const [launch, setLaunch] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const onHash = () => { setRoute(routeId()); setMenuOpen(false); window.scrollTo({ top: 0 }); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (hash) => { window.location.hash = hash; };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pulse.theme', next); } catch {}
  };

  const activeCount = (data.pipeline?.queued || 0) + (data.pipeline?.generating || 0);
  const reviewCount = data.pipeline?.review || 0;
  const badgeValue = (kind) => (kind === 'review' ? reviewCount : kind === 'active' ? activeCount : 0);
  const meta = TITLES[route] || TITLES.dashboard;

  const pages = {
    dashboard: <Dashboard onLaunch={() => setLaunch(true)} />,
    queue: <Queue onLaunch={() => setLaunch(true)} />,
    calendar: <Calendar />,
    projects: <Projects />,
    analytics: <Analytics />,
    money: <Money />,
    transparency: <Transparency />,
    products: <Products />,
    accounts: <Accounts />,
    logs: <Logs />,
    settings: <Settings refresh={refresh} />,
  };

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

        <nav className="col" style={{ gap: 2 }}>
          {NAV.map((item, i) =>
            item.section ? (
              <div className="nav-section" key={`s${i}`}>{item.section}</div>
            ) : (
              <button
                key={item.id}
                className={`nav-item ${route === item.id ? 'active' : ''}`}
                onClick={() => go(item.hash)}
              >
                <Icon name={item.icon} size={16} />
                {item.label}
                {item.badge && badgeValue(item.badge) > 0 && <span className={`nav-badge ${item.badge}`}>{badgeValue(item.badge)}</span>}
              </button>
            )
          )}
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

        <header className="topbar">
          <div>
            <div className="topbar-title">{meta.title}</div>
            <div className="topbar-sub">
              <span>{meta.sub}</span>
              <span style={{ opacity: 0.4 }}>·</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 5, height: 5, borderRadius: 9, background: activeCount ? 'var(--violet-2)' : 'var(--green)', boxShadow: `0 0 8px ${activeCount ? 'var(--violet-2)' : 'var(--green)'}` }} />
                {activeCount ? `${activeCount} ${plural(activeCount, 'ролик', 'ролика', 'роликов')} в работе` : 'конвейер свободен'}
              </span>
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

        {loading && !data.projects.length ? (
          <div className="page">
            <div className="page-grid grid-4">{[0, 1, 2, 3].map((i) => <div className="skeleton" key={i} style={{ height: 128 }} />)}</div>
            <div className="skeleton" style={{ height: 320 }} />
          </div>
        ) : (
          pages[route] || pages.dashboard
        )}
      </div>

      <LaunchModal open={launch} onClose={() => setLaunch(false)} onDone={() => { refresh(); window.location.hash = '#/queue'; }} />
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
