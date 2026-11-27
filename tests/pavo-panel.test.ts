import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { pavoAddress, pavoSerial } from '../server/okc/pavo';
import { findPavo, privateIpv4, scanHosts } from '../server/okc/pavo-bul';
import { pavoTiming } from '../server/okc/providers/pavo';
import { type FakePavo, startFakePavo } from './fake-pavo';
import { type Harness, startApp } from './harness';
import { PAVO_KIMLIGI } from '@shared/eski-adlar';

/**
 * Pavo cihazının bilgileri yönetimden (ayarlar dosyası olmadan): adres ve seri no'nun okunması, kaydedince eşleştirmenin
 * sıfırlanması, yetki, denetim kaydı, cihaz meşgulken ya da sonucu beklenen sepet varken değişmemesi ve ağda arama
 */

describe('adres ve seri no', () => {
  it('IP yazmak yeter: şema yoksa https, port yoksa 4567; yol, kullanıcı ve boşluk kabul edilmez', () => {
    expect(pavoAddress('192.168.1.50')).toBe('https://192.168.1.50:4567');
    expect(pavoAddress(' 192.168.1.50:4568 ')).toBe('https://192.168.1.50:4568');
    expect(pavoAddress('http://192.168.1.50:4567/')).toBe('http://192.168.1.50:4567');
    expect(pavoAddress('HTTPS://Pavo-Kasa:4567')).toBe('https://pavo-kasa:4567');
    for (const bad of ['', '192.168.1.50/Ping', 'ftp://192.168.1.50', 'user@192.168.1.50', '192.168.1.50:99999', '192.168 1.50', 'https://']) expect(pavoAddress(bad)).toBeNull();
  });

  it('seri no büyük harfe çevrilir; kısa ya da tuhaf karakterli seri no reddedilir', () => {
    expect(pavoSerial(' pav860000001 ')).toBe('PAV860000001');
    expect(pavoSerial('AB')).toBeNull();
    expect(pavoSerial('PAV 1234')).toBeNull();
  });
});

describe('ağda arama', () => {
  it('yalnız özel ağlar; Tailscale ve genel adresler taranmaz; kendi adresi hariç /24', () => {
    expect(['10.0.0.5', '172.16.3.4', '172.31.0.1', '192.168.1.20'].every(privateIpv4)).toBe(true);
    expect(['100.101.7.9', '172.32.0.1', '8.8.8.8', '169.254.1.1', '192.168.1'].some(privateIpv4)).toBe(false);
    const s = scanHosts(['192.168.1.20']);
    expect(s.subnets).toEqual(['192.168.1.0/24']);
    expect(s.hosts).toHaveLength(253);
    expect(s.hosts).not.toContain('192.168.1.20');
  });

  it('REST portu açık ve /Ping’e yanıt veren cihaz bulunur; kapalı port aday olmaz', async () => {
    const device = await startFakePavo();
    try {
      const port = Number(new URL(device.url).port);
      const r = await findPavo({ hosts: ['127.0.0.1'], ports: [port, 1], connectMs: 500, pingMs: 1500 });
      // Seri no yazılmadan da yanıt veren cihaz adaydır (cihaz seri no'yu reddeder ama Pavo olduğu anlaşılır)
      expect(r.candidates).toEqual([{ url: device.url, ok: false, message: 'Seri numarası eşleşmiyor' }]);
      const withSerial = await findPavo({ serial: device.serial, hosts: ['127.0.0.1'], ports: [port], connectMs: 500, pingMs: 1500 });
      expect(withSerial.candidates).toEqual([{ url: device.url, ok: true, message: 'Pong' }]);
      // Yoklama sıra no göndermez, cihaz eşleşmiş sayılmaz
      expect(device.requests.map((x) => x.path).every((p) => p === '/Ping')).toBe(true);
      // Sahada: /Ping'i JSON'suz (gövdesiz HTTP hatası) yanıtlayan cihaz elenmez; adres "doğrulanamadı" adayı olur
      device.pingHttpStatus = 400;
      const odd = await findPavo({ hosts: ['127.0.0.1'], ports: [port], connectMs: 500, pingMs: 1500 });
      expect(odd.candidates).toEqual([{ url: device.url, ok: false, unrecognized: true, message: expect.stringContaining('HTTP 400') }]);
      device.pingHttpStatus = null;
    } finally {
      await device.close();
    }
  });
});

describe('yönetimden cihaz bilgileri (ayarlar dosyası yok)', () => {
  let device: FakePavo;
  let other: FakePavo;
  let h: Harness;
  type Status = { provider: string; pavo: { configured: boolean; source: string | null; url: string | null; serial: string | null; paired: boolean } };
  beforeAll(async () => {
    pavoTiming.sendWaitMs = 300;
    pavoTiming.askEveryMs = 0;
    device = await startFakePavo();
    other = await startFakePavo({ serial: 'PAV860000002' });
    // Ortamda Pavo yok: bilgiler yalnız yönetimden gelir
    delete process.env.PAVO_URL;
    delete process.env.PAVO_SERIAL;
    delete process.env.PAVO_FINGERPRINT;
    h = await startApp();
  });
  afterAll(async () => {
    await device.close();
    await other.close();
    h.cleanup();
  });

  it('girilmemişken Pavo kurulmamış görünür ve eşleştirilemez', async () => {
    const s = await h.ok<Status>('patron', 'PUT', '/okc/settings', { provider: 'pavo' });
    expect(s.pavo).toMatchObject({ configured: false, source: null, paired: false });
    const pair = await h.call<{ code: string; error: string }>('patron', 'POST', '/okc/pair');
    expect(pair.status).toBe(409);
    expect(pair.json.error).toContain('Yönetim › Yazarkasa POS');
  });

  it('yalnız ayar yetkisi girer; anlaşılmayan adres ve seri no alan koduyla 400', async () => {
    expect((await h.call('kasa', 'PUT', '/okc/pavo', { address: device.url, serial: device.serial })).status).toBe(403);
    const badAddr = await h.call<{ code: string }>('patron', 'PUT', '/okc/pavo', { address: '192.168.1.50/x', serial: device.serial });
    expect(badAddr).toMatchObject({ status: 400, json: { code: 'pavo_address' } });
    const badSerial = await h.call<{ code: string }>('patron', 'PUT', '/okc/pavo', { address: device.url, serial: '?' });
    expect(badSerial).toMatchObject({ status: 400, json: { code: 'pavo_serial' } });
    expect((await h.call('kasa', 'POST', '/okc/pavo/find', {})).status).toBe(403);
  });

  it('kaydedince hemen kullanılır (yeniden başlatma yok): eşleştir, dene', async () => {
    const s = await h.ok<Status>('patron', 'PUT', '/okc/pavo', { address: device.url, serial: device.serial.toLowerCase() });
    expect(s.pavo).toMatchObject({ configured: true, source: 'panel', url: device.url, serial: device.serial, paired: false });
    await h.ok('patron', 'POST', '/okc/pair');
    const test = await h.ok<{ paired: boolean }>('patron', 'POST', '/okc/test');
    expect(test.paired).toBe(true);
    // İlk eşleştirme kuruluma özel kimlik üretir ve saklar; eşleştirme ve sonraki istekler onunla gider
    const fp = (await h.ok<{ pavo: { fingerprint: string; fingerprintSource: string } }>('patron', 'GET', '/okc/status')).pavo;
    expect(fp.fingerprint).toMatch(new RegExp(`^${PAVO_KIMLIGI}-[A-Z2-9]{6}$`));
    expect(fp.fingerprintSource).toBe('kurulum');
    const handles = device.requests.filter((r) => r.path !== '/Ping').map((r) => (r.body.TransactionHandle as { Fingerprint: string }).Fingerprint);
    expect(new Set(handles)).toEqual(new Set([fp.fingerprint]));
    // Aynı bilgileri yeniden kaydetmek eşleştirmeyi bozmaz
    expect((await h.ok<Status>('patron', 'PUT', '/okc/pavo', { address: device.url, serial: device.serial })).pavo.paired).toBe(true);
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=20');
    expect(audit.some((a) => a.action === 'okc.pavo_device' && a.message.includes(device.serial))).toBe(true);
  });

  it('cihazda süren satış varken ve sonucu beklenen sepet varken cihaz değişmez', async () => {
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    const product = h.boot.products.find((p) => p.name === 'Türk Kahvesi')!;
    const o0 = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o0.id}/items`, { items: [{ productId: product.id, qty: 1 }] });
    const sent = await h.ok<{ receipt: { id: string } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    const busy = await h.call<{ code: string }>('patron', 'PUT', '/okc/pavo', { address: other.url, serial: other.serial });
    expect(busy).toMatchObject({ status: 409, json: { code: 'okc_busy' } });
    const { pavoOrderNo } = await import('../server/okc/providers/pavo');
    device.pay(pavoOrderNo(sent.receipt.id), [{ type: 1, amount: o.total / 100 }], { invoiceNo: 'LAF2026000000099' });
    await new Promise((r) => setTimeout(r, 50));
    await h.ok('kasa', 'POST', `/okc/receipts/${sent.receipt.id}/refresh`);
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).status).toBe('kapali');
  });

  it('başka cihaza geçince eşleştirme sıfırlanır; yeni cihaz eşleşince satışlar ona gider', async () => {
    const s = await h.ok<Status>('patron', 'PUT', '/okc/pavo', { address: other.url, serial: other.serial });
    expect(s.pavo).toMatchObject({ url: other.url, serial: other.serial, paired: false });
    const before = (await h.ok<{ pavo: { fingerprint: string } }>('patron', 'GET', '/okc/status')).pavo.fingerprint;
    await h.ok('patron', 'POST', '/okc/pair');
    expect(other.requests.some((r) => r.path === '/Pairing')).toBe(true);
    // Kimlik kalıcı: yeni cihazla eşleştirmede de aynısı gider
    const pairing = other.requests.find((r) => r.path === '/Pairing')!;
    expect((pairing.body.TransactionHandle as { Fingerprint: string }).Fingerprint).toBe(before);
    expect((await h.ok<{ paired: boolean }>('patron', 'POST', '/okc/test')).paired).toBe(true);
  });
});
