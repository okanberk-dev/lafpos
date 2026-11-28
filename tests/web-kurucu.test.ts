import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ALAN_ADI, ESKI_URUN_ADI, ESKI_WEB_KURUCU, KURULUM_KLASORU, SUNUCU_GOREVI, UYGULAMA_ZIP_ONEKI } from '@shared/eski-adlar';

/**
 * Siteden kurulum (scripts/kasa/windows/kurulum/web-kurucu.mjs, web-kurucu.ps1, web-kaldir.ps1): kanal derlemesinin
 * yazdığı AsilPOS-Kur.cmd surum.json'daki adres ve özetleri taşır, gizli bir şey taşımaz, Windows PowerShell 5.1'de
 * çalışır (7'ye özgü işleç yok), cmd başlığı ASCII ve CRLF'dir. İndirme bağlantısı yalnız AsilPOS Uzaktan'da ve
 * girişten sonra görünür.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Mod = Record<string, any>;
const root = new URL('../', import.meta.url);
const load = (f: string) => import(/* @vite-ignore */ new URL(`scripts/kasa/windows/kurulum/${f}`, root).href) as Promise<Mod>;
const read = (f: string) => readFileSync(new URL(f, root), 'utf8');
/** `a`'dan (dahil) sonraki ilk `b`'ye (hariç) kadar; ikisi de bulunmalı */
const between = (s: string, a: string, b: string) => {
  const i = s.indexOf(a);
  expect(i, a).toBeGreaterThanOrEqual(0);
  const j = s.indexOf(b, i + a.length);
  expect(j, b).toBeGreaterThan(i);
  return s.slice(i, j);
};

async function build() {
  const { manifestFor } = await load('kanal.mjs');
  const { webInstaller } = await load('web-kurucu.mjs');
  const { NODE_VERSION, NODE_ABI, NODE_SHA256, SQLITE_SHA256 } = await load('surumler.mjs');
  const sqlite = Object.keys(SQLITE_SHA256)[0]!;
  const manifest = manifestFor({ build: 1_795_100_000, commit: 'abc', version: '0.2.0', zip: Buffer.from(`${UYGULAMA_ZIP_ONEKI}deneme`), sqlite });
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

describe('siteden kurulum: AsilPOS-Kur.cmd', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('surum.json’un derlemesini, özetlerini ve adreslerini taşır', async () => {
    const { manifest, text, NODE_VERSION, NODE_ABI, NODE_SHA256, sqlite, sqliteSha } = await build();
    const body = psBody(text);
    expect(body).toContain(`build = '${manifest.build}'; version = '0.2.0'`);
    expect(body).toContain(`appFile = '${UYGULAMA_ZIP_ONEKI}${manifest.build}.zip'; appSha = '${manifest.app.sha256}'; appSize = [long]${manifest.app.size}`);
    expect(body).toContain(`nodeVersion = '${NODE_VERSION}'; nodeAbi = '${NODE_ABI}'; nodeSha = '${NODE_SHA256}'`);
    expect(body).toContain(`sqliteVersion = '${sqlite}'; sqliteSha = '${sqliteSha}'`);
    // Kanal: önce alan adı, yoksa Vercel'in adresi; güncelleyicinin (guncelle.mjs) adresleriyle aynı
    const { MANIFEST_URLS, nodeZipUrl, sqliteTarUrl } = await load('guncelle.mjs');
    const kanal = /^\$Kanal = @\((.*)\)\r$/m.exec(body)![1]!;
    expect(kanal.split(', ').map((s) => `${s.slice(1, -1)}surum.json`)).toEqual(MANIFEST_URLS);
    // İndirme adresleri güncelleyicinin kalıbıyla aynı (kanal yalnız sürüm ve özet verir)
    const values = { nodeVersion: NODE_VERSION, nodeAbi: NODE_ABI, sqliteVersion: sqlite, taban: `https://${ALAN_ADI}/guncelleme/`, appFile: manifest.app.file };
    const nodeExpr = /Indir \((.*?)\) \$nodeZip /.exec(body)![1]!;
    expect(concat(nodeExpr, values)).toBe(nodeZipUrl(NODE_VERSION));
    const sqliteName = /\$sqliteAd = (.*?)\r/.exec(body)![1]!;
    const sqliteExpr = /Indir \((.*?)\) \$sqliteTgz /.exec(body)![1]!.replace('$sqliteAd', sqliteName);
    expect(concat(sqliteExpr, values)).toBe(sqliteTarUrl(sqlite, NODE_ABI));
    const appExpr = /Indir \((.*?)\) \$appZip /.exec(body)![1]!;
    expect(concat(appExpr, values)).toBe(`https://${ALAN_ADI}/guncelleme/${UYGULAMA_ZIP_ONEKI}${manifest.build}.zip`);
    // Her indirme SHA-256 ile doğrulanır; uygulama yükünün boyu da
    expect(body).toMatch(/Get-FileHash -LiteralPath \$Hedef -Algorithm SHA256/);
    expect(body).toMatch(/\$Surum\.nodeSha/);
    expect(body).toMatch(/\$Surum\.sqliteSha/);
    expect(body).toMatch(/\$Surum\.appSha/);
    expect(body).toMatch(/Length -ne \$Surum\.appSize/);
  });

  it('kurulum dosyasıyla (asilpos.nsi) aynı görev, güvenlik duvarı ve klasörler', async () => {
    const { text } = await build();
    const nsi = read('scripts/kasa/windows/kurulum/asilpos.nsi');
    const body = psBody(text);
    // Görev XML'i satır satır aynı (komut ve klasör satırları dışında)
    const nsiTask = [...nsi.matchAll(/!insertmacro TaskLine '(.*)'$/gm)].map((m) => m[1]!).filter((l) => !/\$(SYSDIR|INSTDIR)/.test(l));
    for (const line of nsiTask) expect(body, line).toContain(`'${line}'`);
    expect(body).toContain("'/RU', 'SYSTEM'");
    expect(nsi).toContain(`!define TASK "${SUNUCU_GOREVI}"`);
    expect(body).toContain(`$Gorev = '${SUNUCU_GOREVI}'`);
    expect(body).toContain("@('localsubnet', '100.64.0.0/10')");
    expect(body).toContain("'*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'");
    // Klasörler kurulu kasadaki eski adla (shared/eski-adlar.ts); eski Başlat menüsü ve kısayollar silinir
    expect(body).toContain(`Join-Path $env:ProgramData '${KURULUM_KLASORU}'`);
    expect(body).toContain(`Join-Path $ProgramKlasoru '${KURULUM_KLASORU}'`);
    expect(body).toContain(`$EskiAd = '${ESKI_URUN_ADI}'`);
    expect(nsi).toContain('!insertmacro EskiKisayollariSil');
    // Başlatıcı, kasa kısayolu, yönetim betiği, simge, notlar, ayar örneği ve kaldırıcı dosyanın içinde
    const files = embedded(text);
    // Eski adlı kök dosyalar: eski kısayolların çağırdığı yönlendirici, eski Uygulamalar kaydının simgesi ve kaldırıcı
    const eskiKasa = `${ESKI_URUN_ADI}-Kasa.bat`;
    const kaldirici = `${ESKI_URUN_ADI}-Kaldir.ps1`;
    const eskiIkon = `${ESKI_URUN_ADI.toLowerCase()}.ico`;
    expect(Object.keys(files).sort()).toEqual(['AsilPOS-Kasa.bat', 'BENIOKU.txt', eskiKasa, kaldirici, 'ayarlar.env.ornek', 'asilpos.ico', 'baslat.cmd', eskiIkon, 'yonet.ps1'].sort());
    expect(files[eskiIkon]!.equals(files['asilpos.ico']!)).toBe(true);
    expect(files[eskiKasa]!.toString('latin1')).toContain('"%~dp0AsilPOS-Kasa.bat" %*');
    expect(files['baslat.cmd']!.toString('utf8')).toBe(read('scripts/kasa/windows/kurulum/baslat.cmd').replace(/\r?\n/g, '\r\n'));
    expect(files['asilpos.ico']!.equals(readFileSync(new URL('scripts/kasa/windows/kurulum/asilpos.ico', root)))).toBe(true);
    // cmd ve Windows PowerShell 5.1 BOM'suz dosyayı yerel kod sayfasıyla okur: bu ikisi ASCII
    for (const f of ['baslat.cmd', 'AsilPOS-Kasa.bat', eskiKasa, 'yonet.ps1']) expect(/^[\x00-\x7f]*$/.test(files[f]!.toString('latin1')), f).toBe(true);
    for (const f of ['BENIOKU.txt', 'ayarlar.env.ornek', kaldirici]) expect(files[f]!.subarray(0, 3).toString('hex'), f).toBe('efbbbf');
  });

  it('gizli bir şey taşımaz', async () => {
    const sentinel = 'gizli-deger-7f3a9c2e1b5d4a6f8e0c';
    for (const k of ['ASILPOS_CLOUD_SECRET', 'ASILPOS_UZAKTAN_PAROLA', 'LAFFOGATO_SYNC_SECRET', 'LAFMALIYET_SYNC_SECRET', 'GITHUB_TOKEN', 'KV_REST_API_TOKEN', 'VERCEL_OIDC_TOKEN']) process.env[k] = sentinel;
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
    expect(ps51Problems(read('scripts/kasa/windows/kurulum/kisayollar.ps1'))).toEqual([]);
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

  it('kanal derlemesi kurucuyu güncelleme kanalının yanına iki adla yazar; Vercel ikisini de indirme olarak sunar', async () => {
    // İki adla, aynı baytlar: ladmin'in şube kurucusu ve eski bağlantılar eski adı ister
    const { OLD_WEB_INSTALLER_NAME } = await load('web-kurucu.mjs');
    const kanal = read('scripts/kasa/windows/kurulum/kanal.mjs');
    expect(kanal).toContain('const kurucu = webInstaller({ manifest });');
    expect(kanal).toContain('writeFileSync(join(OUT, WEB_INSTALLER_NAME), kurucu);');
    expect(kanal).toContain('writeFileSync(join(OUT, OLD_WEB_INSTALLER_NAME), kurucu);');
    expect(OLD_WEB_INSTALLER_NAME).toBe(ESKI_WEB_KURUCU);
    const vercel = JSON.parse(read('vercel.json'));
    // Arayüzün yedek sayfası /guncelleme/'yi yutmaz
    expect(vercel.rewrites.at(-1).source).toContain('guncelleme/');
    for (const ad of ['AsilPOS-Kur.cmd', ESKI_WEB_KURUCU]) {
      const h = vercel.headers.find((x: any) => x.source === `/guncelleme/${ad}`);
      expect(h.headers.find((x: any) => x.key === 'content-disposition').value, ad).toBe(`attachment; filename="${ad}"`);
    }
  });
});

/**
 * Çalışan kasada siteden kurulum (28 Kasım 2026, sahibin kasası: "Çalışan AsilPOS sunucusu durduruluyor > AsilPOS
 * kuruluyor > Kurulum yarıda kaldı: The process cannot access the file because it is being used by another process").
 * Görev sorgusu görevi bulamadı, sunucu durdurulmadı; çalışma klasörü app\ olan sunucu klasörün taşınmasını engelledi.
 * Gerçek Windows'ta CI dener (ci-kurulum.mjs F4, F4b, F5); burada sıra ve yapı.
 */
describe('siteden kurulum: çalışan kasada', () => {
  const ps = read('scripts/kasa/windows/kurulum/web-kurucu.ps1').replace(/\r\n/g, '\n');
  const kur = between(ps, '# ─── Kur ', '$acildi = $false');

  it('görev sorgusuna dayanmaz: görevi her durumda kapatmayı dener, kurulum klasöründeki Node süreçlerini bekçiden başlayarak durdurur', () => {
    // Sorgu yok: kapatmanın sonucu görevin var olduğunu söyler (asilpos.nsi de böyle)
    expect(ps).not.toContain("'/Query'");
    expect(kur).toContain("$GorevVardi = ((Calistir $schtasks @('/Change', '/TN', $Gorev, '/DISABLE')) -eq 0)");
    expect(kur).toContain('if ($GorevVardi) { $SunucuDurdu = $true }');
    // Sıra: görev kapanır ve biter, süreçler durur, veritabanı kopyalanır, sonra yer değiştirme
    const sira = [
      "@('/Change', '/TN', $Gorev, '/DISABLE')",
      "@('/End', '/TN', $Gorev)",
      'if ((SurecleriDurdur) -gt 0) { $SunucuDurdu = $true }',
      'Copy-Item -LiteralPath $db -Destination $yedek',
      'Tasi $app $appEski',
    ].map((t) => kur.indexOf(t));
    expect(sira.every((i) => i > 0), JSON.stringify(sira)).toBe(true);
    expect([...sira].sort((a, b) => a - b)).toEqual(sira);
    // Süreçler görevden bağımsız bulunur: çalıştırılan dosya kurulumun Node'u (ya da güncellemenin node.yeni'si)
    const surecler = between(ps, 'function KurulumSurecleri', 'function SurecleriDurdur');
    expect(surecler).toContain('Get-CimInstance -ClassName Win32_Process -Filter "Name=\'node.exe\'"');
    expect(surecler).toContain("$nodeKoku = (Join-Path $Kur 'node') + '\\'");
    expect(surecler).toContain("$yeniKoku = (Join-Path $Kur 'node.yeni') + '\\'");
    expect(surecler).toContain('$yol = [string]$_.ExecutablePath');
    expect(surecler).toContain('$yol.StartsWith($nodeKoku, [StringComparison]::OrdinalIgnoreCase)');
    // Bekçi önce (yoksa sunucuyu bir saniyede yeniden açar); hiçbiri kalmayana dek en çok 20 sn
    const durdur = between(ps, 'function SurecleriDurdur', 'function SunucuyuGeriAc');
    expect(durdur).toContain("$bekciler = @($kalan | Where-Object { [string]$_.CommandLine -match 'bekci\\.mjs' })");
    expect(durdur).toContain('foreach ($p in ($bekciler + $digerleri)) {');
    expect(durdur).toContain('$bitis = (Get-Date).AddSeconds(20)');
    expect(durdur).toContain('if ($kalan.Count -eq 0 -or (Get-Date) -gt $bitis) { return $durdurulan }');
    expect(durdur).toContain('Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop');
    // İşlev betiğin değişkenine yazmaz (kurucu ScriptBlock olarak çalışır: işlevin yazdığı kapsam ayrı); sonucu döndürür
    expect(ps).not.toMatch(/\$script:/);
  });

  it('dört yer değiştirme tek denemede, her biri yeniden denenerek; olmazsa yeni klasör kalkar, eskiler ayrı ayrı döner', () => {
    const tasi = between(ps, 'function Tasi(', 'function KurulumSurecleri');
    expect(tasi).toContain('for ($i = 1; $i -le 20; $i++) {');
    expect(tasi).toContain('Start-Sleep -Milliseconds 500');
    expect(tasi).toContain('if ($i -ge 20) { throw }');
    // Hedef varsa taşınmaz (Move-Item klasörü onun içine koyardı)
    expect(tasi.indexOf("if (Test-Path -LiteralPath $Nereye) { throw")).toBeLessThan(tasi.indexOf('Move-Item'));
    // Kurulum bölümü klasörleri yalnız Tasi ile taşır
    expect(kur).not.toMatch(/Rename-Item|Move-Item/);
    const dene = between(kur, "  try {\n    # Otomatik güncellemenin", '  } catch {');
    const adimlar = [
      "foreach ($k in @('app.eski', 'app.yeni', 'app.bozuk', 'node.eski', 'node.yeni')) { Sil (Join-Path $Kur $k) }",
      'Tasi $app $appEski; $eskiAppTasindi = $true',
      'Tasi $node $nodeEski; $eskiNodeTasindi = $true',
      "Tasi (Join-Path $Gecici 'app') $app",
      '$yeniAppKondu = $true',
      "Tasi (Join-Path $Gecici 'node') $node",
    ].map((t) => dene.indexOf(t));
    expect(adimlar.every((i) => i >= 0), JSON.stringify(adimlar)).toBe(true);
    expect([...adimlar].sort((a, b) => a - b)).toEqual(adimlar);
    // Geri alma bayraklarla (var olan klasöre bakmak önceki kurulumdan kalan app.eski'yi eski sürüm sanardı); her adım ayrı
    const geri = between(kur, '$neden = $_.Exception.Message', "throw ('Program klasörü yazılamadı");
    expect(geri).toContain('if ($yeniAppKondu) { try { Sil $app } catch { $eskiYerinde = $false } }');
    expect(geri).toContain('if ($eskiAppTasindi) { try { Tasi $appEski $app } catch { $eskiYerinde = $false } }');
    expect(geri).toContain('if ($eskiNodeTasindi) { try { Tasi $nodeEski $node } catch { $eskiYerinde = $false } }');
    expect(geri.indexOf('Sil $app')).toBeLessThan(geri.indexOf('Tasi $appEski $app'));
    // "Eski sürüm çalışıyor" yalnız eski sürüm gerçekten yerindeyse söylenir
    expect(geri).toContain("if ($eskiYerinde -and (Test-Path -LiteralPath (Join-Path $app 'bekci.mjs')) -and (Test-Path -LiteralPath (Join-Path $node 'node.exe'))) {");
    // Eski sürümün artıkları silinemezse uyarı; kurulum yarıda kalmaz
    const sonra = between(kur, "throw ('Program klasörü yazılamadı", "# Veri klasörü:");
    expect(sonra).toContain('foreach ($k in @($appEski, $nodeEski)) {');
    expect(sonra).toContain("try { Sil $k } catch { Write-Host (");
    expect(sonra).toContain('try { Sil $Gecici } catch { Write-Host (');
    expect(sonra).not.toMatch(/^\s*Sil /m);
  });

  it('yarıda kalınca önce sunucu geri açılır, sonra geçici klasör (silinemese de); ileti ne olduğunu ve ne yapılacağını söyler', () => {
    // Kurulum bölümünün dış catch'i (satır başında; içindeki try { } catch { } değil)
    const dis = ps.slice(ps.lastIndexOf('\n} catch {\n', ps.indexOf('$acildi = $false')), ps.indexOf('$acildi = $false'));
    const sira = ['$hata = $_.Exception.Message', 'SunucuyuGeriAc', 'try { Sil $Gecici } catch { }', "Dur ('Kurulum yarıda kaldı: ' + $hata)"].map((t) => dis.indexOf(t));
    expect(sira.every((i) => i >= 0), JSON.stringify(sira)).toBe(true);
    expect([...sira].sort((a, b) => a - b)).toEqual(sira);
    // İndirme yarıda kalırsa da geçici klasörün silinememesi iletiyi engellemez
    expect(ps).toContain("  $hata = $_.Exception.Message\n  try { Sil $Gecici } catch { }\n  Dur ('Kurulum yapılamadı: ' + $hata)");
    // Geri açma: bir şey durdurulduysa. Görev yalnız vardıysa yeniden açılır; yoksa görev denenir, sunucu gelmezse başlatıcı
    // görevin komutuyla açılır
    const geri = between(ps, 'function SunucuyuGeriAc', 'function Dur(');
    expect(geri).toContain('if (-not $SunucuDurdu) { return }');
    const varsa = between(geri, 'if ($GorevVardi) {', '} else {');
    const yoksa = geri.slice(geri.indexOf('} else {'));
    expect(varsa).toContain("@('/Change', '/TN', $Gorev, '/ENABLE')");
    expect(varsa).toContain("@('/Run', '/TN', $Gorev)");
    expect(yoksa).not.toContain("'/ENABLE'");
    expect(yoksa).toContain("@('/Run', '/TN', $Gorev)");
    expect(yoksa).toContain('$calisiyor = (@(KurulumSurecleri).Count -gt 0)');
    expect(yoksa).toContain("Start-Process -FilePath (Join-Path $Sys 'cmd.exe') -ArgumentList ('/d /c \"\"' + $baslatici + '\"\"') -WorkingDirectory $Kur -WindowStyle Hidden");
    // Başlatıcı görevin komutuyla aynı biçimde (görev XML'i)
    expect(ps).toContain("('    <Arguments>/d /c \"\"' + $baslat + '\"\"</Arguments>')");
    // İleti: ne oldu, eski sürüm çalışıyor, ne yapılır (programın içinden Şimdi güncelle ya da yeniden başlatıp yeniden)
    expect(ps).toContain(
      "$KullanimdaIletisi = 'Program dosyaları kullanımda olduğu için değiştirilemedi; eski sürüm çalışıyor. En kolayı: Yönetim > Ayarlar ve yedek > Sürüm ve güncelleme > Şimdi güncelle. Ya da bilgisayarı yeniden başlatıp bu dosyayı yeniden çalıştırın.'",
    );
    expect(kur).toContain("throw ($KullanimdaIletisi + ' Ayrıntı: ' + $neden)");
    // İletideki yol kasadaki adlarla aynı
    expect(read('src/pages/admin/SettingsAdmin.tsx')).toContain('<PageHeader title="Ayarlar ve yedek"');
    const kart = read('src/components/admin/UpdateCard.tsx');
    expect(kart).toContain('title="Sürüm ve güncelleme"');
    expect(kart).toContain("confirmLabel: 'Şimdi güncelle'");
    // Uzun tire yok (sade metin)
    expect(ps).not.toMatch(/[\u2013\u2014]/);
  });

  it('aynı anda tek kurulum; kurulu sürüm daha yeniyse kurmaz; sağlık beklemesi bu derleme ya da yenisi', () => {
    // Adlı kilit yönetici izninden sonra (izni isteyen ilk kopya tutmaz), sürüm sorulmadan önce; ikinci kopya açıklayıp çıkar
    const kilit = ps.indexOf("$Kilit = New-Object System.Threading.Mutex($false, 'Global\\AsilPOS-Kurulum')");
    expect(kilit).toBeGreaterThan(ps.indexOf('Start-Process -FilePath $Kaynak -Verb RunAs'));
    expect(kilit).toBeLessThan(ps.indexOf("Adim 'Son sürüm soruluyor'"));
    expect(ps).toContain('try { $kilitBende = $Kilit.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $kilitBende = $true }');
    expect(between(ps, 'if (-not $kilitBende) {', '\n}')).toContain("Dur 'Bu bilgisayarda başka bir AsilPOS kurulumu sürüyor");
    // Sürüm geri düşmez: kurulu derleme güncelleyicinin okuduğu yerden; indirmeden önce, başarıyla çıkar
    const derleme = between(ps, 'function KuruluDerleme', '# ─── İndir');
    expect(derleme).toContain("Get-Content -LiteralPath (Join-Path $Kur 'app\\package.json') -Raw | ConvertFrom-Json");
    expect(derleme).toContain('if ($kuruluDerleme -gt [long]$Surum.build) {');
    expect(derleme).toContain('exit 0');
    expect(ps.indexOf('$kuruluDerleme = KuruluDerleme')).toBeGreaterThan(ps.indexOf("Write-Host ('  AsilPOS ' + $Surum.version"));
    expect(ps.indexOf('$kuruluDerleme = KuruluDerleme')).toBeLessThan(ps.indexOf("Adim 'İndiriliyor"));
    expect(read('scripts/kasa/windows/kurulum/guncelle.mjs')).toContain("readFileSync(join(appDir, 'package.json'), 'utf8')");
    // Sağlık: bu derleme ya da arada kendiliğinden gelen yenisi
    expect(ps).toContain('if ([long]$saglik.build -ge [long]$Surum.build) { $acildi = $true; break }');
    expect(ps).not.toContain('$saglik.build -eq');
  });

  it('başarıda Enter beklemez, birkaç saniye sonra kendiliğinden kapanır; hata ve uyarıda bekler; sessiz kip aynı', () => {
    const kapan = between(ps, 'function KendiligindenKapan', 'function Calistir');
    expect(kapan).toContain('if ($Sessiz) { return }');
    expect(kapan).toContain('Start-Sleep -Seconds $Saniye');
    expect(kapan).not.toContain('Read-Host');
    const son = ps.slice(ps.indexOf('if ($acildi) {', ps.indexOf('$acildi = $false')));
    const basari = between(son, 'if ($acildi) {', '} else {');
    expect(basari).toContain('KendiligindenKapan 10');
    expect(basari).not.toMatch(/\bBekle\b/);
    expect(son.slice(son.indexOf('} else {'))).toMatch(/\n {2}Bekle\n\}/);
    expect(between(ps, 'function Dur(', 'exit 1')).toContain('Bekle');
    // CI'ın çıkış kodları aynı (sessizde sunucu açılmazsa 4)
    expect(son).toContain('if (-not $acildi -and $Sessiz) { exit 4 }\nexit 0');
  });

  it('dış komutlar konsolun özgün kod sayfasıyla çalışır; bütün schtasks çağrıları bu yardımcıdan', () => {
    expect(ps.indexOf('try { $OzgunKodlama = [Console]::OutputEncoding } catch { }')).toBeGreaterThan(0);
    expect(ps.indexOf('try { $OzgunKodlama = [Console]::OutputEncoding } catch { }')).toBeLessThan(ps.indexOf('try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }'));
    const calistir = between(ps, 'function Calistir(', 'function Sil(');
    const once = calistir.indexOf('[Console]::OutputEncoding = $OzgunKodlama');
    const komut = calistir.indexOf('& $Exe @Arg 2>&1 | Out-Null');
    const sonra = calistir.indexOf('} finally {');
    expect(once).toBeGreaterThan(0);
    expect(komut).toBeGreaterThan(once);
    expect(sonra).toBeGreaterThan(komut);
    expect(calistir.slice(sonra)).toContain('if ($dondu) { try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { } }');
    for (const m of ps.matchAll(/^.*schtasks.*$/gm)) {
      const satir = m[0].trim();
      if (satir.startsWith('#') || /^\$schtasks = Join-Path \$Sys 'schtasks\.exe'$/.test(satir)) continue;
      expect(satir).toMatch(/Calistir \$schtasks @\(/);
    }
  });
});

describe('siteden kurulum: İndir sayfası', () => {
  it('menüde yalnız AsilPOS Uzaktan’da, en sonda', async () => {
    const { remoteNav } = await import('../src/lib/remote');
    const { POS_NAV } = await import('../src/lib/nav');
    const { DOWNLOAD_NAV, WEB_INSTALLER_PATH } = await import('../src/lib/download');
    const { WEB_INSTALLER_NAME, WEB_INSTALLER_URL } = await load('web-kurucu.mjs');
    expect(remoteNav(POS_NAV, false)).toEqual(POS_NAV);
    const remote = remoteNav(POS_NAV, true);
    expect(remote.at(-1)).toBe(DOWNLOAD_NAV);
    expect(remote.map((n) => n.to)).toEqual(['/masalar', '/mutfak', '/raporlar', '/patron', '/merkez', '/uzaktan-yonetim', '/indir']);
    expect(DOWNLOAD_NAV.label).toBe('İndir');
    expect(WEB_INSTALLER_URL).toBe(`https://${ALAN_ADI}${WEB_INSTALLER_PATH}`);
    expect(WEB_INSTALLER_PATH.endsWith(WEB_INSTALLER_NAME)).toBe(true);
  });

  it('bağlantı yalnız girişten sonra: rota oturumlu kabukta, giriş ekranında indirme yok', () => {
    const app = read('src/App.tsx');
    const authed = app.indexOf('function Authed()');
    const appFn = app.indexOf('export function App()');
    const route = app.indexOf('{REMOTE && <Route path={DOWNLOAD_PATH} element={<DownloadPage />} />}');
    const standalone = app.indexOf('<StandaloneDownloadPage ');
    expect(authed).toBeGreaterThan(0);
    for (const at of [route, standalone]) {
      expect(at).toBeGreaterThan(authed);
      expect(at).toBeLessThan(appFn);
    }
    // Oturum yoksa App giriş ekranını çizer, Authed'e hiç inmez
    expect(app.slice(appFn)).toMatch(/if \(!me\) \{[\s\S]*?RemoteLoginPage[\s\S]*?\}\s*if \(location\.pathname === '\/giris'\)[\s\S]*?return <Authed \/>;/);
    const login = read('src/pages/RemoteLoginPage.tsx');
    expect(login).not.toMatch(/AsilPOS-Kur|guncelleme\/|download|indir'/i);
    expect(login).toContain('Üye girişi');
  });

  it('İndir uzaktan e2e taramasında (telefon, tablet, bilgisayar, koyu; girişten önce ve sonra)', () => {
    expect(read('e2e/uzaktan.mjs')).toMatch(/REMOTE_ROUTES = \[[^\]]*'\/indir'/);
    expect(read('e2e/run.mjs')).toMatch(/await runRemote\(browser\)/);
  });
});
