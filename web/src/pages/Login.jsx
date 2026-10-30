import React, { useState } from 'react';
import { api, setToken, storageBlocked } from '../lib/api.js';
import Icon, { Logo } from '../components/Icons.jsx';

export default function Login({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.login(password);
      setToken(res.token);
      onSuccess();
    } catch (err) {
      // Раньше любая сетевая ошибка показывалась как «Требуется вход», и на
      // телефоне это выглядело как «пароль не подходит». Теперь причина названа.
      setError(
        err.status === 401 ? 'Неверный пароль'
          : err.status === 429 ? 'Слишком много попыток — подождите минуту'
            : err.status ? `Сервер ответил ${err.status}. ${err.message || ''}`.trim()
              : 'Нет связи с сервером: проверьте адрес и интернет',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div style={{ width: 'min(400px, 100%)' }}>
        <div className="row" style={{ gap: 10, justifyContent: 'center', marginBottom: 26 }}>
          <Logo size={38} />
          <div>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.03em' }}>Pulse</div>
            <div style={{ fontSize: 10, letterSpacing: '0.18em', color: 'var(--muted)', textTransform: 'uppercase' }}>content engine</div>
          </div>
        </div>
        <form className="login-card" onSubmit={submit}>
          <h1>Вход в панель</h1>
          <p className="lead">
            Конвейер коротких видео: идеи, сценарии, рендер, публикации и аналитика — на одном экране.
          </p>
          <div className="pulse-line">
            <svg viewBox="0 0 340 40" preserveAspectRatio="none" fill="none">
              <defs>
                <linearGradient id="pl" x1="0" x2="340" y1="0" y2="0">
                  <stop stopColor="#7c3aed" stopOpacity="0.2" />
                  <stop offset="0.5" stopColor="#c4b5fd" />
                  <stop offset="1" stopColor="#7c3aed" stopOpacity="0.2" />
                </linearGradient>
              </defs>
              <path d="M0 24h60l10-14 12 26 12-34 12 30 10-8h34l8-10 10 22 10-30 12 26 10-8h130" stroke="url(#pl)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="field">
            <span className="field-label">Пароль доступа</span>
            <input
              className="input"
              type="password"
              autoFocus
              placeholder="••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && (
            <div className="notice warn" style={{ marginTop: 12 }}>
              <Icon name="alert" size={15} />
              <span>{error}</span>
            </div>
          )}
          <button className="btn btn-primary btn-block btn-lg" style={{ marginTop: 16 }} disabled={busy || !password}>
            {busy ? 'Проверяем…' : 'Войти'} <Icon name="arrowUpRight" size={15} />
          </button>
          <p className="field-hint" style={{ marginTop: 14, textAlign: 'center' }}>
            {storageBlocked()
              ? 'Браузер блокирует локальное хранилище — вход сохранится в cookie сессии.'
              : <>Пароль задаётся переменной <code className="mono">PULSE_PASSWORD</code> в <code className="mono">.env</code></>}
          </p>
        </form>
      </div>
    </div>
  );
}
