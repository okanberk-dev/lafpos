// Yerel deneme: Vercel'deki LafPOS Uzaktan'ın taklidi (statik arayüz + api/uzaktan + bellekte Redis)
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
const root = process.argv[2]!;
const store = new Map<string, string>();
const redis = createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const [cmd, key, ...rest] = JSON.parse(b);
  let result: unknown = null;
  if (cmd === 'GET') result = store.get(key) ?? null;
  if (cmd === 'SET') { store.set(key, rest[0]); result = 'OK'; }
  if (cmd === 'INCR') { store.set(key, String(Number(store.get(key) ?? 0) + 1)); result = Number(store.get(key)); }
  if (cmd === 'DEL') { store.delete(key); result = 1; }
  if (cmd === 'EXPIRE') result = 1;
  res.end(JSON.stringify({ result }));
}).listen(4402);
Object.assign(process.env, { KV_REST_API_URL: 'http://127.0.0.1:4402', KV_REST_API_TOKEN: 't' });
const api = await import('./api/uzaktan.ts');
const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1:4401');
  if (url.pathname.startsWith('/api/')) {
    const yol = url.pathname.slice(5);
    url.searchParams.set('yol', yol);
    let body = ''; for await (const c of req) body += c;
    const r = new Request(`http://127.0.0.1:4401/api/uzaktan?${url.searchParams}`, { method: req.method, headers: req.headers as Record<string, string>, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : body });
    const out: Response = await (api as Record<string, (r: Request) => Promise<Response>>)[req.method!]!(r);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  const f = join(root, url.pathname);
  const file = existsSync(f) && extname(f) ? f : join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'text/html' });
  res.end(readFileSync(file));
}).listen(4401, () => console.log('bulut hazır'));
