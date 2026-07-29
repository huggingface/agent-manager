import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:7860',
      '/ws': { target: 'ws://localhost:7860', ws: true },
    },
  },
  build: {
    // ghostty-web inlines its ~400KB wasm as a data URL, so the chunk is big by
    // design. Raising the limit keeps the build output readable.
    chunkSizeWarningLimit: 2000,
  },
});
