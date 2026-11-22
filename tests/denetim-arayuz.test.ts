import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOWNLOAD_NAV, MERKEZ_NAV } from '../src/lib/download';
import { navAllowed } from '../src/lib/nav';

/** 21 Kasım denetiminin arayüz bulguları (bileşen davranışı kaynaktan ve saf yardımcılardan denetlenir) */
const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('komut paleti (bulgu 33)', () => {
  it('yetki istemeyen uzaktan ekranlar (Merkez, İndir) paletten de bulunur; menüyle aynı kural', () => {
    const none = () => false;
    expect(navAllowed(MERKEZ_NAV, none)).toBe(true);
    expect(navAllowed(DOWNLOAD_NAV, none)).toBe(true);
    expect(src('src/components/CommandPalette.tsx')).toMatch(/navAllowed\(n, can\)/);
  });
});

describe('telefon bildirimleri kartı (bulgu 32)', () => {
  it('yalnız senkron.yonet yetkisiyle görünür; hata iskelette kalmaz', () => {
    expect(src('src/pages/admin/NetworkAdmin.tsx')).toMatch(/n\.cloud\?\.configured && can\('senkron\.yonet'\) && \(\s*<div className="lg:col-span-2">\s*<NotifyCard/);
    expect(src('src/components/admin/NotifyCard.tsx')).toMatch(/q\.isError \? \(\s*<ErrorState/);
  });
});

describe('bildirim aboneliği (bulgu 31)', () => {
  it('site aboneliği yazamazsa tarayıcıdaki abonelik bırakılır: kart "Açık" demez, düğme yeniden görünür', () => {
    const push = src('src/lib/push.ts');
    const enable = push.slice(push.indexOf('export async function enablePush'), push.indexOf('export async function disablePush'));
    expect(enable).toMatch(/catch \(e\) \{[^}]*await sub\.unsubscribe\(\)/);
  });
});

describe('Merkez dükkân penceresi (bulgu 30)', () => {
  it('düğme grubu <label> içinde değil: etikete dokunmak lisansı ya da kipi ilk seçeneğe çevirmez', () => {
    const page = src('src/pages/MerkezPage.tsx');
    expect(page).not.toMatch(/<Field[^>]*>\s*<Segmented/);
  });
});

describe('dükkân seçici (bulgu 29)', () => {
  it('bilgisayar ve tablet başlığında da var (telefonun üst şeridi dışında)', () => {
    const shell = src('src/components/AppShell.tsx');
    expect(shell.match(/<RemoteShopPicker \/>/g)?.length).toBeGreaterThanOrEqual(2);
    expect(shell).toMatch(/\{REMOTE && <RemoteShopPicker \/>\}\s*\{healthPill\}/);
  });
});

describe('çevrimdışı gönderim kuyruğu (bulgu 17/20/27/28)', () => {
  it('kuyruğa giren satırlar sepetten çıkar: sonra silmek ya da azaltmak gönderimi değiştirmez', async () => {
    const { useCart, queueBatch, flushBatch } = await import('../src/lib/cart');
    const o = 'o-kuyruk';
    useCart.getState().add(o, { productId: 'latte', size: 'TEK', qty: 2, options: [], note: '' });
    const lines = useCart.getState().byOrder[o]!;
    queueBatch(o, { id: 'b1', lines, hold: false, at: 1 });
    expect(useCart.getState().byOrder[o]).toBeUndefined();
    // Garson "Gönderilmemişleri sil" der: kuyruktaki gönderim sepette değil, ona dokunulmaz ve sessizce gitmez sanılmaz
    useCart.getState().clear(o);
    let posted = 0;
    const offline = Object.assign(new Error('yok'), { status: 0 });
    expect(await flushBatch(o, useCart.getState().batches[o]!, async () => { throw offline; })).toBe('queued');
    expect(await flushBatch(o, useCart.getState().batches[o]!, async () => { posted++; })).toBe('sent');
    expect(posted).toBe(1);
    expect(useCart.getState().batches[o]).toBeUndefined();
  });

  it('kasa reddederse satırlar sepete döner; aynı adisyon iki yerden aynı anda gönderilmez', async () => {
    const { useCart, queueBatch, flushBatch, claimSend, releaseSend } = await import('../src/lib/cart');
    const o = 'o-ret';
    useCart.getState().add(o, { productId: 'latte', size: 'TEK', qty: 1, options: [], note: '' });
    queueBatch(o, { id: 'b2', lines: useCart.getState().byOrder[o]!, hold: false, at: 1 });
    expect(claimSend(o)).toBe(true);
    expect(await flushBatch(o, useCart.getState().batches[o]!, async () => undefined)).toBe('busy');
    releaseSend(o);
    const rejected = Object.assign(new Error('tükendi'), { status: 409 });
    expect(await flushBatch(o, useCart.getState().batches[o]!, async () => { throw rejected; })).toBe('rejected');
    expect(useCart.getState().batches[o]).toBeUndefined();
    expect(useCart.getState().byOrder[o]?.[0]?.qty).toBe(1);
  });

  it('yeniden deneme uygulama düzeyinde (adisyon ekranından çıkınca da), adisyon ekranında ayrı döngü yok', () => {
    expect(src('src/pages/order/OrderPage.tsx')).not.toMatch(/setInterval/);
    expect(src('src/components/AppShell.tsx')).toMatch(/useOutbox\(boot\)/);
  });
});
