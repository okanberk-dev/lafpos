import { and, eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { tl } from '@shared/money';
import { type DB, schema, type Tx } from '../db/client';
import { env } from '../env';
import { ulid } from '../lib/ids';
import { getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { requireSiteLinked, siteBranch, siteSigned, unknownSiteListVersion, wrongSiteBranch } from './laffogato-link';
import { SITE_GROUP_KEYS, siteGroupsFor } from './option-profile';

/**
 * laffogato menüsünü LafPOS'a çeker. Kaynak: herkese açık, CDN önbellekli `GET /api/mobile/v1/menu` (ETag).
 * Site fiyatın, Satışta bilgisinin ve KDV'nin sahibidir; LafPOS'a özel alanlar (istasyon, kısa ad, renk,
 * gizli, sık kullanılan, porsiyon sayacı, posName) senkronda korunur. docs/03-ENTEGRASYON.md §2
 */

export interface SiteMenuItem {
  id: string;
  categoryKey: string;
  name: string;
  description?: string;
  priceMinor: number;
  priceLargeMinor: number | null;
  tags?: string[];
  image?: string | null;
  taxRatePct?: number;
  allergens?: string[];
}

export interface SiteMenu {
  categories: { key: string; title: string; subtitle?: string; items: SiteMenuItem[] }[];
  customization: {
    milks: { id: string; label: string; priceMinor: number; allergens?: string[] }[];
    roasts: { id: string; label: string }[];
    syrups: { id: string; label: string; priceMinor: number; allergens?: string[] }[];
    extraShotMinor: number;
    sugarMax: number;
  };
  updatedAt?: string;
}

/** Sitenin seçenek almayan kategorileri (laffogato NON_CUSTOMIZABLE_CATEGORIES) */
export const NON_CUSTOMIZABLE = ['dessert', 'snack', 'extras'];
/** Kategori ilk kez oluşturulurken istasyonu: yiyecekler mutfağa, diğerleri bara */
const KITCHEN_CATEGORIES = ['dessert', 'snack'];

export interface MenuChange {
  kind: 'yeni' | 'fiyat' | 'ad' | 'kdv' | 'boy' | 'kalkti' | 'geri' | 'diger';
  productId: string | null;
  extId: string;
  name: string;
  detail: string;
}

export interface MenuPreview {
  changes: MenuChange[];
  newCategories: string[];
  itemCount: number;
  siteUpdatedAt: string | null;
}

const hashItem = (i: SiteMenuItem) =>
  createHash('sha1')
    .update(JSON.stringify([i.name, i.description ?? '', i.priceMinor, i.priceLargeMinor, i.taxRatePct ?? 10, i.image ?? '', i.allergens ?? null, i.tags ?? [], i.categoryKey]))
    .digest('hex')
    .slice(0, 16);

const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

/**
 * Siteye hiç ulaşılamadı (site kapalı, ağ yok, adres çözülmedi, 15 saniyede yanıt yok): Entegrasyon kartında ve
 * bildirimde Node'un İngilizce "fetch failed"ı yerine. Nedeni ağ hatasının kodu (ECONNREFUSED, ENOTFOUND…)
 */
function siteUnreachable(e: unknown): Error {
  if (isTimeout(e)) return new Error('Siteye ulaşılamadı (15 saniyede yanıt yok)');
  const cause = (e as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const why = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' && cause.message ? cause.message : e instanceof Error ? e.message : String(e);
  return new Error(`Siteye ulaşılamadı (${why})`);
}

export async function fetchPublicMenu(force = false): Promise<{ status: 'degismedi' } | { status: 'yeni'; menu: SiteMenu; etag: string | null }> {
  requireSiteLinked();
  const prev = getSyncState<{ etag?: string }>('laffogato.menu');
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'LafPOS/0.1 (+kafe kasasi)' };
  if (prev?.etag && !force) headers['if-none-match'] = prev.etag;
  let res: Response;
  try {
    res = await fetch(`${env.laffogatoUrl}/api/mobile/v1/menu`, { headers, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw siteUnreachable(e);
  }
  if (res.status === 304) return { status: 'degismedi' };
  if (!res.ok) throw new Error(`Site menüsü alınamadı (HTTP ${res.status})`);
  let menu: SiteMenu;
  try {
    menu = (await res.json()) as SiteMenu;
  } catch (e) {
    // Gövde 15 saniyede bitmedi ya da JSON değil (sitenin hata sayfası): İngilizce ayrıştırıcı iletisi yazılmaz
    throw isTimeout(e) ? siteUnreachable(e) : new Error('Site menüsü beklenen biçimde değil');
  }
  if (!Array.isArray(menu?.categories)) throw new Error('Site menüsü beklenen biçimde değil');
  return { status: 'yeni', menu, etag: res.headers.get('etag') };
}

/**
 * İmzalı panelin kalemleri: sitedeki her kalem, Tükendi olanlar dahil, CDN önbelleği yok (laffogato `toPanelMenuItem`).
 * `isActive` bu şubede satılıyor mu, `onMenu` site kalemi menüden kaldırmadı mı (şube öncesi site göndermez)
 */
export type PanelMenu = Map<string, { isActive: boolean; onMenu?: boolean; priceMinor: number; priceMinorL: number }>;

/**
 * İmzalı panel okuması: kalemler ve şube fiyatının zamanı (laffogato #301, docs/03-ENTEGRASYON.md §2.1 "Şube fiyatı").
 * `nextPriceAt` şubenin bir sonraki fiyat anı (yoksa, eski sitede ya da bozuksa null), `readAt` okumanın anı sitenin
 * saatiyle (`now`; yoksa kasanın saati): o an gelince site hiçbir şey yazmaz, kasa o anda kendisi çeker
 */
export interface PanelRead {
  items: PanelMenu;
  nextPriceAt: string | null;
  readAt: string;
}

/** Sitenin ISO anı (saat dilimli); değilse null. Bozuk değer okumayı bozmaz, yalnız yok sayılır */
function isoInstant(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * İmzalı panel ucundan Tükendi kalemler dahil liste (adres ve anahtar varsa). Bozuk gövde ve tanınmayan biçim
 * (`version` 1 değil; alanı göndermeyen eski site tanınır) liste sayılmaz: çağıran Satışta bilgisine ve bağlı ürünlerin
 * fiyatına dokunmaz.
 */
export async function fetchPanelMenu(): Promise<PanelRead | null> {
  if (!siteSigned()) return null;
  // Satışta bilgisi bu kasanın şubesinin (`?branch=`, §2.3 "Şube")
  const url = new URL(`${env.laffogatoUrl}/api/panel/menu`);
  url.searchParams.set('branch', siteBranch());
  const { status, json } = await signedFetch(env.laffogatoPanelSecret, 'GET', url);
  if (status !== 200) throw new Error(`Panel menüsü alınamadı (HTTP ${status})`);
  const localNow = new Date().toISOString();
  const body = json as { version?: unknown; branch?: unknown; items?: unknown; now?: unknown; nextPriceAt?: unknown } | null;
  const items = body?.items;
  if (!body || !Array.isArray(items)) throw new Error('Panel menüsü beklenen biçimde değil');
  const version = unknownSiteListVersion(body);
  if (version !== null) throw new Error(`Panel menüsü tanınmayan biçimde (sürüm ${version})`);
  // Başka şubenin Satışta'sı bu kasaya yazılmaz (alanı göndermeyen eski site tanınır)
  const other = wrongSiteBranch(body.branch);
  if (other) throw new Error(`Panel menüsü başka şubenin (${other}); bu kasanın şubesi ${siteBranch()}`);
  const map: PanelMenu = new Map(
    (items as { id?: unknown; isActive?: unknown; onMenu?: unknown; priceMinor: number; priceMinorL: number }[])
      .filter((i) => typeof i?.id === 'string' && typeof i.isActive === 'boolean')
      .map((i) => [
        i.id as string,
        { isActive: i.isActive as boolean, ...(typeof i.onMenu === 'boolean' ? { onMenu: i.onMenu } : {}), priceMinor: i.priceMinor, priceMinorL: i.priceMinorL },
      ]),
  );
  // Şube fiyatı öncesi site alanları göndermez: bir sonraki an yok, okuma bugünkü gibi
  return { items: map, nextPriceAt: isoInstant(body.nextPriceAt), readAt: isoInstant(body.now) ?? localNow };
}

/** Şube fiyatının kayıtlı zamanı (`laffogato.menu` durum kaydı): son imzalı okumanın `nextPriceAt`'i ve okuma anı */
export interface PriceTiming {
  nextPriceAt?: string | null;
  priceReadAt?: string | null;
}

/**
 * Şubenin bir sonraki fiyat anı kasada ne ister. An son imzalı okumadan (sitenin saatiyle) sonraysa: gelecekteyse o an
 * (`at`, zamanlayıcı kurar), kasanın saatinde geçtiyse zorunlu eşitleme (`due`: gün açılışında ya da yoklamada ETag'siz,
 * imzalı okuma da yapılsın; herkese açık menü değişmediği için 304 dönerdi). An okumadan önceyse o fiyat zaten okundu.
 */
export function priceInstant(state: PriceTiming | null | undefined, now: number): { due: boolean; at: number | null } {
  const at = Date.parse(state?.nextPriceAt ?? '');
  if (!Number.isFinite(at)) return { due: false, at: null };
  const read = Date.parse(state?.priceReadAt ?? '');
  if (Number.isFinite(read) && at <= read) return { due: false, at: null };
  return now >= at ? { due: true, at: null } : { due: false, at };
}

type LocalProduct = typeof schema.products.$inferSelect;

/** Son eşitlemenin anı: listelenen her bağlı ürünün `syncedAt`'i o eşitlemede yazılır */
function lastSyncAt(local: LocalProduct[]): number {
  return local.reduce((a, p) => Math.max(a, p.syncedAt ?? 0), 0);
}

/**
 * Bağlı ürün LafPOS'ta satışta mı olmalı. Porsiyon sayacı biten ürünü site açamaz (sayaç LafPOS'un). Anahtar
 * varsa imzalı panelin Satışta bilgisi geçerlidir: panel veritabanından tazedir ve her kalemi verir, herkese açık
 * menü ise CDN'den dakikalarca eski gelebilir (s-maxage=300, stale-while-revalidate). Herkese açık listede görünen
 * ama panelde kapalı kalem kapanır, listede görünmeyen ama panelde açık kalem kapanmaz, panelde hiç olmayan kalem
 * sitede silinmiştir. Panel yoksa herkese açık menüde listelenen satışta sayılır; yalnız son eşitlemede de
 * listelenmiş ve o zamandan beri LafPOS'ta (anahtarsız) Tükendi yapılmış ürün, site değişmedikçe kapalı kalır.
 */
export function shouldBeActive(p: LocalProduct, listed: boolean, panel: PanelMenu | null, lastSync: number): boolean {
  if (p.portionsLeft === 0) return false;
  if (panel) return panel.get(p.extId!)?.isActive ?? false;
  if (!listed) return false;
  return p.active || (p.syncedAt ?? 0) < lastSync;
}

type SoldOutBy = 'lafpos' | 'site';

/**
 * Senkrondan sonra Tükendi'nin sahibi. Açılan üründe yok. Site `onMenu` gönderiyorsa (şubeli site) kilit yalnız
 * sitenin menüden kaldırdığı kalemde ('site'): site LafPOS'un onu açmasını 409 `site_closed` ile reddeder. Menüde olup
 * yalnız bu şubede Tükendi olan kalemi (kasa ya da köşkün paneli kapattı) site LafPOS'tan açtırır: kasada açılır
 * ('lafpos'). `onMenu` yoksa eski kural: zaten kapalı üründe kim kapattıysa o kalır, eski kayıtta (sahipsiz) site;
 * yeni kapananda porsiyon bittiyse LafPOS, değilse site.
 */
export function soldOutByAfterSync(p: { active: boolean; soldOutBy: SoldOutBy | null; portionsLeft: number | null }, active: boolean, onMenu?: boolean): SoldOutBy | null {
  if (active) return null;
  if (onMenu === false) return 'site';
  if (onMenu === true) return 'lafpos';
  if (!p.active) return p.soldOutBy ?? 'site';
  return p.portionsLeft === 0 ? 'lafpos' : 'site';
}

/**
 * Eşitlemenin Satışta kuralı. `keep`: imzalı panel alınamadı (anahtar varken): bağlı ürünlerin Satışta bilgisine
 * dokunulmaz, fiyat, ad, KDV ve yeni ürünler yine uygulanır. `held`: LafPOS'un siteye henüz gönderemediği Satışta
 * yazımı bekleyen ürünler (giden kutusu); sitenin anlık görüntüsü o yazımdan eskidir, ürünün durumu korunur.
 */
export interface AvailabilityRule {
  panel: PanelMenu | null;
  keep?: boolean;
  held?: Set<string>;
}

const decides = (rule: AvailabilityRule, extId: string) => !rule.keep && !rule.held?.has(extId);

function siteItems(menu: SiteMenu): SiteMenuItem[] {
  return menu.categories.flatMap((c) => c.items.map((i) => ({ ...i, categoryKey: i.categoryKey ?? c.key })));
}

/**
 * Fiyatın taze kaynağı imzalı panel (sitenin veritabanından, CDN'siz): herkese açık menü CDN'de 5 dakikaya kadar bayat
 * kalabilir ve sitede (ya da lafmaliyet panelinde) değişen fiyat kasaya geç gelirdi. Panel varsa ve kalemin geçerli bir
 * fiyatı varsa M / tek boy ve L fiyatı ondan (`priceMinorL` 0 = tek boy); yoksa herkese açık menüdeki
 */
export function withPanelPrices<T extends { id: string; priceMinor: number; priceLargeMinor?: number | null }>(items: T[], panel: PanelMenu | null): T[] {
  if (!panel) return items;
  return items.map((i) => {
    const p = panelPrice(panel, i.id);
    return p ? { ...i, priceMinor: p.price, priceLargeMinor: p.priceL } : i;
  });
}

/** Kalemin paneldeki geçerli fiyatı (`withPanelPrices` kuralı): M / tek boy ve L (`null` tek boy); geçersizse null */
export function panelPrice(panel: PanelMenu | null, id: string): { price: number; priceL: number | null } | null {
  const p = panel?.get(id);
  if (!p || !Number.isInteger(p.priceMinor) || p.priceMinor <= 0 || !Number.isInteger(p.priceMinorL) || p.priceMinorL < 0) return null;
  return { price: p.priceMinor, priceL: p.priceMinorL > 0 ? p.priceMinorL : null };
}

/**
 * CDN'deki herkese açık liste bayat mı: panelde satışta olan bağlı kalem herkese açık listede yok (liste yalnız satıştaki
 * kalemleri verir; sitede yeniden açılan ürün CDN'de 2 dakikaya kadar görünmez). Kısa süre sonra bir kez ETag'siz
 * yeniden eşitlenir: ad, KDV ve görsel de taze listeden gelsin. Liste Tuzla'nın Satışta'sıdır: Marina'da Tuzla'da tükenen
 * ürün de "bayat" görünür (docs/03-ENTEGRASYON.md §2.1)
 */
export function cdnStale(local: { extId: string | null }[], menu: SiteMenu, panel: PanelMenu | null): boolean {
  if (!panel) return false;
  const listed = new Set(siteItems(menu).map((i) => i.id));
  return local.some((p) => !!p.extId && !listed.has(p.extId) && panel.get(p.extId)?.isActive === true);
}

export function previewMenu(t: Tx | DB, menu: SiteMenu, panelOrRule: PanelMenu | AvailabilityRule | null = null): MenuPreview {
  const rule: AvailabilityRule = panelOrRule instanceof Map || panelOrRule === null ? { panel: panelOrRule } : panelOrRule;
  const panel = rule.panel;
  const local = t.select().from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all();
  const lastSync = lastSyncAt(local);
  const byExt = new Map(local.map((p) => [p.extId!, p]));
  const cats = new Set(t.select({ k: schema.categories.extKey }).from(schema.categories).where(eq(schema.categories.extSource, 'laffogato')).all().map((c) => c.k));
  const changes: MenuChange[] = [];
  const items = withPanelPrices(siteItems(menu), panel);
  const seen = new Set<string>();
  for (const i of items) {
    seen.add(i.id);
    const p = byExt.get(i.id);
    if (!p) {
      changes.push({ kind: 'yeni', productId: null, extId: i.id, name: i.name, detail: `${tl(i.priceMinor)}${i.priceLargeMinor ? ` / ${tl(i.priceLargeMinor)}` : ''}` });
      continue;
    }
    if (decides(rule, i.id)) {
      const active = shouldBeActive(p, true, panel, lastSync);
      if (!p.active && active) changes.push({ kind: 'geri', productId: p.id, extId: i.id, name: i.name, detail: 'Sitede yeniden satışta' });
      if (p.active && !active) changes.push({ kind: 'kalkti', productId: p.id, extId: i.id, name: i.name, detail: p.portionsLeft === 0 ? 'Porsiyon bitti' : 'Sitede Tükendi' });
    }
    // İmzalı okuma alınamadı: herkese açık menünün fiyatı ana şubenin (Tuzla); bağlı ürünün son imzalı fiyatı kalır
    if (!rule.keep && p.price !== i.priceMinor) changes.push({ kind: 'fiyat', productId: p.id, extId: i.id, name: i.name, detail: `${tl(p.price)} → ${tl(i.priceMinor)}` });
    if (!rule.keep && (p.priceL ?? null) !== (i.priceLargeMinor ?? null)) {
      changes.push({ kind: 'boy', productId: p.id, extId: i.id, name: i.name, detail: `L: ${p.priceL ? tl(p.priceL) : 'yok'} → ${i.priceLargeMinor ? tl(i.priceLargeMinor) : 'yok'}` });
    }
    if (p.name !== i.name) changes.push({ kind: 'ad', productId: p.id, extId: i.id, name: i.name, detail: `"${p.name}" → "${i.name}"` });
    if (p.kdvRate !== (i.taxRatePct ?? 10)) changes.push({ kind: 'kdv', productId: p.id, extId: i.id, name: i.name, detail: `%${p.kdvRate} → %${i.taxRatePct ?? 10}` });
    else if (p.extHash && p.extHash !== hashItem(i) && !changes.some((c) => c.extId === i.id)) {
      changes.push({ kind: 'diger', productId: p.id, extId: i.id, name: i.name, detail: 'Açıklama, görsel ya da alerjen değişti' });
    }
  }
  for (const p of local) {
    if (seen.has(p.extId!)) continue;
    // Herkese açık listede yok (Tükendi ya da CDN bayat) ama panelde fiyatı var: fiyat yine panelden (yeniden açılan ürün
    // eski fiyattan satılmasın)
    const pp = panelPrice(panel, p.extId!);
    if (pp && pp.price !== p.price) changes.push({ kind: 'fiyat', productId: p.id, extId: p.extId!, name: p.name, detail: `${tl(p.price)} → ${tl(pp.price)}` });
    if (pp && (p.priceL ?? null) !== pp.priceL) {
      changes.push({ kind: 'boy', productId: p.id, extId: p.extId!, name: p.name, detail: `L: ${p.priceL ? tl(p.priceL) : 'yok'} → ${pp.priceL ? tl(pp.priceL) : 'yok'}` });
    }
    if (!decides(rule, p.extId!)) continue;
    const active = shouldBeActive(p, false, panel, lastSync);
    if (!p.active && active) changes.push({ kind: 'geri', productId: p.id, extId: p.extId!, name: p.name, detail: 'Sitede yeniden satışta' });
    if (p.active && !active) changes.push({ kind: 'kalkti', productId: p.id, extId: p.extId!, name: p.name, detail: panel?.has(p.extId!) ? 'Sitede Tükendi' : 'Sitede satışta değil' });
  }
  return {
    changes,
    newCategories: menu.categories.filter((c) => !cats.has(c.key)).map((c) => c.title),
    itemCount: items.length,
    siteUpdatedAt: menu.updatedAt ?? null,
  };
}

function upsertOptionGroups(t: Tx | DB, menu: SiteMenu): string[] {
  const c = menu.customization;
  const defs: {
    key: string;
    name: string;
    kind: 'single' | 'counter';
    items: { code: string; name: string; price: number; isDefault: boolean; maxQty: number; allergens: string[] }[];
  }[] = [
    { key: 'milk', name: 'Süt', kind: 'single', items: c.milks.map((m, i) => ({ code: m.id, name: m.label, price: m.priceMinor, isDefault: i === 0, maxQty: 1, allergens: m.allergens ?? [] })) },
    { key: 'roast', name: 'Kavrum', kind: 'single', items: c.roasts.map((r, i) => ({ code: r.id, name: r.label, price: 0, isDefault: i === 0, maxQty: 1, allergens: [] })) },
    { key: 'syrup', name: 'Şurup', kind: 'single', items: c.syrups.map((s, i) => ({ code: s.id, name: s.label, price: s.priceMinor, isDefault: i === 0, maxQty: 1, allergens: s.allergens ?? [] })) },
    { key: 'extraShot', name: 'Ekstra shot', kind: 'counter', items: [{ code: 'extraShot', name: 'Ekstra shot', price: c.extraShotMinor, isDefault: false, maxQty: 1, allergens: [] }] },
    { key: 'sugar', name: 'Şeker', kind: 'counter', items: [{ code: 'sugar', name: 'Şeker', price: 0, isDefault: false, maxQty: c.sugarMax, allergens: [] }] },
  ];
  const ids: string[] = [];
  defs.forEach((d, gi) => {
    let g = t.select().from(schema.optionGroups).where(and(eq(schema.optionGroups.extSource, 'laffogato'), eq(schema.optionGroups.extKey, d.key))).get();
    if (!g) {
      const id = ulid();
      t.insert(schema.optionGroups).values({ id, name: d.name, kind: d.kind, required: false, maxSelect: 1, sort: gi, extSource: 'laffogato', extKey: d.key }).run();
      g = t.select().from(schema.optionGroups).where(eq(schema.optionGroups.id, id)).get()!;
    }
    ids.push(g.id);
    const existing = t.select().from(schema.optionItems).where(eq(schema.optionItems.groupId, g.id)).all();
    d.items.forEach((it, ii) => {
      const e = existing.find((x) => x.code === it.code);
      if (e) t.update(schema.optionItems).set({ name: it.name, price: it.price, isDefault: it.isDefault, maxQty: it.maxQty, allergens: it.allergens, sort: ii, active: true }).where(eq(schema.optionItems.id, e.id)).run();
      else t.insert(schema.optionItems).values({ id: ulid(), groupId: g!.id, name: it.name, code: it.code, price: it.price, isDefault: it.isDefault, maxQty: it.maxQty, allergens: it.allergens, sort: ii }).run();
    });
    for (const e of existing) if (!d.items.some((x) => x.code === e.code)) t.update(schema.optionItems).set({ active: false }).where(eq(schema.optionItems.id, e.id)).run();
  });
  return ids;
}

/**
 * Menüyü uygular (tek işlem). Fiyat, ad, KDV, açıklama, görsel siteden gelir; POS alanları (sıra dahil) korunur.
 * Satışta bilgisi `shouldBeActive` kuralıyla (imzalı panel verildiyse onun Satışta bilgisi geçerlidir): sitede
 * satışta olmayan bağlı ürün Tükendi yapılır (silinmez, geçmiş satışlar bozulmasın), porsiyonu biten ürünü site
 * açamaz. Tükendi'nin sahibi `soldOutBy`'a yazılır. `keep` ve `held` ürünlerin Satışta bilgisine dokunulmaz
 * (`AvailabilityRule`). `keep`'te (imzalı okuma alınamadı) var olan bağlı ürünün fiyatı da değişmez: herkese açık menü
 * ana şubenin (Tuzla) fiyatıdır, kasanın şubesinin fiyatı yalnız imzalı okumadadır (şube fiyatı, laffogato #301); yeni
 * ürün herkese açık listenin fiyatıyla oluşur, sonraki imzalı okuma düzeltir.
 */
export function applyMenu(
  t: Tx,
  menu: SiteMenu,
  opts: { barStationId?: string | null; kitchenStationId?: string | null; panel?: PanelMenu | null; keep?: boolean; held?: Set<string> } = {},
): { created: number; updated: number; deactivated: number; reactivated: number } {
  const now = Date.now();
  const rule: AvailabilityRule = { panel: opts.panel ?? null, keep: opts.keep, held: opts.held };
  const panel = rule.panel;
  const lastSync = lastSyncAt(t.select().from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all());
  const groupIds = upsertOptionGroups(t, menu);
  const catIdByKey = new Map<string, string>();
  menu.categories.forEach((c, ci) => {
    const existing = t.select().from(schema.categories).where(and(eq(schema.categories.extSource, 'laffogato'), eq(schema.categories.extKey, c.key))).get();
    if (existing) {
      t.update(schema.categories)
        .set({ name: c.title, subtitle: c.subtitle || null, sort: ci, customizable: !NON_CUSTOMIZABLE.includes(c.key) })
        .where(eq(schema.categories.id, existing.id))
        .run();
      catIdByKey.set(c.key, existing.id);
    } else {
      const id = ulid();
      t.insert(schema.categories)
        .values({
          id,
          name: c.title,
          subtitle: c.subtitle || null,
          sort: ci,
          color: CATEGORY_COLORS[c.key] ?? '#245c43',
          stationId: KITCHEN_CATEGORIES.includes(c.key) ? (opts.kitchenStationId ?? opts.barStationId ?? null) : (opts.barStationId ?? null),
          customizable: !NON_CUSTOMIZABLE.includes(c.key),
          extSource: 'laffogato',
          extKey: c.key,
        })
        .run();
      catIdByKey.set(c.key, id);
    }
  });

  let created = 0;
  let updated = 0;
  let deactivated = 0;
  let reactivated = 0;
  const seen = new Set<string>();
  const items = withPanelPrices(siteItems(menu), panel);
  items.forEach((i, idx) => {
    seen.add(i.id);
    const categoryId = catIdByKey.get(i.categoryKey);
    if (!categoryId) return;
    const values = {
      categoryId,
      name: i.name,
      description: i.description || null,
      price: i.priceMinor,
      priceL: i.priceLargeMinor ?? null,
      kdvRate: i.taxRatePct ?? 10,
      image: i.image ?? null,
      tags: i.tags ?? [],
      allergens: i.allergens ?? null,
      extHash: hashItem(i),
      syncedAt: now,
      updatedAt: now,
    };
    const existing = t.select().from(schema.products).where(and(eq(schema.products.extSource, 'laffogato'), eq(schema.products.extId, i.id))).get();
    let productId: string;
    if (existing) {
      // İmzalı okuma yok: son imzalı fiyat kalır; özet de saklanan fiyatla (sonraki okumada sahte "diğer" değişikliği çıkmasın)
      const kept = { priceMinor: existing.price, priceLargeMinor: existing.priceL ?? null };
      const own = rule.keep ? { ...values, price: existing.price, priceL: existing.priceL ?? null, extHash: hashItem({ ...i, ...kept }) } : values;
      if (decides(rule, i.id)) {
        const active = shouldBeActive(existing, true, panel, lastSync);
        if (existing.active && !active) deactivated++;
        if (!existing.active && active) reactivated++;
        t.update(schema.products).set({ ...own, active, soldOutBy: soldOutByAfterSync(existing, active, panel?.get(i.id)?.onMenu) }).where(eq(schema.products.id, existing.id)).run();
      } else t.update(schema.products).set(own).where(eq(schema.products.id, existing.id)).run();
      productId = existing.id;
      updated++;
    } else {
      productId = ulid();
      // POS sırası LafPOS'un (docs/03 §1): yalnız ürün ilk gelirken sitenin sırası verilir. Panel alınamadıysa
      // herkese açık listede görünen yeni kalem satıştadır
      const active = (rule.keep ? undefined : panel?.get(i.id)?.isActive) ?? true;
      // Yalnız bu şubede Tükendi (menüde) olan yeni kalem kasada açılabilir; kilit yalnız sitenin menüden kaldırdığında
      const soldOutBy = active ? null : soldOutByAfterSync({ active: true, soldOutBy: null, portionsLeft: null }, false, panel?.get(i.id)?.onMenu);
      t.insert(schema.products).values({ id: productId, ...values, sort: idx, active, soldOutBy, extSource: 'laffogato', extId: i.id, createdAt: now }).run();
      created++;
    }
    // Site seçenekleri (süt, şurup…) yalnız ürün ilk kez gelirken bağlanır, seçenek profiline göre (Su'ya süt, Çay'a
    // kavrum sorulmaz: option-profile.ts); sonra yöneticinin seçimi korunur
    if (!existing && !NON_CUSTOMIZABLE.includes(i.categoryKey)) {
      const wanted = new Set(siteGroupsFor(i.categoryKey, i.id));
      SITE_GROUP_KEYS.forEach((key, gi) => {
        if (wanted.has(key)) t.insert(schema.productOptionGroups).values({ productId, groupId: groupIds[gi], sort: gi }).onConflictDoNothing().run();
      });
    }
  });

  // Herkese açık listede olmayan bağlı ürünler: panel "açık" diyorsa (CDN bayat) kapanmaz. Panelde geçerli fiyatı varsa
  // fiyat ondan: sitede Tükendi'yken değişen fiyat, ürün yeniden açılınca (liste CDN'de henüz eski) kasaya gelir
  const local = t.select().from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all();
  for (const p of local) {
    if (seen.has(p.extId!)) continue;
    const pp = panelPrice(panel, p.extId!);
    const price = pp && (pp.price !== p.price || pp.priceL !== (p.priceL ?? null)) ? { price: pp.price, priceL: pp.priceL } : null;
    if (!decides(rule, p.extId!)) {
      if (price) t.update(schema.products).set({ ...price, updatedAt: now }).where(eq(schema.products.id, p.id)).run();
      continue;
    }
    const active = shouldBeActive(p, false, panel, lastSync);
    const soldOutBy = soldOutByAfterSync(p, active, panel?.get(p.extId!)?.onMenu);
    if (active === p.active && soldOutBy === p.soldOutBy && !price) continue;
    t.update(schema.products).set({ active, soldOutBy, ...(price ?? {}), updatedAt: now }).where(eq(schema.products.id, p.id)).run();
    if (p.active && !active) deactivated++;
    if (!p.active && active) reactivated++;
  }
  return { created, updated, deactivated, reactivated };
}

const CATEGORY_COLORS: Record<string, string> = {
  matcha: '#5e8f45',
  espresso: '#6b4226',
  'ice-coffee': '#3f6b8a',
  cold: '#2f7d7a',
  hot: '#9a3b2f',
  frappe: '#8a5a2b',
  smoothie: '#a23e6b',
  frozen: '#c2577e',
  'ice-tea': '#b07a1f',
  dessert: '#6b1a2b',
  snack: '#a87c2e',
  extras: '#7a6a5f',
};

export function recordMenuSync(result: { etag?: string | null; changes?: number; error?: string | null; prices?: { nextPriceAt: string | null; readAt: string } }) {
  const prev = getSyncState<Record<string, unknown>>('laffogato.menu') ?? {};
  setSyncState('laffogato.menu', {
    ...prev,
    // Şube fiyatının zamanı yalnız uygulanmış imzalı okumadan (jobs.ts bir sonraki ana eşitleme kurar)
    ...(result.prices ? { nextPriceAt: result.prices.nextPriceAt, priceReadAt: result.prices.readAt } : {}),
    ...(result.etag !== undefined ? { etag: result.etag } : {}),
    lastCheckAt: Date.now(),
    ...(result.error ? { lastError: result.error, lastErrorAt: Date.now() } : { lastError: null, lastSuccessAt: Date.now() }),
    ...(result.changes !== undefined ? { lastChanges: result.changes } : {}),
  });
}

/** Gün açıkken menünün en çok bu kadar eşitlenmeden kalabileceği süre: iki yoklama (15 dk) ve pay */
export const MENU_STALE_MS = 40 * 60_000;

/**
 * Menü sessizce bayatladı mı: bağlantı ve otomatik eşitleme açık, gün açık, son başarılı kontrol (ya da gün açılışı,
 * hangisi yeniyse) `MENU_STALE_MS`'ten eski ve kayıtlı bir hata yok. Yoklama hiç çalışmadığında hata da yazılmaz;
 * kasa eski fiyattan satmaya devam eder ve kimse fark etmez. Bu durumda Entegrasyon ve yönetim çubuğu hata gösterir.
 */
export function menuStaleError(o: {
  linked: boolean;
  auto: boolean;
  /** Açık günün açılış (ya da yeniden açılış) anı; gün kapalıysa null */
  dayOpenedAt: number | null;
  state: { lastSuccessAt?: number; lastError?: string | null } | null;
  now: number;
}): string | null {
  if (!o.linked || !o.auto || o.dayOpenedAt === null || o.state?.lastError) return null;
  const since = Math.max(o.state?.lastSuccessAt ?? 0, o.dayOpenedAt);
  const late = o.now - since;
  if (late <= MENU_STALE_MS) return null;
  return `Menü ${Math.floor(late / 60_000)} dakikadır siteyle eşitlenmedi: kasa eski fiyattan satıyor olabilir. "Siteyle eşitle" ile deneyin`;
}
