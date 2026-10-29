import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icons.jsx';
import { fmt } from '../lib/format.js';

/* ── Toasts ─────────────────────────────────────────────────────────────── */
const ToastCtx = createContext({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((toast) => {
    const id = Math.random().toString(36).slice(2);
    const item = typeof toast === 'string' ? { title: toast } : toast;
    setItems((prev) => [...prev, { id, tone: 'info', ...item }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), item.tone === 'error' ? 6500 : 4200);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <Icon name={t.tone === 'error' || t.tone === 'warn' ? 'alert' : t.tone === 'success' ? 'check' : 'info'} size={16} style={{ marginTop: 1, color: t.tone === 'error' ? 'var(--red)' : t.tone === 'warn' ? 'var(--amber)' : t.tone === 'success' ? 'var(--green)' : 'var(--violet-2)' }} />
            <div>
              <div className="toast-title">{t.title}</div>
              {t.text && <div className="toast-text">{t.text}</div>}
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ── Modal / Drawer ─────────────────────────────────────────────────────── */
export function Modal({ open, onClose, title, subtitle, children, footer, wide }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Закрыть"><Icon name="x" size={17} /></button>
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, subtitle, children, actions }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15.5, fontWeight: 750, letterSpacing: '-0.02em' }} className="clamp-2">{title}</div>
            {subtitle && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>{subtitle}</div>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {actions}
            <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Закрыть"><Icon name="x" size={17} /></button>
          </div>
        </div>
        {children}
      </aside>
    </div>
  );
}

/* ── Primitives ─────────────────────────────────────────────────────────── */
export const Badge = ({ tone = 'muted', children, dot, live }) => (
  <span className={`badge ${tone} ${live ? 'live' : ''}`}>
    {dot && <i className="dot" />}
    {children}
  </span>
);

export function Toggle({ checked, onChange, label, hint, disabled }) {
  if (!label) {
    return <button type="button" className={`toggle ${checked ? 'on' : ''}`} onClick={() => !disabled && onChange?.(!checked)} aria-pressed={checked} disabled={disabled} />;
  }
  return (
    <div className="toggle-row">
      <div>
        <div className="t-label">{label}</div>
        {hint && <div className="t-hint">{hint}</div>}
      </div>
      <button type="button" className={`toggle ${checked ? 'on' : ''}`} onClick={() => !disabled && onChange?.(!checked)} aria-pressed={checked} disabled={disabled} />
    </div>
  );
}

export const Progress = ({ value, striped, style }) => (
  <div className={`progress-line ${striped ? 'striped' : ''}`} style={style}>
    <i style={{ width: `${Math.max(2, Math.min(100, value || 0))}%` }} />
  </div>
);

export function ScoreRing({ value = 0, size = 34, label }) {
  const r = (size - 5) / 2;
  const c = 2 * Math.PI * r;
  const tone = value >= 75 ? 'var(--green)' : value >= 50 ? 'var(--violet-2)' : 'var(--amber)';
  return (
    <div className="score-ring" style={{ width: size, height: size }} title={`Оценка темы: ${value}/100`}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="3" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={`${(value / 100) * c} ${c}`} />
      </svg>
      <span>{label ?? value}</span>
    </div>
  );
}

export const Kpi = ({ label, value, sub, icon, trend, tone = 'accent' }) => (
  <div className="card kpi">
    <div className="kpi-top">
      <span className="kpi-label">{label}</span>
      {icon && <span className="kpi-icon"><Icon name={icon} size={14} /></span>}
    </div>
    <div className="kpi-value">
      {value}
      {sub && <small>{sub}</small>}
    </div>
    <div className="kpi-foot">
      {trend !== undefined && trend !== null ? (
        <span className={`trend ${trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat'}`}>
          <Icon name={trend > 0 ? 'arrowUpRight' : trend < 0 ? 'arrowDown' : 'minus'} size={11} />
          {trend > 0 ? '+' : ''}{String(trend).replace('.', ',')}%
        </span>
      ) : <span />}
      {tone === 'spark' ? null : null}
    </div>
  </div>
);

export const Empty = ({ icon = 'sparkles', title, text, action }) => (
  <div className="empty">
    <div className="empty-icon"><Icon name={icon} size={20} /></div>
    <h4>{title}</h4>
    {text && <p>{text}</p>}
    {action}
  </div>
);

export const Field = ({ label, hint, children, span }) => (
  <label className={`field ${span ? 'span-2' : ''}`}>
    {label && <span className="field-label">{label}</span>}
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
);

export const Segmented = ({ options, value, onChange, size }) => (
  <div className="pill-switch" style={size === 'sm' ? { padding: 2 } : undefined}>
    {options.map((o) => (
      <button key={o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)} type="button">
        {o.label}
      </button>
    ))}
  </div>
);

/* ── Charts ─────────────────────────────────────────────────────────────── */
const smoothPath = (pts) => {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6.5;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6.5;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6.5;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6.5;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
};

export function AreaChart({ data, series = [{ key: 'views', color: '#a78bfa', label: 'Просмотры' }], height = 220, valueFormat = fmt, todayIndex }) {
  const [hover, setHover] = useState(null);
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(760);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const pad = { l: 38, r: 10, t: 14, b: 22 };
  const innerW = Math.max(10, width - pad.l - pad.r);
  const innerH = height - pad.t - pad.b;
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0)));
  const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;
  const x = (i) => pad.l + i * stepX;
  const y = (v) => pad.t + innerH - (v / max) * innerH;
  const gridLines = 4;
  const labelEvery = Math.max(1, Math.ceil(data.length / (width < 560 ? 5 : 8)));

  const onMove = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const idx = Math.round((px - pad.l) / stepX);
    setHover(Math.max(0, Math.min(data.length - 1, idx)));
  };

  const primary = series[0];
  const pts = data.map((d, i) => [x(i), y(Number(d[primary.key]) || 0)]);
  const line = smoothPath(pts);
  const area = `${line} L ${x(data.length - 1)} ${pad.t + innerH} L ${pad.l} ${pad.t + innerH} Z`;
  const gid = useMemo(() => `area-${Math.random().toString(36).slice(2, 8)}`, []);

  return (
    <div className="chart-wrap" ref={wrapRef} onMouseLeave={() => setHover(null)} onMouseMove={onMove}>
      <svg className="chart-svg" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={primary.color} stopOpacity="0.34" />
            <stop offset="65%" stopColor={primary.color} stopOpacity="0.06" />
            <stop offset="100%" stopColor={primary.color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {Array.from({ length: gridLines + 1 }).map((_, i) => {
          const gy = pad.t + (innerH / gridLines) * i;
          const val = max - (max / gridLines) * i;
          return (
            <g key={i}>
              <line className="chart-grid" x1={pad.l} x2={width - pad.r} y1={gy} y2={gy} />
              <text className="chart-axis" x={pad.l - 8} y={gy + 3} textAnchor="end">{valueFormat(val)}</text>
            </g>
          );
        })}
        {data.map((d, i) => (i % labelEvery === 0 || i === data.length - 1) && (
          <text key={d.label + i} className="chart-axis" x={x(i)} y={height - 4} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}>{d.label}</text>
        ))}
        <path d={area} fill={`url(#${gid})`} />
        {series.slice(1).map((s) => (
          <path key={s.key} d={smoothPath(data.map((d, i) => [x(i), y(Number(d[s.key]) || 0)]))} fill="none" stroke={s.color} strokeWidth="1.6" strokeOpacity="0.75" strokeDasharray="4 4" />
        ))}
        <path d={line} fill="none" stroke={primary.color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        {todayIndex != null && todayIndex >= 0 && (
          <rect x={x(todayIndex) - stepX / 2} y={pad.t} width={stepX} height={innerH} fill="rgba(167,139,250,.05)" />
        )}
        {hover != null && data[hover] && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + innerH} stroke={primary.color} strokeOpacity="0.4" strokeDasharray="3 3" />
            {series.map((s) => (
              <circle key={s.key} cx={x(hover)} cy={y(Number(data[hover][s.key]) || 0)} r="3.6" fill={s.color} stroke="#0b0812" strokeWidth="2" />
            ))}
          </g>
        )}
      </svg>
      {hover != null && data[hover] && (
        <div className="chart-tip" style={{ left: Math.min(width - 70, Math.max(70, x(hover))), top: Math.max(48, y(Number(data[hover][primary.key]) || 0)) }}>
          <div className="t-day">{data[hover].label}</div>
          {series.map((s) => (
            <div className="t-row" key={s.key}>
              <span style={{ color: s.color }}>{s.label}</span>
              <b>{valueFormat(data[hover][s.key])}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values = [], color = '#a78bfa', width = 92, height = 30 }) {
  const max = Math.max(1, ...values);
  const min = Math.min(...values, 0);
  const pts = values.map((v, i) => [
    (i / Math.max(1, values.length - 1)) * width,
    height - 3 - ((v - min) / Math.max(1, max - min)) * (height - 6),
  ]);
  const d = smoothPath(pts);
  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }} aria-hidden="true">
      <path d={`${d} L ${width} ${height} L 0 ${height} Z`} fill={color} fillOpacity="0.1" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function BarList({ items = [], valueKey = 'views', labelKey = 'label', format = fmt, alt }) {
  const max = Math.max(1, ...items.map((i) => Number(i[valueKey]) || 0));
  return (
    <div className="barlist">
      {items.map((item, idx) => (
        <div className="barlist-row" key={item[labelKey] + idx}>
          <span className="barlist-label truncate" title={item[labelKey]}>{item[labelKey]}</span>
          <div className="bar-track">
            <div className={`bar-fill ${alt ? 'alt' : ''}`} style={{ width: `${Math.max(3, ((Number(item[valueKey]) || 0) / max) * 100)}%` }} />
          </div>
          <span className="barlist-value">{format(item[valueKey])}</span>
        </div>
      ))}
    </div>
  );
}

export function Donut({ segments = [], size = 132, thickness = 13, centerLabel, centerValue }) {
  const total = segments.reduce((a, s) => a + (Number(s.value) || 0), 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.06)" strokeWidth={thickness} />
        {segments.map((s, i) => {
          const len = (Number(s.value) / total) * c;
          const el = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
              strokeDasharray={`${Math.max(0, len - 2)} ${c}`} strokeDashoffset={-offset} strokeLinecap="round" />
          );
          offset += len;
          return el;
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
        <span style={{ fontSize: 20, fontWeight: 780, letterSpacing: '-0.03em' }}>{centerValue}</span>
        <span style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>{centerLabel}</span>
      </div>
    </div>
  );
}

export function Confirm({ open, title, text, confirmLabel = 'Удалить', tone = 'danger', onConfirm, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={text}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
        <button className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
      </>}>
      <div style={{ height: 4 }} />
    </Modal>
  );
}
