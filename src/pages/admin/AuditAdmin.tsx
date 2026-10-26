import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, Info } from 'lucide-react';
import { useState } from 'react';
import { tl } from '@shared/money';
import { fmtDateTime } from '@shared/time';
import { Segmented } from '@/components/ui/Field';
import { Card, PageHeader, PageLoading } from '@/components/ui/misc';
import { get } from '@/lib/api';

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

export default function AuditAdmin() {
  const [severity, setSeverity] = useState<'tum' | 'uyari' | 'alarm'>('tum');
  const data = useQuery({ queryKey: ['admin', 'audit', severity], queryFn: () => get<AuditRow[]>(`/admin/audit?severity=${severity}&limit=300`) });
  return (
    <div>
      <PageHeader
        title="Denetim kaydı"
        subtitle="İptal, ikram, indirim, ödeme iptali, yeniden açma, kasa hareketi, gün sonu, fiyat ve ayar değişiklikleri"
        actions={
          <Segmented
            value={severity}
            onChange={setSeverity}
            options={[
              { value: 'tum', label: 'Tümü' },
              { value: 'uyari', label: 'Uyarı' },
              { value: 'alarm', label: 'Alarm' },
            ]}
          />
        }
      />
      {data.isLoading ? (
        <PageLoading />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {(data.data ?? []).map((a) => (
              <li key={a.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                {a.severity === 'alarm' ? <AlertOctagon className="mt-0.5 size-4 shrink-0 text-burgundy-500" /> : a.severity === 'uyari' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-brass-500" /> : <Info className="mt-0.5 size-4 shrink-0 text-muted" />}
                <span className="min-w-0 flex-1">
                  <span className="block">{a.message}</span>
                  <span className="text-xs text-muted">
                    {fmtDateTime(a.at)} · {a.action}
                    {a.approverName && ` · onaylayan ${a.approverName}`}
                  </span>
                </span>
                {a.amount != null && <span className="tabular whitespace-nowrap font-semibold">{tl(a.amount)}</span>}
              </li>
            ))}
            {data.data?.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">Kayıt yok</li>}
          </ul>
        </Card>
      )}
    </div>
  );
}
