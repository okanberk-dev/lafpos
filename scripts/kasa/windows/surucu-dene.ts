// Token cihaz sürücülerinin sessiz kurulumunu gerçek Windows'ta dener (.github/workflows/token-surucu.yml). Kasadaki
// yolun aynısı koşar (server/okc/token-kablo-kurulum.ts › installDriver): araç indirilir, içindeki iki kurucu alınır,
// X30TR'nin libusbK sürücüsü ve 300TR'nin FTDI sürücüsü pencere açmadan kurulur. Cihaz takılı olmadığı için bağlantı
// sınanmaz; sınanan, kurulumun asılı kalmadan bittiği ve sürücülerin Windows'un sürücü deposuna girdiğidir.
//
//   npx tsx scripts/kasa/windows/surucu-dene.ts        (yönetici olarak, Windows)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useKabloDir } from '../../../server/okc/token-kablo';
import { driverInstalled, installDriver, killStrayCommand, runPowershell } from '../../../server/okc/token-kablo-kurulum';

if (process.platform !== 'win32') {
  console.error('Bu deneme yalnız Windows’ta koşar');
  process.exit(2);
}

const root = process.env.SystemRoot || 'C:\\Windows';
const dir = mkdtempSync(join(tmpdir(), 'asilpos-token-'));
useKabloDir(() => dir);

const started = Date.now();
const result = await installDriver();
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`Kurulum ${seconds} sn sürdü:`, JSON.stringify(result));

const store = join(root, 'System32', 'DriverStore', 'FileRepository');
const x30tr = readdirSync(store).filter((d) => d.toLowerCase().startsWith('token_x30tr_libusbk_vid'));
const drivers = execFileSync(join(root, 'System32', 'pnputil.exe'), ['/enum-drivers'], { encoding: 'utf8' });
// Sürücü klasöründen çalışan süreç kalmadı mı (asılı kurucu dosyasını kilitler)
const stray = await runPowershell(
  `$d = '${join(dir, 'surucu')}\\'; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) }).Count`,
  60_000,
);

const checks: [string, boolean][] = [
  ['X30TR sürücüsü kuruldu (sonuç)', result.x30tr],
  ['300TR sürücüsü kuruldu (sonuç)', result.tr300],
  [`X30TR libusbK paketleri sürücü deposunda (${x30tr.length})`, x30tr.length >= 1],
  ['FTDI veri yolu sürücüsü depoda (ftdibus.inf)', /ftdibus\.inf/i.test(drivers)],
  ['FTDI seri kapı sürücüsü depoda (ftdiport.inf)', /ftdiport\.inf/i.test(drivers)],
  ['işaret dosyası iki modeli de kurulu sayıyor', driverInstalled()],
  ['geçici sürücü klasörü silindi', !existsSync(join(dir, 'surucu'))],
  [`sürücü klasöründen çalışan süreç kalmadı (${stray.out})`, stray.out.trim() === '0'],
  [`kurulum 10 dakikadan kısa sürdü (${seconds} sn)`, seconds < 600],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'TAMAM' : 'HATA '} ${label}`);
  if (!ok) failed++;
}
// Temizlik komutu boş klasörde de hatasız döner
await runPowershell(killStrayCommand(join(dir, 'surucu')), 60_000);
process.exit(failed ? 1 : 0);
