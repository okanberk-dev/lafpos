import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { Role } from '@shared/permissions';
import type { Permission } from '@shared/permissions';
import type { OrderTotals } from '@shared/order-calc';
import type { SelectedOption, ZField, ZSummary } from '@shared/types';

export type { ZField, ZSummary };

/**
 * LafPOS veritabanı şeması (SQLite). Para alanları kuruş tam sayı; zaman alanları epoch milisaniye;
 * iş günü tarihi "YYYY-MM-DD" metin. İşlem kayıtları (adisyon, kalem, ödeme…) ULID ile kimliklenir.
 */

const bool = (name: string) => integer(name, { mode: 'boolean' });
const nowMs = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

// ─── Ayarlar ve personel ────────────────────────────────────────────────────

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: integer('updated_at').notNull().default(nowMs),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').$type<Role>().notNull(),
  /** HMAC(secret, pin): tekil, böylece yalnız PIN'le giriş yapılabilir */
  pinHash: text('pin_hash').notNull().unique(),
  color: text('color').notNull().default('#245c43'),
  active: bool('active').notNull().default(true),
  permGrant: text('perm_grant', { mode: 'json' }).$type<Permission[]>().notNull().default(sql`'[]'`),
  permRevoke: text('perm_revoke', { mode: 'json' }).$type<Permission[]>().notNull().default(sql`'[]'`),
  /** İndirim üst sınırı (yüzde); yetkili onayı olmadan bundan fazlası yapılamaz */
  maxDiscountPct: integer('max_discount_pct').notNull().default(100),
  createdAt: integer('created_at').notNull().default(nowMs),
  lastLoginAt: integer('last_login_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** sha256(token) */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    device: text('device').notNull().default(''),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

// ─── Masa planı, istasyon, yazıcı ───────────────────────────────────────────

export const sections = sqliteTable('sections', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
  active: bool('active').notNull().default(true),
});

export const tables = sqliteTable(
  'tables',
  {
    id: text('id').primaryKey(),
    sectionId: text('section_id')
      .notNull()
      .references(() => sections.id),
    name: text('name').notNull(),
    seats: integer('seats').notNull().default(2),
    shape: text('shape').$type<'square' | 'rect' | 'round' | 'bar'>().notNull().default('square'),
    /** Plan üzerindeki konum ve boyut, bölüm tuvalinin yüzdesi olarak (0-100) */
    x: real('x').notNull().default(0),
    y: real('y').notNull().default(0),
    w: real('w').notNull().default(10),
    h: real('h').notNull().default(10),
    kind: text('kind').$type<'masa' | 'oda'>().notNull().default('masa'),
    /** Karaoke odası gibi süreli alanlarda saatlik ücret (kuruş) */
    hourlyRate: integer('hourly_rate'),
    /** Sitenin masa QR kodu (laffogato cafe_tables), online masa siparişini eşlemek için */
    siteTableCode: text('site_table_code'),
    sort: integer('sort').notNull().default(0),
    active: bool('active').notNull().default(true),
  },
  (t) => [index('tables_section_idx').on(t.sectionId)],
);

export const printers = sqliteTable('printers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').$type<'ag' | 'tarayici'>().notNull().default('tarayici'),
  host: text('host'),
  port: integer('port').notNull().default(9100),
  widthMm: integer('width_mm').notNull().default(80),
  copies: integer('copies').notNull().default(1),
  /** Hangi belgeler bu yazıcıdan çıkar */
  docs: text('docs', { mode: 'json' }).$type<('adisyon' | 'mutfak' | 'z')[]>().notNull().default(sql`'["adisyon"]'`),
  active: bool('active').notNull().default(true),
});

export const stations = sqliteTable('stations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').$type<'bar' | 'mutfak' | 'diger'>().notNull().default('bar'),
  color: text('color').notNull().default('#245c43'),
  printerId: text('printer_id').references(() => printers.id, { onDelete: 'set null' }),
  sort: integer('sort').notNull().default(0),
  active: bool('active').notNull().default(true),
});

// ─── Menü ───────────────────────────────────────────────────────────────────

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    subtitle: text('subtitle'),
    color: text('color').notNull().default('#245c43'),
    icon: text('icon'),
    sort: integer('sort').notNull().default(0),
    active: bool('active').notNull().default(true),
    stationId: text('station_id').references(() => stations.id, { onDelete: 'set null' }),
    /** İçecek seçenekleri (süt, şurup…) bu kategorideki ürünlere bağlansın mı */
    customizable: bool('customizable').notNull().default(true),
    extSource: text('ext_source').$type<'laffogato'>(),
    extKey: text('ext_key'),
  },
  (t) => [uniqueIndex('categories_ext_idx').on(t.extSource, t.extKey)],
);

export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    name: text('name').notNull(),
    /** Düğmede ve fişte görünen kısa ad (boşsa ad) */
    shortName: text('short_name'),
    description: text('description'),
    /** M ya da tek boy fiyat, kuruş, KDV dahil */
    price: integer('price').notNull(),
    /** L boy fiyat; null ise tek boy */
    priceL: integer('price_l'),
    kdvRate: integer('kdv_rate').notNull().default(10),
    stationId: text('station_id').references(() => stations.id, { onDelete: 'set null' }),
    color: text('color'),
    image: text('image'),
    /** Satışta (false = Tükendi) */
    active: bool('active').notNull().default(true),
    /** POS ekranında gösterme (sitede durabilir) */
    hidden: bool('hidden').notNull().default(false),
    favorite: bool('favorite').notNull().default(false),
    sort: integer('sort').notNull().default(0),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    allergens: text('allergens', { mode: 'json' }).$type<string[] | null>(),
    barcode: text('barcode'),
    /** lafmaliyet satış listesinde görünecek ad (boşsa "AD BOY") */
    posName: text('pos_name'),
    /** HİZMET (karaoke saati gibi): lafmaliyet'te ayrı eşlenir */
    isService: bool('is_service').notNull().default(false),
    /** Günlük porsiyon sayacı: null = takip yok; 0'a inince ürün Tükendi olur */
    portionsLeft: integer('portions_left'),
    /** Maliyet (kuruş) — lafmaliyet'ten; yalnız rapor.maliyet yetkisi görür */
    cost: integer('cost'),
    extSource: text('ext_source').$type<'laffogato'>(),
    extId: text('ext_id'),
    /** Sitedeki son bilinen değerlerin özeti: değişiklik önizlemesi için */
    extHash: text('ext_hash'),
    syncedAt: integer('synced_at'),
    createdAt: integer('created_at').notNull().default(nowMs),
    updatedAt: integer('updated_at').notNull().default(nowMs),
  },
  (t) => [uniqueIndex('products_ext_idx').on(t.extSource, t.extId), index('products_category_idx').on(t.categoryId)],
);

export const optionGroups = sqliteTable(
  'option_groups',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** single: tek seçim, multi: çoklu seçim, counter: adetli (şeker 0-3, ekstra shot) */
    kind: text('kind').$type<'single' | 'multi' | 'counter'>().notNull().default('single'),
    required: bool('required').notNull().default(false),
    maxSelect: integer('max_select').notNull().default(1),
    sort: integer('sort').notNull().default(0),
    active: bool('active').notNull().default(true),
    extSource: text('ext_source').$type<'laffogato'>(),
    /** milk | roast | syrup | extraShot | sugar */
    extKey: text('ext_key'),
  },
  (t) => [uniqueIndex('option_groups_ext_idx').on(t.extSource, t.extKey)],
);

export const optionItems = sqliteTable(
  'option_items',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => optionGroups.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Sitedeki kimlik (oat, vanilla…) */
    code: text('code'),
    price: integer('price').notNull().default(0),
    isDefault: bool('is_default').notNull().default(false),
    /** counter gruplarında en fazla adet */
    maxQty: integer('max_qty').notNull().default(1),
    allergens: text('allergens', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    sort: integer('sort').notNull().default(0),
    active: bool('active').notNull().default(true),
  },
  (t) => [index('option_items_group_idx').on(t.groupId)],
);

export const productOptionGroups = sqliteTable(
  'product_option_groups',
  {
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => optionGroups.id, { onDelete: 'cascade' }),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.productId, t.groupId] })],
);

export const happyHours = sqliteTable('happy_hours', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** 1 = Pazartesi … 7 = Pazar */
  days: text('days', { mode: 'json' }).$type<number[]>().notNull(),
  start: text('start').notNull(),
  end: text('end').notNull(),
  percent: integer('percent').notNull(),
  categoryIds: text('category_ids', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  productIds: text('product_ids', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  active: bool('active').notNull().default(true),
});

// ─── Kasa ───────────────────────────────────────────────────────────────────


export const paymentMethods = sqliteTable('payment_methods', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').$type<'nakit' | 'kart' | 'yemek' | 'havale' | 'cari' | 'online' | 'diger'>().notNull(),
  /** lafmaliyet Kasa raporundaki alan */
  zField: text('z_field').$type<ZField>().notNull(),
  /** lafmaliyet komisyon kanalı (pluxee, multinet, edenred, setcard, metropol, yemeksepeti…) */
  channel: text('channel'),
  color: text('color').notNull().default('#245c43'),
  sort: integer('sort').notNull().default(0),
  active: bool('active').notNull().default(true),
});


export const businessDays = sqliteTable(
  'business_days',
  {
    id: text('id').primaryKey(),
    /** İş günü (05:00 kuralı): lafmaliyet Kasa raporu tarihiyle aynı */
    date: text('date').notNull(),
    zNo: integer('z_no').notNull(),
    openedAt: integer('opened_at').notNull(),
    openedBy: text('opened_by').references(() => users.id),
    openingCash: integer('opening_cash').notNull().default(0),
    closedAt: integer('closed_at'),
    closedBy: text('closed_by').references(() => users.id),
    countedCash: integer('counted_cash'),
    cashCounts: text('cash_counts', { mode: 'json' }).$type<Record<string, number> | null>(),
    expectedCash: integer('expected_cash'),
    cashDiff: integer('cash_diff'),
    note: text('note'),
    summary: text('summary', { mode: 'json' }).$type<ZSummary | null>(),
    lastOrderNo: integer('last_order_no').notNull().default(0),
    exportedAt: integer('exported_at'),
    /** Gün sonundan sonra "Günü yeniden aç" ile açıldığı son an (otomatik gün sonu buna da bakar) */
    reopenedAt: integer('reopened_at'),
  },
  (t) => [index('business_days_date_idx').on(t.date)],
);

export const cashMovements = sqliteTable(
  'cash_movements',
  {
    id: text('id').primaryKey(),
    dayId: text('day_id')
      .notNull()
      .references(() => businessDays.id),
    /** harcama: kasadan masraf · teslim: patrona/bankaya teslim · giris: kasaya para konması */
    kind: text('kind').$type<'harcama' | 'teslim' | 'giris'>().notNull(),
    amount: integer('amount').notNull(),
    description: text('description').notNull().default(''),
    userId: text('user_id').references(() => users.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('cash_movements_day_idx').on(t.dayId)],
);

// ─── Müşteri ────────────────────────────────────────────────────────────────

export const customers = sqliteTable(
  'customers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    note: text('note'),
    birthday: text('birthday'),
    /** Açık hesap bakiyesi (kuruş): artı = müşteri borçlu */
    balance: integer('balance').notNull().default(0),
    /** Açık hesap üst sınırı (kuruş), null = sınırsız */
    creditLimit: integer('credit_limit'),
    stamps: integer('stamps').notNull().default(0),
    totalSpent: integer('total_spent').notNull().default(0),
    visits: integer('visits').notNull().default(0),
    lastVisitAt: integer('last_visit_at'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('customers_phone_idx').on(t.phone)],
);

export const customerAddresses = sqliteTable('customer_addresses', {
  id: text('id').primaryKey(),
  customerId: text('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default('Ev'),
  address: text('address').notNull(),
  note: text('note'),
});

export const customerLedger = sqliteTable(
  'customer_ledger',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** borc: açık hesaba satış · tahsilat: ödeme alındı · duzeltme: elle düzeltme */
    kind: text('kind').$type<'borc' | 'tahsilat' | 'duzeltme'>().notNull(),
    amount: integer('amount').notNull(),
    orderId: text('order_id'),
    paymentId: text('payment_id'),
    methodId: text('method_id'),
    dayId: text('day_id'),
    note: text('note'),
    userId: text('user_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('customer_ledger_customer_idx').on(t.customerId)],
);

// ─── Adisyon ────────────────────────────────────────────────────────────────

export type OrderType = 'masa' | 'tezgah' | 'gelal' | 'paket' | 'online';
export type OrderStatus = 'acik' | 'kapali' | 'iptal' | 'birlesti';
export type ItemStatus = 'yeni' | 'hazirlaniyor' | 'hazir' | 'servis';
export type DeliveryStatus = 'hazirlaniyor' | 'hazir' | 'yolda' | 'teslim';

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    dayId: text('day_id')
      .notNull()
      .references(() => businessDays.id),
    no: integer('no').notNull(),
    type: text('type').$type<OrderType>().notNull(),
    status: text('status').$type<OrderStatus>().notNull().default('acik'),
    tableId: text('table_id').references(() => tables.id),
    customerId: text('customer_id').references(() => customers.id),
    waiterId: text('waiter_id').references(() => users.id),
    guests: integer('guests').notNull().default(1),
    /** Hesap paylaşımı: kaç kişiye eşit bölündü (yoksa null). Paylar ödemelerdeki shareNo/shareOf'tan sayılır */
    splitPeople: integer('split_people'),
    note: text('note'),
    openedAt: integer('opened_at').notNull(),
    openedBy: text('opened_by').references(() => users.id),
    closedAt: integer('closed_at'),
    closedBy: text('closed_by').references(() => users.id),
    discountType: text('discount_type').$type<'percent' | 'amount'>(),
    discountValue: integer('discount_value'),
    discountReason: text('discount_reason'),
    discountBy: text('discount_by'),
    serviceRate: integer('service_rate').notNull().default(0),
    /** Önbelleğe alınmış hesap (her yazmada yeniden hesaplanır) */
    total: integer('total').notNull().default(0),
    paid: integer('paid').notNull().default(0),
    totals: text('totals', { mode: 'json' }).$type<OrderTotals | null>(),
    billPrintedAt: integer('bill_printed_at'),
    billPrints: integer('bill_prints').notNull().default(0),
    source: text('source').$type<'pos' | 'laffogato'>().notNull().default('pos'),
    /** Online sipariş: sitedeki kimlik (ord-0042), aşama, teslim türü, etiket; ödemesi sitede alınmış */
    extId: text('ext_id'),
    extNo: integer('ext_no'),
    extStage: text('ext_stage').$type<'new' | 'preparing' | 'ready' | 'done'>(),
    extFulfillment: text('ext_fulfillment').$type<'table' | 'pickup' | 'delivery'>(),
    extLabel: text('ext_label'),
    extPaid: bool('ext_paid').notNull().default(false),
    extTotal: integer('ext_total'),
    scheduledFor: text('scheduled_for'),
    deliveryName: text('delivery_name'),
    deliveryPhone: text('delivery_phone'),
    deliveryAddress: text('delivery_address'),
    deliveryStatus: text('delivery_status').$type<DeliveryStatus>(),
    courierId: text('courier_id').references(() => users.id),
    mergedInto: text('merged_into'),
    cancelReason: text('cancel_reason'),
    /** Yarı self servis: kasada girilen masa no / numaratör ("12"); bar fişinde, çağrı ekranında numara yerine */
    numarator: text('numarator'),
    updatedAt: integer('updated_at').notNull(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('orders_status_idx').on(t.status),
    index('orders_table_idx').on(t.tableId, t.status),
    index('orders_day_idx').on(t.dayId),
    uniqueIndex('orders_ext_idx').on(t.source, t.extId),
  ],
);

export const orderItems = sqliteTable(
  'order_items',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    size: text('size').$type<'M' | 'L' | 'TEK'>().notNull().default('TEK'),
    options: text('options', { mode: 'json' }).$type<SelectedOption[]>().notNull().default(sql`'[]'`),
    /** "Yulaf · Vanilya · +1 shot" */
    optionsText: text('options_text').notNull().default(''),
    qty: integer('qty').notNull(),
    /** Seçenek farkları ve happy hour dahil birim fiyat */
    unitPrice: integer('unit_price').notNull(),
    /** Ürünün boy fiyatı (seçenek ve indirim öncesi) */
    basePrice: integer('base_price').notNull(),
    kdvRate: integer('kdv_rate').notNull(),
    discount: integer('discount').notNull().default(0),
    discountReason: text('discount_reason'),
    happyHour: bool('happy_hour').notNull().default(false),
    complimentary: bool('complimentary').notNull().default(false),
    compReason: text('comp_reason'),
    compBy: text('comp_by'),
    voided: bool('voided').notNull().default(false),
    voidReason: text('void_reason'),
    voidBy: text('void_by'),
    voidApprovedBy: text('void_approved_by'),
    voidedAt: integer('voided_at'),
    /** İptal edildiğinde bara/mutfağa gönderilmiş miydi (zayi riski) */
    voidAfterSend: bool('void_after_send').notNull().default(false),
    note: text('note'),
    stationId: text('station_id'),
    status: text('status').$type<ItemStatus>().notNull().default('yeni'),
    /** Aynı anda gönderilen kalemler aynı fiş numarasını taşır */
    batch: integer('batch').notNull().default(1),
    sentAt: integer('sent_at').notNull(),
    startedAt: integer('started_at'),
    readyAt: integer('ready_at'),
    servedAt: integer('served_at'),
    paidQty: integer('paid_qty').notNull().default(0),
    isService: bool('is_service').notNull().default(false),
    /** Site kimliği (mnu-0011): lafmaliyet eşlemesi için */
    extProductId: text('ext_product_id'),
    posName: text('pos_name'),
    createdBy: text('created_by'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('order_items_order_idx').on(t.orderId), index('order_items_status_idx').on(t.status, t.stationId)],
);

export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    dayId: text('day_id')
      .notNull()
      .references(() => businessDays.id),
    methodId: text('method_id')
      .notNull()
      .references(() => paymentMethods.id),
    methodName: text('method_name').notNull(),
    zField: text('z_field').$type<ZField>().notNull(),
    amount: integer('amount').notNull(),
    tip: integer('tip').notNull().default(0),
    /** Nakitte müşterinin verdiği ve para üstü */
    given: integer('given'),
    change: integer('change'),
    /**
     * Kalem bazlı ödemede seçilen kalemler; `amount` bu adetlere düşen tutar (yazarkasa ve eski ödemelerde yok).
     * Ödeme iptal edilip adet yeniden ödenince kalemin kalanı bununla kuruşu kuruşuna alınır
     */
    items: text('items', { mode: 'json' }).$type<{ itemId: string; qty: number; amount?: number }[] | null>(),
    /** Paylaşımlı hesapta bu ödemenin payı: shareNo / shareOf (ör. 2/4) */
    shareNo: integer('share_no'),
    shareOf: integer('share_of'),
    customerId: text('customer_id'),
    note: text('note'),
    userId: text('user_id'),
    createdAt: integer('created_at').notNull(),
    refundedAt: integer('refunded_at'),
    refundedBy: text('refunded_by'),
    refundReason: text('refund_reason'),
    /**
     * Ödeme denemesinin istemcide üretilen kimliği: yanıtı kaybolan istek yeniden gelirse ödeme ikinci kez yazılmaz,
     * ilk sonuç döner (adisyon başına tekil)
     */
    requestId: text('request_id'),
  },
  (t) => [index('payments_order_idx').on(t.orderId), index('payments_day_idx').on(t.dayId), uniqueIndex('payments_request_idx').on(t.orderId, t.requestId)],
);

export const roomSessions = sqliteTable('room_sessions', {
  id: text('id').primaryKey(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  tableId: text('table_id')
    .notNull()
    .references(() => tables.id),
  hourlyRate: integer('hourly_rate').notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  itemId: text('item_id'),
  startedBy: text('started_by'),
});

export const reservations = sqliteTable(
  'reservations',
  {
    id: text('id').primaryKey(),
    date: text('date').notNull(),
    time: text('time').notNull(),
    durationMin: integer('duration_min').notNull().default(120),
    name: text('name').notNull(),
    phone: text('phone'),
    guests: integer('guests').notNull().default(2),
    tableId: text('table_id').references(() => tables.id, { onDelete: 'set null' }),
    customerId: text('customer_id'),
    status: text('status').$type<'bekliyor' | 'geldi' | 'iptal' | 'gelmedi'>().notNull().default('bekliyor'),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('reservations_date_idx').on(t.date)],
);

// ─── Denetim, senkron ───────────────────────────────────────────────────────

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: integer('at').notNull(),
    userId: text('user_id'),
    approverId: text('approver_id'),
    action: text('action').notNull(),
    severity: text('severity').$type<'info' | 'uyari' | 'alarm'>().notNull().default('info'),
    orderId: text('order_id'),
    entity: text('entity'),
    entityId: text('entity_id'),
    amount: integer('amount'),
    message: text('message').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  },
  (t) => [index('audit_at_idx').on(t.at), index('audit_severity_idx').on(t.severity, t.at)],
);

export const outbox = sqliteTable(
  'outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    target: text('target').$type<'lafmaliyet' | 'laffogato'>().notNull(),
    kind: text('kind').notNull(),
    /** Aynı anahtarlı bekleyen kayıt varsa yenisiyle değiştirilir (ör. aynı günün Z'si) */
    dedupeKey: text('dedupe_key'),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: integer('created_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    lastError: text('last_error'),
    sentAt: integer('sent_at'),
  },
  (t) => [index('outbox_pending_idx').on(t.sentAt, t.nextAttemptAt)],
);

export const syncState = sqliteTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// ─── Yazarkasa POS (ÖKC) ────────────────────────────────────────────────────

export type FiscalStatus = 'gonderildi' | 'kilitli' | 'tamamlandi' | 'iptal' | 'hata' | 'silindi' | 'fis_iptal';

/**
 * Cihaza (ör. Token ÖKC, TokenX Connect) gönderilen sepetler. `id` sepetin kimliğidir (basketID, UUID).
 * Ödeme ve mali fiş cihazda olur; sonuç (Z no, fiş no, ödeme kalemleri) buraya ve adisyonun ödemelerine yazılır.
 */
export const fiscalReceipts = sqliteTable(
  'fiscal_receipts',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    provider: text('provider').$type<'tokenx' | 'simulator'>().notNull(),
    mode: text('mode').$type<'anlik' | 'liste'>().notNull(),
    terminalId: text('terminal_id'),
    status: text('status').$type<FiscalStatus>().notNull(),
    amount: integer('amount').notNull(),
    /** Sepetteki kalemler ve adetleri (kalem bazlı ödeme için) */
    items: text('items', { mode: 'json' }).$type<{ itemId: string; qty: number }[]>().notNull(),
    basket: text('basket', { mode: 'json' }).$type<unknown>().notNull(),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    zNo: integer('z_no'),
    receiptNo: integer('receipt_no'),
    paymentIds: text('payment_ids', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    error: text('error'),
    sentBy: text('sent_by'),
    lockedBy: text('locked_by'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => [index('fiscal_order_idx').on(t.orderId), index('fiscal_status_idx').on(t.status)],
);
