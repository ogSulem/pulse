import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon from '../components/Icons.jsx';
import { Badge, Field, Modal, Toggle, ScoreRing, Empty, Segmented, Confirm, useToast } from '../components/ui.jsx';
import LaunchModal from '../components/LaunchModal.jsx';
import { FORMAT_LABELS, fmt } from '../lib/format.js';

const COLORS = [
  { id: 'violet', label: 'Фиолетовый', grad: 'linear-gradient(135deg,#8b5cf6,#4c1d95)' },
  { id: 'indigo', label: 'Индиго', grad: 'linear-gradient(135deg,#6366f1,#1e1b4b)' },
  { id: 'fuchsia', label: 'Фуксия', grad: 'linear-gradient(135deg,#d946ef,#4a044e)' },
  { id: 'cyan', label: 'Циан', grad: 'linear-gradient(135deg,#22d3ee,#164e63)' },
];

const blank = { name: '', niche: '', description: '', product_url: '', format: 'problem-solution', posts_per_day: 2, duration_sec: 32, ab_tests: true, autopilot: true, tone: 'friendly' };

export default function Projects() {
  const { data, refresh, refreshLight } = useApp();
  const toast = useToast();
  const [selected, setSelected] = useState(data.projects[0]?.id || null);
  const [ideas, setIdeas] = useState([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [launch, setLaunch] = useState(null);
  const [confirmArchive, setConfirmArchive] = useState(null);
  const [ideasLoading, setIdeasLoading] = useState(false);

  const project = useMemo(() => data.projects.find((p) => p.id === selected) || data.projects[0], [data.projects, selected]);

  useEffect(() => {
    if (!selected && data.projects[0]) setSelected(data.projects[0].id);
  }, [data.projects, selected]);

  const loadIdeas = async (projectId) => {
    if (!projectId) return;
    setIdeasLoading(true);
    try {
      setIdeas(await api.ideas({ projectId }));
    } finally {
      setIdeasLoading(false);
    }
  };

  useEffect(() => { loadIdeas(project?.id); }, [project?.id, data.pipeline]);

  const generate = async () => {
    setBusy(true);
    try {
      const res = await api.generateIdeas(project.id, 6);
      toast.push({
        tone: 'success',
        title: `+${res.created} новых тем`,
        text: res.source === 'ai'
          ? 'Идеи написала языковая модель под вашу нишу и площадку — оценка показывает прогноз вовлечения.'
          : 'Оценка показывает прогноз вовлечения — можно отправить в конвейер.',
      });
      loadIdeas(project.id);
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не удалось сгенерировать', text: err.message });
    } finally { setBusy(false); }
  };

  const toPipeline = async (idea) => {
    try {
      await api.ideaToPipeline(idea.id);
      toast.push({ tone: 'success', title: 'Тема в конвейере', text: 'Pulse соберёт сценарий и поставит ролик в ближайший слот.' });
      loadIdeas(project.id); refreshLight();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    }
  };

  const reject = async (idea) => {
    await api.rejectIdea(idea.id);
    loadIdeas(project.id);
  };

  const createProject = async () => {
    if (!form.name.trim()) { toast.push({ tone: 'error', title: 'Укажите название проекта' }); return; }
    setBusy(true);
    try {
      const res = await api.createProject({ ...form, niche: form.niche || form.name });
      toast.push({ tone: 'success', title: `Проект «${res.name}» создан`, text: `Предложено ${res.ideas.length} тем — выберите первые.` });
      setCreating(false);
      setForm(blank);
      await refresh();
      setSelected(res.id);
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    } finally { setBusy(false); }
  };

  const saveProject = async () => {
    setBusy(true);
    try {
      await api.updateProject(editing.id, editing);
      toast.push({ tone: 'success', title: 'Проект обновлён' });
      setEditing(null);
      refresh();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    } finally { setBusy(false); }
  };

  const toggleAutopilot = async (p) => {
    await api.updateProject(p.id, { autopilot: !p.autopilot });
    toast.push({ tone: 'info', title: `Автопилот проекта ${!p.autopilot ? 'включён' : 'выключен'}`, text: p.name });
    refresh();
  };

  return (
    <div className="page">
      <div className="page-grid grid-2-1">
        <div className="card pad-lg">
          <div className="card-head">
            <div>
              <h2>Проекты</h2>
              <p>Ниша, продукт и ритм публикаций. Один проект — один контент-канал.</p>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => { setForm(blank); setCreating(true); }}>
              <Icon name="plus" size={14} />Новый проект
            </button>
          </div>

          <div className="col" style={{ gap: 9 }}>
            {data.projects.map((p) => {
              const color = COLORS.find((c) => c.id === p.color) || COLORS[0];
              return (
                <div key={p.id} className={`card flat`} onClick={() => setSelected(p.id)}
                  style={{
                    padding: 14, cursor: 'pointer',
                    borderColor: project?.id === p.id ? 'rgba(167,139,250,.4)' : 'var(--line)',
                    background: project?.id === p.id ? 'rgba(139,92,246,.08)' : 'var(--surface)',
                  }}>
                  <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                    <span style={{ width: 34, height: 34, borderRadius: 11, background: color.grad, flex: 'none', display: 'grid', placeItems: 'center', fontWeight: 750, fontSize: 13, color: '#fff', border: '1px solid rgba(255,255,255,.16)' }}>
                      {p.name.slice(0, 2).toUpperCase()}
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="row" style={{ gap: 7 }}>
                        <b style={{ fontSize: 13.5 }}>{p.name}</b>
                        <Badge tone={p.autopilot ? 'success' : 'muted'} dot>{p.autopilot ? 'автопилот' : 'вручную'}</Badge>
                        <Badge tone="accent">A/B</Badge>
                      </div>
                      <div className="muted" style={{ fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>{p.niche}</div>
                      <div className="row wrap" style={{ gap: 12, marginTop: 8, fontSize: 10.5, color: 'var(--muted)' }}>
                        <span>{FORMAT_LABELS[p.format] || p.format}</span>
                        <span>{p.posts_per_day}/день</span>
                        <span>{p.duration_sec} с</span>
                        <span>{p.episodes} роликов</span>
                      </div>
                    </div>
                    <div className="row" style={{ gap: 4 }}>
                      <button className="btn btn-ghost btn-icon" title="Настройки" onClick={(e) => { e.stopPropagation(); setEditing({ ...p }); }}>
                        <Icon name="settings" size={15} />
                      </button>
                      <button className="btn btn-ghost btn-icon" title="В архив" onClick={(e) => { e.stopPropagation(); setConfirmArchive(p); }}>
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {!data.projects.length && (
              <Empty icon="sparkles" title="Нет проектов" text="Создайте проект: хватит названия и ниши, темы Pulse предложит сам."
                action={<button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={13} />Создать</button>} />
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-title"><h3>Двигатель проекта</h3><Icon name="activity" size={14} style={{ color: 'var(--muted)' }} /></div>
          {project ? (
            <div className="col" style={{ gap: 14 }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 650 }}>{project.name}</div>
                <div className="muted" style={{ fontSize: 11, marginTop: 3, lineHeight: 1.5 }}>{project.description || project.niche}</div>
              </div>
              <div className="form-grid" style={{ gap: 10 }}>
                <div className="field">
                  <span className="field-label">Постов в день</span>
                  <input className="input" type="number" min="1" max="8" value={project.posts_per_day}
                    onChange={async (e) => { await api.updateProject(project.id, { posts_per_day: Number(e.target.value) }); refresh(); }} />
                </div>
                <div className="field">
                  <span className="field-label">Длительность</span>
                  <select className="select" value={project.duration_sec}
                    onChange={async (e) => { await api.updateProject(project.id, { duration_sec: Number(e.target.value) }); refresh(); }}>
                    {[15, 22, 32, 45, 60].map((d) => <option key={d} value={d}>{d} секунд</option>)}
                  </select>
                </div>
              </div>
              <Toggle label="Автопилот проекта" hint="Сам наполняет очередь и публикует по слотам" checked={project.autopilot} onChange={() => toggleAutopilot(project)} />
              <Toggle label="A/B-тесты" hint="Две обложки/описания на один ролик" checked={project.ab_tests}
                onChange={async (v) => { await api.updateProject(project.id, { ab_tests: v }); refresh(); }} />
              <div className="divider" style={{ margin: '4px -18px' }} />
              <button className="btn btn-primary btn-block" onClick={() => setLaunch(project.id)}>
                <Icon name="zap" size={14} />Запустить конвейер проекта
              </button>
              <div className="notice">
                <Icon name="info" size={14} />
                <span>Все параметры влияют только на новые ролики. Уже стоящие в расписании остаются как есть.</span>
              </div>
            </div>
          ) : <Empty icon="layers" title="Выберите проект" />}
        </div>
      </div>

      <div className="card pad-lg">
        <div className="card-head">
          <div>
            <h2>Библиотека тем {project ? `· ${project.name}` : ''}</h2>
            <p>Оценка — прогноз вовлечённости на основе истории проекта. Отправьте тему в конвейер одним кликом.</p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={generate} disabled={busy || !project}>
              <Icon name="sparkles" size={13} className={busy ? 'spin' : ''} />{busy ? 'Генерируем…' : 'Ещё 6 тем'}
            </button>
            <LaunchModal open={Boolean(launch)} projectId={launch} onClose={() => setLaunch(null)} onDone={() => { refresh(); refreshLight(); }} />
          </div>
        </div>

        <div className="page-grid grid-3">
          {ideasLoading && !ideas.length && [0, 1, 2].map((i) => <div className="skeleton" key={i} style={{ height: 150 }} />)}
          {ideas.map((idea) => (
            <div key={idea.id} className="card flat hoverable" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
              <div className="row-between" style={{ alignItems: 'flex-start' }}>
                <div className="row" style={{ gap: 9, minWidth: 0 }}>
                  <ScoreRing value={idea.score} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 650, lineHeight: 1.35 }} className="clamp-2">{idea.title}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3 }}>{FORMAT_LABELS[idea.format] || idea.format}</div>
                  </div>
                </div>
                {idea.status === 'used'
                  ? <Badge tone="success">использована</Badge>
                  : idea.source === 'ai' ? <Badge tone="accent">ИИ</Badge> : null}
              </div>
              <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>«{idea.hook}»</p>
              <div className="row wrap" style={{ gap: 4 }}>
                {(idea.tags || []).slice(0, 3).map((t) => <span className="hashtag" key={t}>#{t}</span>)}
              </div>
              <div className="row" style={{ gap: 6, marginTop: 'auto' }}>
                <button className="btn btn-soft btn-sm grow" onClick={() => toPipeline(idea)}><Icon name="zap" size={12} />В конвейер</button>
                <button className="btn btn-ghost btn-icon" title="Убрать" onClick={() => reject(idea)}><Icon name="x" size={14} /></button>
              </div>
            </div>
          ))}
          {!ideasLoading && !ideas.length && (
            <div style={{ gridColumn: 'span 3' }}>
              <Empty icon="sparkles" title="Тем пока нет" text="Нажмите «Ещё 6 тем» — ИИ предложит идеи под нишу проекта (без ключа работает встроенный Content Brain)."
                action={<button className="btn btn-primary btn-sm" onClick={generate}><Icon name="sparkles" size={13} />Сгенерировать темы</button>} />
            </div>
          )}
        </div>
      </div>

      {/* create */}
      <Modal open={creating} onClose={() => setCreating(false)} wide
        title="Новый проект"
        subtitle="Достаточно названия и ниши. Остальное можно настроить позже — Pulse сразу предложит первые темы."
        footer={<>
          <button className="btn btn-ghost" onClick={() => setCreating(false)}>Отмена</button>
          <button className="btn btn-primary" onClick={createProject} disabled={busy}>{busy ? 'Создаём…' : 'Создать проект'}</button>
        </>}>
        <div className="form-grid">
          <Field label="Название проекта / канала" span>
            <input className="input" autoFocus placeholder="Например, Momentum" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Ниша или тема" span hint="Опишите свободно: «фитнес дома», «SaaS для дизайнеров», «психология привычек»">
            <input className="input" placeholder="фитнес и тренировки дома" value={form.niche} onChange={(e) => setForm({ ...form, niche: e.target.value })} />
          </Field>
          <Field label="Что продвигаем" span hint="Ссылка подставится в описания с UTM-метками">
            <input className="input" placeholder="https://product.ru" value={form.product_url} onChange={(e) => setForm({ ...form, product_url: e.target.value })} />
          </Field>
          <Field label="Описание аудитории" span>
            <textarea className="textarea" style={{ minHeight: 66 }} placeholder="Кто эти люди, что у них болит, какой результат нужен"
              value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="Базовый формат">
            <select className="select" value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
              {Object.entries(FORMAT_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </Field>
          <Field label="Постов в день">
            <select className="select" value={form.posts_per_day} onChange={(e) => setForm({ ...form, posts_per_day: Number(e.target.value) })}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} в день</option>)}
            </select>
          </Field>
          <div className="span-2">
            <Toggle label="A/B-тесты включены" hint="Разные обложки и описания для одного ролика" checked={form.ab_tests} onChange={(v) => setForm({ ...form, ab_tests: v })} />
            <Toggle label="Автопилот включён" hint="Наполнять очередь и публиковать без подтверждения" checked={form.autopilot} onChange={(v) => setForm({ ...form, autopilot: v })} />
          </div>
        </div>
      </Modal>

      {/* edit */}
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} wide title="Настройки проекта" subtitle={editing?.name}
        footer={<>
          <button className="btn btn-ghost" onClick={() => setEditing(null)}>Отмена</button>
          <button className="btn btn-primary" onClick={saveProject} disabled={busy}>Сохранить</button>
        </>}>
        {editing && (
          <div className="form-grid">
            <Field label="Название"><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Ниша"><input className="input" value={editing.niche} onChange={(e) => setEditing({ ...editing, niche: e.target.value })} /></Field>
            <Field label="Ссылка на продукт" span><input className="input" value={editing.product_url || ''} onChange={(e) => setEditing({ ...editing, product_url: e.target.value })} /></Field>
            <Field label="Формат">
              <select className="select" value={editing.format} onChange={(e) => setEditing({ ...editing, format: e.target.value })}>
                {Object.entries(FORMAT_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </Field>
            <Field label="Постов в день">
              <select className="select" value={editing.posts_per_day} onChange={(e) => setEditing({ ...editing, posts_per_day: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <Field label="Цвет проекта" span>
              <div className="row" style={{ gap: 8 }}>
                {COLORS.map((c) => (
                  <button key={c.id} onClick={() => setEditing({ ...editing, color: c.id })}
                    style={{ width: 34, height: 34, borderRadius: 11, background: c.grad, border: editing.color === c.id ? '2px solid #fff' : '1px solid var(--line)', cursor: 'pointer' }} />
                ))}
              </div>
            </Field>
            <div className="span-2">
              <Toggle label="Автопилот" checked={editing.autopilot} onChange={(v) => setEditing({ ...editing, autopilot: v })} />
              <Toggle label="A/B-тесты" checked={editing.ab_tests} onChange={(v) => setEditing({ ...editing, ab_tests: v })} />
            </div>
          </div>
        )}
      </Modal>

      <Confirm open={Boolean(confirmArchive)} onClose={() => setConfirmArchive(null)}
        title={`Архивировать «${confirmArchive?.name || ''}»?`}
        text="Проект исчезнет из списка, но история и статистика сохранятся в базе."
        confirmLabel="В архив"
        onConfirm={async () => { await api.archiveProject(confirmArchive.id); toast.push({ tone: 'info', title: 'Проект в архиве' }); refresh(); }} />
    </div>
  );
}
