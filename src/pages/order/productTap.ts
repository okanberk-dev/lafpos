import type { BootstrapDTO, ProductDTO, Size } from '@shared/types';
import { asksOptions } from '../../lib/boot';

/**
 * Ürüne dokununca ne olur: kart, boy düğmesi ve en çok satanlar şeridi aynı kuralla ekler (inceleme, 23 Kas 2026: şerit
 * her ürünü orta boyla ve yalnız seçenek grubu sayısına bakarak ekliyordu; tek boylu ürün şeritten ve karttan eklenince
 * sepette iki ayrı satır oluyor, fiyatı 0 olan açık ürün fiyat sorulmadan ₺0 ekleniyordu).
 *
 * `ask`: hemen eklenmez, seçenek penceresi o boy seçili açılır. Zorunlu seçim (Türk kahvesinde şeker) varsa ya da ayar
 * "Seçenekli her üründe" ise sorulur; yalnız isteğe bağlı seçeneği olan ürün (tek boylu da) tek dokunuşla eklenir, sunucu
 * varsayılanı yazar (Normal süt), değişiklik kartın köşesindeki seçenek düğmesinden. Fiyatı 0 olan açık ürün (etkinlik
 * ücreti, özel pasta) fiyat girilsin diye hep pencereyle. `size`: dokunuşun boyu, iki boyluda orta, tek boyluda TEK
 */
export function productTap(boot: BootstrapDTO, p: ProductDTO): { twoSizes: boolean; ask: boolean; size: Size } {
  const twoSizes = p.priceL != null;
  return { twoSizes, ask: asksOptions(boot, p) || (!twoSizes && p.price <= 0), size: twoSizes ? 'M' : 'TEK' };
}
