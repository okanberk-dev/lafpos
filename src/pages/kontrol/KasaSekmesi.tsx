import { useState } from 'react';
import { GUN_SONU_OMRU_MS } from '@shared/kontrol';
import { SERVICE_MODE_HINT, SERVICE_MODE_LABEL, SERVICE_MODES, type ServiceMode } from '@shared/service-mode';
import { Button } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Badge, Card } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useTick } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { BekliyorRozeti, KasaGuncelDegil, NEDEN, NOT, type SekmeProps } from './ortak';
import { gunSonuNedeni } from './yardimci';

/**
 * Kasa: gün sonu ve güncelleme (`gun.sonu`, yalnız sahip ve kasa bağlıyken) ve servis modu (Yönetim › Ayarlar › Servis
 * modu'nun uzaktaki hâli; `ayar.servis`). Seçim gönderilene dek yalnız ekranda; bekleyen istek "Bekliyor" rozetiyle
 * görünür, kasa uygulayınca özet yeni modu getirir
 */
export function KasaSekmesi({ panel, durum, genel, neden, bekleyen, gonder }: SekmeProps) {
  const [secim, setSecim] = useState<ServiceMode | null>(null);
  const [bekle, setBekle] = useState(false);
  // Kasanın çevrimiçi olup olmadığı zamanla değişir: gün sonu düğmesi yoklama gelmeden de kapanır
  const now = useTick(30_000);
  if (!durum) return <KasaGuncelDegil bagli={panel.kasa !== null} />;
  const isler = bekleyen.get('servis');
  const istenen = isler?.at(-1)?.hedef.mod;
  const simdiki = durum.servisModu;
  // Ekranda seçili görünen: elle seçilen, yoksa bekleyen istek, yoksa kasadaki mod
  const hedef = istenen ?? simdiki;
  const gorunen = secim ?? hedef;
  const kapali = neden('ayar.servis');

  const uygula = async () => {
    if (!secim || secim === hedef || bekle) return;
    const ok = await confirmDialog({
      title: `Servis modu “${SERVICE_MODE_LABEL[secim]}” olsun mu`,
      body: 'Kasa en geç 5 dakikada geçer; açılış ekranı, menü ve tezgâh satışının akışı buna göre değişir',
      confirmLabel: 'Servis modunu değiştir',
      tone: 'primary',
    });
    if (!ok) return;
    setBekle(true);
    try {
      await gonder({ tur: 'ayar.servis', veri: { mod: secim } });
      setSecim(null);
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBekle(false);
    }
  };

  // Rol ve kasa durumu, sırada bekleyen gün sonu ve kasa çevrimdışı (bulut da reddeder); gün kapalıysa alt başlık söyler
  const gunNeden = gunSonuNedeni(panel, now);
  const gunKapali = panel.kasa?.gunAcik === false;
  const gunSonu = async () => {
    const ok = await confirmDialog({
      title: 'Gün sonu alınsın ve güncelleme kurulsun mu',
      body: `Kasa en geç 5 dakikada gün sonunu (Z) sayımsız alır: Pavo banka gün sonu, lafmaliyet ve e-postalar kendiliğinden gider. Gün kapanınca yeni sürüm kurulur (LafPOS bir dakika kadar kapanır). Gün sonu şu durumlarda alınmaz, nedeni Geçmiş’te yazar ve güncelleme de hemen kurulmaz: kasada açık adisyon var, istek ${GUN_SONU_OMRU_MS / 60_000} dakikada kasaya ulaşmadı ya da bu arada kasada gün değişti. Kasa sayımını sonra Kasa › Geçmiş günler › Kasa föyü’nden girin`,
      confirmLabel: 'Gün sonu al ve güncelle',
      tone: 'primary',
    });
    if (!ok) return;
    setBekle(true);
    try {
      // Sıraya alındığını gonder duyurur (kasa çevrimdışıysa uyarıyla); burada ikinci kez duyurulmaz
      await gonder({ tur: 'gun.sonu', veri: { not: '' }, guncelle: true });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBekle(false);
    }
  };

  return (
    <>
    <Card
      title="Gün sonu ve güncelleme"
      subtitle={gunKapali ? 'Gün kapalı' : 'Kasada gün açık'}
      actions={
        <Button variant="primary" disabled={!!gunNeden || gunKapali} title={gunNeden ?? (gunKapali ? 'Kasada gün kapalı' : undefined)} loading={bekle} onClick={() => void gunSonu()}>
          Gün sonu al ve güncelle
        </Button>
      }
    >
      {gunNeden && gunNeden !== genel && <p className={cn('border-b border-[var(--admin-divider)] px-5 py-2.5', NEDEN)}>{gunNeden}</p>}
      <p className="px-5 py-4 text-sm text-muted">Kafede kimse gün sonu almadıysa kasa bağlıyken buradan alınır; ardından yeni LafPOS sürümü kendiliğinden kurulur. Yalnız panelin sahibi.</p>
    </Card>
    <Card
      title="Servis modu"
      subtitle="İşletmenin siparişi nasıl aldığı: açılış ekranı, menü ve tezgâh satışının akışı"
      actions={
        <Button variant="primary" disabled={!!kapali || !secim || secim === hedef} title={kapali ?? undefined} loading={bekle} onClick={() => void uygula()}>
          Servis modunu değiştir
        </Button>
      }
    >
      {kapali && kapali !== genel && <p className={cn('border-b border-[var(--admin-divider)] px-5 py-2.5', NEDEN)}>{kapali}</p>}
      <fieldset className="grid gap-2 p-5 sm:grid-cols-2" disabled={!!kapali}>
        <legend className="sr-only">Servis modu</legend>
        {SERVICE_MODES.map((m) => {
          const on = gorunen === m;
          return (
            <label
              key={m}
              className={cn(
                'flex min-h-11 items-start gap-3 rounded-[var(--r-tile)] border px-4 py-3 transition-colors duration-150',
                on ? 'border-[var(--admin-primary)] bg-[var(--admin-primary-soft)]' : 'border-[var(--admin-border)] bg-surface',
                kapali ? 'cursor-default' : 'cursor-pointer hover:border-[var(--admin-border-strong)]',
              )}
            >
              <input type="radio" name="servis-modu" value={m} checked={on} onChange={() => setSecim(m)} className="mt-0.5 size-5 shrink-0 accent-[var(--admin-primary)] pointer-fine:size-4" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold text-ink">{SERVICE_MODE_LABEL[m]}</span>
                  {m === simdiki && <Badge>Kasada şu an</Badge>}
                  {m === istenen && m !== simdiki && <BekliyorRozeti isler={isler} />}
                </span>
                <span className="mt-0.5 block text-pretty text-[13px] leading-5 text-muted">{SERVICE_MODE_HINT[m]}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className={cn('border-t border-[var(--admin-divider)] px-5 py-3', NOT)}>Ödeme kuralları ve bara gidiş her modda aynıdır; değişen açılış ekranı, menü ve tezgâh satışının akışıdır</p>
    </Card>
    </>
  );
}
