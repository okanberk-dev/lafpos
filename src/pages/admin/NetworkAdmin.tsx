import { useQuery } from '@tanstack/react-query';
import { WifiOff } from 'lucide-react';
import { fmtDateTime } from '@shared/time';
import type { NetAddressDTO, NetworkInfoDTO } from '@shared/types';
import { Badge, Card, CARD, CODE, DefRow, EmptyState, LABEL, PageHeader, SetupNotes } from '@/components/admin/ui';
import { QrCode } from '@/components/QrCode';
import { ErrorState, Notice, Skeleton } from '@/components/ui/misc';
import { get } from '@/lib/api';
import { cn } from '@/lib/cn';

/** Karekod ve adres yan yana; telefonda alt alta */
function Address({ item, children }: { item: NetAddressDTO; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <QrCode value={item.url} label={`${item.url} karekodu`} />
      <div className="min-w-0 space-y-2">
        <p className="tabular break-all text-lg font-semibold text-[var(--admin-text)]">{item.url}</p>
        {children}
      </div>
    </div>
  );
}

const HINT = 'text-[13px] text-[var(--admin-text-mute)]';

/**
 * Tablet ve telefonların bağlanacağı adresler: kafenin ağı (karekodla) ve Tailscale ile dışarıdan canlı erişim.
 * Kurulum: docs/07-UZAKTAN-ERISIM.md
 */
export default function NetworkAdmin() {
  const q = useQuery({ queryKey: ['admin', 'network'], queryFn: () => get<NetworkInfoDTO>('/admin/network'), refetchInterval: 15_000 });
  const header = <PageHeader title="Ağ ve uzaktan erişim" description="Tablet ve telefonlar kafede Wi-Fi’dan, dışarıdan Tailscale ile bağlanır" />;
  if (!q.data)
    return (
      <div className="space-y-4">
        {header}
        {q.isError ? (
          <ErrorState className={CARD} title="Ağ bilgisi alınamadı" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : (
          <div role="status" aria-label="Yükleniyor…" className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-56 rounded-2xl" />
            <Skeleton className="h-56 rounded-2xl" />
          </div>
        )}
      </div>
    );
  const n = q.data;
  const [local, ...others] = n.lan;
  const remote = n.tailscale[0];

  return (
    <div className="space-y-4">
      {header}
      {n.loopbackOnly && (
        <Notice tone="warn" role="status">
          Sunucu yalnız bu bilgisayarı dinliyor: tablet ve telefonlar bağlanamaz
        </Notice>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Kafenin ağı" subtitle="Tablet, garson telefonu, bar ekranı">
          {local ? (
            <Address item={local}>
              <p className={HINT}>Aynı Wi-Fi’deki tablet ya da telefonun kamerasıyla okutun; Chrome menüsünden “Ana ekrana ekle” ile uygulama gibi açılır</p>
              <p className={HINT}>Adres değişmesin diye modemde bu bilgisayara sabit IP verin (DHCP rezervasyonu)</p>
            </Address>
          ) : (
            <EmptyState bare icon={<WifiOff />} title="Ağa bağlı görünmüyor">
              Bu bilgisayarın Wi-Fi’ını ya da kablosunu denetleyin; bağlanınca adres ve karekod burada çıkar
            </EmptyState>
          )}
          {others.length > 0 && (
            <div className="mt-4">
              <p className={LABEL}>Diğer ağ kartları</p>
              {others.map((o) => (
                <DefRow key={o.url} label={o.name}>
                  <span className="tabular break-all">{o.url}</span>
                </DefRow>
              ))}
            </div>
          )}
        </Card>

        <Card
          title="Dışarıdan (Tailscale)"
          subtitle="Patronun telefonu, evdeki bilgisayar"
          actions={remote ? <Badge tone="success" dot>Bağlı</Badge> : <Badge>Kurulmadı</Badge>}
        >
          {remote ? (
            <Address item={remote}>
              <p className={HINT}>Telefonda Tailscale açıkken açın: masalar, adisyonlar, kasa ve patron paneli her yerden canlı</p>
              <p className={HINT}>Bağlantı yalnız sizin Tailscale hesabınızdaki cihazlara açık ve şifreli</p>
            </Address>
          ) : (
            <ol className="list-decimal space-y-2 pl-5 text-sm text-[var(--admin-text)]">
              <li>Bu bilgisayara Tailscale’i kurun ve hesabınızla girin (tailscale.com/download)</li>
              <li>Telefonunuza Tailscale uygulamasını kurun, aynı hesapla girin</li>
              <li>Bu sayfa kendini yeniler; uzaktan adres ve karekodu burada çıkar</li>
            </ol>
          )}
          <p className={cn(HINT, 'mt-4')}>LafPOS’u modemden port açarak internete açmayın; dışarıdan yalnız Tailscale ile</p>
        </Card>
      </div>

      <Card
        title="LafPOS Uzaktan (Vercel)"
        subtitle="Kurulum gerektirmeyen salt okunur görünüm: patron paneli, masalar, bar"
        actions={n.cloud?.configured ? <Badge tone={n.cloud.lastError ? 'warning' : 'success'} dot>{n.cloud.lastError ? 'Gönderilemiyor' : 'Açık'}</Badge> : <Badge>Kapalı</Badge>}
      >
        {n.cloud?.configured ? (
          <>
            <DefRow label="Adres">
              <span className="break-all">{n.cloud.url}</span>
            </DefRow>
            <DefRow label="Son gönderim">{n.cloud.lastSuccessAt ? fmtDateTime(n.cloud.lastSuccessAt) : 'Henüz yok'}</DefRow>
            {n.cloud.lastError && <DefRow label="Son hata">{n.cloud.lastError}</DefRow>}
          </>
        ) : (
          <p className={HINT}>Açmak için kasa bilgisayarına ve Vercel’e aynı anahtar tanımlanır; adımlar sayfanın sonunda</p>
        )}
      </Card>

      <Card title="Bu bilgisayar">
        <DefRow label="Bilgisayar adı">{n.hostname}</DefRow>
        <DefRow label="Port">
          <span className="tabular">{n.port}</span>
        </DefRow>
        <DefRow label="Bu ekranın adresi">
          <span className="break-all">{window.location.origin}</span>
        </DefRow>
      </Card>

      <SetupNotes>
        <p>
          Sunucunun dinlediği adres <code className={CODE}>LAFPOS_HOST</code> ayarıyla değişir; ağdaki cihazların bağlanması için <code className={CODE}>0.0.0.0</code> (varsayılan) kalmalı.
        </p>
        <p>
          LafPOS Uzaktan: kasa bilgisayarının ayarlarına <code className={CODE}>LAFPOS_CLOUD_URL</code> ve <code className={CODE}>LAFPOS_CLOUD_SECRET</code> yazın; Vercel’de aynı anahtar ve bir parola tanımlanır.
        </p>
        <p>
          Ayrıntı: <code className={CODE}>docs/07-UZAKTAN-ERISIM.md</code>
        </p>
      </SetupNotes>
    </div>
  );
}
