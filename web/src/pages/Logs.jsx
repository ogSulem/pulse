import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon from '../components/Icons.jsx';
import { Badge, Empty } from '../components/ui.jsx';
import { relative, dateTime } from '../lib/format.js';

const LEVELS = [
  { id: 'all', label: 'Все' },
  { id: 'success', label: 'Успех' },
  { id: 'info', label: 'Инфо' },
  { id: 'warn', label: 'Внимание' },
  { id: 'error', label: 'Ошибки' },
];

const ICONS = { success: 'check', info: 'zap', warn: 'info', error: 'alert' };

export default function Logs() {
  const { data } = useApp();
  const [level, setLevel] = useState('all');
  const [query, setQuery] = useState('');
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const params = { limit: 200 };
    if (level !== 'all') params.level = level;
    api.logs(params).then((rows) => alive && setLogs(rows))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [level, data.pipeline]);

  const filtered = logs.filter((l) => {
    const q = query.trim().toLowerCase();
    return !q || `${l.message} ${l.actor} ${l.action}`.toLowerCase().includes(q);
  });

  const counts = logs.reduce((acc, l) => ({ ...acc, [l.level]: (acc[l.level] || 0) + 1 }), {});

  return (
    <div className="page">
      <div className="card">
        <div className="row-between wrap" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            {LEVELS.map((l) => (
              <button key={l.id} className={`chip ${level === l.id ? 'active' : ''}`} onClick={() => setLevel(l.id)}>
                {l.label}
                {l.id !== 'all' && counts[l.id] ? <span style={{ opacity: 0.6 }}>{counts[l.id]}</span> : null}
              </button>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            <Icon name="search" size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--muted)' }} />
            <input className="input" style={{ paddingLeft: 32, width: 240 }} placeholder="Поиск по журналу" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card pad-lg">
        <div className="card-head">
          <div>
            <h2>События конвейера</h2>
            <p>Аудит действий: кто, что и когда сделал. Хранится последние 2000 записей.</p>
          </div>
          <Badge tone="muted">{filtered.length} записей</Badge>
        </div>

        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr><th style={{ width: 140 }}>Когда</th><th style={{ width: 130 }}>Источник</th><th>Событие</th><th style={{ width: 190 }}>Действие</th></tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <div style={{ fontSize: 11.5, color: 'var(--text-2)' }}>{relative(l.ts)}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>{dateTime(l.ts)}</div>
                  </td>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      <span className={`feed-icon ${l.level}`} style={{ width: 20, height: 20 }}><Icon name={ICONS[l.level] || 'info'} size={11} /></span>
                      <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{l.actor}</span>
                    </span>
                  </td>
                  <td style={{ color: 'var(--text)' }}>{l.message}</td>
                  <td><span className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>{l.action}</span></td>
                </tr>
              ))}
              {!filtered.length && !loading && (
                <tr><td colSpan="4"><Empty icon="terminal" title="Ничего не найдено" text="Попробуйте другой фильтр или запрос." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && !logs.length && <div className="skeleton" style={{ height: 200 }} />}
      </div>

      <div className="page-grid grid-3">
        <div className="card">
          <div className="card-title"><h3>Что логируется</h3></div>
          <div className="col" style={{ gap: 8, fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
            <span>· каждый этап конвейера и смена статуса</span>
            <span>· ошибки провайдеров и retry-попытки очереди</span>
            <span>· ручные правки сценариев и расписания</span>
            <span>· изменения аккаунтов, квот и настроек</span>
            <span>· публикации, переносы слотов и блокировки</span>
          </div>
        </div>
        <div className="card">
          <div className="card-title"><h3>Уровни</h3></div>
          <div className="col" style={{ gap: 8 }}>
            {[
              ['success', 'Успешное завершение этапа'],
              ['info', 'Штатное действие движка'],
              ['warn', 'Перенос, риск, ограничение'],
              ['error', 'Сбой или блокировка'],
            ].map(([lv, text]) => (
              <div key={lv} className="row" style={{ gap: 8 }}>
                <Badge tone={lv === 'success' ? 'success' : lv === 'warn' ? 'warn' : lv === 'error' ? 'danger' : 'accent'} dot>{lv}</Badge>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{text}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-title"><h3>Экспорт</h3></div>
          <div className="col" style={{ gap: 8 }}>
            <a className="btn btn-sm btn-block" href={api.exportUrl('episodes')}><Icon name="download" size={13} />Ролики и статусы</a>
            <a className="btn btn-sm btn-block" href={api.exportUrl('analytics')}><Icon name="download" size={13} />Статистика</a>
            <a className="btn btn-sm btn-block" href={api.backupUrl()}><Icon name="database" size={13} />Полный бэкап (JSON)</a>
          </div>
        </div>
      </div>
    </div>
  );
}
