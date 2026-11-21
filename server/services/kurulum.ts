import { isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { DEMO_USERS } from '../db/seed';
import { hashPin } from '../lib/auth';
import { getSettings, getSyncState, setSyncState } from '../lib/settings';
import { pavoProvider } from '../okc/providers/pavo';

/**
 * Karşılama sihirbazı (Yönetim › Genel bakış): yeni kurulumun adımları ve her birinin durumu, veritabanından. Kart
 * bütün adımlar bitince ya da patron "Gizle" deyince kaybolur. Adım tamamlanmış sayılır:
 * - menü: siteden gelmiş en az bir ürün; masa: en az bir masa (oda hariç); personel: örnek PIN'le açık hesap kalmadı
 *   ve patrondan başka biri var; fiş: en az bir hesap yazdırıldı; Pavo: yazarkasa Pavo ve eşleşti (yazarkasa
 *   kullanılmıyorsa "Kapalı" seçilince geçilir); deneme satışı: kapanmış bir adisyon; gerçek kullanım: deneme bitti
 */
export interface SetupStep {
  key: 'menu' | 'masa' | 'personel' | 'fis' | 'pavo' | 'deneme' | 'gercek';
  title: string;
  detail: string;
  done: boolean;
  to: string;
}

export function setupSteps(): { steps: SetupStep[]; hidden: boolean } {
  const s = getSettings();
  const fromSite = db.select({ id: schema.products.id }).from(schema.products).where(isNotNull(schema.products.extId)).all().length;
  const tables = db.select({ kind: schema.tables.kind }).from(schema.tables).all().filter((t) => t.kind !== 'oda').length;
  const users = db.select({ pinHash: schema.users.pinHash, active: schema.users.active, role: schema.users.role }).from(schema.users).all().filter((u) => u.active);
  const sample = new Set(DEMO_USERS.map((u) => hashPin(u.pin)));
  const withSample = users.filter((u) => sample.has(u.pinHash)).length;
  const printed = db.select({ id: schema.orders.id }).from(schema.orders).where(isNotNull(schema.orders.billPrintedAt)).limit(1).all().length > 0;
  const sales = db.select({ status: schema.orders.status, source: schema.orders.source }).from(schema.orders).all().some((o) => o.status === 'kapali' && o.source === 'pos');
  const pavoPaired = s.okcProvider === 'pavo' && (pavoProvider.status() as { paired?: boolean }).paired === true;
  const steps: SetupStep[] = [
    { key: 'menu', title: 'Menü siteden geldi', detail: fromSite ? `${fromSite} ürün siteden` : 'Site bağlanınca menü ve fiyatlar kendiliğinden gelir', done: fromSite > 0, to: '/yonetim/menu' },
    { key: 'masa', title: 'Masa planı', detail: tables ? `${tables} masa` : 'Bölümleri ve masaları ekleyin', done: tables > 0, to: '/yonetim/masa-plani' },
    {
      key: 'personel',
      title: 'Personel ve PIN’ler',
      detail: withSample ? `${withSample} hesap hâlâ örnek PIN’le` : `${users.length} kişi`,
      done: withSample === 0 && users.length > 1,
      to: '/yonetim/personel',
    },
    { key: 'fis', title: 'Fiş yazdırma', detail: printed ? 'Hesap yazdırıldı' : 'Bir adisyonda Hesap yazdır ile deneyin', done: printed, to: '/masalar' },
    {
      key: 'pavo',
      title: 'Yazarkasa (Pavo)',
      detail: s.okcProvider === 'kapali' ? 'Kullanılmıyor' : pavoPaired ? 'Eşleşti' : 'Yazarkasa POS › Pavo › Eşleştir',
      done: s.okcProvider === 'kapali' || pavoPaired,
      to: '/yonetim/yazarkasa',
    },
    { key: 'deneme', title: 'Deneme satışı', detail: sales ? 'Satış yapıldı' : 'Küçük bir satış yapıp ödemesini alın', done: sales, to: '/' },
    { key: 'gercek', title: 'Gerçek kullanıma başla', detail: s.demoMode ? 'Ayarlar ve yedek › Denemeyi bitir' : 'Başladı', done: !s.demoMode, to: '/yonetim/ayarlar' },
  ];
  return { steps, hidden: getSyncState<boolean>(HIDDEN) === true };
}

const HIDDEN = 'kurulum.gizli';
/** Patron kartı gizler ya da yeniden açar */
export const setSetupHidden = (hidden: boolean) => setSyncState(HIDDEN, hidden);
