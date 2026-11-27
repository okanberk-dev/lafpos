import { and, eq, isNotNull } from 'drizzle-orm';
import { SUBE_YOK_METNI, subeAdiOf } from '@shared/sube';
import { db, schema, tx } from '../db/client';
import { Effects } from './effects';
import { conflict } from './http';
import { getSettings, getSyncState, setSyncState, updateSettings } from './settings';

/**
 * Kasanın şubesi (docs/03-ENTEGRASYON.md §4c "Çok şubeli kasa"). Yeni kurulum şubesiz açılır: şubeyi ladmin'in kurulum
 * bağlantısı verir (server/sync/kurulum-kodu.ts) ya da patron Yönetim › Ayarlar ve yedek › Şube kimliği'ne yazar. Şube
 * belli olana dek şubeye bağlı senkron (lafmaliyet gün sonu, devir, personel, ModPOS dönemi, bağlantı dağıtımı, site,
 * platform anahtarları) istek göndermez, hata döngüsüne de girmez: ekranlar `SUBE_YOK_METNI`'ni gösterir.
 *
 * 26 Kasım 2026'ya kadar her kurulum `marina` varsayılanıyla açılırdı ve kimlik ayar satırı olarak yazılmazdı. Geçmişi
 * olan eski kasa çok şubeli sürümdeki ilk açılışında `marina`'yı kalıcı yazar (`eskiKasaSubesiniYaz`, veritabanı başına
 * bir kez): Marina'nın kasası olduğu gibi çalışır.
 */

/** Eski kasaların varsayılan şubesi: ilk AsilPOS kasası Marina'da (sahibin kararı, 21 Kasım 2026) */
export const ESKI_VARSAYILAN_SUBE = 'marina';

/** Bu kasanın şube kimliği; seçilmediyse null (yeni kurulum, kurulum bağlantısından önce) */
export function kasaSubesi(): string | null {
  const b = getSettings().branchId;
  return typeof b === 'string' && b ? b : null;
}

/** Şubeye bağlı elle işlem (Gönder, Geçmiş günleri gönder, personel listesi, ModPOS dönemi) şube yokken 409 `no_branch` */
export function subeGerekli(): string {
  const b = kasaSubesi();
  if (!b) throw conflict(SUBE_YOK_METNI, 'no_branch');
  return b;
}

/**
 * Şubenin okunur adı: ladmin kurulumunun verdiği ad (aynı kimlikse), yoksa kimlikten ('marina' → 'Marina'); şube yoksa
 * null. Bildirim başlığı ve gün sonu metni bununla ayrışır (iki şubenin kasası aynı patrona yazar)
 */
export function subeAdi(): string | null {
  const id = kasaSubesi();
  if (!id) return null;
  // kurulum-kodu.ts'in kaydı (döngüsel içe aktarma olmasın diye anahtardan okunur)
  const kurulum = getSyncState<{ sube?: { id?: string; ad?: string } | null }>('kurulum.sube')?.sube;
  return kurulum?.id === id && kurulum.ad ? kurulum.ad : subeAdiOf(id);
}

/**
 * Kasanın geçmişi var mı: iş günü (eğitim günü dahil), lafmaliyet'in kabul ettiği gün sonu ya da gerçek kullanım işareti.
 * Böyle bir kasa 26 Kasım 2026'dan önce `marina` varsayılanıyla çalışıyordu
 */
export function kasaGecmisiVar(): boolean {
  if (getSettings().liveSince != null) return true;
  const push = getSyncState<{ acceptedBranch?: string; lastSuccessAt?: number }>('lafmaliyet.push');
  if (push?.acceptedBranch || push?.lastSuccessAt) return true;
  if (db.select({ id: schema.businessDays.id }).from(schema.businessDays).limit(1).get()) return true;
  return !!db
    .select({ id: schema.outbox.id })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'lafmaliyet'), eq(schema.outbox.kind, 'pos.gun'), isNotNull(schema.outbox.sentAt)))
    .limit(1)
    .get();
}

/**
 * Eski kasa denetiminin yapıldığı işareti (`sync_state`): `{ at, yazildi }`. Çok şubeli sürümün her veritabanındaki ilk
 * açılışta yazılır; varsa denetim bir daha yapılmaz. Yedeğin şubesi de buna bakar (`server/sync/yedek.ts` `yedekSubesi`)
 */
export const ESKI_KASA_DENETIMI = 'sube.eskiKasaDenetimi';

/**
 * Açılışta (göçlerden sonra), veritabanı başına bir kez: şube kimliği satırı yoksa ama kasanın geçmişi varsa eski varsayılan
 * `marina` kalıcı yazılır ve denetime düşer. Kimlik satırı varsa ya da kasa yeniyse (geçmiş yok) dokunulmaz. Sonuç ne
 * olursa olsun işaret (`ESKI_KASA_DENETIMI`) aynı işlemde yazılır: denetim yalnız çok şubeli sürümden önceki veritabanına
 * (yükseltilen kasa ya da geri yüklenen eski yedek) bir kez yapılır. Yeni kasa ilk açılışta (veritabanı boşken) işaretlenir;
 * sonra açtığı deneme günü ya da gerçek kullanımı onu Marina yapmaz, şubesi ladmin kurulumundan ya da Ayarlar'dan gelir.
 * Yazdıysa true
 */
export function eskiKasaSubesiniYaz(now = Date.now()): boolean {
  if (getSyncState(ESKI_KASA_DENETIMI) != null) return false;
  const row = db.select({ key: schema.settings.key }).from(schema.settings).where(eq(schema.settings.key, 'branchId')).get();
  const yaz = !row && kasaGecmisiVar();
  const fx = new Effects();
  tx((t) => {
    if (yaz) {
      updateSettings({ branchId: ESKI_VARSAYILAN_SUBE }, t);
      fx.audit(t, {
        action: 'settings.branchId',
        entity: 'settings',
        entityId: 'branchId',
        message: `Şube kimliği eski varsayılandan kalıcı yazıldı: ${ESKI_VARSAYILAN_SUBE} (bu kasa çok şubeli sürümden önce kuruldu)`,
        data: { from: null, to: ESKI_VARSAYILAN_SUBE, eskiVarsayilan: true },
      });
      fx.emit({ topic: 'settings', kind: 'settings.updated' });
    }
    setSyncState(ESKI_KASA_DENETIMI, { at: now, yazildi: yaz });
  });
  fx.flush();
  return yaz;
}
