import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, CalendarCheck, Coins, EyeOff, Lock, MonitorSmartphone, Receipt, Wallet } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { parseTL, tl } from '@shared/money';
import { fmtDateLong, fmtTime } from '@shared/time';
import type { BusinessDayDTO, ShiftCountDTO, ZSummary } from '@shared/types';
import { Button, buttonClass } from '@/components/ui/Button';
import { Field, Input, Segmented } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';
import { Badge, Card, EmptyState, ErrorState, ListSkeleton, Notice, PageHeader, PageLoading } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { errorMessage, get, post } from '@/lib/api';
import { withApproval } from '@/lib/approval';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';
import { TypedAmount } from '../order/TypedAmount';
import { CashCount, type CountResult } from './CashCount';
import { ShiftCountsCard, ShiftHandoverModal } from './ShiftHandover';
import { ZView } from './ZView';

/** Kasa hareketi düğmesi: telefonda üç eşit sütuna sığar */
const MOVE_BTN = 'max-sm:gap-1.5 max-sm:px-2 max-sm:whitespace-normal max-sm:leading-tight max-[400px]:[&>svg]:hidden';

interface DayResponse {
  day: BusinessDayDTO | null;
  summary: ZSummary | null;
  movements: { id: string; kind: 'harcama' | 'teslim' | 'giris'; amount: number; description: string; userName: string | null; createdAt: number }[];
  /** Kör kasa: bu kullanıcı kasa rakamlarını görmez */
  blind?: boolean;
  /** Açık gün yokken bugünün kapanmış günü: bir iş gününe tek Z, yeni gün 05:00'ten sonra */
  closedToday?: BusinessDayDTO | null;
  /** Açık gün dünden kalmışsa uyarı metni: yeni satış alınmaz, önce gün sonu */
  stale?: string | null;
  /** Günün vardiya devirleri (kör kasada beklenen ve fark gizli) */
  shiftCounts?: ShiftCountDTO[];
}
interface DayListItem extends BusinessDayDTO {
  netSales: number | null;
  cashDiff: number | null;
  receipts: number | null;
}
interface DayDetail {
  day: BusinessDayDTO;
  summary: ZSummary;
  lafmaliyet: Record<string, unknown>;
  movements: DayResponse['movements'];
  shiftCounts?: ShiftCountDTO[];
}

const MOVE_LABEL = { harcama: 'Harcama', teslim: 'Teslim', giris: 'Kasaya giriş' };
const emptyCount = (): CountResult => ({ countedCash: 0, banknotes: {}, methodCounts: {} });

export default function CashPage() {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'bugun' | 'gecmis'>('bugun');
  const current = useQuery({ queryKey: ['cash', 'day'], queryFn: () => get<DayResponse>('/cash/day'), refetchInterval: 60_000 });
  const days = useQuery({ queryKey: ['cash', 'days'], queryFn: () => get<DayListItem[]>('/cash/days?limit=60'), enabled: tab === 'gecmis' && can('rapor.gor') });
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['cash', 'detail', selected], queryFn: () => get<DayDetail>(`/cash/days/${selected}`), enabled: !!selected });

  const [opening, setOpening] = useState('');
  const [moveKind, setMoveKind] = useState<null | 'harcama' | 'teslim' | 'giris'>(null);
  const [moveAmount, setMoveAmount] = useState('');
  const [moveDesc, setMoveDesc] = useState('');
  const [closing, setClosing] = useState(false);
  const [handover, setHandover] = useState(false);
  const [count, setCount] = useState<CountResult>(emptyCount());
  const [counted, setCounted] = useState(true);
  const [note, setNote] = useState('');
  const [zResult, setZResult] = useState<DayDetail | null>(null);
  const [fillFor, setFillFor] = useState<DayDetail | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const [moveError, setMoveError] = useState<{ amount?: string; desc?: string }>({});
  const descRef = useRef<HTMLInputElement>(null);
  // Kasa hareketi Enter'la da kaydedilir: istek sürerken ikinci basış ikinci hareketi yazmasın
  const moveBusy = useRef(false);
  const [moveSaving, setMoveSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['cash'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };

  const openDay = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await post('/cash/day/open', { openingCash: parseTL(opening || '0') ?? 0 });
      toast.ok('Gün açıldı, satışa hazır');
      setOpening('');
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Gece Z alındıktan sonra gelen müşteri: aynı gün yetkili onayıyla yeniden açılır, Z numarası değişmez
  const reopen = async (id: string) => {
    // Neden zorunlu (Z raporuna yazılır): düğme sessizce soluk kalmaz, ileti alanın altında
    if (!reopenReason.trim()) {
      setReasonError('Neden gerekli');
      reasonRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await withApproval((pin) => post(`/cash/days/${id}/reopen`, { reason: reopenReason, approverPin: pin }));
      if (res === null) return;
      toast.ok('Gün yeniden açıldı; kapatınca Z raporu ve lafmaliyet kaydı güncellenir');
      setReopenReason('');
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const openMove = (kind: 'harcama' | 'teslim' | 'giris') => {
    setMoveError({});
    setMoveKind(kind);
  };
  const addMove = async () => {
    if (!moveKind) return;
    const err = { amount: parseTL(moveAmount || '0') ? undefined : 'Tutarı girin', desc: moveKind === 'harcama' && !moveDesc.trim() ? 'Harcamanın açıklaması gerekli' : undefined };
    if (err.amount || err.desc) {
      setMoveError(err);
      if (!err.amount && err.desc) descRef.current?.focus();
      return;
    }
    if (moveBusy.current) return;
    moveBusy.current = true;
    setMoveSaving(true);
    try {
      const res = await withApproval((pin) => post('/cash/movements', { kind: moveKind, amount: parseTL(moveAmount) ?? 0, description: moveDesc, approverPin: pin }));
      if (res === null) return;
      toast.ok(`${MOVE_LABEL[moveKind]} kaydedildi`);
      setMoveKind(null);
      setMoveAmount('');
      setMoveDesc('');
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      moveBusy.current = false;
      setMoveSaving(false);
    }
  };

  const closeDay = async () => {
    setBusy(true);
    try {
      const cashCounts = {
        ...Object.fromEntries(Object.entries(count.banknotes).filter(([, n]) => n > 0).map(([k, n]) => [`b:${k}`, n])),
        ...Object.fromEntries(Object.entries(count.methodCounts).map(([k, v]) => [`m:${k}`, v])),
      };
      const res = await post<{ day: BusinessDayDTO; summary: ZSummary | null; lafmaliyet: Record<string, unknown> | null; blind?: boolean }>('/cash/day/close', {
        countedCash: counted ? count.countedCash : null,
        cashCounts,
        note: note || null,
      });
      setClosing(false);
      setCount(emptyCount());
      if (res.summary) setZResult({ day: res.day, summary: res.summary, lafmaliyet: res.lafmaliyet ?? {}, movements: [] });
      else toast.ok(`Gün kapandı (Z ${res.day.zNo}); sayım kaydedildi, fark yöneticinin ekranında`);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveCount = async () => {
    if (!fillFor) return;
    setBusy(true);
    try {
      // Kaydedilmiş sayımı değiştirmek yetkili onayı ister
      const done = await withApproval((pin) =>
        post(`/cash/days/${fillFor.day.id}/count`, { countedCash: count.countedCash, methodCounts: count.methodCounts, banknotes: count.banknotes, note: note || null, approverPin: pin }),
      );
      if (done === null) return;
      toast.ok('Kasa föyü kaydedildi');
      setFillFor(null);
      setCount(emptyCount());
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (current.isPending) return <PageLoading />;
  if (current.isError && !current.data) {
    return (
      <div className="grid h-full place-items-center p-4">
        <ErrorState title="Kasa bilgisi alınamadı" error={current.error} retrying={current.isFetching} onRetry={() => void current.refetch()} />
      </div>
    );
  }
  const day = current.data?.day ?? null;
  const summary = current.data?.summary ?? null;
  // Kör kasa: kasiyerin `kasa.rakam` yetkisi yoksa sunucu ara raporu ve beklenen nakdi göndermez
  const blind = current.data?.blind ?? false;
  const movements = current.data?.movements ?? [];
  const closedDay = day ? null : (current.data?.closedToday ?? null);

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      <PageHeader
        title="Kasa"
        subtitle={
          day
            ? joinMeta([`Z ${day.zNo}`, fmtDateLong(day.date), day.reopenedAt ? `yeniden açılış ${fmtTime(day.reopenedAt)}` : [`açılış ${fmtTime(day.openedAt)}`, day.openedByName].filter(Boolean).join(', ')])
            : 'Gün kapalı'
        }
        actions={
          <>
            {boot.integrations.okc.provider === 'simulator' && (
              <Link to="/cihaz" className={buttonClass('secondary')}>
                <MonitorSmartphone className="size-4" />
                Eğitim cihazı
              </Link>
            )}
            {/* Vardiya devri: gün içinde kasiyer değişirken çekmece sayımı (gün sonu değil) */}
            {tab === 'bugun' && day && !current.data?.stale && can('kasa.gun') && (
              <Button icon={<ArrowLeftRight className="size-4" />} onClick={() => setHandover(true)}>
                Vardiya devri
              </Button>
            )}
            {/* Gün sonu rutin bir kapanıştır: birincil yeşil; kırmızı iptal ve alarma ayrılır */}
            {tab === 'bugun' && day && can('kasa.gun') && (
              <Button variant="primary" icon={<Lock className="size-4" />} onClick={() => setClosing(true)}>
                Gün sonu (Z)
              </Button>
            )}
            {/* Telefonda kendi satırında, tam genişlik: eylemlerle aynı satıra sıkışıp "Geçmiş günler" kırpılmasın */}
            {can('rapor.gor') && (
              <Segmented
                className="max-sm:min-w-full max-sm:[&>button]:flex-1"
                label="Kasa görünümü"
                value={tab}
                onChange={(v) => {
                  setTab(v);
                  setSelected(null);
                }}
                options={[
                  { value: 'bugun', label: 'Bugün' },
                  { value: 'gecmis', label: 'Geçmiş günler' },
                ]}
              />
            )}
          </>
        }
      />

      {tab === 'bugun' && !day && closedDay && (
        <div className="mx-auto max-w-md">
          <Card>
            <div className="space-y-4 p-6 text-center">
              <span aria-hidden="true" className="mx-auto grid size-12 place-items-center rounded-2xl bg-surface-3 text-ink-2">
                <Lock className="size-6" />
              </span>
              <div>
                <h2 className="text-lg font-semibold tracking-[-0.01em]">Bugünün gün sonu alındı</h2>
                <p className="tabular mt-1 text-sm font-medium text-ink-2">{joinMeta([`Z ${closedDay.zNo}`, closedDay.closedAt && `kapanış ${fmtTime(closedDay.closedAt)}`])}</p>
                <p className="mt-1 text-pretty text-sm text-muted">Yeni gün 05:00’ten sonra açılır; kapanıştan sonra satış gerekirse günü yeniden açın</p>
              </div>
              {can('kasa.gun') ? (
                <>
                  <Field label="Neden" hint="zorunlu, Z raporuna yazılır" className="text-left" error={reasonError}>
                    <Input
                      ref={reasonRef}
                      value={reopenReason}
                      onChange={(e) => {
                        setReopenReason(e.target.value);
                        setReasonError(null);
                      }}
                      maxLength={200}
                      placeholder="Ör. kapanıştan sonra gelen müşteri"
                    />
                  </Field>
                  <Button variant="primary" size="lg" block loading={busy} onClick={() => reopen(closedDay.id)}>
                    Günü yeniden aç
                  </Button>
                  <p className="text-xs text-muted">Yetkili onayı gerekir. Gün yeniden kapanınca Z raporu ve lafmaliyet’teki kayıt güncellenir</p>
                </>
              ) : (
                <p className="text-sm text-muted">Günü yeniden açma yetkiniz yok. Kasiyer, müdür ya da patron açabilir</p>
              )}
            </div>
          </Card>
        </div>
      )}

      {tab === 'bugun' && !day && !closedDay && (
        <div className="mx-auto max-w-md">
          <Card>
            <div className="space-y-4 p-6 text-center">
              {/* Gün sonu kartıyla aynı ikon kutusu ve başlık ölçüsü */}
              <span aria-hidden="true" className="mx-auto grid size-12 place-items-center rounded-2xl bg-surface-3 text-ink-2">
                <CalendarCheck className="size-6" />
              </span>
              <div>
                <h2 className="text-lg font-semibold tracking-[-0.01em]">Günü aç</h2>
                <p className="mt-1 text-pretty text-sm text-muted">Çekmecedeki açılış nakdini girin. Gece 05:00’e kadarki satışlar bu güne yazılır</p>
              </div>
              {can('kasa.gun') ? (
                <>
                  {/* Kasa bilgisayarında tutar klavyeyle de yazılır (rakam, virgül, Backspace, Enter: günü aç) */}
                  <output aria-label="Açılış nakdi" aria-live="polite" className="tabular font-headline block rounded-2xl border border-line-strong bg-surface-2 px-4 py-3 text-right text-4xl font-semibold">
                    <TypedAmount text={opening} />
                  </output>
                  <Numpad decimal keyboard onEnter={() => void openDay()} onKey={(k) => setOpening(applyNumpadKey(opening, k, { decimal: true, maxLength: 9 }))} />
                  <Button variant="primary" size="xl" block loading={busy} onClick={openDay}>
                    Günü aç
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted">Günü açma yetkiniz yok. Kasiyer, müdür ya da patron açabilir</p>
              )}
            </div>
          </Card>
        </div>
      )}

      {tab === 'bugun' && day && (
        <div className="space-y-3">
          {current.data?.stale && (
            <Notice tone="warn" role="alert" title={current.data.stale}>
              Bu güne yeni adisyon ve ürün eklenmez; açık adisyonların ödemesi alınır. Gün sonunu aldıktan sonra yeni günü açın
            </Notice>
          )}
          {can('kasa.hareket') && (
            // Telefonda üç eşit sütun: dolgu daralır, dar telefonda ikon düşer ve etiket gerekirse iki satıra iner (kenara dayanmasın)
            <div className="grid grid-cols-3 gap-2 sm:flex">
              <Button icon={<ArrowUpFromLine className="size-4" />} className={MOVE_BTN} onClick={() => openMove('harcama')}>
                Harcama
              </Button>
              <Button icon={<Wallet className="size-4" />} className={MOVE_BTN} onClick={() => openMove('teslim')}>
                Teslim
              </Button>
              <Button icon={<ArrowDownToLine className="size-4" />} className={MOVE_BTN} onClick={() => openMove('giris')}>
                Kasaya giriş
              </Button>
            </div>
          )}

          {summary ? (
            <ZView day={day} summary={summary} lafmaliyet={null} title={`Ara rapor (X) · Z ${day.zNo}`} />
          ) : (
            // Kör kasa: başlıksız tek not; yetkinin adı ipucunda
            <div
              className="flex items-start gap-2.5 rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)] px-4 py-3 text-[13px] text-muted"
              title="Rakamları görmek için yöneticiden “Ara rapor (X) ve kasa rakamlarını görme” yetkisi isteyin"
            >
              <EyeOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p className="text-pretty">
                <span className="font-medium text-ink-2">Kör kasa</span>: ara rapor ve beklenen nakit bu rolde gizli. Gün sonunda çekmeceyi sayıp girin; farkı yönetici görür
              </p>
            </div>
          )}

          <ShiftCountsCard counts={current.data?.shiftCounts ?? []} />

          <Card title="Kasa hareketleri">
            {movements.length === 0 ? (
              <EmptyState compact icon={<Coins />} title="Bugün kasa hareketi yok">
                Harcama, teslim ve kasaya giriş burada listelenir
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {movements.map((m) => (
                  // Yön işaretle: giriş artı ve yeşil, çıkan para eksi
                  <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <Badge tone={m.kind === 'giris' ? 'green' : m.kind === 'teslim' ? 'blue' : 'red'}>{MOVE_LABEL[m.kind]}</Badge>
                    <span className="min-w-0 flex-1 truncate">{m.description}</span>
                    <span className="shrink-0 text-right text-xs text-muted sm:w-28">{joinMeta([m.userName, fmtTime(m.createdAt)])}</span>
                    <span className={cn('tabular w-24 shrink-0 text-right font-semibold', m.kind === 'giris' ? 'text-[var(--admin-success)]' : 'text-ink')}>
                      {m.kind === 'giris' ? '+' : '−'}
                      {tl(m.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {tab === 'gecmis' && !selected && (
        <Card>
          {days.isPending ? (
            <ListSkeleton rows={6} />
          ) : days.isError && !days.data ? (
            <ErrorState compact title="Geçmiş günler alınamadı" error={days.error} retrying={days.isFetching} onRetry={() => void days.refetch()} />
          ) : !days.data?.length ? (
            <EmptyState icon={<Receipt />} title="Henüz kapanmış gün yok">
              Gün sonu alınan günler Z raporlarıyla burada listelenir
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {days.data.map((d) => (
                <li key={d.id}>
                  <button onClick={() => setSelected(d.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-hover active:bg-press">
                    <span className="tabular w-14 font-semibold">Z {d.zNo}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block">{fmtDateLong(d.date)}</span>
                      <span className="text-xs text-muted">{d.closedAt ? `${d.receipts ?? 0} adisyon` : 'Açık'}</span>
                    </span>
                    {d.closedAt && d.cashDiff == null && <Badge tone="warn">Föy girilmedi</Badge>}
                    {d.cashDiff != null && d.cashDiff !== 0 && <Badge tone="red">Fark {tl(d.cashDiff)}</Badge>}
                    <span className="tabular w-28 text-right font-semibold">{d.netSales != null ? tl(d.netSales) : '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'gecmis' && selected && !detail.data && (
        // Detay gelene dek sayfa boş kalmaz: dönüş düğmesi ve iskelet ya da hata
        <div className="space-y-3">
          <Button onClick={() => setSelected(null)}>Listeye dön</Button>
          <Card>
            {detail.isError ? (
              <ErrorState compact title="Gün raporu alınamadı" error={detail.error} retrying={detail.isFetching} onRetry={() => void detail.refetch()} />
            ) : (
              <ListSkeleton rows={6} />
            )}
          </Card>
        </div>
      )}

      {tab === 'gecmis' && selected && detail.data && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Button onClick={() => setSelected(null)}>Listeye dön</Button>
            {detail.data.day.closedAt && can('kasa.gun') && (
              <Button icon={<Coins className="size-4" />} onClick={() => { setCount(emptyCount()); setNote(''); setFillFor(detail.data!); }}>
                {detail.data.summary.countedCash == null ? 'Kasa föyü gir' : 'Kasa föyünü düzelt'}
              </Button>
            )}
          </div>
          <ZView day={detail.data.day} summary={detail.data.summary} lafmaliyet={detail.data.lafmaliyet} />
          <ShiftCountsCard counts={detail.data.shiftCounts ?? []} />
        </div>
      )}

      <Modal
        open={!!moveKind}
        onClose={() => setMoveKind(null)}
        size="sm"
        title={moveKind ? MOVE_LABEL[moveKind] : ''}
        subtitle={moveKind === 'harcama' ? 'Kasadan yapılan masraf (lafmaliyet: kasadan çıkan)' : moveKind === 'teslim' ? 'Patrona ya da bankaya teslim edilen nakit' : 'Kasaya konan bozuk para vb.'}
      >
        <div className="space-y-3 p-4">
          <div>
            <output
              aria-label="Tutar"
              aria-live="polite"
              aria-invalid={!!moveError.amount || undefined}
              className={cn('tabular font-headline block rounded-2xl border bg-surface-2 px-4 py-3 text-right text-3xl font-semibold', moveError.amount ? 'border-[var(--admin-danger)]' : 'border-line-strong')}
            >
              <TypedAmount text={moveAmount} />
            </output>
            {moveError.amount && (
              <p role="alert" className="mt-1.5 text-[13px] text-danger-ink">
                {moveError.amount}
              </p>
            )}
          </div>
          <Numpad
            size="md"
            decimal
            keyboard
            onEnter={() => void addMove()}
            onKey={(k) => {
              setMoveAmount(applyNumpadKey(moveAmount, k, { decimal: true }));
              setMoveError((e) => ({ ...e, amount: undefined }));
            }}
          />
          <Field label="Açıklama" hint={moveKind === 'harcama' ? 'zorunlu' : 'isteğe bağlı'} error={moveError.desc}>
            <Input
              ref={descRef}
              value={moveDesc}
              onChange={(e) => {
                setMoveDesc(e.target.value);
                setMoveError((x) => ({ ...x, desc: undefined }));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.repeat) void addMove();
              }}
              enterKeyHint="done"
              placeholder={moveKind === 'harcama' ? 'Ör. süt (market), fiş no' : moveKind === 'teslim' ? 'Ör. bankaya yatırıldı' : 'Ör. bozuk para'}
            />
          </Field>
          <Button variant="primary" block loading={moveSaving} onClick={addMove}>
            Kaydet
          </Button>
        </div>
      </Modal>

      <Modal
        open={closing && (!!summary || blind)}
        onClose={() => setClosing(false)}
        size="lg"
        title={`Gün sonu · Z ${day?.zNo ?? ''}`}
        subtitle="Çekmeceyi sayın; banka POS slipi ve yemek kartı tutarlarını girin"
        footer={
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={!counted} onChange={(e) => setCounted(!e.target.checked)} className="size-5 accent-[var(--admin-primary)]" />
              Sayımı sonra gireceğim
            </label>
            <div className="flex-1" />
            <Button onClick={() => setClosing(false)}>Vazgeç</Button>
            <Button variant="danger" loading={busy} onClick={closeDay}>
              Günü kapat
            </Button>
          </div>
        }
      >
        <div className="space-y-4 p-5">
          {counted && <CashCount summary={summary} value={count} onChange={setCount} />}
          <Field label="Not">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ör. kart slipinde 1 işlem eksik" />
          </Field>
        </div>
      </Modal>

      <Modal open={!!fillFor} onClose={() => setFillFor(null)} size="lg" title={`Kasa föyü · Z ${fillFor?.day.zNo ?? ''}`} subtitle="Otomatik ya da sayımsız kapanan günün sayımı">
        <div className="space-y-4 p-5">
          {fillFor && <CashCount summary={fillFor.summary} value={count} onChange={setCount} />}
          <Field label="Not">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button variant="primary" block loading={busy} onClick={saveCount}>
            Föyü kaydet
          </Button>
        </div>
      </Modal>

      <Modal open={!!zResult} onClose={() => setZResult(null)} size="xl" title="Gün sonu alındı" subtitle="Z raporu ve lafmaliyet alanları">
        <div className="p-5">{zResult && <ZView day={zResult.day} summary={zResult.summary} lafmaliyet={zResult.lafmaliyet} />}</div>
      </Modal>
      <ShiftHandoverModal open={handover} onClose={() => setHandover(false)} summary={summary} />
    </div>
  );
}
