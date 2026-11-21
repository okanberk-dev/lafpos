import { Building2, Download } from 'lucide-react';
import type { NavItem } from './nav';

/**
 * Siteden kurulum (LafPOS Uzaktan › İndir, yalnız girişten sonra görünür). Web kurucusu kanal derlemesinin yanında
 * herkese açıktır (gizli bir şey taşımaz; scripts/kasa/windows/kurulum/web-kurucu.mjs), bağlantısı yalnız oturumda.
 */
export const DOWNLOAD_PATH = '/indir';
export const WEB_INSTALLER_NAME = 'LafPOS-Kur.cmd';
export const WEB_INSTALLER_PATH = `/guncelleme/${WEB_INSTALLER_NAME}`;
/** Tam kurulum dosyası: özel depo, GitHub hesabıyla */
export const RELEASES_URL = 'https://github.com/okanberk-dev/lafpos/releases/latest';

/** Uzaktan menüsünün son öğesi; yetki istemez (oturum yeter) */
export const DOWNLOAD_NAV: NavItem = {
  to: DOWNLOAD_PATH,
  label: 'İndir',
  title: 'Programı indir',
  icon: Download,
  perms: [],
  keywords: 'kurulum windows program indir kur',
};

/** Merkez (dükkânlar, lisans, güncelleme gönderme): yalnız Uzaktan'da, oturumla; panel uçları gerçek girişi ister */
export const MERKEZ_PATH = '/merkez';
export const MERKEZ_NAV: NavItem = {
  to: MERKEZ_PATH,
  label: 'Merkez',
  title: 'Merkez: dükkânlar ve lisans',
  icon: Building2,
  perms: [],
  keywords: 'merkez dükkan şube lisans güncelleme gönder',
};

/** Güncelleme kanalının manifesti (kanal.mjs): yalnız sayfanın yazdığı alanlar */
export interface ChannelManifest {
  version: string;
  build: number;
  date: string;
}

export const channelVersionQuery = {
  queryKey: ['indir', 'surum'],
  queryFn: async (): Promise<ChannelManifest> => {
    const res = await fetch('/guncelleme/surum.json');
    if (!res.ok) throw new Error(`surum.json ${res.status}`);
    return (await res.json()) as ChannelManifest;
  },
  staleTime: 5 * 60_000,
};
