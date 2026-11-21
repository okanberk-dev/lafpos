import { useQuery } from '@tanstack/react-query';
import { CloudOff, CloudUpload } from 'lucide-react';
import { get } from '@/lib/api';
import { REMOTE } from '@/lib/remote';
import { Badge } from './ui/misc';

interface InternetInfo {
  configured: boolean;
  state: 'bilinmiyor' | 'var' | 'yok';
  pending: number;
  sent: { at: number; count: number } | null;
}

/**
 * Durum alanının internet rozeti (server/sync/catch-up.ts): kasa internetsiz de satar, rozet yalnız dışarı gidecek
 * kayıt beklerken görünür ("İnternet yok · 3 kayıt bekliyor"), internet dönüp hepsi gidince yarım saat "Bekleyenler
 * gönderildi" der. Dış bağlantı kurulmamış kasada ve her şey yolundayken hiçbir şey çizilmez. Canlı akışın `sync`
 * olayı sorguyu yeniler; ayrıca dakikada bir. `compact`: telefonun üst şeridi (ikon ve sayı, tam metin ipucunda)
 */
export function InternetBadge({ compact = false }: { compact?: boolean }) {
  const q = useQuery({ queryKey: ['sync', 'internet'], queryFn: () => get<InternetInfo>('/sync/internet'), refetchInterval: 60_000, enabled: !REMOTE });
  const d = q.data;
  if (!d?.configured) return null;
  if (d.state === 'yok' && d.pending > 0) {
    const text = `İnternet yok · ${d.pending} kayıt bekliyor`;
    return (
      <span role="status" title={`${text}; satış sürer, internet gelince gönderilir`} className="inline-flex shrink-0">
        <Badge tone="warning" className="gap-1 whitespace-nowrap">
          <CloudOff aria-hidden="true" className="size-3.5" />
          {compact ? (
            <>
              <span aria-hidden="true">{d.pending}</span>
              <span className="sr-only">{text}</span>
            </>
          ) : (
            text
          )}
        </Badge>
      </span>
    );
  }
  if (d.sent) {
    return (
      <span role="status" title={`Bekleyenler gönderildi (${d.sent.count} kayıt)`} className="inline-flex shrink-0">
        <Badge tone="success" className="gap-1 whitespace-nowrap">
          <CloudUpload aria-hidden="true" className="size-3.5" />
          {compact ? <span className="sr-only">Bekleyenler gönderildi</span> : 'Bekleyenler gönderildi'}
        </Badge>
      </span>
    );
  }
  return null;
}
