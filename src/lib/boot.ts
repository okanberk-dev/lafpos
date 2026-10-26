import { useQuery } from '@tanstack/react-query';
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

export function sizePrice(p: ProductDTO, size: Size): number {
  return size === 'L' && p.priceL != null ? p.priceL : p.price;
}

/** Gönderilmemiş kalemin tahmini birim fiyatı (sunucu happy hour'u da uygular; kesin fiyat gönderince gelir) */
export function estimateUnit(boot: BootstrapDTO, p: ProductDTO, size: Size, picks: { itemId: string; qty?: number }[]): number {
  let unit = sizePrice(p, size);
  for (const g of productGroups(boot, p)) {
    for (const pick of picks) {
      const item = g.items.find((i) => i.id === pick.itemId);
      if (item) unit += item.price * (g.kind === 'counter' ? (pick.qty ?? 1) : 1);
    }
  }
  return unit;
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

export type { SelectedOption };
