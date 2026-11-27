import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { flushOutbox, retryWrongBranch } from './lafmaliyet';
import { resetStaffCache } from './lafmaliyet-personel';
import { platformKeysBranchChanged } from './platform-anahtar';

/**
 * Kasanın şubesi değişti ya da ilk kez belli oldu (Yönetim › Ayarlar ve yedek › Şube kimliği, ladmin kurulumu;
 * docs/03-ENTEGRASYON.md §4c). Eski şubenin önbellekleri bırakılır: lafmaliyet devri (başka şubenin çekmecesi) ve
 * personel listesi. Şube retiyle (409 `wrong_branch`) bekleyen günler günlük denemeyi beklemeden, şubesizken biriken günler
 * hemen gönderilir; platform anahtarları yeni şube için çekilir. Hiçbiri beklenmez, hata kaydı bozmaz
 */
export function subeDegisti(onceki: string | null): void {
  try {
    db.delete(schema.syncState).where(eq(schema.syncState.key, 'lafmaliyet.devir')).run();
    resetStaffCache();
    const retried = retryWrongBranch();
    if (retried || onceki === null) void flushOutbox();
  } catch (e) {
    console.warn('[şube] eski şubenin önbelleği bırakılamadı:', e instanceof Error ? e.message : e);
  }
  void platformKeysBranchChanged();
}
