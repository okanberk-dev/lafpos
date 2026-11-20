import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Armchair, ChevronLeft, ChevronRight, Clock, Phone, Plus, Users } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { addDays, businessDate, businessDayStartMs, DAY_ROLLOVER_HOUR, fmtDateLong, fmtDateShort, fmtElapsed, fmtTime, hmToMinutes } from '@shared/time';
import type { OrderDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Field, Input, NumberInput, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, EmptyState, ErrorState, FLOAT_CARD, PageHeader, Skeleton } from '@/components/ui/misc';
import { Stage } from '@/components/ui/Stage';
import { errorMessage, get, patch, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useFinePointer, useTick } from '@/lib/hooks';
import { fmtPhone, joinMeta, telHref } from '@/lib/text';
import { toast } from '@/lib/toast';

type Status = 'bekliyor' | 'geldi' | 'iptal' | 'gelmedi';
interface Reservation {
  id: string;
  date: string;
  time: string;
  durationMin: number;
  name: string;
  phone: string | null;
  guests: number;
  tableId: string | null;
  tableName: string | null;
  status: Status;
  note: string | null;
}

// Bekliyor nötr (barda bekleyen kalem gibi); amber yalnız zamanı söyler: saati 15 dakika geçen rezervasyon "Gecikti"
const STATUS = { bekliyor: { label: 'Bekliyor', tone: 'neutral' }, geldi: { label: 'Geldi', tone: 'green' }, iptal: { label: 'İptal', tone: 'neutral' }, gelmedi: { label: 'Gelmedi', tone: 'red' } } as const;
const LATE_MS = 15 * 60_000;
/** İşaretlenen durumun bildirimi; "Geri al" rezervasyonu yeniden Bekliyor'a alır */
const DONE: Record<Exclude<Status, 'bekliyor'>, (name: string) => string> = {
  geldi: (name) => `${name} geldi olarak işaretlendi`,
  gelmedi: (name) => `${name} gelmedi olarak işaretlendi`,
  iptal: (name) => `${name} rezervasyonu iptal edildi`,
};
/**
 * Satır düğmeleri: tablet ve bilgisayarda en az 96 px (üç düğme hizalı). Kitin dokunmatik 44 px'i (`pointer-coarse:min-w-11`)
 * genişte bununla ezilir; telefonda düğmeler satırı içerikleri oranında doldurur
 */
const ACTION = 'sm:min-w-24 sm:pointer-coarse:min-w-24';
/** Tarih adımlayıcının okları: kapsülün içinde yuvarlak, dokunmatikte de 44 px */
const STEP = 'grid size-11 shrink-0 place-items-center rounded-full text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink active:bg-press';

/** Rezervasyonun başladığı an: iş günü 05:00'te döner, gece yarısından sonraki saat (01:00) o günün gecesidir */
function startOf(r: Reservation): number {
  const fromRollover = (hmToMinutes(r.time) - DAY_ROLLOVER_HOUR * 60 + 1440) % 1440;
  return businessDayStartMs(r.date) + fromRollover * 60_000;
}

export default function ReservationsPage() {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Gecikme rozeti ve "Bugün" yarım dakikada bir yenilenir (iş günü 05:00'te döner)
  const now = useTick(30_000);
  const today = businessDate(now);
  const [date, setDate] = useState(today);
  const dateRef = useRef<HTMLInputElement>(null);
  // Gün değişince önceki günün listesi soluk kalır (sahte "rezervasyon yok" yanıp sönmesin)
  const list = useQuery({ queryKey: ['reservations', date], queryFn: () => get<Reservation[]>(`/reservations?date=${date}`), placeholderData: keepPreviousData });
  const [form, setForm] = useState<null | { time: string; name: string; phone: string; guests: number; tableId: string; durationMin: number; note: string }>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Süren durum isteği: o satırın düğmeleri kilitli, basılan düğmede gösterge; ikinci dokunuş ikinci isteği göndermez
  const [busy, setBusy] = useState<{ id: string; status: Status } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const fine = useFinePointer();
  const refresh = () => qc.invalidateQueries({ queryKey: ['reservations'] });
  const openForm = () => {
    setNameError(null);
    setForm({ time: '19:00', name: '', phone: '', guests: 2, tableId: '', durationMin: 120, note: '' });
  };

  const save = async () => {
    if (!form || saving) return;
    // Zorunlu alan eksikse düğme sessizce soluk kalmaz: ileti alanın altında, odak alanda
    if (!form.name.trim()) {
      setNameError('Ad gerekli');
      nameRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      await post('/reservations', { date, time: form.time, name: form.name, phone: form.phone || null, guests: form.guests, tableId: form.tableId || null, durationMin: form.durationMin, note: form.note || null });
      toast.ok('Rezervasyon eklendi');
      setForm(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  // Yanlış dokunuş kalıcı olmasın: işaretlenen durum bildirimden geri alınır (masa açılan Geldi hariç; adisyon açıldı)
  const undo = async (r: Reservation) => {
    try {
      await patch(`/reservations/${r.id}`, { status: 'bekliyor' });
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  // "Geldi, masa aç" yalnız masa açılabilecekken: gün açık, adisyon açma yetkisi var, masa planda (kapatılmamış). Öteki
  // durumda Geldi yalnız durumu işaretler (geri alınır); masa Masalar'dan açılır
  const opensTable = (r: Reservation) => !!r.tableId && !!boot.day && can('siparis.al') && boot.tables.some((t) => t.id === r.tableId);
  const setStatus = async (r: Reservation, status: Exclude<Status, 'bekliyor'>) => {
    if (busy) return;
    setBusy({ id: r.id, status });
    try {
      if (status === 'geldi' && opensTable(r)) {
        // Önce masa açılır, sonra Geldi işaretlenir: masa açılamazsa (dünden açık kalan gün, bağlantı) rezervasyon
        // Bekliyor kalır ve yeniden denenir; adisyonsuz Geldi'de takılmaz. Yeniden denemede masanın açık adisyonu döner
        const o = await post<OrderDTO>('/orders', { type: 'masa', tableId: r.tableId, guests: r.guests, note: `Rezervasyon: ${r.name}` });
        await patch(`/reservations/${r.id}`, { status });
        refresh();
        navigate(`/adisyon/${o.id}`);
        return;
      }
      await patch(`/reservations/${r.id}`, { status });
      refresh();
      toast.ok(DONE[status](r.name), { action: { label: 'Geri al', run: () => void undo(r) } });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const rows = list.data ?? [];
  const live = rows.filter((r) => r.status !== 'iptal');
  const guests = live.reduce((a, r) => a + r.guests, 0);
  const isToday = date === today;
  const dayLabel = isToday ? 'Bugün' : date === addDays(today, -1) ? 'Dün' : date === addDays(today, 1) ? 'Yarın' : fmtDateShort(date);

  return (
    // Sahne: başlık, tarih ve ekleme sol sütunda (PageHeader taşınır), gün listesi yaprakta
    <Stage leafLabel="Rezervasyonlar" float>
    <div className="lp-leaf-pad">
      <PageHeader
        title="Rezervasyon"
        // Gün yüklenirken önceki günün sayıları yeni tarihin altında kalmaz; rezervasyon yoksa yalnız tarih
        subtitle={joinMeta([fmtDateLong(date), !list.isPlaceholderData && live.length > 0 && `${live.length} rezervasyon, ${guests} kişi`])}
        actions={
          <>
            <div className="flex items-center gap-2">
              {/* Tarih adımlayıcı (kapsül, düğmelerle aynı kenar): görünen metin bizim biçimimizde ("Bugün", "27 Eki Sal"); ortadaki
                  düğme yerli seçiciyi açar (görünmez tarih alanının showPicker'ı). Telefonda tam genişlikte dengeli */}
              <div className="flex min-w-0 flex-1 items-center rounded-full bg-surface shadow-[var(--rim)] outline-1 -outline-offset-1 outline-[var(--admin-border-strong)] sm:flex-none">
                <button type="button" aria-label="Önceki gün" className={STEP} onClick={() => setDate(addDays(date, -1))}>
                  <ChevronLeft aria-hidden="true" className="size-4" />
                </button>
                <span className="relative inline-flex min-w-28 flex-1">
                  <button
                    type="button"
                    aria-label={`Tarih seç: ${fmtDateLong(date)}`}
                    className="inline-flex h-11 w-full items-center justify-center rounded-full px-3 text-sm font-medium transition-colors duration-150 hover:bg-hover active:bg-press"
                    onClick={() => {
                      const el = dateRef.current;
                      if (!el) return;
                      try {
                        el.showPicker();
                      } catch {
                        // showPicker yoksa (eski tarayıcı) alan odaklanıp tıklanır
                        el.focus();
                        el.click();
                      }
                    }}
                  >
                    {dayLabel}
                  </button>
                  <input
                    ref={dateRef}
                    type="date"
                    value={date}
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={(e) => e.target.value && setDate(e.target.value)}
                    className="pointer-events-none absolute inset-0 size-full opacity-0"
                  />
                </span>
                <button type="button" aria-label="Sonraki gün" className={STEP} onClick={() => setDate(addDays(date, 1))}>
                  <ChevronRight aria-hidden="true" className="size-4" />
                </button>
              </div>
              {/* Başka güne gidilince tek dokunuşla bugüne dönüş */}
              {!isToday && (
                <Button variant="ghost" className="shrink-0" onClick={() => setDate(today)}>
                  Bugün
                </Button>
              )}
            </div>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={openForm}>
              Yeni rezervasyon
            </Button>
          </>
        }
      />
      {list.isPending ? (
        <div role="status" aria-label="Rezervasyonlar yükleniyor…" className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[72px] rounded-2xl" />
          ))}
        </div>
      ) : list.isError && !list.data ? (
        <ErrorState className={FLOAT_CARD} title="Rezervasyonlar alınamadı" error={list.error} retrying={list.isFetching} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        // Ekleme düğmesi başlıkta: boş durum ikinci bir çağrı yapmaz
        <EmptyState art="bilet" title={isToday ? 'Bugün rezervasyon yok' : 'Bu güne rezervasyon yok'} className={FLOAT_CARD}>
          Telefonla gelen rezervasyonu ekleyin; Geldi deyince masa açılır
        </EmptyState>
      ) : (
        <div aria-busy={list.isPlaceholderData || undefined} className={cn('space-y-2 transition-opacity duration-150', list.isPlaceholderData && 'opacity-60')}>
          {rows.map((r) => {
            const start = startOf(r);
            // Gecikme yalnız bugünün listesinde: geçmiş günün işaretlenmemiş rezervasyonu "Bekliyor" kalır
            const late = isToday && r.status === 'bekliyor' && now > start + LATE_MS;
            const doing = busy?.id === r.id ? busy.status : null;
            const status = STATUS[r.status];
            return (
              // Saat ve ad üstte; düğmeler telefonda ve tablette kendi satırında (ad hiç sıkışmaz), bilgisayarda aynı satırda sağda
              <div key={r.id} className={cn('flex flex-col gap-3 rounded-[var(--r-card)] border border-[var(--card-line)] bg-surface p-4 shadow-[var(--card-shadow)] lg:flex-row lg:items-center', r.status === 'iptal' && 'opacity-60')}>
                <div className="flex min-w-0 flex-1 items-baseline gap-3">
                  <div className="tabular w-14 shrink-0 font-headline text-xl font-bold tracking-[-0.01em]">{r.time}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{r.name}</span>
                      {late ? (
                        <Badge tone="warn" dot>
                          Gecikti · {fmtElapsed(start, now)}
                        </Badge>
                      ) : (
                        <Badge tone={status.tone}>{status.label}</Badge>
                      )}
                    </div>
                    {/* Meta parçaları bölünmez: satır parçaların arasında kırılır */}
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[13px] text-muted">
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <Users aria-hidden="true" className="size-3.5" /> {r.guests} kişi
                      </span>
                      {r.tableName && (
                        <span className="inline-flex items-center gap-1 whitespace-nowrap">
                          <Armchair aria-hidden="true" className="size-3.5" /> {r.tableName}
                        </span>
                      )}
                      <span className="tabular inline-flex items-center gap-1 whitespace-nowrap">
                        <Clock aria-hidden="true" className="size-3.5" /> {r.time}–{fmtTime(start + r.durationMin * 60_000)}
                      </span>
                      {r.phone && (
                        <a href={telHref(r.phone)} className="tabular inline-flex min-h-11 items-center gap-1 whitespace-nowrap text-primary pointer-fine:min-h-0">
                          <Phone aria-hidden="true" className="size-3.5" /> {fmtPhone(r.phone)}
                        </a>
                      )}
                    </div>
                    {r.note && <p className="mt-1 text-pretty text-sm italic text-ink-2">{r.note}</p>}
                  </div>
                </div>
                {r.status === 'bekliyor' && (
                  // Telefonda satırı içerikleri oranında doldurur; tablette adın hizasında, bilgisayarda sağda
                  <div className="flex gap-2 max-sm:[&>*]:flex-auto sm:pl-[68px] lg:shrink-0 lg:pl-0">
                    <Button size="sm" variant="primary" className={ACTION} loading={doing === 'geldi'} disabled={!!doing} onClick={() => void setStatus(r, 'geldi')}>
                      {opensTable(r) ? 'Geldi, masa aç' : 'Geldi'}
                    </Button>
                    <Button size="sm" className={ACTION} loading={doing === 'gelmedi'} disabled={!!doing} onClick={() => void setStatus(r, 'gelmedi')}>
                      Gelmedi
                    </Button>
                    <Button size="sm" variant="ghost" className={ACTION} loading={doing === 'iptal'} disabled={!!doing} onClick={() => void setStatus(r, 'iptal')}>
                      İptal
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        persistent={saving}
        title="Yeni rezervasyon"
        subtitle={fmtDateLong(date)}
        footer={
          <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <Button onClick={() => setForm(null)}>Vazgeç</Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Rezervasyonu kaydet
            </Button>
          </div>
        }
      >
        {form && (
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            <Field label="Saat">
              <Input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
            </Field>
            <Field label="Kişi">
              <NumberInput value={form.guests} min={1} max={99} fallback={1} onCommit={(guests) => setForm({ ...form, guests })} />
            </Field>
            <Field label="Ad" required error={nameError}>
              <Input
                ref={nameRef}
                value={form.name}
                onChange={(e) => {
                  setForm({ ...form, name: e.target.value });
                  setNameError(null);
                }}
                maxLength={80}
                autoFocus={fine}
                autoCapitalize="words"
                enterKeyHint="next"
              />
            </Field>
            <Field label="Telefon">
              <Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} maxLength={30} inputMode="tel" spellCheck={false} />
            </Field>
            <Field label="Masa">
              <Select value={form.tableId} onChange={(e) => setForm({ ...form, tableId: e.target.value })}>
                <option value="">Sonra belirlenecek</option>
                {/* Oda yerel rezervasyona verilmez: karaoke sitede alınır ve ödenir (docs/03-ENTEGRASYON.md §2.4) */}
                {boot.tables
                  .filter((t) => t.kind !== 'oda')
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {boot.sections.find((s) => s.id === t.sectionId)?.name} · {t.name}
                    </option>
                  ))}
              </Select>
            </Field>
            {/* Sunucunun sınırı 600 dakika (10 saat) */}
            <Field label="Süre (dk)">
              <NumberInput value={form.durationMin} min={15} max={600} fallback={120} onCommit={(durationMin) => setForm({ ...form, durationMin })} />
            </Field>
            <Field label="Not" className="sm:col-span-2">
              <Textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={300} placeholder="Ör. doğum günü, pasta getirecekler" />
            </Field>
            {/* Masa listesinde oda yok: neden olduğu formun altında, alanların hizasını bozmadan */}
            {boot.tables.some((t) => t.kind === 'oda') && <p className="text-pretty text-xs text-muted sm:col-span-2">Karaoke odası burada değil, sitede (laffogato.net/karaoke) rezerve edilir</p>}
          </div>
        )}
      </Modal>
    </div>
    </Stage>
  );
}
