import { maskOdenmezPeople } from '@shared/comp';
import type { ZSummary } from '@shared/types';
import { type AuthUser, can, seesCashNumbers, seesStaffOf } from './auth';

/**
 * Z (ve X) özetinin kişiye göre hâli: kasa uçları (`routes/cash.ts`) ve fiş yazıcısının gün sonu kâğıdı
 * (`okc/service.ts` `takeEodSlip`) aynı süzgeçten geçer.
 */

/**
 * Personel tutarları (kişi başına adisyon sayısı ve ciro) maliyet yetkisi ister, personel raporu gibi: kör kasası
 * kaldırılan kasiyer (`kasa.rakam`) ya da rapor gören (`rapor.gor`) kişi X ve Z özetinde onları görmez (denetim,
 * 26 Eki 2026). Kural yalnız bu özet için değil, verinin kendisi için: kapanmış adisyonun garsonu da aynı kişiye
 * gitmez (`seesStaffOf`: adisyon uçları `blindOrder`, adisyon raporu ve CSV dökümü).
 */
export function summaryFor(user: AuthUser, s: ZSummary | null): ZSummary | null {
  if (!s || can(user, 'rapor.maliyet')) return s;
  // Personelin adına yazılan ödenmez de personel tutarıdır: kendisininki dışındakiler tek "Personel" satırında
  return { ...s, byUser: [], ...(s.odenmezPeople ? { odenmezPeople: maskOdenmezPeople(s.odenmezPeople, (id) => seesStaffOf(user, id)) } : {}) };
}

/**
 * Kör kasa (`kasa.rakam` ya da `rapor.gor` yok): Z özeti hiç gitmez (beklenen nakit, sayılan, kasa farkı, ödeme
 * dökümü); görene personel tutarları `summaryFor` ile süzülür. Gün sonunu kör kasiyer kapatınca kasa ekranının
 * istediği gün sonu kâğıdı Z'yi ham gönderiyordu (inceleme, 23 Kas 2026)
 */
export function zSummaryFor(user: AuthUser, s: ZSummary | null): ZSummary | null {
  return seesCashNumbers(user) ? summaryFor(user, s) : null;
}
