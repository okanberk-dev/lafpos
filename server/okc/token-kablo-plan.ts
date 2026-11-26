import type { AllSettings } from '../lib/settings';
import { tokenMealMap } from '@shared/yemek-karti';
import { autoSectionMap } from './basket';
import type { TokenxSection } from './tokenx';

/**
 * Token kablolunun saf kararları (testli; veritabanı ve ortam yüklemez): köprü çalışmalı mı, kablo takılınca ne
 * değişir. Uygulayan `token-kablo-servis.ts`.
 */

export type KabloSettings = Pick<AllSettings, 'okcProvider' | 'okcTokenKabloOto' | 'okcSectionMap' | 'okcOperatorMethods'>;
type Settings = KabloSettings;

/** Bu kurulumda köprü çalışmalı mı: seçili bağlantı Token kablolu ya da kablo takılınca kendiliğinden geçilecek */
export function kabloWantedFor(s: Settings, supported: boolean): boolean {
  if (!supported) return false;
  return s.okcProvider === 'tokenkablo' || (s.okcTokenKabloOto && (s.okcProvider === 'kapali' || s.okcProvider === 'simulator'));
}

/**
 * Kablo takılınca yapılacaklar (saf). Bağlantı: Kapalı'dan her zaman, eğitim cihazından gün açık değilken Token
 * kabloluya geçer (açık eğitim gününe gerçek fiş karışmaz); Pavo ya da Token bulut seçiliyse dokunulmaz. KDV → kısım:
 * cihazda olmayan ya da oranı tutmayan kısım cihazdakiyle değişir. Yemek kartı: kanalı bilinen türler cihazdaki
 * uygulamalarına eşlenir, elle eşleme korunur
 */
export function kabloPlan(
  s: Settings,
  device: { sections: TokenxSection[]; paymentApps: number[] },
  methods: { id: string; name: string; kind: string; channel: string | null; active: boolean }[],
  dayOpen: boolean,
  /** Patron "Kurulumu yap"a bastı: bağlantı her durumda Token kabloluya geçer (yönetimden elle seçmekle aynı) */
  force = false,
): { provider: 'tokenkablo' | null; sectionMap: Record<string, number> | null; operatorMethods: Record<string, string> | null; held: string | null } {
  let provider: 'tokenkablo' | null = null;
  let held: string | null = null;
  if (s.okcProvider !== 'tokenkablo') {
    if (force) provider = 'tokenkablo';
    else if (!s.okcTokenKabloOto) held = 'Kendiliğinden geçiş kapalı: Yönetim › Yazarkasa POS › Kurulumu yap';
    else if (s.okcProvider === 'kapali') provider = 'tokenkablo';
    else if (s.okcProvider === 'simulator') {
      if (dayOpen) held = 'Eğitim günü açık: gün kapanınca kablo yeniden takılınca ya da “Kurulumu yap” ile Token kabloluya geçer';
      else provider = 'tokenkablo';
    } else held = `Bağlantı ${s.okcProvider === 'pavo' ? 'Pavo' : 'Token bulut'}; değiştirmek için Yönetim › Yazarkasa POS`;
  }
  if (s.okcProvider !== 'tokenkablo' && !provider) return { provider: null, sectionMap: null, operatorMethods: null, held };
  let sectionMap: Record<string, number> | null = null;
  if (device.sections.length) {
    const auto = autoSectionMap(device.sections);
    const next: Record<string, number> = {};
    for (const [rate, no] of Object.entries(s.okcSectionMap)) {
      const sec = device.sections.find((x) => x.sectionNo === no);
      if (sec && Math.round(sec.taxPercent / 100) === Number(rate)) next[rate] = no;
    }
    for (const [rate, no] of Object.entries(auto)) if (!(rate in next)) next[rate] = no;
    if (JSON.stringify(next) !== JSON.stringify(s.okcSectionMap)) sectionMap = next;
  }
  const meal = tokenMealMap(s.okcOperatorMethods, methods, device.paymentApps);
  return { provider, sectionMap, operatorMethods: JSON.stringify(meal) !== JSON.stringify(s.okcOperatorMethods) ? meal : null, held };
}

