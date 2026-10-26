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


// ─────────────────────────────────────────────────────────────────────────────
// Слои: фон отдельно, текст отдельно.
//
// Так монтируют настоящие ролики: фон идёт одним непрерывным планом (медленный
// наезд камеры), а текстовые слои сменяются с коротким кроссфейдом. При этом
// текст двух сцен не «складывается» в нечитаемую кашу, как при кроссфейде
// целых кадров.
// ─────────────────────────────────────────────────────────────────────────────

/** Фон на весь ролик: градиент, свечения, сетка, бренд, хэндл, метка AI. */
export function buildBackground({
  palette,
  projectName = 'PULSE',
  handle = 'pulse',
  aiLabel = true,
  seed = '',
  grain = false,
}) {
  const p = palette || PALETTES[hash(seed) % PALETTES.length];
  const pad = 88;
  const safeRight = 168;
  const angle = (hash(seed) % 70) - 35;
  const h = hash(seed || 'pulse');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  ${defs(p, angle)}
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <ellipse cx="${160 + (h % 240)}" cy="300" rx="520" ry="460" fill="url(#glowA)" filter="url(#blur)" opacity="0.7"/>
  <ellipse cx="${820 - (h % 180)}" cy="1620" rx="440" ry="400" fill="url(#glowB)" filter="url(#blur)"/>
  <g opacity="0.06" stroke="#FFFFFF" stroke-width="1.2">
    ${Array.from({ length: 9 }, (_, i) => `<line x1="0" y1="${160 + i * 200}" x2="1080" y2="${160 + i * 200}"/>`).join('')}
  </g>
  ${grain ? '<rect width="1080" height="1920" filter="url(#grain)" opacity="0.5"/>' : ''}
  <g fill="rgba(255,255,255,.55)">
    ${glyphRun(String(projectName || 'PULSE').toUpperCase().slice(0, 24), { size: 28, x: pad, baseline: 132, weight: 'regular', letterSpacing: 5 }).d}
  </g>
  <line x1="${pad}" y1="168" x2="${1080 - safeRight}" y2="168" stroke="rgba(255,255,255,.14)" stroke-width="1"/>
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

/** Текстовый слой с прозрачным фоном: только контент сцены. */
export function buildTextOverlay({
  text,
  index = 0,
  total = 1,
  title = '',
  palette,
  layout = null,
  progress = true,
  counter = true,
}) {
  const p = palette || PALETTES[hash(text) % PALETTES.length];
  const layoutId = layout ?? ['display', 'stack', 'quote', 'metric'][hash(`${text}${index}`) % 4];
  const pad = 88;
  const safeRight = 168;
  const maxWidth = 1080 - pad - safeRight;

  const sizeStart = layoutId === 'display' ? 124 : 108;
  const { size, lines } = fitTitle(sanitize(text), { maxWidth, maxLines: 4, start: sizeStart });
  const lineHeight = size * 1.06;
  const blockHeight = lines.length * lineHeight;

  const activeDot = Math.min(index, 7);
  const dots = progress
    ? Array.from({ length: Math.min(total, 8) }, (_, i) => {
        const w = i === activeDot ? 54 : 16;
        const offset = Array.from({ length: i }).reduce((acc, j) => acc + (j === activeDot ? 54 : 16) + 10, 0);
        return `<rect x="${(pad + offset).toFixed(1)}" y="1728" width="${w}" height="6" rx="3" fill="${i <= activeDot ? p.accent : 'rgba(255,255,255,.2)'}"/>`;
      }).join('')
    : '';

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

  const accentBar = `<rect x="${pad}" y="${(blockTop + blockHeight + 42).toFixed(1)}" width="${Math.min(340, 120 + (hash(text) % 180))}" height="9" rx="4.5" fill="url(#accent)"/>`;

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

  // подпись-тема: первые 3 слова заголовка, обрезаем по границе слова,
  // чтобы в кадре не появлялось «3 ОШИБКИ: КАК ПЕРЕСТАТЬ ОТ»
  const titleWords = sanitize(title).split(' ').filter(Boolean);
  const labelText = (titleWords.length > 3 ? `${titleWords.slice(0, 3).join(' ')}…` : titleWords.join(' ')).toUpperCase();
  const labelUseful = labelText && sanitize(title).toLowerCase() !== sanitize(text).toLowerCase();
  const stackLabel = layoutId === 'stack' && labelUseful
    ? `<g opacity="0.9" fill="rgba(255,255,255,.85)">${glyphRun(labelText, { size: 26, x: pad, baseline: blockTop - 54, weight: 'regular', letterSpacing: 4 }).d}</g>`
    : '';

  const counterText = counter
    ? `<g fill="rgba(255,255,255,.42)">${glyphRun(`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, { size: 28, x: 1080 - safeRight, baseline: 132, weight: 'regular', letterSpacing: 2 }).d}</g>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  ${defs(p, 0)}
  ${counterText}
  ${bigNumber}
  ${quoteMark}
  ${stackLabel}
  ${layoutId === 'quote' ? `<rect x="${pad - 26}" y="${(blockTop - 6).toFixed(1)}" width="6" height="${(blockHeight + 12).toFixed(1)}" rx="3" fill="url(#accent)"/>` : ''}
  ${textPaths}
  ${accentBar}
  ${dots}
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

// ─────────────────────────────────────────────────────────────────────────────
// Длинные серии: 16:9, фото-ряд.
//
// Короткий ролик держится на крупной типографике. Сериал — на изображении:
// зритель 12 минут смотрит на кадр и слушает голос. Поэтому здесь другой
// визуальный язык: горизонтальный «фотографический» кадр (горизонт, глубина,
// туман, зерно, виньетка), а текст — не заголовок, а субтитры.
// ─────────────────────────────────────────────────────────────────────────────

const num1 = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * Силуэты под локацию. Рисуем векторами: детерминированно и без чужих прав.
 * Задача — не «нарисовать город», а дать кадру глубину: три плана, воздух между
 * ними и свет сзади. Тогда 12 минут фото-ряда не выглядят как слайдшоу.
 */
function sceneryArt(kind, h, W = 1920, H = 1080) {
  const rnd = (i) => ((h >> (i % 24)) & 1023) / 1023;
  const horizon = H * 0.64;
  const parts = [];
  const ink = (o = 1) => `#000000" opacity="${o}`;

  if (kind === 'city') {
    // три плана: дальний (светлее, в дымке), средний, ближний (чёрный)
    for (const [layer, cfg] of [[0, { op: 0.55, y: horizon - 6, h: 170, w: 70 }], [1, { op: 0.8, y: horizon + 14, h: 280, w: 100 }], [2, { op: 1, y: horizon + 46, h: 420, w: 140 }]]) {
      let x = -60;
      let i = 0;
      while (x < W + 60) {
        const w = cfg.w * (0.6 + rnd(i * 3 + layer) * 0.9);
        const bh = cfg.h * (0.45 + rnd(i * 5 + layer) * 0.9);
        parts.push(`<rect x="${x.toFixed(0)}" y="${(cfg.y - bh).toFixed(0)}" width="${w.toFixed(0)}" height="${(H - cfg.y + bh).toFixed(0)}" fill="${ink(cfg.op)}"/>`);
        if (layer === 2) {
          for (let k = 0; k < 7; k += 1) {
            if (rnd(i * 11 + k) > 0.55) {
              parts.push(`<rect x="${(x + 14 + (k % 3) * 34).toFixed(0)}" y="${(cfg.y - bh + 30 + Math.floor(k / 3) * 52).toFixed(0)}" width="13" height="20" fill="#F5F3FF" opacity="${(0.14 + rnd(i + k * 3) * 0.4).toFixed(2)}"/>`);
            }
          }
        }
        x += w + 12 + rnd(i + layer) * 30;
        i += 1;
      }
    }
    // редкие фонари на среднем плане
    for (let i = 0; i < 5; i += 1) {
      const x = W * (0.12 + i * 0.2) + rnd(i) * 40;
      parts.push(`<rect x="${x.toFixed(0)}" y="${(horizon - 90).toFixed(0)}" width="4" height="100" fill="#05040A" opacity="0.9"/>`);
      parts.push(`<circle cx="${x.toFixed(0)}" cy="${(horizon - 92).toFixed(0)}" r="26" fill="#FDE68A" opacity="0.10" filter="url(#blur)"/>`);
    }
  } else if (kind === 'forest') {
    for (const [layer, cfg] of [[0, { op: 0.5, y: horizon - 14, s: 0.75 }], [1, { op: 0.78, y: horizon + 40, s: 1.05 }], [2, { op: 1, y: horizon + 110, s: 1.6 }]]) {
      for (let i = 0; i < 18; i += 1) {
        const x = (i * (W / 16)) - 120 + rnd(i + layer * 4) * 70;
        const th = (200 + rnd(i * 3 + layer) * 190) * cfg.s;
        const tw = (60 + rnd(i * 5 + layer) * 46) * cfg.s;
        parts.push(`<path d="M${x.toFixed(0)} ${(cfg.y - th * 0.16).toFixed(0)} L${(x - tw * 0.24).toFixed(0)} ${cfg.y.toFixed(0)} L${(x + tw * 0.24).toFixed(0)} ${cfg.y.toFixed(0)} Z" fill="${ink(cfg.op)}"/>`);
        parts.push(`<path d="M${x.toFixed(0)} ${(cfg.y - th * 0.46).toFixed(0)} L${(x - tw * 0.38).toFixed(0)} ${(cfg.y - th * 0.12).toFixed(0)} L${(x + tw * 0.38).toFixed(0)} ${(cfg.y - th * 0.12).toFixed(0)} Z" fill="${ink(cfg.op)}"/>`);
        parts.push(`<path d="M${x.toFixed(0)} ${(cfg.y - th).toFixed(0)} L${(x - tw * 0.5).toFixed(0)} ${(cfg.y - th * 0.42).toFixed(0)} L${(x + tw * 0.5).toFixed(0)} ${(cfg.y - th * 0.42).toFixed(0)} Z" fill="${ink(cfg.op)}"/>`);
      }
    }
  } else if (kind === 'road') {
    parts.push(`<path d="M${W * 0.2} ${H} L${W * 0.455} ${horizon} L${W * 0.545} ${horizon} L${W * 0.8} ${H} Z" fill="#0A0813" opacity="0.95"/>`);
    for (let i = 0; i < 10; i += 1) {
      const t = i / 10;
      const y = horizon + Math.pow(t, 1.8) * (H - horizon);
      const w = 5 + t * 30;
      parts.push(`<rect x="${(W / 2 - w / 2).toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${(8 + t * 58).toFixed(0)}" fill="#EDE9FE" opacity="${(0.14 + t * 0.34).toFixed(2)}"/>`);
    }
    // столбы вдоль обочины — дают перспективу
    for (let i = 0; i < 7; i += 1) {
      const t = Math.pow(i / 7, 1.7);
      const y = horizon + t * (H - horizon) * 0.9;
      const x = W * (0.5 - 0.33 * Math.pow(1 - t, 0.7)) - 30;
      const bh = 40 + t * 240;
      parts.push(`<rect x="${x.toFixed(0)}" y="${(y - bh).toFixed(0)}" width="${(3 + t * 5).toFixed(0)}" height="${bh.toFixed(0)}" fill="#05040A" opacity="${(0.5 + t * 0.5).toFixed(2)}"/>`);
    }
    parts.push(`<ellipse cx="${W / 2}" cy="${horizon + 6}" rx="70" ry="24" fill="#F8F5FF" opacity="0.22" filter="url(#blur)"/>`);
  } else if (kind === 'room') {
    // окно с переплётом и лучом света, дверь, стол на переднем плане
    const wx = W * 0.12;
    const wy = H * 0.14;
    const ww = W * 0.3;
    const wh = H * 0.46;
    parts.push(`<rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" fill="#0C0918"/>`);
    parts.push(`<rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" fill="url(#glow)" opacity="0.5"/>`);
    parts.push(`<rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" fill="none" stroke="#EDE9FE" stroke-opacity="0.22" stroke-width="5"/>`);
    parts.push(`<line x1="${wx + ww / 2}" y1="${wy}" x2="${wx + ww / 2}" y2="${wy + wh}" stroke="#EDE9FE" stroke-opacity="0.18" stroke-width="4"/>`);
    parts.push(`<line x1="${wx}" y1="${wy + wh / 2}" x2="${wx + ww}" y2="${wy + wh / 2}" stroke="#EDE9FE" stroke-opacity="0.18" stroke-width="4"/>`);
    parts.push(`<path d="M${wx} ${wy + wh * 0.6} L${W * 0.72} ${H} L${W * 0.3} ${H} L${wx - W * 0.06} ${H * 0.86} Z" fill="#EDE9FE" opacity="0.045"/>`);
    parts.push(`<rect x="${W * 0.7}" y="${H * 0.22}" width="${W * 0.11}" height="${H * 0.74}" fill="#05040A" opacity="0.92"/>`);
    parts.push(`<rect x="${W * 0.7}" y="${H * 0.94}" width="${W * 0.11}" height="10" fill="#FDE68A" opacity="0.10" filter="url(#blur)"/>`);
    parts.push(`<rect x="${W * 0.08}" y="${H * 0.82}" width="${W * 0.4}" height="${H * 0.18}" rx="8" fill="#05040A" opacity="0.95"/>`);
    parts.push(`<rect x="${W * 0.16}" y="${H * 0.74}" width="${W * 0.06}" height="${H * 0.12}" fill="#05040A" opacity="0.9"/>`);
  } else if (kind === 'horde') {
    parts.push(`<rect x="0" y="${(horizon + 50).toFixed(0)}" width="${W}" height="${(H - horizon - 50).toFixed(0)}" fill="#05040A" opacity="0.9"/>`);
    for (let i = 0; i < 46; i += 1) {
      const x = -20 + i * (W / 44) + rnd(i) * 20;
      const scaleY = 0.5 + rnd(i * 3) * 0.8;
      const bh = 130 * scaleY;
      const op = 0.55 + rnd(i * 7) * 0.45;
      parts.push(`<ellipse cx="${x.toFixed(0)}" cy="${(horizon + 44 - bh).toFixed(0)}" rx="${(10 + scaleY * 5).toFixed(0)}" ry="${(12 + scaleY * 6).toFixed(0)}" fill="#05040A" opacity="${op.toFixed(2)}"/>`);
      parts.push(`<rect x="${(x - 9 - scaleY * 5).toFixed(0)}" y="${(horizon + 40 - bh + 20).toFixed(0)}" width="${(18 + scaleY * 10).toFixed(0)}" height="${(bh).toFixed(0)}" rx="8" fill="#05040A" opacity="${op.toFixed(2)}"/>`);
    }
  } else if (kind === 'tunnel') {
    // арки: полукруглые своды, уходящие в точку света
    for (let i = 6; i >= 0; i -= 1) {
      const k = 1 - i * 0.13;
      const rw = W * 0.5 * k;
      const rh = H * 0.9 * k;
      const x = W / 2 - rw;
      const y = H * 0.92 - rh;
      parts.push(`<path d="M${x.toFixed(0)} ${H} L${x.toFixed(0)} ${(y + rh * 0.42).toFixed(0)} A ${rw.toFixed(0)} ${(rh * 0.42).toFixed(0)} 0 0 1 ${(x + rw * 2).toFixed(0)} ${(y + rh * 0.42).toFixed(0)} L${(x + rw * 2).toFixed(0)} ${H}" fill="none" stroke="#E9D5FF" stroke-opacity="${(0.05 + i * 0.035).toFixed(3)}" stroke-width="${(26 - i * 2).toFixed(0)}"/>`);
    }
    parts.push(`<ellipse cx="${W / 2}" cy="${H * 0.68}" rx="${W * 0.06}" ry="${H * 0.05}" fill="#F8F5FF" opacity="0.20" filter="url(#blur)"/>`);
  } else if (kind === 'sky') {
    for (let i = 0; i < 60; i += 1) {
      const x = rnd(i * 3) * W;
      const y = rnd(i * 7) * horizon * 0.9;
      parts.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(1 + rnd(i) * 1.6).toFixed(1)}" fill="#F8F5FF" opacity="${(0.12 + rnd(i * 5) * 0.4).toFixed(2)}"/>`);
    }
    parts.push(`<circle cx="${W * 0.72}" cy="${H * 0.24}" r="70" fill="#FDF4FF" opacity="0.55"/>`);
    parts.push(`<circle cx="${W * 0.72}" cy="${H * 0.24}" r="210" fill="#E9D5FF" opacity="0.10" filter="url(#blur)"/>`);
    for (let i = 0; i < 4; i += 1) {
      const y = H * 0.32 + i * 66;
      parts.push(`<ellipse cx="${(W * (0.25 + rnd(i) * 0.5)).toFixed(0)}" cy="${y.toFixed(0)}" rx="${(280 + rnd(i) * 260).toFixed(0)}" ry="30" fill="#0B0814" opacity="0.4" filter="url(#blur)"/>`);
    }
  } else if (kind === 'corridor') {
    const vpx = W * 0.52;
    const vpy = H * 0.5;
    parts.push(`<path d="M0 ${H} L${vpx} ${vpy} L${W} ${H} Z" fill="#07050E" opacity="0.75"/>`);
    for (let i = 0; i < 6; i += 1) {
      const t = i / 6;
      const y = vpy + Math.pow(t, 1.6) * (H - vpy);
      const half = W * 0.08 + Math.pow(t, 1.5) * W * 0.5;
      parts.push(`<line x1="${(vpx - half).toFixed(0)}" y1="${y.toFixed(0)}" x2="${(vpx + half).toFixed(0)}" y2="${y.toFixed(0)}" stroke="#E9D5FF" stroke-opacity="0.05" stroke-width="2"/>`);
    }
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i += 1) {
        const t = 0.12 + i * 0.22;
        const y = vpy + Math.pow(t, 1.6) * (H - vpy);
        const x = vpx + side * (W * 0.1 + Math.pow(t, 1.5) * W * 0.46);
        const dw = (40 + t * 170);
        const dh = (90 + t * 420);
        parts.push(`<rect x="${(x - dw / 2).toFixed(0)}" y="${(y - dh).toFixed(0)}" width="${dw.toFixed(0)}" height="${dh.toFixed(0)}" fill="#05040A" opacity="0.92"/>`);
      }
    }
    parts.push(`<ellipse cx="${vpx}" cy="${vpy}" rx="110" ry="150" fill="#EDE9FE" opacity="0.10" filter="url(#blur)"/>`);
  } else if (kind === 'water') {
    parts.push(`<rect x="0" y="${horizon.toFixed(0)}" width="${W}" height="${(H - horizon).toFixed(0)}" fill="#07050D"/>`);
    for (let i = 0; i < 14; i += 1) {
      const t = i / 14;
      const y = horizon + 14 + Math.pow(t, 1.4) * (H - horizon);
      const w = W * (0.2 + rnd(i) * 0.5);
      parts.push(`<rect x="${(W / 2 - w / 2 + (rnd(i + 3) - 0.5) * 120).toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${(2 + t * 8).toFixed(0)}" fill="#EDE9FE" opacity="${(0.16 - t * 0.1).toFixed(3)}"/>`);
    }
    parts.push(`<rect x="${W * 0.69}" y="${horizon.toFixed(0)}" width="30" height="${(H - horizon).toFixed(0)}" fill="#F8F5FF" opacity="0.06" filter="url(#blur)"/>`);
    parts.push(`<path d="M0 ${H * 0.9} L${W * 0.3} ${H * 0.78} L0 ${H} Z" fill="#05040A" opacity="0.9"/>`);
  }

  // передний план: нерезкая тёмная масса внизу — кадр перестаёт быть плоским
  const fg = 0.9 + rnd(11) * 0.5;
  parts.push(`<path d="M0 ${H} L0 ${(H * 0.93).toFixed(0)} Q ${(W * 0.18).toFixed(0)} ${(H * (0.99 - 0.06 * fg)).toFixed(0)} ${(W * 0.42).toFixed(0)} ${(H * 0.96).toFixed(0)} T ${W} ${(H * 0.9).toFixed(0)} L${W} ${H} Z" fill="#030207" opacity="0.95" filter="url(#blur)"/>`);

  return parts.join('\n');
}

/**
 * Кадр серии: «фотография» под конкретную сцену. Один кадр на сцену — это и
 * есть фото-ряд, который держит 12-минутную историю без съёмок.
 */
export function buildSeriesPlate({
  palette,
  scenery = 'room',
  shot = 'wide',
  seed = '',
  index = 0,
  watermark = 'AI · PULSE',
  title = '',
  episodeLabel = '',
}) {
  const p = palette || PALETTES[hash(seed) % PALETTES.length];
  const h = hash(`${seed}-${index}-${scenery}`);
  const W = 1920;
  const H = 1080;
  const shotZoom = { wide: 1, medium: 1.12, close: 1.28, detail: 1.45 }[shot] || 1;
  const horizon = H * (shot === 'wide' ? 0.60 : 0.64);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#07040E"/>
      <stop offset="38%" stop-color="${p.b}"/>
      <stop offset="76%" stop-color="${p.a}"/>
      <stop offset="100%" stop-color="${p.accent}" stop-opacity="0.55"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.accent}" stop-opacity="0.09"/>
      <stop offset="14%" stop-color="#100B1C" stop-opacity="0.86"/>
      <stop offset="38%" stop-color="#08060F" stop-opacity="0.97"/>
      <stop offset="55%" stop-color="#040308"/>
      <stop offset="100%" stop-color="#010005"/>
    </linearGradient>
    <!-- кинематографическая рамка: затемнение сверху и снизу, как в кино -->
    <linearGradient id="bars" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.55"/>
      <stop offset="14%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="82%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.72"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${p.accent}" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="${p.accent}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="back" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="${p.a}" stop-opacity="0.30"/>
      <stop offset="35%" stop-color="${p.accent}" stop-opacity="0.09"/>
      <stop offset="100%" stop-color="${p.accent}" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="vig" cx="50%" cy="48%" r="72%">
      <stop offset="55%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.85"/>
    </radialGradient>
    <filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="46"/></filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" result="n"/>
      <feColorMatrix in="n" type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.09"/></feComponentTransfer>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <!-- источник света: точечный, как фонарь за кадром. Широкая полоса выглядит дёшево -->
  <circle cx="${W * (0.24 + (h % 50) / 100)}" cy="${(horizon - 90).toFixed(0)}" r="${90 + (h % 60)}" fill="url(#glow)" opacity="0.85" filter="url(#blur)"/>
  <rect x="0" y="${horizon.toFixed(0)}" width="${W}" height="${(H - horizon).toFixed(0)}" fill="url(#ground)"/>

  <g transform="translate(${W / 2} ${H * 0.94}) scale(${shotZoom.toFixed(3)}) translate(${-W / 2} ${-H * 0.94})">
    ${sceneryArt(scenery, h, W, H)}
  </g>

  <!-- туман: три слоя, чтобы силуэты «стояли» в воздухе -->
  <ellipse cx="${W * 0.42}" cy="${(horizon + 20).toFixed(0)}" rx="${W * 0.6}" ry="34" fill="${p.accent}" opacity="0.06" filter="url(#blur)"/>
  <ellipse cx="${W * 0.66}" cy="${(horizon + 80).toFixed(0)}" rx="${W * 0.5}" ry="26" fill="#000000" opacity="0.5" filter="url(#blur)"/>
  <ellipse cx="${W * 0.18}" cy="${(horizon + 140).toFixed(0)}" rx="${W * 0.44}" ry="24" fill="#000000" opacity="0.45" filter="url(#blur)"/>
  <g>
    ${Array.from({ length: 40 }, (_, i) => {
      const x = ((h >> (i % 20)) & 2047) % W;
      const y = ((h >> ((i + 5) % 20)) & 1023) % Math.round(horizon * 0.8);
      return `<circle cx="${x}" cy="${y}" r="${(0.8 + ((h >> (i % 12)) & 7) / 6).toFixed(1)}" fill="#F8F5FF" opacity="${(0.06 + ((h >> (i % 9)) & 15) / 60).toFixed(2)}"/>`;
    }).join('')}
  </g>
  <rect width="${W}" height="${H}" fill="url(#vig)"/>
  <rect width="${W}" height="${H}" fill="url(#bars)"/>
  <rect width="${W}" height="${H}" filter="url(#grain)" opacity="0.72"/>
  <!-- тёплый акцент: один источник света делает кадр «снятым», а не нарисованным -->
  <circle cx="${(W * (0.14 + (h % 60) / 100)).toFixed(0)}" cy="${(H * 0.72).toFixed(0)}" r="${(26 + (h % 16)).toFixed(0)}" fill="#FDE68A" opacity="0.20" filter="url(#blur)"/>
  <g fill="rgba(255,255,255,.34)">
    ${glyphRun(sanitize(watermark).slice(0, 28), { size: 19, x: W - 240, baseline: 62, weight: 'regular', letterSpacing: 3 }).d}
  </g>
  ${title ? `<g fill="rgba(255,255,255,.30)">${glyphRun(sanitize(title).toUpperCase().slice(0, 34), { size: 20, x: 56, baseline: 52, weight: 'regular', letterSpacing: 4 }).d}</g>` : ''}
  ${episodeLabel ? `<g fill="rgba(255,255,255,.30)">${glyphRun(sanitize(episodeLabel).slice(0, 24), { size: 20, x: 56, baseline: 84, weight: 'regular', letterSpacing: 2 }).d}</g>` : ''}
</svg>`;
}

/** Разбивка реплики на субтитры: 2 строки, не больше ~96 знаков на кадр. */
export function splitCaptions(text, { maxChars = 96, maxLines = 2 } = {}) {
  const clean = sanitize(text);
  if (!clean) return [];
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks = [];
  let buf = '';
  const push = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      push();
      const words = sentence.split(' ');
      let line = '';
      for (const w of words) {
        if ((line ? `${line} ${w}` : w).length > maxChars && line) { chunks.push(line); line = w; }
        else line = line ? `${line} ${w}` : w;
      }
      if (line) buf = line;
      continue;
    }
    if ((buf ? `${buf} ${sentence}` : sentence).length > maxChars) push();
    buf = buf ? `${buf} ${sentence}` : sentence;
  }
  push();
  return chunks.slice(0, 6).map((c) => (c.length > maxChars ? `${c.slice(0, maxChars - 1).trim()}…` : c));
}

/** Слой субтитров 16:9: 1–2 строки внизу, с мягкой подложкой без рамок. */
export function buildSeriesCaption({ text, palette, y = 872, maxChars = 96 }) {
  const p = palette || PALETTES[0];
  const clean = sanitize(text);
  if (!clean) return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="none"/></svg>`;
  const { size, lines } = fitTitle(clean, { maxWidth: 1520, maxLines: 2, start: 52, min: 34 });
  const lineHeight = Math.round(size * 1.26);
  const widest = Math.max(...lines.map((l) => measure(l, { size, weight: 'bold' })), 1);
  const bandW = Math.min(1700, widest + 96);
  const bandH = lines.length * lineHeight + 34;
  const bandX = (1920 - bandW) / 2;
  const bandY = y - 6;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <defs>
    <radialGradient id="soft" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#04030A" stop-opacity="0.72"/>
      <stop offset="70%" stop-color="#04030A" stop-opacity="0.44"/>
      <stop offset="100%" stop-color="#04030A" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <ellipse cx="960" cy="${(bandY + bandH / 2).toFixed(0)}" rx="${(bandW / 2 + 90).toFixed(0)}" ry="${(bandH / 2 + 26).toFixed(0)}" fill="url(#soft)"/>
  ${lines.map((line, i) => {
    const w = measure(line, { size, weight: 'bold' });
    const x = (1920 - w) / 2;
    const baseline = bandY + 34 + size + i * lineHeight;
    return `<g fill="#FFFFFF">${glyphRun(line, { size, x, baseline, weight: 'bold', letterSpacing: -0.5 }).d}</g>`;
  }).join('')}
  <rect x="${(960 - 44).toFixed(0)}" y="${(bandY + bandH + 6).toFixed(0)}" width="88" height="2" fill="${p.accent}" opacity="0.45"/>
</svg>`;
}

/** Обложка серии 1280×720 (YouTube): кадр, крупный заголовок, номер серии. */
export function buildSeriesCover({ title = '', episodeLabel = '', projectName = 'PULSE', handle = 'pulse', palette, seed = '', scenery = 'city', badge = 'сериал' }) {
  const p = palette || PALETTES[hash(seed) % PALETTES.length];
  const W = 1280;
  const H = 720;
  const h = hash(`${seed}-cover`);
  const { size, lines } = fitTitle(title, { maxWidth: 1080, maxLines: 2, start: 96, min: 52 });
  const titleTop = H - 96 - lines.length * Math.round(size * 1.08);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#07040E"/>
      <stop offset="52%" stop-color="${p.b}"/>
      <stop offset="100%" stop-color="#030208"/>
    </linearGradient>
    <linearGradient id="veil" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#04030A" stop-opacity="0.30"/>
      <stop offset="46%" stop-color="#04030A" stop-opacity="0.20"/>
      <stop offset="72%" stop-color="#04030A" stop-opacity="0.86"/>
      <stop offset="100%" stop-color="#04030A" stop-opacity="0.97"/>
    </linearGradient>
    <radialGradient id="cglow" cx="72%" cy="30%" r="55%">
      <stop offset="0%" stop-color="${p.accent}" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="${p.accent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="cvig" cx="50%" cy="45%" r="70%">
      <stop offset="50%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.8"/>
    </radialGradient>
    <filter id="cblur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="38"/></filter>
    <filter id="cgrain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="n"/>
      <feColorMatrix in="n" type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.10"/></feComponentTransfer>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#cg)"/>
  <g transform="scale(${(W / 1920).toFixed(4)} ${(H / 1080).toFixed(4)})" opacity="0.95">${sceneryArt(scenery, h, 1920, 1080)}</g>
  <rect width="${W}" height="${H}" fill="url(#cglow)"/>
  <rect width="${W}" height="${H}" fill="url(#veil)"/>
  <rect width="${W}" height="${H}" fill="url(#cvig)"/>
  <rect width="${W}" height="${H}" filter="url(#cgrain)" opacity="0.6"/>

  <!-- верхняя плашка: бренд и жанр. Нижняя треть — под заголовок -->
  <g fill="rgba(255,255,255,.62)">${glyphRun(String(projectName || 'PULSE').toUpperCase().slice(0, 18), { size: 22, x: 52, baseline: 54, weight: 'regular', letterSpacing: 6 }).d}</g>
  <g>
    <rect x="52" y="72" width="${Math.max(150, measure(badge.toUpperCase(), { size: 18, weight: 'regular', letterSpacing: 3 }) + 44)}" height="34" rx="17" fill="#F8F5FF" opacity="0.14"/>
    <g fill="#F8F5FF" opacity="0.9">${glyphRun(badge.toUpperCase(), { size: 18, x: 74, baseline: 95, weight: 'regular', letterSpacing: 3 }).d}</g>
  </g>
  <g fill="${p.accent}">${glyphRun(sanitize(episodeLabel).toUpperCase().slice(0, 34), { size: 21, x: 52, baseline: titleTop - 22, weight: 'regular', letterSpacing: 4 }).d}</g>
  ${lines.map((line, i) => `<g fill="#FFFFFF">${glyphRun(line, { size, x: 52, baseline: titleTop + size + i * Math.round(size * 1.05), weight: 'bold', letterSpacing: -1.2 }).d}</g>`).join('')}
  <rect x="52" y="${H - 52}" width="${Math.max(120, measure(String(handle || 'pulse'), { size: 20, weight: 'regular' }) + 30)}" height="2" fill="${p.accent}" opacity="0.5"/>
  <g fill="rgba(255,255,255,.55)">${glyphRun(`@${String(handle || 'pulse').replace(/^@/, '')}`, { size: 20, x: 52, baseline: H - 24, weight: 'regular', letterSpacing: 1 }).d}</g>
  <g fill="rgba(255,255,255,.35)">${glyphRun('AI · PULSE', { size: 18, x: W - 168, baseline: H - 24, weight: 'regular', letterSpacing: 3 }).d}</g>
</svg>`;
}
