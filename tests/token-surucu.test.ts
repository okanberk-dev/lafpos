import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TOKEN_KABLO_DIR, useKabloDir } from '../server/okc/token-kablo';
import { driverInstalled, DRIVER_TOOL, embeddedZip, killStrayCommand, psQuote, slicePart, tr300Command, x30trCommand } from '../server/okc/token-kablo-kurulum';
import { interruptedRun, type SetupRun } from '../server/okc/token-kablo-servis';

/**
 * Token cihaz sürücülerinin sessiz kurulumu (server/okc/token-kablo-kurulum.ts). Token'ın "sürücü kurulum aracı" pencereli
 * bir sihirbazdır; kasa sunucusu (SYSTEM) onu çalıştırınca görünmeden asılı kalıyor, "Cihaz görünmedi; Token sürücüsü
 * kuruluyor" adımı hiç bitmiyordu. Araç artık çalıştırılmaz: içindeki iki kurucu yerinden alınır. Burada saf parçalar
 * sınanır; gerçek Windows'taki kurulum `.github/workflows/token-surucu.yml`'de koşar.
 */

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Tek dosyalı, sıkıştırmasız en küçük zip */
function tinyZip(name: string, body: string): Buffer {
  const n = Buffer.from(name, 'utf8');
  const data = Buffer.from(body, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const dir = Buffer.concat([central, n]);
  const files = Buffer.concat([local, n, data]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(files.length, 16);
  return Buffer.concat([files, dir, end]);
}

describe('Token sürücü aracının içindeki kurucular', () => {
  it('parça yerinden alınır; dosya kısaysa ya da özet tutmuyorsa hiçbir şey dönmez', () => {
    const inner = Buffer.from('gomulu kurucu');
    const tool = Buffer.concat([Buffer.alloc(100, 1), inner, Buffer.alloc(50, 2)]);
    const part = { offset: 100, size: inner.length, sha256: sha(inner) };
    expect(slicePart(tool, part, 'kurucu').equals(inner)).toBe(true);
    // Başka bir tamponun dilimi olarak gelen dosyada da konum dosyanın başından sayılır
    const shifted = Buffer.concat([Buffer.alloc(7, 9), tool]).subarray(7);
    expect(slicePart(shifted, part, 'kurucu').equals(inner)).toBe(true);
    expect(() => slicePart(tool.subarray(0, 105), part, 'kurucu')).toThrow(/beklenenden kısa/);
    expect(() => slicePart(tool, { ...part, offset: 101 }, 'kurucu')).toThrow(/özeti tutmuyor/);
  });

  it('sabit parçalar aracın içinde, üst üste binmeden durur', () => {
    const { x30tr, tr300 } = DRIVER_TOOL.parts;
    for (const p of [x30tr, tr300]) {
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.offset).toBeGreaterThan(0);
      expect(p.size).toBeGreaterThan(1_000_000);
    }
    expect(tr300.offset + tr300.size).toBeLessThanOrEqual(x30tr.offset);
  });

  it('kendi kendini açan paketten temiz zip çıkar: öndeki program ve sondaki imza artığı atılır', () => {
    const zip = tinyZip('ftdibus.inf', '[Version]');
    const exe = Buffer.concat([Buffer.from('MZ program govdesi '.repeat(40)), zip, Buffer.alloc(300, 7)]);
    expect(embeddedZip(exe).equals(zip)).toBe(true);
    // Artığın içinde zip sonu imzasına benzeyen baytlar aldatmaz
    const noisy = Buffer.concat([exe, Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(40, 0xff)]);
    expect(embeddedZip(noisy).equals(zip)).toBe(true);
    expect(() => embeddedZip(Buffer.from('arsiv yok'))).toThrow(/arşiv bulunamadı/);
  });
});

describe('Token sürücü kurulum komutları', () => {
  it('X30TR: kurucu pencere açmadan çalışır, depodaki .inf pnputil ile kurulur; sürücü yoksa hata kodu', () => {
    const cmd = x30trCommand("C:\\ProgramData\\AsilPOS\\token-kablo\\surucu\\wdi-simple.exe", 'C:\\ProgramData\\AsilPOS\\token-kablo\\surucu');
    expect(cmd).toContain("Start-Process -FilePath 'C:\\ProgramData\\AsilPOS\\token-kablo\\surucu\\wdi-simple.exe'");
    expect(cmd).toContain('-WindowStyle Hidden -Wait -PassThru');
    // Token'ın aracının kullandığı /quiet gibi bir argüman gitmez: kurucu argümansız çalışır
    expect(cmd).not.toContain('-ArgumentList');
    expect(cmd).toContain("token_x30tr_libusbk_vid*");
    expect(cmd).toContain('/add-driver $i.FullName /install');
    expect(cmd).toContain('if ($infs.Count -eq 0) { exit 20 }');
    expect(cmd).toContain('@(0, 259, 3010) -notcontains $LASTEXITCODE');
  });

  it('300TR: zip açılır, veri yolu ve seri kapı sürücüsünün ikisi de kurulur', () => {
    const cmd = tr300Command('C:\\veri\\surucu\\ftdi.zip', 'C:\\veri\\surucu\\ftdi');
    expect(cmd).toContain("Expand-Archive -LiteralPath 'C:\\veri\\surucu\\ftdi.zip' -DestinationPath 'C:\\veri\\surucu\\ftdi' -Force");
    expect(cmd).toContain("@('ftdibus.inf', 'ftdiport.inf')");
    expect(cmd).toContain('/add-driver $inf /install');
    expect(cmd).toContain('if ($n -lt 2) { exit 20 }');
  });

  it('yoldaki kesme işareti komutu bozmaz', () => {
    expect(psQuote("C:\\Users\\O'Neil\\veri")).toBe("'C:\\Users\\O''Neil\\veri'");
    expect(tr300Command("C:\\O'Neil\\ftdi.zip", "C:\\O'Neil\\ftdi")).toContain("'C:\\O''Neil\\ftdi.zip'");
  });

  it('asılı kalan süreçler yalnız sürücü klasöründen çalışanlardır', () => {
    const cmd = killStrayCommand('C:\\ProgramData\\AsilPOS\\token-kablo\\surucu\\');
    expect(cmd).toContain("$d = 'C:\\ProgramData\\AsilPOS\\token-kablo\\surucu\\'");
    expect(cmd).toContain('$_.ExecutablePath.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase)');
    expect(cmd.endsWith('exit 0')).toBe(true);
  });
});

describe('Token sürücü işareti', () => {
  const before = TOKEN_KABLO_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'asilpos-token-'));
  const original = before();
  useKabloDir(() => dir);
  afterAll(() => {
    useKabloDir(() => original);
    rmSync(dir, { recursive: true, force: true });
  });
  const mark = (m: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'surucu.json'), JSON.stringify(m));
  };

  it('işaret yoksa, sürüm eskiyse ya da model ayrımı taşımıyorsa sürücü kurulu sayılmaz', () => {
    expect(driverInstalled()).toBe(false);
    // Sihirbazı çalıştıran eski sürümün yazdığı biçim: sürücü aslında hiç kurulmamıştı
    mark({ version: DRIVER_TOOL.version, at: 1, reboot: false });
    expect(driverInstalled()).toBe(false);
    mark({ version: '2.0.0', x30tr: true, tr300: true });
    expect(driverInstalled()).toBe(false);
  });

  it('iki modelin sürücüsü de kurulduysa kurulu sayılır; biri eksikse sonraki kurulumda yeniden denenir', () => {
    mark({ version: DRIVER_TOOL.version, x30tr: true, tr300: false });
    expect(driverInstalled()).toBe(false);
    mark({ version: DRIVER_TOOL.version, x30tr: true, tr300: true });
    expect(driverInstalled()).toBe(true);
  });
});

describe('Yarım kalan kurulum kaydı', () => {
  it('kasa yeniden başlayınca süren adım hata olur, bekleyenler atlanır ve düğme yeniden basılabilir', () => {
    const run: SetupRun = {
      device: 'tokenkablo',
      running: true,
      ok: null,
      startedAt: 1_000,
      finishedAt: null,
      steps: [
        { key: 'vc', label: 'Visual C++ çalışma kitaplığı', status: 'atlandi', detail: null },
        { key: 'kopru', label: 'Token köprüsü', status: 'tamam', detail: 'Çalışıyor' },
        { key: 'cihaz', label: 'Cihaz kabloyla bağlı', status: 'suruyor', detail: 'Cihaz görünmedi; Token sürücüsü kuruluyor (birkaç dakika sürebilir)' },
        { key: 'ayar', label: 'Kısımlar, yemek kartları ve bağlantı', status: 'bekliyor', detail: null },
      ],
    };
    const out = interruptedRun(run, 5_000);
    expect(out).toMatchObject({ running: false, ok: false, finishedAt: 5_000 });
    expect(out.steps.map((s) => s.status)).toEqual(['atlandi', 'tamam', 'hata', 'atlandi']);
    expect(out.steps[2]!.detail).toContain('yeniden “Kurulumu yap”a basın');
    // Biten adımın ayrıntısı korunur
    expect(out.steps[1]!.detail).toBe('Çalışıyor');
  });
});
