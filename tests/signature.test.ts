import { describe, expect, it } from 'vitest';
import { canonicalString, sign } from '../server/lib/signature';

/**
 * laffogato `tests/panel-karaoke-sync-core.test.ts` ve lafmaliyet'in sabitlediği vektörlerin aynısı.
 * Bu test kırılırsa LafPOS'un imzalı istekleri sitede 401 alır.
 */
const SECRET = 'test-secret-0123456789-abcdefghijklmnop';
const TS = 1760000000;
const PULL_URL = new URL('https://laffogato.net/api/panel/karaoke?to=2026-12-31&from=2026-10-20');
const PING_URL = new URL('https://ladmin.laffogato.net/api/karaoke/ping');
const PING_BODY = JSON.stringify({ event: 'karaoke.changed', at: '2026-10-21T10:00:00.000Z' });

describe('panel imzası (laffogato ↔ lafmaliyet ile bayt bayt aynı)', () => {
  it('iki projenin sabitlediği vektörler', () => {
    expect(sign(SECRET, { timestamp: TS, method: 'GET', url: PULL_URL, body: '' })).toBe('13a147fac8db7d7012e86b1a83c230ac4c2a5d15bef73877e3ebe1e6d668a1e4');
    expect(sign(SECRET, { timestamp: TS, method: 'POST', url: PING_URL, body: PING_BODY })).toBe('1d993513ad228ef2b3c43bc4c32c76d792a20aa4563d31001320cc95cfbd9c69');
  });

  it('lafmaliyet\'in LafPOS uçları için sabitlediği vektörler (lafmaliyet tests/lafpos.test.ts)', () => {
    // Gün sonu itmesi ve maliyet okuması: LafPOS'un imzası bu iki değeri vermezse lafmaliyet 401 döner
    const dayBody = '{"version":1,"source":"lafpos","date":"2026-10-26"}';
    expect(sign(SECRET, { timestamp: TS, method: 'POST', url: new URL('https://ladmin.laffogato.net/api/pos/gun'), body: dayBody })).toBe('5ab02280859d09c6afb003f9cc62bbfdd46b1738f6a25c9a6cf8a475113639cb');
    expect(sign(SECRET, { timestamp: TS, method: 'GET', url: new URL('https://ladmin.laffogato.net/api/panel/pos/urunler'), body: '' })).toBe('4693defb7ef97b132908d552133471db2827261b6468b2ef565effa6fcbf8a3c');
  });

  it('kanonik metin: zaman, yöntem, yol, sıralı sorgu, gövde özeti; alan adı yok', () => {
    expect(canonicalString({ timestamp: TS, method: 'get', url: PULL_URL, body: '' })).toBe(
      ['1760000000', 'GET', '/api/panel/karaoke', 'from=2026-10-20&to=2026-12-31', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'].join('\n'),
    );
    const www = new URL(PULL_URL);
    www.host = 'www.laffogato.net';
    expect(sign(SECRET, { timestamp: TS, method: 'GET', url: www, body: '' })).toBe(sign(SECRET, { timestamp: TS, method: 'GET', url: PULL_URL, body: '' }));
  });
});
