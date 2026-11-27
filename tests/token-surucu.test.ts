import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TOKEN_KABLO_DIR, useKabloDir } from '../server/okc/token-kablo';
import { deflateRawSync } from 'node:zlib';
import { driverInstalled, DRIVER_TOOL, embeddedZip, killStrayCommand, psQuote, safeJoin, slicePart, tr300Command, unzip, x30trCommand } from '../server/okc/token-kablo-kurulum';
import { interruptedRun, type SetupRun } from '../server/okc/token-kablo-servis';

/**
 * Token cihaz sürücülerinin sessiz kurulumu (server/okc/token-kablo-kurulum.ts). Token'ın "sürücü kurulum aracı" pencereli
 * bir sihirbazdır; kasa sunucusu (SYSTEM) onu çalıştırınca görünmeden asılı kalıyor, "Cihaz görünmedi; Token sürücüsü
 * kuruluyor" adımı hiç bitmiyordu. Araç artık çalıştırılmaz: içindeki iki kurucu yerinden alınır. Burada saf parçalar
 * sınanır; gerçek Windows'taki kurulum `.github/workflows/token-surucu.yml`'de koşar.
 */

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Küçük bir zip: girdiler sıkıştırmasız ya da deflate; ad UTF-8 bayrağıyla */
function makeZip(entries: { name: string; body: string | Buffer; deflate?: boolean }[]): Buffer {
  const files: Buffer[] = [];
  const dir: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const n = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.body) ? e.body : Buffer.from(e.body, 'utf8');
    const packed = e.deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    files.push(local, n, packed);
    dir.push(central, n);
    offset += 30 + n.length + packed.length;
  }
  const d = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(d.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, d, end]);
}
const tinyZip = (name: string, body: string) => makeZip([{ name, body }]);

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

describe('Arşivin açılması (PowerShell olmadan)', () => {
  it('sıkıştırılmış ve sıkıştırmasız girdiler, Türkçe ad ve alt klasör okunur; klasör girdisi atlanır', () => {
    const big = Buffer.alloc(50_000, 'a');
    const zip = makeZip([
      { name: 'TokenX Connect (Wired) Sürücü Kurulum Aracı v2.9.3.exe', body: big, deflate: true },
      { name: 'amd64/', body: '' },
      { name: 'amd64/ftdibus.sys', body: 'surucu' },
    ]);
    const files = unzip(zip);
    expect([...files.keys()]).toEqual(['TokenX Connect (Wired) Sürücü Kurulum Aracı v2.9.3.exe', 'amd64/ftdibus.sys']);
    expect(files.get('TokenX Connect (Wired) Sürücü Kurulum Aracı v2.9.3.exe')!.equals(big)).toBe(true);
    expect(files.get('amd64/ftdibus.sys')!.toString()).toBe('surucu');
  });

  it('bozuk ya da beklenenden büyük arşiv hata verir, yarım içerik dönmez', () => {
    const zip = makeZip([{ name: 'a.inf', body: Buffer.alloc(4_000, 'x'), deflate: true }]);
    expect(() => unzip(zip, 1_000)).toThrow(/boyut tutmuyor/);
    expect(() => unzip(Buffer.from('zip degil'))).toThrow(/sonu bulunamadı/);
    const broken = Buffer.from(zip);
    broken.writeUInt32LE(0, 0);
    expect(() => unzip(broken)).toThrow(/a\.inf okunamadı/);
  });

  it('arşivden gelen ad klasörün dışına çıkamaz', () => {
    expect(safeJoin('/veri/ftdi', 'amd64/ftdibus.sys')).toBe(join('/veri/ftdi', 'amd64', 'ftdibus.sys'));
    for (const bad of ['../x.inf', 'amd64/../../x.sys', 'C:\\Windows\\x.sys', '', '/']) expect(() => safeJoin('/veri/ftdi', bad)).toThrow(/beklenmeyen dosya adı/);
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

  it('300TR: çıkarılmış klasördeki veri yolu ve seri kapı sürücüsünün ikisi de kurulur', () => {
    const cmd = tr300Command('C:\\veri\\surucu\\ftdi');
    // Windows'un Expand-Archive'i Token'ın arşivinde hata veriyor: arşiv sunucuda açılır
    expect(cmd).not.toContain('Expand-Archive');
    expect(cmd).toContain("@('ftdibus.inf', 'ftdiport.inf')");
    expect(cmd).toContain("Join-Path 'C:\\veri\\surucu\\ftdi' $f");
    expect(cmd).toContain('/add-driver $inf /install');
    expect(cmd).toContain('if ($n -lt 2) { exit 20 }');
  });

  it('yoldaki kesme işareti komutu bozmaz', () => {
    expect(psQuote("C:\\Users\\O'Neil\\veri")).toBe("'C:\\Users\\O''Neil\\veri'");
    expect(tr300Command("C:\\O'Neil\\ftdi")).toContain("'C:\\O''Neil\\ftdi'");
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
