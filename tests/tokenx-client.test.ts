import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenxClient, TokenxError } from '../server/okc/tokenx';

/** Belgedeki uçları taklit eden sahte Token sunucusu: yollar, başlıklar ve gövdeler doğrulanır. */
const seen: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] = [];
let server: Server;
let base = '';
let tokenCalls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.url === '/v1/auth/token') {
        tokenCalls++;
        const ok = req.headers.authorization === `Basic ${Buffer.from('cid:csecret').toString('base64')}`;
        return ok ? send(201, { status: 201, description: 'ok', result: { accessToken: `tok${tokenCalls}`, expiresIn: 900, tokenType: 'Bearer' } }) : send(401, { status: 401 });
      }
      if (req.headers.authorization !== `Bearer tok${tokenCalls}`) return send(401, { status: '0002', description: 'expired' });
      if (req.url === '/v1/fiscal-parameters') return send(200, { status: 0, result: { sections: [{ sectionNo: 1, name: 'İçecek', taxPercent: 1000 }] } });
      if (req.url === '/v1/instant-basket') {
        const b = JSON.parse(body);
        if (b.basketID === 'busy') return send(200, { status: 1100, description: 'There is already an open basket' });
        return send(200, { status: 0, description: 'Basket Record Successfully Created' });
      }
      if (req.url?.startsWith('/v1/basket/')) return send(200, { status: 0, result: { basketID: 'b1', status: 1, sale: { basketID: 'b1', status: 0, zNo: 3, receiptNo: 6, paymentItems: [{ type: 1, amount: 22500 }] } } });
      send(404, { status: 404 });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const client = () =>
  new TokenxClient({ authUrl: base, basketUrl: base, settingsUrl: base, clientId: 'cid', clientSecret: 'csecret', terminalId: 'AV0000000001', branchId: '', appResource: 'asilpos' });

describe('TokenX Connect istemcisi', () => {
  it('Basic ile jeton alır, Bearer ve terminal-id ile kısımları ister', async () => {
    const c = client();
    const r = await c.getFiscalSections();
    expect(r.sections[0]).toMatchObject({ sectionNo: 1, taxPercent: 1000 });
    const call = seen.find((s) => s.url === '/v1/fiscal-parameters')!;
    expect(call.headers['terminal-id']).toBe('AV0000000001');
    expect(call.headers['x-application-resource']).toBe('asilpos');
    expect(call.headers.authorization).toMatch(/^Bearer tok\d+$/);
  });

  it('anlık sepet gönderir; 1100 kodunu Türkçe hata olarak döner', async () => {
    const c = client();
    await c.sendInstantBasket({ basketID: 'b1', items: [{ name: 'Latte', price: 19500, sectionNo: 1, taxPercent: 1000, quantity: 1000 }] });
    const sent = seen.filter((s) => s.url === '/v1/instant-basket').pop()!;
    expect(JSON.parse(sent.body)).toMatchObject({ basketID: 'b1', items: [{ quantity: 1000 }] });
    await expect(c.sendInstantBasket({ basketID: 'busy', items: [] })).rejects.toThrow(TokenxError);
    await expect(c.sendInstantBasket({ basketID: 'busy', items: [] })).rejects.toThrow(/açık bir sepet/);
  });

  it('sepet detayında satış sonucunu okur', async () => {
    const d = await client().getBasket('b1');
    expect(d.sale).toMatchObject({ status: 0, zNo: 3, receiptNo: 6 });
  });
});
