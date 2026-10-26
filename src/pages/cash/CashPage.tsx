import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, CalendarCheck, Coins, Lock, MonitorSmartphone, Receipt, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { parseTL, tl } from '@shared/money';
import { fmtDateLong, fmtTime } from '@shared/time';
import type { BusinessDayDTO, ZSummary } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Field, Input, Segmented } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';
import { Badge, Card, EmptyState, PageHeader, PageLoading } from '@/components/ui/misc';
import { errorMessage, get, post } from '@/lib/api';
import { withApproval } from '@/lib/approval';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { toast } from '@/lib/toast';
import { CashCount, type CountResult } from './CashCount';
import { ZView } from './ZView';

interface DayResponse {
  day: BusinessDayDTO | null;
  summary: ZSummary | null;
  movements: { id: string; kind: 'harcama' | 'teslim' | 'giris'; amount: number; description: string; userName: string | null; createdAt: number }[];
  /** Kör kasa: bu kullanıcı kasa rakamlarını görmez */
  blind?: boolean;
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
  const [count, setCount] = useState<CountResult>(emptyCount());
  const [counted, setCounted] = useState(true);
  const [note, setNote] = useState('');
  const [zResult, setZResult] = useState<DayDetail | null>(null);
  const [fillFor, setFillFor] = useState<DayDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['cash'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };

  const openDay = async () => {
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

  const addMove = async () => {
    if (!moveKind) return;
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
      await post(`/cash/days/${fillFor.day.id}/count`, { countedCash: count.countedCash, methodCounts: count.methodCounts, banknotes: count.banknotes, note: note || null });
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

  if (current.isLoading) return <PageLoading />;
  const day = current.data?.day ?? null;
  const summary = current.data?.summary ?? null;
  // Kör kasa: kasiyerin `kasa.rakam` yetkisi yoksa sunucu ara raporu ve beklenen nakdi göndermez
  const blind = current.data?.blind ?? false;
  const movements = current.data?.movements ?? [];

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      <PageHeader
        title="Kasa"
        subtitle={day ? `Z ${day.zNo} · ${fmtDateLong(day.date)} · ${day.openedByName ?? ''} ${fmtTime(day.openedAt)}'de açtı` : 'Gün kapalı'}
        actions={
          <>
            {boot.integrations.okc.provider === 'simulator' && (
              <Link to="/cihaz">
                <Button icon={<MonitorSmartphone className="size-4" />}>Eğitim cihazı</Button>
              </Link>
            )}
            {can('rapor.gor') && (
              <Segmented
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

      {tab === 'bugun' && !day && (
        <div className="mx-auto max-w-md">
          <Card>
            <div className="space-y-4 p-6 text-center">
              <CalendarCheck className="mx-auto size-12 text-forest-500" />
              <div>
                <h2 className="text-xl font-semibold">Günü aç</h2>
                <p className="text-sm text-muted">Çekmecedeki açılış nakitini girin. Gün 05:00 kuralıyla lafmaliyet'teki tarihe yazılır</p>
              </div>
              {can('kasa.gun') ? (
                <>
                  <div className="tabular rounded-2xl border border-line bg-surface-2 px-4 py-3 text-right text-4xl font-semibold">{opening || '0'} ₺</div>
                  <Numpad decimal onKey={(k) => setOpening(applyNumpadKey(opening, k, { decimal: true, maxLength: 9 }))} />
                  <Button variant="primary" size="xl" block loading={busy} onClick={openDay}>
                    Günü aç
                  </Button>
                </>
              ) : (
                <p className="text-sm text-burgundy-500">Günü kasiyer, müdür ya da patron açabilir</p>
              )}
            </div>
          </Card>
        </div>
      )}

      {tab === 'bugun' && day && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {can('kasa.hareket') && (
              <>
                <Button icon={<ArrowUpFromLine className="size-4" />} onClick={() => setMoveKind('harcama')}>
                  Harcama
                </Button>
                <Button icon={<Wallet className="size-4" />} onClick={() => setMoveKind('teslim')}>
                  Teslim
                </Button>
                <Button icon={<ArrowDownToLine className="size-4" />} onClick={() => setMoveKind('giris')}>
                  Kasaya giriş
                </Button>
              </>
            )}
            <div className="flex-1" />
            {can('kasa.gun') && (
              <Button variant="danger" icon={<Lock className="size-4" />} onClick={() => setClosing(true)}>
                Gün sonu (Z)
              </Button>
            )}
          </div>

          {summary ? (
            <ZView day={day} summary={summary} lafmaliyet={null} title={`Ara rapor (X) · Z ${day.zNo}`} />
          ) : (
            <Card title="Kör kasa">
              <p className="px-4 py-4 text-sm text-muted">
                Ara rapor ve beklenen nakit bu rolde görünmez. Gün sonunda çekmeceyi sayıp yazın; fark yöneticinin ekranında ve Z raporunda. Rakamları görmek için yöneticiden "Ara rapor (X) ve kasa rakamlarını görme" yetkisi isteyin
              </p>
            </Card>
          )}

          <Card title="Kasa hareketleri">
            {movements.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted">Bugün kasa hareketi yok</p>
            ) : (
              <ul className="divide-y divide-line">
                {movements.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <Badge tone={m.kind === 'giris' ? 'green' : m.kind === 'teslim' ? 'blue' : 'red'}>{MOVE_LABEL[m.kind]}</Badge>
                    <span className="min-w-0 flex-1 truncate">{m.description || '—'}</span>
                    <span className="text-xs text-muted">
                      {m.userName} · {fmtTime(m.createdAt)}
                    </span>
                    <span className="tabular font-semibold">{tl(m.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {tab === 'gecmis' && !selected && (
        <Card>
          {(days.data ?? []).length === 0 ? (
            <EmptyState icon={<Receipt />} title="Henüz kapanmış gün yok" />
          ) : (
            <ul className="divide-y divide-line">
              {days.data?.map((d) => (
                <li key={d.id}>
                  <button onClick={() => setSelected(d.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2">
                    <span className="tabular w-14 font-semibold">Z {d.zNo}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block">{fmtDateLong(d.date)}</span>
                      <span className="text-xs text-muted">{d.closedAt ? `${d.receipts ?? 0} adisyon` : 'Açık'}</span>
                    </span>
                    {d.closedAt && d.cashDiff == null && <Badge tone="brass">Föy girilmedi</Badge>}
                    {d.cashDiff != null && d.cashDiff !== 0 && <Badge tone="red">Fark {tl(d.cashDiff)}</Badge>}
                    <span className="tabular w-28 text-right font-semibold">{d.netSales != null ? tl(d.netSales) : '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
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
          <div className="tabular rounded-2xl border border-line bg-surface-2 px-4 py-3 text-right text-3xl font-semibold">{moveAmount || '0'} ₺</div>
          <Numpad size="md" decimal onKey={(k) => setMoveAmount(applyNumpadKey(moveAmount, k, { decimal: true }))} />
          <Field label="Açıklama">
            <Input value={moveDesc} onChange={(e) => setMoveDesc(e.target.value)} placeholder={moveKind === 'harcama' ? 'Ör. Süt (market), fiş no' : 'İsteğe bağlı'} />
          </Field>
          <Button variant="primary" block disabled={!parseTL(moveAmount || '0') || (moveKind === 'harcama' && !moveDesc.trim())} onClick={addMove}>
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
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!counted} onChange={(e) => setCounted(!e.target.checked)} className="size-4" />
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
    </div>
  );
}
