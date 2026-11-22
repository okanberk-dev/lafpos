import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanCloudKeys } from '@shared/baglanti';
import { env } from '../env';

/**
 * Buluttan gelen platform anahtarlarının yerel kopyası (#75 İş 2): veri klasöründe `platform-anahtarlari.json` (0600).
 * Veritabanında değil (veritabanı buluta yedeklenir), ayarlar.env'de değil (bekçi o dosya değişince sunucuyu yeniden
 * başlatır; anahtar değişimi yeniden başlatma istemez, bağdaştırıcı yerinde kurulur). İnternet yokken kasa son çekilen
 * değerlerle sürer. Değerler buradan yalnız bağdaştırıcıya gider: arayüz, günlük ve denetim kaydı yalnız anahtar adını görür.
 */

export interface CloudKeyStore {
  /** Bulutta dolu olan değerler (yalnız CLOUD_KEYS) */
  values: Record<string, string>;
  /** Son başarılı çekimin anı; hiç çekilmediyse null */
  at: number | null;
}

const file = () => resolve(env.dataDir, 'platform-anahtarlari.json');
let cache: CloudKeyStore | null = null;

function readStored(): CloudKeyStore {
  try {
    if (!existsSync(file())) return { values: {}, at: null };
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { values?: unknown; at?: unknown };
    return { values: cleanCloudKeys(raw.values), at: typeof raw.at === 'number' ? raw.at : null };
  } catch {
    return { values: {}, at: null };
  }
}

export function cloudKeys(): CloudKeyStore {
  cache ??= readStored();
  return cache;
}

/** Önce geçici dosya, sonra yerine (yarım dosya kalmasın) */
export function saveCloudKeys(next: CloudKeyStore) {
  cache = { values: { ...next.values }, at: next.at };
  writeFileSync(`${file()}.yeni`, JSON.stringify(cache), { mode: 0o600 });
  renameSync(`${file()}.yeni`, file());
}

/** Bağdaştırıcının okuduğu ortam: yerel ayarlar, üstüne bulutta dolu olanlar (bulut ezer, boşsa yerel kalır) */
export const platformVars = (): Record<string, string | undefined> => ({ ...process.env, ...cloudKeys().values });

export interface PullState {
  /** Son denemenin anı ve sonucu (bellekte) */
  triedAt: number | null;
  ok: boolean | null;
  /** Kısa, değersiz neden ("İmza geçersiz", "Uzaktan'a ulaşılamadı") */
  error: string | null;
}

let pull: PullState = { triedAt: null, ok: null, error: null };
export const pullState = (): PullState => pull;
export function setPullState(next: PullState) {
  pull = next;
}

/** Testler: bellekteki kopyayı ve çekim durumunu unutur (dosyadan yeniden okunur) */
export function forgetCloudKeys() {
  cache = null;
  pull = { triedAt: null, ok: null, error: null };
}
