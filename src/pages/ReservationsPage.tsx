import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronLeft, ChevronRight, Phone, Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { addDays, businessDate, fmtDateLong } from '@shared/time';
import type { OrderDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, EmptyState, PageHeader } from '@/components/ui/misc';
import { errorMessage, get, patch, post } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
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

const STATUS = { bekliyor: { label: 'Bekliyor', tone: 'brass' }, geldi: { label: 'Geldi', tone: 'green' }, iptal: { label: 'İptal', tone: 'neutral' }, gelmedi: { label: 'Gelmedi', tone: 'red' } } as const;

export default function ReservationsPage() {
  const boot = useBoot();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [date, setDate] = useState(businessDate(Date.now()));
  const list = useQuery({ queryKey: ['reservations', date], queryFn: () => get<Reservation[]>(`/reservations?date=${date}`) });
  const [form, setForm] = useState<null | { time: string; name: string; phone: string; guests: number; tableId: string; durationMin: number; note: string }>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['reservations'] });

  const save = async () => {
    if (!form) return;
    try {
      await post('/reservations', { date, time: form.time, name: form.name, phone: form.phone || null, guests: form.guests, tableId: form.tableId || null, durationMin: form.durationMin, note: form.note || null });
      toast.ok('Rezervasyon eklendi');
      setForm(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
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
            <div className="flex items-center rounded-xl border border-line bg-surface">
              <button aria-label="Önceki gün" className="grid size-10 place-items-center" onClick={() => setDate(addDays(date, -1))}>
                <ChevronLeft className="size-4" />
              </button>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-10 bg-transparent px-1 text-sm" />
              <button aria-label="Sonraki gün" className="grid size-10 place-items-center" onClick={() => setDate(addDays(date, 1))}>
                <ChevronRight className="size-4" />
              </button>
            </div>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm({ time: '19:00', name: '', phone: '', guests: 2, tableId: '', durationMin: 120, note: '' })}>
              Yeni
            </Button>
          </>
        }
      />
      {rows.length === 0 ? (
        <EmptyState icon={<CalendarClock />} title="Bu gün için rezervasyon yok" />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className={cn('flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4', r.status === 'iptal' && 'opacity-60')}>
              <div className="tabular w-16 text-2xl font-semibold">{r.time}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-semibold">
                  {r.name} <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 text-sm text-muted">
                  <span className="inline-flex items-center gap-1">
                    <Users className="size-3.5" /> {r.guests} kişi
                  </span>
                  {r.tableName && <span>{r.tableName}</span>}
                  {r.phone && (
                    <a href={`tel:${r.phone}`} className="inline-flex items-center gap-1 text-forest-600">
                      <Phone className="size-3.5" /> {r.phone}
                    </a>
                  )}
                  <span>{r.durationMin} dk</span>
                </div>
                {r.note && <div className="mt-1 text-sm italic text-ink-2">{r.note}</div>}
              </div>
              {r.status === 'bekliyor' && (
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => setStatus(r, 'geldi')}>
                    Geldi{r.tableId && boot.day ? ', masa aç' : ''}
                  </Button>
                  <Button size="sm" onClick={() => setStatus(r, 'gelmedi')}>
                    Gelmedi
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setStatus(r, 'iptal')}>
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
            <Button variant="primary" disabled={!form?.name.trim()} onClick={save}>
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
              <Input type="number" min={1} value={form.guests} onChange={(e) => setForm({ ...form, guests: Number(e.target.value) || 1 })} />
            </Field>
            <Field label="Ad">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
            </Field>
            <Field label="Telefon">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} inputMode="tel" />
            </Field>
            <Field label="Masa / oda">
              <Select value={form.tableId} onChange={(e) => setForm({ ...form, tableId: e.target.value })}>
                <option value="">Sonra belirlenecek</option>
                {boot.tables.map((t) => (
                  <option key={t.id} value={t.id}>
                    {boot.sections.find((s) => s.id === t.sectionId)?.name} · {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Süre (dk)">
              <Input type="number" min={15} step={15} value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: Number(e.target.value) || 120 })} />
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
