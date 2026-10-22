import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon, { PlatformIcon } from '../components/Icons.jsx';
import { Badge, Field, Modal, Confirm, Empty, useToast } from '../components/ui.jsx';
import { ACCOUNT_STATUS, fmt, platformLabel } from '../lib/format.js';

const STATUS_OPTIONS = [
  { id: 'healthy', label: 'Активен' },
  { id: 'warmup', label: 'Прогрев' },
  { id: 'cooldown', label: 'Охлаждение' },
  { id: 'blocked', label: 'Блокировка' },
];

const blank = { platform: 'reels', handle: '', display_name: '', daily_limit: 3, min_gap_min: 90, window_start: '09:00', window_end: '23:00', status: 'warmup', project_id: '' };

export default function Accounts() {
  const { data, refresh, refreshLight } = useApp();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(null);
  const [tokenForm, setTokenForm] = useState({ token: '', externalId: '' });

  const accounts = data.accounts || [];
  const projects = data.projects || [];
  const projectName = (id) => projects.find((p) => p.id === id)?.name || null;
  const totalCap = accounts.filter((a) => a.status !== 'blocked').reduce((a, x) => a + x.cap, 0);
  const totalUsed = accounts.reduce((a, x) => a + x.used_today, 0);
  const healthy = accounts.filter((a) => a.status === 'healthy').length;

  const setStatus = async (account, status) => {
    try {
      await api.updateAccount(account.id, { status });
      toast.push({
        tone: status === 'blocked' ? 'error' : 'success',
        title: `@${account.handle} → ${ACCOUNT_STATUS[status].label}`,
        text: status === 'blocked' ? 'Нагрузка перераспределена на свободные аккаунты' : 'Правила планировщика обновлены',
      });
      refresh(); refreshLight();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    }
  };

  const saveEdit = async () => {
    setBusy(true);
    try {
      await api.updateAccount(editing.id, editing);
      toast.push({ tone: 'success', title: 'Аккаунт обновлён' });
      setEditing(null);
      refresh();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    } finally { setBusy(false); }
  };

  const create = async () => {
    if (!form.handle.trim()) { toast.push({ tone: 'error', title: 'Укажите @handle' }); return; }
    setBusy(true);
    try {
      await api.createAccount(form);
      toast.push({ tone: 'success', title: 'Аккаунт добавлен', text: 'Пока в режиме прогрева: 1 публикация в день' });
      setCreating(false);
      setForm(blank);
      refresh();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    } finally { setBusy(false); }
  };

  const openConnect = (account) => {
    setConnecting(account);
    setTokenForm({ token: '', externalId: account.external_id || '' });
  };

  const connect = async () => {
    if (!tokenForm.token.trim()) { toast.push({ tone: 'error', title: 'Вставьте access token' }); return; }
    setBusy(true);
    try {
      await api.connectAccount(connecting.id, tokenForm);
      toast.push({ tone: 'success', title: `@${connecting.handle} подключён`, text: 'Токен зашифрован и хранится только на сервере' });
      setConnecting(null);
      refresh(); refreshLight();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не подключено', text: err.message });
    } finally { setBusy(false); }
  };

  const disconnect = async (account) => {
    try {
      await api.disconnectAccount(account.id);
      toast.push({ tone: 'info', title: `@${account.handle} отключён` });
      refresh();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    }
  };

  return (
    <div className="page">
      <div className="page-grid grid-4">
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Аккаунты</span><span className="kpi-icon"><Icon name="at" size={14} /></span></div>
          <div className="kpi-value">{accounts.length}</div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{healthy} активны</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Слоты сегодня</span><span className="kpi-icon"><Icon name="calendar" size={14} /></span></div>
          <div className="kpi-value">{totalUsed}<small>/ {totalCap}</small></div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>с учётом прогрева</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Средний интервал</span><span className="kpi-icon"><Icon name="clock" size={14} /></span></div>
          <div className="kpi-value">{Math.round(accounts.reduce((a, x) => a + x.min_gap_min, 0) / Math.max(1, accounts.length))}<small>мин</small></div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>между публикациями</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Добавить аккаунт</span><span className="kpi-icon"><Icon name="plus" size={14} /></span></div>
          <button className="btn btn-soft btn-block" style={{ marginTop: 6 }} onClick={() => setCreating(true)}><Icon name="plus" size={13} />Новый аккаунт</button>
          <div className="kpi-foot"><span style={{ fontSize: 10.5, color: 'var(--muted)' }}>резервный аккаунт = страховка от блокировки</span></div>
        </div>
      </div>

      <div className="page-grid grid-2">
        {accounts.map((a) => {
          const st = ACCOUNT_STATUS[a.status] || ACCOUNT_STATUS.healthy;
          const pct = a.cap ? Math.min(100, Math.round((a.used_today / a.cap) * 100)) : 0;
          return (
            <div className="card" key={a.id}>
              <div className="row-between" style={{ alignItems: 'flex-start', marginBottom: 12 }}>
                <div className="row" style={{ gap: 11, minWidth: 0 }}>
                  <span style={{ width: 40, height: 40, borderRadius: 12, background: `hsl(${a.avatar_hue} 70% 32%)`, display: 'grid', placeItems: 'center', flex: 'none', border: '1px solid rgba(255,255,255,.18)' }}>
                    <PlatformIcon platform={a.platform} size={18} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <b style={{ fontSize: 13.5 }}>@{a.handle}</b>
                      <Badge tone={st.tone} dot>{st.label}</Badge>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      {platformLabel(a.platform)} · {a.display_name} · качество {a.quality}
                      {a.project_id ? ` · ${projectName(a.project_id) || 'бренд'}` : ' · универсальный'}
                    </div>
                    <div className="row" style={{ gap: 6, marginTop: 5 }}>
                      <Badge tone={a.connected ? 'success' : 'muted'} dot>{a.connected ? 'API подключён' : 'без токена'}</Badge>
                      {a.connected && a.external_id ? <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>id {a.external_id}</span> : null}
                    </div>
                  </div>
                </div>
                <div className="row" style={{ gap: 3 }}>
                  <button className="btn btn-ghost btn-icon" title="Настроить" onClick={() => setEditing({ ...a })}><Icon name="settings" size={15} /></button>
                  <button className="btn btn-ghost btn-icon" title="Удалить" onClick={() => setConfirmDelete(a)}><Icon name="trash" size={15} /></button>
                </div>
              </div>

              <div className="row-between" style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 5 }}>
                <span>Квота на сегодня</span>
                <span><b style={{ color: 'var(--text)' }}>{a.used_today}</b> / {a.cap}</span>
              </div>
              <div className={`quota ${pct >= 100 ? 'full' : pct >= 70 ? 'high' : ''}`}>
                <div className="quota-bar"><i style={{ width: `${Math.max(3, pct)}%` }} /></div>
                <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{pct}%</span>
              </div>

              <div className="row wrap" style={{ gap: 7, marginTop: 14 }}>
                <button className="btn btn-soft btn-sm" onClick={() => openConnect(a)}>
                  <Icon name="link" size={12} />{a.connected ? 'Заменить токен' : 'Подключить API'}
                </button>
                {a.connected && (
                  <button className="btn btn-ghost btn-sm" onClick={() => disconnect(a)}><Icon name="logout" size={12} />Отключить</button>
                )}
              </div>

              <div className="row wrap" style={{ gap: 7, marginTop: 12 }}>
                {STATUS_OPTIONS.map((s) => (
                  <button key={s.id} className={`chip ${a.status === s.id ? 'active' : ''}`} onClick={() => a.status !== s.id && setStatus(a, s.id)}>
                    {s.label}
                  </button>
                ))}
              </div>

              <div className="row wrap" style={{ gap: 16, marginTop: 14, fontSize: 10.5, color: 'var(--muted)' }}>
                <span><Icon name="clock" size={11} style={{ verticalAlign: -1 }} /> интервал {a.min_gap_min} мин</span>
                <span><Icon name="calendar" size={11} style={{ verticalAlign: -1 }} /> окно {a.window_start}–{a.window_end}</span>
                <span><Icon name="target" size={11} style={{ verticalAlign: -1 }} /> лимит {a.daily_limit}/день</span>
              </div>
            </div>
          );
        })}
        {!accounts.length && (
          <div className="card" style={{ gridColumn: 'span 2' }}>
            <Empty icon="at" title="Нет подключённых аккаунтов" text="Добавьте хотя бы один аккаунт Reels и один TikTok — Pulse распределит нагрузку между ними."
              action={<button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={13} />Добавить</button>} />
          </div>
        )}
      </div>

      <div className="card pad-lg">
        <div className="card-head">
          <div>
            <h2>Как Pulse защищает аккаунты</h2>
            <p>Без «трюков»: только лимиты, распределение и резервы</p>
          </div>
          <Badge tone="accent">anti-block архитектура</Badge>
        </div>
        <div className="page-grid grid-4">
          {[
            { icon: 'layers', title: 'Распределение', text: 'Публикация уходит на аккаунт с наибольшим остатком квоты и лучшим качеством. Один аккаунт не перегружается.' },
            { icon: 'clock', title: 'Интервалы', text: 'Между постами одного аккаунта — не меньше настроенного gap. Слоты двигаются с джиттером, без «ровных» секунд.' },
            { icon: 'shield', title: 'Лимиты платформ', text: 'Дневные квоты, прогрев новых аккаунтов (1 пост в день), паузы при ошибках и 429 от API.' },
            { icon: 'user', title: 'Резерв и ручная проверка', text: 'Резервные аккаунты, быстрый перевод в cooldown/blocked и подтверждение спорных роликов вручную.' },
          ].map((c) => (
            <div key={c.title} className="card flat" style={{ padding: 14 }}>
              <div className="kpi-icon" style={{ marginBottom: 9 }}><Icon name={c.icon} size={14} /></div>
              <div style={{ fontSize: 12.5, fontWeight: 650, marginBottom: 5 }}>{c.title}</div>
              <p style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.55 }}>{c.text}</p>
            </div>
          ))}
        </div>
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Новый аккаунт"
        subtitle="Токены доступа хранятся в секретах (Vault / env) и используются только при публикации."
        footer={<>
          <button className="btn btn-ghost" onClick={() => setCreating(false)}>Отмена</button>
          <button className="btn btn-primary" onClick={create} disabled={busy}>Добавить</button>
        </>}>
        <div className="form-grid">
          <Field label="Площадка">
            <select className="select" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
              <option value="reels">Instagram Reels</option>
              <option value="tiktok">TikTok</option>
              <option value="youtube">YouTube Shorts</option>
            </select>
          </Field>
          <Field label="Бренд / проект" hint="Аккаунт получает ролики только своего проекта. «Универсальный» — любой проект">
            <select className="select" value={form.project_id || ''} onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
              <option value="">Универсальный</option>
              {projects.filter((p) => !p.archived).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="@handle">
            <input className="input" placeholder="pulse.studio" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} />
          </Field>
          <Field label="Отображаемое имя" span>
            <input className="input" placeholder="Pulse Studio" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
          </Field>
          <Field label="Лимит в день">
            <input className="input" type="number" min="1" max="10" value={form.daily_limit} onChange={(e) => setForm({ ...form, daily_limit: Number(e.target.value) })} />
          </Field>
          <Field label="Мин. интервал, мин">
            <input className="input" type="number" min="15" max="720" value={form.min_gap_min} onChange={(e) => setForm({ ...form, min_gap_min: Number(e.target.value) })} />
          </Field>
          <Field label="Начало окна">
            <input className="input" type="time" value={form.window_start} onChange={(e) => setForm({ ...form, window_start: e.target.value })} />
          </Field>
          <Field label="Конец окна">
            <input className="input" type="time" value={form.window_end} onChange={(e) => setForm({ ...form, window_end: e.target.value })} />
          </Field>
          <div className="span-2">
            <div className="notice"><Icon name="info" size={14} /><span>Новый аккаунт стартует в режиме прогрева: 1 публикация в день и увеличенный интервал.</span></div>
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(connecting)} onClose={() => setConnecting(null)} title={`Подключить @${connecting?.handle || ''}`}
        subtitle={connecting?.platform === 'tiktok' ? 'TikTok Content Posting API' : connecting?.platform === 'youtube' ? 'YouTube Data API v3 (Shorts)' : 'Instagram Graph API (Reels)'}
        footer={<>
          <button className="btn" onClick={() => setConnecting(null)}>Отмена</button>
          <button className="btn btn-primary" disabled={busy} onClick={connect}><Icon name="check" size={14} />Подключить</button>
        </>}>
        <div className="col" style={{ gap: 14 }}>
          <div className="notice">
            <Icon name="shield" size={15} />
            <span>
              Токен шифруется AES-256-GCM прямо на сервере и никогда не отдаётся во фронтенд.
              Права: {connecting?.platform === 'tiktok' ? 'video.publish, video.upload'
                : connecting?.platform === 'youtube' ? 'youtube.upload, youtube.readonly'
                : 'instagram_content_publish, instagram_manage_insights'}.
            </span>
          </div>
          <Field label="Access token" hint="Долгоживущий токен из кабинета разработчика площадки">
            <input className="input" type="password" value={tokenForm.token} autoComplete="off"
              onChange={(e) => setTokenForm({ ...tokenForm, token: e.target.value })} placeholder="вставьте токен" />
          </Field>
          <Field label={connecting?.platform === 'tiktok' ? 'Open ID (необязательно)' : connecting?.platform === 'youtube' ? 'Channel ID (необязательно)' : 'Instagram user id'}
            hint={connecting?.platform === 'youtube' ? 'Можно оставить пустым: канал определится по токену, подписчики подтянутся из API' : 'Для Instagram обязателен: по нему идут media и insights'}>
            <input className="input" value={tokenForm.externalId}
              onChange={(e) => setTokenForm({ ...tokenForm, externalId: e.target.value })} placeholder="например, 17841400000000000" />
          </Field>
          <div className="field-hint">
            {connecting?.platform === 'tiktok'
              ? 'Без аудита клиента TikTok публикует только в приватный аккаунт (SELF_ONLY) — Pulse выставит это автоматически.'
              : connecting?.platform === 'youtube'
                ? 'Без аудита проекта Google загрузки уходят приватно; после аудита включите публичность в настройках. Отдельного Shorts API нет — вертикальное видео ≤ 3 минут считается автоматически.'
                : 'Instagram забирает видео по публичному адресу: задайте PULSE_PUBLIC_URL в .env (например, https://pulse.example.com).'}
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`Настройки @${editing?.handle || ''}`}
        footer={<>
          <button className="btn btn-ghost" onClick={() => setEditing(null)}>Отмена</button>
          <button className="btn btn-primary" onClick={saveEdit} disabled={busy}>Сохранить</button>
        </>}>
        {editing && (
          <div className="form-grid">
            <Field label="Лимит в день">
              <input className="input" type="number" min="1" max="10" value={editing.daily_limit} onChange={(e) => setEditing({ ...editing, daily_limit: Number(e.target.value) })} />
            </Field>
            <Field label="Мин. интервал, мин">
              <input className="input" type="number" min="15" max="720" value={editing.min_gap_min} onChange={(e) => setEditing({ ...editing, min_gap_min: Number(e.target.value) })} />
            </Field>
            <Field label="Окно с">
              <input className="input" type="time" value={editing.window_start} onChange={(e) => setEditing({ ...editing, window_start: e.target.value })} />
            </Field>
            <Field label="Окно до">
              <input className="input" type="time" value={editing.window_end} onChange={(e) => setEditing({ ...editing, window_end: e.target.value })} />
            </Field>
            <Field label="Бренд / проект" span hint="Смена бренда перенаправит ролики другого проекта на другие аккаунты">
              <select className="select" value={editing.project_id || ''} onChange={(e) => setEditing({ ...editing, project_id: e.target.value })}>
                <option value="">Универсальный</option>
                {projects.filter((p) => !p.archived).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Качество аккаунта (влияет на приоритет)" span>
              <input type="range" min="0" max="100" value={editing.quality} onChange={(e) => setEditing({ ...editing, quality: Number(e.target.value) })} />
            </Field>
            <Field label="Заметки" span>
              <textarea className="textarea" style={{ minHeight: 70 }} value={editing.notes || ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>

      <Confirm open={Boolean(confirmDelete)} onClose={() => setConfirmDelete(null)}
        title={`Удалить @${confirmDelete?.handle || ''}?`}
        text="Аккаунт перестанет получать публикации. Статистика уже вышедших роликов сохранится."
        onConfirm={async () => { await api.deleteAccount(confirmDelete.id); toast.push({ tone: 'info', title: 'Аккаунт удалён' }); refresh(); }} />
    </div>
  );
}
