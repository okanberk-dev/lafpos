import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLOUD_KEYS, CONN_FIELDS, CONN_GROUPS } from '@shared/baglanti';
import { env } from '../env';
import { subeAnahtariGorunumu } from './kafe-anahtari';
import { MIN_SECRET_LENGTH } from './signature';
import { cloudKeys, currentSube, pullState } from './platform-anahtar';
import { envDegeri, eskiEnvAdi, posEnv, yazilacakEnvAdi, yeniEnvAdi } from '@shared/pos-env';

/**
 * Ayarlar dosyası (Windows kurulumunda veri klasöründeki ayarlar.env; klasör eski adla, shared/eski-adlar.ts): dış sistemlerin adresleri ve anahtarları
 * burada durur, veritabanında değil (veritabanı buluta yedeklenir; yedeğin şifresi de bu dosyadaki anahtardan). Yönetim
 * › Bağlantı bilgileri bu dosyaya yazar; bekçi (scripts/kasa/windows/kurulum/bekci.mjs) dosyanın değiştiğini 5 sn'de
 * görür ve sunucuyu yeni ayarlarla yeniden başlatır. Dosyanın öbür satırları ve yorumları korunur, BOM ve satır sonu
 * (CRLF) da: sahip dosyayı Not Defteri'nde açınca aynı düzeni görür.
 *
 * Yalnız Windows kurulumunda (bekçi altında) ya da ASILPOS_AYAR_DOSYASI verilince yazılır; git ile çalışan sunucuda
 * ve tarayıcı demosunda `.env` elle düzenlenir.
 */

export interface SettingsFile {
  path: string;
  /** Bekçi dosyanın değiştiğini görüp sunucuyu yeniden başlatır; değilse yeni değerler elle yeniden başlatınca geçer */
  restart: 'otomatik' | 'elle';
}

export function settingsFile(): SettingsFile | null {
  const bekci = posEnv(process.env, 'STDIN_CONTROL') === '1';
  const explicit = posEnv(process.env, 'AYAR_DOSYASI')?.trim();
  if (explicit) return { path: resolve(explicit), restart: bekci ? 'otomatik' : 'elle' };
  // Eski bekçi dosyanın yolunu söylemez: veri klasörü kurulumun klasörüdür (ASILPOS_DATA_DIR, ProgramData altındaki kurulum klasörü)
  if (bekci) return { path: resolve(env.dataDir, 'ayarlar.env'), restart: 'otomatik' };
  return null;
}

/** Dosyanın satırları → anahtarlar (bekçinin okuyucusuyla aynı kurallar: # yorum, tırnak soyulur, son yazılan geçer) */
export function readEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^\uFEFF/, '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

const HEADER = '# Yönetim › Bağlantı bilgileri';

/** Dosyanın etkin (yorum olmayan) satırlarındaki anahtarlar */
function activeKeys(lines: string[]): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    const t = line.trim();
    const eq = t.indexOf('=');
    if (!t.startsWith('#') && eq > 0) keys.add(t.slice(0, eq).trim());
  }
  return keys;
}

/**
 * Yeni adla (`ASILPOS_X`) gelen değişikliği dosyanın adına çevirir (shared/pos-env.ts `yazilacakEnvAdi`): dosyada yeni
 * ad yoksa eski adlı satır değişir ya da eski adla eklenir, yeni ad duruyorsa o (eski ad da duruyorsa ikisi);
 * kaldırmada ikisi de kalkar. Dosya yeniden adlandırılmaz: eski sürüme dönülürse eski sunucu aynı satırı okur
 */
function toFileNames(keys: Set<string>, edits: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, v] of Object.entries(edits)) {
    const eski = eskiEnvAdi(key);
    if (!eski) {
      out[key] = v;
      continue;
    }
    if (v == null) {
      out[key] = null;
      out[eski] = null;
      continue;
    }
    const target = yazilacakEnvAdi(keys, key);
    out[target] = v;
    if (target === key && keys.has(eski)) out[eski] = v;
  }
  return out;
}

/**
 * Değişiklikleri dosyanın metnine işler (saf). Değer: yeni değer; null: satır kaldırılır. Etkin satır yerinde değişir
 * (aynı anahtarın sonraki tekrarları düşer); etkin satır yoksa örnek dosyadaki yorumlu satırın (`# ANAHTAR=`, eski ya
 * da yeni adla) altına, o da yoksa dosyanın sonuna, başlık satırının altına eklenir. BOM ve satır sonu korunur. Yeni
 * adla gelen anahtar dosyada yeni ad yoksa eski adla yazılır (`toFileNames`)
 */
export function applyEnvEdits(text: string, requested: Record<string, string | null>): string {
  const bom = text.startsWith('\uFEFF');
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.length ? body.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const edits = toFileNames(activeKeys(lines), requested);
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    const eq = t.indexOf('=');
    const key = !t.startsWith('#') && eq > 0 ? t.slice(0, eq).trim() : null;
    if (key && key in edits) {
      if (done.has(key)) continue;
      done.add(key);
      const v = edits[key];
      if (v != null) out.push(`${key}=${v}`);
      continue;
    }
    out.push(line);
  }
  for (const [key, v] of Object.entries(edits)) {
    if (done.has(key) || v == null) continue;
    // Örnek dosyanın yorumlu satırı yeni adla (`# ASILPOS_X=`), kurulu kasanınki eski adla durur: ikisi de yer gösterir
    const names = [...new Set([key, eskiEnvAdi(key), yeniEnvAdi(key)])].filter((n): n is string => !!n).join('|');
    const template = out.findIndex((l) => new RegExp(`^#\\s*(${names})=`).test(l.trim()));
    if (template >= 0) {
      out.splice(template + 1, 0, `${key}=${v}`);
    } else {
      if (!out.includes(HEADER)) {
        if (out.length && out[out.length - 1]!.trim() !== '') out.push('');
        out.push(HEADER);
      }
      out.push(`${key}=${v}`);
    }
  }
  return `${bom ? '\uFEFF' : ''}${out.join(eol)}${eol}`;
}

function readFile(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * Değeri değişince eskisi `<ad>_ONCEKI` satırında tutulan kafe anahtarları (Uzaktan'ın ortak anahtarı ve şube anahtarı).
 * Kasa bulut yedeğini bu anahtarla şifreler (server/sync/yedek.ts): anahtar değişince (ladmin'in dağıtımı gün sonunda,
 * Bağlantı bilgileri, kurulum kodu) değişimden önce alınmış yedekler eski değerle şifreli kalır, geri yükleme onu da
 * dener (server/lib/kafe-anahtari.ts `yedekCozmeAnahtarlari`). Yalnız bir önceki değer tutulur
 */
export const ONCEKISI_TUTULAN = ['ASILPOS_CLOUD_SECRET', 'ASILPOS_CLOUD_SUBE_SECRET'] as const;

/**
 * Değişikliklerle birlikte yazılacak `_ONCEKI` satırları (saf): `ONCEKISI_TUTULAN`'dan biri dosyadaki dolu, en az 32
 * karakterlik değerinden başka bir değere (ya da boşa) geçiyorsa eski değer `<ad>_ONCEKI` olur. Ad yeni ya da eski önekle
 * gelebilir, dosyadaki değer de (`yazilacakEnvAdi` gibi `_ONCEKI` de dosyanın adlandırmasıyla yazılır)
 */
export function oncekiSatirlari(dosya: Readonly<Record<string, string>>, edits: Readonly<Record<string, string | null>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ad of ONCEKISI_TUTULAN) {
    const eskiAd = eskiEnvAdi(ad)!;
    if (!(ad in edits) && !(eskiAd in edits)) continue;
    const simdiki = ((dosya[ad] ?? '').trim() || (dosya[eskiAd] ?? '').trim());
    const yeni = ((ad in edits ? edits[ad] : edits[eskiAd]) ?? '').trim();
    if (simdiki.length >= MIN_SECRET_LENGTH && simdiki !== yeni) out[`${ad}_ONCEKI`] = simdiki;
  }
  return out;
}

/**
 * Dosyaya yazar: önce geçici dosya, sonra yerine (bekçi yarım dosya okumasın). Değişen kafe anahtarının eski değeri
 * `_ONCEKI` satırına (`oncekiSatirlari`)
 */
export function writeEnvEdits(file: SettingsFile, edits: Record<string, string | null>) {
  const before = readFile(file.path);
  // Yeni dosya Not Defteri'nde Türkçe karakterleri doğru göstersin (Windows): BOM ve CRLF
  const base = before || (process.platform === 'win32' ? '\uFEFF\r\n' : '');
  const next = applyEnvEdits(base, { ...oncekiSatirlari(readEnvText(before), edits), ...edits });
  writeFileSync(`${file.path}.yeni`, next, { mode: 0o600 });
  renameSync(`${file.path}.yeni`, file.path);
}

/**
 * Bağlantı bilgilerinin görünümü: düz alanların değeri, gizli alanların yalnız tanımlı olup olmadığı. `pending`: dosya
 * çalışan sunucunun ayarlarından farklı (yeniden başlama bekleniyor ya da elle başlatılmalı)
 */
export function connectionView() {
  const file = settingsFile();
  const vars = file ? readEnvText(readFile(file.path)) : {};
  // Yeni ya da eski adla (kurulu kasanın dosyası eski adla durur)
  const running = (key: string) => (envDegeri(process.env, key) ?? '').trim();
  const pendingKeys = file ? CONN_FIELDS.filter((f) => (envDegeri(vars, f.key) ?? '').trim() !== running(f.key)).map((f) => f.key) : [];
  // Buluttan gelen platform anahtarları (#75 İş 2): bulutta dolu olan yereli ezer; değeri hiç dönmez, yalnız kaynak.
  // Yalnız bu şube için çekilmiş olanlar sayılır (şube değişince eskisininkiler kullanılmaz)
  const cloud = cloudKeys();
  const pull = pullState();
  const sube = currentSube();
  const forThis = !!sube && cloud.sube === sube;
  const cloudValues = forThis ? cloud.values : {};
  return {
    available: !!file,
    restart: file?.restart ?? null,
    pending: pendingKeys.length > 0,
    groups: CONN_GROUPS.map((g) => ({
      id: g.id,
      fields: g.fields.map((f) => {
        if (cloudValues[f.key]) return { key: f.key, set: true, value: null, source: 'bulut' as const };
        const v = envDegeri(file ? vars : process.env, f.key)?.trim() ?? '';
        return { key: f.key, set: v !== '', value: f.kind === 'secret' || !v ? null : v, ...(CLOUD_KEYS.includes(f.key) && v ? { source: 'yerel' as const } : {}) };
      }),
    })),
    /**
     * Son çekim: bu şube için son başarılı çekimin anı (yerel kopyadan; başka şube için çekildiyse null), son denemenin
     * sonucu. `sube`: kasanın şube etiketi, Vercel adındaki ŞUBE (yalnız ad, değer değil; geçersizse null). `uzaktan`:
     * AsilPOS Uzaktan kurulu mu (değilse buluttan hiçbir şey gelmez). `subeAnahtari`: şube anahtarının durumu ve
     * Vercel'deki adı (değer değil; server/lib/kafe-anahtari.ts)
     */
    bulut: { at: forThis ? cloud.at : null, ok: pull.ok, error: pull.error, sube, uzaktan: !!env.cloudUrl && env.cloudSecret.length >= 32, subeAnahtari: subeAnahtariGorunumu() },
  };
}
