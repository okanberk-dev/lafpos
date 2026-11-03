import { cn } from '@/lib/cn';
import fincan from '@/assets/illustrations/ilke-fincan.svg';
import kapi from '@/assets/illustrations/ilke-kapi.svg';
import saat from '@/assets/illustrations/ilke-saat.svg';
import bilet from '@/assets/illustrations/kosk-ticket.svg';
import arama from '@/assets/illustrations/menu-arama.svg';
import kategori from '@/assets/illustrations/menu-kategori.svg';
import affogato from '@/assets/illustrations/rehber-affogato.svg';
import espresso from '@/assets/illustrations/rehber-espresso.svg';
import favori from '@/assets/illustrations/spot-favori.svg';
import kupon from '@/assets/illustrations/spot-kupon.svg';
import fis from '@/assets/illustrations/spot-siparis.svg';

/**
 * laffogato.net'in çizimleri (laffogato `public/illustrations/`, docs/BRAND.md §6.1): düz dolgu, 2 px espresso kontur,
 * altı renk, yazısız. Boş durumlarda simge kutusunun yerine durur; anlamı yanındaki başlık taşır (`alt=""`). Her çizim
 * ilk bakışta ne olduğunu söyler: boş sipariş listesi bir kafe fişi, sonuçsuz arama boş bir fincan tabağı, ürünü
 * kalmamış kategori boş bir kek standı.
 */
export const ILLUSTRATIONS = {
  fis,
  arama,
  kategori,
  fincan,
  espresso,
  saat,
  bilet,
  kupon,
  kapi,
  affogato,
  favori,
} as const;
export type IllustrationName = keyof typeof ILLUSTRATIONS;

/**
 * Çizim: koyu temada espresso kontur kaybolmasın diye porselen bir diskin üstünde (`--illustration-disk`, index.css:
 * bir ton kırık porselen, gece ekranının en parlak yüzeyi olmasın; kontur 10:1'in üstünde). Diskteki boşluk çizimin
 * boyuyla (%76) verilir, dolguyla değil: yüzdeli dolgu kabın değil üst öğenin genişliğine göre hesaplanır, geniş
 * kartta çizim sıfıra iner.
 */
export function Illustration({ name, className }: { name: IllustrationName; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('inline-grid shrink-0 place-items-center dark:rounded-full dark:bg-[var(--illustration-disk)]', className)}>
      <img src={ILLUSTRATIONS[name]} alt="" draggable={false} className="size-full object-contain dark:size-[76%]" />
    </span>
  );
}
