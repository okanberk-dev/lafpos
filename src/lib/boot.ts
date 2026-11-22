import { useQuery } from '@tanstack/react-query';
import { happyHourPercentAt, happyHourUnit } from '@shared/order-calc';
import type { BootstrapDTO, OptionGroupDTO, OptionItemDTO, ProductDTO, SelectedOption, Size } from '@shared/types';
import { get } from './api';
import { REMOTE, REMOTE_SLOW_POLL_MS } from './remote';

/**
 * Açılış verisi: menü, masa planı, ödeme türleri, ayarlar. Menü/ayar olaylarında yenilenir; uzakta canlı olay yok,
 * 5 dk'da bir sorulur (değişmediyse 304)
 */
export function useBootQuery() {
  return useQuery({ queryKey: ['bootstrap'], queryFn: () => get<BootstrapDTO>('/bootstrap'), staleTime: 5 * 60_000, refetchInterval: REMOTE ? REMOTE_SLOW_POLL_MS : false });
}

export function useBoot(): BootstrapDTO {
  const { data } = useBootQuery();
  if (!data) throw new Error('Açılış verisi henüz yüklenmedi');
  return data;
}

export function productGroups(boot: BootstrapDTO, p: ProductDTO): OptionGroupDTO[] {
  return p.optionGroupIds.map((id) => boot.optionGroups.find((g) => g.id === id)).filter((g): g is OptionGroupDTO => !!g);
}

/**
 * İsteğe bağlı tek seçimlik grubun tükenen varsayılanı seçili sayılmaz (pencerenin önseçtiği Normal süt, pencere açıkken
 * ya da satır sepetteyken tükendi): seçim yokmuş gibi ele alınır. Sunucu seçimsiz grubun tükenen varsayılanını yazmaz,
 * satış sürer; açıkça gönderilse 409 alırdı. Pencere onu bırakır (`reconcilePicks`), sepet işaretlemez
 * (`pendingProblem`), gönderim çıkarır (`sendableOptions`), tahmini fiyata ve seçenek metnine girmez
 */
function lapsedDefault(g: OptionGroupDTO, i: OptionItemDTO): boolean {
  return g.kind === 'single' && !g.required && i.isDefault && i.soldOut;
}

/**
 * Gönderimden hemen önce bekleyen satırın seçenekleri: `lapsedDefault` seçimler çıkar, o grup boş gider (sunucu seçenek
 * yazmaz; kalsa 409 alır, bütün bekleyen satırlar takılırdı). Çıkacak bir şey yoksa aynı dizi döner
 */
export function sendableOptions<T extends { itemId: string }>(boot: BootstrapDTO, productId: string, options: T[]): T[] {
  const p = boot.products.find((x) => x.id === productId);
  if (!p || !options.length) return options;
  const lapsed = new Set(productGroups(boot, p).flatMap((g) => g.items.filter((i) => lapsedDefault(g, i)).map((i) => i.id)));
  return options.some((o) => lapsed.has(o.itemId)) ? options.filter((o) => !lapsed.has(o.itemId)) : options;
}

/**
 * Hızlı eklemede (seçeneksiz) sunucu tek seçimlik grupların varsayılanını yazar; zorunlu grubun varsayılanı kasada
 * tükendiyse seçenek penceresi açılır (sunucu 409 `option_sold_out` döner). İsteğe bağlı grubun tükenen varsayılanı
 * (Normal süt) hızlı eklemeyi durdurmaz: sunucu o grup için seçenek yazmaz, su ve espresso sorulmadan eklenir
 */
export function soldOutDefault(boot: BootstrapDTO, p: ProductDTO): boolean {
  return productGroups(boot, p).some((g) => g.kind === 'single' && g.required && g.items.some((i) => i.isDefault && i.soldOut));
}

export function sizePrice(p: ProductDTO, size: Size): number {
  return size === 'L' && p.priceL != null ? p.priceL : p.price;
}

/**
 * Bekleyen satırın sunucuda yazılacak seçenekleri, kasa satışında `resolveOptions`'ın kuralıyla: satırın kendi
 * seçimleri (isteğe bağlı grubun tükenen varsayılanı hariç, gönderim onu çıkarır: `sendableOptions`; sayaçlı grupta
 * aynı seçeneğin adetleri toplanır, sıfır adet yazılmaz) ve seçimi olmayan tek seçimlik grupta varsayılan, tükenmemişse.
 * Ücretli varsayılan (Karton +₺5) satır eklenirken tükenikti ve sonra satışa açıldı, ya da iki boylu ürün pencere
 * açılmadan eklendi: sunucu onu yazar ve ücretini alır, tahmin ve satır metni de. Tükenen varsayılanı sunucu isteğe
 * bağlı grupta yazmaz; zorunlu grupta 409 verir, o satır zaten `pendingProblem` ile işaretli
 */
function resolvedPicks(boot: BootstrapDTO, p: ProductDTO, picks: { itemId: string; qty?: number }[]) {
  const out: { g: OptionGroupDTO; item: OptionItemDTO; qty: number }[] = [];
  for (const g of productGroups(boot, p)) {
    const own = new Map<string, { g: OptionGroupDTO; item: OptionItemDTO; qty: number }>();
    for (const pick of picks) {
      const item = g.items.find((i) => i.id === pick.itemId);
      if (!item || lapsedDefault(g, item)) continue;
      const qty = g.kind === 'counter' ? Math.trunc(pick.qty ?? 1) : 1;
      const seen = own.get(item.id);
      if (!seen) own.set(item.id, { g, item, qty });
      else if (g.kind === 'counter') seen.qty += qty;
    }
    if (own.size || g.kind !== 'single') {
      out.push(...[...own.values()].filter((r) => r.qty > 0));
      continue;
    }
    const d = g.items.find((i) => i.isDefault);
    if (d && !d.soldOut) out.push({ g, item: d, qty: 1 });
  }
  return out;
}

/**
 * Menü birim fiyatı: boy ve sunucunun yazacağı seçeneklerin farkları dahil (`resolvedPicks`), happy hour öncesi (elle
 * fiyatın karşılaştırıldığı tutar)
 */
export function menuUnit(boot: BootstrapDTO, p: ProductDTO, size: Size, picks: { itemId: string; qty?: number }[]): number {
  return resolvedPicks(boot, p, picks).reduce((unit, r) => unit + r.item.price * r.qty, sizePrice(p, size));
}

/**
 * Gönderilmemiş kalemin tahmini birim fiyatı: menü fiyatına şu an geçerli happy hour, sunucunun kalemi eklerken
 * yaptığı hesapla uygulanır (kesin fiyat gönderince gelir; saat sınırında cihaz saati farkı olabilir)
 */
export function estimateUnit(boot: BootstrapDTO, p: ProductDTO, size: Size, picks: { itemId: string; qty?: number }[], nowMs = Date.now()): number {
  return happyHourUnit(menuUnit(boot, p, size, picks), happyHourPercentAt(boot.happyHours, p, nowMs));
}

/**
 * Gönderilmemiş kalemin seçenek metni: sunucunun yazacağı seçenekler (`resolvedPicks`) sunucunun `optionsText`
 * kuralıyla. İsteğe bağlı grubun ücretsiz varsayılanı (Normal süt) yazılmaz, ücretli varsayılan (Karton) ve zorunlu
 * grubun seçimi (Orta) yazılır
 */
export function pendingOptionsText(boot: BootstrapDTO, p: ProductDTO, picks: { itemId: string; qty?: number }[]): string {
  const parts: string[] = [];
  for (const { g, item, qty } of resolvedPicks(boot, p, picks)) {
    if (g.items.find((i) => i.isDefault)?.id === item.id && item.price === 0 && !g.required) continue;
    if (g.extKey === 'extraShot') parts.push(qty > 1 ? `+${qty} shot` : '+1 shot');
    else if (g.extKey === 'sugar') parts.push(`${qty} şeker`);
    else if (g.extKey === 'roast') parts.push(`${item.name} kavrum`);
    else parts.push(qty > 1 ? `${qty}× ${item.name}` : item.name);
  }
  return parts.join(' · ');
}

/** Kasiyerin seçmesi gereken grup: zorunlu ve seçeneği var (sayaçlı grup, ekstra shot gibi, sıfırla da geçerli) */
const isChoice = (g: OptionGroupDTO) => g.required && g.kind !== 'counter' && g.items.length > 0;

/**
 * Üründe zorunlu seçim var mı (Türk kahvesinde şeker). Kasa satışında (eski istemci) seçeneksiz gelen zorunlu tek
 * seçimlik gruba sunucu varsayılanı yazar, varsayılan kasada tükendiyse 409 `option_sold_out` (docs/03 §2.3); paket
 * platformu ve site satırına yazılmaz, seçim notta ya da sitenin döküm metninde gelir. Kasada sorulmadan "Orta" bara
 * gitmesin diye ürün pencereyle eklenir
 */
export function needsChoice(boot: BootstrapDTO, p: ProductDTO): boolean {
  return productGroups(boot, p).some(isChoice);
}

/**
 * Ürün kartı ve boy düğmesi seçenek penceresini mi açar (hemen eklemek yerine): zorunlu seçim varsa, Yönetim › Ayarlar ›
 * Seçenekleri sor "Seçenekli her üründe" ise seçeneği olan her üründe. Yalnız isteğe bağlı seçeneği olan ürün, tek boylu
 * da, tek dokunuşla eklenir (sunucu varsayılanı yazar; 4 Kasım 2026, seçenek profili)
 */
export function asksOptions(boot: BootstrapDTO, p: ProductDTO): boolean {
  if (!productGroups(boot, p).length) return false;
  return boot.settings.askOptions === 'hep' || needsChoice(boot, p);
}

/**
 * Seçenek penceresinin ilk seçimi: isteğe bağlı tek seçimlik grupta varsayılan (Normal süt, Cam bardak). Zorunlu
 * grupta önseçim yok, kasiyer seçer (seçilene kadar Ekle kapalı)
 */
export function defaultPicks(groups: OptionGroupDTO[]): Record<string, number> {
  const picks: Record<string, number> = {};
  for (const g of groups) {
    if (g.kind !== 'single' || g.required) continue;
    const d = g.items.find((i) => i.isDefault);
    // Tükenen varsayılan seçili gelmez: kasiyer başkasını seçer (sunucu da almaz)
    if (d && !d.soldOut) picks[d.id] = 1;
  }
  return picks;
}

/**
 * Sepetteki satırı düzenlerken ilk seçim: satırın seçimleri olduğu gibi. Bu arada tükenen seçenek de seçili kalır
 * (`pickHint` uyarır, Güncelle kapalı, kasiyer bırakır ya da başkasını seçer); süzülse isteğe bağlı grup boş kalır,
 * sunucu varsayılanı yazardı (müşteri yulaf istemişti, normal süt giderdi). Pencere bunu `reconcilePicks`'ten geçirir:
 * grubu kapanan ya da kaldırılan seçenek ve isteğe bağlı grubun tükenen varsayılanı düşer
 */
export function editingPicks(options: { itemId: string; qty?: number }[]): Record<string, number> {
  return Object.fromEntries(options.map((o) => [o.itemId, o.qty ?? 1]));
}

/**
 * Seçimden ürünün açık gruplarında olmayan seçenekleri atar (grup kapandı, seçenek kaldırıldı): kalsa sunucu 400
 * `option_invalid` döner ve bütün bekleyen satırlar takılır. Tükenen seçenek açılış verisinde durur, korunur.
 * Atılacak bir şey yoksa aynı nesne döner
 */
export function knownPicks(groups: OptionGroupDTO[], picks: Record<string, number>): Record<string, number> {
  const known = new Set(groups.flatMap((g) => g.items.map((i) => i.id)));
  const ids = Object.keys(picks);
  return ids.every((id) => known.has(id)) ? picks : Object.fromEntries(ids.filter((id) => known.has(id)).map((id) => [id, picks[id]!]));
}

/**
 * Seçimi ürünün o anki gruplarıyla uzlaştırır (pencere açılırken ve açıkken grup kapanınca, açılınca, seçenek tükenince
 * ya da satışa açılınca; menü olayı): bilinmeyen seçenekler atılır (`knownPicks`), isteğe bağlı grubun tükenen
 * varsayılanı bırakılır (`lapsedDefault`: Normal süt bitti, Ekle açık, grup boş gider). Sonra seçimi kalmayan her
 * isteğe bağlı tek seçimlik grubun tükenmemiş varsayılanı seçili gelir (`defaultPicks`): yeni açılan grup, yeniden
 * satışa açılan varsayılan, seçili seçeneği gruptan kaldırılan grup. Sunucu boş gruba varsayılanı yazar; ücretli
 * varsayılan ekranda seçili görünmeden ücrete girmesin. Açıkça seçilen tükenen seçenek (Yulaf) kalır, `pickHint`
 * uyarır. Değişen bir şey yoksa aynı nesne döner
 */
export function reconcilePicks(groups: OptionGroupDTO[], picks: Record<string, number>): Record<string, number> {
  const known = knownPicks(groups, picks);
  const lapsed = new Set(groups.flatMap((g) => g.items.filter((i) => known[i.id] && lapsedDefault(g, i)).map((i) => i.id)));
  const kept = lapsed.size ? Object.fromEntries(Object.entries(known).filter(([id]) => !lapsed.has(id))) : known;
  const added = defaultPicks(groups.filter((g) => !g.items.some((i) => kept[i.id])));
  return Object.keys(added).length ? { ...kept, ...added } : kept;
}

/**
 * Tek seçimlik grup radyo düğmesi gibi davranır: dokunulan seçilir, gruptaki diğerleri kalkar. Seçiliyken tükenen
 * seçeneğe dokunmak onu bırakır: grup varsayılanına döner (`defaultPicks`; zorunlu grupta seçim bekler)
 */
export function pickSingle(g: OptionGroupDTO, picks: Record<string, number>, itemId: string): Record<string, number> {
  const next = { ...picks };
  for (const i of g.items) delete next[i.id];
  const drop = !!picks[itemId] && !!g.items.find((i) => i.id === itemId)?.soldOut;
  return { ...next, ...(drop ? defaultPicks([g]) : { [itemId]: 1 }) };
}

/**
 * Tükenen seçenek yüzünden seçim bekleyen grubun uyarısı; varken Ekle kapalı (sunucu 409 `option_sold_out` döner).
 * Açıkça seçilip seçiliyken tükenen (başka kasa işaretledi, ya da sepetteki satır düzenleniyor) her grupta bırakılır;
 * isteğe bağlı grupta bırakmak varsayılana döner. Zorunlu tek seçimlik grupta bir şey seçilmediyse sunucu varsayılanı
 * yazar: o tükendiyse başkası seçilir. İsteğe bağlı grubun tükenen varsayılanı, seçili olsa da, satışı durdurmaz
 * (`lapsedDefault`; sunucu o grup için seçenek yazmaz); onu yalnız `pickNote` söyler
 */
export function pickHint(g: OptionGroupDTO, picks: Record<string, number>): string | null {
  const gone = g.items.find((i) => i.soldOut && picks[i.id] && !lapsedDefault(g, i));
  if (gone) return `${gone.name} tükendi, ${g.kind !== 'single' ? 'kaldırın' : g.required ? 'başka birini seçin' : 'başka birini seçin ya da bırakın'}`;
  if (g.kind !== 'single' || !g.required || g.items.some((i) => picks[i.id])) return null;
  const d = g.items.find((i) => i.isDefault);
  if (d) return d.soldOut ? `${d.name} tükendi, başka birini seçin` : null;
  return g.items.some((i) => i.soldOut) ? 'Birini seçin' : null;
}

/**
 * İsteğe bağlı tek seçimlik grupta bir şey seçilmedi ve varsayılan kasada tükendi: bilgi notu ("Normal tükendi"),
 * Ekle açık kalır; sunucu o grup için seçenek yazmaz (su, espresso süt sormadan satılır)
 */
export function pickNote(g: OptionGroupDTO, picks: Record<string, number>): string | null {
  if (g.kind !== 'single' || g.required || g.items.some((i) => picks[i.id] && !lapsedDefault(g, i))) return null;
  const d = g.items.find((i) => i.isDefault);
  return d?.soldOut ? `${d.name} tükendi` : null;
}

/**
 * Gönderilmemiş satırı sunucu neden reddeder (sepette satırın altında kırmızı; dokununca düzenleme penceresi açılır):
 * açıkça seçilen seçenek tükendi ("Yulaf tükendi"), zorunlu grupta seçim yok ve varsayılanı tükendi ("Orta tükendi,
 * şeker seçin") ya da varsayılanı yok ("Şeker seçin"), ya da seçeneğinin grubu kapandı / seçenek kaldırıldı. Yoksa null.
 * Kurallar sunucunun `resolveOptions`'ıyla aynı; isteğe bağlı grubun tükenen varsayılanı sorun değil, gönderim onu
 * çıkarır (`sendableOptions`)
 */
export function pendingProblem(boot: BootstrapDTO, p: ProductDTO, options: { itemId: string; qty?: number }[]): string | null {
  const groups = productGroups(boot, p);
  const picks = editingPicks(options);
  for (const g of groups) {
    const gone = g.items.find((i) => i.soldOut && (picks[i.id] ?? 0) > 0 && !lapsedDefault(g, i));
    if (gone) return `${gone.name} tükendi`;
    if (!g.required || g.kind === 'counter' || g.items.some((i) => (picks[i.id] ?? 0) > 0)) continue;
    const d = g.kind === 'single' ? g.items.find((i) => i.isDefault) : undefined;
    if (!d) return `${g.name} seçin`;
    if (d.soldOut) return `${d.name} tükendi, ${g.name.toLocaleLowerCase('tr-TR')} seçin`;
  }
  return knownPicks(groups, picks) === picks ? null : 'Seçeneği kalktı, düzenleyin';
}

/** Seçim bekleyen ilk zorunlu grup: varken pencerede Ekle kapalı, altında "Şeker seçin" */
export function missingChoice(groups: OptionGroupDTO[], picks: Record<string, number>): OptionGroupDTO | undefined {
  return groups.find((g) => isChoice(g) && !g.items.some((i) => (picks[i.id] ?? 0) > 0));
}

export type { SelectedOption };
