import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import type { LiveEvent, LiveTopic } from '@shared/events';
import { getToken } from './api';

type Status = 'baglaniyor' | 'canli' | 'kopuk';

export const useLive = create<{ status: Status; lastEventAt: number | null; set: (s: Partial<{ status: Status; lastEventAt: number }>) => void }>((set) => ({
  status: 'baglaniyor',
  lastEventAt: null,
  set: (s) => set(s),
}));

/** Konu → yenilenecek sorgu anahtarları */
const INVALIDATE: Record<LiveTopic, string[][]> = {
  orders: [['orders'], ['floor']],
  tables: [['floor']],
  kitchen: [['kitchen']],
  menu: [['bootstrap']],
  cash: [['cash']],
  settings: [['bootstrap'], ['cash']],
  sync: [['sync']],
  delivery: [['orders'], ['floor']],
  reservations: [['reservations'], ['floor']],
  stock: [['bootstrap']],
  customers: [['customers']],
  users: [['bootstrap'], ['users']],
  alerts: [['alerts'], ['patron']],
  okc: [['okc']],
};

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
export function onLive(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

let controller: AbortController | null = null;
let stopped = true;

/**
 * Sunucu olaylarına bağlanır (fetch akışıyla SSE). Kopunca artan beklemeyle yeniden bağlanır; bağlanınca
 * bütün sorguları bir kez yeniler (kopukken kaçan değişiklikler için).
 */
export function startLive(qc: QueryClient) {
  stopLive();
  stopped = false;
  let retry = 0;
  const connect = async () => {
    if (stopped) return;
    const token = getToken();
    if (!token) return;
    controller = new AbortController();
    useLive.getState().set({ status: 'baglaniyor' });
    try {
      const res = await fetch('/api/events', { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      if (retry > 0) qc.invalidateQueries();
      retry = 0;
      useLive.getState().set({ status: 'canli' });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleChunk(qc, chunk);
        }
      }
    } catch {
      /* bağlantı koptu */
    }
    if (stopped) return;
    useLive.getState().set({ status: 'kopuk' });
    retry += 1;
    setTimeout(connect, Math.min(10_000, 500 * 2 ** retry));
  };
  connect();
}

export function stopLive() {
  stopped = true;
  controller?.abort();
  controller = null;
}

function handleChunk(qc: QueryClient, chunk: string) {
  let event = 'message';
  let data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (event !== 'live' || !data) return;
  let e: LiveEvent;
  try {
    e = JSON.parse(data);
  } catch {
    return;
  }
  useLive.getState().set({ lastEventAt: Date.now() });
  for (const key of INVALIDATE[e.topic] ?? []) qc.invalidateQueries({ queryKey: key });
  // Gün açılıp kapanınca açılış verisindeki açık gün (Z no, raporların "Bugün"ü) her cihazda yenilenir
  if (e.topic === 'cash' && e.kind.startsWith('day.')) qc.invalidateQueries({ queryKey: ['bootstrap'] });
  if (e.orderId) qc.invalidateQueries({ queryKey: ['order', e.orderId] });
  for (const fn of listeners) fn(e);
}
