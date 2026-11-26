import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, Mic2, Plus, Printer, QrCode as QrCodeIcon, RefreshCw, Save, Trash2 } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { parseTL, tl } from '@shared/money';
import { tableQrUrl } from '@shared/table-qr';
import { Badge, CARD, DefRow, EmptyState, PageHeader, StatusTabs } from '@/components/admin/ui';
import { QrCode } from '@/components/QrCode';
import { Button } from '@/components/ui/Button';
import { confirmDialog, promptDialog } from '@/components/ui/Confirm';
import { Field, Input, NumberInput, Select } from '@/components/ui/Field';
import { ErrorState, Notice, Skeleton } from '@/components/ui/misc';
import { errorMessage, get, patch, post, put } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { printNow } from '@/lib/print';
import { toast } from '@/lib/toast';
import { useUnsavedGuard } from '@/lib/unsavedGuard';
import { layoutChanges, mergeServerTables, settleSaved } from '@/lib/floorLayout';

interface Section {
  id: string;
  name: string;
  sort: number;
  active: boolean;
}
interface Table {
  id: string;
  sectionId: string;
  name: string;
  seats: number;
  shape: 'square' | 'rect' | 'round' | 'bar';
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'masa' | 'oda';
  hourlyRate: number | null;
  siteTableCode: string | null;
  qrCode: string | null;
  active: boolean;
}

/**
 * A4 masa kartları (yazdırma): her kartta masanın QR'ı (sitenin masa adresi), adı ve işletme adı. Sayfa kuralı
 * index.css `.print-sheet`; kart bölünmez (`breakInside`). Sitenin kendi kart sayfasıyla aynı düzen.
 */
function TableCardsSheet({ tables, businessName }: { tables: Table[]; businessName: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10mm' }}>
      {tables.map((t) => (
        <section key={t.id} style={{ breakInside: 'avoid', border: '1px solid #999', borderRadius: 12, padding: 18, textAlign: 'center', color: '#0c0e1b', background: '#fff' }}>
          <QrCode value={tableQrUrl(t.qrCode ?? '')} label={`${t.name} QR kodu`} className="mx-auto w-full max-w-56 border-0" />
          <div style={{ marginTop: 10, fontSize: 22, fontWeight: 700 }}>{t.name}</div>
          <div style={{ marginTop: 4, fontSize: 13, color: '#5f594e' }}>Menü · Uygulamadan masaya sipariş</div>
          <div style={{ marginTop: 2, fontSize: 12, color: '#5f594e' }}>{businessName}</div>
        </section>
      ))}
    </div>
  );
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const snap = (v: number) => Math.round(v);
/** Klavyeyle taşıma ve boyutlandırma: ok başına planın %1'i (sürüklemenin adımı) */
const ARROWS: Partial<Record<string, [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
/** Yeni masanın boyu (planın yüzdesi) */
const NEW_W = 12;
const NEW_H = 16;

/**
 * Yeni masanın adı: bölümdeki adlandırmayı sürdürür (S1…S8 varsa S9), numaralı masa yoksa "Masa N"; salonda
 * kullanılan ad atlanır (kasada iki aynı adlı masa karışmasın)
 */
function nextTableName(section: Table[], all: Table[]): string {
  const taken = new Set(all.filter((t) => t.active).map((t) => t.name.toLocaleLowerCase('tr-TR')));
  const numbered = section.map((t) => /^(.*?)(\d+)$/.exec(t.name)).filter((m): m is RegExpExecArray => m != null);
  const freq = new Map<string, number>();
  for (const m of numbered) freq.set(m[1], (freq.get(m[1]) ?? 0) + 1);
  const prefix = [...freq].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Masa ';
  let n = Math.max(0, ...numbered.filter((m) => m[1] === prefix).map((m) => Number(m[2]))) + 1;
  while (taken.has(`${prefix}${n}`.toLocaleLowerCase('tr-TR'))) n++;
  const name = `${prefix}${n}`;
  return name.length <= 30 ? name : `Masa ${section.length + 1}`;
}

/** Yeni masaya boş yer: planı yukarıdan aşağı, soldan sağa tarar, masalar birbirine değmez; yer yoksa sol üst köşe */
function freeSpot(taken: Table[], w: number, h: number): { x: number; y: number } {
  const gap = 2;
  const clear = (x: number, y: number) => taken.every((t) => x >= t.x + t.w + gap || x + w + gap <= t.x || y >= t.y + t.h + gap || y + h + gap <= t.y);
  for (let y = 4; y + h <= 96; y += 4) for (let x = 4; x + w <= 96; x += 4) if (clear(x, y)) return { x, y };
  return { x: 5, y: 5 };
}

export default function FloorAdmin() {
  const boot = useBoot();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'floor'], queryFn: () => get<{ sections: Section[]; tables: Table[] }>('/admin/floor') });
  // Sitenin karaoke saat ücreti: ekran başına bir okuma (otomatik yoklama yok; docs/03-ENTEGRASYON.md §2.4)
  const sitePrice = useQuery({
    queryKey: ['admin', 'floor', 'site-karaoke-price'],
    queryFn: () => get<{ linked: boolean; hourlyMinor: number | null; error: string | null }>('/admin/floor/site-karaoke-price'),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [sectionId, setSectionId] = useState('');
  const [tables, setTables] = useState<Table[]>([]);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  // Çift gönderim olmasın: kayıt ve ekleme sürerken düğme döner gösterge alır
  const [busy, setBusy] = useState<'plan' | 'masa' | 'qr' | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const keysHint = useId();
  // `moved`: dokunup bırakmayı sürüklemeden ayırır (birkaç piksellik titreme masayı oynatmaz)
  const drag = useRef<{ id: string; mode: 'move' | 'size'; startX: number; startY: number; orig: Table; moved: boolean } | null>(null);

  // Sunucu verisi yalnız kendisi değişince yeniden kurulur (bölüm sekmesi değişince değil); sürüklenip kaydedilmemiş
  // masaların yeri korunur (öteki masada Kişi, Şekil, QR, kaldırma da listeyi yeniler)
  const dirtyRef = useRef(dirty);
  const tablesRef = useRef(tables);
  useEffect(() => {
    dirtyRef.current = dirty;
    tablesRef.current = tables;
  });
  useEffect(() => {
    if (!data.data) return;
    const server = data.data.tables;
    setTables((local) => mergeServerTables(server, local, dirtyRef.current));
  }, [data.data]);
  useEffect(() => {
    if (!sectionId && data.data?.sections[0]) setSectionId(data.data.sections[0].id);
  }, [data.data, sectionId]);
  // Sayaç ve kayıt yalnız yeri gerçekten değişen masalar (sürüklenip eski yerine bırakılan sayılmaz)
  const changes = layoutChanges(tables, data.data?.tables ?? [], dirty);
  // Kaydedilmemiş yerleşim: kenar çubuğu, geri, komut paleti ve sekme kapanırken sorulur (yoksa plan sessizce kaybolurdu)
  useUnsavedGuard(changes.length > 0);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'floor'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };

  // Paneldeki alanlar (Kişi, Ad, ücret) çıkınca kaydeder ve seçili masaya bağlı: seçim değişmeden önce odaktaki alan
  // bırakılır, yazılan değer kaydedilir (yoksa alan blur gelmeden DOM'dan kalkar, değer sessizce kaybolur)
  const select = (id: string | null) => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el !== document.body && !canvas.current?.contains(el)) el.blur();
    setSelected(id);
  };
  const onPointerDown = (e: React.PointerEvent, t: Table, mode: 'move' | 'size') => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: t.id, mode, startX: e.clientX, startY: e.clientY, orig: t, moved: false };
    select(t.id);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !canvas.current) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
    d.moved = true;
    const rect = canvas.current.getBoundingClientRect();
    const dx = ((e.clientX - d.startX) / rect.width) * 100;
    const dy = ((e.clientY - d.startY) / rect.height) * 100;
    setTables((all) =>
      all.map((t) => {
        if (t.id !== d.id) return t;
        if (d.mode === 'move') return { ...t, x: snap(clamp(d.orig.x + dx, 0, 100 - t.w)), y: snap(clamp(d.orig.y + dy, 0, 100 - t.h)) };
        return { ...t, w: snap(clamp(d.orig.w + dx, 4, 100 - t.x)), h: snap(clamp(d.orig.h + dy, 4, 100 - t.y)) };
      }),
    );
    setDirty((s) => new Set(s).add(d.id));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    // Dokunup bırakınca (sürüklemeden) düzenleme kartı dar ekranda planın altında kalır, telefonda çoğu ekranın dışında:
    // kart ekranın alt kısmından başlıyorsa ona kaydırılır (yan yana düzende ve kart zaten göz önündeyken kaydırma yok)
    const el = panel.current;
    if (!d || d.moved || !el || window.matchMedia('(min-width: 1280px)').matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.6) return;
    el.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  /** Klavye: Enter ya da boşluk seçer, oklar taşır, Shift ile oklar boyutlandırır (sürüklemeyle aynı sınırlar) */
  const onTileKey = (e: KeyboardEvent, t: Table) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(t.id);
      return;
    }
    const step = ARROWS[e.key];
    if (!step) return;
    e.preventDefault();
    const [dx, dy] = step;
    const resize = e.shiftKey;
    if (selected !== t.id) select(t.id);
    setTables((all) =>
      all.map((x) => {
        if (x.id !== t.id) return x;
        if (resize) return { ...x, w: clamp(x.w + dx, 4, 100 - x.x), h: clamp(x.h + dy, 4, 100 - x.y) };
        return { ...x, x: clamp(x.x + dx, 0, 100 - x.w), y: clamp(x.y + dy, 0, 100 - x.h) };
      }),
    );
    setDirty((s) => new Set(s).add(t.id));
  };

  const saveLayout = async () => {
    setBusy('plan');
    try {
      const sent = changes.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
      const before = data.data?.tables ?? [];
      await put('/admin/tables/layout', { tables: sent });
      // Kayıt sürerken sürüklenen masa işaretli kalır (yalnız gönderilen yerde duranlar düşer)
      const next = settleSaved(dirtyRef.current, tablesRef.current, sent, before);
      dirtyRef.current = next;
      setDirty(next);
      toast.ok('Masa planı kaydedildi');
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const addTable = async () => {
    setBusy('masa');
    try {
      // Bölümün düzenini sürdürür (ad ve boş yer): dolu bölümde yeni masa S1'in üstüne binip gözden kaçmaz; eklenen
      // masa seçili gelir, düzenleme kartında adı ve kişisi hemen değişir
      const here = tables.filter((t) => t.sectionId === sectionId && t.active);
      const name = nextTableName(here, tables);
      const r = await post<{ id: string }>('/admin/tables', { sectionId, name, seats: 2, shape: 'square', ...freeSpot(here, NEW_W, NEW_H), w: NEW_W, h: NEW_H });
      setSelected(r.id);
      toast.ok(`${name} eklendi; sürükleyip yerine koyun`);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const addSection = async () => {
    const name = await promptDialog({ title: 'Yeni bölüm', label: 'Bölüm adı', placeholder: 'Ör. Teras', confirmLabel: 'Bölümü ekle', tone: 'primary', required: true, maxLength: 40 });
    if (!name) return;
    try {
      const r = await post<{ id: string }>('/admin/sections', { name });
      setSectionId(r.id);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const updateTable = async (id: string, body: Partial<Table>) => {
    setTables((all) => all.map((t) => (t.id === id ? { ...t, ...body } : t)));
    try {
      await patch(`/admin/tables/${id}`, body);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
      refresh();
    }
  };

  /** Masa QR'ı: üret ya da yenile (yenilemede basılı eski kart o anda geçersiz olur) */
  const makeQr = async (t: Table, rotate = false) => {
    if (
      rotate &&
      !(await confirmDialog({
        title: `${t.name} masasının kodu yenilensin mi`,
        body: 'Eski kod siteye pasif olarak bildirilir; site alana dek eski kart menüyü açmaya devam eder. Yeni kartı yazdırıp eskisini masadan kaldırın',
        confirmLabel: 'Kodu yenile',
      }))
    )
      return;
    try {
      const r = await post<{ qrCode: string; changed: boolean }>(`/admin/tables/${t.id}/qr`, { rotate });
      setTables((all) => all.map((x) => (x.id === t.id ? { ...x, qrCode: r.qrCode } : x)));
      toast.ok(rotate ? `${t.name} kodu yenilendi; kartı yeniden yazdırın` : `${t.name} için QR üretildi`);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const makeAllQr = async () => {
    setBusy('qr');
    try {
      const r = await post<{ created: number }>('/admin/tables/qr', {});
      toast.ok(r.created ? `${r.created} masaya QR üretildi` : 'Bütün masaların QR kodu zaten var');
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const removeTable = async (t: Table) => {
    if (!(await confirmDialog({ title: `${t.name} plandan kaldırılsın mı`, body: 'Geçmiş adisyonlar değişmez', confirmLabel: 'Masayı kaldır' }))) return;
    setSelected(null);
    await updateTable(t.id, { active: false });
  };
  const printCards = (list: Table[]) => {
    const withCode = list.filter((t) => t.qrCode);
    if (!withCode.length) return toast.warn('Önce masalara QR üretin');
    printNow(<TableCardsSheet tables={withCode} businessName={boot.settings.businessName} />, { sheet: true });
  };

  const sections = data.data?.sections ?? [];
  const visible = tables.filter((t) => t.sectionId === sectionId && t.active);
  const sel = tables.find((t) => t.id === selected) ?? null;
  // Sitede ödenen blok kasada yeniden alınmaz ama aşan süre odanın saat ücretiyle alınır: iki fiyat aynı olmalı
  const siteHourly = sitePrice.data?.hourlyMinor ?? null;
  const priceMismatch = siteHourly ? tables.filter((t) => t.active && t.kind === 'oda' && t.hourlyRate !== siteHourly) : [];
  const qrTables = tables.filter((t) => t.active && t.kind === 'masa');
  const missingQr = qrTables.filter((t) => !t.qrCode).length;
  // Masa seçili değilken düzenleme kartı yalnız ipucuyla boş kalmasın: seçili bölümün özeti (plandan sayılır, istek yok)
  const sectionName = sections.find((s) => s.id === sectionId)?.name ?? '';
  const sectionMasa = visible.filter((t) => t.kind === 'masa');
  const sectionOda = visible.length - sectionMasa.length;
  const sectionSeats = sectionMasa.reduce((n, t) => n + t.seats, 0);
  const sectionQr = sectionMasa.filter((t) => t.qrCode).length;

  const header = (
    <PageHeader
      title="Masa planı"
      description="Masaları sürükleyin, köşeden boyutlandırın; QR ve karaoke odası da burada"
      actions={
        data.data ? (
          <>
            {missingQr > 0 ? (
              <Button icon={<QrCodeIcon className="size-4" />} loading={busy === 'qr'} onClick={makeAllQr}>
                Eksik QR’ları üret ({missingQr})
              </Button>
            ) : (
              <Button icon={<Printer className="size-4" />} onClick={() => printCards(qrTables)} disabled={!qrTables.length}>
                Masa kartlarını yazdır
              </Button>
            )}
            <Button icon={<Plus className="size-4" />} loading={busy === 'masa'} disabled={!sectionId} onClick={addTable}>
              Masa ekle
            </Button>
            <Button variant="primary" icon={<Save className="size-4" />} loading={busy === 'plan'} disabled={!changes.length} onClick={saveLayout}>
              Planı kaydet{changes.length ? ` (${changes.length})` : ''}
            </Button>
          </>
        ) : undefined
      }
    />
  );

  // Başlık ve açıklama hemen; plan gelene dek iskelet, alınamazsa neden ve yeniden dene
  if (data.isPending)
    return (
      <div>
        {header}
        <div role="status" aria-label="Yükleniyor…" className="grid items-start gap-4 xl:grid-cols-[1fr_320px]">
          <Skeleton className="aspect-[16/10] w-full rounded-[var(--r-card)]" />
          <Skeleton className="h-48 rounded-[var(--r-card)]" />
        </div>
      </div>
    );
  if (data.isError && !data.data)
    return (
      <div>
        {header}
        <ErrorState className={CARD} title="Masa planı alınamadı" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      </div>
    );

  return (
    <div>
      {header}
      {siteHourly != null && priceMismatch.length > 0 && (
        <Notice tone="warn" role="status" className="mb-4 text-[13px]">
          Sitedeki karaoke saat ücreti {tl(siteHourly)},{' '}
          {priceMismatch.map((t) => `${t.name} ${t.hourlyRate ? tl(t.hourlyRate) : 'ücretsiz'}`).join(', ')}. Sitede ödenen rezervasyonu aşan süre kasada odanın ücretiyle
          alınır; ikisini aynı tutun
        </Notice>
      )}
      {/* Bölüm sekmeleri ve yanında "Bölüm ekle": sekmeler telefonda kendi içinde kayar, düğme yerinde kalır (telefonda yalnız ikon) */}
      <div className="flex items-start gap-2 [&>[role=tablist]]:mx-0 [&>[role=tablist]]:min-w-0 [&>[role=tablist]]:flex-1 [&>[role=tablist]]:px-0">
        <StatusTabs label="Bölüm" value={sectionId} onChange={setSectionId} tabs={sections.map((s) => ({ value: s.id, label: s.name, count: tables.filter((t) => t.sectionId === s.id && t.active).length }))} />
        <Button icon={<Plus className="size-4" />} onClick={() => void addSection()} className="mb-4 shrink-0 max-sm:w-11 max-sm:px-0">
          <span className="max-sm:sr-only">Bölüm ekle</span>
        </Button>
      </div>
      <p id={keysHint} className="sr-only">
        Enter ile seçin; ok tuşları masayı taşır, Shift ile ok tuşları boyutlandırır
      </p>
      {/* items-start: uzun düzenleme paneli satırı uzatınca 16/10 plan, oranı yüzünden genişleyip kartı taşırıyordu */}
      <div className="grid items-start gap-4 xl:grid-cols-[1fr_320px]">
        <div
          ref={canvas}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          // Kesilen dokunuş (sistem hareketi, kaydırma) sürüklemeyi bırakır: masa sonraki harekette parmağı izlemez
          onPointerCancel={onPointerUp}
          onPointerDown={() => select(null)}
          // Plan yanındaki düzenleme kartıyla aynı kap (köşe 18, saç teli, zeminde aynı hafif gölge); noktalı zemin ızgara
          className="relative aspect-[16/10] w-full touch-none select-none rounded-[var(--r-card)] border border-[var(--card-line)] bg-[radial-gradient(circle_at_1px_1px,var(--admin-border-strong)_1px,transparent_0)] bg-[length:20px_20px] bg-[var(--admin-surface-2)] shadow-[var(--card-shadow)]"
        >
          {visible.length === 0 && (
            <div className="absolute inset-0 grid place-items-center p-4" onPointerDown={(e) => e.stopPropagation()}>
              {sections.length === 0 ? (
                <EmptyState bare icon={<LayoutGrid />} title="Henüz bölüm yok" action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => void addSection()}>Bölüm ekle</Button>}>
                  {/* Telefonda plan alçak: açıklama sığmaz, başlık ve düğme yeter */}
                  <span className="max-sm:hidden">Önce salon, bahçe ya da teras gibi bir bölüm ekleyin; masalar bölümün içine yerleşir</span>
                </EmptyState>
              ) : (
                <EmptyState bare icon={<LayoutGrid />} title="Bu bölümde masa yok" action={<Button variant="primary" icon={<Plus className="size-4" />} loading={busy === 'masa'} onClick={addTable}>Masa ekle</Button>}>
                  <span className="max-sm:hidden">Eklenen masa sol üst köşeye gelir; sürükleyip yerine koyun</span>
                </EmptyState>
              )}
            </div>
          )}
          {visible.map((t) => (
            <div
              key={t.id}
              // Klavye ve ekran okuyucu da seçer: Tab ile gelinir, Enter seçer, oklar taşır (aria-describedby)
              role="button"
              tabIndex={0}
              aria-pressed={selected === t.id}
              aria-label={`${t.name}, ${t.kind === 'oda' ? 'saatlik oda' : `${t.seats} kişilik`}${t.qrCode ? ', QR kodu var' : ''}`}
              aria-describedby={keysHint}
              // Karonun boyu salonun planından gelir (telefonda plan küçülür): 44 px taraması bu karoları saymaz
              data-tap-ok
              onPointerDown={(e) => onPointerDown(e, t, 'move')}
              onKeyDown={(e) => onTileKey(e, t)}
              data-table-id={t.id}
              style={{ left: `${t.x}%`, top: `${t.y}%`, width: `${t.w}%`, height: `${t.h}%` }}
              // Karo kitin karo köşesinde (12); seçili masa açık nane zeminde yeşil kenarlı (yönetimin seçim dili), ötekiler
              // beyaz ve hafif gölgeyle noktalı zeminden kalkar. Geçiş yalnız renkte: sürüklerken yer anında izler
              className={cn(
                // Adlı kap (tile): alçak karoda kişi sayısı çekilir, ad kalır (index.css tile-flat; küçük telefonda plan küçülür)
                'group absolute flex cursor-grab flex-col items-center justify-center gap-0.5 border px-1 text-center [container:tile/size] text-sm font-semibold leading-tight tracking-[-0.01em] text-[var(--admin-text)] transition-[border-color,background-color,box-shadow] duration-150 active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]',
                t.shape === 'round' ? 'rounded-full' : 'rounded-[var(--r-tile)]',
                selected === t.id
                  ? 'k-picked'
                  : 'border-[var(--admin-border-field)]/60 bg-[var(--admin-surface)] shadow-[var(--shadow-control)] hover:border-[var(--admin-border-field)]',
              )}
            >
              {t.name}
              {/* Oda kasadaki masa planı gibi mikrofon ve "Saatlik"le ayrılır (mor zemin değil: mor online siparişin rengi) */}
              <span className="inline-flex items-center gap-1 text-xs font-normal tabular-nums tracking-normal text-[var(--admin-text-mute)] tile-flat:hidden">
                {t.kind === 'oda' ? (
                  <>
                    <Mic2 aria-hidden="true" className="size-3" />
                    Saatlik
                  </>
                ) : (
                  `${t.seats} kişi`
                )}
              </span>
              {t.qrCode && <QrCodeIcon aria-hidden="true" className="absolute left-1.5 top-1.5 size-3.5 text-[var(--admin-text-mute)]" />}
              {/* Boyutlandırma kulpu yalnız seçili masada (farede üzerine gelince de): her masada hep görünen mavi köşe
                  gürültüydü. Görünen köşe 16 px; parmakla tutturulsun diye dokunma alanı 44 px (farede 24) */}
              <span
                onPointerDown={(e) => onPointerDown(e, t, 'size')}
                aria-hidden="true"
                className={cn(
                  'absolute -bottom-3 -right-3 z-[1] grid size-11 cursor-nwse-resize place-items-center transition-opacity pointer-fine:-bottom-1 pointer-fine:-right-1 pointer-fine:size-6',
                  selected === t.id ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100',
                )}
              >
                <span className="size-4 rounded-sm border-b-2 border-r-2 border-[var(--admin-primary)]" />
              </span>
            </div>
          ))}
        </div>
        {/* İç pay kitin kartıyla aynı (telefonda 16, genişte 20) */}
        <div ref={panel} className={cn(CARD, 'scroll-m-4 p-4 sm:p-5')}>
          {!sel ? (
            <>
              <EmptyState bare icon={<LayoutGrid />} title="Masa seçilmedi">
                Düzenlemek için plandan bir masaya dokunun
              </EmptyState>
              {visible.length > 0 && (
                <div className="mt-2 border-t border-[var(--admin-divider)] pt-3">
                  <p className="mb-1 text-[13px] font-medium text-[var(--admin-text-mute)]">{sectionName}</p>
                  {sectionMasa.length > 0 && (
                    <>
                      <DefRow label="Masa">
                        <span className="tabular-nums">{sectionMasa.length}</span>
                      </DefRow>
                      <DefRow label="Kapasite">
                        <span className="tabular-nums">{sectionSeats} kişi</span>
                      </DefRow>
                      <DefRow label="QR kodu olan">
                        <span className="tabular-nums">
                          {sectionQr} / {sectionMasa.length}
                        </span>
                      </DefRow>
                    </>
                  )}
                  {sectionOda > 0 && (
                    <DefRow label="Saatlik oda">
                      <span className="tabular-nums">{sectionOda}</span>
                    </DefRow>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-4">
              {/* Başlık kitin kart başlığı (16/600); alanlardan saç teliyle ayrılır */}
              <div className="border-b border-[var(--admin-divider)] pb-3">
                <h3 className="text-base font-semibold leading-6 tracking-[-0.015em] text-[var(--admin-text)]">{sel.name}</h3>
                {/* Klavyeli cihazda: seçili masa oklarla da taşınır */}
                <p className="mt-0.5 text-[13px] text-[var(--admin-text-mute)] pointer-coarse:hidden">Ok tuşları taşır, Shift ile boyutlandırır</p>
              </div>
              <Field label="Ad">
                <Input defaultValue={sel.name} key={`n${sel.id}`} onBlur={(e) => e.target.value.trim() && e.target.value !== sel.name && updateTable(sel.id, { name: e.target.value.trim() })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Kişi">
                  <NumberInput key={`s${sel.id}`} value={sel.seats} min={1} max={40} onCommit={(seats) => updateTable(sel.id, { seats })} />
                </Field>
                <Field label="Şekil">
                  <Select value={sel.shape} onChange={(e) => updateTable(sel.id, { shape: e.target.value as Table['shape'] })}>
                    <option value="square">Kare</option>
                    <option value="rect">Dikdörtgen</option>
                    <option value="round">Yuvarlak</option>
                    <option value="bar">Bar tezgâhı</option>
                  </Select>
                </Field>
              </div>
              <Field label="Tür">
                <Select value={sel.kind} onChange={(e) => updateTable(sel.id, { kind: e.target.value as Table['kind'] })}>
                  <option value="masa">Masa</option>
                  <option value="oda">Oda (saatlik ücret, sayaç)</option>
                </Select>
              </Field>
              {sel.kind === 'oda' && (
                <Field label="Saatlik ücret (₺)" hint={siteHourly != null ? `Sitede ${tl(siteHourly)}` : undefined}>
                  <Input defaultValue={sel.hourlyRate ? String(sel.hourlyRate / 100) : ''} key={`r${sel.id}`} inputMode="decimal" onBlur={(e) => updateTable(sel.id, { hourlyRate: parseTL(e.target.value || '0') || null })} />
                </Field>
              )}
              <Field label="Sitedeki masa adı" hint="Sitede ayrı adla tanımlı masanın online siparişini bu masaya düşürür; QR kodu olan masada gerekmez">
                <Input defaultValue={sel.siteTableCode ?? ''} key={`c${sel.id}`} placeholder="Ör. Masa 4" spellCheck={false} onBlur={(e) => updateTable(sel.id, { siteTableCode: e.target.value.trim() || null })} />
              </Field>
              {sel.kind === 'masa' && (
              <div className="space-y-2 rounded-xl border border-[var(--admin-border)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-[var(--admin-text-soft)]">Masa QR</span>
                  {sel.qrCode ? <Badge tone="success">Kod var</Badge> : <Badge>Kod yok</Badge>}
                </div>
                {sel.qrCode ? (
                  <>
                    <div className="flex items-start gap-3">
                      <QrCode value={tableQrUrl(sel.qrCode)} label={`${sel.name} QR kodu`} className="size-28" />
                      <div className="min-w-0 space-y-1 text-xs text-[var(--admin-text-mute)]">
                        <p className="break-all font-mono text-[13px] font-semibold text-[var(--admin-text)]">{sel.qrCode}</p>
                        <p className="break-all">{tableQrUrl(sel.qrCode)}</p>
                        <p>Müşteri okutunca sitenin menüsü açılır, uygulamadan bu masaya sipariş verir; sipariş kasada bu masaya düşer</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" icon={<Printer className="size-4" />} onClick={() => printCards([sel])}>
                        Kartı yazdır
                      </Button>
                      <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} onClick={() => void makeQr(sel, true)}>
                        Kodu yenile
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-[var(--admin-text-mute)]">Masaya özel QR: müşteri okutunca uygulamadan bu masaya sipariş verir, sipariş kasada masaya düşer. Kodu LafPOS üretir, sitenin biçimiyle</p>
                    <Button size="sm" icon={<QrCodeIcon className="size-4" />} onClick={() => void makeQr(sel)}>
                      QR üret
                    </Button>
                  </>
                )}
              </div>
              )}
              <Button variant="dangerOutline" icon={<Trash2 className="size-4" />} onClick={() => void removeTable(sel)}>
                Masayı kaldır
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
