/**
 * index.html'in ana betiği: ilk `<script type="module" src>` (Vite derlemesinde `/assets/index-<özet>.js`, dosya adı
 * derlemenin özetini taşır; geliştirme sunucusunda `/@vite/client`). Satır içi modül (src'siz) sayılmaz. Arayüz sayfanın
 * eski olup olmadığını buna bakarak anlar (src/lib/buildWatch.ts); yoksa null
 */
export const anaBetik = (html: string): string | null => /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1] ?? null;

/**
 * Sayfa eski derlemeden mi (src/lib/buildWatch.ts): sunucunun şu an verdiği index.html'in (`html`) ana betiği sayfanın
 * yüklediği modül betiklerinde (`own`, yolları) yoksa onun yolu (sayfa eski, yenilenmeli); varsa ya da anlaşılamazsa
 * null. `base`: sayfanın adresi (göreli betik yolu için)
 */
export function yeniAnaBetik(own: readonly string[], html: string, base: string): string | null {
  if (!own.length) return null;
  const latest = anaBetik(html);
  if (!latest) return null;
  const path = new URL(latest, base).pathname;
  return own.includes(path) ? null : path;
}

/**
 * Eski sayfada ne yapılır. `yeni`: `yeniAnaBetik`; `denenen`: bu sekmede daha önce eski bulunup yenilenen sayfanın hedef
 * betiği (oturum deposu). 'guncel': sayfa güncel, iz silinir; 'yenile': bir kez yenilenir, hedef yazılır; 'dur': aynı
 * hedef için zaten yenilendi ama sayfa hâlâ eski (ara bir önbellek eski sayfayı vermeyi sürdürüyor): döngüye girilmez
 */
export function eskiSayfaKarari(yeni: string | null, denenen: string | null): 'guncel' | 'yenile' | 'dur' {
  if (!yeni) return 'guncel';
  return denenen === yeni ? 'dur' : 'yenile';
}
