import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTableCode, normalizeTableCode, TABLE_CODE_ALPHABET, TABLE_CODE_LENGTH, TABLE_URL_BASE, tableQrUrl } from '@shared/table-qr';
import type { BootstrapDTO } from '@shared/types';
import { type FakeSite, startFakeSite } from './fake-site';
import { PINS, startApp, type Harness } from './harness';
import { SITE_AKTOR } from '@shared/eski-adlar';

/**
 * Masaya özel QR: kodu AsilPOS üretir (sitenin 10 simgelik Crockford kuralı), QR içeriği sitenin masa adresi.
 * Yönetim › Masa planı'ndan masa başına ya da toplu üretilir, yenilenir; elle yazılamaz. Siteden gelen masa siparişi
 * önce koduyla (`tableCode`), sonra etiketiyle masaya düşer. Liste siteye giden kutusundan gider; site ucu henüz
 * tanımıyorsa (404) yeniden denenmez ve Entegrasyon'da görünür.
 */
const SECRET = 'q'.repeat(48);
let h: Harness;
let site: FakeSite;
let boot: BootstrapDTO;

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  h = await startApp({ LAFFOGATO_URL: site.url, LAFFOGATO_SYNC_SECRET: SECRET });
  boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(async () => {
  h.cleanup();
  await site.close();
});

const table = (name: string) => boot.tables.find((t) => t.name === name)!;

describe('masa kodu: saf kurallar', () => {
  it('10 simge, yalnız Crockford alfabesi, birbirinden farklı; adres sitenin masa adresi', () => {
    const codes = Array.from({ length: 300 }, () => generateTableCode());
    for (const c of codes) {
      expect(c).toHaveLength(TABLE_CODE_LENGTH);
      for (const ch of c) expect(TABLE_CODE_ALPHABET).toContain(ch);
    }
    expect(new Set(codes).size).toBe(codes.length);
    expect(TABLE_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    expect(tableQrUrl('0123456789')).toBe('https://laffogato.net/masa/0123456789');
    expect(TABLE_URL_BASE.startsWith('https://laffogato.net/')).toBe(true);
    // 32, 256'yı böler: her bayt alınır (250 → 'T', 1 → '1'); üretici verilen rastgelelikle belirlenir
    const fixed = generateTableCode((n) => Uint8Array.from({ length: n }, (_, i) => (i === 0 ? 250 : 1)));
    expect(fixed).toBe(`T${'1'.repeat(9)}`);
  });

  it('yazılan kod katlanır: küçük harf, boşluk, tire, O → 0, I ve L → 1; yanlış uzunluk ya da simge null', () => {
    expect(normalizeTableCode(' ab12-cd34 ef ')).toBe('AB12CD34EF');
    expect(normalizeTableCode('o1lI0Oabcd')).toBe('011100ABCD');
    expect(normalizeTableCode('ABCDEFGHJ')).toBeNull();
    expect(normalizeTableCode('ABCDEFGHJKM')).toBeNull();
    expect(normalizeTableCode('ABCDEFGHJU')).toBeNull();
    expect(normalizeTableCode(12)).toBeNull();
    expect(normalizeTableCode(null)).toBeNull();
  });
});

describe('masa QR yönetimi', () => {
  let s1Code = '';

  it('masaya QR üretilir; ikinci istek aynı kodu verir; yenileme değiştirir; yetki ayar.yonet', async () => {
    const s1 = table('S1');
    const denied = await h.call('kasa', 'POST', `/admin/tables/${s1.id}/qr`, {});
    expect(denied.status).toBe(403);
    const made = await h.ok<{ qrCode: string; url: string; changed: boolean }>('patron', 'POST', `/admin/tables/${s1.id}/qr`, {});
    expect(made.qrCode).toHaveLength(10);
    expect(made.url).toBe(tableQrUrl(made.qrCode));
    expect(made.changed).toBe(true);
    const again = await h.ok<{ qrCode: string; changed: boolean }>('patron', 'POST', `/admin/tables/${s1.id}/qr`, {});
    expect([again.qrCode, again.changed]).toEqual([made.qrCode, false]);
    const rotated = await h.ok<{ qrCode: string; changed: boolean }>('patron', 'POST', `/admin/tables/${s1.id}/qr`, { rotate: true });
    expect(rotated.changed).toBe(true);
    expect(rotated.qrCode).not.toBe(made.qrCode);
    s1Code = rotated.qrCode;
    const fresh = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    expect(fresh.tables.find((t) => t.id === s1.id)?.qrCode).toBe(s1Code);
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=10');
    expect(audit.some((a) => a.action === 'table.qr_rotated' && a.message.includes('S1'))).toBe(true);
    expect(audit.some((a) => a.action === 'table.qr_created' && a.message.includes('S1'))).toBe(true);
    const missing = await h.call('patron', 'POST', '/admin/tables/yok/qr', {});
    expect(missing.status).toBe(404);
  });

  it('kod elle yazılamaz: PATCH gövdesindeki qrCode düşer', async () => {
    const s1 = table('S1');
    await h.ok('patron', 'PATCH', `/admin/tables/${s1.id}`, { qrCode: 'ABCDEFGHJK', seats: 4 });
    const fresh = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    const row = fresh.tables.find((t) => t.id === s1.id)!;
    expect([row.qrCode, row.seats]).toEqual([s1Code, 4]);
  });

  it('toplu üretim: kodu olmayan etkin masalar (oda değil); ikinci çağrı 0', async () => {
    const masa = boot.tables.filter((t) => t.kind === 'masa');
    const r = await h.ok<{ created: number }>('patron', 'POST', '/admin/tables/qr', {});
    expect(r.created).toBe(masa.length - 1);
    const fresh = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    for (const t of fresh.tables) {
      if (t.kind === 'masa') expect(t.qrCode).toHaveLength(10);
      else expect(t.qrCode).toBeNull();
    }
    expect(new Set(fresh.tables.map((t) => t.qrCode).filter(Boolean)).size).toBe(masa.length);
    expect((await h.ok<{ created: number }>('patron', 'POST', '/admin/tables/qr', {})).created).toBe(0);
  });

  it('siteden gelen masa siparişi önce koduyla masaya düşer (yazım farkı katlanır), kod yoksa etiketiyle', async () => {
    const { upsertOnlineOrders } = await import('../server/sync/laffogato-orders');
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const base = { stage: 'new' as const, firstName: 'Ayşe', scheduledFor: '', note: '', paidAt: new Date().toISOString(), lines: [{ menuItemId: 'mnu-0003', name: 'Latte', size: 'M' as const, detail: '', note: '', qty: 1 }], totalMinor: 16000 };
    const s1 = table('S1');
    const b1 = table('B1');
    // Etiket başka masayı (B1) söylüyor ama kod S1: kod kazanır. Kod küçük harf ve tireli yazılmış
    const spelled = `${s1Code.slice(0, 5)}-${s1Code.slice(5).toLowerCase()}`;
    upsertOnlineOrders([
      { ...base, id: 'ord-qr-1', orderNo: 9101, fulfillment: 'table', label: 'Masa B1', tableCode: spelled },
      { ...base, id: 'ord-qr-2', orderNo: 9102, fulfillment: 'table', label: 'B1', tableCode: 'YOK' },
      { ...base, id: 'ord-qr-3', orderNo: 9103, fulfillment: 'table', label: 'Masa 99' },
    ]);
    const rows = db.select().from(schema.orders).where(eq(schema.orders.source, 'laffogato')).all();
    const by = (ext: string) => rows.find((o) => o.extId === ext)!;
    expect(by('ord-qr-1').tableId).toBe(s1.id);
    expect(by('ord-qr-2').tableId).toBe(b1.id);
    expect(by('ord-qr-3').tableId).toBeNull();
  });

  it('kod listesi siteye giden kutusundan gider; site ucu tanımıyorsa (404) ertelenir ve Entegrasyon "site henüz almıyor" der', async () => {
    const { db, schema } = await import('../server/db/client');
    const { and, eq, isNull } = await import('drizzle-orm');
    const { flushSiteOutbox, withSiteMenuLock, TABLES_PUSH_STATE } = await import('../server/sync/site-outbox');
    const { getSyncState } = await import('../server/lib/settings');
    // Kod üretiminin arka planda başlattığı gönderim kilit zincirinde bekliyor olabilir: önce bitsin
    await withSiteMenuLock(async () => undefined);
    const pending = () => db.select().from(schema.outbox).where(and(eq(schema.outbox.kind, 'tables.sync'), isNull(schema.outbox.sentAt))).all();
    expect(pending()).toHaveLength(1);
    const payload = pending()[0]!.payload as { tables: { code: string; name: string; active: boolean }[]; actor: string };
    expect(payload.actor).toBe(SITE_AKTOR);
    // Etkin masalar + yenilenen eski kod (pasif)
    expect(payload.tables.filter((t) => t.active).length).toBe(boot.tables.filter((t) => t.kind === 'masa').length);
    expect(payload.tables.filter((t) => !t.active).length).toBe(1);
    expect(payload.tables.find((t) => t.name === 'S1')?.code).toBe(s1Code);
    // Masa adı değişince liste yenilenir (yine tek kayıt)
    await h.ok('patron', 'PATCH', `/admin/tables/${table('S1').id}`, { name: 'S1 Pencere' });
    expect(pending()).toHaveLength(1);
    expect((pending()[0]!.payload as typeof payload).tables.find((t) => t.code === s1Code)?.name).toBe('S1 Pencere');
    // Kod üretimi listeyi hemen göndermeyi denemişti (404); ad değişince yeni kayıt yeniden dener
    const calls = site.count('PUT /api/panel/tables');
    await flushSiteOutbox();
    expect(site.count('PUT /api/panel/tables')).toBe(calls + 1);
    // Site ucu yok (404): kayıt düşmez, 6 saat sonrasına ertelenir
    expect(pending()).toHaveLength(1);
    expect(pending()[0]!.nextAttemptAt).toBeGreaterThan(Date.now() + 5 * 3600_000);
    expect(getSyncState<{ unsupported?: boolean }>(TABLES_PUSH_STATE)?.unsupported).toBe(true);
    const status = await h.ok<{ online: { tablesPush: { unsupported?: boolean } | null } }>('patron', 'GET', '/sync/status');
    expect(status.online.tablesPush?.unsupported).toBe(true);
    await h.ok('patron', 'PATCH', `/admin/tables/${table('S1').id}`, { name: 'S1' });
  });

  it('odaya QR üretilmez; plandan kaldırılmış masanın kodu siparişi masaya düşürmez', async () => {
    const oda = boot.tables.find((t) => t.kind === 'oda')!;
    const r = await h.call<{ code: string }>('patron', 'POST', `/admin/tables/${oda.id}/qr`, {});
    expect([r.status, r.json.code]).toEqual([400, 'not_table']);
    const { upsertOnlineOrders, tableForOrder } = await import('../server/sync/laffogato-orders');
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const b9 = table('B9');
    const code = db.select({ qrCode: schema.tables.qrCode }).from(schema.tables).where(eq(schema.tables.id, b9.id)).get()!.qrCode!;
    await h.ok('patron', 'PATCH', `/admin/tables/${b9.id}`, { active: false });
    const rows = db.select().from(schema.tables).all();
    expect(tableForOrder(rows, { label: 'Masa 99', tableCode: code })).toBeUndefined();
    const base = { stage: 'new' as const, firstName: 'Can', scheduledFor: '', note: '', paidAt: new Date().toISOString(), lines: [{ menuItemId: 'mnu-0003', name: 'Latte', size: 'M' as const, detail: '', note: '', qty: 1 }], totalMinor: 16000 };
    upsertOnlineOrders([{ ...base, id: 'ord-qr-pasif', orderNo: 9104, fulfillment: 'table', label: 'Masa 99', tableCode: code }]);
    expect(db.select().from(schema.orders).where(eq(schema.orders.extId, 'ord-qr-pasif')).get()?.tableId).toBeNull();
    await h.ok('patron', 'PATCH', `/admin/tables/${b9.id}`, { active: true });
  });

  it('kod yenilenince eski kod siteye pasif gider; site ucu yoksa kayıt kalır ve 6 saat sonra yeniden denenir; "yeniden gönder"', async () => {
    const { db, schema } = await import('../server/db/client');
    const { and, eq, isNull } = await import('drizzle-orm');
    const { flushSiteOutbox, RETIRED_CODES_STATE } = await import('../server/sync/site-outbox');
    const { getSyncState } = await import('../server/lib/settings');
    const s2 = table('S2');
    const before = db.select({ qrCode: schema.tables.qrCode }).from(schema.tables).where(eq(schema.tables.id, s2.id)).get()!.qrCode!;
    await h.ok('patron', 'POST', `/admin/tables/${s2.id}/qr`, { rotate: true });
    expect(getSyncState<string[]>(RETIRED_CODES_STATE)).toContain(before);
    const pending = () => db.select().from(schema.outbox).where(and(eq(schema.outbox.kind, 'tables.sync'), isNull(schema.outbox.sentAt))).all();
    // Üretim hemen göndermeyi dener (sahte site 404): kayıt düşmez, 6 saat sonrasına ertelenir
    await flushSiteOutbox();
    const row = pending()[0];
    expect(row).toBeTruthy();
    expect(row!.nextAttemptAt - Date.now()).toBeGreaterThan(5 * 3600_000);
    const payload = row!.payload as { tables: { code: string; active: boolean; name: string }[] };
    expect(payload.tables.find((t) => t.code === before)).toMatchObject({ active: false });
    expect(payload.tables.some((t) => t.active && t.name === 'S2')).toBe(true);
    expect(payload.tables.every((t) => t.name !== 'Karaoke odası')).toBe(true);
    // Yeniden gönder: hemen dener
    const calls = site.count('PUT /api/panel/tables');
    const r = await h.ok<{ ok: boolean; sent: number; failed: number }>('patron', 'POST', '/admin/tables/qr/sync', {});
    expect(r.ok).toBe(true);
    expect(site.count('PUT /api/panel/tables')).toBe(calls + 1);
    expect((await h.call('kasa', 'POST', '/admin/tables/qr/sync', {})).status).toBe(403);
  });

  it('servis modu QR + self: ayardan seçilir, bootstrap ve denetim kaydı', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { serviceMode: 'qr_self' });
    const fresh = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    expect(fresh.settings.serviceMode).toBe('qr_self');
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=5');
    expect(audit.some((a) => a.message.includes('QR + self servis'))).toBe(true);
    const bad = await h.call('patron', 'PUT', '/admin/settings', { serviceMode: 'qr' });
    expect(bad.status).toBe(422);
    await h.ok('patron', 'PUT', '/admin/settings', { serviceMode: 'masa' });
    expect(PINS.patron).toBeTruthy();
  });
});
