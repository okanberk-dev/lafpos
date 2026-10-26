import type { KitchenTicket, Size } from './types';

export interface KitchenTotal {
  key: string;
  name: string;
  size: Size;
  qty: number;
  waiting: number;
  making: number;
  /** Seçeneklerin dökümü ("Yulaf sütü" 2, "+1 shot" 1); seçeneksiz olanlar sayılmaz */
  options: { text: string; qty: number }[];
}

/**
 * Bar ekranının "Toplam" görünümü: açık fişlerdeki (bekleyen ve hazırlanan) kalemler ürün ve boya göre toplanır,
 * seçenekler alt sayım olarak. Yoğunlukta barista "6 latte, 2'si yulaflı" görüp topluca hazırlar.
 */
export function kitchenTotals(tickets: KitchenTicket[]): KitchenTotal[] {
  const map = new Map<string, KitchenTotal>();
  for (const t of tickets) {
    for (const i of t.items) {
      if (i.voided || (i.status !== 'yeni' && i.status !== 'hazirlaniyor')) continue;
      const key = `${i.name}|${i.size}`;
      const row = map.get(key) ?? { key, name: i.name, size: i.size, qty: 0, waiting: 0, making: 0, options: [] };
      row.qty += i.qty;
      if (i.status === 'yeni') row.waiting += i.qty;
      else row.making += i.qty;
      for (const text of i.optionsText ? i.optionsText.split(' · ') : []) {
        const o = row.options.find((x) => x.text === text);
        if (o) o.qty += i.qty;
        else row.options.push({ text, qty: i.qty });
      }
      map.set(key, row);
    }
  }
  return [...map.values()]
    .map((r) => ({ ...r, options: r.options.sort((a, b) => b.qty - a.qty || a.text.localeCompare(b.text, 'tr')) }))
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'tr'));
}
