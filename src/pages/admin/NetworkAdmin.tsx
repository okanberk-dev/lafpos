import { useQuery } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { encode } from 'uqr';
import { fmtDateTime } from '@shared/time';
import type { NetAddressDTO, NetworkInfoDTO } from '@shared/types';
import { Badge, Card, DefRow, LABEL, PageHeader, TONE_SOFT } from '@/components/admin/ui';
import { PageLoading } from '@/components/ui/misc';
import { get } from '@/lib/api';
import { cn } from '@/lib/cn';

/** Karekod: beyaz zeminde koyu modüller (okuyucular ters renkte zorlanır), kenarda iki modül sessiz alan */
function QrCode({ value, label }: { value: string; label: string }) {
  const { d, n } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 2 });
    let path = '';
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d: path, n: qr.data.length };
  }, [value]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="size-40 shrink-0 rounded-lg border border-[var(--admin-border)] bg-white">
      <path d={d} fill="#0c0e1b" />
    </svg>
  );
}

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
  if (q.isLoading || !q.data) return <PageLoading />;
  const n = q.data;
  const [local, ...others] = n.lan;
  const remote = n.tailscale[0];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Ağ ve uzaktan erişim"
        description="Tablet ve telefonlar bu bilgisayardaki LafPOS sunucusuna bağlanır: kafede Wi-Fi'dan, dışarıdan Tailscale ile. İkisinde de ekranlar kafedekilerle aynı anda güncellenir"
      />
      {n.loopbackOnly && (
        <p className={cn('flex items-start gap-2 rounded-xl p-3 text-sm', TONE_SOFT.warning)}>
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Sunucu yalnız bu bilgisayarı dinliyor (LAFPOS_HOST): tablet ve telefonlar bağlanamaz
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Kafenin ağı" subtitle="Tablet, garson telefonu, bar ekranı">
          {local ? (
            <Address item={local}>
              <p className={HINT}>Aynı Wi-Fi'deki tablet ya da telefonun kamerasıyla okutun; Chrome menüsünden "Ana ekrana ekle" ile uygulama gibi açılır</p>
              <p className={HINT}>Adres değişmesin diye modemde bu bilgisayara sabit IP verin (DHCP rezervasyonu)</p>
            </Address>
          ) : (
            <p className="text-sm">Bu bilgisayar bir ağa bağlı görünmüyor; Wi-Fi'ı ya da kabloyu denetleyin</p>
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
              <li>Bu bilgisayara Tailscale'i kurun ve hesabınızla girin (tailscale.com/download)</li>
              <li>Telefonunuza Tailscale uygulamasını kurun, aynı hesapla girin</li>
              <li>Bu sayfa kendini yeniler; uzaktan adres ve karekodu burada çıkar</li>
            </ol>
          )}
          <p className={cn(HINT, 'mt-4')}>LafPOS'u modemden port açarak internete açmayın; dışarıdan yalnız Tailscale ile</p>
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
          <p className={HINT}>Açmak için ayarlara LAFPOS_CLOUD_URL ve LAFPOS_CLOUD_SECRET yazın (docs/07-UZAKTAN-ERISIM.md); Vercel'de aynı anahtar ve bir parola tanımlanır</p>
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
    </div>
  );
}
