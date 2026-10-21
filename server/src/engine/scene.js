// ─────────────────────────────────────────────────────────────────────────────
// Scene & Cover Builder — вертикальные кадры 1080×1920.
//
// Текст рисуется векторными контурами из TTF (fontkit), а не через <text>:
//   • не зависит от системных шрифтов и fontconfig внутри контейнера;
//   • кириллица, типографика, трекинг и переносы полностью под контролем;
//   • sharp растеризует пути одинаково на любой машине.
//
// Формат — кинетическая типографика: крупный текст по сценам, акцентные
// подложки, безопасные зоны под интерфейс Reels/TikTok.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.resolve(__dirname, '../../assets/fonts');

let fontkit = null;
try { fontkit = await import('fontkit'); } catch { fontkit = null; }

const fonts = { bold: null, regular: null };
function loadFont(file, key) {
  if (!fontkit) return;
  try {
    const buf = fs.readFileSync(path.join(FONT_DIR, file));
    fonts[key] = fontkit.create(buf);
  } catch { /* шрифт не нужен для старта — деградируем аккуратно */ }
}
loadFont('DejaVuSans-Bold.ttf', 'bold');
loadFont('DejaVuSans.ttf', 'regular');

export const fontsReady = () => Boolean(fonts.bold);

// ── типографика ────────────────────────────────────────────────────────────
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu;

export const sanitize = (input) => String(input || '')
  .replace(EMOJI, '')
  .replace(/[*_`~<>{}\\]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function glyphRun(text, { size, x, baseline, weight = 'bold', letterSpacing = 0 }) {
  const font = fonts[weight] || fonts.bold;
  if (!font) return { d: '', width: text.length * size * 0.55 };
  const scale = size / font.unitsPerEm;
  let cursor = 0;
  const parts = [];
  for (const ch of Array.from(text)) {
    if (ch === ' ') {
      const space = (font.layout(' ').glyphs[0]?.advanceWidth || font.unitsPerEm * 0.32) * scale;
      cursor += space + letterSpacing;
      continue;
    }
    const run = font.layout(ch);
    const glyph = run.glyphs[0];
    if (!glyph) continue;
    const d = glyph.path.toSVG();
    if (d) parts.push(`<path transform="translate(${(x + cursor).toFixed(2)} ${baseline}) scale(${scale.toFixed(5)} -${scale.toFixed(5)})" d="${d}"/>`);
    cursor += (glyph.advanceWidth || 0) * scale + letterSpacing;
  }
  return { d: parts.join(''), width: cursor - (letterSpacing || 0) };
}

export function measure(text, { size, weight = 'bold', letterSpacing = 0 }) {
  const font = fonts[weight] || fonts.bold;
  if (!font) return text.length * size * 0.55;
  const scale = size / font.unitsPerEm;
  let width = 0;
  for (const ch of Array.from(text)) {
    if (ch === ' ') { width += (font.layout(' ').glyphs[0]?.advanceWidth || font.unitsPerEm * 0.32) * scale; continue; }
    const glyph = font.layout(ch).glyphs[0];
    width += (glyph?.advanceWidth || 0) * scale + letterSpacing;
  }
  return width;
}

function wrap(text, { size, maxWidth, maxLines = 4, weight = 'bold', letterSpacing = 0, allowOverflow = false }) {
  const words = sanitize(text).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate, { size, weight, letterSpacing }) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  // если строк больше лимита — отдаём как есть: fitTitle уменьшит кегль,
  // резать слова нельзя (типографика важнее, чем «красивое» число строк)
  if (!allowOverflow && lines.length > maxLines) return lines;
  // слишком длинное одиночное слово тоже не должно вылезать за кадр
  return lines;
}

/** Подбирает кегль так, чтобы каждая строка гарантированно влезала по ширине */
function fitTitle(text, { maxWidth, maxLines = 4, start = 110, min = 44, letterSpacingRatio = -0.018 }) {
  let size = start;
  let lines = [];
  for (let guard = 0; guard < 40 && size >= min; guard++) {
    const letterSpacing = size * letterSpacingRatio;
    lines = wrap(text, { size, maxWidth, maxLines });

    // слово шире кадра — режем по символам (крайне редкий случай)
    lines = lines.flatMap((line) => {
      if (measure(line, { size, letterSpacing }) <= maxWidth) return [line];
      return Array.from(line);
    });

    const fits = lines.length <= maxLines
      && lines.every((l) => measure(l, { size, letterSpacing }) <= maxWidth);
    if (fits) break;
    size -= 5;
  }
  const letterSpacing = size * letterSpacingRatio;
  // короткий текст делаем крупнее — он должен «кричать»
  const longest = Math.max(...lines.map((l) => measure(l, { size, letterSpacing })), 1);
  const fill = longest / maxWidth;
  if (fill < 0.74 && size < 148) {
    const boosted = Math.min(148, Math.round(size * Math.min(1.45, 0.85 / fill)));
    const boostedLines = wrap(text, { size: boosted, maxWidth, maxLines });
    if (boostedLines.length <= maxLines && boostedLines.every((l) => measure(l, { size: boosted, letterSpacing: boosted * letterSpacingRatio }) <= maxWidth)) {
      return { size: boosted, lines: boostedLines };
    }
  }
  return { size, lines };
}

// ── палитры и раскладки ────────────────────────────────────────────────────
export const PALETTES = [
  { a: '#8B5CF6', b: '#2B1055', ink: '#F8F5FF', accent: '#C4B5FD', glow: '#7C3AED' },
  { a: '#A855F7', b: '#26093F', ink: '#FDF4FF', accent: '#F0ABFC', glow: '#D946EF' },
  { a: '#6366F1', b: '#101034', ink: '#EEF2FF', accent: '#A5B4FC', glow: '#818CF8' },
  { a: '#7C3AED', b: '#14082A', ink: '#FFFFFF', accent: '#DDD6FE', glow: '#A78BFA' },
  { a: '#9333EA', b: '#1A0B2E', ink: '#FAF5FF', accent: '#E9D5FF', glow: '#C026D3' },
];

export function hash(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const pickBy = (arr, seed) => arr[hash(seed) % arr.length];

const defs = (p, angle) => `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(${angle} .5 .5)">
      <stop offset="0%" stop-color="#0A0612"/>
      <stop offset="48%" stop-color="${p.b}"/>
      <stop offset="100%" stop-color="#06030B"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${p.accent}"/>
      <stop offset="100%" stop-color="${p.a}" stop-opacity="0.15"/>
    </linearGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.ink}"/>
      <stop offset="100%" stop-color="${p.accent}"/>
    </linearGradient>
    <radialGradient id="glowA" cx="18%" cy="12%" r="58%">
      <stop offset="0%" stop-color="${p.glow}" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="${p.glow}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="92%" cy="86%" r="52%">
      <stop offset="0%" stop-color="${p.accent}" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="${p.accent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="90"/></filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="n"/>
      <feColorMatrix in="n" type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.05"/></feComponentTransfer>
    </filter>
  </defs>`;

const chrome = ({ projectName, handle, aiLabel, index, total }) => `
  <g>
    <circle cx="96" cy="150" r="7" fill="${'#C4B5FD'}"/>
    <path ${''}/>
  </g>`;

// ── сцена ──────────────────────────────────────────────────────────────────
export function buildScene({
  text,
  index = 0,
  total = 1,
  title = '',
  projectName = 'PULSE',
  handle = 'pulse',
  palette,
  aiLabel = true,
  layout = null,
  progress = true,
  grain = false,
}) {
  const p = palette || PALETTES[hash(text) % PALETTES.length];
  const layoutId = layout ?? ['display', 'stack', 'quote', 'metric'][hash(`${text}${index}`) % 4];
  const pad = 88;
  const safeRight = 168;          // место под кнопки площадок
  const maxWidth = 1080 - pad - safeRight;
  const angle = (hash(text) % 70) - 35;

  const sizeStart = layoutId === 'display' ? 124 : 108;
  const { size, lines } = fitTitle(sanitize(text), { maxWidth, maxLines: 4, start: sizeStart });
  const lineHeight = size * 1.06;
  const blockHeight = lines.length * lineHeight;

  const progressDots = progress
    ? Array.from({ length: Math.min(total, 8) }, (_, i) => {
        const active = i <= Math.min(index, 7);
        const w = i === Math.min(index, 7) ? 54 : 16;
        const offset = Array.from({ length: i }).reduce((acc, j) => acc + (j === Math.min(index, 7) ? 54 : 16) + 10, 0);
        return `<rect x="${pad + offset}" y="1728" width="${w}" height="6" rx="3" fill="${active ? p.accent : 'rgba(255,255,255,.2)'}"/>`;
      }).join('')
    : '';

  // вертикальные позиции по раскладкам
  let blockTop;
  if (layoutId === 'display') blockTop = 1010 - blockHeight / 2;
  else if (layoutId === 'stack') blockTop = 830 - blockHeight / 2;
  else if (layoutId === 'quote') blockTop = 900 - blockHeight / 2;
  else blockTop = 1120 - blockHeight / 2;

  const textPaths = lines.map((line, i) => {
    const baseline = blockTop + size * 0.82 + i * lineHeight;
    const run = glyphRun(line, { size, x: pad, baseline, letterSpacing: size * -0.018 });
    const fill = i === 0 ? 'url(#ink)' : 'rgba(255,255,255,.82)';
    return `<g fill="${fill}">${run.d}</g>`;
  }).join('\n    ');

  const accentBar = `<rect x="${pad}" y="${blockTop + blockHeight + 42}" width="${Math.min(340, 120 + (hash(text) % 180))}" height="9" rx="4.5" fill="url(#accent)"/>`;

  // крупный «призрачный» номер сцены: прижимаем к правому краю по фактической ширине
  let bigNumber = '';
  if (layoutId === 'metric') {
    const label = String(index + 1).padStart(2, '0');
    const nSize = 380;
    const width = measure(label, { size: nSize, letterSpacing: -14 });
    bigNumber = `<g opacity="0.1" fill="${p.accent}">${glyphRun(label, { size: nSize, x: 1080 - safeRight - width, baseline: 500, letterSpacing: -14 }).d}</g>`;
  }

  const quoteMark = layoutId === 'quote'
    ? `<g opacity="0.16" fill="${p.accent}">${glyphRun('“', { size: 300, x: pad - 14, baseline: blockTop - 40 }).d}</g>`
    : '';

  const stackLabel = layoutId === 'stack'
    ? `<g opacity="0.9">${glyphRun(String(title || '').slice(0, 26).toUpperCase(), { size: 26, x: pad, baseline: blockTop - 54, weight: 'regular', letterSpacing: 4 }).d}</g>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  ${defs(p, angle)}
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <ellipse cx="${160 + (hash(text) % 240)}" cy="300" rx="520" ry="460" fill="url(#glowA)" filter="url(#blur)" opacity="0.7"/>
  <ellipse cx="${820 - (hash(text) % 180)}" cy="1620" rx="440" ry="400" fill="url(#glowB)" filter="url(#blur)"/>
  <g opacity="0.06" stroke="#FFFFFF" stroke-width="1.2">
    ${Array.from({ length: 9 }, (_, i) => `<line x1="0" y1="${160 + i * 200}" x2="1080" y2="${160 + i * 200}"/>`).join('')}
  </g>
  ${grain ? '<rect width="1080" height="1920" filter="url(#grain)" opacity="0.5"/>' : ''}

  <g fill="rgba(255,255,255,.55)">
    ${glyphRun(String(projectName || 'PULSE').toUpperCase().slice(0, 24), { size: 28, x: pad, baseline: 132, weight: 'regular', letterSpacing: 5 }).d}
  </g>
  <g fill="rgba(255,255,255,.42)">
    ${glyphRun(`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, { size: 28, x: 1080 - safeRight, baseline: 132, weight: 'regular', letterSpacing: 2 }).d}
  </g>
  <line x1="${pad}" y1="168" x2="${1080 - safeRight}" y2="168" stroke="rgba(255,255,255,.14)" stroke-width="1"/>

  ${bigNumber}
  ${quoteMark}
  ${stackLabel}
  ${layoutId === 'quote' ? `<rect x="${pad - 26}" y="${blockTop - 6}" width="6" height="${blockHeight + 12}" rx="3" fill="url(#accent)"/>` : ''}

  ${textPaths}
  ${accentBar}

  ${progressDots}
  <g fill="rgba(255,255,255,.7)">
    ${glyphRun(`@${String(handle || 'pulse').replace(/^@/, '')}`, { size: 28, x: pad, baseline: 1790, weight: 'regular', letterSpacing: 1 }).d}
  </g>
  ${aiLabel ? `
  <g>
    <rect x="${1080 - safeRight - 150}" y="1758" width="150" height="42" rx="21" fill="rgba(255,255,255,.1)" stroke="rgba(255,255,255,.2)"/>
    <g fill="rgba(255,255,255,.7)">${glyphRun('AI · PULSE', { size: 20, x: 1080 - safeRight - 130, baseline: 1786, weight: 'regular', letterSpacing: 2 }).d}</g>
  </g>` : ''}
</svg>`;
}

// ── обложка ────────────────────────────────────────────────────────────────
export function buildCover({ title, subtitle = 'смотреть', projectName = 'PULSE', handle = 'pulse', palette, variant = 0, badge = '' }) {
  const p = palette || PALETTES[hash(title) % PALETTES.length];
  const pad = 88;
  const safeRight = 150;
  const maxWidth = 1080 - pad - safeRight;
  const angle = variant ? 20 : -20;
  const ink = variant ? 'url(#ink)' : '#FFFFFF';

  const lead = sanitize(title);
  const words = lead.split(' ');
  const head = words.slice(0, 3).join(' ');
  const tail = words.slice(3, 15).join(' ');
  const headFit = fitTitle(head || lead, { maxWidth, maxLines: 3, start: 132, min: 66, letterSpacingRatio: -0.02 });
  const tailFit = tail ? fitTitle(tail, { maxWidth, maxLines: 3, start: 60, min: 36, letterSpacingRatio: -0.005 }) : { size: 0, lines: [] };

  const headBlock = headFit.lines.length * headFit.size * 1.04;
  const tailBlock = tailFit.lines.length * tailFit.size * 1.25;
  const totalBlock = headBlock + (tail ? 34 + tailBlock : 0);
  const startY = 930 - totalBlock / 2;

  const headPaths = headFit.lines.map((line, i) => `<g fill="${ink}">${glyphRun(line, { size: headFit.size, x: pad, baseline: startY + headFit.size * 0.8 + i * headFit.size * 1.04, letterSpacing: -headFit.size * 0.02 }).d}</g>`).join('');
  const tailPaths = tailFit.lines.map((line, i) => `<g fill="${p.accent}" opacity="0.88">${glyphRun(line, { size: tailFit.size, x: pad, baseline: startY + headBlock + 34 + tailFit.size * 0.8 + i * tailFit.size * 1.25, letterSpacing: tailFit.size * -0.005 }).d}</g>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  ${defs(p, angle)}
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <ellipse cx="${variant ? 820 : 240}" cy="${variant ? 1180 : 420}" rx="520" ry="470" fill="url(#glowA)" filter="url(#blur)" opacity="0.85"/>
  <ellipse cx="${variant ? 240 : 860}" cy="${variant ? 300 : 1500}" rx="380" ry="340" fill="url(#glowB)" filter="url(#blur)"/>
  <rect width="1080" height="1920" filter="url(#grain)" opacity="0.55"/>

  <g fill="rgba(255,255,255,.6)">${glyphRun(String(projectName || 'PULSE').toUpperCase().slice(0, 22), { size: 28, x: pad, baseline: 140, weight: 'regular', letterSpacing: 5 }).d}</g>

  <rect x="${pad}" y="${startY - 96}" width="76" height="8" rx="4" fill="url(#accent)"/>
  ${headPaths}
  ${tailPaths}

  ${badge ? `
  <g>
    <rect x="${pad}" y="${startY + totalBlock + 74}" width="${Math.min(380, 40 + badge.length * 17)}" height="52" rx="26" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.22)"/>
    <g fill="#fff">${glyphRun(badge, { size: 24, x: pad + 22, baseline: startY + totalBlock + 108, weight: 'regular', letterSpacing: 1 }).d}</g>
  </g>` : ''}

  <rect x="0" y="1500" width="1080" height="420" fill="url(#bg)" opacity="0.9"/>
  <g fill="rgba(255,255,255,.92)">${glyphRun(String(subtitle).slice(0, 26), { size: 34, x: pad, baseline: 1700, letterSpacing: 1 }).d}</g>
  <g fill="rgba(255,255,255,.45)">${glyphRun(`@${String(handle || 'pulse').replace(/^@/, '')}`, { size: 26, x: pad, baseline: 1760, weight: 'regular' }).d}</g>

  <g>
    <circle cx="${1080 - pad - 56}" cy="1680" r="52" fill="rgba(255,255,255,.14)" stroke="rgba(255,255,255,.3)"/>
    <path transform="translate(${1080 - pad - 76} 1652)" d="M0 0 L36 28 L0 56 Z" fill="#fff"/>
  </g>
</svg>`;
}

export { esc };
