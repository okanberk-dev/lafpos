import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronLeft, ChevronRight, Phone, Plus, Users } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { addDays, businessDate, fmtDateLong, fmtDateShort } from '@shared/time';
import type { OrderDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Field, Input, NumberInput, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { errorMessage, get, patch, post } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useFinePointer } from '@/lib/hooks';
import { toast } from '@/lib/toast';

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
  status: 'bekliyor' | 'geldi' | 'iptal' | 'gelmedi';
  note: string | null;
}

const STATUS = { bekliyor: { label: 'Bekliyor', tone: 'warn' }, geldi: { label: 'Geldi', tone: 'green' }, iptal: { label: 'İptal', tone: 'neutral' }, gelmedi: { label: 'Gelmedi', tone: 'red' } } as const;

export default function ReservationsPage() {
  const boot = useBoot();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [date, setDate] = useState(businessDate(Date.now()));
  const dateRef = useRef<HTMLInputElement>(null);
  // Gün değişince önceki günün listesi soluk kalır (sahte "rezervasyon yok" yanıp sönmesin)
  const list = useQuery({ queryKey: ['reservations', date], queryFn: () => get<Reservation[]>(`/reservations?date=${date}`), placeholderData: keepPreviousData });
  const [form, setForm] = useState<null | { time: string; name: string; phone: string; guests: number; tableId: string; durationMin: number; note: string }>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const fine = useFinePointer();
  const refresh = () => qc.invalidateQueries({ queryKey: ['reservations'] });
  const openForm = () => {
    setNameError(null);
    setForm({ time: '19:00', name: '', phone: '', guests: 2, tableId: '', durationMin: 120, note: '' });
  };

  const save = async () => {
    if (!form) return;
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
  const setStatus = async (r: Reservation, status: Reservation['status']) => {
    try {
      await patch(`/reservations/${r.id}`, { status });
      refresh();
      if (status === 'geldi' && r.tableId && boot.day) {
        const o = await post<OrderDTO>('/orders', { type: 'masa', tableId: r.tableId, guests: r.guests, note: `Rezervasyon: ${r.name}` });
        navigate(`/adisyon/${o.id}`);
      }
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const rows = list.data ?? [];
  const guests = rows.filter((r) => r.status !== 'iptal').reduce((a, r) => a + r.guests, 0);

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      <PageHeader
        title="Rezervasyon"
        subtitle={`${fmtDateLong(date)} · ${rows.filter((r) => r.status !== 'iptal').length} rezervasyon, ${guests} kişi`}
        actions={
          <>
            {/* Tarih adımlayıcı: görünen metin bizim biçimimizde ("Bugün", "27 Eki Sal"); ortadaki düğme yerli seçiciyi açar
                (görünmez tarih alanının showPicker'ı). Odak düğmede, halkası görünür; telefonda tam genişlikte dengeli */}
            <div className="flex items-center justify-between rounded-xl border border-line bg-surface">
              <button aria-label="Önceki gün" className="grid size-11 place-items-center rounded-l-xl transition-colors duration-150 hover:bg-hover active:bg-press" onClick={() => setDate(addDays(date, -1))}>
                <ChevronLeft className="size-4" />
              </button>
              <span className="relative inline-flex min-w-24 flex-1">
                <button
                  type="button"
                  aria-label={`Tarih seç: ${fmtDateLong(date)}`}
                  className="inline-flex h-11 w-full items-center justify-center px-3 text-sm font-medium transition-colors duration-150 hover:bg-hover active:bg-press"
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
                  {date === businessDate(Date.now()) ? 'Bugün' : fmtDateShort(date)}
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
              <button aria-label="Sonraki gün" className="grid size-11 place-items-center rounded-r-xl transition-colors duration-150 hover:bg-hover active:bg-press" onClick={() => setDate(addDays(date, 1))}>
                <ChevronRight className="size-4" />
              </button>
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
        <ErrorState title="Rezervasyonlar alınamadı" error={list.error} retrying={list.isFetching} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<CalendarClock />}
          title="Bu gün için rezervasyon yok"
          action={
            <Button size="sm" icon={<Plus className="size-4" />} onClick={openForm}>
              Rezervasyon ekle
            </Button>
          }
        >
          Telefonla gelen rezervasyonu ekleyin; Geldi deyince masa açılır
        </EmptyState>
      ) : (
        <div aria-busy={list.isPlaceholderData || undefined} className={cn('space-y-2 transition-opacity duration-150', list.isPlaceholderData && 'opacity-60')}>
          {rows.map((r) => (
            <div key={r.id} className={cn('flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4', r.status === 'iptal' && 'opacity-60')}>
              <div className="tabular w-14 text-xl font-semibold">{r.time}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-semibold">
                  {r.name} <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 text-[13px] text-muted">
                  <span className="inline-flex items-center gap-1">
                    <Users className="size-3.5" /> {r.guests} kişi
                  </span>
                  {r.tableName && <span>{r.tableName}</span>}
                  {r.phone && (
                    <a href={`tel:${r.phone}`} className="inline-flex min-h-11 items-center gap-1 text-primary pointer-fine:min-h-0">
                      <Phone className="size-3.5" /> {r.phone}
                    </a>
                  )}
                  <span>{r.durationMin} dk</span>
                </div>
                {r.note && <div className="mt-1 text-sm italic text-ink-2">{r.note}</div>}
              </div>
              {r.status === 'bekliyor' && (
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" className="min-w-24" onClick={() => setStatus(r, 'geldi')}>
                    Geldi{r.tableId && boot.day ? ', masa aç' : ''}
                  </Button>
                  <Button size="sm" className="min-w-24" onClick={() => setStatus(r, 'gelmedi')}>
                    Gelmedi
                  </Button>
                  <Button size="sm" variant="ghost" className="min-w-24" onClick={() => setStatus(r, 'iptal')}>
                    İptal
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title="Yeni rezervasyon"
        subtitle={fmtDateLong(date)}
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setForm(null)}>Vazgeç</Button>
            <Button variant="primary" loading={saving} onClick={save}>
              Kaydet
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
                autoFocus={fine}
                autoCapitalize="words"
                enterKeyHint="next"
              />
            </Field>
            <Field label="Telefon">
              <Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" spellCheck={false} />
            </Field>
            <Field label="Masa" hint={boot.tables.some((t) => t.kind === 'oda') ? 'Karaoke odası sitedeki /karaoke’den rezerve edilir' : undefined}>
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
            <Field label="Süre (dk)">
              <NumberInput value={form.durationMin} min={15} max={720} fallback={120} onCommit={(durationMin) => setForm({ ...form, durationMin })} />
            </Field>
            <Field label="Not" className="sm:col-span-2">
              <Textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Ör. doğum günü, pasta getirecekler" />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
