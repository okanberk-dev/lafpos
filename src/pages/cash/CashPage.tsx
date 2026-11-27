import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, ChevronLeft, ChevronRight, Coins, EyeOff, FileText, Lock, MonitorSmartphone, Receipt, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { parseTL, tl, tlPlain } from '@shared/money';
import { BANK_RECIPIENT, cleanRecipientName, RECIPIENT_MAX } from '@shared/teslim';
import { fmtDateLong, fmtTime } from '@shared/time';
import type { BusinessDayDTO, ShiftCountDTO, ZSummary } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Chip, Field, Input, Label } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';
import { Badge, Card, EmptyState, ErrorState, ListSkeleton, Notice, PageLoading } from '@/components/ui/misc';
import { Stage } from '@/components/ui/Stage';
import { cn } from '@/lib/cn';
import { ApiError, errorMessage, get, post } from '@/lib/api';
import { withApproval } from '@/lib/approval';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { closeDayBody, countStarted, type CountResult, emptyCount, savedCount } from '@/lib/cashCount';
import { type OpeningSuggestion, openingSourceText } from '@/lib/lafmaliyet';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';
import { TypedAmount } from '../order/TypedAmount';
import { Illustration } from '@/components/Illustration';
import { CashCount, signedTL } from './CashCount';
import { ShiftCountsCard, ShiftHandoverModal } from './ShiftHandover';
import { ZView } from './ZView';
import { DayCloseGuide } from './DayCloseGuide';
import { DayCloseDone, DayCloseSummary } from './DayCloseSummary';
import { WorkedStaffCard, type WorkedDTO } from './WorkedStaff';

/** Kasa hareketi düğmesi: telefonda üç eşit sütuna sığar */
const MOVE_BTN = 'max-sm:gap-1.5 max-sm:px-2 max-[400px]:[&>svg]:hidden';

type MoveKind = 'harcama' | 'teslim' | 'giris';
export interface Movement {
  id: string;
  kind: MoveKind;
  amount: number;
  description: string;
  userName: string | null;
  createdAt: number;
  /** Harcamanın lafmaliyet gider kategorisi (yazıldığı andaki adı) */
  categoryName?: string | null;
  /** Teslimde parayı alan (kullanıcıysa kimliği; adı yazıldığı anki hâliyle); eski teslimde ve eski sunucuda yok */
  recipientUserId?: string | null;
  recipientName?: string | null;
}
/**
 * Teslim penceresinde "Kime" seçimi: patron ya da müdür hesabı, Banka ya da elle yazılan ad ("Başka"). null: seçilmedi
 */
type RecipientPick = { kind: 'user'; userId: string } | { kind: 'bank' } | { kind: 'other' } | null;
/** lafmaliyet'in personelin seçebildiği gider kategorisi (GET /cash/expense-categories) */
interface ExpenseCategory {
  id: number;
  name: string;
}
/**
 * Açılış önerisi (kasa zinciri): rakam gören kullanıcıya beklenen tutar, kaynağı ve devrin günü; kör kasiyere yalnız
 * "beklenen var" (`check`). Beklenen bilinmiyorsa null
 */
type OpeningHint = OpeningSuggestion | { check: true };
interface DayResponse {
  day: BusinessDayDTO | null;
  summary: ZSummary | null;
  movements: Movement[];
  /** Kör kasa: bu kullanıcı kasa rakamlarını görmez */
  blind?: boolean;
  /** Açık gün yokken bugünün kapanmış günü: bir iş gününe tek Z, yeni gün 05:00'ten sonra */
  closedToday?: BusinessDayDTO | null;
  /** Açık gün dünden kalmışsa uyarı metni: yeni satış alınmaz, önce gün sonu */
  stale?: string | null;
  /** Günün vardiya devirleri (kör kasada beklenen ve fark gizli) */
  shiftCounts?: ShiftCountDTO[];
  /** Gün kapalıyken: açılış önerisi (eski sunucu göndermez) */
  opening?: OpeningHint | null;
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
  movements: Movement[];
  shiftCounts?: ShiftCountDTO[];
  /** Gün sonu notu */
  note?: string | null;
  /** Kaydedilmiş sayım: `b:<kuruş>` banknot adedi, `m:<ödeme türü>` sayılan tutar; föy düzeltilirken pencereye gelir */
  cashCounts?: Record<string, number> | null;
  /** "Bugün çalışanlar" (lafmaliyet'in yemek kartı günleri; eski sunucu göndermez) */
  worked?: WorkedDTO;
}

const MOVE_KINDS: MoveKind[] = ['harcama', 'teslim', 'giris'];
const MOVE_LABEL: Record<MoveKind, string> = { harcama: 'Harcama', teslim: 'Teslim', giris: 'Kasaya giriş' };
const MOVE_ICON = { harcama: ArrowUpFromLine, teslim: Wallet, giris: ArrowDownToLine } satisfies Record<MoveKind, unknown>;
const MOVE_HINT: Record<MoveKind, string> = { harcama: 'Kasadan nakit çıkan masraf', teslim: 'Kasadan çıkıp birine ya da bankaya verilen nakit', giris: 'Kasaya eklenen nakit (bozuk para gibi)' };
const MOVE_SAVE: Record<MoveKind, string> = { harcama: 'Harcamayı kaydet', teslim: 'Teslimi kaydet', giris: 'Girişi kaydet' };

/** En az bu kadar farkta (kuruş) açılışın nedeni zorunlu (sunucudaki `OPENING_REASON_MIN`, lafmaliyet'in 1 TL toleransı) */
const OPENING_REASON_MIN = 100;

export default function CashPage() {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'bugun' | 'gecmis'>('bugun');
  const current = useQuery({ queryKey: ['cash', 'day'], queryFn: () => get<DayResponse>('/cash/day'), refetchInterval: 60_000 });
  const days = useQuery({ queryKey: ['cash', 'days'], queryFn: () => get<DayListItem[]>('/cash/days?limit=60'), enabled: tab === 'gecmis' && can('rapor.gor') });
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['cash', 'detail', selected], queryFn: () => get<DayDetail>(`/cash/days/${selected}`), enabled: !!selected });
  // Kapanış saati bildiriminin "Gün sonu al"ı (/kasa?gunsonu=1): gün açıksa ve yetki varsa gün sonu penceresi açılır;
  // her durumda parametre adresten silinir (geri ya da yenile pencereyi yeniden açmasın)
  const [params, setParams] = useSearchParams();
  const askClose = params.get('gunsonu') === '1';

  const [opening, setOpening] = useState('');
  // Açılışın nedeni: rakam gören kullanıcıda fark ₺1,00 ve üstündeyse, kör kasiyerde sunucu farkı söyleyince istenir.
  // `openingAsked`: sunucunun reddettiği tutar ve iletisi; tutar değişince ekran yeniden sormadan sunucuya bırakır
  const [openingReason, setOpeningReason] = useState('');
  const [openingAsked, setOpeningAsked] = useState<{ message: string; amount: number } | null>(null);
  const [openingReasonError, setOpeningReasonError] = useState<string | null>(null);
  const openingReasonRef = useRef<HTMLInputElement>(null);
  const [moveKind, setMoveKind] = useState<null | MoveKind>(null);
  const [moveAmount, setMoveAmount] = useState('');
  const [moveDesc, setMoveDesc] = useState('');
  const [moveCategory, setMoveCategory] = useState<number | null>(null);
  // Teslimde paranın kime verildiği (zorunlu): hesap, Banka ya da elle yazılan ad
  const [moveRecipient, setMoveRecipient] = useState<RecipientPick>(null);
  const [moveRecipientText, setMoveRecipientText] = useState('');
  const recipientRef = useRef<HTMLInputElement>(null);
  // Harcama kategorileri: pencere açılınca son liste gelir, lafmaliyet'ten gelen yenisi ekranı kendiliğinden yeniler
  const categories = useQuery({
    queryKey: ['cash', 'categories'],
    queryFn: () => get<{ items: ExpenseCategory[] }>('/cash/expense-categories'),
    enabled: moveKind === 'harcama',
    staleTime: 60_000,
  });
  const [closing, setClosing] = useState(false);
  // Pencere yalnız istekten sonra çekilmiş veriyle açılır (önbellekteki gün kapanmış ya da başka kişinin olabilir).
  // Parametre gelince gün yeniden çekilir (sürmekte olan çekim varsa o beklenir): önbellek tazeyken (15 sn) sayfa
  // açılışta çekmez, pencere 60 sn'lik yoklamayı beklemesin (inceleme, 26 Kasım 2026; tests/kapanis-teslim.test.ts).
  // Çekilemezse pencere açılmaz, parametre yine silinir
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const refetchDay = current.refetch;
  useEffect(() => {
    if (!askClose) return;
    setAskedAt(Date.now());
    void refetchDay({ cancelRefetch: false });
  }, [askClose, refetchDay]);
  useEffect(() => {
    if (!askClose || askedAt == null || current.isFetching) return;
    const fresh = current.dataUpdatedAt >= askedAt;
    if (!fresh && current.errorUpdatedAt < askedAt) return;
    const d = fresh ? current.data : undefined;
    if (d?.day && can('kasa.gun') && (d.summary || d.blind)) {
      setTab('bugun');
      setSelected(null);
      setClosing(true);
    }
    setAskedAt(null);
    const next = new URLSearchParams(params);
    next.delete('gunsonu');
    setParams(next, { replace: true });
  }, [askClose, askedAt, current.data, current.dataUpdatedAt, current.errorUpdatedAt, current.isFetching, can, params, setParams]);
  const [handover, setHandover] = useState(false);
  const [count, setCount] = useState<CountResult>(emptyCount());
  const [counted, setCounted] = useState(true);
  const [note, setNote] = useState('');
  const [zResult, setZResult] = useState<DayDetail | null>(null);
  // Föy düzeltmenin kendi sayımı ve notu: gün sonu penceresinin yarım kalan sayımına karışmaz
  const [fillFor, setFillFor] = useState<DayDetail | null>(null);
  const [fillCount, setFillCount] = useState<CountResult>(emptyCount());
  const [fillNote, setFillNote] = useState('');
  const [reopenReason, setReopenReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const [moveError, setMoveError] = useState<{ amount?: string; desc?: string; recipient?: string }>({});
  const descRef = useRef<HTMLInputElement>(null);
  // Kasa hareketi Enter'la da kaydedilir: istek sürerken ikinci basış ikinci hareketi yazmasın
  const moveBusy = useRef(false);
  const [moveSaving, setMoveSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['cash'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };

  const openingHint = current.data?.opening ?? null;
  const openingCash = parseTL(opening || '0') ?? 0;
  const openingDiff = openingHint && 'suggested' in openingHint ? openingCash - openingHint.suggested : null;
  const openingOverLimit = openingDiff != null && Math.abs(openingDiff) >= OPENING_REASON_MIN;
  // Sunucu bu tutarı reddetti (kör kasiyer farkı yalnız böyle öğrenir): aynı tutarla neden zorunlu. Kasiyer yeniden sayıp
  // başka tutar yazarsa alan açık kalır ama zorunlu değildir: farkı yine sunucu söyler (ekran tahmin etmez)
  const openingAskedNow = openingAsked != null && openingAsked.amount === openingCash;
  // Neden alanı: rakam gören kullanıcıda fark eşiği geçince, kör kasiyerde sunucu sorunca (tutar ve yön söylenmez)
  const openingNeedsReason = openingOverLimit || openingAsked != null;
  const typeOpening = (text: string) => {
    setOpening(text);
    setOpeningReasonError(null);
  };

  const openDay = async () => {
    if (busy) return;
    if ((openingOverLimit || openingAskedNow) && !openingReason.trim()) {
      setOpeningReasonError(openingAskedNow ? openingAsked.message : 'Farkın nedeni gerekli');
      openingReasonRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      // Görünmeyen alanın eski yazısı gitmez
      await post('/cash/day/open', { openingCash, reason: (openingNeedsReason && openingReason.trim()) || null });
      toast.ok('Gün açıldı, satışa hazır');
      setOpening('');
      setOpeningReason('');
      setOpeningAsked(null);
      setOpeningReasonError(null);
      refresh();
    } catch (e) {
      // Sayım beklenenden farklı: neden alanı açılır, ileti altında (kör kasiyerde tutarsız)
      if (e instanceof ApiError && e.code === 'opening_reason_required') {
        setOpeningAsked({ message: e.message, amount: openingCash });
        setOpeningReasonError(e.message);
        requestAnimationFrame(() => openingReasonRef.current?.focus());
      } else toast.err(errorMessage(e));
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

  const openMove = (kind: MoveKind) => {
    setMoveError({});
    setMoveCategory(null);
    setMoveRecipient(null);
    setMoveRecipientText('');
    setMoveKind(kind);
  };
  // Teslimi alabilecek hesaplar: patron ve müdür (kasiyer kasayı devrederse Vardiya devri'dir); geri kalanı Başka
  const recipients = boot.users.filter((u) => u.active && (u.role === 'patron' || u.role === 'mudur'));
  const pickRecipient = (p: Exclude<RecipientPick, null>) => {
    setMoveRecipient(p);
    setMoveError((x) => ({ ...x, recipient: undefined }));
    if (p.kind === 'other') requestAnimationFrame(() => recipientRef.current?.focus());
  };
  // Teslimin alıcısı gövdede: hesapta kimliği (ad sunucuda o anki hâliyle yazılır), Banka'da ve elle yazılanda ad
  const recipientBody = () => {
    if (moveKind !== 'teslim' || !moveRecipient) return {};
    if (moveRecipient.kind === 'user') return { recipientUserId: moveRecipient.userId };
    return { recipientName: moveRecipient.kind === 'bank' ? BANK_RECIPIENT : cleanRecipientName(moveRecipientText) };
  };
  const addMove = async () => {
    if (!moveKind) return;
    const recipientMissing = moveKind === 'teslim' && (!moveRecipient || (moveRecipient.kind === 'other' && !cleanRecipientName(moveRecipientText)));
    const err = {
      amount: parseTL(moveAmount || '0') ? undefined : 'Tutarı girin',
      desc: moveKind === 'harcama' && !moveDesc.trim() ? 'Harcamanın açıklaması gerekli' : undefined,
      recipient: recipientMissing ? (moveRecipient?.kind === 'other' ? 'Teslim alanın adını yazın' : 'Kime teslim edildiğini seçin') : undefined,
    };
    if (err.amount || err.desc || err.recipient) {
      setMoveError(err);
      if (!err.amount && err.recipient && moveRecipient?.kind === 'other') recipientRef.current?.focus();
      else if (!err.amount && !err.recipient && err.desc) descRef.current?.focus();
      return;
    }
    if (moveBusy.current) return;
    moveBusy.current = true;
    setMoveSaving(true);
    try {
      const categoryId = moveKind === 'harcama' ? moveCategory : null;
      const res = await withApproval((pin) => post('/cash/movements', { kind: moveKind, amount: parseTL(moveAmount) ?? 0, description: moveDesc, categoryId, ...recipientBody(), approverPin: pin }));
      if (res === null) return;
      toast.ok(`${MOVE_LABEL[moveKind]} kaydedildi`);
      setMoveKind(null);
      setMoveAmount('');
      setMoveDesc('');
      setMoveCategory(null);
      setMoveRecipient(null);
      setMoveRecipientText('');
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
      // Dokunulmamış sayaç "Sayılmadı"dır: gün ₺0 sayılmış gibi değil, sayımsız kapanır (föy sonra girilir)
      const body = closeDayBody(count, !counted, note);
      const res = await post<{ day: BusinessDayDTO; summary: ZSummary | null; lafmaliyet: Record<string, unknown> | null; blind?: boolean }>('/cash/day/close', body);
      setClosing(false);
      setCount(emptyCount());
      // Sonuç penceresi günün hareketlerini de gösterir (kayda ne geçti, teslim kime)
      if (res.summary) setZResult({ day: res.day, summary: res.summary, lafmaliyet: res.lafmaliyet ?? {}, movements, shiftCounts });
      else
        toast.ok(
          body.countedCash == null
            ? `Ayrıntılı gün sonu alındı (Z ${res.day.zNo}); sayım girilmedi, kasa föyünü yönetici girer`
            : `Ayrıntılı gün sonu alındı (Z ${res.day.zNo}); sayım kaydedildi, fark yöneticinin ekranında`,
        );
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Föy penceresi kaydedilmiş sayımla ve notla açılır (düzeltme sıfırdan sayım istemez)
  const openFill = (d: DayDetail) => {
    setFillCount(savedCount(d.summary.countedCash, d.cashCounts));
    setFillNote(d.note ?? '');
    setFillFor(d);
  };
  const saveCount = async () => {
    if (!fillFor || busy) return;
    // Föy nakit sayımıyla kaydedilir: "Sayılmadı" görünen sayaç ₺0 sayılmış gibi yazılmaz
    if (!countStarted(fillCount)) {
      toast.warn('Önce çekmecedeki nakdi girin; çekmece boşsa Toplam tutar’a 0 yazın');
      return;
    }
    setBusy(true);
    try {
      // Kaydedilmiş sayımı değiştirmek yetkili onayı ister. Not yazıldığı gibi gider: silinen not silinir
      const banknotes = Object.fromEntries(Object.entries(fillCount.banknotes).filter(([, n]) => n > 0));
      const done = await withApproval((pin) =>
        post(`/cash/days/${fillFor.day.id}/count`, { countedCash: fillCount.countedCash, methodCounts: fillCount.methodCounts, banknotes, note: fillNote.trim(), approverPin: pin }),
      );
      if (done === null) return;
      toast.ok('Kasa föyü kaydedildi');
      setFillFor(null);
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
  const shiftCounts = current.data?.shiftCounts ?? [];
  const stale = current.data?.stale ?? null;
  const closedDay = day ? null : (current.data?.closedToday ?? null);
  const views = can('rapor.gor');
  const simulator = boot.integrations.okc.provider === 'simulator';
  // Gün sonu ladmin'e (lafmaliyet) gider mi: bağlantı kurulu ve bugün kapanacak gün eğitim günü değil (kurulum modunda
  // gerçek kullanım başlamadan kapanan gün gitmez; başladıktan sonra eğitim cihazında da gider)
  const ladminPush = boot.integrations.lafmaliyetPush && !(boot.integrations.trainingDay ?? boot.integrations.deneme);

  // Görünüm (Bugün, Geçmiş günler) ve eğitim cihazı sahnenin numaralı menüsünde: geniş ekranda solda, darda hap şeridi.
  // Eylemler Bugün'ün kendi şeridinde
  const menu =
    views || simulator ? (
      <div role="tablist" aria-label="Kasa görünümü" className="lp-menu">
        {views &&
          (
            [
              ['bugun', 'Bugün'],
              ['gecmis', 'Geçmiş günler'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={tab === v}
              onClick={() => {
                setTab(v);
                setSelected(null);
              }}
              className="lp-menu-item"
            >
              <span className="min-w-0 flex-1 truncate" data-text={label}>
                {label}
              </span>
            </button>
          ))}
        {simulator && (
          <Link to="/cihaz" className="lp-menu-item">
            <span className="min-w-0 flex-1 truncate" data-text="Eğitim cihazı">
              Eğitim cihazı
            </span>
            <MonitorSmartphone aria-hidden="true" className="size-4 shrink-0" />
          </Link>
        )}
      </div>
    ) : undefined;

  return (
    <Stage
      name="Kasa"
      sub={
        day
          ? joinMeta([`Z ${day.zNo}`, fmtDateLong(day.date), day.reopenedAt ? `yeniden açılış ${fmtTime(day.reopenedAt)}` : [`açılış ${fmtTime(day.openedAt)}`, day.openedByName].filter(Boolean).join(', ')])
          : 'Gün kapalı'
      }
      menu={menu}
      leafLabel="Kasa"
      // Pano: kartlar zeminde yüzer, eylem çubuğu zeminin üstünde
      float
    >
    <div className="lp-leaf-pad">
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
                {views && (
                  <Button
                    size="sm"
                    variant="soft"
                    icon={<FileText className="size-4" />}
                    className="mt-3"
                    onClick={() => {
                      setTab('gecmis');
                      setSelected(closedDay.id);
                    }}
                  >
                    Z raporunu gör
                  </Button>
                )}
              </div>
              {can('kasa.gun') ? (
                <div className="space-y-4 border-t border-[var(--admin-divider)] pt-4">
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
                </div>
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
              {/* Gün açılmadı: sitenin kapı çizimi (açılış) */}
              <Illustration name="kapi" className="mx-auto size-20" />
              <div>
                <h2 className="text-lg font-semibold tracking-[-0.01em]">Günü aç</h2>
                <p className="mt-1 text-pretty text-sm text-muted">Çekmecedeki açılış nakdini girin. Gece 05:00’e kadarki satışlar bu güne yazılır</p>
              </div>
              {can('kasa.gun') ? (
                <>
                  {openingHint && 'suggested' in openingHint && (
                    // Kasa zinciri: önceki günün devri (lafmaliyet'in kasa raporu ya da AsilPOS'un sayımı); sayım yerine geçmez
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[var(--r-tile)] bg-surface-2 px-4 py-3 text-left">
                      <div className="min-w-0">
                        <p className="text-[13px] text-muted">Beklenen açılış</p>
                        <p className="tabular text-lg font-semibold">{tl(openingHint.suggested)}</p>
                        <p className="text-pretty text-xs text-muted">{openingSourceText(openingHint)}</p>
                      </div>
                      <Button variant="soft" onClick={() => typeOpening(tlPlain(openingHint.suggested).replace(/\./g, ''))}>
                        Bu tutarı yaz
                      </Button>
                    </div>
                  )}
                  {openingHint && 'check' in openingHint && !openingAsked && (
                    <p className="text-pretty text-sm text-muted">Çekmeceyi sayıp girin; önceki günün devriyle karşılaştırılır</p>
                  )}
                  {/* Kasa bilgisayarında tutar klavyeyle de yazılır (rakam, virgül, Backspace, Enter: günü aç) */}
                  <output aria-label="Açılış nakdi" aria-live="polite" className="tabular font-headline block rounded-2xl border border-line-strong bg-surface-2 px-4 py-3 text-right text-4xl font-semibold">
                    <TypedAmount text={opening} />
                  </output>
                  <Numpad decimal keyboard onEnter={() => void openDay()} onKey={(k) => typeOpening(applyNumpadKey(opening, k, { decimal: true, maxLength: 9 }))} />
                  {openingNeedsReason && (
                    <Field
                      label="Farkın nedeni"
                      hint={
                        openingOverLimit
                          ? `Açılış beklenenden ${tl(Math.abs(openingDiff))} ${openingDiff > 0 ? 'fazla' : 'eksik'}; neden zorunlu`
                          : openingAskedNow
                            ? 'zorunlu'
                            : 'farkta zorunlu'
                      }
                      className="text-left"
                      error={openingReasonError}
                    >
                      <Input
                        ref={openingReasonRef}
                        value={openingReason}
                        onChange={(e) => {
                          setOpeningReason(e.target.value);
                          setOpeningReasonError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.repeat) void openDay();
                        }}
                        maxLength={200}
                        enterKeyHint="done"
                        placeholder="Ör. bozuk para için kasaya para kondu"
                      />
                    </Field>
                  )}
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
          {stale && (
            <Notice tone="warn" role="alert" title={stale}>
              Bu güne yeni adisyon ve ürün eklenmez; açık adisyonların ödemesi alınır. Gün sonunu aldıktan sonra yeni günü açın
            </Notice>
          )}
          {(can('kasa.hareket') || can('kasa.gun')) && (
            // Günün eylem şeridi: solda kasa hareketleri, sağda vardiya devri ve gün sonu (telefonda gün sonu sayfanın sonunda)
            <div className="flex flex-wrap items-center gap-2">
              {can('kasa.hareket') && (
                // Telefonda üç eşit sütun: dolgu daralır, dar telefonda ikon düşer ve etiket gerekirse iki satıra iner (kenara dayanmasın)
                <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto">
                  {MOVE_KINDS.map((k) => {
                    const Icon = MOVE_ICON[k];
                    return (
                      <Button key={k} wrap icon={<Icon className="size-4" />} className={MOVE_BTN} onClick={() => openMove(k)}>
                        {MOVE_LABEL[k]}
                      </Button>
                    );
                  })}
                </div>
              )}
              {can('kasa.gun') && (
                <div className={cn('flex gap-2 max-sm:w-full max-sm:[&>*]:flex-1 sm:ml-auto', stale && 'max-sm:hidden')}>
                  {/* Vardiya devri: gün içinde kasiyer değişirken çekmece sayımı (gün sonu değil) */}
                  {!stale && (
                    <Button icon={<ArrowLeftRight className="size-4" />} onClick={() => setHandover(true)}>
                      Vardiya devri
                    </Button>
                  )}
                  {/* Gün sonu rutin bir kapanıştır: birincil yeşil; kırmızı iptal ve alarma ayrılır */}
                  <Button variant="primary" icon={<Lock className="size-4" />} className="max-sm:hidden" onClick={() => setClosing(true)}>
                    Gün sonu (Z)
                  </Button>
                </div>
              )}
            </div>
          )}

          {summary ? (
            <ZView day={day} summary={summary} lafmaliyet={null} title="Ara rapor (X)">
              <CashActivity movements={movements} counts={shiftCounts} />
            </ZView>
          ) : (
            <>
              <Notice tone="info" icon={<EyeOff />} title="Kör kasa">
                Ara rapor ve beklenen nakit bu rolde gizli. Gün sonunda çekmeceyi sayıp girin; farkı yönetici görür
              </Notice>
              <CashActivity movements={movements} counts={shiftCounts} />
            </>
          )}

          {/* Telefonda günün birincil eylemi altta: rapora bakılıp sonra kapanır */}
          {can('kasa.gun') && (
            <Button variant="primary" size="lg" block icon={<Lock className="size-4" />} className="sm:hidden" onClick={() => setClosing(true)}>
              Gün sonu (Z)
            </Button>
          )}
        </div>
      )}

      {tab === 'gecmis' && !selected && (
        <Card className="overflow-hidden">
          {days.isPending ? (
            <ListSkeleton rows={6} />
          ) : days.isError && !days.data ? (
            <ErrorState compact title="Geçmiş günler alınamadı" error={days.error} retrying={days.isFetching} onRetry={() => void days.refetch()} />
          ) : !days.data?.length ? (
            <EmptyState icon={<Receipt />} title="Henüz kapanmış gün yok">
              Gün sonu alınan günler Z raporlarıyla burada listelenir
            </EmptyState>
          ) : (
            <ul className="divide-y divide-[var(--admin-divider)]">
              {days.data.map((d) => (
                <li key={d.id}>
                  {/* Z no, tarih ve altında adisyon ile durum rozetleri, ciro, ok: telefonda tarih kırılmaz, satırın açıldığı belli */}
                  <button
                    onClick={() => setSelected(d.id)}
                    className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-hover focus-visible:-outline-offset-2 active:bg-press"
                  >
                    <span className="tabular font-headline text-[15px] font-bold">Z {d.zNo}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{fmtDateLong(d.date)}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <span>{d.closedAt ? `${d.receipts ?? 0} adisyon` : 'Açık'}</span>
                        {d.closedAt && d.cashDiff == null && <Badge tone="warn">Föy girilmedi</Badge>}
                        {d.cashDiff != null && d.cashDiff !== 0 && <Badge tone="red">Fark {signedTL(d.cashDiff)}</Badge>}
                      </span>
                    </span>
                    <span className="tabular text-right text-sm font-semibold">{d.netSales != null ? tl(d.netSales) : '—'}</span>
                    <ChevronRight aria-hidden="true" className="size-4 text-muted" />
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
          <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} className="sm:-ml-2" onClick={() => setSelected(null)}>
            Listeye dön
          </Button>
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
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} className="sm:-ml-2" onClick={() => setSelected(null)}>
              Listeye dön
            </Button>
            {detail.data.day.closedAt && can('kasa.gun') && (
              <Button icon={<Coins className="size-4" />} className="ml-auto" onClick={() => openFill(detail.data!)}>
                {detail.data.summary.countedCash == null ? 'Kasa föyü gir' : 'Kasa föyünü düzelt'}
              </Button>
            )}
          </div>
          <ZView day={detail.data.day} summary={detail.data.summary} lafmaliyet={detail.data.lafmaliyet}>
            <CashActivity movements={detail.data.movements} counts={detail.data.shiftCounts ?? []} past />
            {/* Eski sunucu göndermez: kart yalnız alan varken */}
            {detail.data.worked && (
              <WorkedStaffCard
                dayId={detail.data.day.id}
                worked={detail.data.worked}
                editable={!!detail.data.day.closedAt && can('rapor.gor')}
                onSaved={() => void qc.invalidateQueries({ queryKey: ['cash', 'detail', detail.data!.day.id] })}
              />
            )}
          </ZView>
        </div>
      )}

      <Modal open={!!moveKind} onClose={() => setMoveKind(null)} size="sm" title={moveKind ? MOVE_LABEL[moveKind] : ''} subtitle={moveKind ? MOVE_HINT[moveKind] : undefined}>
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
          {moveKind === 'harcama' && !!categories.data?.items.length && (
            // lafmaliyet'in personel gider kategorileri (isteğe bağlı): satır "Kasadan çıkanlar"a bu kategoriyle gider
            <div role="group" aria-labelledby="harcama-kategori">
              <Label hint="isteğe bağlı">
                <span id="harcama-kategori">Kategori</span>
              </Label>
              <div className="flex flex-wrap gap-2">
                {categories.data.items.map((cat) => (
                  <Chip key={cat.id} on={moveCategory === cat.id} tone="ink" className="pointer-fine:min-h-11" onClick={() => setMoveCategory(moveCategory === cat.id ? null : cat.id)}>
                    {cat.name}
                  </Chip>
                ))}
              </div>
            </div>
          )}
          {moveKind === 'teslim' && (
            // Paranın kime verildiği (zorunlu): patron ve müdür hesapları, Banka ya da elle yazılan ad. Z raporu teslimi
            // alıcıya göre döker, ladmin'e (lafmaliyet) satırla gider
            <div role="group" aria-labelledby="teslim-kime">
              <Label hint="zorunlu">
                <span id="teslim-kime">Kime</span>
              </Label>
              <div className="flex flex-wrap gap-2">
                {recipients.map((u) => (
                  <Chip
                    key={u.id}
                    on={moveRecipient?.kind === 'user' && moveRecipient.userId === u.id}
                    tone="ink"
                    className="pointer-fine:min-h-11"
                    onClick={() => pickRecipient({ kind: 'user', userId: u.id })}
                  >
                    {u.name}
                  </Chip>
                ))}
                <Chip on={moveRecipient?.kind === 'bank'} tone="ink" className="pointer-fine:min-h-11" onClick={() => pickRecipient({ kind: 'bank' })}>
                  {BANK_RECIPIENT}
                </Chip>
                <Chip on={moveRecipient?.kind === 'other'} tone="ink" className="pointer-fine:min-h-11" onClick={() => pickRecipient({ kind: 'other' })}>
                  Başka
                </Chip>
              </div>
              {moveRecipient?.kind === 'other' && (
                <Input
                  ref={recipientRef}
                  value={moveRecipientText}
                  onChange={(e) => {
                    setMoveRecipientText(e.target.value);
                    setMoveError((x) => ({ ...x, recipient: undefined }));
                  }}
                  maxLength={RECIPIENT_MAX}
                  aria-label="Teslim alanın adı"
                  aria-invalid={!!moveError.recipient || undefined}
                  placeholder="Teslim alanın adı"
                  className="mt-2"
                />
              )}
              {moveError.recipient && (
                <p role="alert" className="mt-1.5 text-[13px] text-danger-ink">
                  {moveError.recipient}
                </p>
              )}
            </div>
          )}
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
              placeholder={moveKind === 'harcama' ? 'Ör. süt (market), fiş no' : moveKind === 'teslim' ? 'Ör. akşam teslimi' : 'Ör. bozuk para'}
            />
          </Field>
          <Button variant="primary" block loading={moveSaving} onClick={addMove}>
            {moveKind ? MOVE_SAVE[moveKind] : 'Kaydet'}
          </Button>
          {/* Harcama ve teslim lafmaliyet'in "Kasadan çıkanlar"ına satır satır gider (gün sonu paketiyle) */}
          {ladminPush && moveKind !== 'giris' && <p className="text-center text-xs text-muted">Gün sonunda ladmin’e (lafmaliyet) satır satır gider</p>}
        </div>
      </Modal>

      <Modal
        open={closing && (!!summary || blind)}
        onClose={() => setClosing(false)}
        size="lg"
        title={`Ayrıntılı gün sonu · Z ${day?.zNo ?? ''}`}
        subtitle="Satışlar, ödemeler, kasa hareketleri ve sayım tek raporda kaydedilir"
        footer={
          // Telefonda iki satır: seçim ve sayılan toplam üstte, Vazgeç ve Günü kapat eşit genişlikte altta
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center justify-between gap-3 sm:flex-1">
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={!counted} onChange={(e) => setCounted(!e.target.checked)} className="size-5 accent-[var(--admin-primary)]" />
                Sayımı sonra gireceğim
              </label>
              {/* Banknot satırları uzun: telefonda sayılan toplam düğmelerin hemen üstünde de görünür; sayım başlamadıysa gün sayımsız kapanır */}
              {counted && <span className="tabular whitespace-nowrap text-sm text-muted sm:hidden">{countStarted(count) ? `Sayılan ${tl(count.countedCash)}` : 'Sayılmadı'}</span>}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <Button onClick={() => setClosing(false)}>Vazgeç</Button>
              <Button variant="primary" icon={<Lock className="size-4" />} loading={busy} onClick={closeDay}>
                Günü kapat
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4 p-5">
          {/* Kayda geçecekler: ayrıntılı gün sonunun neyi kaydettiği bir bakışta (kör kasada ciro ve beklenen nakit yok) */}
          <DayCloseSummary summary={summary} movements={movements} shiftCounts={shiftCounts} lafmaliyet={ladminPush} />
          {/* Ekibin her akşam aynı sırayla yaptığı adımlar (sahibin istediği gün sonu rehberi) */}
          <DayCloseGuide />
          {counted && <CashCount summary={summary} value={count} onChange={setCount} />}
          <Field label="Not">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ör. kart slipinde 1 işlem eksik" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!fillFor}
        onClose={() => setFillFor(null)}
        size="lg"
        title={`Kasa föyü · Z ${fillFor?.day.zNo ?? ''}`}
        subtitle={fillFor?.summary.countedCash == null ? 'Sayımsız kapanan günün sayımı' : 'Kaydedilmiş sayımı düzeltmek yetkili onayı ister'}
        footer={
          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <Button onClick={() => setFillFor(null)}>Vazgeç</Button>
            <Button variant="primary" loading={busy} onClick={saveCount}>
              Föyü kaydet
            </Button>
          </div>
        }
      >
        <div className="space-y-4 p-5">
          {fillFor && <CashCount summary={fillFor.summary} value={fillCount} onChange={setFillCount} />}
          <Field label="Not">
            <Input value={fillNote} onChange={(e) => setFillNote(e.target.value)} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={!!zResult}
        onClose={() => setZResult(null)}
        size="xl"
        title={`Ayrıntılı gün sonu alındı · Z ${zResult?.day.zNo ?? ''}`}
        subtitle="Özet üstte, ayrıntılı Z raporu altında"
      >
        {zResult && (
          <div className="space-y-4 p-5">
            <DayCloseDone summary={zResult.summary} closedAt={zResult.day.closedAt} lafmaliyet={boot.integrations.lafmaliyetPush && !zResult.day.trainingDay} />
            <ZView day={zResult.day} summary={zResult.summary} lafmaliyet={zResult.lafmaliyet}>
              <CashActivity movements={zResult.movements} counts={zResult.shiftCounts ?? []} past />
            </ZView>
          </div>
        )}
      </Modal>
      <ShiftHandoverModal open={handover} onClose={() => setHandover(false)} summary={summary} prevDiff={shiftCounts.at(-1)?.diff ?? 0} />
    </div>
    </Stage>
  );
}

/** Kasa hareketleri ve vardiya devirleri yan yana (devir yoksa hareketler tam genişlik); rakam şeridinin altında */
function CashActivity({ movements, counts, past }: { movements: Movement[]; counts: ShiftCountDTO[]; past?: boolean }) {
  return (
    <div className={cn('grid gap-3 lg:items-start', counts.length > 0 && 'lg:grid-cols-2')}>
      <MovementsCard movements={movements} past={past} />
      <ShiftCountsCard counts={counts} />
    </div>
  );
}

/**
 * Kasa hareketleri: paranın neye gittiği (açıklama) ilk satırda, türü, kim ve saat altında; yön işarette ve renkte
 * (giriş artı ve yeşil, çıkan eksi). Tür durum değildir: renkli rozet yok, düğmesindeki ikonla yazılır.
 */
function MovementsCard({ movements, past }: { movements: Movement[]; past?: boolean }) {
  return (
    <Card title="Kasa hareketleri">
      {movements.length === 0 ? (
        <EmptyState compact icon={<Coins />} title={past ? 'Bu gün kasa hareketi yok' : 'Bugün kasa hareketi yok'}>
          {past ? undefined : 'Harcama, teslim ve kasaya giriş burada listelenir'}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-[var(--admin-divider)]">
          {movements.map((m) => {
            const Icon = MOVE_ICON[m.kind];
            return (
              <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{m.description || MOVE_LABEL[m.kind]}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                    {m.description && (
                      <>
                        <span className="inline-flex items-center gap-1 whitespace-nowrap text-ink-2">
                          <Icon aria-hidden="true" className="size-3.5" />
                          {MOVE_LABEL[m.kind]}
                        </span>
                        <span aria-hidden="true">·</span>
                      </>
                    )}
                    <span className="min-w-0 max-w-full truncate">{joinMeta([m.kind === 'teslim' && m.recipientName ? `Kime: ${m.recipientName}` : null, m.categoryName, m.userName, fmtTime(m.createdAt)])}</span>
                  </span>
                </span>
                <span className={cn('tabular shrink-0 text-right font-semibold', m.kind === 'giris' ? 'text-success-ink' : 'text-ink')}>
                  {m.kind === 'giris' ? '+' : '−'}
                  {tl(m.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
