/**
 * Yönetim › Bağlantı bilgileri: kasa bilgisayarının ayarlar dosyasındaki (Windows kurulumunda
 * C:\ProgramData\LafPOS\ayarlar.env) dış sistem adresleri ve anahtarları, panelden girilir. Sunucu yalnız bu listedeki
 * anahtarları yazar (server/lib/ayar-dosyasi.ts); gizli değerler arayüze hiç dönmez, yalnız "tanımlı" bilgisi.
 * Kaydedince bekçi dosyanın değiştiğini görüp sunucuyu yeni ayarlarla yeniden başlatır (birkaç saniye).
 * Pavo'nun adresi ve seri no'su burada değil: Yönetim › Yazarkasa POS'tan girilir, yeniden başlatma gerekmez.
 */

export type ConnFieldKind = 'url' | 'text' | 'secret';

export interface ConnField {
  key: string;
  label: string;
  kind: ConnFieldKind;
  placeholder?: string;
  hint?: string;
  /** Gizli anahtarın en kısa boyu (karşı sistem bundan kısasını reddeder) */
  minLength?: number;
  /** Boş kalabilir: bağlantı onsuz da çalışır (kartın "Tanımlı" rozeti onu beklemez) */
  optional?: boolean;
}

export interface ConnGroup {
  id: string;
  title: string;
  desc: string;
  fields: ConnField[];
}

export const CONN_GROUPS: ConnGroup[] = [
  {
    id: 'lafmaliyet',
    title: 'lafmaliyet',
    desc: 'Gün sonu, ürün satış listesi ve maliyetler maliyet paneline gider',
    fields: [
      { key: 'LAFMALIYET_URL', label: 'Adres', kind: 'url', placeholder: 'https://ladmin.laffogato.net' },
      { key: 'LAFMALIYET_SYNC_SECRET', label: 'Anahtar', kind: 'secret', hint: 'Paneldeki LAFPOS_SYNC_SECRET ile aynı' },
    ],
  },
  {
    id: 'uzaktan',
    title: 'LafPOS Uzaktan',
    desc: 'Uzaktan raporlar, bulut yedeği, lisans, güncelleme seçimi ve telefon bildirimleri',
    fields: [
      { key: 'LAFPOS_CLOUD_URL', label: 'Adres', kind: 'url', placeholder: 'https://lafpos.laffogato.net' },
      { key: 'LAFPOS_CLOUD_SECRET', label: 'Anahtar', kind: 'secret', minLength: 32, hint: 'Vercel’deki LAFPOS_CLOUD_SECRET ile aynı, en az 32 karakter' },
    ],
  },
  {
    id: 'site',
    title: 'Site (laffogato)',
    desc: 'Menü ve fiyatlar, online siparişler, Tükendi, karaoke rezervasyonları. Deneme bittikten sonra açın; adres boşken siteye hiç bağlanılmaz',
    fields: [
      { key: 'LAFFOGATO_URL', label: 'Adres', kind: 'url', placeholder: 'https://laffogato.net' },
      { key: 'LAFFOGATO_SYNC_SECRET', label: 'Anahtar', kind: 'secret', minLength: 32, hint: 'Sitedeki LAFPOS_SYNC_SECRET ile aynı, en az 32 karakter' },
    ],
  },
  {
    id: 'tokenx',
    title: 'Token yazarkasa (TokenX Connect)',
    desc: 'Token · Beko cihazı bulut üzerinden; değerleri Token verir',
    fields: [
      { key: 'TOKENX_AUTH_URL', label: 'Kimlik adresi', kind: 'url' },
      { key: 'TOKENX_BASKET_URL', label: 'Sepet adresi', kind: 'url' },
      { key: 'TOKENX_SETTINGS_URL', label: 'Ayar adresi', kind: 'url', hint: 'Boşsa sepet adresi kullanılır', optional: true },
      { key: 'TOKENX_CLIENT_ID', label: 'Uygulama kimliği', kind: 'text' },
      { key: 'TOKENX_CLIENT_SECRET', label: 'Uygulama anahtarı', kind: 'secret' },
      { key: 'TOKENX_TERMINAL_ID', label: 'Terminal', kind: 'text', hint: 'Cihazdaki karekodda, AV ya da AT ile başlar' },
      { key: 'TOKENX_BRANCH_ID', label: 'Şube', kind: 'text', hint: 'Masada ödeme için', optional: true },
      { key: 'TOKENX_APP_RESOURCE', label: 'Uygulama kaynağı', kind: 'text', hint: 'Token isterse', optional: true },
      { key: 'LAFPOS_PUBLIC_URL', label: 'LafPOS’un internet adresi', kind: 'url', hint: 'Webhook için; boşsa durum sorulur', optional: true },
      { key: 'TOKENX_WEBHOOK_SECRET', label: 'Webhook anahtarı', kind: 'secret', minLength: 16, optional: true },
    ],
  },
  {
    id: 'yemeksepeti',
    title: 'Yemeksepeti',
    desc: 'Delivery Hero’nun verdiği bilgiler; LafPOS Uzaktan da tanımlı olmalı',
    fields: [
      { key: 'YEMEKSEPETI_MW_URL', label: 'Middleware adresi', kind: 'url' },
      { key: 'YEMEKSEPETI_USERNAME', label: 'Kullanıcı adı', kind: 'text' },
      { key: 'YEMEKSEPETI_PASSWORD', label: 'Parola', kind: 'secret' },
      { key: 'YEMEKSEPETI_REMOTE_ID', label: 'Restoranın POS kimliği', kind: 'text' },
    ],
  },
  {
    id: 'getir',
    title: 'Getir Yemek',
    desc: 'Getir’in verdiği anahtarlar; LafPOS Uzaktan da tanımlı olmalı',
    fields: [
      { key: 'GETIR_APP_SECRET_KEY', label: 'Uygulama anahtarı', kind: 'secret' },
      { key: 'GETIR_RESTAURANT_SECRET_KEY', label: 'Restoran anahtarı', kind: 'secret' },
      { key: 'GETIR_API_URL', label: 'API adresi', kind: 'url', hint: 'Boşsa canlı; test için Getir’in verdiği adres', optional: true },
    ],
  },
  {
    id: 'trendyol',
    title: 'Trendyol Go',
    desc: 'Satıcı panelinden; Uber Eats Türkiye siparişleri de buradan',
    fields: [
      { key: 'TRENDYOL_SUPPLIER_ID', label: 'Satıcı no', kind: 'text' },
      { key: 'TRENDYOL_API_KEY', label: 'API anahtarı', kind: 'secret' },
      { key: 'TRENDYOL_API_SECRET', label: 'Gizli anahtar', kind: 'secret' },
      { key: 'TRENDYOL_EXECUTOR_EMAIL', label: 'İşlemi yapan e-posta', kind: 'text', hint: 'Satıcı panelindeki kullanıcı', optional: true },
      { key: 'TRENDYOL_API_URL', label: 'API adresi', kind: 'url', hint: 'Boşsa canlı', optional: true },
    ],
  },
];

export const CONN_FIELDS: ConnField[] = CONN_GROUPS.flatMap((g) => g.fields);
const BY_KEY = new Map(CONN_FIELDS.map((f) => [f.key, f]));
export const connField = (key: string): ConnField | undefined => BY_KEY.get(key);

/**
 * Buluttan gelen platform anahtarları (#75 İş 2): sahip bunları bir kez Vercel'deki LafPOS Uzaktan projesine girer, kasa
 * imzalı uçtan (`GET /api/uzaktan/anahtarlar`) açılışta ve 10 dakikada bir çeker (server/sync/platform-anahtar.ts).
 * Bulutta dolu olan yerel değeri ezer, bulutta boşsa yerel kalır. Ad listesi sabit: uç yalnız bunları verir
 */
export const CLOUD_KEY_GROUPS = [
  { id: 'trendyol', label: 'Trendyol', keys: ['TRENDYOL_SUPPLIER_ID', 'TRENDYOL_API_KEY', 'TRENDYOL_API_SECRET', 'TRENDYOL_EXECUTOR_EMAIL'] },
  { id: 'yemeksepeti', label: 'Yemeksepeti', keys: ['YEMEKSEPETI_MW_URL', 'YEMEKSEPETI_USERNAME', 'YEMEKSEPETI_PASSWORD', 'YEMEKSEPETI_REMOTE_ID'] },
] as const;
export const CLOUD_KEYS: readonly string[] = CLOUD_KEY_GROUPS.flatMap((g) => g.keys);

const TR_ASCII: Record<string, string> = { ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U' };

/**
 * Şubenin Vercel ortamındaki adı: büyük harf, Türkçe karaktersiz, yalnız harf ve rakam ('marina' → 'MARINA',
 * 'tuzla-2' → 'TUZLA2', 'Kadıköy' → 'KADIKOY'). Boş ya da geçersizse null: şubesi bilinmeyen kasa hiçbir platform
 * anahtarı almaz
 */
export function subeEtiketi(branchId: unknown): string | null {
  if (typeof branchId !== 'string') return null;
  const s = branchId
    .trim()
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TR_ASCII[c] ?? c)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{1,32}$/.test(s) ? s : null;
}

/**
 * Platform anahtarları şubeye göre (#75): bulutta her değer `<PLATFORM>_<ŞUBE>_<ALAN>` adıyla durur
 * (TRENDYOL_API_KEY + TUZLA → TRENDYOL_TUZLA_API_KEY, YEMEKSEPETI_REMOTE_ID + MARINA → YEMEKSEPETI_MARINA_REMOTE_ID).
 * Öneksiz eski adlar hiçbir kasaya verilmez: bir şubenin anahtarı yanlışlıkla öbürüne gitmesin
 */
export function subeKeyName(key: string, sube: string): string {
  const group = CLOUD_KEY_GROUPS.find((g) => (g.keys as readonly string[]).includes(key));
  if (!group) throw new Error(`Bulut anahtarı değil: ${key}`);
  const prefix = `${group.id.toUpperCase()}_`;
  return `${prefix}${sube}_${key.slice(prefix.length)}`;
}

/** Buluttan gelen değerlerin süzgeci: yalnız listedeki anahtarlar, dolu ve alanın kuralına uyanlar */
export function cleanCloudKeys(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of CLOUD_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    const field = connField(key);
    if (typeof v !== 'string' || !field) continue;
    const r = checkConnValue(field, v);
    if ('value' in r && r.value) out[key] = r.value;
  }
  return out;
}

/**
 * Yazılacak değerin denetimi: boş değer "kaldır" demektir (null). Satır sonu, boşluk ve tırnak kabul edilmez (dosyada tek
 * satır kalmalı, sunucunun okuyucusu tırnağı soyar). Adres http(s) olmalı. Hata Türkçe mesaj, yoksa temiz değer
 */
export function checkConnValue(field: ConnField, raw: string): { value: string | null } | { error: string } {
  const value = raw.trim();
  if (!value) return { value: null };
  if (/[\r\n]/.test(value) || value.length > 500) return { error: `${field.label}: tek satır, en çok 500 karakter` };
  if (/\s/.test(value) || /^["']|["']$/.test(value)) return { error: `${field.label}: boşluk ve tırnak olmadan yazın` };
  if (field.kind === 'url') {
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      return { error: `${field.label}: adres https:// ile başlamalı` };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: `${field.label}: adres https:// ile başlamalı` };
    return { value: value.replace(/\/+$/, '') };
  }
  if (field.minLength && value.length < field.minLength) return { error: `${field.label}: en az ${field.minLength} karakter` };
  return { value };
}

/**
 * Yapıştırılan ayar satırları (ANAHTAR=değer; # yorum) → anahtarlar. Sahibe verilen kurulum dosyası
 * (lafpos-kasa-ayarlari.env) olduğu gibi yapıştırılabilir; bilinmeyen anahtarlar ayrı listelenir. Satır sonundaki not
 * değer değildir; notu "(deneme bittikten sonra)" olan satır şimdi yazılmaz (`later`: site bağlantısı deneme bitince
 * açılır, docs/03-ENTEGRASYON.md §8)
 */
export function parseEnvLines(text: string): { values: Record<string, string>; unknown: string[]; later: string[] } {
  const values: Record<string, string> = {};
  const unknown: string[] = [];
  const later: string[] = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const note = /\s+\(([^()]*)\)$/.exec(value);
    if (note) value = value.slice(0, note.index).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (!key.startsWith('PAVO_') && !BY_KEY.has(key)) unknown.push(key);
    else if (note && /deneme/i.test(note[1]!)) later.push(key);
    else values[key] = value;
  }
  return { values, unknown, later };
}
