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
