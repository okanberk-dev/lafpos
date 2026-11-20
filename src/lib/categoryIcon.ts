import { CakeSlice, Citrus, Coffee, Cookie, Croissant, CupSoda, Droplet, Egg, GlassWater, IceCreamCone, Leaf, type LucideIcon, Mic, Pizza, Plus, Salad, Sandwich, Snowflake, Soup, UtensilsCrossed } from 'lucide-react';

/** Türkçe duyarsız anahtar: küçük harf, ı → i, aksanlar atılır ("Soğuk İçecekler" → "soguk icecekler") */
const fold = (s: string) =>
  s
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');

/**
 * Kategorinin ikonu (adisyonun kategori menüsü: yönetimin alt menüsüyle aynı satır, tek renk ikon). Ad anahtar kelimeyle
 * eşlenir; sıra önemli (önce "soğuk kahve", sonra "kahve"). Eşleşmeyen kategoride null: satır etiket ikonu çizer. Süs:
 * anlamı ad taşır
 */
const RULES: [string[], LucideIcon][] = [
  [['matcha'], Leaf],
  [['affogato', 'dondurma', 'gelato'], IceCreamCone],
  [['frozen', 'buzlu'], Snowflake],
  [['frappe', 'milkshake', 'soguk kahve', 'iced', 'mesrubat', 'gazoz', 'kola'], CupSoda],
  [['smoothie', 'meyve', 'limonata', 'fresh'], Citrus],
  [['soguk cay', 'soguk icecek', 'soda', 'maden'], GlassWater],
  [['espresso', 'kahve', 'sicak', 'cay', 'filtre', 'latte'], Coffee],
  [['tatli', 'pasta', 'kek', 'cheesecake', 'sebastian'], CakeSlice],
  [['kurabiye', 'cookie', 'kuru pasta'], Cookie],
  [['atistirmalik', 'sandvic', 'tost', 'wrap', 'bagel'], Sandwich],
  [['kruvasan', 'firin', 'pogaca', 'simit'], Croissant],
  [['kahvalti', 'yumurta'], Egg],
  [['salata', 'bowl'], Salad],
  [['pizza'], Pizza],
  [['corba'], Soup],
  [['yemek', 'ana yemek', 'mutfak'], UtensilsCrossed],
  [['karaoke', 'etkinlik', 'sahne', 'muzik'], Mic],
  [['ekstra', 'ilave', 'shot', 'surup'], Plus],
  [['su ', 'suyu'], Droplet],
];

export function categoryIcon(name: string): LucideIcon | null {
  const k = ` ${fold(name)} `;
  for (const [words, icon] of RULES) if (words.some((w) => k.includes(w.endsWith(' ') ? ` ${w}` : w))) return icon;
  return null;
}

