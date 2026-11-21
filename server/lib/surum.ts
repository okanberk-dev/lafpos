import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env, ROOT } from '../env';

/**
 * Kurulu sürüm ve otomatik güncellemenin durumu (Windows kurulumu). Kurulumun app\package.json'ı derleme numarasını
 * taşır (scripts/kasa/windows/kurulum/paket.mjs); git ile çalışan sunucuda yalnız sürüm vardır. Güncelleyici
 * (bekçi, guncelle.mjs) durumunu veri klasöründeki guncelleme/durum.json'a yazar; sunucu yalnız okur.
 */
export interface Installed {
  version: string;
  /** HEAD commit'inin unix zamanı (sn); git ile çalışan sunucuda yok */
  build: number | null;
}

let installed: Installed | null = null;

export function installedVersion(): Installed {
  if (installed) return installed;
  try {
    const p = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version?: unknown; build?: unknown };
    installed = { version: typeof p.version === 'string' ? p.version : '', build: Number.isInteger(p.build) ? (p.build as number) : null };
  } catch {
    // Tarayıcı demosunda disk yok
    installed = { version: '', build: null };
  }
  return installed;
}

const UPDATE_STATES = ['guncel', 'indiriliyor', 'bekliyor', 'kuruluyor', 'geri-dondu', 'hata', 'kapali'] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

export interface UpdateStatus {
  durum: UpdateState;
  mesaj: string;
  yeni: { surum: string; build: number } | null;
  sonKontrol: string | null;
  sonBasariliKontrol: string | null;
  sonHata: { mesaj: string; at: string } | null;
  sonKurulum: string | null;
  guncellendi: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** durum.json (bozuk ya da yoksa null): yalnız ekranın gösterdiği alanlar, beklenmeyen değer düşer */
export function readUpdateStatus(dataDir = env.dataDir): UpdateStatus | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(resolve(dataDir, 'guncelleme', 'durum.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || !UPDATE_STATES.includes(raw.durum as UpdateState)) return null;
  const yeni = raw.yeni as { surum?: unknown; build?: unknown } | null;
  const hata = raw.sonHata as { mesaj?: unknown; at?: unknown } | null;
  return {
    durum: raw.durum as UpdateState,
    mesaj: (str(raw.mesaj) ?? '').slice(0, 400),
    yeni: yeni && typeof yeni.surum === 'string' && Number.isInteger(yeni.build) ? { surum: yeni.surum, build: yeni.build as number } : null,
    sonKontrol: str(raw.sonKontrol),
    sonBasariliKontrol: str(raw.sonBasariliKontrol),
    sonHata: hata && typeof hata.mesaj === 'string' ? { mesaj: hata.mesaj.slice(0, 400), at: str(hata.at) ?? '' } : null,
    sonKurulum: str(raw.sonKurulum),
    guncellendi: str(raw.guncellendi),
  };
}

/** Bağlantının bu bilgisayardan mı geldiği (güncelleyicinin sorusu yalnız buradan yanıtlanır) */
export function isLoopback(addr: string | undefined | null): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
