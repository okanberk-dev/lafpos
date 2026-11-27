import { and, eq, inArray } from 'drizzle-orm';
import { db, schema, tx } from '../db/client';
import type { Actor } from '../lib/auth';
import { Effects } from '../lib/effects';
import { conflict, HttpError } from '../lib/http';
import { type AllSettings, getSettings, getSyncState, setSyncState, updateSettings } from '../lib/settings';
import { getOpenDay } from '../services/orders';
import { fromTokenxSale } from './providers/tokenx';
import { pavoProvider } from './providers/pavo';
import { applyResult, findPavoDevices, pairDevice, rememberPavoMediators, setPavoDevice } from './service';
import { join } from 'node:path';
import { env } from '../env';
import { kablo, type KabloState, useKabloDir } from './token-kablo';
import { driverInstalled, ensureDll, ensureVcRuntime, installDriver } from './token-kablo-kurulum';
import { pavoMealMap } from '@shared/yemek-karti';
import type { TokenxSale } from './tokenx';
import { kabloPlan, kabloWantedFor, type KabloSettings as Settings } from './token-kablo-plan';

export { kabloPlan };

/**
 * Token kablolunun AsilPOS'a bağlandığı yer: köprüyü açar ya da kapatır, kablo takılınca kurulumu kendiliğinden yapar
 * (kısımlar, yemek kartları, gerekirse bağlantıyı Token kabloluya geçirir), cihazdan gelen satış sonucunu adisyona işler
 * ve Yönetim › Yazarkasa POS › "Kurulumu yap" düğmesini çalıştırır (Pavo için de). Ayrıntı: docs/04-YAZARKASA.md §9.
 */

/** Bu kurulumda köprü çalışmalı mı (ayarlardan; ayrıntı `token-kablo-plan.ts`) */
export function kabloWanted(s: Settings = getSettings(), supported = kablo.supported): boolean {
  return kabloWantedFor(s, supported);
}

/** Kablo takıldı: plan uygulanır, denetim kaydına yazılır, ekranlar yenilenir */
export function kabloConnected(state: KabloState, actorId: string | null = null, force = false): { applied: string[]; held: string | null } {
  const s = getSettings();
  const methods = db.select().from(schema.paymentMethods).all();
  const plan = kabloPlan(s, state, methods, !!getOpenDay(db), force);
  // Geçilmediyse nedeni ekranda (Token kablolu kartı)
  if (plan.held) setSyncState('tokenkablo.held', plan.held);
  else db.delete(schema.syncState).where(eq(schema.syncState.key, 'tokenkablo.held')).run();
  const applied: string[] = [];
  const fx = new Effects();
  tx((t) => {
    const patch: Partial<AllSettings> = {};
    if (plan.provider) {
      patch.okcProvider = plan.provider;
      patch.okcMode = 'anlik';
      applied.push(`bağlantı ${s.okcProvider} → Token kablolu`);
    }
    if (plan.sectionMap) {
      patch.okcSectionMap = plan.sectionMap;
      applied.push(`KDV → kısım ${Object.entries(plan.sectionMap).map(([r, n]) => `%${r}→${n}`).join(', ')}`);
    }
    if (plan.operatorMethods) {
      patch.okcOperatorMethods = plan.operatorMethods;
      const added = Object.keys(plan.operatorMethods).filter((k) => !(k in s.okcOperatorMethods));
      applied.push(`yemek kartı ${added.length} uygulama eşlendi`);
    }
    if (!applied.length) return;
    updateSettings(patch, t);
    fx.audit(t, {
      userId: actorId,
      action: 'okc.settings',
      severity: plan.provider ? 'uyari' : 'info',
      entity: 'settings',
      entityId: 'okc',
      message: `Token cihazı kabloyla bağlandı (${state.model ?? 'model bilinmiyor'}${state.fiscalId ? ` · ${state.fiscalId}` : ''}); kendiliğinden ayarlandı: ${applied.join('; ')}`,
      data: plan.provider ? { from: { provider: s.okcProvider, mode: s.okcMode }, to: { provider: plan.provider, mode: 'anlik' } } : undefined,
    });
    fx.emit({ topic: 'settings', kind: 'settings.updated' });
  });
  fx.emit({ topic: 'okc', kind: 'okc.device', message: `Token cihazı bağlandı${state.model ? ` (${state.model})` : ''}` });
  fx.flush();
  return { applied, held: plan.held };
}

/** Cihazdan gelen satış sonucu: bekleyen sepete işlenir (sorgu döngüsü de aynı sonucu okur; işlem tekrarlanmaz) */
export function kabloSale(sale: TokenxSale) {
  const r = db
    .select()
    .from(schema.fiscalReceipts)
    .where(and(eq(schema.fiscalReceipts.id, sale.basketID), eq(schema.fiscalReceipts.provider, 'tokenkablo')))
    .get();
  if (!r) {
    console.warn(`[token-kablo] AsilPOS'ta olmayan sepetin sonucu geldi (${sale.basketID})`);
    return;
  }
  applyResult(r.id, fromTokenxSale(sale, r.amount), 'cihaz');
}

useKabloDir(() => join(env.dataDir, 'token-kablo'));

let wired = false;
/** Sunucu açılışında ve bağlantı ayarı değişince: köprüyü gerektiği gibi açar ya da kapatır */
export function syncTokenKablo() {
  if (!wired) {
    wired = true;
    try {
      closeStaleSetup();
    } catch (e) {
      console.error('[token-kablo] yarım kalan kurulum kaydı', e);
    }
    kablo.on('connected', (st: KabloState) => {
      try {
        kabloConnected(st);
      } catch (e) {
        console.error('[token-kablo] kendiliğinden kurulum', e);
      }
    });
    kablo.on('sale', (sale: TokenxSale) => {
      try {
        kabloSale(sale);
      } catch (e) {
        console.error('[token-kablo] satış sonucu işlenemedi', e);
      }
    });
    kablo.on('disconnected', () => {
      const fx = new Effects();
      fx.emit({ topic: 'okc', kind: 'okc.device', message: 'Token cihazının kablosu çıktı' });
      fx.flush();
    });
  }
  if (kabloWanted()) kablo.start();
  else if (kablo.running) kablo.stop();
}

// ─── Kurulumu yap (tek düğme) ───────────────────────────────────────────────

export type StepStatus = 'bekliyor' | 'suruyor' | 'tamam' | 'atlandi' | 'hata';
export interface SetupStep {
  key: string;
  label: string;
  status: StepStatus;
  detail: string | null;
}
export interface SetupRun {
  device: 'tokenkablo' | 'pavo';
  running: boolean;
  ok: boolean | null;
  startedAt: number;
  finishedAt: number | null;
  steps: SetupStep[];
}

const SETUP_KEY = 'tokenkablo.kurulum';

class Steps {
  run: SetupRun;
  constructor(
    device: SetupRun['device'],
    list: [string, string][],
    private readonly key: string | null,
  ) {
    this.run = { device, running: true, ok: null, startedAt: Date.now(), finishedAt: null, steps: list.map(([k, label]) => ({ key: k, label, status: 'bekliyor', detail: null })) };
    this.save();
  }
  private save() {
    if (this.key) setSyncState(this.key, this.run);
    const fx = new Effects();
    fx.emit({ topic: 'okc', kind: 'okc.setup' });
    fx.flush();
  }
  set(key: string, status: StepStatus, detail: string | null = null) {
    this.run = { ...this.run, steps: this.run.steps.map((s) => (s.key === key ? { ...s, status, detail } : s)) };
    this.save();
  }
  async step(key: string, fn: () => Promise<string | null | false>): Promise<boolean> {
    this.set(key, 'suruyor');
    try {
      const out = await fn();
      this.set(key, out === false ? 'atlandi' : 'tamam', out === false ? null : out);
      return true;
    } catch (e) {
      this.set(key, 'hata', e instanceof Error ? e.message : String(e));
      return false;
    }
  }
  finish(ok: boolean) {
    this.run = { ...this.run, running: false, ok, finishedAt: Date.now(), steps: this.run.steps.map((s) => (s.status === 'bekliyor' ? { ...s, status: 'atlandi' } : s)) };
    this.save();
    return this.run;
  }
}

/** Yarıda kesilen koşu (saf): süren adım hata, bekleyenler atlandı; düğme yeniden basılabilir olur */
export function interruptedRun(run: SetupRun, now = Date.now()): SetupRun {
  return {
    ...run,
    running: false,
    ok: false,
    finishedAt: now,
    steps: run.steps.map((s) =>
      s.status === 'suruyor' ? { ...s, status: 'hata', detail: 'Kasa yeniden başladığı için yarım kaldı; yeniden “Kurulumu yap”a basın' } : s.status === 'bekliyor' ? { ...s, status: 'atlandi' } : s,
    ),
  };
}

/**
 * Kurulum sürerken sunucu kapandıysa (güncelleme, yeniden başlatma) kayıt "sürüyor" kalır: kart sonsuza dek "Kurulum
 * sürüyor" der ve düğme basılamaz. Açılışta böyle bir kayıt yarım kaldı diye kapatılır
 */
export function closeStaleSetup(now = Date.now()): boolean {
  const run = getSyncState<SetupRun>(SETUP_KEY);
  if (!run?.running || setupRunning) return false;
  setSyncState(SETUP_KEY, interruptedRun(run, now));
  return true;
}

/** Kablo takılıp cihaz bağlanana dek bekler (en çok `ms`) */
function waitConnected(ms: number): Promise<boolean> {
  if (kablo.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      kablo.off('connected', on);
      resolve(kablo.connected);
    }, ms);
    const on = () => {
      clearTimeout(t);
      kablo.off('connected', on);
      resolve(true);
    };
    kablo.on('connected', on);
  });
}

const CABLE_HINT =
  '300TR: beşiğin fişi takılı, entegrasyon kablosu beşikte RS232’de, Menü › Ayarlar › Harici Cihaz Modu › GMP3 › TOKENX CONNECT seçili ve cihaz satış ekranında olmalı. X30TR: kablo soldaki Type-C girişinde, Satış Uygulamaları’ndan “TokenX Connect Uygulaması (Kablolu)” açık ve “Sepet bekleniyor” yazıyor olmalı; cihazdaki izin sorusunu onaylayın';

let setupRunning: Promise<SetupRun> | null = null;

/**
 * Token kablolu kurulumu: Visual C++ (x86), Token kütüphanesi, köprü, cihaz (gerekirse Token'ın sürücüsü), kısımlar ve
 * yemek kartları, bağlantıyı Token kabloluya geçirme. Arka planda sürer; adımlar `okcStatus().tokenKablo.setup`'ta
 */
export function startTokenKabloSetup(actor: Actor): SetupRun {
  if (!kablo.supported) throw conflict('Kablolu Token kurulumu yalnız Windows kasa bilgisayarında yapılır (AsilPOS’u kasa bilgisayarına kurun)', 'okc_windows');
  if (setupRunning) return getSyncState<SetupRun>(SETUP_KEY)!;
  const s = getSettings();
  if (s.okcProvider !== 'tokenkablo' && s.okcProvider !== 'kapali' && s.okcProvider !== 'simulator' && actor.user.role !== 'patron') {
    throw new HttpError(403, 'Yazarkasa bağlantısını yalnız patron değiştirir', 'patron_only');
  }
  const st = new Steps(
    'tokenkablo',
    [
      ['vc', 'Visual C++ çalışma kitaplığı'],
      ['dll', 'Token kütüphanesi'],
      ['kopru', 'Token köprüsü'],
      ['cihaz', 'Cihaz kabloyla bağlı'],
      ['ayar', 'Kısımlar, yemek kartları ve bağlantı'],
    ],
    SETUP_KEY,
  );
  const job = (async () => {
    if (!(await st.step('vc', async () => ((await ensureVcRuntime()) ? 'Kuruldu' : false)))) return st.finish(false);
    if (!(await st.step('dll', async () => ((await ensureDll()) ? 'İndirildi ve doğrulandı' : false)))) return st.finish(false);
    const started = await st.step('kopru', async () => {
      const state = kablo.running && kablo.state.phase !== 'kurulum' ? kablo.state : kablo.restart();
      // Köprü açılıp "hazır" diyene dek (kütüphane derlenir, birkaç saniye)
      for (let i = 0; i < 40 && (kablo.state.phase === 'baslatiliyor' || state.phase === 'kapali'); i++) await new Promise((r) => setTimeout(r, 500));
      if (kablo.state.phase === 'kurulum' || kablo.state.phase === 'hata' || kablo.state.phase === 'desteklenmiyor') throw new Error(kablo.state.message ?? 'Köprü başlamadı');
      return 'Çalışıyor';
    });
    if (!started) return st.finish(false);
    const found = await st.step('cihaz', async () => {
      if (await waitConnected(20_000)) return `${kablo.state.model ?? 'Token'} · ${kablo.state.fiscalId ?? ''}`.trim();
      // Cihaz görünmüyor: Token'ın sürücüleri (bir kez) kurulur, köprü yeniden başlar
      if (!driverInstalled()) {
        st.set('cihaz', 'suruyor', 'Cihaz görünmedi; Token sürücüsü kuruluyor (birkaç dakika sürebilir)');
        const driver = await installDriver();
        kablo.restart();
        if (await waitConnected(45_000)) return `Sürücü kuruldu · ${kablo.state.model ?? 'Token'} · ${kablo.state.fiscalId ?? ''}`.trim();
        // Yeni sürücü çoğu zaman kablo çıkarılıp takılınca (Token'ın aracı da bunu ister), bazen yeniden başlatınca etkinleşir
        const missing = driver.errors.length ? ` (${driver.errors.join('; ')})` : '';
        throw new Error(
          `Sürücü kuruldu${missing} ama cihaz hâlâ görünmüyor: kabloyu çıkarıp yeniden takın${driver.reboot ? ', olmazsa bilgisayarı yeniden başlatın' : ''}. ${CABLE_HINT}. Kablo takılınca AsilPOS kendiliğinden bağlanır; bağlanmazsa yeniden “Kurulumu yap”a basın`,
        );
      }
      throw new Error(`Cihaz görünmüyor. ${CABLE_HINT}. Sonra yeniden “Kurulumu yap”a basın; kablo takılınca AsilPOS kendiliğinden de bağlanır`);
    });
    if (!found) return st.finish(false);
    const ok = await st.step('ayar', async () => {
      // Patron bastıysa bağlantı her durumda geçer (yönetimden seçmekle aynı); diğer yetkili yalnız kapalı ya da eğitim
      // cihazından (gün açık değilken) geçirir
      const out = kabloConnected(kablo.state, actor.user.id, actor.user.role === 'patron');
      if (out.held && getSettings().okcProvider !== 'tokenkablo') throw new Error(out.held);
      return out.applied.length ? out.applied.join('; ') : 'Ayarlar zaten uygun';
    });
    return st.finish(ok);
  })()
    .catch((e) => {
      console.error('[token-kablo] kurulum', e);
      return st.finish(false);
    })
    .finally(() => {
      setupRunning = null;
    });
  setupRunning = job;
  return st.run;
}

/**
 * Pavo kurulumu (tek düğme): cihazı ağda bulur (adres verilmediyse), kaydeder, bağlantıyı Pavo'ya geçirir, eşleştirir
 * (cihazdaki onayı bekler, en çok 2 dk), bağlantıyı dener ve yemek kartı ödeme araçlarını adıyla eşler. Seri numarası
 * cihazdan okunamaz (Pavo'nun REST'i vermez): bir kez yazılır
 */
export async function runPavoSetup(actor: Actor, input: { serial: string; address?: string | null }): Promise<SetupRun> {
  const s = getSettings();
  if (s.okcProvider !== 'pavo' && actor.user.role !== 'patron') throw new HttpError(403, 'Yazarkasa bağlantısını yalnız patron değiştirir', 'patron_only');
  const st = new Steps(
    'pavo',
    [
      ['bul', 'Cihazı ağda bul'],
      ['kaydet', 'Adres ve seri no'],
      ['eslestir', 'Eşleştirme (cihazda onaylayın)'],
      ['dene', 'Bağlantı ve ödeme araçları'],
    ],
    null,
  );
  let address = input.address?.trim() || null;
  if (
    !(await st.step('bul', async () => {
      if (address) return false;
      const found = await findPavoDevices(input.serial);
      const ok = found.candidates.filter((c) => c.ok);
      const pick = ok.length === 1 ? ok[0] : found.candidates.length === 1 ? found.candidates[0] : null;
      if (!pick) {
        throw new Error(
          found.candidates.length
            ? `Ağda ${found.candidates.length} cihaz bulundu; adresini seçip yeniden deneyin`
            : 'Ağda Pavo bulunamadı: cihaz açık ve kasayla aynı ağda mı, REST açık mı bakın; adresi cihazın Network Ayarları’ndan yazın',
        );
      }
      address = pick.url;
      return pick.url;
    }))
  )
    return st.finish(false);
  if (
    !(await st.step('kaydet', async () => {
      const waiting = db
        .select({ id: schema.fiscalReceipts.id })
        .from(schema.fiscalReceipts)
        .where(and(inArray(schema.fiscalReceipts.status, ['gonderildi', 'kilitli']), inArray(schema.fiscalReceipts.provider, ['tokenx', 'tokenkablo'])))
        .get();
      if (s.okcProvider !== 'pavo' && waiting) throw new Error('Başka cihazda sonucu beklenen hesap var; o sonuçlanınca deneyin');
      setPavoDevice(actor, { address: address!, serial: input.serial });
      if (s.okcProvider !== 'pavo') switchProvider(actor, 'pavo');
      return null;
    }))
  )
    return st.finish(false);
  if (!(await st.step('eslestir', async () => ((pavoProvider.status() as { paired?: boolean }).paired ? false : (await pairDevice(actor), 'Eşleştirildi')))))
    return st.finish(false);
  const ok = await st.step('dene', async () => {
    const out = (await pavoProvider.test!()) as { ping: { ok: boolean; message: string | null }; paired: boolean; pairingHint: string | null; mediators: { id: number | null; name: string | null }[] };
    if (!out.ping.ok) throw new Error(`Cihaz yanıtı: ${out.ping.message ?? 'hata'}`);
    if (!out.paired) throw new Error(out.pairingHint ?? 'Eşleştirme gerekli');
    if (out.mediators.length) rememberPavoMediators(out.mediators);
    const cur = getSettings().okcPavoMediatorMethods;
    const methods = db.select().from(schema.paymentMethods).all();
    const next = pavoMealMap(cur, methods, out.mediators);
    const added = Object.keys(next).filter((k) => !(k in cur));
    if (added.length) {
      const fx = new Effects();
      tx((t) => {
        updateSettings({ okcPavoMediatorMethods: next }, t);
        fx.audit(t, { userId: actor.user.id, action: 'okc.settings', entity: 'settings', entityId: 'okc', message: `Pavo yemek kartı ödeme araçları eşlendi: ${added.map((k) => `${k} → ${methods.find((m) => m.id === next[k])?.name ?? next[k]}`).join(', ')}` });
        fx.emit({ topic: 'settings', kind: 'settings.updated', byUserId: actor.user.id });
      });
      fx.flush();
    }
    return `Cihaz yanıt veriyor · ${out.mediators.length} ödeme aracı${added.length ? ` · ${added.length} yemek kartı eşlendi` : ''}`;
  });
  return st.finish(ok);
}

/** Bağlantıyı değiştirir (kurulum düğmeleri): yönetimdeki seçimle aynı kayıt */
function switchProvider(actor: Actor, to: 'pavo' | 'tokenkablo') {
  const prev = getSettings();
  if (prev.okcProvider === to) return;
  const fx = new Effects();
  tx((t) => {
    updateSettings({ okcProvider: to, okcMode: 'anlik' }, t);
    fx.audit(t, {
      userId: actor.user.id,
      action: 'okc.settings',
      severity: 'uyari',
      entity: 'settings',
      entityId: 'okc',
      message: `${actor.user.name} yazarkasa ayarını değiştirdi (kurulum): sağlayıcı ${prev.okcProvider} → ${to}`,
      data: { from: { provider: prev.okcProvider, mode: prev.okcMode }, to: { provider: to, mode: 'anlik' } },
    });
    fx.emit({ topic: 'settings', kind: 'settings.updated', byUserId: actor.user.id });
  });
  fx.flush();
  syncTokenKablo();
}
