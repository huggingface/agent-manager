import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API + WebSocket to the backend on :7860.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:7860',
      '/ws': { target: 'ws://localhost:7860', ws: true },
    },
  },
  build: { outDir: 'dist' },
});
