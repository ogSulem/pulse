import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import { Modal, Field, useToast } from './ui.jsx';
import Icon from './Icons.jsx';
import { FORMAT_LABELS } from '../lib/format.js';

export default function LaunchModal({ open, onClose, onDone, projectId: preset }) {
  const { data } = useApp();
  const toast = useToast();
  const [projectId, setProjectId] = useState(preset || '');
  const [count, setCount] = useState(3);
  const [startIn, setStartIn] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setProjectId(preset || data.projects[0]?.id || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preset]);

  const project = data.projects.find((p) => p.id === (projectId || preset));
  const chosenId = projectId || preset || project?.id;

  const run = async () => {
    if (!chosenId) { setError('Выберите проект'); return; }
    setBusy(true); setError('');
    try {
      const res = await api.runPipeline({ projectId: chosenId, count, startInMinutes: startIn });
      toast.push({ tone: 'success', title: `Конвейер запущен`, text: `${res.started} ${res.started === 1 ? 'ролик' : 'ролика'} в очереди. Первый выйдет примерно через ${startIn} мин.` });
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Запустить конвейер"
      subtitle="Pulse сам соберёт сценарии, озвучку, видеоряд и поставит ролики в расписание."
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
        <button className="btn btn-primary" onClick={run} disabled={busy || !chosenId}>
          <Icon name="zap" size={14} />{busy ? 'Запускаем…' : 'Запустить'}
        </button>
      </>}>
      <div className="col" style={{ gap: 16 }}>
        <Field label="Проект">
          <select className="select" value={chosenId || ''} onChange={(e) => setProjectId(e.target.value)}>
            <option value="" disabled>Выберите проект</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name} — {p.niche.slice(0, 42)}</option>
            ))}
          </select>
        </Field>

        {project && (
          <div className="notice accent">
            <Icon name="info" size={15} />
            <div>
              Формат: <b>{FORMAT_LABELS[project.format] || project.format}</b> · вертикаль {project.aspect} · ~{project.duration_sec} с ·
              {' '}{project.posts_per_day} {project.posts_per_day === 1 ? 'пост' : 'поста'} в день
              {data.products[0] ? <> · продукт <b>{data.products[0].name}</b></> : null}
            </div>
          </div>
        )}

        <Field label={`Сколько роликов подготовить${count ? `: ${count}` : ''}`} hint="Pulse распределит их по свободным слотам и аккаунтам">
          <input type="range" min="1" max="8" value={count} onChange={(e) => setCount(Number(e.target.value))} />
        </Field>

        <Field label="Первый ролик выйдет" hint="Дальше — по расписанию проекта, с паузами между публикациями">
          <select className="select" value={startIn} onChange={(e) => setStartIn(Number(e.target.value))}>
            <option value={1}>через 1 минуту (демо-быстро)</option>
            <option value={3}>через 3 минуты</option>
            <option value={30}>через 30 минут</option>
            <option value={120}>через 2 часа</option>
          </select>
        </Field>

        {error && <div className="notice warn"><Icon name="alert" size={15} /><span>{error}</span></div>}

        <div className="notice">
          <Icon name="shield" size={15} />
          <span>В demo-режиме генерация и постинг симулируются. В live-режиме используются ключи провайдеров из <code className="mono">.env</code>.</span>
        </div>
      </div>
    </Modal>
  );
}
