import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Card } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Field, NumberInput, Toggle } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/misc';
import { errorMessage, get, post, put } from '@/lib/api';
import { toast } from '@/lib/toast';

interface NotifySettings {
  enabled: boolean;
  voidMin: number;
  compMin: number;
  cashDiffMin: number;
  internetMin: number;
  pavo: boolean;
}

const KEY = ['sync', 'bildirim'];

/**
 * Telefon bildirimleri (Yönetim › Ağ ve uzaktan erişim): hangi olayın patronun telefonuna gideceği ve eşikleri
 * (server/sync/bildirim.ts). Telefonda bildirimi patron LafPOS Uzaktan › Merkez'de açar
 */
export function NotifyCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => get<{ ready: boolean; settings: NotifySettings; pending: number }>('/sync/bildirim') });
  const save = useMutation({
    mutationFn: (patch: Partial<NotifySettings>) => put('/sync/bildirim', patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
    onError: (e) => toast.err(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: () => post<{ pending: number }>('/sync/bildirim/dene'),
    onSuccess: (r) => toast.ok(r.pending ? 'İnternet yok; deneme bildirimi internet gelince gidecek' : 'Deneme bildirimi gönderildi'),
    onError: (e) => toast.err(errorMessage(e)),
  });
  const d = q.data;
  const s = d?.settings;
  // Tutarlar TL olarak yazılır, kuruş saklanır
  const tlField = (label: string, key: 'voidMin' | 'compMin' | 'cashDiffMin') =>
    s && (
      <Field label={label}>
        <NumberInput value={s[key] / 100} min={0} max={1_000_000} fallback={s[key] / 100} disabled={!s.enabled} onCommit={(v) => save.mutate({ [key]: Math.round(v * 100) })} />
      </Field>
    );
  return (
    <Card
      title="Telefon bildirimleri"
      subtitle="Önemli olaylar patronun telefonuna; telefonda LafPOS Uzaktan › Merkez'den açılır"
      actions={d ? d.ready ? s?.enabled ? <Badge tone="success" dot>Açık</Badge> : <Badge>Kapalı</Badge> : <Badge>Uzaktan kurulu değil</Badge> : undefined}
    >
      {!s ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="grid gap-4">
          <Toggle checked={s.enabled} onChange={(v) => save.mutate({ enabled: v })} label="Bildirim gönder" disabled={!d?.ready} />
          <div className="grid gap-3 sm:grid-cols-2">
            {tlField('İptal en az (₺)', 'voidMin')}
            {tlField('İkram en az (₺)', 'compMin')}
            {tlField('Kasa farkı en az (₺)', 'cashDiffMin')}
            <Field label="İnternet kesintisi en az (dakika)">
              <NumberInput value={s.internetMin} min={1} max={1440} fallback={s.internetMin} disabled={!s.enabled} onCommit={(v) => save.mutate({ internetMin: Math.round(v) })} />
            </Field>
          </div>
          <Toggle checked={s.pavo} onChange={(v) => save.mutate({ pavo: v })} label="Pavo gün sonu alınamazsa" disabled={!s.enabled} />
          <div>
            <Button variant="secondary" loading={test.isPending} disabled={!d?.ready || !s.enabled} onClick={() => test.mutate()}>
              Deneme bildirimi gönder
            </Button>
            {d.pending > 0 && <p className="mt-2 text-[13px] text-muted">{d.pending} bildirim internet bekliyor</p>}
          </div>
        </div>
      )}
    </Card>
  );
}
