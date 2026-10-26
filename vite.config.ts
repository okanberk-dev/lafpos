import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_PORT = Number(process.env.LAFPOS_PORT ?? 4000);

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    outDir: 'dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
