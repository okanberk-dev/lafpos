import { useMutation, useQuery } from '@tanstack/react-query';
import { CloudUpload } from 'lucide-react';
import { useState } from 'react';
import { fmtDateTime } from '@shared/time';
import { Badge, Card, DefRow } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Modal } from '@/components/ui/Modal';
import { ErrorState, Notice, Skeleton } from '@/components/ui/misc';
import { errorMessage, get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { toast } from '@/lib/toast';

interface State {
  ready: boolean;
  restore: boolean;
  state: { lastAt: number | null; lastName: string | null; lastSize: number | null; lastError: string | null };
}
interface Backup {
  pathname: string;
  size: number;
  at: number;
}

const mb = (b: number) => `${(b / 1048576).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} MB`;

/** Geri yükleme sihirbazı: yedeği seç → uyarıyı oku, PIN'i yaz → LafPOS yeniden açılır */
function RestoreDialog({ onClose }: { onClose: () => void }) {
  const [shop, setShop] = useState<string | undefined>(undefined);
  const list = useQuery({ queryKey: ['admin', 'bulut-yedek', 'liste', shop], queryFn: () => post<{ shop: string; dukkanlar: string[]; yedekler: Backup[] }>('/admin/bulut-yedek/liste-dukkan', shop ? { dukkan: shop } : {}) });
  const [picked, setPicked] = useState<Backup | null>(null);
  const [pin, setPin] = useState('');
  const restore = useMutation({
    mutationFn: () => post('/admin/bulut-yedek/geri-yukle', { pathname: picked!.pathname, pin }),
    onSuccess: () => {
      toast.ok('Yedek indirildi; LafPOS yeniden açılıyor');
      // Sunucu kapanıp açılır: oturum ve ekran yenilenir
      setTimeout(() => window.location.reload(), 8000);
      onClose();
    },
  });
  const d = list.data;
  return (
    <Modal
      open
      onClose={onClose}
      title="Buluttan geri yükle"
      subtitle={picked ? fmtDateTime(picked.at) : 'Dönmek istediğiniz yedeği seçin'}
      footer={
        picked ? (
          <>
            <Button variant="ghost" onClick={() => setPicked(null)}>
              Geri
            </Button>
            <Button variant="danger" loading={restore.isPending} disabled={pin.length < 4} onClick={() => restore.mutate()}>
              Bu yedeğe dön
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
        )
      }
    >
      {!picked ? (
        list.isPending ? (
          <Skeleton className="h-40" />
        ) : list.isError ? (
          <ErrorState compact title="Yedekler alınamadı" error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (
          <div className="grid gap-3">
            {d && d.dukkanlar.length > 1 && (
              <Field label="Kurulum" hint="Bilgisayar değiştiyse eski kurulumun yedekleri">
                <select value={d.shop} onChange={(e) => setShop(e.target.value)} className="h-11 w-full rounded-[var(--r-control)] border border-line bg-surface px-3 text-sm pointer-fine:h-10">
                  {d.dukkanlar.map((x) => (
                    <option key={x} value={x}>
                      {x === d.shop ? `${x.slice(0, 8)} (bu liste)` : x.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {!d?.yedekler.length ? (
              <p className="text-sm text-muted">Bu kurulumun bulutta yedeği yok</p>
            ) : (
              <ul className="divide-y divide-[var(--admin-divider)] overflow-hidden rounded-[var(--r-tile)] border border-line">
                {d.yedekler.map((b) => (
                  <li key={b.pathname}>
                    <button type="button" onClick={() => setPicked(b)} className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-hover">
                      <span className="font-medium">{fmtDateTime(b.at)}</span>
                      <span className="tabular text-[13px] text-muted">{mb(b.size)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      ) : (
        <div className="grid gap-4">
          <Notice tone="warn" title="Bu yedekten sonraki kayıtlar geri gelmez">
            Şu anki veritabanının kopyası yedek klasörüne alınır, sonra seçtiğiniz yedek yerine konur ve LafPOS yeniden açılır (yaklaşık yarım dakika)
          </Notice>
          <Field label="Kendi PIN’iniz">
            <PasswordInput inputMode="numeric" autoComplete="off" wide showLabel="PIN’i göster" hideLabel="PIN’i gizle" maxLength={12} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          </Field>
          {restore.isError && <Notice tone="danger">{errorMessage(restore.error)}</Notice>}
        </div>
      )}
    </Modal>
  );
}

/**
 * Bulut yedeği (Yönetim › Ayarlar ve yedek; server/sync/yedek.ts): günlük yedek şifrelenip LafPOS Uzaktan'ın özel
 * deposuna gider. Son yüklemenin anı, şimdi yedekle, buluttan geri yükle (yalnız patron, Windows kurulumunda)
 */
export function CloudBackupCard() {
  const me = useAuth((s) => s.me);
  const q = useQuery({ queryKey: ['admin', 'bulut-yedek'], queryFn: () => get<State>('/admin/bulut-yedek') });
  const [restoring, setRestoring] = useState(false);
  const now = useMutation({
    mutationFn: () => post<{ size: number }>('/admin/bulut-yedek'),
    onSuccess: (r) => {
      toast.ok(`Yedek buluta yüklendi (${mb(r.size)})`);
      void q.refetch();
    },
    onError: (e) => toast.err(errorMessage(e)),
  });
  const d = q.data;
  if (d && !d.ready) return null;
  const s = d?.state;
  return (
    <Card
      title="Bulut yedeği"
      subtitle="Her gün şifrelenip buluta gider; bilgisayar bozulsa da veriler kaybolmaz"
      actions={s ? s.lastError ? <Badge tone="warning" dot>Gidemedi</Badge> : s.lastAt ? <Badge tone="success" dot>Açık</Badge> : <Badge tone="info" dot>Bekliyor</Badge> : undefined}
    >
      {!d ? (
        <Skeleton className="h-24" />
      ) : (
        <div className="text-sm">
          <DefRow label="Son yedek">{s?.lastAt ? `${fmtDateTime(s.lastAt)}${s.lastSize ? ` · ${mb(s.lastSize)}` : ''}` : 'Henüz yok'}</DefRow>
          {s?.lastError && <DefRow label="Son hata">{s.lastError}</DefRow>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button icon={<CloudUpload className="size-4" />} loading={now.isPending} onClick={() => now.mutate()}>
              Şimdi yedekle
            </Button>
            {me?.role === 'patron' && d.restore && (
              <Button variant="ghost" onClick={() => setRestoring(true)}>
                Buluttan geri yükle
              </Button>
            )}
          </div>
        </div>
      )}
      {restoring && <RestoreDialog onClose={() => setRestoring(false)} />}
    </Card>
  );
}
