/**
 * index.html'in ana betiği: ilk `<script type="module" src>` (Vite derlemesinde `/assets/index-<özet>.js`, dosya adı
 * derlemenin özetini taşır; geliştirme sunucusunda `/@vite/client`). Satır içi modül (src'siz) sayılmaz. Arayüz sayfanın
 * eski olup olmadığını buna bakarak anlar (src/lib/buildWatch.ts); yoksa null
 */
export const anaBetik = (html: string): string | null => /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1] ?? null;
