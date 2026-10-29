import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon from '../components/Icons.jsx';
import { Badge, Toggle, Field, Confirm, useToast } from '../components/ui.jsx';

const NumberField = ({ label, hint, value, suffix, onSave, busy }) => {
  const [v, setV] = useState(String(value ?? ''));
  React.useEffect(() => setV(String(value ?? '')), [value]);
  return (
    <Field label={label} hint={hint}>
      <div className="row" style={{ gap: 8 }}>
        <input className="input" value={v} inputMode="decimal" onChange={(e) => setV(e.target.value)} />
        {suffix && <span className="suffix">{suffix}</span>}
        <button className="btn btn-soft btn-sm" disabled={busy || String(value ?? '') === v} onClick={() => onSave(v)}>OK</button>
      </div>
    </Field>
  );
};

// Настоящий статус ИИ: не «включено/выключено», а кто отвечает, сколько бесплатных
// запросов осталось и что именно нужно добавить в .env, чтобы модель заработала.
function AiBrain({ onToast }) {
  const [st, setSt] = useState(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try { setSt(await api.aiStatus()); setError(''); } catch (err) { setError(err.message); }
  };
  useEffect(() => { load(); }, []);

  const test = async () => {
    setTesting(true);
    try {
      const res = await api.aiTest();
      onToast({ tone: 'success', title: `Модель ответила: ${res.provider}`, text: `${res.model} · ${res.ms} мс` });
      load();
    } catch (err) {
      onToast({ tone: 'error', title: 'ИИ не ответил', text: err.message });
    } finally { setTesting(false); }
  };

  const providers = st?.providers || [];
  const ready = providers.filter((p) => p.configured);
  const today = providers.reduce((a, p) => a + (p.callsToday || 0), 0);

  return (
    <div className="card pad-lg">
      <div className="card-head">
        <div>
          <h2>ИИ-движок</h2>
          <p>
            Pulse перебирает провайдеров по цепочке и берёт первый доступный: сначала бесплатные,
            платные — только если ключ есть. Один ключ уже включает ИИ везде: идеи, сценарии, описания,
            библия сериала и режиссура кадра.
          </p>
        </div>
        <Badge tone={st?.enabled ? 'success' : 'warn'} dot>
          {st?.enabled ? `включён · ${st.active}` : 'выключен'}
        </Badge>
      </div>

      {error && <div className="notice" style={{ marginBottom: 12 }}><Icon name="alert" size={14} /><span>{error}</span></div>}

      <div className="grid-4" style={{ gap: 10, marginBottom: 12 }}>
        {[
          ['Готовы к работе', `${ready.length} / ${providers.length}`],
          ['Бесплатных', String(ready.filter((p) => p.free).length)],
          ['Запросов сегодня', String(today)],
          ['Кэш ответов', `${st?.cached ?? 0}`],
        ].map(([k, v]) => (
          <div key={k} className="mini-kv" style={{ margin: 0 }}>
            <div><span>{k}</span><b>{v}</b></div>
          </div>
        ))}
      </div>

      <div className="col" style={{ gap: 0 }}>
        {providers.map((p) => (
          <div key={p.id} className="row-between" style={{ padding: '9px 0', borderBottom: '1px solid var(--line)', gap: 12 }}>
            <div className="row" style={{ gap: 9, minWidth: 0 }}>
              <span style={{
                width: 7, height: 7, borderRadius: 9, flex: 'none',
                background: p.configured ? 'var(--green)' : p.free ? 'var(--violet-3)' : 'var(--muted)',
                boxShadow: p.active ? '0 0 9px var(--green)' : 'none',
              }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: p.configured ? 'var(--text)' : 'var(--text-2)' }}>{p.label}</div>
                <div className="mono truncate" style={{ fontSize: 10, color: 'var(--muted)' }}>{p.model || '—'}</div>
              </div>
            </div>
            <div className="row" style={{ gap: 6, flex: 'none' }}>
              {p.free && <Badge tone="accent">бесплатно</Badge>}
              {p.active && <Badge tone="success">активен</Badge>}
              {p.configured ? (
                <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>
                  {p.callsToday || 0}{p.rpd ? ` / ${p.rpd}` : ''} сегодня
                </span>
              ) : (
                <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>{p.keyEnv || 'локально'}</span>
              )}
            </div>
          </div>
        ))}
        {!providers.length && !error && <span className="muted" style={{ fontSize: 11.5 }}>Загружаем статус…</span>}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" onClick={test} disabled={testing}>
          <Icon name="sparkles" size={13} />{testing ? 'Проверяем ключ…' : 'Проверить ИИ живым запросом'}
        </button>
        <a className="btn btn-soft btn-sm" href="https://build.nvidia.com" target="_blank" rel="noreferrer">
          <Icon name="link" size={12} />Бесплатный ключ NVIDIA
        </a>
        <a className="btn btn-ghost btn-sm" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
          <Icon name="link" size={12} />Gemini
        </a>
        <a className="btn btn-ghost btn-sm" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
          <Icon name="link" size={12} />Groq
        </a>
      </div>

      <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 12, lineHeight: 1.6 }}>
        Цепочка: <span className="mono">ollama → nvidia → gemini → groq → cerebras → openrouter → mistral → openai</span>.
        Ключи задаются в <span className="mono">.env</span> (<span className="mono">NVIDIA_API_KEY</span>,{' '}
        <span className="mono">GEMINI_API_KEY</span>, …), включение — <span className="mono">PULSE_AI=on</span>.
        Совсем без ключей: <span className="mono">PULSE_OLLAMA=on</span> и своя Ollama на VPS — тоже бесплатно.
      </p>
    </div>
  );
}

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

      {/* ── Площадки и маркировка ─────────────────────────────────────────── */}
      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Площадки</div>
              <div className="card-sub">правила, которые Pulse соблюдает при публикации</div>
            </div>
            <Badge tone={String(settings.tiktok_audited) === '1' ? 'success' : 'warn'}>
              {String(settings.tiktok_audited) === '1' ? 'TikTok аудирован' : 'TikTok: приватно'}
            </Badge>
          </div>
          <Toggle
            checked={String(settings.tiktok_audited) === '1'}
            onChange={(v) => patch({ tiktok_audited: v ? 1 : 0 })}
            label="TikTok-клиент прошёл аудит"
            hint="Без аудита Direct Post разрешён только в приватные аккаунты (SELF_ONLY) и максимум на 5 креаторов в сутки — это ограничение площадки, а не Pulse."
          />
          <Toggle
            checked={String(settings.youtube_audited) === '1'}
            onChange={(v) => patch({ youtube_audited: v ? 1 : 0 })}
            label="Проект Google прошёл аудит"
            hint="Без аудита YouTube принимает только приватные загрузки. После проверки проекта включите — Shorts начнут выходить публично (вертикальное видео ≤ 3 минут)."
          />
          <Toggle
            checked={String(settings.series_autopublish ?? '1') === '1'}
            onChange={(v) => patch({ series_autopublish: v ? 1 : 0 })}
            label="Серии выходят по расписанию сами"
            hint="Собранная серия, поставленная в расписание, публикуется задачей в очереди — без вашего участия. Выключите, если хотите подтверждать каждый выпуск вручную."
          />
          <Toggle
            checked={String(settings.ai_label) === '1'}
            onChange={(v) => patch({ ai_label: v ? 1 : 0 })}
            label="Маркировать ИИ-контент"
            hint="В описании появится «Видео создано с помощью ИИ». На кадре уже стоит метка AI · PULSE."
          />
          <Toggle
            checked={String(settings.ad_label) === '1'}
            onChange={(v) => patch({ ad_label: v ? 1 : 0 })}
            label="Маркировать рекламу"
            hint="Пометка «Реклама: <продукт>» в описании, если у ролика есть продукт."
          />
          <Toggle
            checked={String(settings.ads_enabled ?? '1') === '1'}
            onChange={(v) => patch({ ads_enabled: v ? '1' : '0' })}
            label="Автораздача бренд-кампаний"
            hint="Pulse сам привязывает активные кампании к свободным роликам с учётом бюджета, дневного кэпа и дедлайна. Выключите, если размещаете интеграции только вручную."
          />
          <div className="hr" />
          <NumberField label="Минимальный вирусный скор" suffix="/100" value={settings.min_viral_score} busy={busy}
            hint="Ниже порога ролик не публикуется автоматически, а уходит на проверку с рекомендациями"
            onSave={(v) => patch({ min_viral_score: v })} />
          <div className="mini-kv tight" style={{ marginTop: 6 }}>
            <div><span>TikTok</span><b>15 постов / 24 ч · 6 init/мин</b></div>
            <div><span>Reels</span><b>50 API-постов / 24 ч</b></div>
            <div><span>Окно лимита</span><b>скользящее, 24 часа</b></div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Деньги</div>
              <div className="card-sub">ставки для расчёта дохода, расхода и ROI</div>
            </div>
            <Badge tone="accent">{settings.currency || '₽'}</Badge>
          </div>
          <div className="grid-2" style={{ gap: 12 }}>
            <NumberField label="RPM Reels" suffix={settings.currency} value={settings.rpm_reels} busy={busy}
              hint="доход за 1000 просмотров" onSave={(v) => patch({ rpm_reels: v })} />
            <NumberField label="RPM TikTok" suffix={settings.currency} value={settings.rpm_tiktok} busy={busy}
              hint="доход за 1000 просмотров" onSave={(v) => patch({ rpm_tiktok: v })} />
            <NumberField label="RPM Shorts" suffix={settings.currency} value={settings.rpm_youtube} busy={busy}
              hint="доход за 1000 просмотров Shorts (после монетизации канала)" onSave={(v) => patch({ rpm_youtube: v })} />
            <NumberField label="Цена продукта" suffix={settings.currency} value={settings.product_price} busy={busy}
              onSave={(v) => patch({ product_price: v })} />
            <NumberField label="Маржа" suffix="доля" value={settings.product_margin} busy={busy}
              hint="0.55 = 55% от цены остаётся вам" onSave={(v) => patch({ product_margin: v })} />
            <NumberField label="Конверсия клика" suffix="%" value={settings.conv_rate} busy={busy}
              onSave={(v) => patch({ conv_rate: v })} />
            <NumberField label="CTR (оценка)" suffix="%" value={settings.ctr_estimate} busy={busy}
              hint="для демо-симуляции кликов" onSave={(v) => patch({ ctr_estimate: v })} />
            <NumberField label="Генерация видео" suffix={settings.currency} value={settings.cost_video} busy={busy}
              onSave={(v) => patch({ cost_video: v })} />
            <NumberField label="Озвучка (TTS)" suffix={settings.currency} value={settings.cost_tts} busy={busy}
              onSave={(v) => patch({ cost_tts: v })} />
            <NumberField label="LLM" suffix={settings.currency} value={settings.cost_llm} busy={busy}
              onSave={(v) => patch({ cost_llm: v })} />
            <NumberField label="Рендер" suffix={settings.currency} value={settings.cost_render} busy={busy}
              onSave={(v) => patch({ cost_render: v })} />
          </div>
          <div className="hr" />
          <Field label="Ключ postback" hint="Необязательно. Если задан, POST /api/postback требует заголовок x-pulse-key или ?key=.">
            <input className="input" defaultValue={settings.postback_key || ''} placeholder="например, 32 случайных символа"
              onBlur={(e) => e.target.value !== (settings.postback_key || '') && patch({ postback_key: e.target.value })} />
          </Field>
        </div>
      </div>

      <div className="page-grid grid-4">
        <ProviderList title="Видео-генерация" items={providers.video} hint="Движок меняется адаптером: NVIDIA NIM, Runway, Luma, Pika, Replicate — без переделки конвейера." />
        <ProviderList title="Озвучка (TTS)" items={providers.tts} hint="Поддерживается мультиязычный синтез и клонирование голоса." />
        <ProviderList title="LLM" items={providers.llm} hint="Идеи, сценарии, описания. Полный статус и тест — в блоке «ИИ-движок» ниже." />
        <ProviderList title="Публикация" items={providers.publish} hint="Meta Graph API для Reels и TikTok Content Posting API. Токены — только в секретах." />
      </div>

      <AiBrain onToast={toast.push} />

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
bash deploy/tunnel.sh      # бесплатный https-адрес для Instagram
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
