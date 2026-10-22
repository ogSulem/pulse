import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../App.jsx';
import Icon from '../components/Icons.jsx';
import { Badge, Field, Modal, Confirm, Empty, Progress, useToast } from '../components/ui.jsx';
import { fmt, money, pct, relative } from '../lib/format.js';

const MODELS = [
  { id: 'fixed', label: 'Фикс за ролик' },
  { id: 'cpm', label: 'За 1000 показов' },
  { id: 'cpa', label: 'За конверсию' },
  { id: 'barter', label: 'Бартер' },
];

const MODEL_HINT = {
  fixed: 'Бренд платит фиксированную сумму за каждый выход — ровно то, что чаще всего просят в директ.',
  cpm: 'Оплата за просмотры: сколько ролик набрал — столько и стоит. Хорошо для долгих интеграций.',
  cpa: 'Оплата за покупки. Конверсии приходят из postback платёжки или CPA-сети.',
  barter: 'Деньги не начисляются, но выходы, сроки и маркировка учитываются так же.',
};

const STATUS = {
  active: { label: 'активна', tone: 'success' },
  paused: { label: 'на паузе', tone: 'warn' },
  draft: { label: 'черновик', tone: 'muted' },
  done: { label: 'выполнена', tone: 'accent' },
};

const blank = {
  brandName: '', legalName: '', inn: '', name: '', model: 'fixed',
  budget: 120000, rate: 40000, postsTarget: 3, dailyCap: 1,
  startsAt: '', endsAt: '', erid: '', mention: '', hashtags: '', brief: '', projectId: '',
};

const localDate = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const daysLeft = (iso) => (iso ? Math.ceil((new Date(iso) - Date.now()) / 86400000) : null);

export default function Ads() {
  const { data, refresh } = useApp();
  const toast = useToast();
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(null);
  const [payAmount, setPayAmount] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = async () => {
    try {
      setOverview(await api.adsOverview());
    } catch {
      setOverview(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [data.pipeline?.published]);

  const totals = overview?.totals || {};
  const campaigns = overview?.campaigns || [];

  const openCreate = () => {
    setForm({ ...blank, endsAt: new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10) });
    setCreating(true);
  };

  const create = async () => {
    if (!form.brandName.trim() || !form.name.trim()) {
      toast.push({ tone: 'error', title: 'Нужны бренд и название кампании' });
      return;
    }
    setBusy(true);
    try {
      await api.createCampaign({
        ...form,
        budget: Number(form.budget) || 0,
        rate: Number(form.rate) || 0,
        postsTarget: Number(form.postsTarget) || 1,
        dailyCap: Number(form.dailyCap) || 1,
        hashtags: String(form.hashtags || '').split(/[\s,]+/).filter(Boolean),
        status: 'active',
        projectId: form.projectId || null,
      });
      toast.push({ tone: 'success', title: 'Кампания создана', text: 'Pulse начнёт привязывать её к роликам автоматически' });
      setCreating(false);
      setForm(blank);
      load();
      refresh();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Не получилось', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (campaign) => {
    const next = campaign.status === 'active' ? 'paused' : 'active';
    try {
      await api.updateCampaign(campaign.id, { status: next });
      toast.push({ tone: 'success', title: next === 'active' ? 'Кампания запущена' : 'Кампания на паузе' });
      load();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    }
  };

  const pay = async () => {
    const amount = Number(payAmount);
    if (!amount) { toast.push({ tone: 'error', title: 'Укажите сумму' }); return; }
    try {
      await api.payCampaign(paying.id, amount);
      toast.push({ tone: 'success', title: `Оплата ${money(amount)} по «${paying.name}» записана` });
      setPaying(null); setPayAmount('');
      load();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    }
  };

  const autofill = async () => {
    try {
      const res = await api.autofillCampaigns(6);
      toast.push({
        tone: res.filled.length ? 'success' : 'info',
        title: res.filled.length ? `Кампании разложены: ${res.filled.length}` : 'Свободных кампаний или роликов нет',
        text: res.filled.map((f) => f.name).join(', ') || undefined,
      });
      load();
    } catch (err) {
      toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
    }
  };

  const openDetail = async (campaign) => {
    setDetail({ ...campaign, loading: true });
    setDetailLoading(true);
    try {
      const full = await api.campaign(campaign.id);
      setDetail(full);
    } catch {
      setDetail(campaign);
    } finally {
      setDetailLoading(false);
    }
  };

  const projects = data.projects || [];
  const deliveryRows = useMemo(() => {
    if (!detail?.posts) return [];
    return detail.posts.slice(0, 12);
  }, [detail]);

  return (
    <div className="page">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="card pad-lg" style={{ background: 'linear-gradient(125deg, rgba(124,58,237,.2), rgba(12,8,18,.25) 55%)', borderColor: 'rgba(167,139,250,.24)' }}>
        <div className="row-between wrap" style={{ gap: 18 }}>
          <div style={{ flex: '1 1 380px', minWidth: 260 }}>
            <Badge tone="accent" dot>бренд-кампании</Badge>
            <h2 style={{ fontSize: 22, fontWeight: 790, letterSpacing: '-0.035em', marginTop: 10 }}>
              Реклама, которая платит
            </h2>
            <p className="dim" style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.6, maxWidth: 560 }}>
              Кампании живут в системе: бюджет, модель оплаты, сроки, обязательный @бренд и erid-маркировка.
              Pulse сам привязывает интеграции к подходящим роликам, подставляет пометку «Реклама»
              и считает, сколько бренд уже должен.
            </p>
            <div className="row wrap" style={{ gap: 8, marginTop: 14 }}>
              <button className="btn btn-primary" onClick={openCreate}><Icon name="plus" size={15} />Новая кампания</button>
              <button className="btn btn-ghost" onClick={autofill}><Icon name="zap" size={14} />Разложить по роликам</button>
            </div>
          </div>
          <div className="row wrap" style={{ gap: 26 }}>
            <div className="hr-stat"><span className="v">{money(totals.revenue || 0)}</span><span className="l">заработано на рекламе</span></div>
            <div className="hr-stat"><span className="v">{money(totals.receivable || 0)}</span><span className="l">дебиторка</span></div>
            <div className="hr-stat"><span className="v">{totals.active || 0}</span><span className="l">активных кампаний</span></div>
          </div>
        </div>
      </div>

      {/* ── Риски маркировки ─────────────────────────────────────────────── */}
      {(overview?.risks || []).length > 0 && (
        <div className="card" style={{ borderColor: 'rgba(244,63,94,.35)', background: 'rgba(244,63,94,.06)' }}>
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <Icon name="alert" size={16} style={{ color: 'var(--red)', marginTop: 2 }} />
            <div>
              <b style={{ fontSize: 12.5 }}>Маркировка неполная — публикации остановятся</b>
              <div className="col" style={{ gap: 4, marginTop: 6 }}>
                {overview.risks.map((r) => {
                  const c = campaigns.find((x) => x.id === r.campaignId);
                  return (
                    <button key={r.campaignId} className="link-btn" style={{ justifyContent: 'flex-start', fontSize: 11.5 }}
                      onClick={() => c && openDetail(c)}>
                      {r.name} — {r.text}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── KPI ──────────────────────────────────────────────────────────── */}
      <div className="page-grid grid-4">
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Средний CPM</span><span className="kpi-icon"><Icon name="coins" size={14} /></span></div>
          <div className="kpi-value">{money(totals.cpm || 0)}</div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>за 1000 показов по кампаниям</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Выходов сделано</span><span className="kpi-icon"><Icon name="megaphone" size={14} /></span></div>
          <div className="kpi-value">{totals.posts || 0}</div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{fmt(totals.views || 0)} показов</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Бюджеты кампаний</span><span className="kpi-icon"><Icon name="receipt" size={14} /></span></div>
          <div className="kpi-value">{money(totals.budgetLeft || 0)}</div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>осталось из {money(totals.budget || 0)}</span></div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-label">Окупаемость рекламы</span><span className="kpi-icon"><Icon name="target" size={14} /></span></div>
          <div className="kpi-value" style={{ fontSize: 24 }}>{totals.roi === null ? '—' : `${Math.round(totals.roi)}%`}</div>
          <div className="kpi-foot"><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>доход брендов к себестоимости</span></div>
        </div>
      </div>

      {/* ── Кампании ─────────────────────────────────────────────────────── */}
      <div className="card pad-lg">
        <div className="card-head">
          <div>
            <h2>Кампании</h2>
            <p>Выходы, бюджет и маркировка по каждому бренду</p>
          </div>
          <Badge tone="muted">{campaigns.length}</Badge>
        </div>

        {loading && <div className="skeleton" style={{ height: 120 }} />}
        {!loading && !campaigns.length && (
          <Empty icon="megaphone" title="Кампаний пока нет"
            text="Добавьте первую бренд-кампанию: Pulse сам подберёт ролики, подставит маркировку и начнёт считать деньги."
            action={<button className="btn btn-primary btn-sm" onClick={openCreate}><Icon name="plus" size={14} />Создать</button>} />
        )}

        <div className="page-grid grid-2" style={{ marginTop: campaigns.length ? 4 : 0 }}>
          {campaigns.map((c) => {
            const st = STATUS[c.status] || STATUS.draft;
            const s = c.stats || {};
            const progress = s.postsTarget ? Math.min(100, Math.round((s.posts / s.postsTarget) * 100)) : 0;
            const dl = daysLeft(c.ends_at);
            return (
              <div key={c.id} className="card" style={{ background: 'rgba(255,255,255,.02)', borderColor: c.status === 'active' ? 'rgba(167,139,250,.28)' : 'var(--line)' }}>
                <div className="row-between" style={{ alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 7, marginBottom: 6 }}>
                      <Badge tone={st.tone} dot={c.status === 'active'}>{st.label}</Badge>
                      <Badge tone="muted">{c.modelLabel}</Badge>
                      {c.erid ? <Badge tone="accent">erid ✓</Badge>
                        : c.marking === 'erid' ? <Badge tone="danger">нет erid</Badge>
                        : c.marking === 'none' ? <Badge tone="muted">без ОРД</Badge> : null}
                    </div>
                    <div style={{ fontSize: 13.5, fontWeight: 730, letterSpacing: '-0.015em', lineHeight: 1.35 }}>{c.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                      {c.brand_name}
                      {c.legal_name ? ` · ${c.legal_name}` : ''}
                      {c.inn ? ` · ИНН ${c.inn}` : ''}
                    </div>
                  </div>
                  <button className="btn btn-ghost btn-icon" title="Подробнее" onClick={() => openDetail(c)}>
                    <Icon name="chevronRight" size={15} />
                  </button>
                </div>

                <div style={{ marginTop: 12 }}>
                  <div className="row-between" style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 5 }}>
                    <span>выходов {s.posts}/{s.postsTarget}</span>
                    <span>{dl !== null ? (dl >= 0 ? `${dl} дн. до дедлайна` : 'срок истёк') : 'бессрочно'}</span>
                  </div>
                  <Progress value={progress} />
                </div>

                <div className="row wrap" style={{ gap: 16, marginTop: 12 }}>
                  <div><div style={{ fontSize: 14, fontWeight: 750 }}>{money(s.revenue || 0)}</div><div style={{ fontSize: 10, color: 'var(--muted)' }}>начислено</div></div>
                  <div><div style={{ fontSize: 14, fontWeight: 750 }} className={(s.receivable || 0) > 0 ? 'tone-amber' : ''}>{money(s.receivable || 0)}</div><div style={{ fontSize: 10, color: 'var(--muted)' }}>к оплате</div></div>
                  <div><div style={{ fontSize: 14, fontWeight: 750 }}>{s.cpm ? money(s.cpm) : '—'}</div><div style={{ fontSize: 10, color: 'var(--muted)' }}>CPM</div></div>
                  <div><div style={{ fontSize: 14, fontWeight: 750 }}>{fmt(s.views || 0)}</div><div style={{ fontSize: 10, color: 'var(--muted)' }}>показов</div></div>
                </div>

                <div className="row wrap" style={{ gap: 6, marginTop: 12 }}>
                  {c.status !== 'done' && (
                    <button className="btn btn-ghost btn-sm" onClick={() => toggleStatus(c)}>
                      <Icon name={c.status === 'active' ? 'pause' : 'play'} size={12} />
                      {c.status === 'active' ? 'Пауза' : 'Запустить'}
                    </button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => { setPaying(c); setPayAmount(String(Math.max(0, Math.round((s.receivable || 0))))); }}>
                    <Icon name="coins" size={12} />Оплата
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => openDetail(c)}>
                    <Icon name="film" size={12} />Выходы
                  </button>
                  <button className="btn btn-ghost btn-icon" title="Удалить" onClick={() => setConfirmDelete(c)} style={{ marginLeft: 'auto' }}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Как это работает ─────────────────────────────────────────────── */}
      <div className="page-grid grid-2">
        <div className="card">
          <div className="card-title"><h3>Маркировка и правила</h3><Icon name="shield" size={14} style={{ color: 'var(--muted)' }} /></div>
          <div className="col" style={{ gap: 10, fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon name="check" size={13} style={{ color: 'var(--green)', marginTop: 2 }} />
              <span>Каждая интеграция получает пометку «Реклама», @бренд, хештеги из брифа и erid-токен ОРД.</span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon name="check" size={13} style={{ color: 'var(--green)', marginTop: 2 }} />
              <span>Если у кампании с моделью «erid» нет токена, ролик не уйдёт в публикацию — это блокирующая проверка.</span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon name="check" size={13} style={{ color: 'var(--green)', marginTop: 2 }} />
              <span>Дневной кэп не даёт выпустить все интеграции в один день: посты распределяются по слотам.</span>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon name="check" size={13} style={{ color: 'var(--green)', marginTop: 2 }} />
              <span>Оплата фиксируется отдельно от начислений: видно, сколько бренд уже заплатил и сколько должен.</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title"><h3>Модели оплаты</h3><Icon name="receipt" size={14} style={{ color: 'var(--muted)' }} /></div>
          <div className="col" style={{ gap: 10 }}>
            {MODELS.map((m) => (
              <div key={m.id} style={{ fontSize: 11.5, lineHeight: 1.55 }}>
                <b style={{ color: 'var(--text)' }}>{m.label}</b>
                <div style={{ color: 'var(--muted)' }}>{MODEL_HINT[m.id]}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Модалка создания ─────────────────────────────────────────────── */}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Новая бренд-кампания"
        subtitle="Бренд, бюджет и модель оплаты — остальное Pulse сделает сам"
        wide
        footer={(
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setCreating(false)}>Отмена</button>
            <button className="btn btn-primary" onClick={create} disabled={busy}>
              <Icon name="check" size={14} />{busy ? 'Создаём…' : 'Создать и запустить'}
            </button>
          </div>
        )}
      >
        <div className="page-grid grid-2">
          <Field label="Бренд" hint="Как называть в интерфейсе">
            <input className="input" value={form.brandName} onChange={(e) => setForm({ ...form, brandName: e.target.value })} placeholder="Nordwind" />
          </Field>
          <Field label="Кампания">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Зимняя капсула" />
          </Field>
          <Field label="Юрлицо" hint="Попадёт в маркировку «Реклама. …»">
            <input className="input" value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} placeholder="ООО «Нордвинд»" />
          </Field>
          <Field label="ИНН">
            <input className="input" value={form.inn} onChange={(e) => setForm({ ...form, inn: e.target.value })} placeholder="7701234567" />
          </Field>
          <Field label="Модель оплаты">
            <select className="select" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Проект" hint="Пусто — любая площадка">
            <select className="select" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              <option value="">Любой проект</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Бюджет, ₽" hint="0 — без потолка">
            <input className="input" type="number" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
          </Field>
          <Field label={form.model === 'fixed' ? 'Ставка за ролик, ₽' : form.model === 'cpm' ? 'Ставка за 1000 показов, ₽' : form.model === 'cpa' ? 'Ставка за конверсию, ₽' : 'Ставка, ₽ (бартер — 0)'}>
            <input className="input" type="number" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
          </Field>
          <Field label="Выходов по договору">
            <input className="input" type="number" value={form.postsTarget} onChange={(e) => setForm({ ...form, postsTarget: e.target.value })} />
          </Field>
          <Field label="Не больше выходов в сутки">
            <input className="input" type="number" value={form.dailyCap} onChange={(e) => setForm({ ...form, dailyCap: e.target.value })} />
          </Field>
          <Field label="Дедлайн">
            <input className="input" type="date" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
          </Field>
          <Field label="erid-токен ОРД" hint="Обязателен для маркировки в РФ">
            <input className="input" value={form.erid} onChange={(e) => setForm({ ...form, erid: e.target.value })} placeholder="2VtzqxP9dKf" />
          </Field>
          <Field label="@бренд в описании">
            <input className="input" value={form.mention} onChange={(e) => setForm({ ...form, mention: e.target.value })} placeholder="@nordwind" />
          </Field>
          <Field label="Хештеги кампании">
            <input className="input" value={form.hashtags} onChange={(e) => setForm({ ...form, hashtags: e.target.value })} placeholder="#nordwind #зима" />
          </Field>
        </div>
        <Field label="Бриф" hint="Что обязательно показать и чего избегать — это уходит в сценарий">
          <textarea className="input" rows={3} value={form.brief} onChange={(e) => setForm({ ...form, brief: e.target.value })} placeholder="3 вещи из капсулы, без «купите», через личный опыт" />
        </Field>
      </Modal>

      {/* ── Модалка оплаты ───────────────────────────────────────────────── */}
      <Modal
        open={Boolean(paying)}
        onClose={() => setPaying(null)}
        title="Записать оплату"
        subtitle={paying ? `${paying.name} · к оплате ${money(paying.stats?.receivable || 0)}` : ''}
        footer={(
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setPaying(null)}>Отмена</button>
            <button className="btn btn-primary" onClick={pay}><Icon name="check" size={14} />Записать</button>
          </div>
        )}
      >
        <Field label="Сумма, ₽" hint="Частичная оплата тоже учитывается">
          <input className="input" type="number" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} autoFocus />
        </Field>
      </Modal>

      {/* ── Детали кампании ──────────────────────────────────────────────── */}
      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.name}
        subtitle={detail ? `${detail.brand_name} · ${detail.modelLabel} · ${detail.stats?.posts || 0}/${detail.stats?.postsTarget || 0} выходов` : ''}
        wide
      >
        {detail && (
          <div className="col" style={{ gap: 14 }}>
            <div className="row wrap" style={{ gap: 18 }}>
              <div className="hr-stat"><span className="v">{money(detail.stats?.revenue || 0)}</span><span className="l">начислено</span></div>
              <div className="hr-stat"><span className="v">{money(detail.stats?.paid || 0)}</span><span className="l">оплачено</span></div>
              <div className="hr-stat"><span className="v">{money(detail.stats?.receivable || 0)}</span><span className="l">к оплате</span></div>
              <div className="hr-stat"><span className="v">{detail.stats?.cpm ? money(detail.stats.cpm) : '—'}</span><span className="l">CPM</span></div>
            </div>

            {detail.disclosure && (
              <div style={{ fontSize: 11.5, padding: '9px 11px', borderRadius: 10, border: '1px solid var(--line)', background: 'rgba(139,92,246,.08)' }}>
                <span style={{ color: 'var(--muted)' }}>Маркировка в описании: </span>{detail.disclosure}
              </div>
            )}

            {detail.brief && (
              <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
                <b>Бриф.</b> {detail.brief}
              </div>
            )}

            <div>
              <div className="card-sub" style={{ marginBottom: 8 }}>Выходы</div>
              {detailLoading && <div className="skeleton" style={{ height: 60 }} />}
              <div className="col" style={{ gap: 6 }}>
                {deliveryRows.map((p) => (
                  <div key={p.id} className="row-between" style={{ gap: 10, fontSize: 11.5, padding: '7px 9px', border: '1px solid var(--line)', borderRadius: 9 }}>
                    <span className="truncate" style={{ flex: 1 }}>{p.title || 'Ролик'}</span>
                    <span style={{ color: 'var(--muted)' }}>{fmt(p.views || 0)} показов</span>
                    <b>{money((p.revenue_cents || 0) / 100)}</b>
                    <span style={{ color: 'var(--muted)', minWidth: 68, textAlign: 'right' }}>{relative(p.created_at)}</span>
                  </div>
                ))}
                {!deliveryRows.length && !detailLoading && <div className="empty-inline">Выходов ещё нет — кампания ждёт свободный слот</div>}
              </div>
            </div>

            {detail.episodes?.length > 0 && (
              <div>
                <div className="card-sub" style={{ marginBottom: 8 }}>Ролики, привязанные к кампании</div>
                <div className="col" style={{ gap: 5 }}>
                  {detail.episodes.slice(0, 8).map((e) => (
                    <div key={e.id} className="row-between" style={{ fontSize: 11.5, gap: 10 }}>
                      <span className="truncate" style={{ flex: 1 }}>{e.title}</span>
                      <Badge tone={e.status === 'published' ? 'success' : e.status === 'scheduled' ? 'accent' : 'muted'}>{e.status}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Confirm
        open={Boolean(confirmDelete)}
        title="Удалить кампанию?"
        text={`«${confirmDelete?.name || ''}» и история её выходов исчезнут. Ролики останутся, но потеряют спонсора.`}
        confirmLabel="Удалить"
        onClose={() => setConfirmDelete(null)}
        onConfirm={async () => {
          try {
            await api.deleteCampaign(confirmDelete.id);
            toast.push({ tone: 'success', title: 'Кампания удалена' });
            setConfirmDelete(null);
            load();
          } catch (err) {
            toast.push({ tone: 'error', title: 'Ошибка', text: err.message });
          }
        }}
      />
    </div>
  );
}
