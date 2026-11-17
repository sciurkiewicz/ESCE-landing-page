import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Preserve the browser-facing Host so the API can enforce same-origin writes.
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
  build: { target: 'es2023' },
});
