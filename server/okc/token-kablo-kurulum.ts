import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { dllPath, HUB_DLL, TOKEN_KABLO_DIR, vcRuntimeX86 } from './token-kablo';

/**
 * Token kablolu bağlantının bilgisayar tarafı kurulumu (Yönetim › Yazarkasa POS › Kurulumu yap). Kasa sunucusu Windows'ta
 * SYSTEM olarak çalışır (Görev Zamanlayıcı, asilpos.nsi): kurulumlar onay penceresi açmadan, sessiz yapılır.
 *
 * 1. Visual C++ çalışma kitaplığı (x86): Microsoft'un kalıcı adresinden; dosyanın Microsoft imzası denetlenir.
 * 2. Token'ın kütüphanesi (IntegrationHub.dll): Token'ın açık örnek projesinden, sabit commit ve SHA-256 ile.
 * 3. Cihaz sürücüsü (300TR FTDI, X30TR libusbK): Token'ın "TokenX Connect (Wired) Sürücü Kurulum Aracı"nın içindeki iki
 *    sürücü kurucusu; yalnız cihaz görünmezse, sabit SHA-256 ile. Aracın kendisi çalıştırılmaz (aşağıda `DRIVER_TOOL`).
 */

export const VC_REDIST_X86 = 'https://aka.ms/vs/17/release/vc_redist.x86.exe';

/**
 * Token'ın sürücü kurulum aracı (Token geliştirici sitesi › Hızlı Başlangıç), v2.9.3.
 *
 * Araç bir kurulum paketi değil, pencereli bir sihirbazdır (.NET WinForms, `hizlisepetcheck`): komut satırı okumaz.
 * Kasa sunucusu SYSTEM olarak çalıştığı için penceresi görünmez ve hiç kapanmaz; bu yüzden ÇALIŞTIRILMAZ. İçine gömdüğü
 * iki sürücü kurucusu dosyadaki yerinden alınır (`parts`: konum, uzunluk, SHA-256; aracın özeti sabit olduğu için
 * konumlar da sabittir, her parça ayrıca kendi özetiyle doğrulanır):
 * - `x30tr`: Token'ın derlediği wdi-simple (konsol programı). Argümansız çalışınca X30TR'nin iki USB kimliği
 *   (18D1:2D00 ve 18D1:4EE1) için libusbK sürücüsünü kurar; araç ardından sürücü deposundaki .inf'leri pnputil ile ekler.
 * - `tr300`: FTDI CDM 2.12.36.4 sürücülerinin kendi kendini açan (pencereli) paketi; içindeki zip'ten `ftdibus.inf` ve
 *   `ftdiport.inf` pnputil ile kurulur (sürücüler Microsoft imzalı, onay istemez).
 */
export const DRIVER_TOOL = {
  url: 'https://828363377-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FTDApe9ujkHROOK7s0JPT%2Fuploads%2FQ94dAe3STDI8fMAokAIn%2FTokenX%20Connect%20(Wired)%20S%C3%BCr%C3%BCc%C3%BC%20Kurulum%20Arac%C4%B1%20v2.9.3.zip?alt=media&token=7ab29ba3-3488-4edf-97b0-53fe659c9c75',
  sha256: '82c81d1d80b6a83c5a5bc6937e25b14f9a5b7abdf661274c05e7869b375086b3',
  version: '2.9.3',
  parts: {
    x30tr: { offset: 43_042_185, size: 7_307_776, sha256: 'b735e912b465cb7bb958cad251b25068ed8c2ad9026e713f1dfd7473e24902a0' },
    tr300: { offset: 503_353, size: 2_264_632, sha256: '835dd64b199190d20dc37c0cadeb064b7eaaaef271703781b2b259b7085437a4' },
  },
} as const;

/** Aracın içindeki bir dosya: dosya başından konumu, uzunluğu ve özeti */
export interface EmbeddedPart {
  offset: number;
  size: number;
  sha256: string;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function download(url: string, maxBytes: number): Promise<Buffer> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5 * 60_000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`indirilemedi (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('dosya beklenenden büyük');
    return buf;
  } catch (e) {
    throw new Error(`İndirme başarısız: ${e instanceof Error ? (e.name === 'AbortError' ? 'süre doldu' : e.message) : String(e)}. Kasa bilgisayarının internetini kontrol edin`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Süreci başlattıklarıyla birlikte kapatır. Yalnız PowerShell kapanırsa başlattığı kurucu yetim kalır ve kendi
 * dosyasını kilitli tutar. taskkill ağacı ana süreçten yürür: ana süreç ondan sonra kapatılır
 */
function killTree(p: ChildProcess) {
  if (process.platform !== 'win32' || !p.pid) {
    p.kill();
    return;
  }
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  try {
    const k = spawn(exe, ['/T', '/F', '/PID', String(p.pid)], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => p.kill());
    k.on('exit', () => p.kill());
  } catch {
    p.kill();
  }
}

/** 64 bit Windows PowerShell'de komut (sistem işleri: imza denetimi, arşiv açma, kurulum) */
export function runPowershell(command: string, timeoutMs = 10 * 60_000): Promise<{ code: number | null; out: string }> {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const exe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d: string) => (out += d));
    p.stderr.on('data', (d: string) => (out += d));
    const timer = setTimeout(() => {
      killTree(p);
      reject(new Error('Kurulum süre sınırını aştı'));
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim().slice(-2_000) });
    });
  });
}

/** PowerShell'de tek tırnaklı dize */
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Token'ın kütüphanesi indirilmiş ve özeti tutuyor mu */
export function dllReady(): boolean {
  const file = dllPath();
  return existsSync(file) && sha256(readFileSync(file)) === HUB_DLL.sha256;
}

/** Kütüphaneyi indirir (özeti tutmazsa yazmaz); hazırsa `false` (atlandı) */
export async function ensureDll(): Promise<boolean> {
  if (dllReady()) return false;
  const buf = await download(HUB_DLL.url, 20 * 1024 * 1024);
  if (sha256(buf) !== HUB_DLL.sha256) throw new Error('İndirilen Token kütüphanesinin özeti tutmuyor; dosya yazılmadı');
  mkdirSync(TOKEN_KABLO_DIR(), { recursive: true });
  const file = dllPath();
  writeFileSync(`${file}.part`, buf);
  renameSync(`${file}.part`, file);
  return true;
}

/** Visual C++ (x86) yoksa sessiz kurar; kuruluysa `false` (atlandı) */
export async function ensureVcRuntime(): Promise<boolean> {
  if (vcRuntimeX86()) return false;
  const buf = await download(VC_REDIST_X86, 60 * 1024 * 1024);
  const dir = TOKEN_KABLO_DIR();
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, 'vc_redist.x86.exe');
  writeFileSync(exe, buf);
  try {
    // Yalnız Microsoft imzalı ve imzası geçerli dosya çalışır (adres sabit sürüm vermez; özet yerine imza)
    const sig = await runPowershell(`$s = Get-AuthenticodeSignature -FilePath ${psQuote(exe)}; "$($s.Status)|$($s.SignerCertificate.Subject)"`, 60_000);
    if (!/^Valid\|.*O=Microsoft Corporation/m.test(sig.out)) throw new Error(`Visual C++ kurulum dosyasının imzası doğrulanamadı (${sig.out.slice(0, 120)})`);
    const run = await runPowershell(`$p = Start-Process -FilePath ${psQuote(exe)} -ArgumentList '/install','/quiet','/norestart' -Wait -PassThru; exit $p.ExitCode`);
    // 0 kuruldu, 1638 daha yenisi var, 3010 yeniden başlatma gerekir (kitaplık yine de kullanılabilir)
    if (run.code !== 0 && run.code !== 1638 && run.code !== 3010) throw new Error(`Visual C++ kurulamadı (çıkış kodu ${run.code})`);
  } finally {
    rmSync(exe, { force: true });
  }
  if (!vcRuntimeX86()) throw new Error('Visual C++ kuruldu ama kitaplık bulunamadı; bilgisayarı yeniden başlatıp tekrar deneyin');
  return true;
}

const driverMarker = () => join(TOKEN_KABLO_DIR(), 'surucu.json');

/** Sürücü kurulumunun sonucu, model başına (iki modelin sürücüsü de kurulur: hangisinin takılacağı bilinmez) */
export interface DriverResult {
  x30tr: boolean;
  tr300: boolean;
  /** Windows sürücünün etkinleşmesi için yeniden başlatma istedi */
  reboot: boolean;
  /** Kurulamayan modelin nedeni (ekranda ve günlükte) */
  errors: string[];
}

/**
 * İki modelin sürücüsü de bu bilgisayara (aracın bu sürümünden) kuruldu mu. Yalnız biri kurulduysa öteki sonraki
 * kurulumda yeniden denenir. Model ayrımı taşımayan eski işaret sayılmaz: onu yazan sürüm sihirbazı çalıştırıyordu
 */
export function driverInstalled(): boolean {
  try {
    const m = JSON.parse(readFileSync(driverMarker(), 'utf8')) as { version?: string; x30tr?: boolean; tr300?: boolean };
    return m.version === DRIVER_TOOL.version && m.x30tr === true && m.tr300 === true;
  } catch {
    return false;
  }
}

/** Aracın içinden bir kurucuyu alır (saf). Konum ya da özet tutmazsa araç değişmiştir: hiçbir şey çalıştırılmaz */
export function slicePart(tool: Uint8Array, part: EmbeddedPart, name: string): Buffer {
  if (tool.length < part.offset + part.size) throw new Error(`Token sürücü aracında ${name} bulunamadı (dosya beklenenden kısa)`);
  const out = Buffer.from(tool.buffer, tool.byteOffset + part.offset, part.size);
  if (sha256(out) !== part.sha256) throw new Error(`Token sürücü aracındaki ${name} özeti tutmuyor; çalıştırılmadı`);
  return out;
}

// Uint8Array: dosya yüklenirken çalışır, tarayıcı demosunda Buffer yok (Buffer.lastIndexOf bunu da arar)
const ZIP_END = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;

/**
 * Kendi kendini açan paketin içindeki zip (saf): program gövdesi zip'in önündedir, sonda imza artığı olabilir. Zip'in
 * başı son kaydından (EOCD) geriye hesaplanır; dönen parça Windows'un açabildiği temiz bir zip'tir
 */
export function embeddedZip(exe: Uint8Array): Buffer {
  const b = Buffer.from(exe.buffer, exe.byteOffset, exe.length);
  let at = b.lastIndexOf(ZIP_END);
  for (let i = 0; i < 16 && at >= 0; i++) {
    if (at + 22 <= b.length) {
      const dirSize = b.readUInt32LE(at + 12);
      const dirOffset = b.readUInt32LE(at + 16);
      const start = at - dirSize - dirOffset;
      const end = at + 22 + b.readUInt16LE(at + 20);
      if (start >= 0 && end <= b.length && dirSize > 0 && b.readUInt32LE(start) === ZIP_LOCAL && b.readUInt32LE(at - dirSize) === ZIP_CENTRAL) return b.subarray(start, end);
    }
    at = at > 0 ? b.lastIndexOf(ZIP_END, at - 1) : -1;
  }
  throw new Error('Sürücü paketinin içinde arşiv bulunamadı');
}

/**
 * Arşivdeki dosyalar (saf): ad → içerik; klasör girdileri atlanır. Windows PowerShell'in Expand-Archive'i Token'ın
 * arşivinde hata veriyor (gerçek Windows denemesi, 28 Kasım 2026: MethodCountCouldNotFindBest); arşiv burada açılır,
 * hiçbir şey çalıştırılmadan. Yalnız sıkıştırmasız ve deflate girdiler (bu iki arşivde başkası yok)
 */
export function unzip(zip: Uint8Array, maxBytes = 256 * 1024 * 1024): Map<string, Buffer> {
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.length);
  const end = b.lastIndexOf(ZIP_END);
  if (end < 0 || end + 22 > b.length) throw new Error('Arşiv okunamadı (sonu bulunamadı)');
  const count = b.readUInt16LE(end + 10);
  let at = b.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > b.length || b.readUInt32LE(at) !== ZIP_CENTRAL) throw new Error('Arşiv okunamadı (dizini bozuk)');
    const utf8 = (b.readUInt16LE(at + 8) & 0x800) !== 0;
    const method = b.readUInt16LE(at + 10);
    const packed = b.readUInt32LE(at + 20);
    const size = b.readUInt32LE(at + 24);
    const nameLen = b.readUInt16LE(at + 28);
    const local = b.readUInt32LE(at + 42);
    const name = b.toString(utf8 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32);
    if (name.endsWith('/')) continue;
    if (local + 30 > b.length || b.readUInt32LE(local) !== ZIP_LOCAL) throw new Error(`Arşivdeki ${name} okunamadı`);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    total += size;
    if (start + packed > b.length || total > maxBytes) throw new Error(`Arşivdeki ${name} okunamadı (boyut tutmuyor)`);
    const raw = b.subarray(start, start + packed);
    if (method !== 0 && method !== 8) throw new Error(`Arşivdeki ${name} açılamadı (sıkıştırma yöntemi ${method})`);
    const data = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    if (data.length !== size) throw new Error(`Arşivdeki ${name} bozuk`);
    out.set(name, data);
  }
  return out;
}

/** Arşivden gelen adı klasörün içinde tutar: üst klasöre ya da başka sürücüye çıkan ad reddedilir */
export function safeJoin(dir: string, name: string): string {
  const parts = name.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((x) => x === '..' || x === '.' || x.includes(':'))) throw new Error(`Arşivde beklenmeyen dosya adı: ${name.slice(0, 80)}`);
  return join(dir, ...parts);
}

/** pnputil'in "kuruldu" sayılan çıkış kodları: 0, 259 (eklendi; takılı aygıt yok ya da zaten güncel), 3010 (yeniden başlat) */
const PNPUTIL_OK = '@(0, 259, 3010)';
const PNPUTIL = "(Join-Path $env:SystemRoot 'System32\\pnputil.exe')";

/**
 * Sürücü klasöründen çalışan süreçleri kapatır: önceki sürümün görünmez açıp bıraktığı sihirbaz ve yarıda kalan
 * kurucular. Açık kalan süreç kendi dosyasını kilitler; klasör silinemez ve sonraki kurulum başlayamaz
 */
export function killStrayCommand(dir: string): string {
  return [
    `$d = ${psQuote(`${dir.replace(/[\\/]+$/, '')}\\`)}`,
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    'exit 0',
  ].join('; ');
}

/**
 * X30TR (libusbK): Token'ın wdi-simple'ı argümansız çalışır (pencere açmaz), sonra sürücü deposuna koyduğu .inf'ler
 * pnputil ile kurulur (Token'ın aracının yaptığı sıra). Çıkış: 0 tamam, 20 depoda sürücü yok, 21 pnputil reddetti
 */
export function x30trCommand(exe: string, dir: string): string {
  return [
    `$p = Start-Process -FilePath ${psQuote(exe)} -WorkingDirectory ${psQuote(dir)} -WindowStyle Hidden -Wait -PassThru`,
    "$store = Join-Path $env:SystemRoot 'System32\\DriverStore\\FileRepository'",
    "$infs = @(Get-ChildItem -LiteralPath $store -Directory -Filter 'token_x30tr_libusbk_vid*' -ErrorAction SilentlyContinue | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter '*.inf' })",
    '$bad = 0; $rb = 0',
    `foreach ($i in $infs) { & ${PNPUTIL} /add-driver $i.FullName /install | Out-Null; if ($LASTEXITCODE -eq 3010) { $rb = 1 }; if (${PNPUTIL_OK} -notcontains $LASTEXITCODE) { $bad = $LASTEXITCODE } }`,
    'Write-Output "wdi=$($p.ExitCode) inf=$($infs.Count) pnputil=$bad reboot=$rb"',
    'if ($infs.Count -eq 0) { exit 20 }',
    'if ($bad -ne 0) { exit 21 }',
    'exit 0',
  ].join('; ');
}

/**
 * 300TR (FTDI): paketten çıkarılmış klasördeki veri yolu ve seri kapı sürücüsü pnputil ile kurulur. Çıkış: 0 tamam, 20
 * sürücü dosyası yok, 21 pnputil reddetti
 */
export function tr300Command(dir: string): string {
  return [
    '$bad = 0; $rb = 0; $n = 0',
    `foreach ($f in @('ftdibus.inf', 'ftdiport.inf')) { $inf = Join-Path ${psQuote(dir)} $f; if (Test-Path -LiteralPath $inf) { $n++; & ${PNPUTIL} /add-driver $inf /install | Out-Null; if ($LASTEXITCODE -eq 3010) { $rb = 1 }; if (${PNPUTIL_OK} -notcontains $LASTEXITCODE) { $bad = $LASTEXITCODE } } }`,
    'Write-Output "inf=$n pnputil=$bad reboot=$rb"',
    'if ($n -lt 2) { exit 20 }',
    'if ($bad -ne 0) { exit 21 }',
    'exit 0',
  ].join('; ');
}

const tail = (out: string) => out.split(/\r?\n/).filter(Boolean).at(-1)?.slice(-160) ?? '';

/**
 * Token cihazlarının sürücülerini sessiz kurar (300TR FTDI, X30TR libusbK). Araç indirilir, özeti denetlenir, içindeki
 * iki kurucu alınır; aracın kendisi çalıştırılmaz. Modeller birbirinden bağımsızdır: biri kurulamazsa öteki yine
 * kurulur ve sonuçta söylenir; ikisi de kurulamazsa hata
 */
export async function installDriver(): Promise<DriverResult> {
  const dir = join(TOKEN_KABLO_DIR(), 'surucu');
  await runPowershell(killStrayCommand(dir), 60_000).catch(() => undefined);
  const buf = await download(DRIVER_TOOL.url, 120 * 1024 * 1024);
  if (sha256(buf) !== DRIVER_TOOL.sha256) throw new Error('Token sürücü aracının özeti tutmuyor (Token yeni sürüm yayımlamış olabilir); çalıştırılmadı');
  // Araç diske yazılmaz: arşiv bellekte açılır, yalnız içindeki iki kurucu çıkarılır
  const tool = [...unzip(buf)].find(([name]) => name.toLowerCase().endsWith('.exe'))?.[1];
  if (!tool) throw new Error('Token sürücü aracının arşivinde program yok');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const result: DriverResult = { x30tr: false, tr300: false, reboot: false, errors: [] };
  try {
    const part = async (model: 'x30tr' | 'tr300', label: string, run: () => Promise<{ code: number | null; out: string }>) => {
      try {
        const r = await run();
        if (r.code !== 0) throw new Error(`${r.code === 20 ? 'sürücü dosyaları bulunamadı' : `çıkış kodu ${r.code}`}${r.out ? ` (${tail(r.out)})` : ''}`);
        result[model] = true;
        if (/reboot=1/.test(r.out)) result.reboot = true;
      } catch (e) {
        result.errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    await part('x30tr', 'X30TR', async () => {
      const exe = join(dir, 'wdi-simple.exe');
      writeFileSync(exe, slicePart(tool, DRIVER_TOOL.parts.x30tr, 'X30TR sürücü kurucusu'));
      return runPowershell(x30trCommand(exe, dir));
    });
    await part('tr300', '300TR', async () => {
      const out = join(dir, 'ftdi');
      for (const [name, data] of unzip(embeddedZip(slicePart(tool, DRIVER_TOOL.parts.tr300, '300TR sürücü paketi')))) {
        const file = safeJoin(out, name);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, data);
      }
      return runPowershell(tr300Command(out));
    });
    if (!result.x30tr && !result.tr300) throw new Error(`Token sürücüsü kurulamadı (${result.errors.join('; ')})`);
    writeFileSync(driverMarker(), JSON.stringify({ version: DRIVER_TOOL.version, at: Date.now(), x30tr: result.x30tr, tr300: result.tr300, reboot: result.reboot }));
    return result;
  } finally {
    await runPowershell(killStrayCommand(dir), 60_000).catch(() => undefined);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Kilitli kalan dosya sonraki kurulumun başında silinir
    }
  }
}
