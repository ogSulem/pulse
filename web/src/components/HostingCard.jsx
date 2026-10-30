import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Icon from './Icons.jsx';
import { Badge, useToast } from './ui.jsx';

// Карточка «Хостинг» — из Студии переехала в Настройки.
//
// Причина переезда: это не ежедневный экран. Раньше она стояла рядом с
// «Запустить конвейер» и отвлекала тем, что почти всегда в порядке. Но когда
// что-то ломается (нет тома, забыт пароль, кончилось место), именно здесь
// написано, что делать — поэтому здесь, а не в документации.
const HOSTING_LABEL = { railway: 'Railway', render: 'Render', fly: 'Fly.io', koyeb: 'Koyeb', 'self-hosted': 'свой сервер' };

const formatMb = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${Math.round((n / 1024 ** 3) * 10) / 10} ГБ`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} МБ`;
  return `${Math.round(n / 1024)} КБ`;
};

export default function HostingCard() {
  const toast = useToast();
  const [deploy, setDeploy] = useState(null);
  const [storage, setStorage] = useState(null);
  const [pruning, setPruning] = useState(false);

  const load = () => {
    api.deployReady().then(setDeploy).catch(() => {});
    api.storage().then(setStorage).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  const prune = async () => {
    setPruning(true);
    try {
      const res = await api.storagePrune({ days: storage?.retentionDays || 14 });
      toast.push({
        tone: res.removed ? 'success' : 'info',
        title: res.removed ? `Убрано ${res.removed} файлов` : 'Убирать нечего',
        text: res.removed ? `Освободилось ${formatMb(res.freedBytes)}` : 'Все файлы моложе срока хранения',
      });
      load();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не удалось почистить', text: err.message });
    } finally { setPruning(false); }
  };

  return (
    <div className="card pad-lg">
      <div className="card-head">
        <div>
          <h2>Хостинг и диск</h2>
          <p>Том, пароль, публичный адрес, рендер и место под видео — с готовым действием для каждой проблемы</p>
        </div>
        <Badge tone={!deploy ? 'muted' : deploy.counts.error ? 'danger' : deploy.counts.warn ? 'warn' : 'success'} dot>
          {!deploy ? 'проверяем' : deploy.counts.error ? `${deploy.counts.error} блокер(ов)` : deploy.counts.warn ? `${deploy.counts.warn} замечаний` : 'всё в порядке'}
        </Badge>
      </div>

      {!deploy && <span className="muted" style={{ fontSize: 11.5 }}>Считаем состояние хостинга…</span>}

      {deploy && (
        <div className="page-grid grid-2" style={{ gap: 14 }}>
          <div className="col" style={{ gap: 9, fontSize: 12 }}>
            <div className="row-between">
              <span style={{ color: 'var(--muted)' }}>Платформа</span>
              <span>{HOSTING_LABEL[deploy.platform] || deploy.platform}{deploy.hosted ? '' : ' · локально'}</span>
            </div>
            <div className="row-between">
              <span style={{ color: 'var(--muted)' }}>Публичный адрес</span>
              {/* Если домен кириллический — показываем привычное написание, а
                  латиницу (punycode) оставляем в подсказке: именно она уходит в
                  конфиги, и человек должен видеть, что это одно и то же. */}
              <span
                className="mono"
                title={deploy.publicUrlUnicode && deploy.publicUrlUnicode !== deploy.publicUrlAscii ? `В конфигах: ${deploy.publicUrlAscii}` : deploy.publicUrl}
                style={{ fontSize: 10.5, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {deploy.publicUrlUnicode || deploy.publicUrl || '—'}
              </span>
            </div>
            {deploy.publicUrlUnicode && deploy.publicUrlUnicode !== deploy.publicUrlAscii && (
              <div style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.5, marginTop: -4 }}>
                в конфигах: <span className="mono">{deploy.publicUrlAscii}</span>
              </div>
            )}
            <div className="row-between">
              <span style={{ color: 'var(--muted)' }}>Каталог данных</span>
              <span className="mono" style={{ fontSize: 10.5 }}>{deploy.dataDir}</span>
            </div>
            <div className="row-between">
              <span style={{ color: 'var(--muted)' }}>Проверки</span>
              <span style={{ fontSize: 11.5 }}>
                <span style={{ color: 'var(--green)' }}>{deploy.counts.ok} ок</span>
                {' · '}
                <span style={{ color: 'var(--amber)' }}>{deploy.counts.warn} замечаний</span>
                {' · '}
                <span style={{ color: 'var(--red)' }}>{deploy.counts.error} блокеров</span>
              </span>
            </div>

            {storage && (
              <div style={{ marginTop: 4 }}>
                <div className="row-between" style={{ fontSize: 11.5 }}>
                  <span style={{ color: 'var(--muted)' }}>Медиа на диске</span>
                  <span>{formatMb(storage.bytes)}{storage.freeBytes ? ` · свободно ${Math.round((storage.freeBytes / 1024 ** 3) * 10) / 10} ГБ` : ''}</span>
                </div>
                <div style={{ height: 6, borderRadius: 99, background: 'rgba(255,255,255,.08)', marginTop: 6, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${storage.freeBytes ? Math.min(100, Math.round((storage.bytes / (storage.bytes + storage.freeBytes)) * 100)) : 40}%`,
                    background: 'linear-gradient(90deg,#7c3aed,#c4b5fd)',
                  }} />
                </div>
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <button className="btn btn-soft btn-sm" onClick={prune} disabled={pruning}>
                    <Icon name="trash" size={12} />{pruning ? 'Убираем…' : `Почистить старше ${storage.retentionDays} дн.`}
                  </button>
                  {storage.staleFiles > 0 && (
                    <span className="muted" style={{ fontSize: 10.5, alignSelf: 'center' }}>{storage.staleFiles} файлов на {formatMb(storage.staleBytes)}</span>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="col" style={{ gap: 8 }}>
            {deploy.checks.filter((c) => c.level !== 'ok').map((c) => (
              <div key={c.id} style={{ padding: '9px 11px', borderRadius: 11, border: `1px solid ${c.level === 'error' ? 'rgba(251,113,133,.35)' : 'rgba(251,191,36,.28)'}`, background: c.level === 'error' ? 'rgba(251,113,133,.07)' : 'rgba(251,191,36,.06)' }}>
                <div className="row" style={{ gap: 7, alignItems: 'flex-start' }}>
                  <Icon name={c.level === 'error' ? 'x' : 'alert'} size={12} style={{ marginTop: 2, color: c.level === 'error' ? 'var(--red)' : 'var(--amber)' }} />
                  <div>
                    <b style={{ fontSize: 11.5 }}>{c.title}</b>
                    <div style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.5, marginTop: 2 }}>{c.detail}</div>
                    {c.fix && <div className="mono" style={{ fontSize: 10, color: 'var(--violet-3)', marginTop: 4, wordBreak: 'break-word' }}>{c.fix}</div>}
                  </div>
                </div>
              </div>
            ))}
            {deploy.checks.every((c) => c.level === 'ok') && (
              <div style={{ fontSize: 11.5, color: 'var(--green)' }}>
                <Icon name="check" size={12} style={{ marginRight: 5 }} />Все проверки пройдены — хостинг настроен правильно.
              </div>
            )}
            {deploy.checks.some((c) => c.level === 'ok') && (
              <div style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.55, marginTop: 2 }}>
                <b style={{ color: 'var(--text-2)' }}>В порядке:</b>{' '}
                {deploy.checks.filter((c) => c.level === 'ok').map((c) => c.title.toLowerCase()).join(' · ')}
              </div>
            )}
            <a className="link-btn" style={{ fontSize: 10.5 }} href="https://github.com/ogSulem/pulse/blob/main/docs/RAILWAY.md" target="_blank" rel="noreferrer">
              инструкция по Railway <Icon name="arrowUpRight" size={10} />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
