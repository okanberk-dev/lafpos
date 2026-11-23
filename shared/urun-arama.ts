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
  // Yabancı adın Türkçe yazılışı (inceleme, 23 Kas 2026: "kapuçino" ve "moka" hiçbir şey bulmuyordu; yazım hatası
  // toleransı bu kadar uzak yazılışı yakalamaz)
  kapucino: 'cappuccino', moka: 'mocha', makyato: 'macchiato', cizkek: 'cheesecake', smuti: 'smoothie', milkseyk: 'milkshake',
  kruvasan: 'croissant', vafil: 'waffle',
};
const PAIRS = Object.entries(TR_EN);
/**
 * Kanonik adın değişimleri: uzun karşılık önce ("beyaz cikolata" "cikolata"dan önce), ifadeler bir kez derlenir (inceleme,
 * 23 Kas 2026: her çağrıda sözlük sıralanıp ifadeler yeniden derleniyordu; arama her harfte bütün eşleşenlere bakar)
 */
const CANONICAL: [RegExp, string][] = [...PAIRS].sort((a, b) => b[0].length - a[0].length).map(([tr, en]) => [new RegExp(`\\b${tr}\\b`, 'g'), en]);
/** Bir ürün adını karşılık sözlüğüyle tek biçime (İngilizce) çevirir: "Çilek Smoothie" ve "STRAWBERRY SMOOTHIE" aynı çıkar */
export function canonicalName(name: string): string {
  let n = fold(name).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // `replace` genel ifadenin konumunu her çağrıda sıfırlar: paylaşılan ifade güvenli
  for (const [re, en] of CANONICAL) n = n.replace(re, en);
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
  for (const [tr, en] of PAIRS) {
    if (k.includes(tr)) out.add(k.replace(tr, en));
    if (k.includes(en)) out.add(k.replace(en, tr));
  }
  return [...out];
}

/**
 * Aynı ürünün iki kopyası (yerel ad ve site adı) tek sonuç olur: kanonik adı aynı yerel ve site ürünü çiftinde yerel olan
 * kalır. Yalnız böyle bir çift birleşir; iki yerel ya da iki site ürünü hiç birleşmez, her site ürünü en çok bir yerelle
 * eşleşir (inceleme, 23 Kas 2026: kanonik adı aynı her ürün birleşiyordu; başka kategorideki, başka fiyatlı ikinci
 * "Limonata", "Çay" ile "Tea" ya da "Su" ile "Water" aramada hiç bulunmuyordu)
 */
export function dedupe<T extends SearchItem>(list: T[]): T[] {
  const twins = twinsOf(list);
  return list.filter((p) => !twins.has(p.id));
}

/** Yerel ikizi olan site ürünü → o yerel ürün (sırayla, her yerel en çok bir site ürünüyle; `dedupe` bunları gizler) */
function twinsOf<T extends SearchItem>(list: T[]): Map<string, T> {
  const locals = new Map<string, T[]>();
  for (const p of list) {
    if (p.site) continue;
    const key = canonicalName(p.name);
    const same = locals.get(key);
    if (same) same.push(p);
    else locals.set(key, [p]);
  }
  const twins = new Map<string, T>();
  for (const p of list) {
    const local = p.site ? locals.get(canonicalName(p.name))?.shift() : undefined;
    if (local) twins.set(p.id, local);
  }
  return twins;
}

/** Baş harf: yabancı adın c'si Türkçede k yazılır (kola, kafe, kortado); ikisi aynı sayılır */
const initial = (s: string) => (s[0] === 'k' ? 'c' : s[0]);

/**
 * Sorgu sözcüğü ürün adındaki bir sözcüğün başına yakın mı (yazım hatası): dört-beş harfte bir, altı ve üstünde iki harf
 * fark olabilir, baş harf aynı kalmalı; üç harfli sözcük yalnız aynen eşleşir (inceleme, 23 Kas 2026: "kek" granola ve
 * kakao barını, "süt" suyu, sürpriz içeceği ve şurubu, "muzlu" tuzlu ve buzlu içecekleri öneriyordu)
 */
function near(w: string, t: string): boolean {
  const max = w.length >= 6 ? 2 : w.length >= 4 ? 1 : 0;
  if (max > 0 && initial(w) !== initial(t)) return false;
  return distance(w, t.slice(0, w.length), max) <= max;
}

/** Kesin eşleşmeler (ad, kısa ad, barkod, karşılıklar) ve yetmezse benzerler (yazım hatası) */
export function searchProducts<T extends SearchItem>(items: T[], q: string, limit = 60): { exact: T[]; similar: T[] } {
  const vs = variants(q);
  if (!vs[0]) return { exact: [], similar: [] };
  // İkizler bütün menüde eşlenir: eşleşen site kopyası yerine yerel ikizi gösterilir, ürün kesin sonuçlar ve benzerler
  // boyunca bir kez çıkar (inceleme, 23 Kas 2026: tekilleştirme iki listede ayrı yapılıyordu; "çilek smoothie" ya da
  // yazarken "kara" ve "cara" bir ikizi sonuçta, ötekini "Benzer ürünler"de gösteriyordu, "kara"da görünen site kopyasıydı)
  const twins = twinsOf(items);
  const shown = new Set<string>();
  const once = (list: T[]) =>
    list
      .map((p) => twins.get(p.id) ?? p)
      .filter((p) => {
        if (shown.has(p.id)) return false;
        shown.add(p.id);
        return true;
      });
  const exact = once(items.filter((p) => vs.some((v) => hay(p).includes(v)))).slice(0, limit);
  if (exact.length >= 3) return { exact, similar: [] };
  const words = vs[0].split(' ').filter((w) => w.length >= 3);
  const similar = once(
    items.filter((p) => {
      const tokens = hay(p).split(/[^a-z0-9]+/).filter(Boolean);
      return words.length > 0 && words.every((w) => tokens.some((t) => near(w, t)));
    }),
  ).slice(0, 8);
  return { exact, similar };
}
