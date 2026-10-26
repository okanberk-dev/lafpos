import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

function Placeholder() {
  return (
    <main className="grid h-full place-items-center p-6 text-center">
      <div>
        <h1 className="text-3xl font-semibold text-forest-700">LafPOS</h1>
        <p className="mt-2 text-muted">Dalga 0: plan ve iskelet hazır, çekirdek POS Dalga 1'de</p>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
);
