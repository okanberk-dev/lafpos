import { useQuery } from '@tanstack/react-query';
import { happyHourPercentAt, happyHourUnit } from '@shared/order-calc';
import type { BootstrapDTO, OptionGroupDTO, ProductDTO, SelectedOption, Size } from '@shared/types';
import { get } from './api';

/** Açılış verisi: menü, masa planı, ödeme türleri, ayarlar. Menü/ayar olaylarında yenilenir. */
export function useBootQuery() {
  return useQuery({ queryKey: ['bootstrap'], queryFn: () => get<BootstrapDTO>('/bootstrap'), staleTime: 5 * 60_000 });
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
 * Hızlı eklemede (seçeneksiz) sunucu tek seçimlik grupların varsayılanını yazar; varsayılanı kasada tükenen üründe
 * seçenek penceresi açılır (sunucu 409 `option_sold_out` döner)
 */
export function soldOutDefault(boot: BootstrapDTO, p: ProductDTO): boolean {
  return productGroups(boot, p).some((g) => g.kind === 'single' && g.items.some((i) => i.isDefault && i.soldOut));
}

export function sizePrice(p: ProductDTO, size: Size): number {
  return size === 'L' && p.priceL != null ? p.priceL : p.price;
}

/** Menü birim fiyatı: boy ve seçenek farkları dahil, happy hour öncesi (elle fiyatın karşılaştırıldığı tutar) */
export function menuUnit(boot: BootstrapDTO, p: ProductDTO, size: Size, picks: { itemId: string; qty?: number }[]): number {
  let unit = sizePrice(p, size);
  for (const g of productGroups(boot, p)) {
    for (const pick of picks) {
      const item = g.items.find((i) => i.id === pick.itemId);
      if (item) unit += item.price * (g.kind === 'counter' ? (pick.qty ?? 1) : 1);
    }
  }
  return unit;
}

/**
 * Gönderilmemiş kalemin tahmini birim fiyatı: menü fiyatına şu an geçerli happy hour, sunucunun kalemi eklerken
 * yaptığı hesapla uygulanır (kesin fiyat gönderince gelir; saat sınırında cihaz saati farkı olabilir)
 */
export function estimateUnit(boot: BootstrapDTO, p: ProductDTO, size: Size, picks: { itemId: string; qty?: number }[], nowMs = Date.now()): number {
  return happyHourUnit(menuUnit(boot, p, size, picks), happyHourPercentAt(boot.happyHours, p, nowMs));
}

/** Gönderilmemiş kalemin seçenek metni (sunucunun `optionsText` kuralıyla aynı) */
export function pendingOptionsText(boot: BootstrapDTO, p: ProductDTO, picks: { itemId: string; qty?: number }[]): string {
  const parts: string[] = [];
  for (const g of productGroups(boot, p)) {
    for (const pick of picks) {
      const item = g.items.find((i) => i.id === pick.itemId);
      if (!item) continue;
      const qty = pick.qty ?? 1;
      if (item.isDefault && item.price === 0 && !g.required) continue;
      if (g.extKey === 'extraShot') parts.push(qty > 1 ? `+${qty} shot` : '+1 shot');
      else if (g.extKey === 'sugar') {
        if (qty > 0) parts.push(`${qty} şeker`);
      } else if (g.extKey === 'roast') parts.push(`${item.name} kavrum`);
      else parts.push(item.name);
    }
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
 * İki boylu ürünün kartı ve boy düğmesi seçenek penceresini o boy seçili mi açar (hemen eklemek yerine): zorunlu seçim
 * varsa, Yönetim › Ayarlar › Seçenekleri sor "Seçenekli her üründe" ise seçeneği olan her üründe. Tek boylu seçenekli
 * ürün zaten hep pencereyle eklenir
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
 * sunucu varsayılanı yazardı (müşteri yulaf istemişti, normal süt giderdi)
 */
export function editingPicks(options: { itemId: string; qty?: number }[]): Record<string, number> {
  return Object.fromEntries(options.map((o) => [o.itemId, o.qty ?? 1]));
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
 * Tek seçimlik grupta bir şey seçilmediyse sunucu varsayılanı yazar: o tükendiyse başkası seçilir. Seçiliyken
 * tükenen (başka kasa işaretledi, ya da sepetteki satır düzenleniyor) kaldırılır
 */
export function pickHint(g: OptionGroupDTO, picks: Record<string, number>): string | null {
  const gone = g.items.find((i) => i.soldOut && picks[i.id]);
  if (gone) return `${gone.name} tükendi, ${g.kind === 'single' ? 'başka birini seçin' : 'kaldırın'}`;
  if (g.kind !== 'single' || g.items.some((i) => picks[i.id])) return null;
  const d = g.items.find((i) => i.isDefault);
  if (d) return d.soldOut ? `${d.name} tükendi, başka birini seçin` : null;
  return g.required && g.items.some((i) => i.soldOut) ? 'Birini seçin' : null;
}

/** Seçim bekleyen ilk zorunlu grup: varken pencerede Ekle kapalı, altında "Şeker seçin" */
export function missingChoice(groups: OptionGroupDTO[], picks: Record<string, number>): OptionGroupDTO | undefined {
  return groups.find((g) => isChoice(g) && !g.items.some((i) => (picks[i.id] ?? 0) > 0));
}

export type { SelectedOption };
