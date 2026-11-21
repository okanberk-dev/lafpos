import { eq } from 'drizzle-orm';
import { SITE_EVENT } from '@shared/events';
import { TABLE_CALL_OPEN_MS, type TableCallDTO, tableCallText } from '@shared/site-alerts';
import { type DB, db, schema, type Tx, tx } from '../db/client';
import { env } from '../env';
import { Effects } from '../lib/effects';
import { HttpError, notFound } from '../lib/http';
import { signedFetch } from '../lib/signature';
import { requireSiteSigned, siteSigned } from './laffogato-link';

/**
 * Masadan çağrılar (uygulamada "Garson çağır", su, peçete; laffogato `src/lib/admin/table-calls-core.ts`). Site açık
 * çağrıları sipariş listesinin `calls` alanında verir (`GET /api/panel/orders`, en eskisi önce, en çok 50): yeni istek
 * yok, var olan sipariş çekimiyle gelir (AGENTS.md kural 6). Liste `sync_state`'te durur (yeniden başlatmada da);
 * her başarılı çekimde yenisiyle değişir: listeden düşen çağrı (sitede ya da köşkün panelinde yanıtlandı, süresi geçti)
 * ekranlardan da düşer. "Gördüm" çağrıyı sitede yanıtlar (`POST /api/panel/calls/ack`, kullanıcı eylemi). Misafirin
 * adı hiç gelmez: yalnız masa ve sebep. docs/03-ENTEGRASYON.md §2.3 "Masa çağrıları"
 */

/** Sitenin listesinden okunan çağrı */
export interface PanelCall {
  id: string;
  tableCode: string;
  /** Sitenin etiketi: "Masa 4" */
  label: string;
  reason: string;
  /** ms */
  createdAt: number;
}

interface StoredCall extends PanelCall {
  /** Eşlenen yerel masa */
  tableId: string | null;
  /** Eşlenen masanın adı ("S4"); eşlenmezse null, sitenin etiketi görünür */
  tableName: string | null;
}

interface CallsState {
  calls: StoredCall[];
  /** LafPOS'ta yanıtlanan çağrılar (kimlik → an): yanıttan önce istenmiş bir liste onları geri getirmesin */
  acked: Record<string, number>;
  /**
   * Son işlenen listenin istendiği an: ondan önce istenmiş (ağda gecikmiş) liste yenisini ezmez. İleride görünüyorsa
   * (bilgisayarın saati geri alındı) bekçi değildir: sonraki liste işlenir, damga bugünün saatine döner
   */
  requestedAt: number;
}

const KEY = 'laffogato.calls';
/** Sitenin çağrı kimliği kuralı (laffogato `calls-ack-core.ts` `CALL_ID`) */
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Sitenin saati bizimkinden bu kadar ileride olsa da çağrı sayılır (sitenin `FUTURE_SKEW_MS`) */
const FUTURE_SKEW_MS = 5 * 60_000;
/** Sitenin ack ucunun `actor` sınırı (`PANEL_STAGE_ACTOR_MAX`) */
const ACTOR_MAX = 80;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Listenin `calls` alanı. Dizi değilse null (alanı göndermeyen eski site: çağrı bilinmiyor, eldeki liste korunur).
 * Okunamayan satır (kimlik, etiket ya da zaman yok) atlanır; site yeni bir sebep eklerse çağrı yine görünür ("Çağırıyor").
 */
export function parsePanelCalls(raw: unknown): PanelCall[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PanelCall[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const label = str(r.label, 60);
    const reason = str(r.reason, 24);
    const createdAt = typeof r.createdAt === 'string' ? Date.parse(r.createdAt) : NaN;
    if (!CALL_ID.test(id) || !label || !reason || !Number.isFinite(createdAt)) continue;
    out.push({ id, tableCode: str(r.tableCode, 32), label, reason, createdAt });
  }
  return out;
}

function readState(t: Tx | DB): CallsState {
  const v = t.select().from(schema.syncState).where(eq(schema.syncState.key, KEY)).get()?.value as Partial<CallsState> | undefined;
  return {
    calls: Array.isArray(v?.calls) ? v.calls : [],
    acked: v?.acked && typeof v.acked === 'object' ? v.acked : {},
    requestedAt: typeof v?.requestedAt === 'number' ? v.requestedAt : 0,
  };
}

function writeState(t: Tx | DB, value: CallsState) {
  const now = Date.now();
  t.insert(schema.syncState).values({ key: KEY, value, updatedAt: now }).onConflictDoUpdate({ target: schema.syncState.key, set: { value, updatedAt: now } }).run();
}

const toDTO = (c: StoredCall): TableCallDTO => ({ id: c.id, label: c.tableName ?? c.label, reason: c.reason, tableId: c.tableId, createdAt: c.createdAt });

/**
 * Çekilen listeyi işler (sipariş çekiminin işleminde, `upsertOnlineOrders`). Yeni çağrı cihazlarda çalar
 * (`tables` › `site.call.new`, "Masa 4 · Su istiyor"); listeden düşen `site.call.done`. `mapTable`: siparişlerin masa
 * kuralı (önce QR kodu, sonra etiket). LafPOS'ta yanıtlanmış çağrı, eski bir listede gelse de geri gelmez.
 */
export function applyTableCalls(
  t: Tx,
  list: PanelCall[] | null,
  fx: Effects,
  mapTable: (c: Pick<PanelCall, 'label' | 'tableCode'>) => { id: string; name: string } | undefined,
  requestedAt = Number.POSITIVE_INFINITY,
): { added: number; removed: number } {
  if (!list) return { added: 0, removed: 0 };
  const now = Date.now();
  const prev = readState(t);
  const asked = Math.min(requestedAt, now);
  // Bu liste daha yeni bir çekimin listesinden önce istendi: eskidir, sonraki çekim geçerli. Saklanan damga ileride
  // görünüyorsa bilgisayarın saati geri alındı (Windows saat eşitlemesi): liste işlenir, damga bugünün saatine döner;
  // yoksa saat yetişene dek (yeniden başlatmada da) hiçbir liste işlenmezdi (siparişlerin `changedSince` kuralı)
  if (asked < prev.requestedAt && prev.requestedAt <= now) return { added: 0, removed: 0 };
  const acked: Record<string, number> = {};
  for (const [id, at] of Object.entries(prev.acked)) if (now - at < TABLE_CALL_OPEN_MS + FUTURE_SKEW_MS) acked[id] = at;
  const before = new Map(prev.calls.map((c) => [c.id, c]));
  const calls: StoredCall[] = list
    .filter((c) => !acked[c.id])
    .map((c) => {
      const table = mapTable(c);
      return { ...c, tableId: table?.id ?? null, tableName: table?.name ?? null };
    });
  let added = 0;
  for (const c of calls) {
    if (before.has(c.id) || !ringsAt(c, now)) continue;
    added++;
    // Metinde yalnız masa ve sebep (shared/events.ts)
    fx.emit({ topic: 'tables', kind: SITE_EVENT.callNew, tableId: c.tableId ?? undefined, message: tableCallText(toDTO(c)) });
  }
  const next = new Set(calls.map((c) => c.id));
  let removed = 0;
  for (const c of prev.calls) {
    if (next.has(c.id)) continue;
    removed++;
    fx.emit({ topic: 'tables', kind: SITE_EVENT.callDone, tableId: c.tableId ?? undefined });
  }
  writeState(t, { calls, acked, requestedAt: asked });
  return { added, removed };
}

/** Çağrı hâlâ açık mı: 15 dakikadan genç (sitenin saatiyle; biraz ileride olan da sayılır) */
const ringsAt = (c: Pick<PanelCall, 'createdAt'>, now: number) => now - c.createdAt < TABLE_CALL_OPEN_MS && c.createdAt <= now + FUTURE_SKEW_MS;

/**
 * Açık çağrılar, en eskisi önce (`GET /api/sync/alerts`, Masalar'daki rozet). Yalnız yerel kayıt; siteye istek yok.
 * Süresi geçen (15 dk) çağrı, liste yenilenmeden de düşer. Site bağlantısı yoksa boş.
 */
export function tableCallsView(now = Date.now(), t: Tx | DB = db): TableCallDTO[] {
  if (!siteSigned()) return [];
  return readState(t)
    .calls.filter((c) => ringsAt(c, now))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .map(toDTO);
}

/**
 * "Gördüm": çağrıyı sitede yanıtlar (`POST /api/panel/calls/ack`, gövde `{id, actor}`; site `lafpos:<ad>` yazar),
 * sonra yerelde düşürür, denetim kaydına yazar ve cihazlara yayar. Site 404 derse (çağrı sitede yok) yine düşer.
 * Siteye ulaşılamazsa ya da site kabul etmezse 502: çağrı açık kalır, yeniden denenir. Aynı çağrıya ikinci "Gördüm"
 * (başka cihazdan, aynı anda) siteye gitmeden tamam döner.
 */
export async function ackTableCall(id: string, actor: { id: string; name: string }): Promise<{ ok: true; already?: true }> {
  requireSiteSigned();
  const state = readState(db);
  if (state.acked[id]) return { ok: true, already: true };
  const call = state.calls.find((c) => c.id === id);
  if (!call) throw notFound('Çağrı');
  const name = actor.name.trim().slice(0, ACTOR_MAX).trim() || 'LafPOS';
  const { status } = await signedFetch(env.laffogatoPanelSecret, 'POST', new URL(`${env.laffogatoUrl}/api/panel/calls/ack`), { id, actor: name }).catch(() => {
    throw new HttpError(502, 'Siteye ulaşılamadı; çağrı sitede açık kaldı. İnternet gelince yeniden deneyin', 'site_call');
  });
  if (status !== 200 && status !== 404) throw new HttpError(502, `Site çağrının yanıtını kabul etmedi (HTTP ${status})`, 'site_call');
  const fx = new Effects();
  const first = tx((t) => {
    const s = readState(t);
    // Başka cihazın "Gördüm"ü yanıt ağdayken yazıldı: ikinci kayıt ve olay yok
    if (s.acked[id]) return false;
    writeState(t, { ...s, calls: s.calls.filter((c) => c.id !== id), acked: { ...s.acked, [id]: Date.now() } });
    fx.audit(t, {
      userId: actor.id,
      action: 'table.call_ack',
      entity: 'table',
      entityId: call.tableId,
      message: `${actor.name}: masa çağrısını gördü (${tableCallText(toDTO(call))})${status === 404 ? '; çağrı sitede yoktu' : ''}`,
    });
    return true;
  });
  if (!first) return { ok: true, already: true };
  fx.emit({ topic: 'tables', kind: SITE_EVENT.callDone, tableId: call.tableId ?? undefined, byUserId: actor.id });
  fx.flush();
  return { ok: true };
}
