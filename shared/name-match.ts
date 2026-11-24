import { foldTr } from './search';

/**
 * LafPOS kullanıcısının adı ile lafmaliyet (ladmin) personel kaydının adı ne kadar benziyor: yalnız ipucu (Yönetim ›
 * Personel › ladmin personeli seçicisinde sıralama ve "Eminim" onayı). Hiçbir zaman kendiliğinden seçmez ya da bağlamaz
 * (sahip kararı 2). Türkçe katlanmış karşılaştırma: büyük-küçük harf, ı/i, ş/s, ç/c, ğ/g, ö/o, ü/u farkı sayılmaz.
 * LafPOS'taki ad çoğu zaman yalnız ilk addır ("Ayşe"), ladmin'deki tam ad ("Ayşe Yılmaz").
 */

export type NameMatch = 'yuksek' | 'orta' | 'dusuk';

/** Adın katlanmış sözcükleri (harf ve rakam dışı ayraç) */
export function nameTokens(name: string): string[] {
  return foldTr(name)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Sözcük ya da baş harfi ("Ayşe Y." → "y", "yilmaz") */
const tokenFits = (t: string, list: string[]) => list.some((u) => u === t || (t.length === 1 && u.startsWith(t)));

/**
 * 0-1 arası benzerlik. 1: aynı ad · 0,9: ilk ad ve öteki sözcükler (ya da baş harfleri) uyuyor · 0,8: ilk ad uyuyor,
 * adlardan biri yalnız ilk addan ibaret, çelişecek sözcük yok ("Ayşe" ↔ "Ayşe Yılmaz", "Ayşe Kara" ↔ "Ayşe") · 0,7: ilk
 * ad uyuyor ama öteki sözcük ya da baş harf ladmin adının kalanına uymuyor ("Ayşe Kara" ↔ "Ayşe Yılmaz": büyük olasılıkla
 * başka kişi, orta; "Eminim" istenir) ·
 * 0,6: başka bir sözcük uyuyor (soyad, ikinci ad) · 0,4'e kadar: yalnız harf benzerliği ("Ali" ↔ "Alican" aynı kişi
 * değildir)
 */
export function nameSimilarity(local: string, remote: string): number {
  const a = nameTokens(local);
  const b = nameTokens(remote);
  if (!a.length || !b.length) return 0;
  if (a.join(' ') === b.join(' ')) return 1;
  if (a[0] === b[0]) {
    const restA = a.slice(1);
    const restB = b.slice(1);
    if (!restA.length || !restB.length) return 0.8;
    return restA.every((t) => tokenFits(t, restB)) ? 0.9 : 0.7;
  }
  if (a.some((t) => t.length > 1 && b.includes(t))) return 0.6;
  return Math.min(0.4, 0.4 * dice(a[0]!, b[0]!));
}

/** Harf ikilisi benzerliği (Sørensen-Dice) */
function dice(x: string, y: string): number {
  const pairs = (s: string) => Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2));
  const px = pairs(x);
  const py = pairs(y);
  if (!px.length || !py.length) return x === y ? 1 : 0;
  const rest = [...py];
  let common = 0;
  for (const p of px) {
    const k = rest.indexOf(p);
    if (k >= 0) {
      common++;
      rest.splice(k, 1);
    }
  }
  return (2 * common) / (px.length + py.length);
}

/** Benzerliğin düzeyi: yüksek ≥ 0,8 (ilk ad uyuyor, öteki sözcük çelişmiyor), orta ≥ 0,5, altı düşük */
export function nameMatch(local: string, remote: string): NameMatch {
  const s = nameSimilarity(local, remote);
  return s >= 0.8 ? 'yuksek' : s >= 0.5 ? 'orta' : 'dusuk';
}
