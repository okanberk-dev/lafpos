import type { AuthUser } from '../lib/auth';

/**
 * Platform komisyon oranı maliyettir (AGENTS kural 3): yalnız maliyeti gören (`rapor.maliyet`) ya da ayarı yöneten
 * (Yönetim › Paket platformları: `ayar.yonet`, `senkron.yonet`) görür. Garson, raporcu ve yalnız patron paneli
 * yetkilisi görmez (oranı ciroyla çarpıp komisyonu bulmasın).
 */
export function seesCommission(user: Pick<AuthUser, 'permissions'>): boolean {
  return user.permissions.has('rapor.maliyet') || user.permissions.has('ayar.yonet') || user.permissions.has('senkron.yonet');
}

/**
 * Denetim kaydı satırı oranı görmeyene (`seesCommission` değil): platform ayarı kaydının `data`'sı (oranın eskisi ve
 * yenisi) düşer, eski kayıtların iletisindeki "%N komisyon" parçası silinir (oran 28 Ekim 2026'ya dek iletide yazıyordu;
 * ileti uyarı olarak patron paneline de gider). Öteki kayıtlar aynen.
 */
export function auditForViewer<T extends { action: string; message: string; data?: unknown }>(row: T, sees: boolean): T {
  if (sees || row.action !== 'platform.settings') return row;
  return { ...row, message: row.message.replace(/, %\d+(?:[.,]\d+)? komisyon/g, ''), ...('data' in row ? { data: null } : {}) };
}
