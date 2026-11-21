// Windows kurulumunun ayar kuralları: bekçinin sunucuya verdiği bellek sınırı ve .env.example'dan üretilen
// ayarlar.env.ornek. Bağımlılıksız; bekci.mjs ile pakete girer (derle.mjs), testi tests/kurulum-ayarlar.test.ts.

/** LAFPOS_MAX_HEAP_MB'nin kabul edilen aralığı (MB) */
export const HEAP_MIN_MB = 256;
export const HEAP_MAX_MB = 4096;
/** Ayarsız varsayılanın tabanı (MB): uzun dönem raporu (MAX_RANGE_DAYS, 400 gün) iki dönemi birden bellekte tutar */
export const HEAP_DEFAULT_MIN_MB = 1024;

/** ayarlar.env'deki değer geçerli mi (256-4096 arası tam sayı) */
export const validHeapSetting = (setting) => {
  const n = Number(setting);
  return setting != null && String(setting).trim() !== '' && Number.isInteger(n) && n >= HEAP_MIN_MB && n <= HEAP_MAX_MB;
};

/**
 * Sunucunun V8 yığın sınırı (--max-old-space-size, MB). ayarlar.env'de LAFPOS_MAX_HEAP_MB geçerliyse o; yoksa
 * bilgisayarın belleğinin dörtte biri, en az 1024, en çok 4096 MB. Sınır bir sızıntının kasa bilgisayarını
 * kilitlemesini önler (sınıra varan sunucu düşer, bekçi yeniden açar); taban, yıllık raporun sığmasını sağlar
 * (sipariş başına yaklaşık 7,5 KB yığın, rapor iki dönemi birden yükler)
 * @param {unknown} setting LAFPOS_MAX_HEAP_MB'nin ham değeri
 * @param {number} totalBytes bilgisayarın belleği (os.totalmem())
 */
export function heapLimitMb(setting, totalBytes) {
  if (validHeapSetting(setting)) return Number(setting);
  return Math.min(HEAP_MAX_MB, Math.max(HEAP_DEFAULT_MIN_MB, Math.floor(totalBytes / 4 / 2 ** 20)));
}

/** ayarlar.env.ornek'te sunucu satırlarının ardına giren, yorumlu bellek ayarı */
const HEAP_SAMPLE = [
  `# Sunucunun JavaScript bellek sınırı (MB, ${HEAP_MIN_MB}-${HEAP_MAX_MB}). Boşsa bilgisayarın belleğinin dörtte biri, en az`,
  `# ${HEAP_DEFAULT_MIN_MB}, en çok ${HEAP_MAX_MB}. Uzun dönem raporunda (ör. bir yıl) sunucu düşüyor ve logs\\sunucu.log'da`,
  '# "heap out of memory" yazıyorsa artırın; sınır, bir sızıntının bilgisayarın belleğini bitirmesini önler.',
  '# LAFPOS_MAX_HEAP_MB=2048',
];

/**
 * .env.example'dan Windows ayar dosyası: sunucu adresi ve veri yolu satırları kurulumun işi, çıkar; bekçinin bellek
 * ayarı eklenir (yalnız kurulumda var, git ile çalışan sunucuda bekçi yok)
 * @param {string} example .env.example'ın metni
 */
export function envSample(example) {
  const lines = example.split('\n');
  lines[0] = "# LafPOS ayarları (Windows kurulumu). Kaydedip Not Defteri'ni kapatınca sunucu yeniden başlar.";
  const out = lines.filter((l) => !/^#?\s*LAFPOS_(PORT|HOST|DATA_DIR)=/.test(l));
  const at = out.findIndex((l) => /^#?\s*LAFPOS_SECRET=/.test(l));
  if (at < 0) throw new Error('.env.example: LAFPOS_SECRET satırı yok (bellek ayarı onun ardına girer)');
  out.splice(at + 1, 0, ...HEAP_SAMPLE);
  return out
    .join('\n')
    .replace('data/secret.key', 'C:\\ProgramData\\LafPOS\\secret.key')
    .replace("yalnız kasa bilgisayarındaki .env'de durur", 'yalnız bu dosyada durur');
}
