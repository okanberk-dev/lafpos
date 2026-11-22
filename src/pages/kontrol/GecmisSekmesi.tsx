import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { KOMUT_ETIKET, type KontrolGecmisi, type KontrolPaneli } from '@shared/kontrol';
import { fmtDateTime, fmtTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Card, EmptyState } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { komutIptal, kontrolAnahtari } from '@/lib/kontrol';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';
import { GecmisRozeti, NEDEN, NOT, SATIR } from './ortak';
import { iptalNedeni, kimEtiketi } from './yardimci';

/**
 * Geçmiş: kuyrukta bekleyenler (eskiden yeniye, iptal edilebilir) ve bitenler (yeniden eskiye). Reddedilen işlemde
 * kasanın nedeni yazılır. Özet gizli değer taşımaz (bulut `komutOzeti` ile kurar)
 */
export function GecmisSekmesi({ panel }: { panel: KontrolPaneli }) {
  const qc = useQueryClient();
  const [mesgul, setMesgul] = useState<string | null>(null);
  const iptal = async (k: KontrolGecmisi) => {
    setMesgul(k.id);
    try {
      const r = await komutIptal(k.id);
      // Satır bekleyenlerden hemen düşer, geçmişin başına "İptal" olarak geçer
      qc.setQueryData<KontrolPaneli>(kontrolAnahtari.durum, (d) => d && { ...d, bekleyen: d.bekleyen.filter((b) => b.id !== k.id), gecmis: r.komut ? [r.komut, ...d.gecmis.filter((g) => g.id !== r.komut.id)] : d.gecmis });
      void qc.invalidateQueries({ queryKey: kontrolAnahtari.durum });
      toast.ok('İşlem iptal edildi; kasaya gitmeyecek');
    } catch (e) {
      toast.err(errorMessage(e));
      void qc.invalidateQueries({ queryKey: kontrolAnahtari.durum });
    } finally {
      setMesgul(null);
    }
  };
  const bekleyen = [...panel.bekleyen].sort((a, b) => a.at - b.at);
  return (
    <>
      <Card title="Bekleyen" subtitle={bekleyen.length ? `${bekleyen.length} işlem kasaya gidecek` : undefined}>
        {bekleyen.length === 0 ? (
          <EmptyState compact title="Bekleyen işlem yok">
            Gönderilen işlem kasaya ulaşana dek burada durur
          </EmptyState>
        ) : (
          <>
            <ul>
              {bekleyen.map((k) => {
                const kapali = iptalNedeni(panel, k);
                return (
                  <GecmisSatiri key={k.id} k={k} ben={panel.ben.eposta} neden={kapali && kapali !== iptalNedeni(panel) ? kapali : null}>
                    <Button size="sm" variant="dangerGhost" loading={mesgul === k.id} disabled={!!kapali} title={kapali ?? undefined} onClick={() => void iptal(k)} aria-label={`İptal: ${k.ozet}`}>
                      İptal
                    </Button>
                  </GecmisSatiri>
                );
              })}
            </ul>
            <p className={cn('border-t border-[var(--admin-divider)] px-5 py-3', NOT)}>Kasa kapalıysa ya da internet yoksa işlem bekler; 24 saat içinde ulaşmazsa uygulanmaz</p>
          </>
        )}
      </Card>
      <Card title="Bitenler" subtitle={panel.gecmis.length ? `Son ${panel.gecmis.length} işlem` : undefined}>
        {panel.gecmis.length === 0 ? (
          <EmptyState compact title="Henüz biten işlem yok">
            Kasanın uyguladığı ya da reddettiği işlemler burada görünür
          </EmptyState>
        ) : (
          <ul>
            {panel.gecmis.map((k) => (
              <GecmisSatiri key={k.id} k={k} ben={panel.ben.eposta} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function GecmisSatiri({ k, ben, neden, children }: { k: KontrolGecmisi; ben: string | null; neden?: string | null; children?: ReactNode }) {
  const zaman = k.bitti ? `${fmtDateTime(k.at)} → ${fmtTime(k.bitti)}` : fmtDateTime(k.at);
  return (
    <li className={cn(SATIR, 'flex flex-wrap items-start gap-x-4 gap-y-2')}>
      <div className="min-w-0 flex-[1_1_14rem]">
        <p className="text-pretty text-sm font-medium text-ink [overflow-wrap:anywhere]">{k.ozet || KOMUT_ETIKET[k.tur]}</p>
        <p className="mt-0.5 text-[13px] text-muted [overflow-wrap:anywhere]">{joinMeta([kimEtiketi(k.kim, ben), zaman])}</p>
        {k.durum === 'reddedildi' && k.mesaj && <p className="mt-1 text-pretty text-[13px] leading-5 text-[var(--admin-danger-ink)]">{k.mesaj}</p>}
        {k.durum === 'iptal' && k.mesaj && <p className="mt-0.5 text-pretty text-[13px] leading-5 text-muted">{k.mesaj}</p>}
        {neden && <p className={cn('mt-0.5', NEDEN)}>{neden}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <GecmisRozeti durum={k.durum} />
        {children}
      </div>
    </li>
  );
}
