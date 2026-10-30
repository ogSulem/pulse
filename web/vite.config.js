import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SPA собирается в web/dist и раздаётся тем же Node-процессом (server/src/index.js).
// В dev-режиме запросы /api проксируются на локальный API.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Телефоны не всегда свежие: iPhone с iOS 13–15 и старые Android ещё в ходу,
    // а «не заходит с мобильного» чаще всего означает именно это — белый экран
    // на синтаксисе, который браузер не понимает. Собираем под es2019/safari13.
    target: ['es2019', 'safari13', 'chrome79', 'firefox72'],
    // React и ReactDOM меняются редко: отдельный чанк кешируется браузером
    // между деплоями и не тянет за собой весь интерфейс.
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules/react') ? 'react' : undefined),
      },
    },
  },
});
