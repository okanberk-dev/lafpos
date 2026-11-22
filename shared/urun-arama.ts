/**
 * Ürün arama (sahip, 22 Kas 2026): Türkçe karakter ve büyük/küçük harf duyarsız, yazım hatasına toleranslı, kısa ad ve
 * Türkçe ↔ İngilizce karşılıkları da arar; sonuç az ya da yoksa "benzer ürünler" önerir. Saf işlev (kasa ekranı ve test).
 * Menüdeki yerel ↔ site ikizleri (ör. "STRAWBERRY SMOOTHIE" ile "Çilek") aramada tek sonuç olur; veri silinmez.
 */
export function fold(s: string): string {
  return s
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Türkçe karşılık → İngilizce menü adı (fold'lu); iki yönde de aranır */
const TR_EN: Record<string, string> = {
  cilek: 'strawberry', muz: 'banana', elma: 'apple', mango: 'mango', frambuaz: 'raspberry', bogurtlen: 'blackberry',
  'yaban mersini': 'blueberry', 'orman meyveleri': 'mixed berry', ananas: 'pineapple', seftali: 'peach', limon: 'lemon',
  limonata: 'lemonade', cikolata: 'chocolate', 'beyaz cikolata': 'white chocolate', sicak: 'hot', soguk: 'iced', kahve: 'coffee',
  sut: 'milk', cay: 'tea', 'turk kahvesi': 'turkish coffee', fistik: 'pistachio', fistikli: 'pistachio', nane: 'mint', su: 'water',
  tatli: 'dessert', kurabiye: 'cookie', karamel: 'caramel', vanilya: 'vanilla', bal: 'honey', tarcin: 'cinnamon',
};
/** Bir ürün adını karşılık sözlüğüyle tek biçime (İngilizce) çevirir: "Çilek Smoothie" ve "STRAWBERRY SMOOTHIE" aynı çıkar */
export function canonicalName(name: string): string {
  let n = fold(name).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [tr, en] of Object.entries(TR_EN).sort((a, b) => b[0].length - a[0].length)) n = n.replace(new RegExp(`\\b${tr}\\b`, 'g'), en);
  return n;
}

/** Aralarındaki düzenleme uzaklığı (en çok `max`; aşarsa max+1): yazım hatası toleransı */
export function distance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

export interface SearchItem {
  id: string;
  name: string;
  shortName?: string | null;
  barcode?: string | null;
  /** Siteden gelen ürün (yerel ikizi varsa aramada tek sonuç: yerel olan) */
  site?: boolean;
}

const hay = (p: SearchItem) => fold(`${p.name} ${p.shortName ?? ''} ${p.barcode ?? ''}`);

function variants(q: string): string[] {
  const k = fold(q.trim());
  const out = new Set([k]);
  for (const [tr, en] of Object.entries(TR_EN)) {
    if (k.includes(tr)) out.add(k.replace(tr, en));
    if (k.includes(en)) out.add(k.replace(en, tr));
  }
  return [...out];
}

/** Aynı ürünün iki kopyası (yerel ad ve site adı) tek sonuç olur: kanonik ad aynıysa yerel olan kalır */
export function dedupe<T extends SearchItem>(list: T[]): T[] {
  const seen = new Map<string, T>();
  for (const p of list) {
    const key = canonicalName(p.name);
    const cur = seen.get(key);
    if (!cur || (cur.site && !p.site)) seen.set(key, p);
  }
  const keep = new Set([...seen.values()].map((p) => p.id));
  return list.filter((p) => keep.has(p.id));
}

/** Kesin eşleşmeler (ad, kısa ad, barkod, karşılıklar) ve yetmezse benzerler (yazım hatası) */
export function searchProducts<T extends SearchItem>(items: T[], q: string, limit = 60): { exact: T[]; similar: T[] } {
  const vs = variants(q);
  if (!vs[0]) return { exact: [], similar: [] };
  const exact = dedupe(items.filter((p) => vs.some((v) => hay(p).includes(v)))).slice(0, limit);
  if (exact.length >= 3) return { exact, similar: [] };
  const taken = new Set(exact.map((p) => p.id));
  const words = vs[0].split(' ').filter((w) => w.length >= 3);
  const similar = dedupe(
    items.filter((p) => {
      if (taken.has(p.id)) return false;
      const tokens = hay(p).split(/[^a-z0-9]+/).filter(Boolean);
      return words.length > 0 && words.every((w) => tokens.some((t) => distance(w, t.slice(0, Math.max(w.length, 3)), w.length >= 6 ? 2 : 1) <= (w.length >= 6 ? 2 : 1)));
    }),
  ).slice(0, 8);
  return { exact, similar };
}
