import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Siteden kurulum (scripts/kasa/windows/kurulum/web-kurucu.mjs, web-kurucu.ps1, web-kaldir.ps1): kanal derlemesinin
 * yazdığı LafPOS-Kur.cmd surum.json'daki adres ve özetleri taşır, gizli bir şey taşımaz, Windows PowerShell 5.1'de
 * çalışır (7'ye özgü işleç yok), cmd başlığı ASCII ve CRLF'dir. İndirme bağlantısı yalnız LafPOS Uzaktan'da ve
 * girişten sonra görünür.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Mod = Record<string, any>;
const root = new URL('../', import.meta.url);
const load = (f: string) => import(/* @vite-ignore */ new URL(`scripts/kasa/windows/kurulum/${f}`, root).href) as Promise<Mod>;
const read = (f: string) => readFileSync(new URL(f, root), 'utf8');

async function build() {
  const { manifestFor } = await load('kanal.mjs');
  const { webInstaller } = await load('web-kurucu.mjs');
  const { NODE_VERSION, NODE_ABI, NODE_SHA256, SQLITE_SHA256 } = await load('surumler.mjs');
  const sqlite = Object.keys(SQLITE_SHA256)[0]!;
  const manifest = manifestFor({ build: 1_795_100_000, commit: 'abc', version: '0.2.0', zip: Buffer.from('lafpos-app-deneme'), sqlite });
  return { manifest, text: webInstaller({ manifest }) as string, NODE_VERSION, NODE_ABI, NODE_SHA256, sqlite, sqliteSha: SQLITE_SHA256[sqlite] as string };
}

/** Kurucunun PowerShell gövdesi (cmd başlığından sonrası) */
const psBody = (text: string) => text.slice(text.indexOf('#>\r\n') + 4);

/** Gömülü dosyalar: $Dosyalar = @{ 'ad' = 'base64' } */
function embedded(text: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const m of text.matchAll(/^ {2}'([A-Za-z0-9._-]+)' = '([A-Za-z0-9+/=]+)'\r$/gm)) out[m[1]!] = Buffer.from(m[2]!, 'base64');
  return out;
}

/**
 * PowerShell kaynağından yorumlar ve dize içerikleri atılır (yalnız kod kalır): işleç denetimi dizedeki metne takılmasın.
 * Tek tırnakta '' kaçış, çift tırnakta ` kaçış; burada-dize (@' '@) kullanılmaz
 */
function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '<' && src[i + 1] === '#') {
      const end = src.indexOf('#>', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === "'") {
      i++;
      while (i < src.length && !(src[i] === "'" && src[i + 1] !== "'")) i += src[i] === "'" ? 2 : 1;
      i++;
      out += "''";
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === '`' ? 2 : 1;
      i++;
      out += '""';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Windows PowerShell 5.1'de olmayan sözdizimi ve parantez dengesi */
function ps51Problems(src: string): string[] {
  const code = codeOnly(src);
  const bad: string[] = [];
  if (src.includes('@\'') || src.includes('@"')) bad.push('burada-dize');
  for (const [re, name] of [
    [/\?\?/, '?? (boş birleştirme)'],
    [/\?\./, '?. (boş koşullu üye)'],
    [/\?\[/, '?[ (boş koşullu dizin)'],
    [/&&/, '&& (zincir)'],
    [/\|\|/, '|| (zincir)'],
    [/\s\?\s/, '? : (üçlü koşul)'],
    [/-Parallel\b/i, 'ForEach-Object -Parallel'],
    [/\bclean\s*\{/i, 'clean bloğu'],
  ] as const) {
    if (re.test(code)) bad.push(name);
  }
  for (const [open, close] of ['()', '{}', '[]']) {
    let depth = 0;
    for (const ch of code) {
      if (ch === open) depth++;
      if (ch === close) depth--;
      if (depth < 0) break;
    }
    if (depth !== 0) bad.push(`dengesiz ${open}${close}`);
  }
  return bad;
}

/** PowerShell'deki `('a' + $Surum.x + 'b')` birleştirmesi, verilen değerlerle */
function concat(expr: string, values: Record<string, string>): string {
  return expr
    .split(' + ')
    .map((p) => {
      const lit = /^'([^']*)'$/.exec(p.trim());
      if (lit) return lit[1];
      const v = /^\$Surum\.(\w+)$/.exec(p.trim());
      if (!v || values[v[1]!] == null) throw new Error(`anlaşılmadı: ${p}`);
      return values[v[1]!];
    })
    .join('');
}

describe('siteden kurulum: LafPOS-Kur.cmd', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('surum.json’un derlemesini, özetlerini ve adreslerini taşır', async () => {
    const { manifest, text, NODE_VERSION, NODE_ABI, NODE_SHA256, sqlite, sqliteSha } = await build();
    const body = psBody(text);
    expect(body).toContain(`build = '${manifest.build}'; version = '0.2.0'`);
    expect(body).toContain(`appFile = 'lafpos-app-${manifest.build}.zip'; appSha = '${manifest.app.sha256}'; appSize = [long]${manifest.app.size}`);
    expect(body).toContain(`nodeVersion = '${NODE_VERSION}'; nodeAbi = '${NODE_ABI}'; nodeSha = '${NODE_SHA256}'`);
    expect(body).toContain(`sqliteVersion = '${sqlite}'; sqliteSha = '${sqliteSha}'`);
    // Kanal: önce alan adı, yoksa Vercel'in adresi; güncelleyicinin (guncelle.mjs) adresleriyle aynı
    const { MANIFEST_URLS, nodeZipUrl, sqliteTarUrl } = await load('guncelle.mjs');
    const kanal = /^\$Kanal = @\((.*)\)\r$/m.exec(body)![1]!;
    expect(kanal.split(', ').map((s) => `${s.slice(1, -1)}surum.json`)).toEqual(MANIFEST_URLS);
    // İndirme adresleri güncelleyicinin kalıbıyla aynı (kanal yalnız sürüm ve özet verir)
    const values = { nodeVersion: NODE_VERSION, nodeAbi: NODE_ABI, sqliteVersion: sqlite, taban: 'https://lafpos.laffogato.net/guncelleme/', appFile: manifest.app.file };
    const nodeExpr = /Indir \((.*?)\) \$nodeZip /.exec(body)![1]!;
    expect(concat(nodeExpr, values)).toBe(nodeZipUrl(NODE_VERSION));
    const sqliteName = /\$sqliteAd = (.*?)\r/.exec(body)![1]!;
    const sqliteExpr = /Indir \((.*?)\) \$sqliteTgz /.exec(body)![1]!.replace('$sqliteAd', sqliteName);
    expect(concat(sqliteExpr, values)).toBe(sqliteTarUrl(sqlite, NODE_ABI));
    const appExpr = /Indir \((.*?)\) \$appZip /.exec(body)![1]!;
    expect(concat(appExpr, values)).toBe(`https://lafpos.laffogato.net/guncelleme/lafpos-app-${manifest.build}.zip`);
    // Her indirme SHA-256 ile doğrulanır; uygulama yükünün boyu da
    expect(body).toMatch(/Get-FileHash -LiteralPath \$Hedef -Algorithm SHA256/);
    expect(body).toMatch(/\$Surum\.nodeSha/);
    expect(body).toMatch(/\$Surum\.sqliteSha/);
    expect(body).toMatch(/\$Surum\.appSha/);
    expect(body).toMatch(/Length -ne \$Surum\.appSize/);
  });

  it('kurulum dosyasıyla (lafpos.nsi) aynı görev, güvenlik duvarı ve klasörler', async () => {
    const { text } = await build();
    const nsi = read('scripts/kasa/windows/kurulum/lafpos.nsi');
    const body = psBody(text);
    // Görev XML'i satır satır aynı (komut ve klasör satırları dışında)
    const nsiTask = [...nsi.matchAll(/!insertmacro TaskLine '(.*)'$/gm)].map((m) => m[1]!).filter((l) => !/\$(SYSDIR|INSTDIR)/.test(l));
    for (const line of nsiTask) expect(body, line).toContain(`'${line}'`);
    expect(body).toContain("'/RU', 'SYSTEM'");
    expect(nsi).toContain('!define TASK "LafPOS Sunucu"');
    expect(body).toContain("$Gorev = 'LafPOS Sunucu'");
    expect(body).toContain("@('localsubnet', '100.64.0.0/10')");
    expect(body).toContain("'*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'");
    expect(body).toContain("Join-Path $env:ProgramData 'LafPOS'");
    // Başlatıcı, kasa kısayolu, yönetim betiği, simge, notlar, ayar örneği ve kaldırıcı dosyanın içinde
    const files = embedded(text);
    expect(Object.keys(files).sort()).toEqual(['BENIOKU.txt', 'LafPOS-Kaldir.ps1', 'LafPOS-Kasa.bat', 'ayarlar.env.ornek', 'baslat.cmd', 'lafpos.ico', 'yonet.ps1']);
    expect(files['baslat.cmd']!.toString('utf8')).toBe(read('scripts/kasa/windows/kurulum/baslat.cmd').replace(/\r?\n/g, '\r\n'));
    expect(files['lafpos.ico']!.equals(readFileSync(new URL('scripts/kasa/windows/kurulum/lafpos.ico', root)))).toBe(true);
    // cmd ve Windows PowerShell 5.1 BOM'suz dosyayı yerel kod sayfasıyla okur: bu ikisi ASCII
    for (const f of ['baslat.cmd', 'LafPOS-Kasa.bat', 'yonet.ps1']) expect(/^[\x00-\x7f]*$/.test(files[f]!.toString('latin1')), f).toBe(true);
    for (const f of ['BENIOKU.txt', 'ayarlar.env.ornek', 'LafPOS-Kaldir.ps1']) expect(files[f]!.subarray(0, 3).toString('hex'), f).toBe('efbbbf');
  });

  it('gizli bir şey taşımaz', async () => {
    const sentinel = 'gizli-deger-7f3a9c2e1b5d4a6f8e0c';
    for (const k of ['LAFPOS_CLOUD_SECRET', 'LAFPOS_UZAKTAN_PAROLA', 'LAFFOGATO_SYNC_SECRET', 'LAFMALIYET_SYNC_SECRET', 'GITHUB_TOKEN', 'KV_REST_API_TOKEN', 'VERCEL_OIDC_TOKEN']) process.env[k] = sentinel;
    const { text } = await build();
    expect(text).not.toContain(sentinel);
    for (const marker of ['ghp_', 'github_pat_', 'Authorization', 'Bearer ', 'BEGIN PRIVATE KEY']) expect(text, marker).not.toContain(marker);
    // Ayar örneğinde anahtar ve parola satırları boş
    const env = embedded(text)['ayarlar.env.ornek']!.toString('utf8');
    expect(env).toMatch(/^LAFFOGATO_SYNC_SECRET=\r?$/m);
    expect(env).not.toMatch(/^[A-Z0-9_]*(SECRET|PAROLA|TOKEN|PASSWORD|KEY)[A-Z0-9_]*=\S/m);
  });

  it('cmd başlığı ASCII ve CRLF, BOM yok; gövde PowerShell 5.1 sözdiziminde', async () => {
    const { text } = await build();
    expect(text.startsWith('<# : ')).toBe(true);
    expect(text.includes('\n') && !/[^\r]\n/.test(text)).toBe(true);
    const header = text.slice(0, text.indexOf('#>\r\n') + 2);
    expect(/^[\x20-\x7e\r\n]*$/.test(header)).toBe(true);
    // cmd gövdeye hiç inmez: başlık kendi koduyla çıkar
    expect(header).toMatch(/endlocal & exit \/b %KOD%\r\n#>$/);
    expect(header).toContain('[Text.Encoding]::UTF8');
    // Yer tutucular doldu
    expect(text).not.toMatch(/__(GOMULU|DOSYALAR)__/);
    expect(ps51Problems(psBody(text))).toEqual([]);
    expect(ps51Problems(read('scripts/kasa/windows/kurulum/web-kaldir.ps1'))).toEqual([]);
    expect(ps51Problems(read('scripts/kasa/windows/kurulum/yonet.ps1'))).toEqual([]);
    // Denetimin kendisi: 7'ye özgü işleçler yakalanır, dizedeki metin yakalanmaz
    expect(ps51Problems('$a = $b ?? 1')).toContain('?? (boş birleştirme)');
    expect(ps51Problems('$a = $b ? 1 : 2')).toContain('? : (üçlü koşul)');
    expect(ps51Problems('git pull && npm ci')).toContain('&& (zincir)');
    expect(ps51Problems("Write-Host 'a && b ?? c' # x || y")).toEqual([]);
    expect(ps51Problems('if ($a) { (1 }')).toContain('dengesiz ()');
  });

  it('bozuk manifestle derlenmez', async () => {
    const { manifest } = await build();
    const { webInstaller } = await load('web-kurucu.mjs');
    expect(() => webInstaller({ manifest: { ...manifest, app: { ...manifest.app, sha256: "x'; Remove-Item C:\\" } } })).toThrow(/uygulama yükü/);
    expect(() => webInstaller({ manifest: { ...manifest, node: { ...manifest.node, version: '24' } } })).toThrow(/Node/);
    expect(() => webInstaller({ manifest: { ...manifest, build: 12 } })).toThrow(/derleme/);
  });

  it('kanal derlemesi kurucuyu güncelleme kanalının yanına yazar; Vercel onu indirme olarak sunar', () => {
    expect(read('scripts/kasa/windows/kurulum/kanal.mjs')).toMatch(/writeFileSync\(join\(OUT, WEB_INSTALLER_NAME\), webInstaller\(\{ manifest \}\)\)/);
    const vercel = JSON.parse(read('vercel.json'));
    // Arayüzün yedek sayfası /guncelleme/'yi yutmaz
    expect(vercel.rewrites.at(-1).source).toContain('guncelleme/');
    const h = vercel.headers.find((x: any) => x.source === '/guncelleme/LafPOS-Kur.cmd');
    expect(h.headers.find((x: any) => x.key === 'content-disposition').value).toContain('attachment');
  });
});

describe('siteden kurulum: İndir sayfası', () => {
  it('menüde yalnız LafPOS Uzaktan’da, en sonda', async () => {
    const { remoteNav } = await import('../src/lib/remote');
    const { POS_NAV } = await import('../src/lib/nav');
    const { DOWNLOAD_NAV, WEB_INSTALLER_PATH } = await import('../src/lib/download');
    const { WEB_INSTALLER_NAME, WEB_INSTALLER_URL } = await load('web-kurucu.mjs');
    expect(remoteNav(POS_NAV, false)).toEqual(POS_NAV);
    const remote = remoteNav(POS_NAV, true);
    expect(remote.at(-1)).toBe(DOWNLOAD_NAV);
    expect(remote.map((n) => n.to)).toEqual(['/masalar', '/mutfak', '/raporlar', '/patron', '/indir']);
    expect(DOWNLOAD_NAV.label).toBe('İndir');
    expect(WEB_INSTALLER_URL).toBe(`https://lafpos.laffogato.net${WEB_INSTALLER_PATH}`);
    expect(WEB_INSTALLER_PATH.endsWith(WEB_INSTALLER_NAME)).toBe(true);
  });

  it('bağlantı yalnız girişten sonra: rota oturumlu kabukta, giriş ekranında indirme yok', () => {
    const app = read('src/App.tsx');
    const authed = app.indexOf('function Authed()');
    const appFn = app.indexOf('export function App()');
    const route = app.indexOf('{REMOTE && <Route path={DOWNLOAD_PATH} element={<DownloadPage />} />}');
    const standalone = app.indexOf('<StandaloneDownloadPage />');
    expect(authed).toBeGreaterThan(0);
    for (const at of [route, standalone]) {
      expect(at).toBeGreaterThan(authed);
      expect(at).toBeLessThan(appFn);
    }
    // Oturum yoksa App giriş ekranını çizer, Authed'e hiç inmez
    expect(app.slice(appFn)).toMatch(/if \(!me\) \{[\s\S]*?RemoteLoginPage[\s\S]*?\}\s*if \(location\.pathname === '\/giris'\)[\s\S]*?return <Authed \/>;/);
    const login = read('src/pages/RemoteLoginPage.tsx');
    expect(login).not.toMatch(/LafPOS-Kur|guncelleme\/|download|indir'/i);
    expect(login).toContain('Üye girişi');
  });
});
