import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Keep the configured dev origin exact: never silently choose the next port.
// Set PORT on the backend and AM_API_PORT here for a non-default backend.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'AM_');
  const apiPort = env.AM_API_PORT || '7860';
  return {
    plugins: [react()],
    server: {
      port: Number(env.AM_DEV_PORT || 5173),
      strictPort: true,
      proxy: {
        '/api': `http://localhost:${apiPort}`,
        '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
      },
    },
    build: { outDir: 'dist' },
  };
});
