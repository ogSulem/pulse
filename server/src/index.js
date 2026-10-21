import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from './core/db.js';
import { api } from './modules/api.js';
import { drain, jobStats, recoverStale, cleanupJobs } from './core/queue.js';
import { log } from './core/logger.js';
import { seedIfEmpty } from './seed/seed.js';
import './engine/pipeline.js'; // регистрирует обработчики конвейера
import { collectAnalytics, sweepDueEpisodes, recoverEpisodeStates } from './engine/pipeline.js';
import { enqueue } from './core/queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PULSE_PORT || 8080);

app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Базовая гигиена ответов. Важно: не ставим X-Frame-Options — панель
// открывается во встроенном предпросмотре и может быть встроена в iframe.
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use('/api', api);

// ── Статика SPA ─────────────────────────────────────────────────────────────
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { index: false, maxAge: '1h', extensions: ['html'] }));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.type('html').send(`
    <body style="background:#0b0710;color:#eee;font-family:system-ui;padding:48px;line-height:1.6">
      <h1 style="color:#a78bfa">Pulse API работает</h1>
      <p>Фронтенд ещё не собран. Выполните <code>npm run build</code> или используйте Docker-образ (сборка включена).</p>
      <p>API: <a style="color:#c4b5fd" href="/api/health">/api/health</a></p>
    </body>`));
}

// ── Старт ───────────────────────────────────────────────────────────────────
migrate();
seedIfEmpty();
log({ level: 'info', actor: 'system', action: 'server.start', message: `Pulse запущен в режиме ${process.env.PULSE_MODE || 'demo'}` });

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ▲ Pulse — панель управления контент-конвейером`);
  console.log(`  → http://localhost:${PORT}  (режим: ${process.env.PULSE_MODE || 'demo'})`);
  console.log(`  → API: http://localhost:${PORT}/api/health\n`);
});

// ── Планировщик: разбирает очередь и обновляет аналитику ────────────────────
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await drain(4);
    const lastAutopilot = Number(globalThis.__lastAutopilot || 0);
    if (Date.now() - lastAutopilot > 20000) {
      globalThis.__lastAutopilot = Date.now();
      enqueue('autopilot.tick', {}, { delayMs: 0, priority: 8 });
      collectAnalytics();
      sweepDueEpisodes();
    }
    if (Date.now() - Number(globalThis.__lastCleanup || 0) > 600000) {
      globalThis.__lastCleanup = Date.now();
      cleanupJobs();
    }
    if (Date.now() - Number(globalThis.__lastRecover || 0) > 60000) {
      globalThis.__lastRecover = Date.now();
      recoverStale();
      recoverEpisodeStates();
    }
  } catch (err) {
    log({ level: 'error', actor: 'scheduler', action: 'scheduler.error', message: String(err.message || err) });
  } finally {
    ticking = false;
  }
}
setInterval(tick, 3000);
setTimeout(tick, 800);

process.on('SIGTERM', () => {
  console.log('Pulse: graceful shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000);
});

process.on('unhandledRejection', (err) => {
  log({ level: 'error', actor: 'system', action: 'unhandled.rejection', message: String(err?.message || err) });
});
