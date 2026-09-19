import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Read web/.env too (not only VITE_* vars) so the dev proxy follows WEB_PORT.
  const env = { ...loadEnv(mode, import.meta.dirname, ''), ...process.env };
  const apiPort = env.WEB_PORT ?? '8787';

  return {
    root: 'src/client',
    plugins: [react()],
    build: {
      outDir: '../../dist/client',
      emptyOutDir: true,
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        // Regex key: a plain '/api' prefix would also swallow the module /api.ts.
        '^/api/': `http://127.0.0.1:${apiPort}`,
      },
    },
  };
});
