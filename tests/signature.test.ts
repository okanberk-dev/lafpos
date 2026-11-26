import { describe, expect, it } from 'vitest';
import { canonicalString, sign } from '../server/lib/signature';
import { TEL_KAYNAK } from '@shared/eski-adlar';

/**
 * lafmaliyet'in sabitlediği vektörlerin aynısı (lafmaliyet `tests/karaoke.test.ts`, `tests/asilpos.test.ts`). Sitenin
 * testi 16 Kasım 2026'da kaldırıldı; vektörleri laffogato `docs/PANEL-KARAOKE.md` ve `docs/PANEL-ORDERS.md`'de durur.
 * Bu test kırılırsa AsilPOS'un imzalı istekleri sitede 401 alır.
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

  it('lafmaliyet\'in AsilPOS uçları için sabitlediği vektörler (lafmaliyet tests/asilpos.test.ts)', () => {
    // Gün sonu itmesi ve maliyet okuması: AsilPOS'un imzası bu iki değeri vermezse lafmaliyet 401 döner
    // Gövde telde eski adla (source): vektör lafmaliyet'teki testle aynı kalmalı
    const dayBody = `{"version":1,"source":"${TEL_KAYNAK}","date":"2026-10-26"}`;
    expect(sign(SECRET, { timestamp: TS, method: 'POST', url: new URL('https://ladmin.laffogato.net/api/pos/gun'), body: dayBody })).toBe('5ab02280859d09c6afb003f9cc62bbfdd46b1738f6a25c9a6cf8a475113639cb');
    expect(sign(SECRET, { timestamp: TS, method: 'GET', url: new URL('https://ladmin.laffogato.net/api/panel/pos/urunler'), body: '' })).toBe('4693defb7ef97b132908d552133471db2827261b6468b2ef565effa6fcbf8a3c');
    // ModPOS dönemi (server/sync/modpos.ts): şube sorguda, imzaya girer
    expect(sign(SECRET, { timestamp: TS, method: 'GET', url: new URL('https://ladmin.laffogato.net/api/panel/pos/modpos-gunler?sube=marina'), body: '' })).toBe('e653d2f73b92e4fa1f6acc750f6702872e7e3a68204f9adad8f17e5bf6dd9023');
  });

  it('kasa zinciri uçları (docs/03-ENTEGRASYON.md §4.6, §4.7; lafmaliyet tests/asilpos.test.ts aynı vektörler)', () => {
    // Devir okuması (sorgu imzaya girer) ve gider kategorileri: ikisi de gövdesiz imzalı GET
    expect(sign(SECRET, { timestamp: TS, method: 'GET', url: new URL('https://ladmin.laffogato.net/api/panel/pos/devir?date=2026-11-22'), body: '' })).toBe('d0d42a100852f660d76a81e1f1631684faef9838a67f1788ded57de92640205b');
    expect(sign(SECRET, { timestamp: TS, method: 'GET', url: new URL('https://ladmin.laffogato.net/api/panel/pos/gider-kategorileri'), body: '' })).toBe('7309e560164d15d4ccb5c17ecaa6355bde88073a238c1cc5976f1858431c10b1');
  });

  it('personel listesi ucu (docs/03-ENTEGRASYON.md §4.8; lafmaliyet tests/asilpos.test.ts aynı vektörü sabitler)', () => {
    // Kasanın şubesi sorguda (imzaya girer): lafmaliyet başka şubeye 409 wrong_branch döner
    expect(sign(SECRET, { timestamp: TS, method: 'GET', url: new URL('https://ladmin.laffogato.net/api/panel/pos/personel?sube=marina'), body: '' })).toBe('b6933a6b1b6469c8e430564d5f31c9002ca2ed6a2100fd3cc41df4ccc2d77f31');
  });

  it('sitenin çağrı yanıtı vektörü (laffogato docs/PANEL-ORDERS.md "İmza vektörü")', () => {
    // Masa çağrısına "Gördüm": sitenin belgesindeki gövde ve sonuç; kanonik metin yalnız yolu okur, alan adı imzaya girmez
    const body = JSON.stringify({ id: 'tcl-3f9a0c4b7d2e1a68', actor: 'Selin' });
    expect(sign(SECRET, { timestamp: TS, method: 'POST', url: new URL('https://laffogato.net/api/panel/calls/ack'), body })).toBe('cdda6260245ebae291a8a93e3e691144b393b3fb970335a1133e2b439df6d19a');
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
