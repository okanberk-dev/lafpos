import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DisplayStateDTO } from '@shared/types';
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
});
