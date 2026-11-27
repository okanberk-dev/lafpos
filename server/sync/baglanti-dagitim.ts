import { checkConnValue, connField } from '@shared/baglanti';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { env } from '../env';
import { settingsFile, writeEnvEdits } from '../lib/ayar-dosyasi';
import { Effects } from '../lib/effects';
import { getSyncState, setSyncState } from '../lib/settings';
import { kasaSubesi } from '../lib/sube';
import { signedFetch } from '../lib/signature';
import { getOpenDay } from '../services/orders';
import { envDegeri, yeniAdlarla } from '@shared/pos-env';

/**
 * Kasanın Uzaktan ve site bağlantısı ladmin'den (docs/03-ENTEGRASYON.md §4b "Anahtar değişimi"): kasa 10 dakikada bir
 * ladmin'e sorar (`GET /api/panel/pos/baglanti`, lafmaliyet anahtarıyla imzalı). Değer değiştiyse yeni değerler
 * bekletilir (`sync_state` `baglanti.bekleyen`) ve **gün kapanınca** (gün açık değilse hemen) ayarlar dosyasına
 * yazılır; bekçi sunucuyu yeni ayarlarla yeniden başlatır. Böylece anahtar değişiminde satış günü bozulmaz. Yalnız kasada
 * zaten tanımlı olan bağlantı güncellenir: kapalı tutulan bağlantı (ör. açılış sırası beklenen site) kendiliğinden
 * açılmaz; yeni kasa bağlantılarını kurulum kodundan alır (kurulum-kodu.ts).
 */

/** Dağıtılan anahtarlar. ladmin Uzaktan'ınkileri bugün eski adla gönderir: yanıt `yeniAdlarla` çevrilir, ayarlar dosyasına
 * dosyada yeni ad yoksa eski adla yazılır (server/lib/ayar-dosyasi.ts) */
export const DAGITILAN_ANAHTARLAR = ['ASILPOS_CLOUD_URL', 'ASILPOS_CLOUD_SECRET', 'LAFFOGATO_URL', 'LAFFOGATO_SYNC_SECRET'] as const;
/** Adres anahtarı → onunla birlikte giden gizli anahtar (çift ya hep birlikte yazılır ya hiç) */
const CIFTLER: [string, string][] = [
  ['ASILPOS_CLOUD_URL', 'ASILPOS_CLOUD_SECRET'],
  ['LAFFOGATO_URL', 'LAFFOGATO_SYNC_SECRET'],
];

const BEKLEYEN = 'baglanti.bekleyen';
const UYGULANAN = 'baglanti.uygulanan';
export const PULL_MS = 10 * 60_000;

export interface Bekleyen {
  surum: string;
  edits: Record<string, string>;
  at: number;
}

/**
 * ladmin'in yanıtından kasaya yazılacaklar (saf): tanınan, geçerli ve kasada tanımlı bağlantının farklı değerleri. Çift
 * eksikse (adres var anahtar yok) o çift yazılmaz
 */
export function dagitimFarki(json: unknown, current: Record<string, string | undefined>): { surum: string; edits: Record<string, string> } | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as { ok?: unknown; surum?: unknown; baglanti?: unknown };
  if (o.ok !== true || typeof o.surum !== 'string' || !/^[0-9a-f]{0,16}$/.test(o.surum)) return null;
  const raw = yeniAdlarla((o.baglanti && typeof o.baglanti === 'object' ? o.baglanti : {}) as Record<string, unknown>);
  const valid: Record<string, string> = {};
  for (const key of DAGITILAN_ANAHTARLAR) {
    const field = connField(key);
    const v = raw[key];
    if (!field || typeof v !== 'string') continue;
    const c = checkConnValue(field, v);
    if ('value' in c && c.value) valid[key] = c.value;
  }
  const edits: Record<string, string> = {};
  for (const [urlKey, secretKey] of CIFTLER) {
    // Kasadaki değer yeni ya da eski adla (kurulu kasanın ayarlar.env'i)
    const nowUrl = envDegeri(current, urlKey)?.trim();
    // Kasada bu bağlantı yoksa (adres boş) dokunulmaz; ladmin'de çift tam değilse de
    if (!nowUrl || !valid[urlKey] || !valid[secretKey]) continue;
    if (nowUrl.replace(/\/+$/, '') !== valid[urlKey].replace(/\/+$/, '')) edits[urlKey] = valid[urlKey];
    if (envDegeri(current, secretKey)?.trim() !== valid[secretKey]) edits[secretKey] = valid[secretKey];
  }
  return { surum: o.surum, edits };
}

export const bekleyenBaglanti = () => getSyncState<Bekleyen>(BEKLEYEN);
const clearPending = () => db.delete(schema.syncState).where(eq(schema.syncState.key, BEKLEYEN)).run();

/**
 * ladmin'e sorar; değişen bağlantıyı bekletir. lafmaliyet bağlantısı yoksa ya da şube seçilmediyse (yeni kasa, kurulum
 * bağlantısından önce) bir şey yapmaz: bağlantılar şubenindir
 */
export async function pullConnections(opts: { fetchImpl?: typeof signedFetch; now?: number } = {}): Promise<Bekleyen | null> {
  if (!env.lafmaliyetUrl || env.lafmaliyetToken.length < 32) return null;
  const sube = kasaSubesi();
  if (!sube) return null;
  const url = new URL('/api/panel/pos/baglanti', env.lafmaliyetUrl);
  url.searchParams.set('sube', sube);
  const applied = getSyncState<{ surum: string }>(UYGULANAN)?.surum ?? '';
  if (applied) url.searchParams.set('uygulanan', applied);
  const res = await (opts.fetchImpl ?? signedFetch)(env.lafmaliyetToken, 'GET', url, undefined, 10_000);
  if (res.status !== 200) return bekleyenBaglanti();
  const diff = dagitimFarki(res.json, process.env);
  if (!diff) return bekleyenBaglanti();
  if (!Object.keys(diff.edits).length) {
    // Kasa zaten güncel: bekleyen kalmaz, uygulanan sürüm ladmin'e söylenir
    clearPending();
    if (diff.surum && diff.surum !== applied) setSyncState(UYGULANAN, { surum: diff.surum, at: opts.now ?? Date.now() });
    return null;
  }
  const next: Bekleyen = { surum: diff.surum, edits: diff.edits, at: opts.now ?? Date.now() };
  setSyncState(BEKLEYEN, next);
  return next;
}

/**
 * Bekleyen bağlantıyı yazar: yalnız gün kapalıyken ve ayarlar dosyası varken (Windows kurulumu). Yazınca bekçi sunucuyu
 * yeniden başlatır; denetime uyarı (anahtarların adı, değeri değil)
 */
export function applyPendingConnections(now = Date.now()): boolean {
  const pending = bekleyenBaglanti();
  if (!pending || !Object.keys(pending.edits).length) return false;
  if (getOpenDay(db)) return false;
  const file = settingsFile();
  if (!file) return false;
  writeEnvEdits(file, pending.edits);
  setSyncState(UYGULANAN, { surum: pending.surum, at: now });
  clearPending();
  const fx = new Effects();
  fx.audit(db, {
    action: 'settings.connections',
    severity: 'uyari',
    entity: 'settings',
    entityId: 'connections',
    message: `Bağlantı bilgileri ladmin'den güncellendi (gün kapalıyken): ${Object.keys(pending.edits).join(', ')}`,
    data: { keys: Object.keys(pending.edits), surum: pending.surum },
  });
  fx.emit({ topic: 'settings', kind: 'settings.updated' });
  fx.flush();
  return true;
}

let running = false;
/** Zamanlayıcı: sor, gün kapalıysa uygula (hata kasayı durdurmaz) */
export async function connectionsTick() {
  if (running) return;
  running = true;
  try {
    await pullConnections().catch((e) => console.error('[bağlantı] ladmin sorulamadı', e instanceof Error ? e.message : e));
    applyPendingConnections();
  } finally {
    running = false;
  }
}
