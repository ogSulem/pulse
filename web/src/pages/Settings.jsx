import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon from '../components/Icons.jsx';
import { Badge, Toggle, Field, Confirm, useToast } from '../components/ui.jsx';

export default function Settings({ refresh }) {
  const { data } = useApp();
  const toast = useToast();
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const settings = data.settings || {};
  const providers = settings.providers || data.meta?.providers || {};

  const patch = async (payload) => {
    setBusy(true);
    try {
      await api.updateSettings(payload);
      await refresh();
      toast.push({ tone: 'success', title: 'Настройки сохранены' });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    } finally { setBusy(false); }
  };

  const reseed = async () => {
    setBusy(true);
    try {
      await api.reseed();
      await refresh();
      toast.push({ tone: 'success', title: 'Демо-данные пересозданы' });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    } finally { setBusy(false); }
  };

  const isDemo = (settings.mode || 'demo') !== 'live';

  const ProviderList = ({ title, items, hint }) => (
    <div className="card">
      <div className="card-title"><h3>{title}</h3><Badge tone={isDemo ? 'muted' : 'success'}>{isDemo ? 'demo' : 'live'}</Badge></div>
      <div className="col" style={{ gap: 7 }}>
        {(items || []).map((p) => (
          <div key={p.id} className="row-between" style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
            <div className="row" style={{ gap: 7, minWidth: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: 9, background: p.live ? 'var(--green)' : 'var(--muted)', flex: 'none', boxShadow: p.live ? '0 0 8px var(--green)' : 'none' }} />
              <span className="truncate" style={{ fontSize: 12, color: p.active ? 'var(--text)' : 'var(--text-2)' }}>{p.label}</span>
            </div>
            <div className="row" style={{ gap: 5 }}>
              {p.active && <Badge tone="accent">выбран</Badge>}
              <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>{p.keyEnv || (p.live ? 'ready' : '—')}</span>
            </div>
          </div>
        ))}
        {!items?.length && <span className="muted" style={{ fontSize: 11.5 }}>Не настроено</span>}
      </div>
      {hint && <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 10, lineHeight: 1.55 }}>{hint}</p>}
    </div>
  );

  return (
    <div className="page">
      <div className="page-grid grid-2-1">
        <div className="card pad-lg">
          <div className="card-head">
            <div>
              <h2>Правила конвейера</h2>
              <p>Глобальные настройки, которые действуют на все проекты</p>
            </div>
            <Badge tone={isDemo ? 'warn' : 'success'} dot>{isDemo ? 'demo-режим' : 'live-режим'}</Badge>
          </div>

          <div className="col" style={{ gap: 4 }}>
            <Toggle label="Автопилот платформы"
              hint="Наполнять очередь и публиковать без ручного подтверждения"
              checked={String(settings.autopilot_global) === '1'}
              onChange={(v) => patch({ autopilot_global: v ? '1' : '0' })} />
            <Toggle label="Ручная проверка каждого ролика"
              hint="Все ролики попадают в статус «На проверке» — публикация только после вашего клика"
              checked={String(settings.manual_review) === '1'}
              onChange={(v) => patch({ manual_review: v ? '1' : '0' })} />

            <div style={{ padding: '14px 0' }}>
              <div className="row-between" style={{ marginBottom: 8 }}>
                <div>
                  <div className="t-label">Порог риска</div>
                  <div className="t-hint">Если риск контента выше порога — ролик уходит на ручную проверку</div>
                </div>
                <Badge tone={Number(settings.risk_threshold) >= 70 ? 'danger' : 'warn'}>{settings.risk_threshold}/100</Badge>
              </div>
              <input type="range" min="10" max="90" value={Number(settings.risk_threshold) || 55}
                onChange={(e) => patch({ risk_threshold: e.target.value })} />
            </div>

            <div className="form-grid">
              <Field label="Максимум постов в день на аккаунт">
                <input className="input" type="number" min="1" max="6" value={Number(settings.max_daily_per_account) || 3}
                  onChange={(e) => patch({ max_daily_per_account: e.target.value })} />
              </Field>
              <Field label="Часовой пояс планировщика">
                <input className="input" value={settings.timezone || 'Europe/Moscow'} onChange={(e) => patch({ timezone: e.target.value })} />
              </Field>
            </div>
          </div>

          <div className="notice" style={{ marginTop: 14 }}>
            <Icon name="info" size={15} />
            <span>
              Настройки применяются к <b>новым</b> задачам. Уже запущенные ролики доходят по прежним правилам —
              это защищает от резкой смены ритма публикаций.
            </span>
          </div>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-title"><h3>Режим работы</h3><Badge tone={isDemo ? 'muted' : 'success'}>{settings.mode || 'demo'}</Badge></div>
            <p style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6 }}>
              {isDemo
                ? 'Demo: сценарии, видео, озвучка и публикация симулируются. Панель полностью рабочая, ключи API не нужны.'
                : 'Live: используются реальные провайдеры из .env. Публикация идёт через официальные API площадок.'}
            </p>
            <div className="divider" style={{ margin: '12px -18px' }} />
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--violet-3)', lineHeight: 1.8 }}>
              PULSE_MODE={isDemo ? 'demo' : 'live'}<br />
              PULSE_PASSWORD=••••••<br />
              PULSE_SECRET=••••••
            </div>
            <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 10, lineHeight: 1.55 }}>
              Смените режим в <span className="mono">.env</span> и перезапустите контейнер: <span className="mono">docker compose up -d</span>.
            </p>
          </div>

          <div className="card">
            <div className="card-title"><h3>Данные и бэкап</h3></div>
            <div className="col" style={{ gap: 8 }}>
              <a className="btn btn-sm btn-block" href={api.backupUrl()}><Icon name="database" size={13} />Скачать бэкап (JSON)</a>
              <a className="btn btn-sm btn-block" href={api.exportUrl('ideas')}><Icon name="download" size={13} />Темы → CSV</a>
              <a className="btn btn-sm btn-block" href={api.exportUrl('scripts')}><Icon name="download" size={13} />Сценарии → CSV</a>
              <a className="btn btn-sm btn-block" href={api.exportUrl('analytics')}><Icon name="download" size={13} />Статистика → CSV</a>
            </div>
            <div className="divider" style={{ margin: '12px -18px' }} />
            <button className="btn btn-danger btn-sm btn-block" onClick={() => setConfirmReset(true)} disabled={busy}>
              <Icon name="refresh" size={13} />Пересоздать демо-данные
            </button>
          </div>
        </div>
      </div>

      <div className="page-grid grid-4">
        <ProviderList title="Видео-генерация" items={providers.video} hint="Движок меняется адаптером: NVIDIA NIM, Runway, Luma, Pika, Replicate — без переделки конвейера." />
        <ProviderList title="Озвучка (TTS)" items={providers.tts} hint="Поддерживается мультиязычный синтез и клонирование голоса." />
        <ProviderList title="LLM" items={providers.llm} hint="Идеи, сценарии и описания. Без ключа работает встроенный Content Brain." />
        <ProviderList title="Публикация" items={providers.publish} hint="Meta Graph API для Reels и TikTok Content Posting API. Токены — только в секретах." />
      </div>

      <div className="page-grid grid-2">
        <div className="card pad-lg">
          <div className="card-head">
            <div>
              <h2>Запуск на VPS</h2>
              <p>Один compose-файл: панель + постоянный том данных</p>
            </div>
            <Badge tone="accent">docker</Badge>
          </div>
          <pre className="mono" style={{
            background: 'rgba(0,0,0,.35)', border: '1px solid var(--line)', borderRadius: 12,
            padding: 14, fontSize: 11, lineHeight: 1.8, overflowX: 'auto', margin: 0, color: 'var(--violet-3)',
          }}>{`git clone <repo> pulse && cd pulse
cp .env.example .env
nano .env                  # пароль + секрет + режим
docker compose up -d --build
open http://<ip-сервера>:8080`}</pre>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 12, lineHeight: 1.6 }}>
            Данные лежат в томе <span className="mono">./data</span>. Бэкап — скопировать этот каталог или скачать JSON выше.
            Для HTTPS поставьте перед контейнером Caddy или Nginx (пример в <span className="mono">deploy/</span>).
          </p>
        </div>

        <div className="card pad-lg">
          <div className="card-head">
            <div>
              <h2>Где что лежит</h2>
              <p>Структура кода без магии</p>
            </div>
          </div>
          <div className="col" style={{ gap: 9, fontSize: 11.5, color: 'var(--text-2)' }}>
            {[
              ['server/src/engine/pipeline.js', 'этапы конвейера, слоты, публикация'],
              ['server/src/engine/brain.js', 'идеи, сценарии, описания, обложки'],
              ['server/src/core/queue.js', 'очередь с lease и retry'],
              ['server/src/providers/index.js', 'адаптеры видео / TTS / LLM / постинга'],
              ['server/src/modules/api.js', 'REST-эндпоинты и выгрузки'],
              ['web/src/pages', 'экраны панели'],
              ['docs/ARCHITECTURE.md', 'целевая микросервисная схема'],
            ].map(([path, text]) => (
              <div className="row" key={path} style={{ gap: 10 }}>
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--violet-3)', minWidth: 190 }}>{path}</span>
                <span className="muted">{text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Confirm open={confirmReset} onClose={() => setConfirmReset(false)}
        title="Пересоздать демо-данные?"
        text="Текущие проекты, ролики и статистика будут удалены и заменены свежим демо-набором. В live-режиме не используйте."
        confirmLabel="Пересоздать"
        onConfirm={reseed} />
    </div>
  );
}
