import { describe, expect, it } from 'vitest';
import { karaokeAlertText, type OnlineAlertDTO, type TableCallDTO, tableCallText } from '@shared/site-alerts';
import { BELL_PARTIALS, RING_NOTES_HZ, ringMotif } from '../src/lib/bell';
import {
  ACK_KEEP_MS,
  addAcks,
  ALERT_PREFS_DEFAULT,
  type AlertPrefs,
  alertPerms,
  callsTitle,
  notYetDue,
  onlineAckKey,
  onlineAckKeys,
  onlineRingActive,
  parseAcks,
  parseAlertPrefs,
  pendingCalls,
  pendingOnline,
  pendingTitle,
  ringLevel,
  setOnlineRinger,
  siteEventCue,
  VOLUME_STEPS,
  volumeStep,
} from '../src/lib/siteAlerts';

/**
 * Sesli uyarıların istemci kuralları (docs/03-ENTEGRASYON.md §2.5; src/lib/siteAlerts.ts, src/lib/alertPrefs.ts):
 * hangi online sipariş çalar ve ne zaman susar, olay → ses ve bildirim, cihaz tercihleri, sitenin zil motifi
 * (src/lib/bell.ts). DOM'suz modüller: sunucu tsconfig'i testleri DOM tipleri olmadan denetler.
 */
const NOW = Date.parse('2026-11-20T15:00:00Z');
const order = (o: Partial<OnlineAlertDTO> & { orderId: string }): OnlineAlertDTO => ({ no: 1, label: 'Gel-al', table: false, tableId: null, openedAt: NOW - 60_000, ...o });
const prefs = (p: Partial<AlertPrefs> = {}): AlertPrefs => ({ ...ALERT_PREFS_DEFAULT, ...p });
const ALL = { online: true, karaoke: true };

describe('online sipariş: kuyruk', () => {
  const data = { online: [order({ orderId: 'b', openedAt: NOW - 30_000 }), order({ orderId: 'a', openedAt: NOW - 120_000, table: true, label: 'Masa 4' })] };

  it('bekleyenler en eskisi önce', () => {
    expect(pendingOnline(data, {}, prefs(), ALL, NOW).map((o) => o.orderId)).toEqual(['a', 'b']);
  });

  it('susar: bu cihazda Gördüm, ekranda açık, 4 saat geçti; yetki ya da tercih kapalıysa hiç yok', () => {
    expect(pendingOnline(data, { a: NOW - 1000 }, prefs(), ALL, NOW).map((o) => o.orderId)).toEqual(['b']);
    expect(pendingOnline(data, {}, prefs(), ALL, NOW, 'b').map((o) => o.orderId)).toEqual(['a']);
    expect(pendingOnline(data, {}, prefs(), ALL, NOW + 4 * 3600_000 - 60_000).map((o) => o.orderId)).toEqual(['b']);
    expect(pendingOnline(data, {}, prefs(), ALL, NOW + 4 * 3600_000)).toEqual([]);
    expect(pendingOnline(data, {}, prefs({ online: false }), ALL, NOW)).toEqual([]);
    expect(pendingOnline(data, {}, prefs(), { online: false }, NOW)).toEqual([]);
    expect(pendingOnline(undefined, {}, prefs(), ALL, NOW)).toEqual([]);
  });

  it('planlı sipariş: 4 saat planlı saatinden 30 dk önce başlar (dueAt); eski sunucuda ödeme anı', () => {
    const planned = { online: [order({ orderId: 'p', openedAt: NOW - 30 * 3600_000, dueAt: NOW - 60_000 })] };
    expect(pendingOnline(planned, {}, prefs(), ALL, NOW).map((o) => o.orderId)).toEqual(['p']);
    expect(pendingOnline(planned, {}, prefs(), ALL, NOW + 4 * 3600_000)).toEqual([]);
    expect(pendingOnline({ online: [order({ orderId: 'p', openedAt: NOW - 30 * 3600_000 })] }, {}, prefs(), ALL, NOW)).toEqual([]);
  });

  it('acked before dueAt rings at dueAt: planlı sipariş saati gelmeden çalmaz, saatinden önce denen Gördüm saatini susturmaz', () => {
    const due = NOW + 2 * 3600_000;
    const p = order({ orderId: 'p', openedAt: NOW - 60_000, dueAt: due, scheduledFor: new Date(due + 30 * 60_000).toISOString() });
    const data = { online: [p] };
    // Saati gelmedi: çalmaz, Gördüm yazılmaz (aşaması ya da masası değişse, ekranda açılsa da)
    expect(notYetDue(p, NOW)).toBe(true);
    expect(pendingOnline(data, {}, prefs(), ALL, NOW)).toEqual([]);
    expect(onlineAckKeys(data.online, ['p'], NOW)).toEqual([]);
    // Saatinden önce denen Gördüm: eski istemci ödeme anında çalar, yalnız kimlikle yazardı
    const early = addAcks({}, ['p', ...onlineAckKeys(data.online, ['p'], NOW)], NOW);
    expect(early).toEqual({ p: NOW });
    expect(pendingOnline(data, early, prefs(), ALL, due - 1)).toEqual([]);
    expect(pendingOnline(data, early, prefs(), ALL, due).map((o) => o.orderId)).toEqual(['p']);
    // Saatinde denen Gördüm susturur (anahtar saatiyle)
    expect(onlineAckKeys(data.online, ['p'], due)).toEqual([`p@${due}`]);
    const seen = addAcks(early, onlineAckKeys(data.online, ['p'], due), due);
    expect(pendingOnline(data, seen, prefs(), ALL, due + 60_000)).toEqual([]);
    // Saati sitede değişti: yeni saatinde yine çalar
    const moved = { online: [{ ...p, dueAt: due + 3600_000 }] };
    expect(pendingOnline(moved, seen, prefs(), ALL, due + 60_000)).toEqual([]);
    expect(pendingOnline(moved, seen, prefs(), ALL, due + 3600_000).map((o) => o.orderId)).toEqual(['p']);
  });

  it('planlı olmayan sipariş cihazın saati biraz geride olsa da hemen çalar; Gördüm kimlikle, listede olmayan kimlik olduğu gibi', () => {
    const n = order({ orderId: 'n', openedAt: NOW + 5_000, dueAt: NOW + 5_000 });
    expect(notYetDue(n, NOW)).toBe(false);
    expect(onlineAckKey(n)).toBe('n');
    expect(pendingOnline({ online: [n] }, {}, prefs(), ALL, NOW).map((o) => o.orderId)).toEqual(['n']);
    expect(onlineAckKeys([n], ['n', 'yok'], NOW)).toEqual(['n', 'yok']);
    expect(pendingOnline({ online: [n] }, addAcks({}, onlineAckKeys([n], ['n'], NOW), NOW), prefs(), ALL, NOW)).toEqual([]);
  });

  it('Gördüm 24 saat hatırlanır; bozuk kayıt düşer', () => {
    const acks = addAcks({ eski: NOW - ACK_KEEP_MS - 1 }, ['a', 'b'], NOW);
    expect(acks).toEqual({ a: NOW, b: NOW });
    expect(parseAcks(JSON.stringify(acks), NOW + ACK_KEEP_MS - 1)).toEqual(acks);
    expect(parseAcks(JSON.stringify(acks), NOW + ACK_KEEP_MS)).toEqual({});
    expect(parseAcks('{"a":"x","b":1e99}', NOW)).toEqual({});
    expect(parseAcks('[1]', NOW)).toEqual({});
    expect(parseAcks('bozuk', NOW)).toEqual({});
    expect(parseAcks(null, NOW)).toEqual({});
  });

  it('zil düzeyi: masa siparişi tam, diğerleri 0,8; cihazın ses düzeyiyle çarpılır', () => {
    expect(ringLevel([{ table: false }, { table: true }], 1)).toBe(1);
    expect(ringLevel([{ table: false }], 1)).toBe(0.8);
    expect(ringLevel([{ table: true }], 0.35)).toBe(0.35);
    expect(ringLevel([{ table: true }], 3)).toBe(1);
  });

  it('şeridin başlığı', () => {
    expect(pendingTitle(1)).toBe('Yeni online sipariş');
    expect(pendingTitle(3)).toBe('3 yeni online sipariş');
  });

  it('yetki: online siparişi alan ya da bar, karaokeyi alan ya da rezervasyoncu', () => {
    const of = (perms: string[]) => alertPerms((p) => perms.includes(p));
    expect(of(['mutfak.ekran'])).toEqual({ online: true, karaoke: false });
    expect(of(['rezervasyon.yonet'])).toEqual({ online: false, karaoke: true });
    expect(of(['siparis.al'])).toEqual({ online: true, karaoke: true });
    expect(of(['paket.yonet'])).toEqual({ online: false, karaoke: false });
  });
});

describe('masa çağrısı: kuyruk', () => {
  const call = (c: Partial<TableCallDTO> & { id: string }): TableCallDTO => ({ label: 'S4', reason: 'water', tableId: 't1', createdAt: NOW - 60_000, ...c });
  const data = { calls: [call({ id: 'tcl-b', createdAt: NOW - 30_000 }), call({ id: 'tcl-a', createdAt: NOW - 120_000, reason: 'waiter' })] };

  it('en eskisi önce; bu cihazda Gördüm, 15 dakika ya da kapalı yetki ve tercih susturur; eski sunucu alanı göndermez', () => {
    expect(pendingCalls(data, {}, prefs(), ALL, NOW).map((c) => c.id)).toEqual(['tcl-a', 'tcl-b']);
    expect(pendingCalls(data, { 'tcl-a': NOW }, prefs(), ALL, NOW).map((c) => c.id)).toEqual(['tcl-b']);
    expect(pendingCalls(data, {}, prefs(), ALL, NOW - 30_000 + 15 * 60_000).map((c) => c.id)).toEqual([]);
    expect(pendingCalls(data, {}, prefs(), ALL, NOW - 31_000 + 15 * 60_000).map((c) => c.id)).toEqual(['tcl-b']);
    expect(pendingCalls(data, {}, prefs({ online: false }), ALL, NOW)).toEqual([]);
    expect(pendingCalls(data, {}, prefs(), { online: false }, NOW)).toEqual([]);
    expect(pendingCalls({}, {}, prefs(), ALL, NOW)).toEqual([]);
    expect(pendingCalls(undefined, {}, prefs(), ALL, NOW)).toEqual([]);
  });

  it('metin yalnız masa ve sebep; bilinmeyen sebep "Çağırıyor"; şeridin başlığı', () => {
    expect(tableCallText({ label: 'Masa 4', reason: 'water' })).toBe('Masa 4 · Su istiyor');
    expect(tableCallText({ label: 'S4', reason: 'waiter' })).toBe('S4 · Garson çağırıyor');
    expect(tableCallText({ label: 'S4', reason: 'napkin' })).toBe('S4 · Peçete istiyor');
    expect(tableCallText({ label: 'S4', reason: 'bill' })).toBe('S4 · Çağırıyor');
    expect(callsTitle(1)).toBe('Masa çağrısı');
    expect(callsTitle(2)).toBe('2 masa çağrısı');
  });
});

describe('olay → ses ve bildirim', () => {
  const ev = (topic: 'orders' | 'reservations' | 'kitchen', kind: string, message?: string, orderId?: string) => ({ topic, kind, message, orderId });

  it('yeni online sipariş: liste yenilenir, bildirim; zili döngü çalar (tek seferlik ses yok)', () => {
    expect(siteEventCue(ev('orders', 'online.new', 'Online sipariş: Masa 4 · Ayşe'), prefs(), ALL)).toEqual({ refetch: true, toast: { tone: 'info', text: 'Online sipariş: Masa 4 · Ayşe' } });
    expect(siteEventCue(ev('orders', 'online.new', 'x'), prefs({ online: false }), ALL)).toEqual({ refetch: true });
  });

  it('aşaması değişti: o siparişin zili bu cihazda susar', () => {
    expect(siteEventCue(ev('orders', 'online.updated', undefined, 'o1'), prefs(), ALL)).toEqual({ refetch: true, ack: 'o1' });
    expect(siteEventCue(ev('orders', 'online.stage', undefined, 'o1'), prefs(), ALL)).toEqual({ refetch: true });
  });

  it('siteden kalktı: tek sakin nota ve bildirim; ses kapalıyken yalnız bildirim', () => {
    const gone = ev('orders', 'online.done', 'Online sipariş #10101 siteden kalktı', 'o1');
    expect(siteEventCue(gone, prefs(), ALL)).toEqual({ refetch: true, sound: 'tek', toast: { tone: 'info', text: 'Online sipariş #10101 siteden kalktı' } });
    expect(siteEventCue(gone, prefs({ sound: false }), ALL)).toEqual({ refetch: true, toast: { tone: 'info', text: 'Online sipariş #10101 siteden kalktı' } });
    expect(siteEventCue(gone, prefs(), { online: false, karaoke: true })).toBeNull();
  });

  it('karaoke: yeni zil, iptal inen ses, değişen tek nota; tercih ya da yetki kapalıysa hiçbiri', () => {
    const m = 'Karaoke 20:00 · 2 sa · 4 kişi';
    expect(siteEventCue(ev('reservations', 'site.karaoke.new', m), prefs(), ALL)).toEqual({ sound: 'ring', toast: { tone: 'info', text: `Yeni rezervasyon · ${m}` } });
    expect(siteEventCue(ev('reservations', 'site.karaoke.cancelled', m), prefs(), ALL)).toEqual({ sound: 'iptal', toast: { tone: 'warn', text: `Rezervasyon iptal · ${m}` } });
    expect(siteEventCue(ev('reservations', 'site.karaoke.moved', m), prefs(), ALL)).toEqual({ sound: 'tek', toast: { tone: 'info', text: `Rezervasyon değişti · ${m}` } });
    expect(siteEventCue(ev('reservations', 'site.karaoke.new', m), prefs({ karaoke: false }), ALL)).toBeNull();
    expect(siteEventCue(ev('reservations', 'site.karaoke.new', m), prefs(), { online: true, karaoke: false })).toBeNull();
    // Listenin değiştiğini söyleyen genel olay ve ilgisiz olaylar ses vermez
    expect(siteEventCue(ev('reservations', 'site.karaoke'), prefs(), ALL)).toBeNull();
    expect(siteEventCue(ev('orders', 'order.sent'), prefs(), ALL)).toBeNull();
    expect(siteEventCue(ev('kitchen', 'ticket.new', 'online'), prefs(), ALL)).toBeNull();
  });

  it('masa çağrısı: yeni çağrı liste yenilenir ve bildirim (zili döngü çalar); yanıtlanan yalnız yenilenir', () => {
    const tables = (kind: string, message?: string) => ({ topic: 'tables' as const, kind, message });
    expect(siteEventCue(tables('site.call.new', 'S4 · Su istiyor'), prefs(), ALL)).toEqual({ refetch: true, toast: { tone: 'info', text: 'Masa çağrısı · S4 · Su istiyor' } });
    expect(siteEventCue(tables('site.call.new', 'S4 · Su istiyor'), prefs({ online: false }), ALL)).toEqual({ refetch: true });
    expect(siteEventCue(tables('site.call.done'), prefs(), ALL)).toEqual({ refetch: true });
    expect(siteEventCue(tables('site.call.new', 'S4 · Su istiyor'), prefs(), { online: false, karaoke: true })).toBeNull();
    // Masa planının öteki olayları uyarı değildir
    expect(siteEventCue(tables('online.sync'), prefs(), ALL)).toBeNull();
    expect(siteEventCue(tables('table.updated'), prefs(), ALL)).toBeNull();
  });

  it('bar ekranı online fişte çift ses çalmaz: kabuğun zili açıkken işaret', () => {
    expect(onlineRingActive()).toBe(false);
    setOnlineRinger(true);
    expect(onlineRingActive()).toBe(true);
    setOnlineRinger(false);
  });

  it('karaoke metni: saat, süre, kişi; kişi bilinmiyorsa yazılmaz', () => {
    expect(karaokeAlertText({ startHour: 9, hours: 1, guests: 0 })).toBe('Karaoke 09:00 · 1 sa');
    expect(karaokeAlertText({ startHour: 20, hours: 2, guests: 4 })).toBe('Karaoke 20:00 · 2 sa · 4 kişi');
  });
});

describe('cihaz tercihleri', () => {
  it('varsayılan açık, orta düzey; bozuk ya da eksik alan varsayılanına döner', () => {
    expect(parseAlertPrefs(null)).toEqual({ sound: true, volume: 0.8, online: true, karaoke: true });
    expect(parseAlertPrefs('bozuk')).toEqual(ALERT_PREFS_DEFAULT);
    expect(parseAlertPrefs('[]')).toEqual(ALERT_PREFS_DEFAULT);
    expect(parseAlertPrefs('{"sound":false,"volume":7,"karaoke":"evet"}')).toEqual({ sound: false, volume: 1, online: true, karaoke: true });
    expect(parseAlertPrefs('{"volume":-1,"online":false}')).toEqual({ sound: true, volume: 0, online: false, karaoke: true });
  });

  it('ses düzeyi üç adım; kayıtlı değer en yakın adıma', () => {
    expect(VOLUME_STEPS.map((s) => s.label)).toEqual(['Kısık', 'Orta', 'Yüksek']);
    expect(volumeStep(0.8)).toBe('orta');
    expect(volumeStep(0.3)).toBe('kisik');
    expect(volumeStep(0.95)).toBe('yuksek');
    expect(volumeStep(0)).toBe('kisik');
  });
});

describe('zil: sitenin motifi (laffogato order-alerts-core.ts)', () => {
  it('Do6, Mi6, Sol6 iki kez; son nota uzun çınlar; üç tını', () => {
    expect(RING_NOTES_HZ).toEqual([1046.5, 1318.5, 1568]);
    expect(BELL_PARTIALS.map((p) => p.ratio)).toEqual([1, 2.76, 5.4]);
    const notes = ringMotif();
    expect(notes.map((n) => n.at)).toEqual([0, 0.11, 0.22, 0.5, 0.61, 0.72]);
    expect(notes.map((n) => n.decay)).toEqual([0.32, 0.32, 0.6, 0.32, 0.32, 0.6]);
  });
});
