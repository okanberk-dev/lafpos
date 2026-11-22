import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { lafposDemo } from './demo/vite-plugin';

export default defineConfig({
  // Arayüz bileşenini (ör. fiş, src/lib/print.tsx) sunucuda çizen testler için: uygulamanın derlemesi gibi otomatik JSX
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  test: {
    testTimeout: 20000,
    projects: [
      { extends: true, test: { name: 'node', environment: 'node', include: ['tests/**/*.test.ts'] } },
      // Aynı sunucu testleri tarayıcı demosunun veritabanıyla (sql.js): demo kasayla aynı kuralları işletir
      {
        extends: true,
        plugins: [lafposDemo({ server: true, builtins: false })],
        test: { name: 'sqljs', environment: 'node', include: ['tests/**/*.test.ts'], setupFiles: ['demo/test-setup.ts'] },
      },
    ],
  },
});
