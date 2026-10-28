import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { businessDate } from '@shared/time';
import { nextZNo, Z_NO_MAX } from '@shared/z-no';
import { type Harness, startApp } from './harness';

/**
 * İlk Z numarası (s-10): geçişte Z zinciri ModPOS'un son Z'sinden devam eder. Ayar yalnız yukarı doğru etkiler
 * (açılan gün = max(kayıtlı en büyük Z, ilk Z − 1) + 1), kayıtlı günlerin numarası değişmez, zincir geri alınmaz;
 * yalnız ayar yetkisiyle, denetim kaydıyla (docs/03-ENTEGRASYON.md §8).
 */
let h: Harness;
let modules: {
  db: typeof import('../server/db/client').db;
  schema: typeof import('../server/db/client').schema;
};
let past = 0;

beforeAll(async () => {
  h = await startApp();
  const client = await import('../server/db/client');
  modules = { db: client.db, schema: client.schema };
});
afterAll(() => h.cleanup());

type ZChain = { lastZ: number | null; nextZ: number };
type Day = { id: string; zNo: number; trainingDay: boolean | null };

/** Açık günü kapatır, tarihini geçmişe alır (bir iş gününe tek Z) ve yeni gün açar */
async function nextDay(): Promise<Day> {
  const { db, schema } = modules;
  if ((await h.ok<{ day: unknown }>('kasa', 'GET', '/cash/day')).day) await h.ok('kasa', 'POST', '/cash/day/close', { countedCash: 0 });
  db.update(schema.businessDays)
    .set({ date: `2026-09-${String(++past).padStart(2, '0')}` })
    .where(eq(schema.businessDays.date, businessDate(Date.now())))
    .run();
  return h.ok<Day>('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
}

function zAudits() {
  const { db, schema } = modules;
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'settings.z_start')).orderBy(desc(schema.auditLog.id)).all();
}

const putZ = (zNoStart: unknown, who = 'patron') => h.call<{ error?: string; code?: string; zNoStart?: number | null }>(who, 'PUT', '/admin/settings', { zNoStart });

describe('nextZNo', () => {
  it('kayıtlı en büyük Z + 1; ilk Z numarası daha büyükse o; küçük ya da boş zinciri geri almaz', () => {
    expect(nextZNo(0, null)).toBe(1);
    expect(nextZNo(0, undefined)).toBe(1);
    expect(nextZNo(7, null)).toBe(8);
    expect(nextZNo(0, 1201)).toBe(1201);
    expect(nextZNo(7, 1201)).toBe(1201);
    expect(nextZNo(1201, 1201)).toBe(1202);
    expect(nextZNo(1250, 1201)).toBe(1251);
    expect(nextZNo(7, 1)).toBe(8);
    expect(Z_NO_MAX).toBe(99_999_999);
  });
});

describe('ilk Z numarası', () => {
  it('varsayılan boş; kasaya gitmez; yetkisiz kullanıcıya 403', async () => {
    const all = await h.ok<{ zNoStart: unknown }>('patron', 'GET', '/admin/settings');
    expect(all.zNoStart).toBeNull();
    expect(await h.ok<ZChain>('patron', 'GET', '/admin/settings/z')).toEqual({ lastZ: null, nextZ: 1 });
    // Kasa ekranlarının açılış verisi ilk Z numarasını taşımaz (yalnız yönetim)
    expect(h.boot.settings).not.toHaveProperty('zNoStart');

    // Kasiyerde ayar yetkisi yok: yazamaz, okuyamaz
    expect((await putZ(1201, 'kasa')).status).toBe(403);
    expect((await h.call('kasa', 'GET', '/admin/settings/z')).status).toBe(403);
    expect((await h.ok<{ zNoStart: unknown }>('patron', 'GET', '/admin/settings')).zNoStart).toBeNull();
    expect(zAudits()).toHaveLength(0);
  });

  it('geçerli aralık: tam sayı, 1 ile 99 999 999 arası', async () => {
    for (const bad of [0, -5, 12.5, Z_NO_MAX + 1, '1201']) expect((await putZ(bad)).status).toBe(422);
    expect(zAudits()).toHaveLength(0);
  });

  it('eğitim günleri zincirdedir; ilk Z girilince sıradaki gün oradan başlar, sonraki bir fazlası', async () => {
    // Yeni kurulum kurulum modunda: ilk gün eğitim günü, Z 1
    const training = await nextDay();
    expect(training.zNo).toBe(1);
    await h.ok('kasa', 'POST', '/cash/day/close', { countedCash: 0 });
    const { db, schema } = modules;
    expect(db.select().from(schema.businessDays).where(eq(schema.businessDays.id, training.id)).get()?.trainingDay).toBe(true);

    const { bus } = await import('../server/lib/events');
    const seen: string[] = [];
    const listen = (e: LiveEvent) => seen.push(`${e.topic}:${e.kind}`);
    bus.on('event', listen);
    const saved = await putZ(1201);
    bus.off('event', listen);
    expect(saved.status).toBe(200);
    expect(saved.json.zNoStart).toBe(1201);
    expect(seen).toContain('settings:settings.updated');
    expect(seen).toContain('alerts:settings.z_start');
    expect(await h.ok<ZChain>('patron', 'GET', '/admin/settings/z')).toEqual({ lastZ: 1, nextZ: 1201 });

    const [audit] = zAudits();
    expect(audit).toMatchObject({ action: 'settings.z_start', severity: 'uyari', entity: 'settings', entityId: 'zNoStart', data: { from: null, to: 1201 } });
    expect(audit?.message).toMatch(/ilk Z numarasını değiştirdi: boş → 1201$/);

    // Kurulum modu kapanır (canlıya geçiş); eğitim gününün numarası değişmez
    await h.ok('patron', 'PUT', '/admin/settings', { demoMode: false });
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'kapali' });
    const first = await nextDay();
    expect(first.zNo).toBe(1201);
    expect(first.trainingDay).toBeNull();
    const second = await nextDay();
    expect(second.zNo).toBe(1202);
    expect(db.select().from(schema.businessDays).where(eq(schema.businessDays.id, training.id)).get()?.zNo).toBe(1);
    expect(await h.ok<ZChain>('patron', 'GET', '/admin/settings/z')).toEqual({ lastZ: 1202, nextZ: 1203 });
  });

  it('kayıtlı en büyük Z ve altı 422: zincir geri alınmaz', async () => {
    // 1201 kayıtlı değerin kendisi: değişiklik değil (aşağıda)
    for (const low of [1202, 1200, 1100, 1]) {
      const r = await putZ(low);
      expect(r.status).toBe(422);
      expect(r.json.code).toBe('z_start_low');
      expect(r.json.error).toBe('Z numarası geri alınamaz; son Z 1202');
    }
    // Geri alınan işlem hiçbir şey yazmaz
    expect((await h.ok<{ zNoStart: unknown }>('patron', 'GET', '/admin/settings')).zNoStart).toBe(1201);
    expect(zAudits()).toHaveLength(1);
  });

  it('başka alan kaydedilince ilk Z ezilmez; değişmeden gelen değer (tüm form) denetlenmez, kayda düşmez', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { tipsEnabled: true });
    expect((await h.ok<{ zNoStart: unknown }>('patron', 'GET', '/admin/settings')).zNoStart).toBe(1201);
    // Ayarlar ekranının Kaydet'i bütün formu gönderir: 1201 artık son Z'nin altında ama değişmedi
    const all = await h.ok<Record<string, unknown>>('patron', 'GET', '/admin/settings');
    const { menuAutoSync: _a, onlineOrdersSync: _b, serviceMode: _c, ...form } = all;
    const r = await h.call('patron', 'PUT', '/admin/settings', { ...form, receiptFooter: 'Teşekkürler' });
    expect(r.status).toBe(200);
    expect(zAudits()).toHaveLength(1);
  });

  it('müdür (ayar yetkisi) ileri alabilir; son Z üstü kabul edilir', async () => {
    const r = await putZ(1300, 'mudur');
    expect(r.status).toBe(200);
    expect(await h.ok<ZChain>('patron', 'GET', '/admin/settings/z')).toEqual({ lastZ: 1202, nextZ: 1300 });
    expect(zAudits()[0]?.data).toEqual({ from: 1201, to: 1300 });
    expect((await nextDay()).zNo).toBe(1300);
  });

  it('boşaltmak serbest ve zinciri geri almaz', async () => {
    const r = await putZ(null);
    expect(r.status).toBe(200);
    expect(r.json.zNoStart).toBeNull();
    const { db, schema } = modules;
    // Boş değer satırı siler, varsayılan (null) geçerli olur
    expect(db.select().from(schema.settings).where(eq(schema.settings.key, 'zNoStart')).get()).toBeUndefined();
    expect(zAudits()[0]).toMatchObject({ data: { from: 1300, to: null } });
    expect(zAudits()[0]?.message).toMatch(/1300 → boş$/);
    expect(await h.ok<ZChain>('patron', 'GET', '/admin/settings/z')).toEqual({ lastZ: 1300, nextZ: 1301 });
    expect((await nextDay()).zNo).toBe(1301);
    // Yeniden boş göndermek değişiklik değildir
    expect((await putZ(null)).status).toBe(200);
    expect(zAudits()).toHaveLength(3);
    const days = db.select({ zNo: schema.businessDays.zNo }).from(schema.businessDays).all().map((d) => d.zNo);
    expect(days.sort((a, b) => a - b)).toEqual([1, 1201, 1202, 1300, 1301]);
  });
});
