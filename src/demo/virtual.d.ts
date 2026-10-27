/** Demo çalışma zamanının kapısı (demo/vite-plugin.ts); demo dışındaki derlemede boş */
declare module 'virtual:lafpos-demo' {
  import type { DemoServer } from '@shared/demo';
  export function startDemoServer(): Promise<DemoServer>;
}
