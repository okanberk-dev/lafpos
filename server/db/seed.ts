import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { ROOT } from '../env';
import { hashPin } from '../lib/auth';
import { ulid } from '../lib/ids';
import { updateSettings } from '../lib/settings';
import { applyMenu, type SiteMenu } from '../sync/laffogato-menu';
import { db, runMigrations, schema, tx } from './client';

/**
 * Deneme modunda giriş ekranında görünen örnek personel ve PIN'leri: kafede her rolü denemek için. "Denemeyi bitir,
 * gerçek kullanıma başla" (services/deneme.ts) patronun PIN'ini değiştirtir, örnek PIN'iyle kalan öbür hesapları
 * kapatır; gerçek kullanımda bu PIN'ler bir daha verilmez.
 */
export const DEMO_USERS = [
  { name: 'Patron', role: 'patron', pin: '1897', color: '#1e4031' },
  { name: 'Müdür', role: 'mudur', pin: '2468', color: '#6b1a2b' },
  { name: 'Kasa', role: 'kasiyer', pin: '1111', color: '#a87c2e' },
  { name: 'Garson', role: 'garson', pin: '2222', color: '#3f6b8a' },
  { name: 'Bar ekranı', role: 'mutfak', pin: '3333', color: '#5e8f45' },
] as const;

/**
 * Boş veritabanına kurulum verisini yükler. Kafe kurulumunda (`LafPOS-Kurulum.exe`, `npm start`) yalnız işletmenin
 * başlamak için gerektirdiği kurulum gelir: rol hesapları (örnek PIN'li), istasyonlar, yazıcı, köşkün masa planı ve
 * karaoke odası, ödeme türleri, sitenin menüsü (anlık görüntü; site bağlantısı kurulunca güncellenir) ve kasaya özgü
 * ürünler (karaoke saati, yenilebilir bardak, şeker ve bardak seçimi). Adisyon, ödeme, gün, müşteri, rezervasyon gibi
 * hiçbir hareket yazılmaz (tests/deneme-modu.test.ts). Kurulum deneme modunda açılır (`demoMode`, eğitim yazarkasası).
 *
 * `demo: true` (tarayıcı demosu, `LAFPOS_DEMO_SEED=1`): ayrıca örnek kampanya (kapalı "Öğle kahvesi" happy hour'u).
 * Demonun ilk gününün satışları ayrıca demo/scenario.ts'ten gerçek uçlarla girilir.
 */
export function seedIfEmpty(opts: { demo?: boolean } = {}): boolean {
  const demo = opts.demo ?? (typeof process !== 'undefined' && process.env?.LAFPOS_DEMO_SEED === '1');
  const row = db.select({ n: sql<number>`count(*)` }).from(schema.users).get();
  if ((row?.n ?? 0) > 0) return false;

  const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'server/db/menu-snapshot.json'), 'utf8')) as SiteMenu;

  tx((t) => {
    const browserPrinter = ulid();
    t.insert(schema.printers).values({ id: browserPrinter, name: 'Bu cihaz (tarayıcı)', kind: 'tarayici', docs: ['adisyon', 'mutfak', 'z'] }).run();

    const bar = ulid();
    const kitchen = ulid();
    t.insert(schema.stations)
      .values([
        { id: bar, name: 'Bar', kind: 'bar', color: '#1e4031', sort: 0 },
        { id: kitchen, name: 'Mutfak', kind: 'mutfak', color: '#a87c2e', sort: 1 },
      ])
      .run();

    // Köşkün planı: salon (zemin kat), bahçe, üst kat, karaoke odası. Konumlar bölüm tuvalinin yüzdesi.
    const sections = [
      { id: ulid(), name: 'Salon', sort: 0 },
      { id: ulid(), name: 'Bahçe', sort: 1 },
      { id: ulid(), name: 'Üst kat', sort: 2 },
      { id: ulid(), name: 'Karaoke', sort: 3 },
    ];
    t.insert(schema.sections).values(sections).run();
    const tables: (typeof schema.tables.$inferInsert)[] = [];
    let sort = 0;
    // Salon: 2 sıra x 4 masa + bar tezgâhı
    for (let i = 0; i < 8; i++) {
      tables.push({ id: ulid(), sectionId: sections[0].id, name: `S${i + 1}`, seats: i % 3 === 0 ? 4 : 2, shape: i % 3 === 0 ? 'rect' : 'square', x: 3 + (i % 4) * 24.5, y: i < 4 ? 5 : 40, w: i % 3 === 0 ? 22 : 19, h: 28, sort: sort++ });
    }
    tables.push({ id: ulid(), sectionId: sections[0].id, name: 'Bar', seats: 6, shape: 'bar', x: 3, y: 76, w: 70, h: 18, sort: sort++ });
    // Bahçe: 12 yuvarlak masa
    for (let i = 0; i < 12; i++) {
      tables.push({ id: ulid(), sectionId: sections[1].id, name: `B${i + 1}`, seats: 4, shape: 'round', x: 4 + (i % 4) * 24.5, y: 3 + Math.floor(i / 4) * 33, w: 17, h: 28, sort: sort++ });
    }
    // Üst kat: 4 masa
    for (let i = 0; i < 4; i++) {
      tables.push({ id: ulid(), sectionId: sections[2].id, name: `Ü${i + 1}`, seats: 4, shape: 'rect', x: 8 + (i % 2) * 46, y: 8 + Math.floor(i / 2) * 46, w: 36, h: 36, sort: sort++ });
    }
    // Karaoke odası: süreli, saatlik 1.000 ₺ (laffogato.net/karaoke)
    tables.push({ id: ulid(), sectionId: sections[3].id, name: 'Karaoke odası', seats: 8, shape: 'rect', kind: 'oda', hourlyRate: 100000, x: 20, y: 20, w: 60, h: 45, sort: sort++ });
    t.insert(schema.tables).values(tables).run();

    t.insert(schema.paymentMethods)
      .values([
        { id: ulid(), name: 'Nakit', kind: 'nakit', zField: 'cash', color: '#2f7354', sort: 0 },
        { id: ulid(), name: 'Kredi kartı', kind: 'kart', zField: 'card', color: '#1e4031', sort: 1 },
        { id: ulid(), name: 'Pluxee', kind: 'yemek', zField: 'meal_card', channel: 'pluxee', color: '#3f6b8a', sort: 2 },
        { id: ulid(), name: 'Multinet', kind: 'yemek', zField: 'meal_card', channel: 'multinet', color: '#a23e6b', sort: 3 },
        { id: ulid(), name: 'Edenred', kind: 'yemek', zField: 'meal_card', channel: 'edenred', color: '#9a3b2f', sort: 4 },
        { id: ulid(), name: 'Setcard', kind: 'yemek', zField: 'meal_card', channel: 'setcard', color: '#b07a1f', sort: 5 },
        { id: ulid(), name: 'Metropol', kind: 'yemek', zField: 'meal_card', channel: 'metropol', color: '#5e8f45', sort: 6 },
        { id: ulid(), name: 'Havale / EFT', kind: 'havale', zField: 'other', color: '#7a6a5f', sort: 7 },
        { id: ulid(), name: 'Açık hesap', kind: 'cari', zField: 'other', color: '#6b1a2b', sort: 8 },
      ])
      .run();

    t.insert(schema.users)
      .values(DEMO_USERS.map((u) => ({ id: ulid(), name: u.name, role: u.role, pinHash: hashPin(u.pin), color: u.color, maxDiscountPct: u.role === 'patron' || u.role === 'mudur' ? 100 : 10 })))
      .run();

    applyMenu(t, snapshot, { barStationId: bar, kitchenStationId: kitchen });

    // LafPOS'a özel: karaoke saati (HİZMET, KDV %20). Oda sayacı durunca bu ürünle satır açılır.
    const serviceCat = ulid();
    t.insert(schema.categories).values({ id: serviceCat, name: 'Karaoke ve etkinlik', color: '#6b1a2b', sort: 99, customizable: false, active: true, stationId: null }).run();
    t.insert(schema.products)
      .values([
        { id: ulid(), categoryId: serviceCat, name: 'Karaoke odası', description: 'Saatlik oda ücreti (sayaçtan)', price: 100000, kdvRate: 20, isService: true, hidden: true, posName: 'KARAOKE ODASI', sort: 0 },
        { id: ulid(), categoryId: serviceCat, name: 'Karaoke kişi başı', price: 15000, kdvRate: 20, isService: true, posName: 'KARAOKE KİŞİ BAŞI', sort: 1 },
        { id: ulid(), categoryId: serviceCat, name: 'Etkinlik ücreti', price: 50000, kdvRate: 20, isService: true, posName: 'ETKİNLİK ÜCRETİ', sort: 2 },
      ])
      .run();

    // ModPOS'ta olup sitede olmayan kasa ürünleri ve seçenek grupları (docs/01-ANALIZ.md §1). Türk kahvesi sitede
    // (mnu-0019): yerel kopyası yok, kasaya özel şeker grubu site kalemine bağlanır (sitenin sayaçlı şekerinin yerine).
    // Yenilebilir bardak bardak seçeneği değil ayrı üründür: ModPOS'taki gibi ayrı satır, lafmaliyet'te ayrı reçete
    const extrasCat = t.select().from(schema.categories).all().find((c) => c.extKey === 'extras');
    if (extrasCat) {
      t.insert(schema.products).values({ id: ulid(), categoryId: extrasCat.id, name: 'Yenilebilir bardak', price: 8000, kdvRate: 10, posName: 'YENİLEBİLİR BARDAK', sort: 50 }).run();
    }
    const sugarGroup = ulid();
    t.insert(schema.optionGroups).values({ id: sugarGroup, name: 'Şeker', kind: 'single', required: true, maxSelect: 1, sort: 10 }).run();
    t.insert(schema.optionItems)
      .values(['Sade', 'Az şekerli', 'Orta', 'Şekerli'].map((name, i) => ({ id: ulid(), groupId: sugarGroup, name, price: 0, isDefault: i === 2, sort: i })))
      .run();
    const turkishCoffee = t
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(and(eq(schema.products.extSource, 'laffogato'), eq(schema.products.extId, 'mnu-0019')))
      .get();
    if (turkishCoffee) {
      const siteSugar = t
        .select({ id: schema.optionGroups.id })
        .from(schema.optionGroups)
        .where(and(eq(schema.optionGroups.extSource, 'laffogato'), eq(schema.optionGroups.extKey, 'sugar')))
        .get();
      if (siteSugar) {
        t.delete(schema.productOptionGroups)
          .where(and(eq(schema.productOptionGroups.productId, turkishCoffee.id), eq(schema.productOptionGroups.groupId, siteSugar.id)))
          .run();
      }
      t.insert(schema.productOptionGroups).values({ productId: turkishCoffee.id, groupId: sugarGroup, sort: 4 }).run();
    }
    const cupGroup = ulid();
    t.insert(schema.optionGroups).values({ id: cupGroup, name: 'Bardak', kind: 'single', required: false, maxSelect: 1, sort: 11 }).run();
    t.insert(schema.optionItems)
      .values([
        { id: ulid(), groupId: cupGroup, name: 'Cam bardak', price: 0, isDefault: true, sort: 0 },
        { id: ulid(), groupId: cupGroup, name: 'Karton bardak', price: 0, sort: 1 },
      ])
      .run();
    // Bardak seçimi espresso bazlı ve soğuk kahvelere bağlanır
    const cupCats = t.select().from(schema.categories).all().filter((c) => c.extKey === 'espresso' || c.extKey === 'ice-coffee');
    for (const c of cupCats) {
      for (const p of t.select().from(schema.products).all().filter((x) => x.categoryId === c.id)) {
        t.insert(schema.productOptionGroups).values({ productId: p.id, groupId: cupGroup, sort: 20 }).run();
      }
    }

    // Örnek kampanya yalnız demoda: kafede kampanyayı işletme kendisi kurar (Yönetim › Menü › Happy hour)
    if (demo) {
      t.insert(schema.happyHours)
        .values({ id: ulid(), name: 'Öğle kahvesi', days: [1, 2, 3, 4, 5], start: '12:00', end: '14:00', percent: 10, categoryIds: [], productIds: [], active: false })
        .run();
    }
  });
  // İşletme self servis (kullanıcı kararı, 27 Ekim 2026): yeni kurulum satış ekranında açılır; masaya servis ve yarı
  // self Yönetim › Ayarlar › Servis modu'ndan. Var olan kurulumun ayarına dokunulmaz. Deneme modu: örnek PIN'ler ve
  // eğitim yazarkasası; patron "Denemeyi bitir, gerçek kullanıma başla" ile kapatır
  updateSettings({ demoMode: true, okcProvider: 'simulator', serviceMode: 'self' });
  return true;
}

// `npm run db:seed`: boş veritabanına kurulum verisini yükler
if (process.argv[1]?.endsWith('seed.ts')) {
  runMigrations();
  console.log(seedIfEmpty() ? 'Kurulum verisi yüklendi' : 'Veritabanında zaten kullanıcı var; seed atlandı');
}
