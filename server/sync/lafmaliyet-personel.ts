import { isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/client';
import { env } from '../env';
import { HttpError } from '../lib/http';
import { getSettings } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { lafmaliyetConfigured, lazyErrorText, networkErrorText } from './lafmaliyet';

/**
 * Personel bağlantısı (lafmaliyet → AsilPOS; docs/03-ENTEGRASYON.md §4.8). AsilPOS kullanıcısı lafmaliyet'in personel
 * kaydına (`s:<staff.id>`, bordro satırı) yalnız Yönetim › Personel'de, iki tarafı gösteren onayla elle bağlanır; ad
 * benzerliği yalnız ipucudur, hiçbir şey kendiliğinden bağlanmaz ya da seçilmez (sahip kararı 2, 23 Kas 2026).
 *
 * Liste imzalı `GET /api/panel/pos/personel?sube=<şube>`'den yalnız ekran isteyince çekilir (seçici açılınca, bağlarken)
 * ve yalnız bellekte en çok 5 dakika tutulur: diske yazılmaz, yedeğe girmez. Adlar yalnız seçicide görünür, denetime
 * yazılmaz; gün sonu gövdesine yalnız kimlik gider (`workedStaffRefs`).
 */

/** lafmaliyet personel kimliği: bordro satırının numarası */
export const STAFF_REF = /^s:[1-9]\d{0,8}$/;

export interface LadminStaff {
  ref: string;
  name: string;
  active: boolean;
  /** Kayda bağlı lafmaliyet giriş hesabının görünen adı (yoksa null) */
  account: string | null;
}

export interface LadminStaffList {
  /** Çekildiği an */
  at: number;
  sube: string;
  items: LadminStaff[];
}

/** Önbelleğin ömrü: bundan eski liste bağlarken yeniden çekilir */
export const STAFF_CACHE_MS = 5 * 60_000;
/** "Yenile" en sık bu arayla gerçekten ladmin'e gider */
export const STAFF_REFRESH_MIN_MS = 30_000;

const staffBody = z.object({
  version: z.literal(1),
  sube: z.string(),
  items: z
    .array(
      z.object({
        ref: z.string().regex(STAFF_REF),
        name: z.string().trim().min(1).max(120),
        active: z.boolean(),
        account: z.string().trim().max(120).nullish(),
      }),
    )
    .max(1000),
});

let cache: LadminStaffList | null = null;
let inflight: Promise<LadminStaffList> | null = null;

/** Önbelleği boşaltır (testler; bağlantı ayarı değişince eski şubenin listesi kalmasın) */
export function resetStaffCache() {
  cache = null;
}

const unavailable = (message: string) => new HttpError(503, message, 'ladmin_unavailable');

async function fetchStaff(sube: string): Promise<LadminStaffList> {
  const url = new URL('/api/panel/pos/personel', env.lafmaliyetUrl);
  url.searchParams.set('sube', sube);
  let res: { status: number; json: unknown };
  try {
    res = await signedFetch(env.lafmaliyetToken, 'GET', url, undefined, 10_000);
  } catch (e) {
    throw unavailable(`ladmin personel listesi alınamadı: ${networkErrorText(e)}`);
  }
  if (res.status === 409 && (res.json as { error?: unknown } | null)?.error === 'wrong_branch') {
    const expected = String((res.json as { expected?: unknown }).expected ?? '?');
    throw new HttpError(
      409,
      `lafmaliyet bu kasanın şubesini ("${sube}") değil "${expected}" şubesini bekliyor: Yönetim › Ayarlar ve yedek › Şube kimliği doğru mu`,
      'wrong_branch',
    );
  }
  if (res.status !== 200) throw unavailable(`ladmin personel listesi alınamadı (${lazyErrorText(res.status, res.json)})`);
  const parsed = staffBody.safeParse(res.json);
  // Başka şubenin listesi bu kasanın personeli değildir: bağlanmaz
  if (!parsed.success || parsed.data.sube !== sube) throw unavailable("ladmin personel listesi okunamadı: lafmaliyet'in yanıtı beklenen biçimde değil");
  return { at: Date.now(), sube, items: parsed.data.items.map((i) => ({ ref: i.ref, name: i.name, active: i.active, account: i.account ?? null })) };
}

/**
 * lafmaliyet'in bu şubedeki personel listesi. Önbellek (aynı şube) `maxAgeMs`'den yeniyse ondan; değilse çekilir (aynı
 * anda gelen istekler tek isteği bekler). Bağlantı yoksa, ladmin'e ulaşılamazsa ya da yanıt bozuksa 503 (liste uydurulmaz),
 * lafmaliyet başka şube bekliyorsa 409 `wrong_branch`. Hata önbelleği silmez ama kullanılmaz: bağlama taze liste ister
 */
export async function ladminStaff(opts: { maxAgeMs?: number } = {}): Promise<LadminStaffList> {
  if (!lafmaliyetConfigured()) throw new HttpError(503, 'lafmaliyet bağlantısı tanımlı değil (LAFMALIYET_URL, LAFMALIYET_SYNC_SECRET)', 'not_configured');
  const sube = getSettings().branchId;
  const maxAge = opts.maxAgeMs ?? STAFF_CACHE_MS;
  if (cache && cache.sube === sube && Date.now() - cache.at < maxAge) return cache;
  if (!inflight) {
    inflight = fetchStaff(sube)
      .then((list) => (cache = list))
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Bağlı AsilPOS kullanıcıları: personel kimliği → kullanıcı */
export function linkedUsers(): Map<string, { id: string; name: string }> {
  return new Map(
    db
      .select({ id: schema.users.id, name: schema.users.name, staffRef: schema.users.staffRef })
      .from(schema.users)
      .where(isNotNull(schema.users.staffRef))
      .all()
      .map((u) => [u.staffRef!, { id: u.id, name: u.name }]),
  );
}

/**
 * Bağlanacak kayıt geçerli mi (PATCH /admin/users/:id): taze listede var (5 dakikadan eski liste yeniden çekilir;
 * çekilemezse 503, bağlantı kurulmaz), ladmin'de etkin ve başka AsilPOS kullanıcısına bağlı değil
 */
export async function assertLinkable(ref: string, userId: string) {
  const list = await ladminStaff();
  const item = list.items.find((i) => i.ref === ref);
  if (!item) throw new HttpError(422, `Bu kayıt lafmaliyet'in "${list.sube}" personel listesinde yok; listeyi yenileyip yeniden seçin`, 'staff_ref_unknown');
  if (!item.active) throw new HttpError(422, "Bu kayıt lafmaliyet'te etkin değil; etkin bir personel seçin", 'staff_ref_inactive');
  assertRefFree(ref, userId);
}

/** Kayıt başka bir AsilPOS kullanıcısına bağlıysa 409 `staff_ref_taken` (yazmadan hemen önce yeniden bakılır) */
export function assertRefFree(ref: string, userId: string) {
  const other = linkedUsers().get(ref);
  if (other && other.id !== userId) throw new HttpError(409, `Bu lafmaliyet personeli zaten ${other.name} hesabına bağlı; önce oradaki bağlantıyı kaldırın`, 'staff_ref_taken');
}
