import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dllPath, HUB_DLL, TOKEN_KABLO_DIR, vcRuntimeX86 } from './token-kablo';

/**
 * Token kablolu bağlantının bilgisayar tarafı kurulumu (Yönetim › Yazarkasa POS › Kurulumu yap). Kasa sunucusu Windows'ta
 * SYSTEM olarak çalışır (Görev Zamanlayıcı, lafpos.nsi): kurulumlar onay penceresi açmadan, sessiz yapılır.
 *
 * 1. Visual C++ çalışma kitaplığı (x86): Microsoft'un kalıcı adresinden; dosyanın Microsoft imzası denetlenir.
 * 2. Token'ın kütüphanesi (IntegrationHub.dll): Token'ın açık örnek projesinden, sabit commit ve SHA-256 ile.
 * 3. Cihaz sürücüsü (300TR FTDI, X30TR libusbK): Token'ın "TokenX Connect (Wired) Sürücü Kurulum Aracı" (WiX); yalnız
 *    kablo takılıyken cihaz görünmezse, sabit SHA-256 ile.
 */

export const VC_REDIST_X86 = 'https://aka.ms/vs/17/release/vc_redist.x86.exe';

/** Token'ın sürücü kurulum aracı (Token geliştirici sitesi › Hızlı Başlangıç), v2.9.3 */
export const DRIVER_TOOL = {
  url: 'https://828363377-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FTDApe9ujkHROOK7s0JPT%2Fuploads%2FQ94dAe3STDI8fMAokAIn%2FTokenX%20Connect%20(Wired)%20S%C3%BCr%C3%BCc%C3%BC%20Kurulum%20Arac%C4%B1%20v2.9.3.zip?alt=media&token=7ab29ba3-3488-4edf-97b0-53fe659c9c75',
  sha256: '82c81d1d80b6a83c5a5bc6937e25b14f9a5b7abdf661274c05e7869b375086b3',
  version: '2.9.3',
} as const;

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
      p.kill();
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

/** Token'ın sürücü aracı bu bilgisayarda (bu sürümüyle) çalıştırıldı mı */
export function driverInstalled(): boolean {
  try {
    return (JSON.parse(readFileSync(driverMarker(), 'utf8')) as { version?: string }).version === DRIVER_TOOL.version;
  } catch {
    return false;
  }
}

/** Token'ın sürücü kurulum aracını indirir ve sessiz çalıştırır (300TR FTDI, X30TR libusbK) */
export async function installDriver(): Promise<void> {
  const buf = await download(DRIVER_TOOL.url, 120 * 1024 * 1024);
  if (sha256(buf) !== DRIVER_TOOL.sha256) throw new Error('Token sürücü aracının özeti tutmuyor (Token yeni sürüm yayımlamış olabilir); çalıştırılmadı');
  const dir = join(TOKEN_KABLO_DIR(), 'surucu');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, 'surucu.zip');
  writeFileSync(zip, buf);
  try {
    const run = await runPowershell(
      [
        `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(dir)} -Force`,
        `$exe = Get-ChildItem -LiteralPath ${psQuote(dir)} -Filter *.exe | Select-Object -First 1`,
        `if (-not $exe) { Write-Output 'arşivde kurulum dosyası yok'; exit 9 }`,
        `$p = Start-Process -FilePath $exe.FullName -ArgumentList '/quiet','/norestart' -Wait -PassThru`,
        'exit $p.ExitCode',
      ].join('; '),
    );
    if (run.code !== 0 && run.code !== 3010 && run.code !== 1638) throw new Error(`Token sürücüsü kurulamadı (çıkış kodu ${run.code}${run.out ? `: ${run.out.slice(-160)}` : ''})`);
    writeFileSync(driverMarker(), JSON.stringify({ version: DRIVER_TOOL.version, at: Date.now(), reboot: run.code === 3010 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
