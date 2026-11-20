import { createContext } from 'react';

/**
 * Kabuğun üst çubuğunun ortası (pano, 20 Kasım 2026): tablette ve bilgisayarda ekranın sekmeleri (Masalar'ın bölümleri,
 * Siparişler'in görünümleri, Kasa'nın günleri) buraya taşınır (Stage, portal). Telefonda ve kabuksuz ekranda null:
 * sekmeler sahnenin başında yatay hap şeridi olarak kalır
 */
export const TopTabsSlot = createContext<HTMLElement | null>(null);
