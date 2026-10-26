import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, Info } from 'lucide-react';
import { useMemo, useState } from 'react';
import { tl } from '@shared/money';
import { fmtDateTime } from '@shared/time';
import { Badge, Card, EmptyState, PageHeader, SearchField, StatusTabs, Timeline, type TimelineItem } from '@/components/admin/ui';
import { PageLoading } from '@/components/ui/misc';
import { get } from '@/lib/api';
import { fold } from '@/lib/shell';

interface AuditRow {
  id: number;
  at: number;
  action: string;
  severity: 'info' | 'uyari' | 'alarm';
  message: string;
  amount: number | null;
  userName: string | null;
  approverName: string | null;
}

/** Denetim kaydı: Innex zaman çizelgesi (§1.5 "Zaman çizelgesi"), önem derecesine göre sayılı sekmeler */
export default function AuditAdmin() {
  const [severity, setSeverity] = useState<'tum' | 'uyari' | 'alarm'>('tum');
  const [q, setQ] = useState('');
  const data = useQuery({ queryKey: ['admin', 'audit'], queryFn: () => get<AuditRow[]>('/admin/audit?severity=tum&limit=300') });
  const all = useMemo(() => data.data ?? [], [data.data]);
  const rows = useMemo(() => {
    const k = fold(q.trim());
    return all.filter((a) => (severity === 'tum' || a.severity === severity) && (!k || fold(`${a.message} ${a.action} ${a.userName ?? ''} ${a.approverName ?? ''}`).includes(k)));
  }, [all, severity, q]);

  const items: TimelineItem[] = rows.map((a) => ({
    key: String(a.id),
    tone: a.severity === 'alarm' ? 'danger' : a.severity === 'uyari' ? 'warning' : 'neutral',
    icon: a.severity === 'alarm' ? <AlertOctagon /> : a.severity === 'uyari' ? <AlertTriangle /> : <Info />,
    title: a.message,
    description: [a.userName && `${a.userName}`, a.approverName && `onaylayan ${a.approverName}`].filter(Boolean).join(' · ') || undefined,
    time: fmtDateTime(a.at),
    meta: (
      <span className="flex flex-wrap gap-1.5">
        <Badge>{a.action}</Badge>
        {a.amount != null && <Badge tone={a.severity === 'alarm' ? 'danger' : 'neutral'}>{tl(a.amount)}</Badge>}
      </span>
    ),
  }));

  return (
    <>
      <PageHeader title="Denetim kaydı" description="İptal, ikram, indirim, ödeme iptali, yeniden açma, kasa hareketi, gün sonu, fiyat ve ayar değişiklikleri; son 300 kayıt" />
      <StatusTabs
        label="Önem"
        value={severity}
        onChange={setSeverity}
        tabs={[
          { value: 'tum', label: 'Tümü', count: all.length },
          { value: 'uyari', label: 'Uyarı', count: all.filter((a) => a.severity === 'uyari').length },
          { value: 'alarm', label: 'Alarm', count: all.filter((a) => a.severity === 'alarm').length },
        ]}
      />
      <div className="mb-3 flex items-center gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Kayıt, işlem ya da kişi" label="Denetim kaydında ara" />
      </div>
      {data.isLoading ? (
        <PageLoading />
      ) : items.length ? (
        <Card>
          <Timeline items={items} />
        </Card>
      ) : (
        <EmptyState title="Kayıt yok">Seçili süzgeçte denetim kaydı bulunmuyor</EmptyState>
      )}
    </>
  );
}
