import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { ConfirmHost } from './components/ui/Confirm';
import { PageLoading } from './components/ui/misc';
import { DemoFailed, DemoFrame } from './demo/DemoBar';
import { ApprovalHost } from './lib/approval';
import { DEMO, startDemo } from './lib/demo';
import { PrintHost } from './lib/print';
import { REMOTE } from './lib/remote';
import { initTheme } from './lib/theme';
import { Toaster } from './lib/toast';
import './index.css';

// Demo /demo altında yayınlanır (vite.config.ts); kasada kök
const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || undefined;

// Bar ekranı (/mutfak) ilk karede de koyu: sayfa kendi koyusunu kurana dek beyaz flaş olmasın
initTheme(basename && window.location.pathname.startsWith(basename) ? window.location.pathname.slice(basename.length) || '/' : window.location.pathname);

// LafPOS güncellenince açık kalan tabletin istediği eski parça dosyası artık yoktur: sayfa bir kez yenilenip yeni
// sürümü alır (aynı dakikada ikinci kez yenilemez, döngüye girmez)
window.addEventListener('vite:preloadError', (e) => {
  try {
    const last = Number(sessionStorage.getItem('lafpos.reloadedAt') ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem('lafpos.reloadedAt', String(Date.now()));
  } catch {
    /* depolama yoksa da bir kez yenile */
  }
  e.preventDefault();
  window.location.reload();
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 15_000 },
    mutations: { retry: 0 },
  },
});

// Dokunmatik ekranlı bilgisayar (kasa): fare de bağlı olsa dokunmatik ölçüler açılır (index.css `pointer-coarse`)
try {
  if (navigator.maxTouchPoints > 0 || window.matchMedia('(any-pointer: coarse)').matches) document.documentElement.dataset.touch = '';
} catch {
  /* eski tarayıcı: fare ölçüleri */
}

const root = createRoot(document.getElementById('root')!);

function render() {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={basename}>
          {DEMO ? (
            <DemoFrame>
              <App />
            </DemoFrame>
          ) : (
            <App />
          )}
          <ApprovalHost />
          <ConfirmHost />
          <Toaster />
          <PrintHost />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

if (DEMO) {
  // Tarayıcı demosu: önce sayfanın içindeki LafPOS sunucusu açılır (ilk açılışta örnek gün kurulur)
  root.render(<PageLoading label="LafPOS demosu hazırlanıyor…" delay={0} />);
  startDemo().then(render, (e: unknown) => root.render(<DemoFailed error={e} />));
} else if (REMOTE && !new URLSearchParams(window.location.search).has('uzaktan')) {
  // LafPOS Uzaktan: kafe henüz bağlanmadıysa (yalnız örnek özet var) site tam etkileşimli demoyu açar. Kafe
  // bağlanınca uzaktan görünüm açılır; ?uzaktan=1 örnek özetle uzaktan görünümde kalır. Üyelik açıksa demoya
  // dönülmez: üye girişi görünür (program buradan indirilir), demo giriş ekranında bağlantı olarak durur
  root.render(<PageLoading label="LafPOS açılıyor…" />);
  fetch('/api/uzaktan/kurulum')
    .then((r) => r.json() as Promise<{ demo?: boolean; member?: string }>)
    .then((s) => (s.demo && !s.member ? window.location.replace('/demo/') : render()), render);
} else {
  render();
}
