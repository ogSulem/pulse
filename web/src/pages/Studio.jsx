import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Icon from '../components/Icons.jsx';
import { Badge, Empty, Progress, useToast } from '../components/ui.jsx';

// PulseStudio — экран запуска. Не «дашборд ради дашборда»: чек-лист из шагов,
// без которых контент не выйдет или не заработает, и состояние интеграций.
const PROVIDER_KINDS = [
  { key: 'llm', label: 'Сценарий (LLM)' },
  { key: 'tts', label: 'Озвучка (TTS)' },
  { key: 'video', label: 'Видео-движок' },
  { key: 'publish', label: 'Публикация' },
];

const STEP_ICON = { account: 'at', topic: 'sparkles', product: 'package', content: 'film', live: 'rocket' };

export default function Studio() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setData(await api.studioOverview());
      setError('');
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => { load(); }, []);

  if (error) {
    return <Empty icon="alert" title="Студия не открылась" text={error}
      action={<button className="btn btn-primary btn-sm" onClick={load}>Повторить</button>} />;
  }
  if (!data) return <div className="col" style={{ gap: 12 }}><Progress value={40} /><span className="muted">Собираем состояние студии…</span></div>;

  const { steps, stats, integrations, secrets } = data;
  const frames = integrations.frames || {};
  const oauth = integrations.oauth || {};
  const providers = integrations.providers || {};
  const live = data.mode === 'live';

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card pad-lg">
        <div className="row-between" style={{ alignItems: 'flex-start', gap: 16 }}>
          <div>
            <div className="row" style={{ gap: 8 }}>
              <h2 style={{ margin: 0 }}>PulseStudio</h2>
              <Badge tone={live ? 'success' : 'warn'} dot>{live ? 'live — публикуем по-настоящему' : 'demo — всё симулируется'}</Badge>
            </div>
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 12.5, maxWidth: 620 }}>
              Готово на {data.progress}%. Ниже — только те шаги, которые реально влияют на выход роликов и деньги.
            </p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={load}><Icon name="refresh" size={13} />Обновить</button>
        </div>
        <div style={{ marginTop: 14 }}><Progress value={data.progress} /></div>
      </div>

      <div className="grid-4">
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Каналы</span><span className="kpi-icon"><Icon name="at" size={14} /></span></div>
          <div className="kpi-value">{stats.connected}<small>/ {stats.accounts}</small></div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{stats.withTopic} с темой</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Продукты</span><span className="kpi-icon"><Icon name="package" size={14} /></span></div>
          <div className="kpi-value">{stats.products}</div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>участвуют в сценариях</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Сериалы</span><span className="kpi-icon"><Icon name="film" size={14} /></span></div>
          <div className="kpi-value">{stats.series}</div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{stats.seriesEpisodes} серий</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Shorts вышло</span><span className="kpi-icon"><Icon name="upload" size={14} /></span></div>
          <div className="kpi-value">{stats.shortsPublished}</div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>по всем аккаунтам</span></div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Путь запуска</div>
            <div className="card-sub">{data.nextStep ? `Следующий шаг: ${data.nextStep.title}` : 'Все шаги пройдены — конвейер работает сам'}</div>
          </div>
        </div>
        <div className="card-body col" style={{ gap: 10 }}>
          {steps.map((s, i) => (
            <div key={s.id} className="row-between" style={{ gap: 14, padding: '12px 14px', borderRadius: 14, background: s.done ? 'rgba(52,211,153,.06)' : 'var(--surface-2, rgba(255,255,255,.03))', border: '1px solid var(--line)' }}>
              <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                <span className="kpi-icon" style={{ background: s.done ? 'rgba(52,211,153,.16)' : undefined }}>
                  <Icon name={s.done ? 'check' : STEP_ICON[s.id] || 'sparkles'} size={14} />
                </span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 650 }}>{i + 1}. {s.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5, maxWidth: 560 }}>{s.text}</div>
                </div>
              </div>
              <a className={`btn btn-sm ${s.done ? 'btn-ghost' : 'btn-primary'}`} href={s.action.to}>
                {s.action.label}<Icon name="chevronRight" size={12} />
              </a>
            </div>
          ))}
        </div>
      </div>

      <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Нейро-кадры</div>
              <div className="card-sub">Фото-ряд сериала: Flux и запасные провайдеры</div>
            </div>
            <Badge tone={frames.enabled ? 'success' : 'muted'} dot>{frames.enabled ? 'включены' : 'выключены'}</Badge>
          </div>
          <div className="card-body" style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.65 }}>
            Активный провайдер: <b style={{ color: 'var(--text)' }}>{frames.active || '—'}</b><br />
            Режим: <b style={{ color: 'var(--text)' }}>{frames.mode || 'demo'}</b> · пауза между кадрами {frames.minGapSec || 15} с<br />
            {frames.enabled
              ? 'Кадры кэшируются по промпту: повторный рендер серии не тратит лимиты.'
              : 'В demo нужен PULSE_IMAGES=on, в live — достаточно бесплатного Flux без ключа.'}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Вход в каналы (OAuth)</div>
              <div className="card-sub">Кнопка вместо ручных токенов</div>
            </div>
            <Badge tone={oauth.configured ? 'success' : 'warn'} dot>{oauth.configured ? 'настроен' : 'нужны ключи'}</Badge>
          </div>
          <div className="card-body col" style={{ gap: 8 }}>
            {(oauth.platforms || []).map((p) => (
              <div key={p.id} className="row-between" style={{ fontSize: 12 }}>
                <span>{p.label}</span>
                <Badge tone={p.configured ? 'success' : 'muted'} dot>{p.configured ? 'готов' : p.missing.join(' / ')}</Badge>
              </div>
            ))}
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Redirect URI: <code className="mono" style={{ wordBreak: 'break-all' }}>{oauth.platforms?.[0]?.redirectUri || '—'}</code>
            </div>
            <a className="btn btn-soft btn-sm" href="#/accounts" style={{ marginTop: 4 }}><Icon name="link" size={12} />Открыть аккаунты</a>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Провайдеры моделей</div>
              <div className="card-sub">Кто пишет сценарий, озвучивает и рисует</div>
            </div>
          </div>
          <div className="card-body col" style={{ gap: 6, fontSize: 12 }}>
            {PROVIDER_KINDS.map(({ key, label }) => {
              const list = Array.isArray(providers[key]) ? providers[key] : [];
              const active = list.find((x) => x.active) || null;
              return (
                <div key={key} className="row-between">
                  <span style={{ color: 'var(--muted)' }}>{label}</span>
                  <Badge tone={active?.live ? 'success' : active ? 'warn' : 'muted'} dot>
                    {active ? (active.id || 'on') : list.length ? 'demo' : '—'}
                  </Badge>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Автопилот</div>
              <div className="card-sub">Что происходит без вашего участия</div>
            </div>
          </div>
          <div className="card-body col" style={{ gap: 7, fontSize: 12 }}>
            {[
              ['Ролики каждый день', true, 'слоты по аккаунтам и темам'],
              ['Серии сериалов заранее', String(integrations.settings.series_auto_compose) === '1', `ряд вперёд: ${integrations.settings.series_lookahead || 3}`],
              ['Сборка видео без человека', String(integrations.settings.series_auto_render) === '1', 'рендер в очереди'],
              ['Публикация после ревью', String(integrations.settings.series_autopublish) === '1', 'автопубликация серий'],
            ].map(([label, on, note]) => (
              <div key={label} className="row-between">
                <span>{label}</span>
                <span className="muted" style={{ fontSize: 11 }}>{on ? `вкл · ${note}` : 'выкл'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {secrets.passwordIsDefault && (
        <div className="notice">
          <Icon name="alert" size={14} />
          <span>
            Пароль панели не задан через <code className="mono">PULSE_PASSWORD</code> — Pulse сгенерировал его при первом
            запуске (см. <code className="mono">data/first-login.txt</code>). Для постоянного доступа задайте свой.
          </span>
        </div>
      )}
      {!secrets.publicUrl && (
        <div className="notice">
          <Icon name="info" size={14} />
          <span>
            <code className="mono">PULSE_PUBLIC_URL</code> не задан: Instagram и TikTok требуют публичный адрес видео,
            а OAuth — точный redirect URI. Укажите домен в настройках окружения.
          </span>
        </div>
      )}
    </div>
  );
}
