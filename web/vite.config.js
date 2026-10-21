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
  },
});
