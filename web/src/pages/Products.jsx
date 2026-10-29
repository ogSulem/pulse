import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon from '../components/Icons.jsx';
import { Badge, Field, Modal, Confirm, Empty, useToast } from '../components/ui.jsx';
import { PRODUCT_TEMPLATES, fmt } from '../lib/format.js';

const blank = { name: '', url: '', pitch: '', proof: '', template: 'review', utm_source: 'reels', utm_medium: 'short', utm_campaign: '', active: true, placement: 'both', always: false };

const PLACEMENTS = [
  { id: 'both', label: 'И в видео, и в описании' },
  { id: 'video', label: 'Только в видео' },
  { id: 'caption', label: 'Только в описании' },
];

const utmPreview = (p) => {
  try {
    const u = new URL(p.url || 'https://example.com');
    u.searchParams.set('utm_source', p.utm_source || 'reels');
    u.searchParams.set('utm_medium', p.utm_medium || 'short');
    u.searchParams.set('utm_campaign', p.utm_campaign || 'pulse');
    return u.toString();
  } catch {
    return p.url || 'https://…';
  }
};

export default function Products() {
  const { data, refresh } = useApp();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(false);

  const [clicks, setClicks] = useState(0);
  useEffect(() => {
    api.analytics({ days: 30 }).then((o) => setClicks(o.totals?.clicks || 0)).catch(() => {});
  }, [data.products]);

  const create = async () => {
    if (!form.name || !form.url) { toast.push({ tone: 'error', title: 'Нужны название и ссылка' }); return; }
    setBusy(true);
    try {
      await api.createProduct(form);
      toast.push({ tone: 'success', title: 'Продукт добавлен', text: 'Pulse подставит ссылку с UTM в сценарии и описания' });
      setCreating(false); setForm(blank); refresh();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    } finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.updateProduct(editing.id, editing);
      toast.push({ tone: 'success', title: 'Продукт обновлён' });
      setEditing(null); refresh();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <div className="card pad-lg" style={{ background: 'linear-gradient(120deg, rgba(124,58,237,.18), rgba(12,8,18,.2) 60%)', borderColor: 'rgba(167,139,250,.22)' }}>
        <div className="row-between wrap" style={{ gap: 18 }}>
          <div style={{ flex: '1 1 340px', minWidth: 260 }}>
            <Badge tone="accent" dot>монетизация</Badge>
            <h2 style={{ fontSize: 21, fontWeight: 780, letterSpacing: '-0.035em', marginTop: 10 }}>
              Продукт внутри каждого сценария
            </h2>
            <p className="dim" style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.6, maxWidth: 520 }}>
              Pulse не «вставляет рекламу»: он строит ролик вокруг вашего продукта по проверенному шаблону
              и добавляет ссылку с UTM в описание. Каждый клик виден в аналитике.
            </p>
          </div>
          <div className="row wrap" style={{ gap: 24 }}>
            <div className="hr-stat"><span className="v">{data.products.length}</span><span className="l">продукта</span></div>
            <div className="hr-stat"><span className="v">{fmt(clicks)}</span><span className="l">переходов</span></div>
            <button className="btn btn-primary" onClick={() => { setForm(blank); setCreating(true); }}>
              <Icon name="plus" size={15} />Добавить продукт
            </button>
          </div>
        </div>
      </div>

      <div className="page-grid grid-2">
        {data.products.map((p) => (
          <div className="card" key={p.id}>
            <div className="row-between" style={{ alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 7 }}>
                  <b style={{ fontSize: 15 }}>{p.name}</b>
                  <Badge tone={p.active ? 'success' : 'muted'} dot>{p.active ? 'в работе' : 'выключен'}</Badge>
                </div>
                <a href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                  {p.url.replace(/^https?:\/\//, '')} <Icon name="arrowUpRight" size={11} />
                </a>
              </div>
              <div className="row" style={{ gap: 3 }}>
                <button className="btn btn-ghost btn-icon" onClick={() => setEditing({ ...p })}><Icon name="edit" size={15} /></button>
                <button className="btn btn-ghost btn-icon" onClick={() => setConfirmDelete(p)}><Icon name="trash" size={15} /></button>
              </div>
            </div>

            <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.55 }}>
              {p.pitch || 'Добавьте короткое описание — оно попадёт в сценарий.'}
            </p>
            {p.proof && (
              <div className="notice" style={{ marginTop: 10 }}>
                <Icon name="check" size={14} style={{ color: 'var(--green)' }} />
                <span>{p.proof}</span>
              </div>
            )}

            <div className="row wrap" style={{ gap: 5, marginTop: 12 }}>
              <span className="chip plain active">{PLACEMENTS.find((x) => x.id === (p.placement || 'both'))?.label}</span>
              {p.always ? <span className="chip plain active"><Icon name="zap" size={11} style={{ verticalAlign: -1 }} /> в каждом ролике</span> : null}
              {PRODUCT_TEMPLATES.map((t) => (
                <span key={t.id} className={`chip plain ${p.template === t.id ? 'active' : ''}`}>{t.label}</span>
              ))}
            </div>

            <div className="divider" style={{ margin: '14px -18px' }} />
            <div style={{ fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600, marginBottom: 6 }}>ссылка для описания</div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--violet-3)', wordBreak: 'break-all', lineHeight: 1.6 }}>{utmPreview(p)}</div>

            <div className="row" style={{ gap: 8, marginTop: 14 }}>
              <button className="btn btn-soft btn-sm grow" onClick={() => setEditing({ ...p })}>
                <Icon name="wand" size={13} />Настроить шаблон
              </button>
              <button className={`btn btn-sm ${p.active ? '' : 'btn-primary'}`}
                onClick={async () => { await api.updateProduct(p.id, { active: !p.active }); refresh(); }}>
                {p.active ? 'Выключить' : 'Включить'}
              </button>
            </div>
          </div>
        ))}
        {!data.products.length && (
          <div className="card" style={{ gridColumn: 'span 2' }}>
            <Empty icon="package" title="Продукт не добавлен" text="Добавьте ссылку на сайт, сервис или товар — Pulse начнёт встраивать его в сценарии и описания."
              action={<button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={13} />Добавить продукт</button>} />
          </div>
        )}
      </div>

      <div className="card pad-lg">
        <div className="card-head">
          <div>
            <h2>Шаблоны интеграции</h2>
            <p>Один продукт — разные углы подачи. Pulse чередует их, чтобы лента не выглядела рекламной.</p>
          </div>
          <Badge tone="muted">5 шаблонов</Badge>
        </div>
        <div className="page-grid grid-3">
          {PRODUCT_TEMPLATES.map((t) => (
            <div key={t.id} className="card flat" style={{ padding: 14 }}>
              <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                <div className="kpi-icon"><Icon name={t.id === 'review' ? 'eye' : t.id === 'before-after' ? 'activity' : t.id === 'problem-solution' ? 'target' : t.id === 'case' ? 'chart' : 'flame'} size={14} /></div>
                <b style={{ fontSize: 12.5 }}>{t.label}</b>
              </div>
              <p style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.55 }}>{t.hint}</p>
            </div>
          ))}
        </div>
        <div className="notice accent" style={{ marginTop: 16 }}>
          <Icon name="shield" size={15} />
          <span>
            <b>Прозрачность важнее охвата.</b> Pulse не добавляет скрытых обещаний и не маскирует рекламу:
            в описании всегда есть ссылка и понятное указание на продукт. Это снижает риск жалоб и ограничений площадок.
          </span>
        </div>
      </div>

      <Modal open={creating} onClose={() => setCreating(false)} title="Новый продукт"
        subtitle="Ссылка и короткое описание — этого достаточно, чтобы начать продвижение."
        footer={<>
          <button className="btn btn-ghost" onClick={() => setCreating(false)}>Отмена</button>
          <button className="btn btn-primary" onClick={create} disabled={busy}>Добавить</button>
        </>}>
        <div className="form-grid">
          <Field label="Название" span><input className="input" autoFocus placeholder="Pulse Pro" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Ссылка" span><input className="input" placeholder="https://pulse.studio/pro" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></Field>
          <Field label="Оффер в одну строку" span hint="Что получает человек: «30 роликов в месяц без монтажёра»">
            <input className="input" value={form.pitch} onChange={(e) => setForm({ ...form, pitch: e.target.value })} />
          </Field>
          <Field label="Доказательство" span hint="Цифра, кейс или факт — повышает доверие">
            <input className="input" placeholder="18 000 роликов собрано за квартал" value={form.proof} onChange={(e) => setForm({ ...form, proof: e.target.value })} />
          </Field>
          <Field label="Шаблон">
            <select className="select" value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })}>
              {PRODUCT_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="UTM campaign">
            <input className="input" placeholder="pro-launch" value={form.utm_campaign} onChange={(e) => setForm({ ...form, utm_campaign: e.target.value })} />
          </Field>
          <Field label="UTM source">
            <input className="input" value={form.utm_source} onChange={(e) => setForm({ ...form, utm_source: e.target.value })} />
          </Field>
          <Field label="UTM medium">
            <input className="input" value={form.utm_medium} onChange={(e) => setForm({ ...form, utm_medium: e.target.value })} />
          </Field>
          <Field label="Где показывать" hint="Описание — мягко и безопасно для рекомендаций. Видео — прямая интеграция в сценарий">
            <select className="select" value={form.placement} onChange={(e) => setForm({ ...form, placement: e.target.value })}>
              {PLACEMENTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </Field>
          <label className="row" style={{ gap: 8, alignSelf: 'end', paddingBottom: 8, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={Boolean(form.always)} onChange={(e) => setForm({ ...form, always: e.target.checked })} />
            В каждом ролике (без «дозирования»)
          </label>
          <div className="span-2">
            <div className="notice"><Icon name="link" size={14} /><span className="mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>{utmPreview(form)}</span></div>
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`Настройки «${editing?.name || ''}»`}
        footer={<>
          <button className="btn btn-ghost" onClick={() => setEditing(null)}>Отмена</button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>Сохранить</button>
        </>}>
        {editing && (
          <div className="form-grid">
            <Field label="Название"><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Ссылка"><input className="input" value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })} /></Field>
            <Field label="Оффер" span><input className="input" value={editing.pitch || ''} onChange={(e) => setEditing({ ...editing, pitch: e.target.value })} /></Field>
            <Field label="Доказательство" span><input className="input" value={editing.proof || ''} onChange={(e) => setEditing({ ...editing, proof: e.target.value })} /></Field>
            <Field label="Шаблон" span>
              <select className="select" value={editing.template} onChange={(e) => setEditing({ ...editing, template: e.target.value })}>
                {PRODUCT_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="UTM source"><input className="input" value={editing.utm_source} onChange={(e) => setEditing({ ...editing, utm_source: e.target.value })} /></Field>
            <Field label="UTM campaign"><input className="input" value={editing.utm_campaign} onChange={(e) => setEditing({ ...editing, utm_campaign: e.target.value })} /></Field>
            <Field label="Где показывать" span>
              <select className="select" value={editing.placement || 'both'} onChange={(e) => setEditing({ ...editing, placement: e.target.value })}>
                {PLACEMENTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
            </Field>
            <label className="row" style={{ gap: 8, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={Boolean(editing.always)} onChange={(e) => setEditing({ ...editing, always: e.target.checked })} />
              Показывать в каждом ролике
            </label>
            <div className="span-2">
              <div className="notice"><Icon name="link" size={14} /><span className="mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>{utmPreview(editing)}</span></div>
            </div>
          </div>
        )}
      </Modal>

      <Confirm open={Boolean(confirmDelete)} onClose={() => setConfirmDelete(null)}
        title={`Удалить «${confirmDelete?.name || ''}»?`}
        text="Новые ролики перестанут ссылаться на продукт. Статистика кликов останется."
        onConfirm={async () => { await api.deleteProduct(confirmDelete.id); toast.push({ tone: 'info', title: 'Продукт удалён' }); refresh(); }} />
    </div>
  );
}
