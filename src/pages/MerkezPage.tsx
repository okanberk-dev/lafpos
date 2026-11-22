import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LicenseState } from '@shared/lisans';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Field, Input, Segmented } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, Card, EmptyState, ErrorState, Notice, PageHeader, Skeleton } from '@/components/ui/misc';
import { Stage } from '@/components/ui/Stage';
import { errorMessage, get, post } from '@/lib/api';
import { disablePush, enablePush, pushState, type PushState } from '@/lib/push';
import { cn } from '@/lib/cn';
import { buildLabel } from '@/lib/text';
import { toast } from '@/lib/toast';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

interface Row {
  id: string;
  ad: string | null;
  surum: string | null;
  build: number | null;
  createdAt: number;
  lastSeen: number | null;
  online: boolean;
  gunAcik: boolean | null;
  guncelleme: { durum: string; mesaj: string; etiket: string; kurulumUyari?: string | null } | null;
  /** Gönderilen güncellemenin adımı: Gönderildi → Kasa aldı → Kuruluyor → Kuruldu / Kurulamadı (api/_merkez.ts deliveryStatus) */
  gonderim?: { etiket: string; ton: Tone } | null;
  lisans: { durum: 'bekliyor' | 'aktif' | 'pasif'; bitis?: string | null; state: LicenseState; message: string; soon?: boolean };
  mod: 'elle' | 'otomatik';
  hedef: number | null;
  gonderildi: number | null;
  bekleyen: boolean;
  /** Şube kodu (eski Merkez göndermez) */
  kod?: string | null;
  /** "Şimdi güncelle" istendi, kasa henüz almadı */
  istekBekliyor?: boolean;
}

interface Data {
  kurulumlar: Row[];
  enYeni: { version: string; build: number; date: string; not: string | null } | null;
  demo?: boolean;
}

const LICENSE_TONE: Record<LicenseState, Tone> = { aktif: 'success', deneme: 'info', uyari: 'warning', kapali: 'danger' };
const licenseTone = (r: Row): Tone => (r.lisans.state === 'aktif' && r.lisans.soon ? 'warning' : LICENSE_TONE[r.lisans.state]);
const licenseLabel = (r: Row) => (r.lisans.durum === 'bekliyor' && r.lisans.state === 'deneme' ? 'Onay bekliyor' : r.lisans.state === 'aktif' ? (r.lisans.soon ? 'Yakında bitiyor' : 'Aktif') : r.lisans.state === 'deneme' ? 'Deneme' : r.lisans.state === 'uyari' ? 'Uyarı' : 'Satış kapalı');
const updateTone = (d: string | undefined): Tone => (d === 'geri-dondu' || d === 'hata' ? 'warning' : d === 'guncel' ? 'success' : 'info');

export const merkezQuery = { queryKey: ['merkez'], queryFn: () => get<Data>('/merkez/kurulumlar'), refetchInterval: 30_000 };

/** Bir dükkânın ayarları: ad, lisans, güncellemenin nasıl gideceği */
function EditDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const qc = useQueryClient();
  const [ad, setAd] = useState(row.ad ?? '');
  const [kod, setKod] = useState(row.kod ?? '');
  const [lisans, setLisans] = useState<Row['lisans']['durum']>(row.lisans.durum);
  const [bitis, setBitis] = useState(row.lisans.bitis ?? '');
  const [mod, setMod] = useState<Row['mod']>(row.mod);
  const save = useMutation({
    mutationFn: () => post('/merkez/kurulum', { id: row.id, ad, kod, lisans, bitis: lisans === 'aktif' ? bitis || null : undefined, mod }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: merkezQuery.queryKey });
      toast.ok('Kaydedildi; dükkân birkaç dakika içinde alır');
      onClose();
    },
  });
  // Şimdi güncelle: kasa bir sonraki bağlantısında (en geç 5 dakika) yeni sürümü denetler ve indirir; gün açıksa gün
  // sonundan sonra kurar
  const update = useMutation({
    mutationFn: () => post<{ istenen: number }>('/merkez/simdi-guncelle', { ids: [row.id] }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: merkezQuery.queryKey });
      toast.ok('İstendi; dükkân birkaç dakika içinde denetler, gün kapalıyken kurar');
    },
    onError: (e) => toast.err(errorMessage(e)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={row.ad || 'Adsız dükkân'}
      subtitle={`Kuruluş ${fmtDateTime(row.createdAt)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Kaydet
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        <Field label="Dükkânın adı">
          <Input value={ad} maxLength={60} onChange={(e) => setAd(e.target.value)} placeholder="Örn. Tuzla" />
        </Field>
        <Field label="Şube kodu" hint="Harf, rakam ve tire; en çok 12 karakter. Fişin başlığında yazılır">
          <Input value={kod} maxLength={12} autoCapitalize="characters" spellCheck={false} onChange={(e) => setKod(e.target.value.toUpperCase())} placeholder="Örn. TZL" />
        </Field>
        {/* Düğme grubu <label> (Field) içine girmez: etikete dokunmak ilk düğmeye tıklardı (SettingsAdmin gibi) */}
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink-2">Lisans</div>
          <Segmented
            label="Lisans"
            value={lisans}
            onChange={setLisans}
            options={[
              { value: 'bekliyor', label: 'Onay bekliyor' },
              { value: 'aktif', label: 'Aktif' },
              { value: 'pasif', label: 'Pasif' },
            ]}
          />
        </div>
        {lisans === 'aktif' && (
          <Field label="Son gün" hint="Boş bırakılırsa süresiz">
            <Input type="date" value={bitis} onChange={(e) => setBitis(e.target.value)} />
          </Field>
        )}
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink-2">Güncelleme</div>
          <Segmented
            label="Güncelleme"
            value={mod}
            onChange={setMod}
            options={[
              { value: 'elle', label: 'Ben gönderince' },
              { value: 'otomatik', label: 'Otomatik' },
            ]}
          />
          <p className="mt-1.5 text-[13px] leading-5 text-muted">{mod === 'otomatik' ? 'Yeni sürüm çıkınca kendiliğinden gider' : 'Siz gönderince gider'}</p>
        </div>
        <p className="text-[13px] leading-5 text-muted">
          Bitişe 14 gün kala dükkânda uyarı çıkar. Pasif ya da süresi dolan lisansta önce uyarı, 7 gün sonra yeni satış kapanır; kasa internete ulaşamıyorsa satış hiç kapanmaz, yalnız uyarı
          kalır. Kayıtlar, raporlar ve tahsilat hep açık
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--admin-divider)] pt-4">
          <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={update.isPending} disabled={row.istekBekliyor} onClick={() => update.mutate()}>
            Şimdi güncelle
          </Button>
          <span className="min-w-0 flex-[1_1_14rem] text-pretty text-[13px] leading-5 text-muted">
            {row.istekBekliyor ? 'İstendi; dükkân bir sonraki bağlantısında alacak' : 'Dükkân birkaç dakika içinde yeni sürümü denetler; gün açıksa gün sonundan sonra kurar'}
          </span>
        </div>
        {save.isError && <Notice tone="danger">{errorMessage(save.error)}</Notice>}
      </div>
    </Modal>
  );
}

const PUSH_TEXT: Record<PushState, string> = {
  acik: 'Bu telefon bildirim alıyor: büyük iptal ve ikram, kasa farkı, uzun internet kesintisi, güncelleme ve Pavo gün sonu sorunları',
  kapali: 'Önemli olaylar bu telefona bildirim olarak gelsin. Eşikler kasada: Yönetim › Ağ ve uzaktan erişim',
  'ana-ekran': 'iPhone’da önce Paylaş › Ana Ekrana Ekle ile siteyi ana ekrana ekleyin, oradan açıp bildirimleri açın',
  engelli: 'Bu tarayıcıda bildirim izni kapalı; telefonun ayarlarından açın',
  desteklenmiyor: 'Bu tarayıcı bildirim desteklemiyor',
};

/** Bu telefonda bildirimler: aç, deneme gönder, kapat */
function PushCard({ readOnly }: { readOnly: boolean }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void pushState().then(setState, () => setState('desteklenmiyor'));
  }, []);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.ok(ok);
    } catch (e) {
      toast.err(e instanceof Error ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
      setState(await pushState().catch(() => 'desteklenmiyor' as const));
    }
  };
  if (!state) return null;
  return (
    <Card title="Telefon bildirimleri" actions={state === 'acik' ? <Badge tone="success" dot>Açık</Badge> : undefined}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-5">
        <p className="min-w-0 flex-[1_1_16rem] text-pretty text-sm text-muted">{PUSH_TEXT[state]}</p>
        {state === 'kapali' && (
          <Button variant="primary" loading={busy} disabled={readOnly} onClick={() => void run(enablePush, 'Bildirimler bu telefonda açıldı')}>
            Bu telefonda aç
          </Button>
        )}
        {state === 'acik' && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy} onClick={() => void run(() => post('/uzaktan/bildirim/dene'), 'Deneme bildirimi gönderildi')}>
              Deneme gönder
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void run(disablePush, 'Bildirimler bu telefonda kapandı')}>
              Kapat
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Dükkân satırı: seçim kutusu, ad ve durum; satıra basınca ayarlar */
function ShopRow({ row, selected, onToggle, onOpen, readOnly }: { row: Row; selected: boolean; onToggle: () => void; onOpen: () => void; readOnly: boolean }) {
  return (
    <li className="flex items-center gap-1 border-b border-[var(--admin-divider)] last:border-b-0">
      <label className="grid size-11 shrink-0 cursor-pointer place-items-center pl-2" title="Seç">
        <input type="checkbox" checked={selected} disabled={readOnly} onChange={onToggle} aria-label={`${row.ad || 'Adsız dükkân'} seç`} className="size-5 accent-[var(--admin-primary)] pointer-fine:size-4" />
      </label>
      <button type="button" onClick={onOpen} disabled={readOnly} className="flex min-h-[64px] min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1.5 py-3 pr-5 text-left disabled:cursor-default">
        <span className="min-w-0 flex-[1_1_12rem] max-sm:basis-full">
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', row.online ? 'bg-[var(--admin-primary)]' : 'bg-[var(--admin-border-strong,#c3cbc6)]')} />
            <span className="truncate font-semibold">{row.ad || 'Adsız dükkân'}</span>
            {row.kod && <span className="shrink-0 text-[13px] font-medium text-muted">{row.kod}</span>}
          </span>
          {/* Kurulu derleme ve bağlantı ayrı satırlarda: telefonda cümle ortasından kırılmaz */}
          <span className="mt-0.5 block text-[13px] leading-5 text-muted">{buildLabel(row.surum, row.build)}</span>
          <span className="block text-[13px] leading-5 text-muted">{row.online ? (row.gunAcik == null ? 'Çevrimiçi' : row.gunAcik ? 'Çevrimiçi · gün açık' : 'Çevrimiçi · gün kapalı') : row.lastSeen ? `Son görülme ${fmtDateTime(row.lastSeen)}` : 'Hiç bağlanmadı'}</span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          {row.bekleyen && <Badge tone="info">Güncelleme gönderilmedi</Badge>}
          {row.istekBekliyor && <Badge tone="info">Güncelleme istendi</Badge>}
          {/* Gönderilen güncelleme varsa onun adımı (Gönderildi 22:20 → Kasa aldı · gün sonunda kurulacak → Kuruluyor →
              Kuruldu 22:41 · sürüm … / Kurulamadı: …); yoksa güncelleme durumu: Güncel / Kasada seçim bekliyor / Sorun çıktı */}
          {row.gonderim ? (
            <Badge tone={row.gonderim.ton} title={row.guncelleme?.mesaj} className="max-w-full whitespace-normal">
              {row.gonderim.etiket}
            </Badge>
          ) : row.guncelleme && (
            <Badge tone={updateTone(row.guncelleme.durum)} title={row.guncelleme.mesaj}>
              {row.guncelleme.etiket}
            </Badge>
          )}
          {/* Güncelleme kurulumun kök dosyalarını ya da kısayollarını yenileyemedi: kasada LafPOS-Kur.cmd yeniden çalıştırılır */}
          {row.guncelleme?.kurulumUyari && (
            <Badge tone="warning" title={row.guncelleme.kurulumUyari}>
              Kurulumu yenileyin
            </Badge>
          )}
          <Badge tone={licenseTone(row)} dot title={row.lisans.message}>
            {licenseLabel(row)}
          </Badge>
        </span>
      </button>
    </li>
  );
}

/**
 * LafPOS Uzaktan › Merkez: dükkânlar, lisans ve seçerek güncelleme (api/_merkez.ts). Yeni kurulum internete ilk
 * çıktığında "Onay bekliyor" olarak gelir; sahip ad ve lisans verir, dükkânları seçip güncelleme gönderir
 */
export default function MerkezPage() {
  const qc = useQueryClient();
  const q = useQuery(merkezQuery);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Row | null>(null);
  const d = q.data;
  const readOnly = !!d?.demo;
  const rows = d?.kurulumlar ?? [];
  const waiting = rows.filter((r) => r.bekleyen);
  const send = useMutation({
    // Güncellemeyi şimdi gönder: hedef kanalın son sürümü ve kasaya "hemen denetle" isteği. Kasa en geç 5 dakikada alır,
    // indirir; gün açıksa kasada "Şimdi güncelle / Gün sonunda güncelle" sorulur, gün kapalıysa hemen kurulur
    mutationFn: (ids: string[]) => post<{ istenen: number }>('/merkez/simdi-guncelle', { ids }),
    onSuccess: (r) => {
      setPicked(new Set());
      void qc.invalidateQueries({ queryKey: merkezQuery.queryKey });
      toast.ok(`${r.istenen} dükkâna gönderildi; kasada "Şimdi" ya da "Gün sonunda" sorulacak`);
    },
    onError: (e) => toast.err(errorMessage(e)),
  });
  const targets = picked.size ? [...picked] : rows.length === 1 ? [rows[0]!.id] : [];
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Stage leafLabel="Merkez" float>
      <div className="lp-leaf-pad grid gap-[var(--grid-gap)]">
        <PageHeader
          title="Merkez"
          subtitle="Dükkânlar, lisanslar ve güncellemeler"
          actions={
            // Tek dükkân varken seçmeye gerek yok; birden çok dükkânda önce seçilir
            <Button variant="primary" ring disabled={!targets.length || readOnly} loading={send.isPending} onClick={() => send.mutate(targets)}>
              <Send aria-hidden="true" className="size-4" />
              {picked.size ? `Güncellemeyi şimdi gönder (${picked.size})` : 'Güncellemeyi şimdi gönder'}
            </Button>
          }
        />
        {readOnly && <Notice tone="info">Örnek görünüm: kafe bağlanınca gerçek dükkânlar burada görünür</Notice>}
        {d?.enYeni && waiting.length > 0 && (
          <Notice
            tone="info"
            title={`Yeni sürüm hazır: ${d.enYeni.version}`}
            action={
              !readOnly && (
                <Button size="sm" variant="secondary" onClick={() => setPicked(new Set(waiting.map((r) => r.id)))}>
                  Bekleyenleri seç
                </Button>
              )
            }
          >
            {d.enYeni.not ? `${d.enYeni.not} · ` : ''}
            {waiting.length} dükkâna henüz gönderilmedi
          </Notice>
        )}
        <Card title="Dükkânlar" subtitle={rows.length ? `${rows.length} kurulum · ${rows.filter((r) => r.online).length} çevrimiçi` : undefined}>
          {q.isPending ? (
            <div className="grid gap-3 p-5">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : q.isError && !d ? (
            <ErrorState compact title="Dükkânlar alınamadı" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
          ) : rows.length === 0 ? (
            <EmptyState compact title="Henüz dükkân yok">
              LafPOS kurulan bilgisayar internete bağlanınca burada "Onay bekliyor" olarak görünür
            </EmptyState>
          ) : (
            <ul>
              {rows.map((r) => (
                <ShopRow key={r.id} row={r} selected={picked.has(r.id)} onToggle={() => toggle(r.id)} onOpen={() => setEditing(r)} readOnly={readOnly} />
              ))}
            </ul>
          )}
        </Card>
        <PushCard readOnly={readOnly} />
      </div>
      {editing && <EditDialog row={editing} onClose={() => setEditing(null)} />}
    </Stage>
  );
}
