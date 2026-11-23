import { z } from 'zod';
import { GECMIS_KEY, HISTORY_MAX_DAYS, HISTORY_MAX_PRODUCTS, HISTORY_SOURCE, HISTORY_SOURCE_UNKNOWN, type HistoryDay, type HistoryProducts, type HistoryStore, MODPOS_KEY, mergeHistory, validProducts } from '@shared/gecmis';
import { roundHalfUp } from '@shared/money';
import { businessDate, isCalendarDate } from '@shared/time';
import { tx } from '../db/client';
import { env } from '../env';
import { Effects } from '../lib/effects';
import { conflict, HttpError } from '../lib/http';
import { getSettings, getSyncState, setSyncState } from '../lib/settings';
import { MIN_SECRET_LENGTH, signedFetch } from '../lib/signature';
import { httpErrorText, networkErrorText } from './lafmaliyet';

/**
 * ModPOS dönemi lafmaliyet'ten (ladmin): LafPOS'tan önceki kasa programının günleri (ciro, ödeme türleri, indirim, ciro
 * dışı, KDV, Z numarası) ve dönemin ürün listesi, `GET /api/panel/pos/modpos-gunler?sube=<şube>` (imzalı,
 * LAFMALIYET_SYNC_SECRET; docs/03-ENTEGRASYON.md §4.6). lafmaliyet şubenin geçiş gününden önceki günlerini kendi kasa
 * raporlarından (yoksa ModPOS föyünden) verir; LafPOS onları geçmiş ciro günü (shared/gecmis.ts `HistoryDay`, kuruş)
 * olarak saklar (`sync_state` `lafmaliyet.modpos`).
 *
 * Bütçe (AGENTS.md kural 6'nın ruhu): kendiliğinden iş günü başına en çok bir kez (05:00'ten sonraki ya da kasa açıldıktan
 * sonraki ilk turda), elle "ModPOS dönemini çek" (Yönetim › Entegrasyon); ikisi de 5 dakikadan sık değil. Bağlantı
 * tanımlı değilse hiç istek yok. Hata önceki günleri silmez, Entegrasyon'da görünür.
 *
 * Kasa bu günleri elle yüklenen geçmişle (Merkez, `merkez.gecmis`) birleştirir (`historyStore`; aynı tarihte lafmaliyet
 * geçer): patron panelinin kıyası, kasadaki Raporlar ve Uzaktan'a giden gün raporları (server/sync/cloud-reports.ts) o
 * günleri görür. İş günü, Z zinciri ve lafmaliyet'e giden gün paketi görmez.
 */

/** Kendiliğinden ya da elle iki çekim arası en az süre */
export const MODPOS_MIN_MS = 5 * 60_000;
export const MODPOS_PATH = '/api/panel/pos/modpos-gunler';

const amount = z.number().finite().min(0).max(1e9);
const date = z.string().refine(isCalendarDate, 'tarih');
/**
 * lafmaliyet'in yanıtı (CONTRACT §5.1; TL iki haneli). Okuma hoşgörülü: biraz farklı bir lafmaliyet kasayı bozmasın.
 * Bilinmeyen alan yok sayılır; isteğe bağlı alan bozuksa yok sayılır (`catch`); bozuk gün tek başına düşer; bozuk ürün
 * listesi düşer, günler kalır. Yalnız zarf (`version`, `sube`, gün dizisi) bozuksa ya da gün geldiği hâlde hiçbiri
 * okunamıyorsa çekim hata sayılır ve önceki günler kalır
 */
const optAmount = amount.optional().catch(undefined);
const modposDay = z.object({
  date,
  ciro: amount,
  kart: optAmount,
  nakit: optAmount,
  yemek: optAmount,
  online: optAmount,
  diger: optAmount,
  // Yalnız föyden gelen günde null: indirim bilinmiyor (CONTRACT §9)
  indirim: amount.nullable().optional().catch(undefined),
  odenmez: optAmount,
  ikram: optAmount,
  fis: z.number().int().min(0).max(1e6).catch(0),
  zNo: z.string().max(40).nullable().optional().catch(null),
  kdv: z.array(z.object({ rate: z.number().min(0).max(100), base: amount, vat: amount })).max(10).optional().catch(undefined),
  // Günün lafmaliyet'teki kaynağı (bilgi): kasa raporu ya da yalnız ModPOS föyü; eski lafmaliyet göndermez
  kaynak: z.enum(['kasa_raporu', 'foy']).optional().catch(undefined),
});
const modposProducts = z.object({
  from: date,
  to: date,
  // `adet` lafmaliyet'te ondalıklı olabilir; `boy` tek boylu ya da eşlenmemiş satırda null
  rows: z.array(z.object({ ad: z.string().min(1).max(120), boy: z.string().max(12).nullable().optional().catch(null), adet: amount, tutar: amount })).max(HISTORY_MAX_PRODUCTS),
});
const modposBody = z.object({
  version: z.literal(1),
  sube: z.string().min(1).max(40),
  switchDay: date.nullable().catch(null),
  days: z.array(z.unknown()).max(HISTORY_MAX_DAYS),
  urunler: z.unknown().optional(),
});
type ModposBody = { switchDay: string | null; days: z.infer<typeof modposDay>[]; urunler: z.infer<typeof modposProducts> | null };

/** Kasada saklanan dönem: geçmiş kaydı biçiminde (kaynak "ModPOS") ve çekimin durumu */
export interface ModposState extends HistoryStore {
  source: 'ladmin';
  /** lafmaliyet'in geçiş günü (bilgi) */
  switchDay: string | null;
  /** Son başarılı çekim (0: hiç) */
  pulledAt: number;
  /** Son deneme (başarılı ya da değil): bütçe */
  checkedAt: number;
  lastError: string | null;
  lastErrorAt: number | null;
}

export const modposState = () => getSyncState<ModposState>(MODPOS_KEY);

const configured = () => !!env.lafmaliyetUrl && env.lafmaliyetToken.length >= MIN_SECRET_LENGTH;
const kurus = (tl: number) => roundHalfUp(tl * 100);
const PAY: [key: 'kart' | 'nakit' | 'yemek' | 'online' | 'diger', ad: string, alan: string][] = [
  ['kart', 'Kredi kartı', 'card'],
  ['nakit', 'Nakit', 'cash'],
  ['yemek', 'Yemek kartı', 'meal_card'],
  ['online', 'Online', 'online'],
  ['diger', 'Diğer', 'other'],
];

/**
 * lafmaliyet'in günleri → geçmiş ciro günleri (kuruş). Geçiş günü ve bugün ile sonrası alınmaz (LafPOS'un). Ödeme türünün
 * adedi bilinmez (0). Ciro dışı = ödenmez + ikram. İndirim null (yalnız föyden gelen gün): bilinmiyor. KDV satırları
 * geldiği gibi (oran oran; ciroyu tutmuyorsa yazılmaz, rapor %10 sayar; %20 hiç varsayılmaz). Ürün listesi biçimi
 * bozuksa alınmaz
 */
export function modposDays(body: ModposBody, today: string): { gunler: HistoryDay[]; urunler?: HistoryProducts } {
  const out = new Map<string, HistoryDay>();
  for (const d of body.days) {
    if (d.date >= today || (body.switchDay && d.date >= body.switchDay)) continue;
    const ciro = kurus(d.ciro);
    const pay: HistoryDay['pay'] = [];
    for (const [key, ad, alan] of PAY) {
      const v = kurus(d[key] ?? 0);
      if (v > 0) pay.push([ad, alan, v, 0]);
    }
    // Föy gününde indirim bilinmez (null): brüt = ciro, raporlar "bilinmiyor" der (0 gibi gösterilmez)
    const unknown = d.indirim === null;
    const indirim = kurus(d.indirim ?? 0);
    const comp = kurus(d.odenmez ?? 0) + kurus(d.ikram ?? 0);
    const kdv = (d.kdv ?? []).filter((k) => k.base + k.vat > 0).map((k): [number, number, number, number] => [Math.round(k.rate), kurus(k.base) + kurus(k.vat), kurus(k.base), kurus(k.vat)]);
    const kdvOk = kdv.length > 0 && kdv.reduce((a, k) => a + k[1], 0) === ciro;
    const z = d.zNo?.trim();
    out.set(d.date, {
      date: d.date,
      ciro,
      adisyon: d.fis,
      closes: [],
      pay,
      ...(indirim ? { indirim } : {}),
      ...(unknown ? { indirimBilinmiyor: true as const } : {}),
      ...(comp ? { odenmez: comp } : {}),
      // KDV satırları geldiği gibi (karaoke %20, kafe %10); ciroyu tutmuyorsa yazılmaz, rapor %10 sayar
      ...(kdvOk ? { kdv: kdv.sort((a, b) => a[0] - b[0]) } : {}),
      ...(z ? { z } : {}),
    });
  }
  const u = body.urunler;
  // Adet ondalıklı gelebilir (lafmaliyet'te çift duyarlıklı): binde bire yuvarlanır. Toplam günlerin cirosuyla denetlenmez
  // (lafmaliyet'in listesi kuruşu kuruşuna tutmayabilir); yalnız biçimi bozuksa düşer
  const urunler = u ? validProducts({ from: u.from, to: u.to, rows: u.rows.map((r) => [r.ad.trim(), r.boy ?? '', Math.round(r.adet * 1000) / 1000, kurus(r.tutar)]) }) : null;
  return { gunler: [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), ...(urunler ? { urunler } : {}) };
}

function saveFailure(now: number, message: string): never {
  const prev = modposState();
  setSyncState(MODPOS_KEY, { ...(prev ?? { v: 1, kaynak: HISTORY_SOURCE, source: 'ladmin', at: 0, gunler: [], switchDay: null, pulledAt: 0 }), checkedAt: now, lastError: message, lastErrorAt: now } satisfies ModposState);
  throw new HttpError(502, message, 'lafmaliyet_modpos');
}

let running: Promise<ModposPullResult> | null = null;
export interface ModposPullResult {
  days: number;
  from: string | null;
  to: string | null;
  products: number;
  /** İçerik değişti (Uzaktan'a giden günler yeniden gider) */
  changed: boolean;
}

/**
 * Bir çekim: istek, doğrulama ve kayıt. Deneme anı (`checkedAt`) hata olsa da yazılır (bütçe). Elle çekimde denetim
 * kaydı. Aynı anda ikinci çekim beklemez, ilkinin sonucunu alır
 */
export function pullModposDays(now = Date.now(), actor?: { id: string | null }): Promise<ModposPullResult> {
  if (!configured()) throw conflict('lafmaliyet bağlantısı tanımlı değil (LAFMALIYET_URL, LAFMALIYET_SYNC_SECRET)', 'not_configured');
  running ??= pull(now, actor).finally(() => {
    running = null;
  });
  return running;
}

async function pull(now: number, actor?: { id: string | null }): Promise<ModposPullResult> {
  const sube = getSettings().branchId;
  let res: { status: number; json: unknown };
  try {
    res = await signedFetch(env.lafmaliyetToken, 'GET', new URL(`${MODPOS_PATH}?sube=${encodeURIComponent(sube)}`, env.lafmaliyetUrl));
  } catch (e) {
    saveFailure(now, `ModPOS dönemi alınamadı: ${networkErrorText(e)}`);
  }
  if (res.status === 409) saveFailure(now, `ModPOS dönemi alınamadı: lafmaliyet bu kasayı başka bir şubeye bağlı görüyor (şube kimliği "${sube}"; Yönetim › Ayarlar ve yedek › Şube kimliği)`);
  if (res.status === 404) saveFailure(now, `ModPOS dönemi alınamadı (HTTP 404): lafmaliyet bu ucu henüz sunmuyor ya da adres yanlış; lafmaliyet güncellenince yeniden çekin`);
  if (res.status !== 200) saveFailure(now, `ModPOS dönemi alınamadı (${httpErrorText(res.status, res.json)})`);
  const parsed = modposBody.safeParse(res.json);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join('.') || 'gövde';
    saveFailure(now, `ModPOS dönemi okunamadı: lafmaliyet'in yanıtı beklenen biçimde değil (${where}); önceki günler kaldı`);
  }
  if (parsed.data.sube !== sube) saveFailure(now, `ModPOS dönemi alınamadı: lafmaliyet "${parsed.data.sube}" şubesinin günlerini gönderdi, bu kasa "${sube}"`);
  const days = parsed.data.days.flatMap((d) => {
    const one = modposDay.safeParse(d);
    return one.success ? [one.data] : [];
  });
  if (parsed.data.days.length && !days.length) saveFailure(now, `ModPOS dönemi okunamadı: lafmaliyet'in günleri beklenen biçimde değil (days.0); önceki günler kaldı`);
  const products = modposProducts.safeParse(parsed.data.urunler);
  const { gunler, urunler } = modposDays({ switchDay: parsed.data.switchDay, days, urunler: products.success ? products.data : null }, businessDate(now));
  const prev = modposState();
  const changed = JSON.stringify([prev?.gunler ?? [], prev?.urunler ?? null]) !== JSON.stringify([gunler, urunler ?? null]);
  const next: ModposState = {
    v: 1,
    kaynak: HISTORY_SOURCE,
    source: 'ladmin',
    // İçerik değişmediyse anı da değişmez: Uzaktan'a giden günler yeniden gitmez (server/sync/cloud-reports.ts)
    at: changed || !prev?.at ? now : prev.at,
    gunler,
    ...(urunler ? { urunler } : {}),
    switchDay: parsed.data.switchDay,
    pulledAt: now,
    checkedAt: now,
    lastError: null,
    lastErrorAt: null,
  };
  const fx = new Effects();
  tx((t) => {
    setSyncState(MODPOS_KEY, next);
    if (actor)
      fx.audit(t, {
        userId: actor.id,
        action: 'sync.lafmaliyet_modpos',
        message: `lafmaliyet'ten ModPOS dönemi çekildi: ${gunler.length} gün${gunler.length ? ` (${gunler[0]!.date} ile ${gunler.at(-1)!.date} arası)` : ''}`,
        data: { days: gunler.length, changed },
      });
    fx.emit({ topic: 'sync', kind: 'lafmaliyet.modpos' });
  });
  fx.flush();
  return { days: gunler.length, from: gunler[0]?.date ?? null, to: gunler.at(-1)?.date ?? null, products: urunler?.rows.length ?? 0, changed };
}

/**
 * Kendiliğinden çekim (server/jobs.ts, dakikada bir tur): iş günü başına en çok bir deneme (05:00 kuralı), 5 dakikadan
 * sık değil; bağlantı yoksa hiç. Hata işi bozmaz, Entegrasyon'da görünür; ertesi iş günü yeniden denenir (elle de çekilir)
 */
export async function modposTick(now = Date.now()): Promise<'off' | 'skip' | 'ok' | 'error'> {
  if (!configured()) return 'off';
  const checked = modposState()?.checkedAt ?? 0;
  if (checked && (businessDate(checked) >= businessDate(now) || now - checked < MODPOS_MIN_MS)) return 'skip';
  try {
    await pullModposDays(now);
    return 'ok';
  } catch (e) {
    console.warn('[lafmaliyet] ModPOS dönemi alınamadı:', e instanceof Error ? e.message : e);
    return 'error';
  }
}

/** Yönetim › Entegrasyon › "ModPOS dönemini çek": son denemeden 5 dakika geçmediyse 429 */
export function pullModposNow(actor: { id: string | null }, now = Date.now()) {
  if (!configured()) throw conflict('lafmaliyet bağlantısı tanımlı değil (LAFMALIYET_URL, LAFMALIYET_SYNC_SECRET)', 'not_configured');
  const checked = modposState()?.checkedAt ?? 0;
  if (checked && now - checked < MODPOS_MIN_MS) {
    const min = Math.max(1, Math.ceil((MODPOS_MIN_MS - (now - checked)) / 60_000));
    throw new HttpError(429, `ModPOS dönemi az önce çekildi; ${min} dakika sonra yeniden deneyin`, 'too_soon');
  }
  return pullModposDays(now, actor);
}

/** Entegrasyon'un satırı: kaç gün, hangi aralık, son çekim ve hata (tutar yok) */
export function modposStatus() {
  const s = modposState();
  return {
    configured: configured(),
    pulledAt: s?.pulledAt || null,
    checkedAt: s?.checkedAt || null,
    days: s?.gunler.length ?? 0,
    from: s?.gunler[0]?.date ?? null,
    to: s?.gunler.at(-1)?.date ?? null,
    products: s?.urunler?.rows.length ?? 0,
    switchDay: s?.switchDay ?? null,
    error: s?.lastError ? { message: s.lastError, at: s.lastErrorAt ?? null } : null,
  };
}

/** Merkez'den gelen elle yüklenmiş geçmiş (server/sync/merkez.ts `takeHistory`) */
interface ManualHistory {
  at: number;
  gunler: HistoryDay[];
  kaynak?: string;
  urunler?: HistoryProducts;
}

/**
 * Kasanın geçmiş cirosu: elle yüklenen (Merkez) ve lafmaliyet'ten gelen, tarih başına lafmaliyet'inki geçerek
 * (shared/gecmis.ts `mergeHistory`). İkisi de yoksa null
 */
export function historyStore(): HistoryStore | null {
  const manual = getSyncState<ManualHistory>(GECMIS_KEY);
  const ladmin = modposState();
  return mergeHistory(manual?.gunler?.length ? { kaynak: manual.kaynak || HISTORY_SOURCE_UNKNOWN, at: manual.at, gunler: manual.gunler, urunler: manual.urunler } : null, ladmin?.gunler.length ? ladmin : null);
}
