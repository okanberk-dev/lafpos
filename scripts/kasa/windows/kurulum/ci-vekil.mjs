// Windows CI'ın kasa penceresi gözcüsü (ci-kurulum.mjs; kasaya gitmez). Kasa penceresi kurulu sunucuya bu yerel vekilden
// bağlanır (kasa kısayolu ASILPOS_URL'i okur): vekil her isteği sunucuya iletir ve yazar, arayüz sayfasına küçük bir betik
// ekler. Betik sayfa yüklenince vekile pencerenin gerçekten gösterdiği ana betiği (hangi derleme), başlığı ve yerel
// depolamanın kalıcı olup olmadığını bildirir (/__ci/sayfa). Böylece CI "güncellemeden sonraki ilk açılışta yeni sürüm
// mü görünüyor" sorusunu pencerenin içinden yanıtlar.
//
// `eski` kipi 27 Kasım 2026 öncesinin sunucusunu taklit eder: arayüz dosyaları önbellek başlığı olmadan, eski bir
// Last-Modified ile gider. Chrome böyle yanıtı sezgisel olarak (son değişikliğin yaşının onda biri kadar) sunucuya
// sormadan açar; güncellemeden sonra eski arayüzün görünmesinin nedeni buydu. `gercek` kipi başlıklara dokunmaz.
import { createServer, request } from 'node:http';

/**
 * Yerel depo denemesinin anahtarı: sayfa ilk açılışta yazar, sonraki açılışta okur. Chromium yerel depoyu profilin
 * `Default\Local Storage\leveldb` klasörüne yazar (anahtar Latin-1 ise baytları olduğu gibi): CI yazımın diske geçtiğini
 * bu adla görür (ci-kurulum.mjs D6)
 */
export const CI_DEPO_ANAHTARI = 'asilpos.ci-depo';

/** Sayfaya eklenen betik: ana betik, başlık, yerel depolama, ekran ölçüsü; vekile bildirir */
export const INJECT = `<script>(function(){try{var s=document.querySelector('script[type="module"][src]');var k='${CI_DEPO_ANAHTARI}',v='';try{v=localStorage.getItem(k)||'';if(!v)localStorage.setItem(k,String(Date.now()))}catch(e){v='yok'}var q='script='+encodeURIComponent(s?new URL(s.src,location.href).pathname:'')+'&depo='+encodeURIComponent(v)+'&baslik='+encodeURIComponent(document.title)+'&yol='+encodeURIComponent(location.pathname)+'&ekran='+screen.width+'x'+screen.height+'&ic='+innerWidth+'x'+innerHeight;fetch('/__ci/sayfa?'+q,{method:'POST',keepalive:true})}catch(e){}})();</script>`;

/** index.html'in ana modül betiğinin yolu */
export function mainScript(html) {
  return /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1] ?? /<script[^>]+src="([^"]+)"[^>]+type="module"/.exec(html)?.[1] ?? null;
}

/** Eski sunucunun başlıkları: önbellek başlığı yok, Last-Modified 30 gün önce (yalnız arayüz dosyaları; /api/ değil) */
export function eskiBasliklar(headers, now = Date.now()) {
  const out = { ...headers };
  delete out['cache-control'];
  out['last-modified'] = new Date(now - 30 * 86_400_000).toUTCString();
  return out;
}

/**
 * Vekili açar. Dönen: `port`, `log` (istekler ve sayfa bildirimleri), `mode` (eski | gercek), `close()`
 * @param {{ port: number, upstreamPort?: number }} o
 */
export function startProxy({ port, upstreamPort = 4000 }) {
  const state = { mode: 'eski', log: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://ci');
    if (url.pathname === '/__ci/sayfa') {
      state.log.push({ t: Date.now(), tur: 'sayfa', ...Object.fromEntries(url.searchParams) });
      req.resume();
      res.writeHead(204).end();
      return;
    }
    const dest = String(req.headers['sec-fetch-dest'] ?? '');
    const entry = { t: Date.now(), tur: 'istek', yol: url.pathname, dest, mode: state.mode };
    state.log.push(entry);
    const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}` };
    // Sayfaya betik eklenebilsin: sıkıştırılmış yanıt istenmez
    delete headers['accept-encoding'];
    const up = request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers }, (ur) => {
      let out = { ...ur.headers };
      if (state.mode === 'eski' && !url.pathname.startsWith('/api/')) out = eskiBasliklar(out);
      entry.status = ur.statusCode;
      entry.cc = out['cache-control'] ?? null;
      const html = String(ur.headers['content-type'] ?? '').includes('text/html');
      if (!html || dest !== 'document') {
        res.writeHead(ur.statusCode ?? 502, out);
        ur.pipe(res);
        return;
      }
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        entry.script = mainScript(body);
        body = body.includes('</body>') ? body.replace('</body>', `${INJECT}</body>`) : body + INJECT;
        delete out['content-encoding'];
        out['content-length'] = String(Buffer.byteLength(body));
        res.writeHead(ur.statusCode ?? 200, out).end(body);
      });
    });
    up.on('error', (e) => {
      entry.status = 502;
      entry.hata = e.message;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('sunucu yok');
      else res.destroy();
    });
    req.pipe(up);
  });
  return new Promise((ok) =>
    server.listen(port, '127.0.0.1', () =>
      ok({
        port: server.address().port,
        get log() {
          return state.log;
        },
        set mode(m) {
          state.mode = m;
        },
        get mode() {
          return state.mode;
        },
        // Canlı bağlantılar (sayfanın olay akışı) açık kalır: kapatırken kesilir
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      }),
    ),
  );
}
