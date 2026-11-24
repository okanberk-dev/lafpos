// Sahte Pavo cihazı (LafPOS'un kendi tests/fake-pavo.ts'i) ayrı süreçte + denetim ucu. run.mjs başlatır:
//   cwd = LafPOS deposu, `node --import tsx fake-pavo-server.mjs`, FAKE_PAVO_MODULE = <lafpos>/tests/fake-pavo.ts
// stdout'a bir kez: READY <cihaz adresi> <denetim adresi> <seri no>
// Denetim (yalnız 127.0.0.1):
//   GET  /ctl/sales                         → [{ orderNo, state, total }]
//   POST /ctl/pay   { orderNo, payments: [{ type: 1|2|7, amount: TL }], invoiceNo }
//   POST /ctl/card  { amount: TL }          → LafPOS sepeti olmadan cihazda kart çekimi (açık batch'e)
//   POST /ctl/eod   { mode: "ok"|"fail"|"silent"|"drop" }
//   GET  /ctl/batches                       → cihazın kapanmış batch'leri (özet)
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(process.env.FAKE_PAVO_MODULE).href);
const device = await mod.startFakePavo({ serial: 'PAV86E2E0001' });

const read = (req) =>
  new Promise((ok) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}));
  });
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const ctl = createServer(async (req, res) => {
  try {
    const body = req.method === 'POST' ? await read(req) : {};
    if (req.url === '/ctl/sales') {
      return send(res, 200, [...device.sales.values()].map((s) => ({ orderNo: s.orderNo, state: s.state, total: Number(s.body.TotalPrice) })));
    }
    if (req.url === '/ctl/pay') {
      if (!device.sales.has(body.orderNo)) return send(res, 404, { error: 'no_sale' });
      device.pay(body.orderNo, body.payments, body.invoiceNo ? { invoiceNo: body.invoiceNo } : undefined);
      return send(res, 200, { ok: true });
    }
    if (req.url === '/ctl/card') {
      // LafPOS'un sepeti olmadan cihazda çekilen kart (ör. cari tahsilatı): bankanın açık batch'ine girer
      device.addCardTransaction(body.amount);
      return send(res, 200, { ok: true });
    }
    if (req.url === '/ctl/eod') {
      device.eodMode = body.mode;
      return send(res, 200, { ok: true });
    }
    if (req.url === '/ctl/batches') {
      return send(res, 200, device.batches.map((b) => ({ batchNo: b.batchNo, dateTime: b.dateTime, grandTotals: b.eodData.grandTotals })));
    }
    return send(res, 404, { error: 'unknown' });
  } catch (e) {
    return send(res, 500, { error: String(e?.message ?? e) });
  }
});
await new Promise((r) => ctl.listen(0, '127.0.0.1', r));
process.stdout.write(`READY ${device.url} http://127.0.0.1:${ctl.address().port} ${device.serial}\n`);

const stop = async () => {
  await device.close().catch(() => {});
  ctl.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
