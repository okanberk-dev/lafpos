import { Lock, MonitorCog } from 'lucide-react';
import type { ReactNode } from 'react';
import type { GecmisDurumu, KomutIstegi, KomutTuru, KontrolDurumu, KontrolGecmisi, KontrolPaneli } from '@shared/kontrol';
import { type Role, ROLE_LABELS } from '@shared/permissions';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState, FLOAT_CARD, Notice } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { type BekleyenIs, GECMIS_ETIKET, GECMIS_TON, type Hedef } from './yardimci';

/** Sekmelerin ortak verisi (KontrolPage hazırlar) */
export interface SekmeProps {
  panel: KontrolPaneli;
  /** Okunur kasa özeti; kasa bu özelliği içermiyorsa null */
  durum: KontrolDurumu | null;
  /** Bütün işlemleri kapatan neden (sayfanın üstünde yazılı: örnek görünüm, yalnız görür, kasa güncel değil ya da kapalı) */
  genel: string | null;
  /** İşlem kapalıysa nedeni (rol kapısı, örnek görünüm, kasa durumu) */
  neden: (tur: KomutTuru, hedefRoller?: (Role | undefined)[]) => string | null;
  /** Bekleyen işlemler satıra göre */
  bekleyen: Map<string, BekleyenIs[]>;
  /** Kasada uygulanmış, menü özetine henüz yansımamış Tükendi / Satışa aç */
  uygulanan: Map<string, Hedef>;
  /** Komutu kuyruğa koyar; hata fırlatır (ileti Türkçe, sunucudan ya da doğrulamadan) */
  gonder: (istek: KomutIstegi) => Promise<KontrolGecmisi>;
}

/** Kartın satır ayracı ve iç payı (MerkezPage satırlarıyla aynı) */
export const SATIR = 'border-b border-[var(--admin-divider)] px-5 py-3 last:border-b-0';
/** Kartın dibindeki ya da üstündeki açıklama satırı */
export const NOT = 'text-pretty text-[13px] leading-5 text-muted';
/** Kapalı işlemin satırdaki nedeni (dokunmatikte ipucu görünmez: neden yazıyla) */
export const NEDEN = 'text-pretty text-xs leading-4 text-muted';

/** Satırda bekleyen işlem: kasaya ulaşınca uygulanır */
export function BekliyorRozeti({ isler }: { isler?: BekleyenIs[] }) {
  const n = isler?.length ?? 1;
  return (
    <Badge tone="info" dot title={isler?.map((i) => i.komut.ozet).join('\n') ?? 'Kasaya ulaşınca uygulanır'}>
      {n > 1 ? `${n} işlem bekliyor` : 'Bekliyor'}
    </Badge>
  );
}

export function GecmisRozeti({ durum }: { durum: GecmisDurumu }) {
  return (
    <Badge tone={GECMIS_TON[durum]} dot={durum === 'bekliyor'}>
      {GECMIS_ETIKET[durum]}
    </Badge>
  );
}

/** Rol rozeti sakin ve renksiz (rol bir durum değil); patron kilitle ayrılır (Yönetim › Personel gibi) */
export function RolRozeti({ rol }: { rol: Role }) {
  return (
    <Badge>
      {rol === 'patron' && <Lock aria-hidden="true" className="size-3" />}
      {ROLE_LABELS[rol]}
    </Badge>
  );
}

/**
 * Kasa bu özelliği içeren sürümde değil ya da hiç bağlanmadı (`bagli` false): kasanın özetinden gelen sekmenin yerinde
 * kısa açıklama. Ne yapılacağı (güncelleme ya da kurulum) ve bağlantısı sayfanın üstündeki notta, burada yinelenmez
 */
export function KasaGuncelDegil({ bagli = true }: { bagli?: boolean }) {
  return (
    <EmptyState className={FLOAT_CARD} icon={<MonitorCog />} title={bagli ? 'Kasa güncellenince açılır' : 'Kasa bağlanınca açılır'}>
      Personel, roller ve servis modu kasanın bildirdiği özetten gelir
    </EmptyState>
  );
}

/** Kart başlığının altındaki açıklama şeridi */
export function KartNotu({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('border-b border-[var(--admin-divider)] px-5 py-3', NOT, className)}>{children}</p>;
}

/**
 * Form penceresinin alt şeridi: Vazgeç ve gönder; telefonda gönder kalan genişliği alır (etiket tek satırda kalsın).
 * `kilitli`: istek sürerken Vazgeç kapalı (yanıtı yalnız bu pencere gösteriyorsa: davet kodu)
 */
export function FormAlti({ formId, bekle, etiket, onClose, kapali, kilitli }: { formId: string; bekle: boolean; etiket: string; onClose: () => void; kapali?: boolean; kilitli?: boolean }) {
  return (
    <div className="flex justify-end gap-2">
      <Button onClick={onClose} disabled={kilitli}>
        Vazgeç
      </Button>
      <Button type="submit" form={formId} variant="primary" loading={bekle} disabled={kapali} wrap className="max-sm:flex-1">
        {etiket}
      </Button>
    </div>
  );
}

/**
 * Formun sunucu ya da şifreleme hatası: alanların altında, ekran okuyucuya hemen okunur. Bölge boşken de ağaçta durur
 * (gizli bölgeye eklenen ileti okunmaz), boşken yer kaplamaz
 */
export function FormHatasi({ hata, className }: { hata: string | null; className?: string }) {
  return (
    <div aria-live="assertive" className={cn('mt-4 empty:mt-0', className)}>
      {hata && <Notice tone="danger">{hata}</Notice>}
    </div>
  );
}
