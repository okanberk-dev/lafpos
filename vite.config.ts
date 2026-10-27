import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { lafposDemo } from './demo/vite-plugin';

const API_PORT = Number(process.env.LAFPOS_PORT ?? 4000);

export default defineConfig(({ mode }) => {
  // Tarayıcı demosu (docs/DEMO.md): sunucu da pakete girer, /demo altında yayınlanır
  const demo = mode === 'demo';
  return {
    base: demo ? '/demo/' : '/',
    plugins: [react(), tailwindcss(), lafposDemo({ server: demo, builtins: demo })],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      },
    },
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': { target: `http://localhost:${API_PORT}` },
        '/uploads': { target: `http://localhost:${API_PORT}` },
      },
    },
    build: {
      outDir: demo ? 'dist/web/demo' : 'dist/web',
      emptyOutDir: true,
      chunkSizeWarningLimit: 1200,
    },
  };
});
