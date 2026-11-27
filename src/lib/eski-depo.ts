import { ESKI_DEPO_ONEKI } from '@shared/eski-adlar';

/** Tarayıcı deposu anahtarlarının öneki (oturum, sepet, tercihler, taslaklar) */
export const DEPO_ONEKI = 'asilpos.';
/** Taşımanın bu depoda yapıldığı işareti: taşıma her depoda bir kez */
export const TASINDI_ISARETI = `${DEPO_ONEKI}eski-depo-tasindi`;

/**
 * Ad değişikliği (26 Kasım 2026): eski önekli localStorage ve sessionStorage anahtarlarını yeni öneke kopyalar; yeni
 * anahtar zaten varsa dokunmaz. Her depoda bir kez (ilk açılışta): sonra işaret (`TASINDI_ISARETI`) durur ve bir daha
 * kopyalanmaz. Yoksa uygulamanın sildiği anahtar (çıkışta oturum, gösterilen "yeni sürüm kuruldu" işareti, seçilen
 * dükkân) her açılışta eski kopyadan geri gelirdi. Eskiler silinmez: eski sürüme dönülürse sayfa oturumu, sepeti ve
 * tercihleri yine bulur (sonraki bir sürümde silinir). Depoyu okuyan modüllerden (zustand sepeti, oturum, tema) önce
 * çalışmalı: src/main.tsx bunu ilk içe aktarır. Depo yoksa ya da yazılamıyorsa sessizce geçer. Kopyalanan anahtar
 * sayısını döner
 */
export function eskiDepoyuTasi(depolar: (Storage | undefined)[] = depolarOf()): number {
  let n = 0;
  for (const depo of depolar) {
    if (!depo) continue;
    try {
      if (depo.getItem(TASINDI_ISARETI) !== null) continue;
      const eskiler: string[] = [];
      for (let i = 0; i < depo.length; i++) {
        const k = depo.key(i);
        if (k?.startsWith(ESKI_DEPO_ONEKI)) eskiler.push(k);
      }
      for (const k of eskiler) {
        const yeni = DEPO_ONEKI + k.slice(ESKI_DEPO_ONEKI.length);
        if (depo.getItem(yeni) !== null) continue;
        const v = depo.getItem(k);
        if (v === null) continue;
        depo.setItem(yeni, v);
        n++;
      }
      depo.setItem(TASINDI_ISARETI, '1');
    } catch {
      /* depo kapalı (gizli pencere) ya da dolu: eski anahtarlar yerinde kalır */
    }
  }
  return n;
}

function depolarOf(): (Storage | undefined)[] {
  const out: (Storage | undefined)[] = [];
  for (const ad of ['localStorage', 'sessionStorage'] as const) {
    try {
      out.push((globalThis as { localStorage?: Storage; sessionStorage?: Storage })[ad]);
    } catch {
      out.push(undefined);
    }
  }
  return out;
}

eskiDepoyuTasi();
