import * as nodeCrypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as zlib from 'node:zlib';
import { db, tx } from '../db/client';
import { env } from '../env';
import { Effects } from '../lib/effects';
import { getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { cloudEnabled } from './cloud';
import { remoteShop } from './merkez';

/**
 * Otomatik bulut yedeği (docs/05-KASA-BILGISAYARI.md §6 "Bulut yedeği"): günlük veritabanı yedeği kasada sıkıştırılıp
 * şifrelenir (AES-256-GCM; anahtar LAFPOS_CLOUD_SECRET'ten türetilir, buluta hiç gitmez) ve LafPOS Uzaktan'ın verdiği
 * kısa süreli imzalı adrese yüklenir (Vercel Blob, özel depo; api/_yedek.ts). Blob anahtarı yalnız buluttadır.
 *
 * Geri yükleme (Yönetim › Ayarlar ve yedek › Bulut yedeği): seçilen yedek indirilir, şifresi çözülür, SQLite olduğu
 * doğrulanır ve veri klasöründe `geri-yukle/hazir.db` olarak bekler. Sunucu kapanır; bekçi (Windows kurulumu) yeniden
 * açmadan önce mevcut veritabanının kopyasını alır ve hazır yedeği yerine koyar (scripts/kasa/windows/kurulum/geri-yukle.mjs).
 * Kurulum yeni bilgisayardaysa ayarlar.env'e aynı LAFPOS_CLOUD_URL ve LAFPOS_CLOUD_SECRET yazılınca eski yedekler
 * görünür (dükkân kimliği yedeklerin klasörüdür; listede kurulumun eski kimliği de seçilebilir).
 */
/** Dosyanın imzası; yükleme anında kurulur (tarayıcı demosunda Buffer yok, modül yine yüklenir) */
const magic = () => Buffer.from('LPY1');
const STATE = 'yedek.bulut';

export interface CloudBackupState {
  lastAt: number | null;
  lastName: string | null;
  lastSize: number | null;
  lastError: string | null;
  /** Son başarılı yüklemenin iş günü: günde bir yüklenir */
  lastDay: string | null;
}

export const cloudBackupState = (): CloudBackupState => ({ lastAt: null, lastName: null, lastSize: null, lastError: null, lastDay: null, ...(getSyncState<Partial<CloudBackupState>>(STATE) ?? {}) });
const saveState = (patch: Partial<CloudBackupState>) => setSyncState(STATE, { ...cloudBackupState(), ...patch });

const keyFor = (secret: string, salt: Buffer) => Buffer.from(nodeCrypto.hkdfSync('sha256', secret, salt, 'lafpos-yedek-v1', 32));

/** Veritabanını sıkıştırıp şifreler: LPY1 | tuz (16) | iv (12) | etiket (16) | şifreli gzip */
export function sealBackup(db: Buffer, secret: string): Buffer {
  const salt = nodeCrypto.randomBytes(16);
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', keyFor(secret, salt), iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(db, { level: 6 })), cipher.final()]);
  return Buffer.concat([magic(), salt, iv, cipher.getAuthTag(), body]);
}

/**
 * sealBackup'ın eşzamansız sıkıştıranı (yükleme): yüz MB'lık veritabanının gzip'i olay döngüsünü saniyelerce kilitlemez,
 * servis sırasında tabletlerin istekleri beklemez (denetim bulgu 26). Şifreleme aynı
 */
export async function sealBackupAsync(db: Buffer, secret: string): Promise<Buffer> {
  const gz = await new Promise<Buffer>((ok, fail) => zlib.gzip(db, { level: 6 }, (err, out) => (err ? fail(err) : ok(Buffer.from(out)))));
  const salt = nodeCrypto.randomBytes(16);
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', keyFor(secret, salt), iv);
  const body = Buffer.concat([cipher.update(gz), cipher.final()]);
  return Buffer.concat([magic(), salt, iv, cipher.getAuthTag(), body]);
}

/** Şifreyi çözer ve SQLite olduğunu doğrular; anahtar yanlışsa ya da dosya bozuksa Türkçe hata */
export function openBackup(buf: Buffer, secret: string): Buffer {
  if (buf.length < 48 || !buf.subarray(0, 4).equals(magic())) throw new Error('Yedek dosyası tanınmadı');
  const salt = buf.subarray(4, 20);
  const iv = buf.subarray(20, 32);
  const tag = buf.subarray(32, 48);
  let db: Buffer;
  try {
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', keyFor(secret, salt), iv);
    decipher.setAuthTag(tag);
    db = zlib.gunzipSync(Buffer.concat([decipher.update(buf.subarray(48)), decipher.final()]));
  } catch {
    throw new Error('Yedeğin şifresi çözülemedi: bu yedek başka bir anahtarla alınmış (LAFPOS_CLOUD_SECRET) ya da bozuk');
  }
  if (!db.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new Error('Yedeğin içinden veritabanı çıkmadı');
  return db;
}

async function cloud<T>(path: string, body: unknown): Promise<T> {
  const res = await signedFetch(env.cloudSecret, 'POST', new URL(`/api/uzaktan/yedek/${path}`, env.cloudUrl), body, 20_000, { 'x-laf-dukkan': remoteShop() });
  const json = (res.json ?? {}) as T & { error?: string };
  if (res.status !== 200) throw new Error(json.error ?? `Bulut yanıt vermedi (${res.status})`);
  return json;
}

/** Yerel yedek dosyasını şifreleyip buluta yükler */
export async function uploadBackup(file: string, day: string | null = null): Promise<{ name: string; size: number }> {
  if (!cloudEnabled()) throw new Error('LafPOS Uzaktan kurulu değil');
  try {
    const sealed = await sealBackupAsync(readFileSync(file), env.cloudSecret);
    const { url, pathname } = await cloud<{ url: string; pathname: string }>('yukle', { boyut: sealed.length });
    const res = await fetch(url, { method: 'PUT', body: new Uint8Array(sealed), headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`Yedek yüklenemedi (${res.status})`);
    saveState({ lastAt: Date.now(), lastName: pathname, lastSize: sealed.length, lastError: null, ...(day ? { lastDay: day } : {}) });
    return { name: pathname, size: sealed.length };
  } catch (e) {
    saveState({ lastError: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

let lastTryAt = 0;
let busy = false;

/** Günlük yedekten sonra: bugün yüklenmediyse yükler; gidemezse yarım saatte bir yeniden dener */
export function afterDailyBackup(file: string, day: string, now = Date.now()) {
  if (!cloudEnabled() || busy || cloudBackupState().lastDay === day || now - lastTryAt < 30 * 60_000) return;
  lastTryAt = now;
  busy = true;
  void uploadBackup(file, day)
    .catch((e) => console.warn('[bulut yedeği]', e instanceof Error ? e.message : e))
    .finally(() => (busy = false));
}

export interface CloudBackup {
  pathname: string;
  size: number;
  at: number;
}

export const listCloudBackups = (dukkan?: string) => cloud<{ shop: string; dukkanlar: string[]; yedekler: CloudBackup[] }>('liste', dukkan ? { dukkan } : {});

/** Kurulum Windows bekçisiyle mi çalışıyor (geri yükleme ancak onunla: veritabanı sunucu dururken değişir) */
export const underBekci = () => process.env.LAFPOS_STDIN_CONTROL === '1';

/**
 * Seçilen yedeği indirir, çözer, doğrular ve `geri-yukle/hazir.db` olarak bırakır; sunucu kapanınca bekçi yerine koyar
 */
export async function stageRestore(pathname: string, byUserId: string, byName = ''): Promise<void> {
  const { url } = await cloud<{ url: string }>('indir', { pathname });
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`Yedek indirilemedi (${res.status})`);
  const db = openBackup(Buffer.from(await res.arrayBuffer()), env.cloudSecret);
  const dir = resolve(env.dataDir, 'geri-yukle');
  mkdirSync(dir, { recursive: true });
  // Önce istek (kim, adıyla: eski yedekte kullanıcı olmayabilir), sonra hazır yedek: yeniden adlandırma onay anıdır.
  // Bekçi yalnız taze istekle yerine koyar (geri-yukle.mjs); yarıda kalırsa hiçbir dosya bırakılmaz
  try {
    writeFileSync(resolve(dir, 'istek.json'), JSON.stringify({ pathname, by: byUserId, byName, at: Date.now() }));
    writeFileSync(resolve(dir, 'hazir.db.part'), db);
    renameSync(resolve(dir, 'hazir.db.part'), resolve(dir, 'hazir.db'));
  } catch (e) {
    for (const f of ['hazir.db', 'hazir.db.part', 'istek.json']) rmSync(resolve(dir, f), { force: true });
    throw e;
  }
}

interface RestoreResult {
  at: number;
  copy?: string;
  hata?: string;
  pathname?: string | null;
  by?: string | null;
  byName?: string | null;
  requestedAt?: number | null;
  done?: boolean;
}

/**
 * Açılışta (göçlerden sonra): bekçinin geri yükleme sonucu (geri-yukle/son.json) denetim kaydına bir kez yazılır. Rota
 * isteği o anki veritabanına yazar, ama o veritabanı yerine konan yedekle değişir: iz yeni veritabanında da kalsın
 * (kural 4). Bekçinin uygulamadığı hazır yedek (bekçisiz açılış, iptal) silinir: günler sonra yerine konamaz
 */
export function recordRestoreResult(): void {
  const dir = resolve(env.dataDir, 'geri-yukle');
  const file = resolve(dir, 'son.json');
  const ready = resolve(dir, 'hazir.db');
  const fx = new Effects();
  if (existsSync(ready)) {
    let req: { pathname?: string; by?: string; byName?: string } = {};
    try {
      req = JSON.parse(readFileSync(resolve(dir, 'istek.json'), 'utf8')) as typeof req;
    } catch {
      req = {};
    }
    for (const f of ['hazir.db', 'istek.json']) rmSync(resolve(dir, f), { force: true });
    fx.audit(db, { userId: req.by ?? null, action: 'yedek', severity: 'uyari', message: `Buluttan geri yükleme yapılmadı: hazır yedek sunucu açılırken yerine konmamıştı, silindi${req.pathname ? ` (${req.pathname})` : ''}` });
    fx.flush();
  }
  if (!existsSync(file)) return;
  let r: RestoreResult;
  try {
    r = JSON.parse(readFileSync(file, 'utf8')) as RestoreResult;
  } catch {
    return;
  }
  if (r.done) return;
  const who = r.byName ? ` (${r.byName})` : '';
  const what = r.pathname ?? 'bilinmeyen yedek';
  const message = r.hata ? `Buluttan geri yükleme yapılmadı${who}: ${what}; ${r.hata}` : `Buluttan geri yüklendi${who}: ${what}; önceki veritabanı ${r.copy ?? '?'}`;
  tx((t) => {
    fx.audit(t, { userId: r.by ?? null, action: 'yedek', severity: 'uyari', message, data: { pathname: r.pathname ?? null, copy: r.copy ?? null, hata: r.hata ?? null, requestedAt: r.requestedAt ?? null, appliedAt: r.at } });
  });
  writeFileSync(file, JSON.stringify({ ...r, done: true }));
  fx.flush();
}

let restart = () => process.emit('SIGTERM');
/** Testler: yeniden başlatmayı yakalar */
export function setRestartHook(fn: () => void) {
  restart = fn as typeof restart;
}

/** Sunucuyu düzgün kapatır (kapanış işleyicisi veritabanını kapatır); bekçi hazır yedeği yerine koyup yeniden açar */
export function restartForRestore() {
  setTimeout(() => restart(), 500).unref();
}
