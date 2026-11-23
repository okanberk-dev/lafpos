import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import type { DisplayStateDTO } from '@shared/types';
import { staleReload } from '../src/lib/staleReload';
import { type Harness, startApp } from './harness';

/** Müşteri ekranı: kasa yazar, ekran okur; şekli ve boyutu sınırlı, yalnız bellekte */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.login('bar', '3333');
});
afterAll(() => h.cleanup());

describe('müşteri ekranı', () => {
  it('kasa yazar, ekran okur; bar yazamaz; ad ve şekil denetlenir', async () => {
    // Ekran oturumsuz okur (müşteriye dönük tablet personel girişi istemez)
    expect((await h.ok<DisplayStateDTO>('', 'GET', '/public/display/kasa')).kind).toBe('idle');
    const order = { kind: 'order', label: 'Tezgâh', lines: [{ name: 'Latte', size: 'Orta', qty: 2, options: 'Yulaf sütü', total: 39000 }], discount: 0, total: 39000, paid: 0, due: 39000 };
    await h.ok('kasa', 'PUT', '/display/kasa', order);
    const seen = await h.ok<DisplayStateDTO>('', 'GET', '/public/display/kasa');
    expect(seen).toMatchObject({ kind: 'order', total: 39000, lines: [{ name: 'Latte', qty: 2 }] });
    expect((await h.call('bar', 'PUT', '/display/kasa', { kind: 'idle' })).status).toBe(403);
    // Garson müşterinin gördüğü tutarı değiştiremez
    expect((await h.call('garson', 'PUT', '/display/kasa', { kind: 'idle' })).status).toBe(403);
    expect((await h.call('kasa', 'PUT', '/display/Kasa Ekran', { kind: 'idle' })).status).toBe(400);
    expect((await h.call('kasa', 'PUT', '/display/kasa', { kind: 'order', label: 'x', lines: [], discount: -1, total: 0, paid: 0, due: 0 })).status).toBe(422);
    await h.ok('kasa', 'PUT', '/display/kasa', { kind: 'thanks', total: 39000 });
    expect((await h.ok<DisplayStateDTO>('', 'GET', '/public/display/kasa')).kind).toBe('thanks');
  });

  it('ekran durumu canlı olay yaymaz: ekran yoklar, kasa adisyonu 10 saniyede bir yeniden gönderir (inceleme, 23 Kas 2026)', async () => {
    const { bus } = await import('../server/lib/events');
    const events: LiveEvent[] = [];
    const listen = (e: LiveEvent) => void events.push(e);
    bus.on('event', listen);
    try {
      const order = { kind: 'order', label: 'Tezgâh', lines: [{ name: 'Latte', size: 'Orta', qty: 1, options: '', total: 19500 }], discount: 0, total: 19500, paid: 0, due: 19500 };
      // Kasanın tazelemesi: aynı görüntü üç kez, sonra teşekkür
      for (let i = 0; i < 3; i++) await h.ok('kasa', 'PUT', '/display/kasa', order);
      await h.ok('kasa', 'PUT', '/display/kasa', { kind: 'thanks', total: 19500 });
    } finally {
      bus.off('event', listen);
    }
    // Olay her cihazda adisyon ve masa sorgularını yeniletiyor, Uzaktan özetini kuruyordu
    expect(events).toEqual([]);
    expect(await h.ok<DisplayStateDTO>('', 'GET', '/public/display/kasa')).toMatchObject({ kind: 'thanks', total: 19500 });
  });

  it('teşekkürde self servisin çağrı numarası; eski kasa göndermezse yok, uzunu reddedilir', async () => {
    await h.ok('kasa', 'PUT', '/display/kasa', { kind: 'thanks', total: 39000, call: 'No 34' });
    expect(await h.ok<DisplayStateDTO>('', 'GET', '/public/display/kasa')).toMatchObject({ kind: 'thanks', total: 39000, call: 'No 34' });
    await h.ok('kasa', 'PUT', '/display/kasa', { kind: 'thanks', total: 39000 });
    expect(await h.ok<DisplayStateDTO>('', 'GET', '/public/display/kasa')).not.toHaveProperty('call');
    expect((await h.call('kasa', 'PUT', '/display/kasa', { kind: 'thanks', total: 39000, call: 'x'.repeat(17) })).status).toBe(422);
  });
});

describe('yanıtsız kalan ekranın yenilenmesi (inceleme, 23 Kas 2026)', () => {
  it('kasa yanıt vermezken yenilenmez (tarayıcının hata sayfası gelirdi); yanıt verince yenilenir', async () => {
    let up = false;
    let probes = 0;
    let reloads = 0;
    const check = staleReload(
      async () => {
        probes++;
        return up;
      },
      () => void reloads++,
      30_000,
    );
    await check(100_000);
    expect([probes, reloads]).toEqual([1, 0]);
    // Ekran her 2 sn'de bakar; soru en sık 30 sn'de bir
    await check(102_000);
    expect(probes).toBe(1);
    up = true;
    await check(130_000);
    expect([probes, reloads]).toEqual([2, 1]);
    // Ağ hatası (soru reddedildi) da yenilemez
    const failing = staleReload(() => Promise.reject(new Error('ağ yok')), () => void reloads++);
    await failing(0);
    expect(reloads).toBe(1);
    // Soru sürerken gelen ikinci bakış ikinci soru açmaz
    let answer: (v: boolean) => void = () => {};
    const slow = staleReload(
      () => {
        probes++;
        return new Promise<boolean>((ok) => (answer = ok));
      },
      () => void reloads++,
      0,
    );
    const first = slow(200_000);
    await slow(200_001);
    answer(true);
    await first;
    expect([probes, reloads]).toEqual([3, 2]);
  });

  it('ekran bayatlayınca sayfayı doğrudan değil sağlık sorusuyla yeniler; yeni sürümde hemen', () => {
    const page = readFileSync(new URL('../src/pages/CustomerDisplayPage.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(/now - lastOk > STALE_RELOAD_MS\) void stale\(now\);/);
    expect(page).toMatch(/staleReload\(\(\) => get\('\/health'\)\.then\(\(\) => true, \(\) => false\), reloadPage\)/);
    expect(page).toMatch(/b !== firstBuild\.v\) reloadPage\(\);/);
    expect(page.match(/window\.location\.reload\(\)/g)).toHaveLength(1);
  });
});
