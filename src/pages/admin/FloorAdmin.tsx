import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { parseTL } from '@shared/money';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { PageLoading } from '@/components/ui/misc';
import { PageHeader } from '@/components/admin/ui';
import { errorMessage, get, patch, post, put } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';

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
  active: boolean;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const snap = (v: number) => Math.round(v);

export default function FloorAdmin() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'floor'], queryFn: () => get<{ sections: Section[]; tables: Table[] }>('/admin/floor') });
  const [sectionId, setSectionId] = useState('');
  const [tables, setTables] = useState<Table[]>([]);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; mode: 'move' | 'size'; startX: number; startY: number; orig: Table } | null>(null);

  useEffect(() => {
    if (!data.data) return;
    setTables(data.data.tables);
    if (!sectionId) setSectionId(data.data.sections[0]?.id ?? '');
  }, [data.data, sectionId]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'floor'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };

  const onPointerDown = (e: React.PointerEvent, t: Table, mode: 'move' | 'size') => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: t.id, mode, startX: e.clientX, startY: e.clientY, orig: t };
    setSelected(t.id);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !canvas.current) return;
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
    drag.current = null;
  };

  const saveLayout = async () => {
    try {
      await put('/admin/tables/layout', { tables: tables.filter((t) => dirty.has(t.id)).map(({ id, x, y, w, h }) => ({ id, x, y, w, h })) });
      setDirty(new Set());
      toast.ok('Masa planı kaydedildi');
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const addTable = async () => {
    try {
      const n = tables.filter((t) => t.sectionId === sectionId).length + 1;
      await post('/admin/tables', { sectionId, name: `M${n}`, seats: 2, shape: 'square', x: 5, y: 5, w: 12, h: 16 });
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const addSection = async () => {
    const name = window.prompt('Bölüm adı (ör. Teras)');
    if (!name?.trim()) return;
    try {
      const r = await post<{ id: string }>('/admin/sections', { name: name.trim() });
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

  if (data.isLoading) return <PageLoading />;
  const sections = data.data?.sections ?? [];
  const visible = tables.filter((t) => t.sectionId === sectionId && t.active);
  const sel = tables.find((t) => t.id === selected) ?? null;

  return (
    <div>
      <PageHeader
        title="Masa planı"
        description="Masaları sürükleyin, köşesinden boyutlandırın. Karaoke odası gibi saatlik alanlar için türü 'oda' seçin"
        actions={
          <>
            <Button icon={<Plus className="size-4" />} onClick={addTable}>
              Masa ekle
            </Button>
            <Button variant="primary" icon={<Save className="size-4" />} disabled={!dirty.size} onClick={saveLayout}>
              Planı kaydet{dirty.size ? ` (${dirty.size})` : ''}
            </Button>
          </>
        }
      />
      <div role="tablist" aria-label="Bölüm" className="no-scrollbar -mx-4 mb-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {sections.map((s) => {
          const on = s.id === sectionId;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={on}
              onClick={() => setSectionId(s.id)}
              className={cn(
                'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border bg-[var(--admin-surface)] px-2.5 text-[13px] pointer-coarse:min-h-11',
                on ? 'border-[var(--admin-text)] font-semibold text-[var(--admin-text)]' : 'border-[var(--admin-border)] font-medium text-[var(--admin-text-soft)] hover:border-[var(--admin-border-field)]',
              )}
            >
              {s.name}
              <span className={cn('min-w-5 rounded-md px-1.5 text-center text-xs tabular-nums', on ? 'bg-[var(--admin-text)] text-[var(--admin-surface)]' : 'bg-[var(--admin-panel)]')}>{tables.filter((t) => t.sectionId === s.id && t.active).length}</span>
            </button>
          );
        })}
        <button onClick={addSection} className="inline-flex min-h-9 shrink-0 items-center rounded-lg border border-dashed border-[var(--admin-border-field)] px-3 text-[13px] text-[var(--admin-text-mute)] hover:text-[var(--admin-text)] pointer-coarse:min-h-11">
          + Bölüm
        </button>
      </div>
      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <div
          ref={canvas}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerDown={() => setSelected(null)}
          className="relative aspect-[16/10] w-full touch-none select-none rounded-xl border border-[var(--admin-border)] bg-[radial-gradient(circle_at_1px_1px,var(--admin-border-strong)_1px,transparent_0)] bg-[length:20px_20px] bg-[var(--admin-surface-2)]"
        >
          {visible.map((t) => (
            <div
              key={t.id}
              onPointerDown={(e) => onPointerDown(e, t, 'move')}
              style={{ left: `${t.x}%`, top: `${t.y}%`, width: `${t.w}%`, height: `${t.h}%` }}
              className={cn(
                'absolute flex cursor-grab flex-col items-center justify-center border bg-[var(--admin-surface)] text-center text-sm font-semibold text-[var(--admin-text)] active:cursor-grabbing',
                t.shape === 'round' ? 'rounded-full' : 'rounded-lg',
                selected === t.id ? 'border-[var(--admin-primary)] ring-2 ring-[var(--admin-primary)]/30' : 'border-[var(--admin-border-field)]/60',
                t.kind === 'oda' && 'bg-[var(--admin-accent-soft)]',
              )}
            >
              {t.name}
              <span className="text-[11px] font-normal text-[var(--admin-text-mute)]">{t.kind === 'oda' ? 'oda' : `${t.seats} kişi`}</span>
              <span onPointerDown={(e) => onPointerDown(e, t, 'size')} aria-hidden="true" className="absolute bottom-0.5 right-0.5 size-4 cursor-nwse-resize rounded-sm border-b-2 border-r-2 border-[var(--admin-primary)]" />
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] p-4">
          {!sel ? (
            <p className="text-sm text-muted">Düzenlemek için bir masaya dokunun</p>
          ) : (
            <div className="space-y-3">
              <h3 className="font-semibold">{sel.name}</h3>
              <Field label="Ad">
                <Input defaultValue={sel.name} key={`n${sel.id}`} onBlur={(e) => e.target.value.trim() && e.target.value !== sel.name && updateTable(sel.id, { name: e.target.value.trim() })} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Kişi">
                  <Input type="number" min={1} defaultValue={sel.seats} key={`s${sel.id}`} onBlur={(e) => updateTable(sel.id, { seats: Number(e.target.value) || 1 })} />
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
                <Field label="Saatlik ücret (₺)">
                  <Input defaultValue={sel.hourlyRate ? String(sel.hourlyRate / 100) : ''} key={`r${sel.id}`} inputMode="decimal" onBlur={(e) => updateTable(sel.id, { hourlyRate: parseTL(e.target.value || '0') || null })} />
                </Field>
              )}
              <Field label="Sitedeki masa adı" hint="QR ile gelen online siparişi bu masaya düşürür">
                <Input defaultValue={sel.siteTableCode ?? ''} key={`c${sel.id}`} placeholder='ör. "Masa 4"' onBlur={(e) => updateTable(sel.id, { siteTableCode: e.target.value.trim() || null })} />
              </Field>
              <Button
                variant="ghost"
                className="text-burgundy-500"
                onClick={() => {
                  if (window.confirm(`${sel.name} plandan kaldırılsın mı?`)) updateTable(sel.id, { active: false });
                  setSelected(null);
                }}
              >
                Masayı kaldır
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
