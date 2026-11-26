import { pavoProvider } from './pavo';
import { tokenKabloProvider } from './tokenkablo';
import { tokenxProvider } from './tokenx';
import type { FiscalProvider, ProviderId } from './types';

/** Eğitim cihazı: sepet LafPOS'ta bekler, /cihaz ekranından ödenir; dışarıyla konuşmaz */
export const simulatorProvider: FiscalProvider = {
  id: 'simulator',
  label: 'Eğitim cihazı (simülatör)',
  capabilities: { transport: 'local', instant: true, list: true, splitPayment: true, cancel: true, poll: false, docKinds: ['okc_fis', 'bilgi_fisi'] },
  configured: () => true,
  notConfigured: '',
  terminalId: () => 'SIMULATOR',
  status: () => ({}),
  async send() {},
  async cancel() {},
};

const PROVIDERS: Partial<Record<ProviderId, FiscalProvider>> = {
  tokenx: tokenxProvider,
  tokenkablo: tokenKabloProvider,
  pavo: pavoProvider,
  simulator: simulatorProvider,
};

export function providerFor(id: string): FiscalProvider | null {
  return (PROVIDERS as Record<string, FiscalProvider | undefined>)[id] ?? null;
}

export type { FiscalProvider, FiscalResult, PollOutcome, ProviderId } from './types';
