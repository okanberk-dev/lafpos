#!/usr/bin/env node
/**
 * Gün sonu uçtan uca (yalnız yerel): LafPOS'ta bir iş günü gerçek HTTP API'siyle sürülür (LafPOS'un kendi sahte Pavo
 * cihazıyla: cihaz fişi, banka gün sonu), gün kapanır, giden kutusu yerel ladmin'e (lafmaliyet) gider; sonra ladmin'in
 * veritabanı (pos_day_reports, pos_daily_sales, cash_reports, cash_outs, expense_entries, lafpos_day_ends, sürümler) ve
 * personel / yönetici Kasa sayfaları (playwright, headless) okunur. Her LafPOS girişi için ladmin'de nerede göründüğü
 * (ya da görünmediği) rapora yazılır.
 *
 * Kullanım (Node 24; ağır iş kilidiyle):
 *   export PATH=$HOME/.local/node/node-v24.22.2-darwin-arm64/bin:$PATH
 *   flock /tmp/laf-heavy.lock node /Users/okanberkmanavoglu/laf/scripts/e2e-gunsonu/run.mjs \
 *     --lafpos <LafPOS deposu ya da worktree> --ladmin <lafmaliyet deposu ya da worktree> \
 *     [--shots <klasör>] [--out <rapor.json>] [--pg postgres://ci:ci@localhost:5433/postgres] \
 *     [--ports 4141,4142] [--no-ui] [--keep] [--allow-env-files] [--photo <png/jpg>]
 *
 * - Hiçbir canlı servise gitmez: ladmin'in ortamı sıfırdan kurulur (yalnız PATH/HOME/TMPDIR/LANG kalıtılır; e-posta,
 *   site, yapay zekâ, Blob anahtarları boş), LafPOS'ta LAFFOGATO_URL boş ve LAFPOS_MERKEZ_URL=0. Depoda .env* dosyası
 *   varsa (`.env.example` hariç) durur (--allow-env-files ile geçilir).
 * - Depolara yazmaz: ladmin deposu geçici klasöre kopyalanır (node_modules APFS klonuyla; Turbopack depo dışına giden
 *   node_modules bağlantısını kabul etmez), LafPOS yerinde ama geçici veri klasörüyle çalışır.
 * - Kendi veritabanını açar (gunsonu_e2e_<pid>) ve sonunda siler; sunucuları, sahte cihazı ve tarayıcıyı kapatır
 *   (--keep: veritabanı ve geçici klasör kalır, sunucular yine kapanır).
 * - Çıktı: --out (varsayılan <geçici>/rapor.json, --keep yoksa <shots>/rapor.json) ve stdout özeti.
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ─── Argümanlar ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
if (!opt('lafpos') || !opt('ladmin')) {
  console.error('Kullanım: node run.mjs --lafpos <dir> --ladmin <dir> [--shots <dir>] [--out <file>] [--pg <url>] [--ports a,b] [--no-ui] [--keep] [--photo <file>]');
  process.exit(2);
}
const LAFPOS = resolve(opt('lafpos'));
const LADMIN_SRC = resolve(opt('ladmin'));
const PG_ADMIN = opt('pg', 'postgres://ci:ci@localhost:5433/postgres');
const SHOTS = opt('shots') ? resolve(opt('shots')) : null;
const KEEP = flag('keep');
const NO_UI = flag('no-ui');
const PHOTO = opt('photo') ? resolve(opt('photo')) : null;
const [PORT_LADMIN, PORT_LAFPOS] = (opt('ports', '') || '').split(',').map(Number).filter(Boolean);

const pgUrl = new URL(PG_ADMIN);
if (!['localhost', '127.0.0.1', '::1'].includes(pgUrl.hostname)) throw new Error(`Yalnız yerel Postgres: ${pgUrl.hostname}`);
if (pgUrl.port === '5432') throw new Error('5432 sahibin Postgres 14’ü; 5433 kullanın');

for (const dir of [LAFPOS, LADMIN_SRC]) {
  if (!existsSync(join(dir, 'package.json'))) throw new Error(`Depo değil: ${dir}`);
  if (!existsSync(join(dir, 'node_modules'))) throw new Error(`node_modules yok: ${dir}`);
  const envFiles = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local', '.env.test'].filter((f) => existsSync(join(dir, f)));
  if (envFiles.length && !flag('allow-env-files')) throw new Error(`${dir} içinde ${envFiles.join(', ')} var: canlı anahtar taşıyabilir. Kaldırın ya da --allow-env-files`);
}

const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TL = (k) => (k == null ? null : Math.round(k) / 100);

// ─── Geçici alan, alt süreçler ve temizlik ───────────────────────────────────
const WORK = mkdtempSync(join(tmpdir(), 'gunsonu-e2e-'));
const DB_NAME = `gunsonu_e2e_${process.pid}`;
const SYNC_SECRET = 'e2e-gunsonu-sync-secret-0123456789abcdef';
const AUTH_SECRET = 'e2e-gunsonu-auth-secret-0123456789abcdefghij';
const children = [];
let browser = null;
let sqlAdmin = null;
let sql = null;

async function cleanup() {
  if (browser) await browser.close().catch(() => {});
  for (const c of children.reverse()) {
    if (c.exitCode != null) continue;
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      c.kill('SIGTERM');
    }
  }
  await sleep(1500);
  for (const c of children) {
    if (c.exitCode != null) continue;
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      /* gitti */
    }
  }
  if (sql) await sql.end({ timeout: 2 }).catch(() => {});
  if (sqlAdmin) {
    if (!KEEP) await sqlAdmin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch((e) => console.warn('veritabanı silinemedi', e.message));
    await sqlAdmin.end({ timeout: 2 }).catch(() => {});
  }
  if (!KEEP) rmSync(WORK, { recursive: true, force: true });
  else log(`--keep: veritabanı ${DB_NAME}, geçici klasör ${WORK}`);
}
let cleaned = false;
const finish = async (code) => {
  if (!cleaned) {
    cleaned = true;
    await cleanup();
  }
  process.exit(code);
};
process.on('SIGINT', () => void finish(130));
process.on('SIGTERM', () => void finish(143));

async function freePort(prefer) {
  const tryPort = (p) =>
    new Promise((ok) => {
      const s = createServer();
      s.once('error', () => ok(false));
      s.listen(p, '127.0.0.1', () => s.close(() => ok(true)));
    });
  if (prefer && (await tryPort(prefer))) return prefer;
  for (let p = 4100; p < 4200; p++) if (await tryPort(p)) return p;
  throw new Error('4100-4199 arasında boş port yok');
}

/** Alt süreç: kendi süreç grubunda (temizlikte torunları da kapanır), çıktısı dosyaya */
function startChild(name, cmd, args, { cwd, env }) {
  const out = join(WORK, `${name}.log`);
  const c = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  const append = (d) => {
    text += d;
    if (text.length > 2_000_000) text = text.slice(-1_000_000);
  };
  c.stdout.on('data', append);
  c.stderr.on('data', append);
  c.on('exit', () => writeFileSync(out, text));
  children.push(c);
  PROCS[name] = { child: c, text: () => text, logFile: out };
  return PROCS[name];
}
const PROCS = {};

const baseEnv = () => {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'SHELL', 'LC_ALL'];
  return Object.fromEntries(keep.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
};

async function waitHttp(url, { timeoutMs = 240_000, ok = (r) => r.status < 500, label = url, proc } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc && proc.child.exitCode != null) throw new Error(`${label} kapandı:\n${proc.text().slice(-3000)}`);
    try {
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
      if (ok(r)) return r;
    } catch {
      /* henüz yok */
    }
    if (Date.now() > deadline) throw new Error(`${label} ${timeoutMs / 1000} sn içinde hazır olmadı${proc ? `:\n${proc.text().slice(-3000)}` : ''}`);
    await sleep(500);
  }
}

// ─── İş günü (05:00 kuralı, İstanbul) ────────────────────────────────────────
const businessDate = (ms = Date.now()) => new Date(ms + 3 * 3600_000 - 5 * 3600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const report = { startedAt: new Date().toISOString(), lafposDir: LAFPOS, ladminDir: LADMIN_SRC, db: DB_NAME, steps: [], entries: [], lafpos: {}, ladmin: {}, ui: {}, mapping: [] };

async function main() {
  const DAY = businessDate();
  const SWITCH = addDays(DAY, -1);
  report.day = DAY;
  report.switchDay = SWITCH;
  log(`iş günü ${DAY}, ladmin geçiş günü ${SWITCH}, geçici ${WORK}`);

  // ─── 1. ladmin kopyası ve veritabanı ──────────────────────────────────────
  const LADMIN = join(WORK, 'ladmin');
  mkdirSync(LADMIN);
  execFileSync('rsync', ['-a', '--exclude', 'node_modules', '--exclude', '.next', '--exclude', '.git', '--exclude', '.data', `${LADMIN_SRC}/`, `${LADMIN}/`]);
  execFileSync('cp', ['-cR', realpathSync(join(LADMIN_SRC, 'node_modules')), join(LADMIN, 'node_modules')]);
  log('ladmin kopyalandı (node_modules klon)');
  const reqLadmin = createRequire(join(LADMIN, 'package.json'));
  const postgres = reqLadmin('postgres');
  sqlAdmin = postgres(PG_ADMIN, { max: 1, onnotice: () => {} });
  await sqlAdmin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await sqlAdmin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  const dbUrl = new URL(PG_ADMIN);
  dbUrl.pathname = `/${DB_NAME}`;
  const DATABASE_URL = dbUrl.href;
  execFileSync(join(LADMIN, 'node_modules/.bin/tsx'), ['scripts/migrate.ts'], { cwd: LADMIN, env: { ...baseEnv(), DATABASE_URL }, stdio: 'pipe' });
  sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  // Şube kütüğü (scripts/seed.ts ensureBranchSeed ile aynı üç kayıt), geçiş günü, bir yönetici ve Marina'nın personeli
  await sql`insert into branches ${sql([
    { id: 'tuzla', name: 'Tuzla', kind: 'fiziksel', pos_source: 'modpos', opened_on: null, sort_order: 1, active: true },
    { id: 'marina', name: 'Marina', kind: 'fiziksel', pos_source: 'modpos', opened_on: null, sort_order: 2, active: true },
    { id: 'online', name: 'laffogato.net', kind: 'online', pos_source: 'yok', opened_on: null, sort_order: 3, active: true },
  ])} on conflict (id) do nothing`;
  await sql`insert into settings (key, value) values ('lafposGecisGunu', ${sql.json(SWITCH)}) on conflict (key) do update set value = excluded.value`;
  const [admin] = await sql`insert into users (email, name, password_hash, role, branch_id) values ('yonetici@e2e.invalid', 'Yönetici E2E', 'x', 'admin', null) returning id, name`;
  const [staff] = await sql`insert into users (email, name, password_hash, role, branch_id) values ('personel@e2e.invalid', 'Personel E2E', 'x', 'staff', 'marina') returning id, name`;
  log('ladmin veritabanı hazır', DB_NAME);

  // ─── 2. ladmin (next dev) ──────────────────────────────────────────────────
  const portLadmin = await freePort(PORT_LADMIN);
  const LADMIN_URL = `http://127.0.0.1:${portLadmin}`;
  const ladminEnv = {
    ...baseEnv(),
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL,
    DATABASE_URL_UNPOOLED: DATABASE_URL,
    AUTH_SECRET,
    LAFPOS_SYNC_SECRET: SYNC_SECRET,
    APP_URL: LADMIN_URL,
    PHOTO_DIR: join(WORK, 'photos'),
    // Canlı servislere giden her şey kapalı
    RESEND_API_KEY: '',
    KARAOKE_SYNC_SECRET: '',
    ANTHROPIC_API_KEY: '',
    BLOB_READ_WRITE_TOKEN: '',
    CRON_SECRET: '',
    CASH_REPORT_RECIPIENTS: '',
    PARASUT_CLIENT_ID: '',
  };
  const ladmin = startChild('ladmin', process.execPath, [join(LADMIN, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(portLadmin), '-H', '127.0.0.1'], { cwd: LADMIN, env: ladminEnv });
  await waitHttp(`${LADMIN_URL}/giris`, { label: 'ladmin', proc: ladmin, ok: (r) => r.status === 200 });
  // LafPOS'un çağıracağı uçlar önceden derlensin (ilk derleme LafPOS'un istek süresini aşmasın)
  for (const p of ['/api/pos/gun', '/api/panel/pos/gider-kategorileri', '/api/panel/pos/devir?date=' + DAY, '/api/panel/pos/urunler', '/api/panel/pos/modpos-gunler?sube=marina']) {
    await fetch(`${LADMIN_URL}${p}`, { signal: AbortSignal.timeout(240_000) }).catch(() => null);
  }
  log(`ladmin hazır ${LADMIN_URL}`);

  // ─── 3. Sahte Pavo ve LafPOS ───────────────────────────────────────────────
  const pavo = startChild('pavo', process.execPath, ['--import', 'tsx', join(HERE, 'fake-pavo-server.mjs')], {
    cwd: LAFPOS,
    env: { ...baseEnv(), FAKE_PAVO_MODULE: join(LAFPOS, 'tests/fake-pavo.ts') },
  });
  let ready = null;
  for (let i = 0; i < 300 && !ready; i++) {
    ready = pavo.text().match(/READY (\S+) (\S+) (\S+)/);
    if (pavo.child.exitCode != null) throw new Error(`sahte Pavo açılamadı:\n${pavo.text()}`);
    if (!ready) await sleep(100);
  }
  if (!ready) throw new Error('sahte Pavo hazır olmadı');
  const [, PAVO_URL, PAVO_CTL, PAVO_SERIAL] = ready;
  const ctl = async (method, path, body) => (await fetch(`${PAVO_CTL}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  log(`sahte Pavo ${PAVO_URL}`);

  const portLafpos = await freePort(PORT_LAFPOS && PORT_LAFPOS !== portLadmin ? PORT_LAFPOS : portLadmin + 1);
  const LAFPOS_URL = `http://127.0.0.1:${portLafpos}`;
  const dataDir = join(WORK, 'lafpos-data');
  mkdirSync(dataDir);
  const lafpos = startChild('lafpos', process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: LAFPOS,
    env: {
      ...baseEnv(),
      NODE_ENV: 'production',
      LAFPOS_DATA_DIR: dataDir,
      LAFPOS_PORT: String(portLafpos),
      LAFPOS_HOST: '127.0.0.1',
      LAFPOS_AYAR_DOSYASI: join(dataDir, 'ayarlar.env'),
      // Arka plan işleri kapalı: giden kutusu gün sonunda hemen, Pavo sonucundan sonra elle "Gönder"le gider (belirli)
      LAFPOS_NO_JOBS: '1',
      LAFMALIYET_URL: LADMIN_URL,
      LAFMALIYET_SYNC_SECRET: SYNC_SECRET,
      LAFPOS_MERKEZ_URL: '0',
      LAFFOGATO_URL: '',
      LAFPOS_CLOUD_URL: '',
      PAVO_URL,
      PAVO_SERIAL,
      PAVO_FINGERPRINT: 'LafPOS-e2e',
    },
  });
  await waitHttp(`${LAFPOS_URL}/api/health`, { label: 'LafPOS', proc: lafpos, ok: (r) => r.ok, timeoutMs: 60_000 });
  log(`LafPOS hazır ${LAFPOS_URL}`);

  // ─── 4. Bir iş günü LafPOS'un HTTP API'siyle ──────────────────────────────
  const tokens = {};
  async function api(who, method, path, body, { allow = [] } = {}) {
    const res = await fetch(`${LAFPOS_URL}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text && (text.startsWith('{') || text.startsWith('[')) ? JSON.parse(text) : text;
    if (!res.ok && !allow.includes(res.status)) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return res.ok ? json : { status: res.status, body: json };
  }
  const PINS = { patron: '1897', mudur: '2468', kasa: '1111', garson: '2222', bar: '3333' };
  for (const [who, pin] of Object.entries(PINS)) tokens[who] = (await api('', 'POST', '/auth/login', { pin })).token;
  const boot = await api('kasa', 'GET', '/bootstrap');
  const product = (name) => {
    const p = boot.products.find((x) => x.name === name);
    if (!p) throw new Error(`ürün yok: ${name}`);
    return p;
  };
  const method = (name) => {
    const m = boot.paymentMethods.find((x) => x.name === name);
    if (!m) throw new Error(`ödeme türü yok: ${name}`);
    return m;
  };
  const user = (role) => boot.users.find((u) => u.role === role);
  const entry = (id, kind, lafpos, note) => {
    report.entries.push({ id, kind, lafpos, note: note ?? null });
    log(`  + ${id} ${kind}`);
  };

  // Gerçek kullanım: kurulum modu kapalı, yazarkasa Pavo (sahte cihaz), eşleştirme. Şube marina (varsayılan)
  await api('patron', 'PUT', '/admin/settings', { demoMode: false, serviceMode: 'masa', tipsEnabled: true });
  await api('patron', 'PUT', '/okc/settings', { provider: 'pavo' });
  await api('patron', 'POST', '/okc/pair');
  const okcSt = await api('patron', 'GET', '/okc/status');
  report.lafpos.okc = { provider: okcSt.provider, paired: okcSt.pavo?.paired, branchId: boot.settings?.branchId };
  log('LafPOS: kurulum modu kapalı, Pavo eşleşti', JSON.stringify(report.lafpos.okc));

  // Gider kategorileri ladmin'den (imzalı GET; gün açıkken tembel çekilir)
  await api('kasa', 'POST', '/cash/day/open', { openingCash: 112000 });
  entry('E01', 'gün açılışı (açılış nakdi)', { openingCash: TL(112000) });
  let cats = { items: [] };
  for (let i = 0; i < 30 && !cats.items.length; i++) {
    cats = await api('mudur', 'GET', '/cash/expense-categories');
    if (!cats.items.length) await sleep(500);
  }
  report.lafpos.expenseCategories = cats.items.length;
  const harcamaCat = cats.items.find((c) => /Diğer fatura dışı/i.test(c.name)) ?? cats.items[0] ?? null;

  const tables = boot.tables.filter((t) => t.kind === 'masa');
  const newOrder = async (body) => api('garson', 'POST', '/orders', body);
  const addItems = async (orderId, items) => api('garson', 'POST', `/orders/${orderId}/items`, { items });
  const getOrder = async (id) => api('mudur', 'GET', `/orders/${id}`);
  const rid = () => `e2e${Math.random().toString(36).slice(2, 12)}`;
  const pay = async (orderId, m, amount, extra = {}) => api('kasa', 'POST', `/orders/${orderId}/payments`, { methodId: method(m).id, amount, requestId: rid(), ...extra });

  /** Sepeti cihaza gönderir, sahte cihazda öder (type 1 nakit, 2 kart), sonuç LafPOS'a işlenene dek bekler */
  async function viaDevice(orderId, payments, items = null) {
    const r = await api('kasa', 'POST', `/okc/orders/${orderId}/send`, { ...(items ? { items } : {}), odeme: payments[0].type === 2 ? 'kart' : 'nakit' });
    let sale = null;
    for (let i = 0; i < 100 && !sale; i++) {
      sale = (await ctl('GET', '/ctl/sales')).find((s) => s.state === 'open');
      if (!sale) await sleep(100);
    }
    if (!sale) throw new Error('cihazda açık satış yok');
    await ctl('POST', '/ctl/pay', { orderNo: sale.orderNo, payments, invoiceNo: `LAF2026${String(Date.now()).slice(-9)}` });
    for (let i = 0; i < 100; i++) {
      const rec = (await api('kasa', 'GET', `/okc/orders/${orderId}/receipts`)).find((x) => x.id === r.receipt.id);
      if (rec?.status === 'tamamlandi') return { receipt: rec, total: sale.total };
      await sleep(150);
    }
    throw new Error(`cihaz fişi tamamlanmadı: ${orderId}`);
  }

  // O1 tezgâh: cihazdan nakit
  let o = await newOrder({ type: 'tezgah' });
  o = await addItems(o.id, [{ productId: product('Latte').id, size: 'M', qty: 2 }]);
  await viaDevice(o.id, [{ type: 1, amount: o.total / 100 }]);
  entry('O1', 'satış, cihazda nakit (Pavo e-Arşiv)', { total: TL(o.total), zField: 'cash', viaDevice: true });

  // O2 tezgâh: cihazdan kart (bankanın batch'ine girer)
  o = await newOrder({ type: 'tezgah' });
  o = await addItems(o.id, [
    { productId: product('Türk Kahvesi').id, qty: 1 },
    { productId: product('Espresso').id, qty: 1 },
  ]);
  await viaDevice(o.id, [{ type: 2, amount: o.total / 100 }]);
  entry('O2', 'satış, cihazda kart', { total: TL(o.total), zField: 'card', viaDevice: true });

  // Gün ortasında elle banka gün sonu (Yönetim › Yazarkasa POS › Cihazda gün sonu al): günün ilk batch'i O2'nin kartı
  const midEod = await api('mudur', 'POST', '/okc/eod', { print: false });
  entry('P0', 'gün ortasında elle Pavo gün sonu (ilk batch)', { status: midEod.status, batchNo: midEod.batchNo, grandTotal: TL(midEod.grandTotalKurus) });

  // O3 masa: %10 adisyon indirimi, kart LafPOS'a yazıldı (cihazsız: yazarkasadan geçmeyen), kartla bahşiş
  o = await newOrder({ type: 'masa', tableId: tables[0].id, guests: 2 });
  o = await addItems(o.id, [
    { productId: product('Latte').id, size: 'L', qty: 1 },
    { productId: product('Espresso').id, qty: 1 },
  ]);
  const o3gross = o.total;
  o = await api('mudur', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Müdavim indirimi' });
  await pay(o.id, 'Kredi kartı', o.total, { tip: 2000 });
  entry('O3', 'satış, %10 indirim, kart cihazsız + kartla bahşiş 20 TL', { gross: TL(o3gross), total: TL(o.total), discount: TL(o3gross - o.total), cardTip: 20, viaDevice: false });

  // O4: yemek kartı (Pluxee)
  o = await newOrder({ type: 'tezgah' });
  o = await addItems(o.id, [{ productId: product('Latte').id, size: 'M', qty: 1 }]);
  await pay(o.id, 'Pluxee', o.total);
  entry('O4', 'satış, yemek kartı (Pluxee)', { total: TL(o.total), zField: 'meal_card', channel: 'pluxee' });

  // O5 masa, bölünmüş ödeme: bir kalem cihazda kart, kalan nakit cihazsız + nakit bahşiş
  o = await newOrder({ type: 'masa', tableId: tables[1].id, guests: 2 });
  o = await addItems(o.id, [
    { productId: product('Türk Kahvesi').id, qty: 2 },
    { productId: product('Latte').id, size: 'M', qty: 1 },
  ]);
  const o5 = o;
  const tk = o.items.find((i) => i.name === 'Türk Kahvesi');
  const dev5 = await viaDevice(o.id, [{ type: 2, amount: (tk.unitPrice * 2) / 100 }], [{ itemId: tk.id, qty: 2 }]);
  o = await getOrder(o.id);
  const rest5 = o.total - o.paid;
  await pay(o.id, 'Nakit', rest5, { tip: 1000 });
  entry('O5', 'bölünmüş ödeme: kalem cihazda kart + kalan nakit cihazsız, nakit bahşiş 10 TL', { total: TL(o5.total), deviceCard: TL(dev5.total * 100), cashOffDevice: TL(rest5), cashTip: 10 });

  // O6: ikram, ödenmez (personel), zayi aynı adisyonda; kalan nakit cihazsız
  o = await newOrder({ type: 'masa', tableId: tables[2].id, guests: 3 });
  o = await addItems(o.id, [
    { productId: product('Latte').id, size: 'M', qty: 1 },
    { productId: product('Espresso').id, qty: 1 },
    { productId: product('Türk Kahvesi').id, qty: 1 },
    { productId: product('San Sebastian').id, qty: 1 },
  ]);
  const its6 = o.items.filter((i) => !i.voided);
  const ikramItem = its6.find((i) => i.name === 'Espresso');
  const odenmezItem = its6.find((i) => i.name === 'Türk Kahvesi');
  const zayiItem = its6.find((i) => i.name === 'San Sebastian');
  await api('mudur', 'POST', `/orders/${o.id}/items/${ikramItem.id}/comp`, { kind: 'ikram', reason: 'Müdavime ikram' });
  await api('mudur', 'POST', `/orders/${o.id}/items/${odenmezItem.id}/comp`, { kind: 'odenmez', reason: 'Personel yemeği', person: { kind: 'user', id: user('garson').id } });
  o = await api('mudur', 'POST', `/orders/${o.id}/items/${zayiItem.id}/comp`, { kind: 'zayi', reason: 'Döküldü' });
  const o6 = await getOrder(o.id);
  await pay(o.id, 'Nakit', o6.total - o6.paid);
  entry('O6', 'ikram + ödenmez (personel) + zayi, kalan nakit', {
    ikram: { name: ikramItem.name, value: TL(ikramItem.unitPrice * ikramItem.qty) },
    odenmez: { name: odenmezItem.name, value: TL(odenmezItem.unitPrice * odenmezItem.qty), person: 'personel (garson)' },
    zayi: { name: zayiItem.name, value: TL(zayiItem.unitPrice * zayiItem.qty) },
    paidCash: TL(o6.total - o6.paid),
  });

  // O7: hazırlanmış iptal (bar "hazır" dedi) ve hazırlanmamış iptal; kalan nakit
  o = await newOrder({ type: 'masa', tableId: tables[3].id, guests: 1 });
  o = await addItems(o.id, [{ productId: product('Latte').id, size: 'M', qty: 1 }]);
  const prepared = o.items.find((i) => !i.voided);
  await api('bar', 'POST', '/kitchen/status', { itemIds: [prepared.id], status: 'hazir' });
  await api('mudur', 'POST', `/orders/${o.id}/items/${prepared.id}/void`, { reason: 'Müşteri vazgeçti (hazırdı)' });
  o = await addItems(o.id, [{ productId: product('Espresso').id, qty: 1 }]);
  const notPrepared = o.items.find((i) => !i.voided && i.name === 'Espresso');
  await api('mudur', 'POST', `/orders/${o.id}/items/${notPrepared.id}/void`, { reason: 'Yanlış girildi' });
  o = await addItems(o.id, [{ productId: product('Türk Kahvesi').id, qty: 1 }]);
  await pay(o.id, 'Nakit', o.total);
  entry('O7', 'iptal: hazırlanmış Latte + hazırlanmamış Espresso; kalan nakit', { preparedVoid: TL(prepared.unitPrice), notPreparedVoid: TL(notPrepared.unitPrice), paidCash: TL(o.total) });

  // O8: kapanmış adisyonda kalem iadesi (nakit) ve O8b açık adisyonda kart ödemesinin iptali
  o = await newOrder({ type: 'tezgah' });
  o = await addItems(o.id, [
    { productId: product('Latte').id, size: 'M', qty: 1 },
    { productId: product('Espresso').id, qty: 1 },
  ]);
  await pay(o.id, 'Nakit', o.total);
  const back = o.items.find((i) => i.name === 'Espresso');
  const ref8 = await api('mudur', 'POST', `/orders/${o.id}/refund-items`, { items: [{ itemId: back.id, qty: 1 }], reason: 'Soğuk geldi' });
  entry('O8', 'kapanmış adisyonda kalem iadesi (nakit geri)', { total: TL(o.total), refunded: TL(ref8.refunded) });
  o = await newOrder({ type: 'tezgah' });
  o = await addItems(o.id, [{ productId: product('Latte').id, size: 'L', qty: 1 }]);
  const wrong = await pay(o.id, 'Kredi kartı', o.total);
  const pid = wrong.payment.id;
  // Kapanmış adisyonun ödemesi iptal edilemiyorsa iade akışı yine iptal yazar; burada kapanmadan önce iptal denenir
  const refundPay = await api('mudur', 'POST', `/orders/${o.id}/payments/${pid}/refund`, { reason: 'Yanlış kart çekimi' }, { allow: [409, 422, 400] });
  const o8b = await getOrder(o.id);
  if (o8b.status !== 'kapali') await pay(o.id, 'Nakit', o8b.total - o8b.paid);
  entry('O8b', 'ödeme iptali (kart, yanlış çekim) sonra nakit', { cardRefunded: refundPay?.status ? `reddedildi ${refundPay.status}` : TL(wrong.amount), total: TL(o8b.total) });

  // O9: cari (açık hesap) satışı ve tahsilat (kartla ve nakitle)
  const cust = await api('mudur', 'POST', '/customers', { name: 'E2E Cari Müşteri', phone: '05000000000', creditLimit: 500000 });
  o = await newOrder({ type: 'tezgah' });
  o = await addItems(o.id, [{ productId: product('Latte').id, size: 'M', qty: 2 }]);
  await pay(o.id, 'Açık hesap', o.total, { customerId: cust.id });
  const cariSale = o.total;
  await api('mudur', 'POST', '/cash/collect', { customerId: cust.id, methodId: method('Kredi kartı').id, amount: Math.round(cariSale / 2), requestId: rid() });
  // Kartla tahsilat sahada Pavo'da çekilir (LafPOS sepeti yok): bankanın batch'ine girer
  await ctl('POST', '/ctl/card', { amount: Math.round(cariSale / 2) / 100 });
  await api('mudur', 'POST', '/cash/collect', { customerId: cust.id, methodId: method('Nakit').id, amount: cariSale - Math.round(cariSale / 2), requestId: rid() });
  entry('O9', 'cari satış (Açık hesap) + tahsilat yarısı kart, yarısı nakit', { cariSale: TL(cariSale), collectedCard: TL(Math.round(cariSale / 2)), collectedCash: TL(cariSale - Math.round(cariSale / 2)) });

  // O10: karaoke hizmeti (HİZMET ürünü, KDV %20), cihazda kart
  o = await newOrder({ type: 'tezgah' });
  o = await addItems(o.id, [{ productId: product('Karaoke kişi başı').id, qty: 2 }]);
  await viaDevice(o.id, [{ type: 2, amount: o.total / 100 }]);
  entry('O10', 'karaoke kişi başı ×2 (hizmet, %20), cihazda kart', { total: TL(o.total) });

  // O11: havale (Z "diğer")
  o = await newOrder({ type: 'tezgah' });
  o = await addItems(o.id, [{ productId: product('Espresso').id, qty: 1 }]);
  await pay(o.id, 'Havale / EFT', o.total);
  entry('O11', 'satış, havale / EFT (Z diğer)', { total: TL(o.total) });

  // Kasa hareketleri: harcama (kategorili), teslim, giriş
  await api('mudur', 'POST', '/cash/movements', { kind: 'harcama', amount: 80000, description: 'Buz ve süt (fişsiz)', categoryId: harcamaCat?.id ?? null });
  entry('M1', 'kasa hareketi: harcama 800 TL (kategori)', { amount: 800, category: harcamaCat?.name ?? null, categoryId: harcamaCat?.id ?? null });
  await api('mudur', 'POST', '/cash/movements', { kind: 'teslim', amount: 50000, description: 'Patrona teslim' });
  entry('M2', 'kasa hareketi: teslim 500 TL', { amount: 500 });
  await api('mudur', 'POST', '/cash/movements', { kind: 'giris', amount: 20000, description: 'Bozuk para' });
  entry('M3', 'kasa hareketi: giriş 200 TL', { amount: 200 });

  // Vardiya devri: kasa sayımı (kasa hareketi değil)
  const mid = await api('mudur', 'GET', '/cash/day');
  await api('kasa', 'POST', '/cash/shift-counts', { countedCash: mid.summary.expectedCash - 1000, note: 'Akşam vardiyasına devir', toUserId: user('mudur').id }, { allow: [400, 403, 422] }).then((r) =>
    entry('S1', 'vardiya devri sayımı (10 TL eksik)', { counted: TL(mid.summary.expectedCash - 1000), expected: TL(mid.summary.expectedCash), result: r?.status ? `HTTP ${r.status}` : 'ok' }),
  );

  // Gün sonu: açık adisyon kalmasın; çekmece banknot banknot sayılır (5 TL eksik)
  for (const x of await api('mudur', 'GET', '/orders')) if (x.source === 'pos' && x.status === 'acik') await api('mudur', 'POST', `/orders/${x.id}/cancel`, { reason: 'E2E kapanış' });
  const before = await api('mudur', 'GET', '/cash/day');
  const counted = before.summary.expectedCash - 500;
  const dayId = before.day.id;
  // Banknot dökümü (kuruş anahtarları): 200, 100, 50, 20, 10, 5, 1 TL
  const notes = {};
  let restCount = counted;
  for (const b of [20000, 10000, 5000, 2000, 1000, 500, 100]) {
    const n = Math.floor(restCount / b);
    if (n) notes[String(b)] = n;
    restCount -= n * b;
  }
  // Kapanıştaki otomatik Pavo gün sonu alınamasın (5085): sonra elle yeniden alınır
  await ctl('POST', '/ctl/eod', { mode: 'fail' });
  const closed = await api('mudur', 'POST', '/cash/day/close', { countedCash: counted, cashCounts: restCount ? null : notes, note: 'Gün sonu notu (E2E)' });
  entry('C1', 'gün sonu: sayım (5 TL eksik), banknot dökümü, kapanış notu', { expected: TL(before.summary.expectedCash), counted: TL(counted), banknotes: notes, zNo: closed.day.zNo });
  report.lafpos.closeResponse = closed.lafmaliyet;
  log(`gün kapandı Z ${closed.day.zNo}`);

  const waitEod = async (want) => {
    let e = null;
    for (let i = 0; i < 160; i++) {
      e = (await api('patron', 'GET', '/okc/status')).pavo?.eod;
      if (e && e.dayId === dayId && e.status !== 'running' && (!want || e.status === want)) return e;
      await sleep(250);
    }
    return e;
  };
  const pushDay = async (label) => {
    const r = await api('patron', 'POST', `/sync/lafmaliyet/gun/${dayId}/push`, {}, { allow: [409, 502, 503] });
    report.lafpos[`push_${label}`] = r;
    // after(): otomatik rapor yanıt döndükten sonra yazılır
    await sleep(2500);
    return r;
  };
  const snap = async (label) => {
    const [p] = await sql`select bank_pos, revision from pos_day_reports where date = ${DAY} and branch_id = 'marina'`;
    const [c] = await sql`select bank_pos, okc_z_no, okc_total, counted_cash, cash_diff, note, revision, submitted_by_name from cash_reports where date = ${DAY} and branch_id = 'marina'`;
    const [st] = await sql`select missing, auto_values->'countedCash' as auto_counted, auto_values->'bankPos' as auto_bank from lafpos_day_ends where date = ${DAY}`;
    const photos = await sql`select p.kind from cash_report_photos p join cash_reports r on r.id = p.report_id where r.date = ${DAY}`;
    report.ladmin[`snap_${label}`] = { pos_day_reports: p ?? null, cash_reports: c ?? null, lafpos_day_ends: st ?? null, photos: photos.map((x) => x.kind) };
    log(`  durum ${label}: bankPos ${p?.bank_pos?.status ?? '-'} ${p?.bank_pos?.pavoCard ?? ''} · rapor ${c ? `r${c.revision} ${c.submitted_by_name} banka ${c.bank_pos} sayılan ${c.counted_cash}` : 'yok'} · eksik ${JSON.stringify(st?.missing ?? null)}`);
  };

  const failed = await waitEod('failed');
  entry('P1', 'Pavo banka gün sonu (otomatik, kapanışta): alınamadı', { status: failed?.status, errorCode: failed?.errorCode, message: failed?.message });
  await pushDay('failed');
  await snap('pavo_alinamadi');

  // Elle yeniden: cihazda gün sonu (Yönetim › Yazarkasa POS) → kapanan güne yazılır, gün yeniden gönderilir
  await ctl('POST', '/ctl/eod', { mode: 'ok' });
  const manual = await api('patron', 'POST', '/okc/eod', { print: false }, { allow: [409, 502] });
  const eod = await waitEod('ok');
  report.lafpos.pavoEod = eod;
  entry('P2', 'Pavo banka gün sonu elle yeniden alındı', { status: eod?.status, batchNo: eod?.batchNo, grandTotal: TL(eod?.grandTotalKurus), lafposCard: TL(eod?.dayCardKurus), earlierBatches: (eod?.earlier ?? []).map((b) => ({ batchNo: b.batchNo, total: TL(b.grandTotalKurus) })), manual: manual?.status ?? 'ok' });
  report.lafpos.pavoBatches = await ctl('GET', '/ctl/batches');
  const push = await pushDay('ok');
  report.lafpos.push = push;
  log('gün yeniden gönderildi (Pavo sonucuyla)', JSON.stringify(push).slice(0, 160));
  await snap('pavo_alindi');

  // LafPOS'un gönderdiği gövde ve kendi kayıtları
  report.lafpos.payload = await api('patron', 'GET', `/sync/lafmaliyet/gun/${dayId}`);
  report.lafpos.day = await api('patron', 'GET', `/cash/days/${dayId}`);
  const reqLafpos = createRequire(join(LAFPOS, 'package.json'));
  const Database = reqLafpos('better-sqlite3');
  const lite = new Database(join(dataDir, 'lafpos.db'), { readonly: true, fileMustExist: true });
  const q = (s, ...p) => lite.prepare(s).all(...p);
  report.lafpos.tables = {
    business_day: q('select date, z_no, opening_cash, counted_cash, cash_counts, expected_cash, cash_diff, note, training_day from business_days where id = ?', dayId)[0],
    payments: q('select method_name, z_field, amount, tip, order_id is null as collection, refunded_at is not null as refunded, customer_id is not null as cari, note from payments where day_id = ?', dayId),
    cash_movements: q('select kind, amount, description, category_id, category_name from cash_movements where day_id = ?', dayId),
    shift_counts: q('select counted, expected, diff, note, banknotes from shift_counts where day_id = ?', dayId),
    customer_ledger: q('select kind, amount, note from customer_ledger'),
    fiscal_receipts: q("select provider, status, amount, z_no, receipt_no, json_array_length(payment_ids) as payments, json_extract(result, '$.docKind') as doc_kind from fiscal_receipts"),
    outbox: q("select target, kind, dedupe_key, sent_at is not null as sent, attempts, last_error from outbox where target = 'lafmaliyet'"),
  };
  lite.close();

  // ─── 5. ladmin: saklanan satırlar ─────────────────────────────────────────
  let pdr = null;
  for (let i = 0; i < 60; i++) {
    [pdr] = await sql`select * from pos_day_reports where date = ${DAY} and branch_id = 'marina'`;
    if (pdr?.bank_pos) break;
    await sleep(500);
  }
  // writeAutoReport yanıt döndükten sonra çalışır (after()): rapor yazılana dek bekle
  let cr = null;
  for (let i = 0; i < 60; i++) {
    [cr] = await sql`select * from cash_reports where date = ${DAY} and branch_id = 'marina'`;
    const [st] = await sql`select auto_values from lafpos_day_ends where date = ${DAY} and branch_id = 'marina'`;
    if (cr && pdr && st?.auto_values) break;
    await sleep(500);
  }
  const L = report.ladmin;
  L.pos_day_reports = pdr ?? null;
  L.pos_daily_sales = await sql`select pos_name, product_id, site_menu_id, slot, qty, revenue, gross, is_addon, lafpos_service from pos_daily_sales where date = ${DAY} and branch_id = 'marina' order by revenue desc`;
  L.cash_reports = cr ?? null;
  L.cash_report_empty_fields = cr ? Object.entries(cr).filter(([k, v]) => (v === null || v === 0) && !['id'].includes(k)).map(([k]) => k) : null;
  L.cash_outs = await sql`select kind, amount, store, description, doc_type, photo_id, created_by_name, lafpos_id from cash_outs where date = ${DAY}`;
  L.expense_entries = await sql`select * from expense_entries where cash_out_id in (select id from cash_outs where date = ${DAY})`.catch((e) => ({ error: e.message }));
  L.lafpos_day_ends = (await sql`select date, report_id, auto_values, missing, day_hash, email_count, email_error from lafpos_day_ends where date = ${DAY}`)[0] ?? null;
  L.pos_day_revisions = await sql`select revision, z_no, correction, received_at from pos_day_revisions where date = ${DAY} order by id`.catch(() => sql`select * from pos_day_revisions where date = ${DAY}`);
  L.cash_report_revisions = await sql`select revision, submitted_by_name, submitted_at from cash_report_revisions where date = ${DAY}`;
  L.cash_report_photos = await sql`select p.kind from cash_report_photos p join cash_reports r on r.id = p.report_id where r.date = ${DAY}`;
  L.activity_log = await sql`select user_name, action, detail from activity_log order by id`;
  L.staff_requests = await sql`select kind, status, subject from staff_requests`.catch((e) => ({ error: e.message }));
  L.integration_state = await sql`select key, value from integration_state where key like 'lafpos%'`;
  log(`ladmin: pos_day_reports ${pdr ? 'var' : 'YOK'}, cash_reports ${cr ? `var (gönderen ${cr.submitted_by_name})` : 'YOK'}`);

  // ─── 5b. Sayfalar (personel ve yönetici) ──────────────────────────────────
  if (!NO_UI) {
    const reqPw = createRequire(join(LAFPOS, 'package.json'));
    const { chromium } = reqPw('playwright-core');
    const { SignJWT } = reqLadmin('jose');
    const cookieFor = async (u, role) =>
      new SignJWT({ name: u.name, role, sv: 1, typ: 'session' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(String(u.id))
        .setJti(crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime('1d')
        .sign(new TextEncoder().encode(AUTH_SECRET));
    browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: 'chrome' }));
    const shotsDir = SHOTS ?? join(WORK, 'shots');
    mkdirSync(shotsDir, { recursive: true });
    async function visit(name, u, role, path, after) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'tr-TR', timezoneId: 'Europe/Istanbul' });
      await ctx.addCookies([
        { name: 'laf_session', value: await cookieFor(u, role), domain: '127.0.0.1', path: '/', httpOnly: true },
        { name: 'laf_sube', value: 'marina', domain: '127.0.0.1', path: '/' },
      ]);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
      await page.goto(`${LADMIN_URL}${path}`, { waitUntil: 'load', timeout: 240_000 });
      await page.waitForTimeout(2500);
      if (after) await after(page).catch((e) => errors.push(`eylem: ${e.message.slice(0, 200)}`));
      const text = await page.evaluate(() => document.querySelector('main')?.innerText ?? document.body.innerText);
      await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
      writeFileSync(join(shotsDir, `${name}.txt`), text);
      const buttons = await page.evaluate(() => [...document.querySelectorAll('main button, main a[role=button]')].map((b) => b.innerText.trim()).filter(Boolean).slice(0, 60));
      await ctx.close();
      report.ui[name] = { url: path, screenshot: join(shotsDir, `${name}.png`), errors, buttons, lines: text.split('\n').map((s) => s.trim()).filter((s) => /eksik|banka|yazarkasa|fotoğraf|gönder|düzelt|lafpos|pavo|kontrol|onay|z no|fark/i.test(s)).slice(0, 60) };
      log(`  sayfa ${name}: ${buttons.length} düğme`);
    }
    await visit('personel-kasa', staff, 'staff', `/panel/kasa?gun=${DAY}`);
    await visit('yonetici-kasa-gun', admin, 'admin', `/panel/kasa?gun=${DAY}`);
    await visit('yonetici-kasa', admin, 'admin', '/panel/kasa');
    await visit('yonetici-onaylar', admin, 'admin', '/panel/onaylar');
    await visit('personel-bugun', staff, 'staff', '/panel/bugun');
    // Personel otomatik raporda "Düzenle"ye basarsa ne görür (Banka POS / yazarkasa alanları, fotoğraf, gönder).
    // Düğme yoksa (yeni akış: yalnız fotoğraf) adım boş geçer, rapora "Düzenle yok" yazılır
    const clickEdit = async (page) => {
      const edit = page.getByRole('button', { name: 'Düzenle', exact: true });
      if (!(await edit.count())) return false;
      await edit.first().click();
      await page.waitForTimeout(2500);
      return true;
    };
    await visit('personel-kasa-duzenle', staff, 'staff', `/panel/kasa?gun=${DAY}`, async (page) => {
      report.ui.staffHasEdit = await clickEdit(page);
    });
    // Personelin fotoğrafı: verilmediyse ilk ekran görüntüsü (yerelde okuma kapalı: ANTHROPIC_API_KEY yok)
    const photoFile = PHOTO ?? join(shotsDir, 'personel-kasa.png');
    await visit('personel-kasa-foto-gonder', staff, 'staff', `/panel/kasa?gun=${DAY}`, async (page) => {
      await clickEdit(page);
      // Kasadan çıkanların fiş alanları (cash-outs) değil, raporun fotoğraf alanı: önce formun içindeki galeri seçicisi
      let input = page.locator('form input[type=file]:not([capture])');
      if (!(await input.count())) input = page.locator('input[type=file]:not([capture])').last();
      await input.first().setInputFiles(photoFile);
      await page.waitForTimeout(8000);
      await page.screenshot({ path: join(shotsDir, 'personel-kasa-foto-yuklendi.png'), fullPage: true });
      writeFileSync(join(shotsDir, 'personel-kasa-foto-yuklendi.txt'), await page.evaluate(() => document.querySelector('main')?.innerText ?? ''));
      const send = page.getByRole('button', { name: /Raporu güncelle|Raporu gönder|Onaya gönder/ });
      report.ui.staffSubmitLabel = (await send.count()) ? (await send.first().innerText()).trim() : null;
      if (report.ui.staffSubmitLabel) {
        await send.first().click();
        await page.waitForTimeout(6000);
      }
    });
    L.photos_after = await sql`select kind, linked_at is not null as linked, created_by_name from photos`;
    L.staff_requests_after = await sql`select kind, status, subject from staff_requests`.catch((e) => ({ error: e.message }));
    await snap('personel_foto_sonrasi');

    // LafPOS'ta föyden yeniden sayım (düzeltme): otomatik birleştirme personelin dokunduğu alanı ezer mi
    const recount = await api('mudur', 'POST', `/cash/days/${dayId}/count`, { countedCash: counted + 1000, note: 'Yeniden sayım (E2E)', approverPin: '1897' }, { allow: [403, 409, 422] });
    entry('C2', 'LafPOS föyünde yeniden sayım (+10 TL), yetkili onayıyla', { counted: TL(counted + 1000), result: recount?.status ? `HTTP ${recount.status} ${JSON.stringify(recount.body).slice(0, 120)}` : 'ok' });
    await sleep(4000);
    await snap('lafpos_yeniden_sayim');
    await visit('yonetici-kasa-gun-son', admin, 'admin', `/panel/kasa?gun=${DAY}`);
    await visit('personel-kasa-son', staff, 'staff', `/panel/kasa?gun=${DAY}`);
  }

  // ─── 6. Eşleme: her LafPOS girişi ladmin'de nerede ────────────────────────
  const pl = report.lafpos.payload ?? {};
  const z = pdr?.z ?? {};
  const has = (v) => v !== undefined && v !== null;
  const pays = pdr?.payments ?? [];
  report.mapping = [
    { lafpos: 'Ürün satırları (O1–O11)', ladmin: `pos_daily_sales ${L.pos_daily_sales.length} satır, Σciro ${TL(Math.round(L.pos_daily_sales.reduce((a, r) => a + r.revenue * 100, 0)))} = z.zTotal ${z.zTotal}` },
    { lafpos: 'Ödeme türleri', ladmin: `pos_day_reports.payments: ${pays.map((p) => `${p.name}/${p.zField}/${p.channel ?? '-'}=${p.amount}`).join(', ')}; cash_reports cash ${cr?.cash} card ${cr?.card} meal ${cr?.meal_card} other ${cr?.other}` },
    { lafpos: 'Kartla bahşiş (O3)', ladmin: `z.cardTips ${z.cardTips} (pos_day_reports.z; kasa raporunda sütun yok, yalnız kart kıyasında düşülür)` },
    { lafpos: 'Nakit bahşiş (O5)', ladmin: `ayrı alan yok; z.cashIn ${z.cashIn} içinde (giriş + nakit tahsilat + nakit bahşiş) → cash_reports.cash_in ${cr?.cash_in}` },
    { lafpos: 'İndirim (O3)', ladmin: `z.discounts ${z.discounts}, cash_reports.discounts ${cr?.discounts}, lines.gross` },
    { lafpos: 'İkram / ödenmez / zayi (O6)', ladmin: `pos_day_reports.ikram: ${(pdr?.ikram ?? []).map((i) => `${i.kind ?? '?'}:${i.posName}=${i.menuValue}${i.personKind ? `(${i.personKind})` : ''}`).join(', ')}; z.offRevenue ${z.offRevenue} → cash_reports.off_revenue ${cr?.off_revenue}` },
    { lafpos: 'İptaller (O7) ve kalem iadesi (O8)', ladmin: `pos_day_reports.iptal: ${(pdr?.iptal ?? []).map((i) => `${i.posName}=${i.listValue} hazır:${i.prepared} iade:${i.refund}`).join(', ')}` },
    { lafpos: 'Ödeme iptalleri (O8, O8b)', ladmin: `pos_day_reports.refunds: ${(pdr?.refunds ?? []).map((r) => `${r.name}/${r.zField}=${r.amount} (${r.reason})`).join(', ')}` },
    { lafpos: 'Cari satış (O9)', ladmin: `payments satırı "Açık hesap" (zField other) ${pays.find((p) => /hesap/i.test(p.name))?.amount ?? 'YOK'}; müşteri bakiyesi / defteri ladmin'e gitmez` },
    { lafpos: 'Cari tahsilat kart (O9)', ladmin: `z.cardCollections ${z.cardCollections}; kasa raporunda sütun yok` },
    { lafpos: 'Cari tahsilat nakit (O9)', ladmin: `ayrı alan yok; z.cashIn ${z.cashIn} içinde` },
    { lafpos: 'Karaoke hizmeti (O10)', ladmin: `pos_daily_sales: ${L.pos_daily_sales.filter((r) => r.lafpos_service).map((r) => `${r.pos_name}=${r.revenue}`).join(', ') || 'YOK'}; z.vat ${JSON.stringify(z.vat ?? null)}` },
    { lafpos: 'Kasa hareketleri (M1–M3)', ladmin: `pos_day_reports.cash_moves ${pdr?.cash_moves?.length ?? 'YOK'}; cash_outs ${L.cash_outs.map((c) => `${c.kind}=${c.amount}${c.lafpos_id ? ' (LafPOS)' : ''}`).join(', ')}; expense_entries ${Array.isArray(L.expense_entries) ? L.expense_entries.length : JSON.stringify(L.expense_entries)}` },
    { lafpos: 'Vardiya devri sayımı (S1)', ladmin: `gövdede yok (${has(pl.shiftCounts) ? 'var' : 'yok'})` },
    { lafpos: 'Gün sonu sayımı ve banknot dökümü (C1)', ladmin: `z.countedCash ${z.countedCash} → cash_reports.counted_cash ${cr?.counted_cash}; banknot dökümü gövdede ${has(pl.z?.cashCounts) ? 'var' : 'yok'}; kapanış notu gövdede ${has(pl.z?.closeNote) ? 'var' : 'yok'}` },
    { lafpos: 'Açılış (E01)', ladmin: `z.openingCash ${z.openingCash} → cash_reports.opening_cash ${cr?.opening_cash}; expectedOpening ${z.expectedOpening}` },
    { lafpos: 'Pavo banka gün sonu (P1)', ladmin: `pos_day_reports.bank_pos ${pdr?.bank_pos ? `${pdr.bank_pos.status} batch ${pdr.bank_pos.batchNo} pavoCard ${pdr.bank_pos.pavoCard} lafposCard ${pdr.bank_pos.lafposCard} diff ${pdr.bank_pos.diff}` : 'YOK'} → cash_reports.bank_pos ${cr?.bank_pos}` },
    { lafpos: 'Cihaz fişleri (O1, O2, O5, O10)', ladmin: `z.okcZNo ${z.okcZNo}; offDevice ${JSON.stringify(pdr?.off_device)}; cash_reports okc_* ${cr ? ['okc_z_no', 'okc_receipts', 'okc_total', 'okc_cash', 'okc_card', 'okc_meal_card', 'okc_other', 'okc_vat_total'].map((k) => `${k}=${cr[k]}`).join(' ') : '-'}` },
    { lafpos: 'Çalışan personel', ladmin: `workedStaffRefs gövdede ${has(pl.workedStaffRefs) ? 'var' : 'yok (bağlı kullanıcı yok)'}; pos_day_reports.worked_staff sütunu ${pdr && 'worked_staff' in pdr ? 'var' : 'yok'}` },
    { lafpos: 'Otomatik kasa raporu', ladmin: cr ? `gönderen ${cr.submitted_by_name}; not "${cr.note}"; eksik ${JSON.stringify(L.lafpos_day_ends?.missing)}` : 'YOK' },
  ];
  report.finishedAt = new Date().toISOString();
}

let code = 0;
try {
  await main();
} catch (e) {
  code = 1;
  report.error = e instanceof Error ? e.stack : String(e);
  console.error('HATA:', report.error);
} finally {
  const outFile = opt('out') ? resolve(opt('out')) : join(SHOTS ?? WORK, 'rapor.json');
  mkdirSync(dirname(outFile), { recursive: true });
  // Sunucu günlükleri (sonları rapora, tamamı --shots klasörüne)
  report.logs = Object.fromEntries(Object.entries(PROCS).map(([n, p]) => [n, p.text().split('\n').filter((l) => /hata|error|warn|lafpos\]|pavo\]|lafmaliyet\]|okunamayan/i.test(l)).slice(-40)]));
  writeFileSync(outFile, JSON.stringify(report, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  if (SHOTS) for (const [n, p] of Object.entries(PROCS)) writeFileSync(join(SHOTS, `${n}.log`), p.text());
  console.log('\n── Eşleme (LafPOS → ladmin) ──');
  for (const m of report.mapping) console.log(`• ${m.lafpos}: ${m.ladmin}`);
  console.log(`\nRapor: ${outFile}`);
  await finish(code);
}
