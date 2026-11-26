import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KOPRU_PS1 } from './token-kablo-kopru';
import type { TokenxBasket, TokenxSale, TokenxSection } from './tokenx';

/**
 * Token kablolu bağlantı (TokenX Connect Wire / Integration Hub): Beko 300TR ve X30TR kasa bilgisayarına kabloyla
 * (300TR beşikteki RS232-USB, X30TR soldaki Type-C) bağlanır. Token'ın kütüphanesi yalnız Windows'ta çalışır; LafPOS
 * onu ayrı bir süreçte (PowerShell köprüsü, `token-kablo-kopru.ts`) yükler: kütüphane çökse de kasa sunucusu düşmez,
 * köprü kendiliğinden yeniden başlar. Kablo takılınca köprü cihazı bildirir, LafPOS kısımları ve ödeme uygulamalarını
 * okur (Token'a göre zorunlu), sepeti gönderir; sonuç cihazdan geri çağrıyla gelir. Durum sorgusu yoktur: kablo
 * koptuysa cihaz, bağlantı geri gelince sonucu yeniden yollar. Ayrıntı: docs/04-YAZARKASA.md §9.
 */

/**
 * Köprünün klasörü (betik, Token kütüphanesi): kasada C:\ProgramData\LafPOS\token-kablo. Veri klasörü servis bağlar
 * (`useKabloDir`); bu modül ortamı yüklemez (sağlayıcı listesi testlerde ortam ayarlanmadan yüklenir)
 */
let kabloDir: () => string = () => resolve(process.env.LAFPOS_DATA_DIR ?? 'data', 'token-kablo');
export const TOKEN_KABLO_DIR = () => kabloDir();
export function useKabloDir(fn: () => string) {
  kabloDir = fn;
}

/**
 * Token'ın C# kütüphanesi (IntegrationHub.dll v2.5.5, açık örnek projesinden, sabit commit ve SHA-256 ile). Kurulumda
 * bir kez indirilir; dosya elle konduysa ve özeti tutuyorsa indirilmez
 */
export const HUB_DLL = {
  name: 'IntegrationHub.dll',
  url: 'https://raw.githubusercontent.com/TokenPublication/hizlisepet-clienttemplate/38d19911236cde75ab0760843eda373ab7692292/TokenDotNet/bin/Release/IntegrationHub.dll',
  sha256: '6aea621f422f10f0436963651099bd22ff161b685b2e3bd1e67a191a09188d8e',
  size: 8_162_304,
} as const;

/** Token cihazının modeli (`getActiveDeviceIndex`): 0 X30TR, 1 300TR */
export type TokenModel = 'X30TR' | '300TR';

export type KabloPhase = 'kapali' | 'desteklenmiyor' | 'kurulum' | 'baslatiliyor' | 'bekliyor' | 'baglaniyor' | 'bagli' | 'hata';

export interface KabloState {
  phase: KabloPhase;
  /** Kullanıcıya bir cümle: ne bekleniyor, ne eksik */
  message: string | null;
  /** Cihazın mali no'su (X30TR AV…, 300TR AT…) */
  fiscalId: string | null;
  model: TokenModel | null;
  sections: TokenxSection[];
  /** Cihazda yüklü ödeme uygulamaları (banka ve yemek kartı operatör no'ları) */
  paymentApps: number[];
  connectedAt: number | null;
}

/** Köprünün bir satırı (JSON); tanınmayan satır `null` */
export type BridgeLine =
  | { t: 'ready' }
  | { t: 'device'; connected: boolean; id: string | null }
  | { t: 'serial'; type: number; value: string | null }
  | { t: 'res'; id: string; ok: boolean; value?: string | null; message?: string }
  | { t: 'fatal'; message: string };

export function parseBridgeLine(line: string): BridgeLine | null {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  switch (o.t) {
    case 'ready':
      return { t: 'ready' };
    case 'device':
      return { t: 'device', connected: o.connected === true, id: str(o.id)?.trim() || null };
    case 'serial':
      return typeof o.type === 'number' ? { t: 'serial', type: o.type, value: str(o.value) } : null;
    case 'res':
      return typeof o.id === 'string' ? { t: 'res', id: o.id, ok: o.ok === true, value: str(o.value), message: str(o.message) ?? undefined } : null;
    case 'fatal':
      return { t: 'fatal', message: str(o.message) ?? 'Token kütüphanesi yüklenemedi' };
    default:
      return null;
  }
}

/** Komut satırı: `kimlik<TAB>komut<TAB>base64(UTF-8 gövde)` */
export function commandLine(id: string, cmd: string, body?: string | null): string {
  return `${id}\t${cmd}\t${body == null ? '' : Buffer.from(body, 'utf8').toString('base64')}\n`;
}

/** `getFiscalInfo` yanıtı: kısımlar ve ödeme uygulamaları (biçim Token belgesindeki "Fiscal Bilgisi JSON'ı") */
export function parseFiscalInfo(json: string | null | undefined): { sections: TokenxSection[]; paymentApps: number[] } | null {
  if (!json?.trim()) return null;
  let o: Record<string, unknown> | null;
  try {
    o = JSON.parse(json) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const sections: TokenxSection[] = [];
  for (const raw of Array.isArray(o.sections) ? o.sections : []) {
    const x = raw as Record<string, unknown>;
    const sectionNo = Number(x.sectionNo);
    const taxPercent = Number(x.taxPercent);
    if (!Number.isInteger(sectionNo) || !Number.isFinite(taxPercent)) continue;
    sections.push({ sectionNo, taxPercent, name: typeof x.name === 'string' ? x.name.trim().slice(0, 40) : `Kısım ${sectionNo}` });
  }
  const paymentApps = (Array.isArray(o.paymentAppInfo) ? o.paymentAppInfo : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
  return { sections, paymentApps };
}

/**
 * LafPOS sepetini kablolu protokolün sepetine çevirir: biçim bulutla aynı (kuruş, adet x1000, KDV x100, kısım no),
 * bulutun liste alanları (masa adı, filtre, çek no, webhook) gitmez
 */
export function wireBasket(b: TokenxBasket): Record<string, unknown> {
  return {
    basketID: b.basketID,
    documentType: b.documentType ?? 0,
    createInvoice: false,
    isVoid: false,
    items: b.items.map((it) => ({
      name: it.name,
      price: it.price,
      sectionNo: it.sectionNo,
      taxPercent: it.taxPercent,
      quantity: it.quantity,
      unit: it.unit ?? 'Adet',
      ...(it.adjust ? { adjust: it.adjust } : {}),
    })),
    paymentItems: (b.paymentItems ?? []).map((p) => ({ amount: p.amount, type: p.type, ...(p.operatorId != null ? { operatorId: p.operatorId } : {}) })),
    ...(b.adjust ? { adjust: b.adjust } : {}),
    ...(b.note ? { note: b.note } : {}),
  };
}

export class KabloError extends Error {
  constructor(
    message: string,
    /** Sepet cihaza ulaşmış olabilir (yanıt gelmedi): bekleyen kalır */
    readonly uncertain = false,
  ) {
    super(message);
    this.name = 'KabloError';
  }
}

/** Köprü süreci (testte sahtesi verilir) */
export interface BridgeProcess {
  stdin: { write(s: string): unknown } | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(ev: 'exit', fn: (code: number | null) => void): unknown;
  on(ev: 'error', fn: (e: Error) => void): unknown;
  kill(): unknown;
}
export type Spawner = (script: string, dll: string, cwd: string) => BridgeProcess;

/** 32 bit Windows PowerShell (64 bit Windows'ta SysWOW64'te; 32 bit Windows'ta System32'de) */
export function powershell32(): string {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const wow = join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(wow) ? wow : join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const realSpawn: Spawner = (script, dll, cwd) =>
  spawn(powershell32(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Dll', dll, '-Firma', 'LafPOS'], {
    cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcess as unknown as BridgeProcess;

/** Visual C++ çalışma kitaplığı (x86): Token'ın yerel kütüphanesi ister */
export function vcRuntimeX86(): boolean {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const dir = existsSync(join(root, 'SysWOW64')) ? join(root, 'SysWOW64') : join(root, 'System32');
  return existsSync(join(dir, 'vcruntime140.dll')) && existsSync(join(dir, 'msvcp140.dll'));
}

export const dllPath = () => join(TOKEN_KABLO_DIR(), HUB_DLL.name);

/** Yeniden başlatma aralıkları (köprü düşerse): 3 sn, 10 sn, 30 sn, sonra dakikada bir */
const BACKOFF_MS = [3_000, 10_000, 30_000, 60_000];

/**
 * Olaylar: `connected` (KabloState; cihaz bağlandı ve kısımları okundu), `disconnected`, `sale` (TokenxSale; Token'ın 3
 * tipli paketi), `rejected` (9: cihaz sepeti işleyemedi, satış ekranında değil), `state` (KabloState)
 */

export interface KabloOptions {
  spawner?: Spawner;
  /** Ön koşullar: Windows, DLL, Visual C++ (testte hep var) */
  ready?: () => { ok: true } | { ok: false; phase: KabloPhase; message: string };
  dir?: string;
  script?: string;
  supported?: boolean;
  /** Sepetten sonra cihazın "işlenemedi" (9) paketini bekleme süresi */
  rejectWaitMs?: number;
}

/**
 * Köprü yöneticisi: süreci başlatır, satırları okur, komutları sıraya koyar, cihaz durumunu tutar. Tek örnek
 * (`kablo`); testler kendi örneğini sahte süreçle kurar.
 */
export class TokenKablo extends EventEmitter {
  state: KabloState = { phase: 'kapali', message: null, fiscalId: null, model: null, sections: [], paymentApps: [], connectedAt: null };
  private proc: BridgeProcess | null = null;
  private buf = '';
  private seq = 0;
  private waiting = new Map<string, { resolve: (v: string | null) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private restartTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private wanted = false;
  private lastStderr = '';
  /** Son satış sonuçları (sepet kimliğiyle): sorgu döngüsü buradan okur */
  readonly sales = new Map<string, TokenxSale>();
  /** Cihazın "sepet işlenemedi" (9) dediği an */
  rejectedAt = 0;

  constructor(private opts: KabloOptions = {}) {
    super();
  }

  /** Bu bilgisayarda çalışabilir mi (Windows; testte sahte süreçle her yerde) */
  get supported(): boolean {
    return this.opts.supported ?? process.platform === 'win32';
  }

  /** Testler sahte süreç ve ön koşul verir (kasada kullanılmaz) */
  configure(opts: KabloOptions) {
    this.opts = { ...this.opts, ...opts };
  }

  private set(patch: Partial<KabloState>) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  get running(): boolean {
    return !!this.proc;
  }

  get connected(): boolean {
    return this.state.phase === 'bagli';
  }

  /** Ön koşullar tamamsa köprüyü başlatır (açıksa bir şey yapmaz) */
  start(): KabloState {
    this.wanted = true;
    if (this.proc) return this.state;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const pre = (this.opts.ready ?? defaultReady)();
    if (!pre.ok) {
      this.set({ phase: pre.phase, message: pre.message });
      return this.state;
    }
    const dir = this.opts.dir ?? TOKEN_KABLO_DIR();
    mkdirSync(dir, { recursive: true });
    const script = this.opts.script ?? join(dir, 'kopru.ps1');
    // Betik her açılışta sürümün kendi metniyle yazılır (eski sürümden kalan betik çalışmaz)
    if (!this.opts.script && (!existsSync(script) || readFileSync(script, 'utf8') !== KOPRU_PS1)) writeFileSync(script, KOPRU_PS1, 'utf8');
    this.set({ phase: 'baslatiliyor', message: 'Token kütüphanesi yükleniyor', fiscalId: null, model: null, connectedAt: null });
    let p: BridgeProcess;
    try {
      p = (this.opts.spawner ?? realSpawn)(script, join(dir, HUB_DLL.name), dir);
    } catch (e) {
      this.set({ phase: 'hata', message: `Köprü başlatılamadı: ${e instanceof Error ? e.message : String(e)}` });
      this.scheduleRestart();
      return this.state;
    }
    this.proc = p;
    this.buf = '';
    p.stdout?.setEncoding?.('utf8');
    p.stdout?.on('data', (chunk: string | Buffer) => this.onData(String(chunk)));
    p.stderr?.on('data', (chunk: string | Buffer) => {
      const s = String(chunk).trim();
      if (s) this.lastStderr = s.split(/\r?\n/).filter(Boolean).at(-1)!.slice(0, 300);
    });
    p.on('error', (e) => this.onExit(null, e.message));
    p.on('exit', (code) => this.onExit(code));
    return this.state;
  }

  /** Köprüyü durdurur (bağlantı başka sağlayıcıya geçti) */
  stop() {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const p = this.proc;
    if (!p) {
      this.set({ phase: 'kapali', message: null, fiscalId: null, model: null, connectedAt: null });
      return;
    }
    try {
      p.stdin?.write(commandLine('quit', 'quit'));
    } catch {
      // süreç zaten kapanıyor
    }
    setTimeout(() => {
      if (this.proc === p) p.kill();
    }, 2_000).unref?.();
  }

  /** Köprüyü yeniden başlatır (kurulumdan sonra, sürücü kurulunca) */
  restart() {
    const p = this.proc;
    this.failures = 0;
    if (!p) return this.start();
    this.wanted = true;
    p.kill();
    return this.state;
  }

  private onExit(code: number | null, error?: string) {
    if (!this.proc) return;
    this.proc = null;
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new KabloError('Token köprüsü kapandı', true));
    }
    this.waiting.clear();
    const was = this.state.phase;
    if (was === 'bagli') this.emit('disconnected');
    if (!this.wanted) {
      // Kütüphane yüklenemediyse (kurulum eksik) neden ekranda kalır; kurulum köprüyü yeniden başlatır
      if (this.state.phase !== 'kurulum') this.set({ phase: 'kapali', message: null, fiscalId: null, model: null, connectedAt: null });
      return;
    }
    if (was !== 'kurulum' || !this.state.message) {
      const why = error ?? this.lastStderr ?? '';
      this.set({ phase: 'hata', message: `Token köprüsü kapandı${code != null ? ` (kod ${code})` : ''}${why ? `: ${why}` : ''}`, fiscalId: null, model: null, connectedAt: null });
    }
    this.scheduleRestart();
  }

  private scheduleRestart() {
    if (!this.wanted || this.restartTimer) return;
    const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!;
    this.failures++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted && !this.proc) this.start();
    }, wait);
    this.restartTimer.unref?.();
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      const msg = parseBridgeLine(line);
      if (msg) this.onLine(msg);
      else if (line.trim()) console.log(`[token-kablo] ${line.trim().slice(0, 300)}`);
    }
  }

  private onLine(m: BridgeLine) {
    switch (m.t) {
      case 'ready':
        this.failures = 0;
        if (this.state.phase === 'baslatiliyor') this.set({ phase: 'bekliyor', message: 'Kablo bekleniyor: cihazı kasa bilgisayarına takın' });
        return;
      case 'fatal':
        // Yeniden denemek düzeltmez (eksik kitaplık, bozuk DLL): kurulum yapılınca köprü yeniden başlar
        this.wanted = false;
        this.set({ phase: 'kurulum', message: `Token kütüphanesi çalışmadı (${m.message}). Yönetim › Yazarkasa POS › Kurulumu yap` });
        return;
      case 'device':
        if (m.connected) void this.onConnected(m.id);
        else {
          const was = this.state.phase === 'bagli';
          this.set({ phase: 'bekliyor', message: 'Cihazın kablosu çıktı: yeniden takın', fiscalId: null, model: null, connectedAt: null });
          if (was) this.emit('disconnected');
        }
        return;
      case 'serial':
        this.onSerial(m.type, m.value);
        return;
      case 'res': {
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        clearTimeout(w.timer);
        if (m.ok) w.resolve(m.value ?? null);
        else w.reject(new KabloError(m.message || 'Token kütüphanesi hata verdi'));
        return;
      }
    }
  }

  private onSerial(type: number, value: string | null) {
    if (type === 3 && value) {
      try {
        const sale = JSON.parse(value) as TokenxSale;
        if (sale && typeof sale.basketID === 'string') {
          this.sales.set(sale.basketID, sale);
          // Eski sonuçlar birikmez (sonuç zaten adisyona işlenir; bu yalnız sorgu için)
          while (this.sales.size > 100) this.sales.delete(this.sales.keys().next().value!);
          this.emit('sale', sale);
        }
      } catch {
        console.error('[token-kablo] satış sonucu okunamadı', value.slice(0, 300));
      }
      return;
    }
    if (type === 9) {
      this.rejectedAt = Date.now();
      this.emit('rejected');
    }
  }

  /** Kablo takıldı: kısımlar ve ödeme uygulamaları okunur (Token: zorunlu), sonra model */
  private async onConnected(id: string | null) {
    this.set({ phase: 'baglaniyor', message: 'Cihaz bağlandı, kısımlar okunuyor', fiscalId: id });
    let info: ReturnType<typeof parseFiscalInfo> = null;
    for (let i = 0; i < 3 && !info; i++) {
      if (i) await new Promise((r) => setTimeout(r, 2_000));
      if (this.state.phase !== 'baglaniyor') return;
      info = parseFiscalInfo(await this.call('fiscal', null, 20_000).catch(() => null));
    }
    if (this.state.phase !== 'baglaniyor') return;
    if (!info) {
      this.set({ phase: 'hata', message: 'Cihaz bağlandı ama kısımları okunamadı: cihazı satış ekranına alıp kabloyu çıkarıp takın' });
      return;
    }
    const index = await this.call('index', null, 10_000).catch(() => null);
    const model: TokenModel | null = index === '0' ? 'X30TR' : index === '1' ? '300TR' : id?.startsWith('AV') ? 'X30TR' : id?.startsWith('AT') ? '300TR' : null;
    this.set({ phase: 'bagli', message: null, model, sections: info.sections, paymentApps: info.paymentApps, connectedAt: Date.now() });
    this.emit('connected', this.state);
  }

  /** Köprüye komut; yanıt gelmezse `timeoutMs` sonra belirsiz hata */
  call(cmd: string, body: string | null, timeoutMs = 15_000): Promise<string | null> {
    const p = this.proc;
    if (!p?.stdin) return Promise.reject(new KabloError('Token köprüsü çalışmıyor'));
    const id = `k${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new KabloError('Cihazdan yanıt alınamadı', true));
      }, timeoutMs);
      timer.unref?.();
      this.waiting.set(id, { resolve, reject, timer });
      try {
        p.stdin!.write(commandLine(id, cmd, body));
      } catch (e) {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(new KabloError(`Token köprüsüne yazılamadı: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  /**
   * Sepeti cihaza yollar. Kütüphane 1 (gitti) ya da 0 (gitmedi) döner; cihaz satış ekranında değilse ardından 9 tipli
   * paket gelir: kısa süre beklenir, gelirse sepet cihazda yok sayılır
   */
  async sendBasket(basket: TokenxBasket, waitRejectMs = this.opts.rejectWaitMs ?? 2_500): Promise<void> {
    if (!this.connected) throw new KabloError(notConnectedMessage(this.state));
    const sentAt = Date.now();
    const out = await this.call('basket', JSON.stringify(wireBasket(basket)), 20_000);
    if (out !== '1') throw new KabloError(`Cihaz sepeti almadı. ${SALE_SCREEN_HINT}`);
    if (waitRejectMs > 0) {
      await new Promise<void>((done) => {
        const t = setTimeout(() => {
          this.off('rejected', on);
          done();
        }, waitRejectMs);
        const on = () => {
          clearTimeout(t);
          this.off('rejected', on);
          done();
        };
        this.on('rejected', on);
      });
    }
    if (this.rejectedAt >= sentAt) throw new KabloError(`Cihaz sepeti işleyemedi. ${SALE_SCREEN_HINT}`);
  }
}

export const SALE_SCREEN_HINT = '300TR satış ekranında olmalı; X30TR’de “TokenX Connect Uygulaması (Kablolu)” açık olmalı';

export function notConnectedMessage(s: KabloState): string {
  if (s.phase === 'desteklenmiyor' || s.phase === 'kurulum' || s.phase === 'hata') return s.message ?? 'Token cihazı bağlı değil';
  return `Token cihazı kabloyla bağlı değil. Kabloyu kasa bilgisayarına takın; ${SALE_SCREEN_HINT}`;
}

/** Gerçek ön koşullar: Windows, Token kütüphanesi indirilmiş, Visual C++ (x86) kurulu */
function defaultReady(): { ok: true } | { ok: false; phase: KabloPhase; message: string } {
  if (process.platform !== 'win32') return { ok: false, phase: 'desteklenmiyor', message: 'Kablolu Token yalnız Windows kasa bilgisayarında çalışır' };
  if (!existsSync(dllPath())) return { ok: false, phase: 'kurulum', message: 'Token kütüphanesi kurulu değil: Yönetim › Yazarkasa POS › Kurulumu yap' };
  if (!vcRuntimeX86()) return { ok: false, phase: 'kurulum', message: 'Visual C++ çalışma kitaplığı (x86) kurulu değil: Yönetim › Yazarkasa POS › Kurulumu yap' };
  return { ok: true };
}

/** Kasa sunucusunun tek köprüsü */
export const kablo = new TokenKablo();
