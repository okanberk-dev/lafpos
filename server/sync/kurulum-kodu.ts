import { existsSync, readFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkConnValue, connField } from '@shared/baglanti';
import { env } from '../env';
import { settingsFile, writeEnvEdits } from '../lib/ayar-dosyasi';
import { Effects } from '../lib/effects';
import { getSettings, getSyncState, setSyncState, updateSettings } from '../lib/settings';
import { db } from '../db/client';
import { branchLocked } from './lafmaliyet';
import { subeDegisti } from './sube-degisti';
import { merkezKapaliUyarisi } from './merkez';
import { kasaSubesi, subeAdi } from '../lib/sube';
import { ESKI_KURULUM_YOLU } from '@shared/eski-adlar';
import { yeniAdlarla } from '@shared/pos-env';

/**
 * Şube kurulumu (ladmin › Ayarlar › Şubeler): ana yönetici şubeyi ekleyince şubeye özel kurucu (AsilPOS-Kur.cmd) üretilir,
 * içinde ladmin'in adresi ve tek kullanımlık kurulum kodu durur. Kurucu kodu veri klasörüne yazar (`kurulum-kodu.json`);
 * sunucu açılınca kodu ladmin'e bir kez verir (`POST {adres}/api/asilpos/kurulum`; eski panel 404 derse eski yol) ve karşılığında şubesini (kimlik, ad)
 * ve bağlantı bilgilerini (lafmaliyet, AsilPOS Uzaktan, site) alır: şube kimliği ayarlara, bağlantılar ayarlar dosyasına
 * yazılır, bekçi sunucuyu yeni ayarlarla yeniden başlatır. Kimse şube kimliği ya da anahtar yazmaz; kasa yanlış şubeyle
 * açılmaz. Sözleşme: docs/03-ENTEGRASYON.md "Şube kurulumu".
 */

export const KOD_DOSYASI = 'kurulum-kodu.json';
/** ladmin'in kurulum kodu ucu (ad değişikliğinden önceki panelde yalnız `ESKI_KURULUM_YOLU`) */
export const KURULUM_YOLU = '/api/asilpos/kurulum';
const STATE = 'kurulum.sube';

/** ladmin'in verebileceği bağlantı anahtarları (başkası yazılmaz). Uzaktan'ınkiler eski adla da gelir (`yeniAdlarla`) */
export const KURULUM_ANAHTARLARI = ['LAFMALIYET_URL', 'LAFMALIYET_SYNC_SECRET', 'ASILPOS_CLOUD_URL', 'ASILPOS_CLOUD_SECRET', 'LAFFOGATO_URL', 'LAFFOGATO_SYNC_SECRET'] as const;

const KOD_RE = /^[A-Za-z0-9_-]{24,128}$/;
const BRANCH_RE = /^[a-z][a-z0-9-]{1,23}$/;

export interface KurulumDurumu {
  /** Kod ladmin'e verildi ve şube kuruldu */
  ok: boolean;
  sube: { id: string; ad: string } | null;
  at: number;
  /** Kurulamadıysa neden (kalıcı: kod kullanılmış ya da süresi dolmuş; geçici: internet) */
  hata: string | null;
  /** Kalıcı hata: yeniden denenmez, ladmin'de yeni bağlantı üretilir */
  kalici?: boolean;
  /** Şube kimliği kilitliydi (lafmaliyet gün kabul etmişti) ve farklıydı: değişmedi */
  kilitli?: boolean;
}

export const kurulumDurumu = () => getSyncState<KurulumDurumu>(STATE);

/**
 * Yönetim › Bağlantı bilgileri'nin "Şube kurulumu" kartı: kasanın şubesi (yoksa null: şubeye bağlı senkron bekler),
 * veri klasöründe ladmin'e verilmeyi bekleyen kurulum kodu var mı, son denemenin sonucu ve hatası (kalıcıysa yeni bağlantı
 * gerekir; geçiciyse 5 dakikada bir yeniden denenir) ve Merkez kapalıyken ikinci şubenin uyarısı. Kod ve anahtar dönmez
 */
export function kurulumGorunumu(dataDir = env.dataDir) {
  const d = kurulumDurumu();
  return {
    sube: kasaSubesi(),
    subeAdi: subeAdi(),
    kodBekliyor: existsSync(resolve(dataDir, KOD_DOSYASI)),
    durum: d ? { ok: d.ok, sube: d.sube, at: d.at, hata: d.hata, kalici: !!d.kalici, kilitli: !!d.kilitli } : null,
    merkezUyarisi: merkezKapaliUyarisi(),
  };
}
export type KurulumGorunumu = ReturnType<typeof kurulumGorunumu>;

/** Kurulumdan gelen şubenin adı (Merkez kaydı ve fiş başlığı için); yoksa null */
export const kurulumSubeAdi = () => kurulumDurumu()?.sube?.ad ?? null;

/** Dosyadaki kod: `{ adres, kod }`; biçim bozuksa null */
export function readKodFile(text: string): { adres: string; kod: string } | null {
  let o: unknown;
  try {
    o = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const { adres, kod } = o as Record<string, unknown>;
  if (typeof adres !== 'string' || typeof kod !== 'string' || !KOD_RE.test(kod)) return null;
  let u: URL;
  try {
    u = new URL(adres);
  } catch {
    return null;
  }
  // Yalnız https (yerel denemede localhost); yol ve kullanıcı bilgisi yok
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if ((u.protocol !== 'https:' && !(local && u.protocol === 'http:')) || u.username || u.password) return null;
  return { adres: u.origin, kod };
}

/** ladmin'in yanıtı → şube ve yazılacak bağlantılar (tanınmayan ya da geçersiz alan düşer) */
export function readRedeemAnswer(json: unknown): { sube: { id: string; ad: string }; edits: Record<string, string> } | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const sube = o.sube as Record<string, unknown> | undefined;
  if (o.ok !== true || !sube || typeof sube.id !== 'string' || !BRANCH_RE.test(sube.id) || typeof sube.ad !== 'string' || !sube.ad.trim()) return null;
  const edits: Record<string, string> = {};
  const raw = yeniAdlarla((o.baglanti && typeof o.baglanti === 'object' ? o.baglanti : {}) as Record<string, unknown>);
  for (const key of KURULUM_ANAHTARLARI) {
    const v = raw[key];
    const field = connField(key);
    if (typeof v !== 'string' || !field) continue;
    const checked = checkConnValue(field, v);
    if ('value' in checked && checked.value) edits[key] = checked.value;
  }
  return { sube: { id: sube.id, ad: sube.ad.trim().slice(0, 60) }, edits };
}

let running = false;

/** Yanıt panelin kendi kurulum yanıtı mı (`{ ok: false, … }` JSON); bilinmeyen yolun 404 sayfası değil. Gövdeyi tüketmez */
async function panelYaniti(res: Response): Promise<boolean> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { ok?: unknown } | null;
  return body?.ok === false;
}

/**
 * Kodu ladmin'e verir (sunucu açılışında ve 5 dakikada bir, kod dosyası durdukça). Başarıda dosya `.kullanildi` olur;
 * kalıcı hatada (kod yok, kullanılmış, süresi dolmuş) da: yeniden denenmez, ekranda neden kalır
 */
export async function redeemInstallCode(opts: { dataDir?: string; fetchImpl?: typeof fetch; now?: number } = {}): Promise<KurulumDurumu | null> {
  const dir = opts.dataDir ?? env.dataDir;
  const file = resolve(dir, KOD_DOSYASI);
  if (running || !existsSync(file)) return null;
  running = true;
  const now = opts.now ?? Date.now();
  const retire = () => {
    try {
      renameSync(file, `${file}.kullanildi`);
    } catch {
      // dosya kalırsa bir sonraki denemede yine kalıcı hata alınır
    }
  };
  try {
    const code = readKodFile(readFileSync(file, 'utf8'));
    if (!code) {
      retire();
      return save({ ok: false, sube: null, at: now, hata: 'Kurulum kodu dosyası okunamadı; ladmin’den yeni indirme bağlantısı alın', kalici: true });
    }
    let res: Response;
    try {
      // Yeni yol; ad değişikliğinden önceki panel onu tanımaz (404, panelin kendi JSON yanıtı değil): eski yol yeniden
      // denenir. Panelin kendi 404'ü (`ok: false`: kod ya da şube yok) kalıcı yanıttır, yeniden denenmez: kod o anda
      // kullanılmış sayılmış olabilir, eski yol "kullanılmış" der ve asıl neden kaybolur
      const post = (yol: string) =>
        (opts.fetchImpl ?? fetch)(new URL(yol, code.adres), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kod: code.kod, surum: process.env.npm_package_version ?? null }),
          signal: AbortSignal.timeout(15_000),
        });
      res = await post(KURULUM_YOLU);
      if (res.status === 404 && !(await panelYaniti(res))) res = await post(ESKI_KURULUM_YOLU);
    } catch (e) {
      return save({ ok: false, sube: null, at: now, hata: `ladmin’e ulaşılamadı (${e instanceof Error ? e.message : String(e)}); internet gelince yeniden denenir` });
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 404 || res.status === 410) {
      retire();
      const why = typeof json?.error === 'string' ? json.error : 'Kurulum kodu geçersiz';
      return save({ ok: false, sube: null, at: now, hata: `${why}. ladmin › Şubeler’den yeni indirme bağlantısı alın`, kalici: true });
    }
    const answer = res.ok ? readRedeemAnswer(json) : null;
    if (!answer) return save({ ok: false, sube: null, at: now, hata: `ladmin yanıtı anlaşılmadı (HTTP ${res.status}); yeniden denenecek` });
    return apply(answer, now, retire);
  } finally {
    running = false;
  }
}

function save(d: KurulumDurumu): KurulumDurumu {
  setSyncState(STATE, d);
  return d;
}

/** Şube kimliği ve bağlantılar yazılır; şube kilitliyse (lafmaliyet gün kabul etti) ve farklıysa kimlik değişmez */
function apply(answer: { sube: { id: string; ad: string }; edits: Record<string, string> }, now: number, retire: () => void): KurulumDurumu {
  const before = getSettings().branchId;
  const locked = before !== answer.sube.id && branchLocked();
  const changed = !locked && before !== answer.sube.id;
  const fx = new Effects();
  if (changed) updateSettings({ branchId: answer.sube.id });
  const file = settingsFile();
  const written = file && Object.keys(answer.edits).length ? Object.keys(answer.edits) : [];
  if (file && written.length) writeEnvEdits(file, answer.edits);
  fx.audit(db, {
    action: 'settings.branchId',
    severity: locked ? 'alarm' : 'uyari',
    entity: 'settings',
    entityId: 'branchId',
    message: locked
      ? `ladmin kurulumu ${answer.sube.ad} (${answer.sube.id}) şubesini verdi ama şube kimliği kilitli (${before}); değişmedi`
      : `Kasa ladmin’den kuruldu: şube ${answer.sube.ad} (${answer.sube.id})${written.length ? `; bağlantılar: ${written.join(', ')}` : ''}`,
    data: { from: before, to: locked ? before : answer.sube.id, keys: written },
  });
  fx.emit({ topic: 'settings', kind: 'settings.updated' });
  fx.flush();
  retire();
  // Şube belli oldu ya da değişti: eski şubenin önbellekleri bırakılır, bekleyen günler ve yeni şubenin platform
  // anahtarları beklemeden (bağlantılar yeni yazıldıysa bekçi sunucuyu yeniden başlatır, açılış da çeker)
  if (changed) subeDegisti(before);
  return save({ ok: !locked, sube: answer.sube, at: now, hata: locked ? `Şube kimliği kilitli (${before}); ${answer.sube.id} yapılmadı` : null, ...(locked ? { kilitli: true, kalici: true } : {}) });
}
