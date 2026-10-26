import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { ApprovalHost } from './lib/approval';
import { PrintHost } from './lib/print';
import { initTheme } from './lib/theme';
import { Toaster } from './lib/toast';
import './index.css';

initTheme();

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <ApprovalHost />
        <Toaster />
        <PrintHost />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
