import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, ClipboardList, Info } from 'lucide-react';
import { useMemo, useState } from 'react';
import { tl } from '@shared/money';
import { addDays, fmtDateLong, fmtTime, istanbulParts } from '@shared/time';
import { settingLabel } from '@shared/settings-labels';
import { Badge, Card, CARD, EmptyState, PageHeader, SearchField, StatusTabs, Timeline, type TimelineItem } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { ErrorState, ListSkeleton } from '@/components/ui/misc';
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

/**
 * Sunucunun yazdığı eylem kodunun Türkçe adı (`grep -rn "action: '" server`). Ham kod (`order.bill`) ekranda
 * gösterilmez: burada olmayan kod önekinin genel adını alır (PREFIX_LABEL), o da yoksa etiket hiç çizilmez.
 */
const ACTION_LABEL: Record<string, string> = {
  'auth.global_lock': 'Giriş kilidi',
  'auth.pin_lock': 'PIN kilidi',
  'cash.giris': 'Kasaya giriş',
  'cash.harcama': 'Kasadan harcama',
  'cash.shift_count': 'Vardiya sayımı',
  'cash.teslim': 'Kasa teslimi',
  'customer.collect': 'Açık hesap tahsilatı',
  'customer.stamps': 'Damga hediyesi',
  'day.auto_skip': 'Otomatik gün sonu',
  'day.close': 'Gün sonu',
  'day.count': 'Kasa sayımı',
  'day.open': 'Gün açılışı',
  'day.recount': 'Yeniden sayım',
  'day.reopen': 'Günü yeniden açma',
  'delivery.done': 'Teslim',
  'delivery.undo': 'Teslimi geri alma',
  'floor.layout': 'Masa planı',
  'item.comp': 'İkram',
  'item.discount': 'Kalem indirimi',
  'item.discount_removed': 'İndirim kaldırma',
  'item.price_override': 'Elle fiyat',
  'item.uncomp': 'İkramı geri alma',
  'item.void': 'Kalem iptali',
  'item.zayi': 'Zayi',
  'menu.category': 'Kategori',
  'menu.happy': 'Happy hour',
  'menu.option_price': 'Seçenek fiyatı',
  'menu.option_sold_out': 'Seçenek tükendi / açıldı',
  'menu.price': 'Fiyat değişikliği',
  'menu.product': 'Ürün',
  'menu.product_delete': 'Ürün silme',
  'menu.product_groups': 'Seçenek grubu bağı',
  'menu.sync': 'Menü eşitleme',
  'okc.apply_failed': 'Yazarkasa işlenemedi',
  'okc.credit_limit': 'Açık hesap sınırı',
  'okc.underpaid': 'Eksik ödeme',
  'online.gone': 'Online sipariş',
  'order.bill': 'Hesap yazdırma',
  'order.cancel': 'Adisyon iptali',
  'order.comp': 'İkram',
  'order.discount': 'İndirim',
  'order.discount_removed': 'İndirim kaldırma',
  'order.merge': 'Birleştirme',
  'order.move': 'Masa taşıma',
  'order.numarator': 'Numaratör',
  'order.odenmez': 'Ödenmez',
  'order.reopen': 'Yeniden açma',
  'order.split': 'Hesap bölme',
  'order.transfer': 'Aktarma',
  'order.waiter': 'Garson değişikliği',
  'order.zayi': 'Zayi',
  'payment.refund': 'Ödeme iptali',
  'platform.accept': 'Platform kabulü',
  'platform.auto_accept': 'Otomatik kabul',
  'platform.auto_skip': 'Otomatik kabul edilmedi',
  'platform.product_map': 'Ürün eşleme',
  'platform.reject': 'Platform reddi',
  'platform.reject_try': 'Platform reddi denemesi',
  'platform.settings': 'Platform ayarı',
  'platform.settle': 'Platform ödemesi',
  'product.available': 'Satışta',
  'product.sold_out': 'Tükendi',
  'role.permissions': 'Rol yetkileri',
  'settings.servis_modu': 'Servis modu',
  'settings.update': 'Ayar değişikliği',
  'settings.z_start': 'İlk Z numarası',
  'sync.lafmaliyet_backfill': 'lafmaliyet aktarımı',
  'table.qr_created': 'Masa QR',
  'table.qr_rotated': 'Masa QR yenileme',
  'user.create': 'Personel ekleme',
  'user.pin_conflict': 'PIN çakışması',
  'user.update': 'Personel düzenleme',
};

const PREFIX_LABEL: Record<string, string> = {
  auth: 'Giriş',
  cash: 'Kasa hareketi',
  customer: 'Müşteri',
  day: 'Gün',
  delivery: 'Teslimat',
  floor: 'Masa planı',
  item: 'Kalem',
  menu: 'Menü',
  okc: 'Yazarkasa',
  online: 'Online sipariş',
  order: 'Adisyon',
  payment: 'Ödeme',
  platform: 'Paket platformu',
  product: 'Ürün',
  role: 'Rol yetkileri',
  room: 'Oda sayacı',
  settings: 'Ayar',
  sync: 'Senkron',
  table: 'Masa',
  // Mesai kaldırıldı (4 Kas 2026); eski kayıtlar (time.in, time.edit…) adıyla okunur kalır
  time: 'Mesai',
  user: 'Personel',
};

const actionLabel = (code: string): string | null => ACTION_LABEL[code] ?? PREFIX_LABEL[code.split('.')[0]] ?? null;

/**
 * Ayar kaydının iletisi: "Patron ayarları değiştirdi: <adlar>". Adlar tek listeden (`@shared/settings-labels`; sunucu
 * iletiyi de onunla yazar): yeni kayıtlar Türkçe adla gelir ve olduğu gibi kalır; kod adıyla yazılmış eski kayıtlar
 * ("businessName, receiptFooter"; Kaydet her alanı gönderiyordu: 35 ad) Türkçe adına çevrilir, listede olmayan ad
 * olduğu gibi kalır
 */
const SETTINGS_MARK = ' ayarları değiştirdi: ';

/** Ayar kaydının iletisi Türkçe alan adlarıyla; dörtten uzun liste kısalır, tamamı (`full`) ipucunda ve aramada */
function settingsText(a: AuditRow): { text: string; full: string } | null {
  if (a.action !== 'settings.update') return null;
  const at = a.message.indexOf(SETTINGS_MARK);
  if (at < 0) return null;
  // "Patron ayarları değiştirdi"
  const head = a.message.slice(0, at + SETTINGS_MARK.length - 2);
  const names = a.message
    .slice(at + SETTINGS_MARK.length)
    .split(', ')
    .filter(Boolean)
    .map(settingLabel);
  if (!names.length) return { text: head, full: head };
  const full = `${head}: ${names.join(', ')}`;
  return { full, text: names.length > 4 ? `${head}: ${names.slice(0, 3).join(', ')} ve ${names.length - 3} ayar daha` : full };
}

/** Denetim kaydı: Innex zaman çizelgesi (§1.5 "Zaman çizelgesi"), önem derecesine göre sayılı sekmeler */
export default function AuditAdmin() {
  const [severity, setSeverity] = useState<'tum' | 'uyari' | 'alarm'>('tum');
  const [q, setQ] = useState('');
  const data = useQuery({ queryKey: ['admin', 'audit'], queryFn: () => get<AuditRow[]>('/admin/audit?severity=tum&limit=300') });
  const all = useMemo(() => data.data ?? [], [data.data]);
  const rows = useMemo(() => {
    const k = fold(q.trim());
    return all.filter(
      (a) => (severity === 'tum' || a.severity === severity) && (!k || fold(`${a.message} ${settingsText(a)?.full ?? ''} ${actionLabel(a.action) ?? ''} ${a.action} ${a.userName ?? ''} ${a.approverName ?? ''}`).includes(k)),
    );
  }, [all, severity, q]);

  // Günlere bölünür (İstanbul takvim günü): gün başlıkta bir kez ("Bugün", "Dün", "1 Kasım 2026 Pazar"), satırda yalnız saat
  const today = istanbulParts(Date.now()).date;
  const dayName = (d: string) => (d === today ? 'Bugün' : d === addDays(today, -1) ? 'Dün' : fmtDateLong(d));
  const groups: { day: string; items: TimelineItem[] }[] = [];
  for (const a of rows) {
    const st = settingsText(a);
    // Kim ve ne, tek sakin satırda: "Kasa · Hesap yazdırma · onaylayan Müdür"; ileti kişinin adıyla başlıyorsa ad yinelenmez
    const meta = [a.userName && !a.message.startsWith(`${a.userName} `) ? a.userName : null, actionLabel(a.action), a.approverName && `onaylayan ${a.approverName}`].filter(Boolean).join(' · ');
    const item: TimelineItem = {
      key: String(a.id),
      tone: a.severity === 'alarm' ? 'danger' : a.severity === 'uyari' ? 'warning' : 'neutral',
      icon: a.severity === 'alarm' ? <AlertOctagon /> : a.severity === 'uyari' ? <AlertTriangle /> : <Info />,
      title: st ? <span title={st.full !== st.text ? st.full : undefined}>{st.text}</span> : a.message,
      description: meta ? <span className="text-xs text-[var(--admin-text-mute)]">{meta}</span> : undefined,
      // Tutar başlık satırının sağında, saatin solunda
      time:
        a.amount != null ? (
          <span className="inline-flex items-center gap-2">
            <Badge tone={a.severity === 'alarm' ? 'danger' : 'neutral'}>{tl(a.amount)}</Badge>
            {fmtTime(a.at)}
          </span>
        ) : (
          fmtTime(a.at)
        ),
    };
    const day = istanbulParts(a.at).date;
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  const query = q.trim();

  return (
    <>
      <PageHeader title="Denetim kaydı" description="İptal, ikram, indirim, kasa hareketi, gün sonu ve ayar izi; son 300 kayıt" />
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
      {data.isPending ? (
        <Card>
          <ListSkeleton rows={6} className="p-0" />
        </Card>
      ) : data.isError && !data.data ? (
        <ErrorState className={CARD} title="Denetim kaydı alınamadı" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : groups.length ? (
        <Card bodyClassName="[&_ol>li]:pb-4">
          <div className="space-y-6">
            {groups.map((g) => (
              <section key={g.day}>
                <h2 className="mb-3 text-[13px] font-semibold text-[var(--admin-text-mute)]">{dayName(g.day)}</h2>
                <Timeline items={g.items} />
              </section>
            ))}
          </div>
        </Card>
      ) : all.length === 0 ? (
        <EmptyState icon={<ClipboardList />} title="Henüz kayıt yok">
          İptal, ikram, indirim, kasa hareketi ve gün sonu yapıldıkça burada listelenir
        </EmptyState>
      ) : query ? (
        // Sonuçsuz arama: boş fincan tabağı ve aranan söz (Ürünler'deki gibi)
        <EmptyState
          art="arama"
          title={`“${query}” ile eşleşen kayıt yok`}
          action={
            <Button
              onClick={() => {
                setQ('');
                setSeverity('tum');
              }}
            >
              Süzgeci temizle
            </Button>
          }
        >
          Başka bir kelime deneyin ya da süzgeci temizleyin
        </EmptyState>
      ) : (
        // Boş Uyarı ya da Alarm sekmesi iyi haberdir: hata gibi görünmez (Genel bakış'taki "Her şey yolunda" çizimi)
        <EmptyState art="favori" title={severity === 'alarm' ? 'Alarm yok' : 'Uyarı yok'}>
          Son 300 kayıtta {severity === 'alarm' ? 'alarm' : 'uyarı'} düşmedi
        </EmptyState>
      )}
    </>
  );
}
