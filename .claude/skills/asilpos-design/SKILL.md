---
name: asilpos-design
description: AsilPOS tasarım sistemi (Keel dili) kontrol listesi. Bir ekran, kart, form, tablo, grafik ya da telefon görünümü eklerken ve değiştirirken kullan; "tasarım", "kart", "arayüz", "panel", "mobil", "koyu tema" işlerinde önce bunu oku.
---

# AsilPOS tasarım kontrol listesi (Keel dili)

> **Kaynak:** bu repoda yazıldı (22 Kasım 2026, sahibin isteği); görsel dil Behance "Keel: Fintech SaaS Dashboard"
> incelemesinden. Bu projede tek doğru kaynak `DESIGN.md` §0 ve `src/styles/keel.css`'tir.

Her arayüz değişikliği bu listeye uyar. Uymayan bir ihtiyaç çıkarsa
önce `DESIGN.md` §0 ve `src/styles/keel.css` güncellenir, sonra bileşen yazılır.

## Önce
1. `DESIGN.md` §0'ı ve dokunacağın bölümü oku; benzer bir bileşen var mı bak (`src/components/ui`, `src/components/admin/ui.tsx`, `src/pages/patron/TodayStats.tsx`).
2. Sabit renk, köşe, gölge yazma: `--k-*` belirteci ya da onu kullanan Tailwind adı (`bg-surface`, `text-ink`, `text-muted`, `rounded-[var(--r-card)]`).

## Kontrol listesi
- [ ] **Hiyerarşi:** ekranda tek kahraman rakam; etiket 13 px soluk, rakam iri ve 500-600 ağırlık, kuruş soluk.
- [ ] **Kart:** beyaz, kenarsız, gölgesiz, köşe 18 (gecede 20); zeminden ton farkıyla ayrılır. Kart içinde kart yerine kuyu (karo, köşe 14).
- [ ] **Seçili durum:** sekme, segment ve alt menüde mürekkep dolgu + beyaz yazı (`--k-select`). Ana eylem ev yeşili; ekranda tek ana eylem.
- [ ] **Renk yalnız anlam:** artış nane, düşüş kırmızı, uyarı kehribar, bilgi mavi; hepsi yumuşak zeminli hap. Renk tek başına bilgi taşımaz (ok, işaret, yazı).
- [ ] **Grafik:** ızgarasız ya da çok soluk; gri bağlam çubukları, vurgulu aralık nane; değer hapı; eksen etiketi 12 px soluk.
- [ ] **Form:** etiket üstte, alan 44 px, köşe 12, hata alanın altında ve `aria-live`.
- [ ] **Tablo/liste:** satır en az 52 px, ayraç ince, sayılar sağa hizalı ve `tabular`; telefonda satır kartına döner.
- [ ] **Boş durum:** tek cümle + ne yapılacağı; sıfır gibi gösterme ("veri yok", "satış yok").
- [ ] **Uyarı:** yumuşak zemin + ikon + kısa metin; ekranda en çok bir kalıcı uyarı şeridi.
- [ ] **Telefon (390 px):** tek sütun, yatay kaydırma yok, dokunma hedefi ≥ 44 px, alt dok ve alttan açılan pencere; rakamlar büyük.
- [ ] **Her ekran boyu:** 320 px telefondan alçak kasa bilgisayarına (1093 × 614) düğme tam görünür: uzun etiket `wrap` ile alt satıra iner, sabit enli karoda kısalan ad `title` taşır, içerik karta sığmazsa kesilmez sadeleşir (masa kartı: `tile-*`).
- [ ] **Koyu tema:** aynı belirteç adlarıyla; kontrast metin ≥ 4.5:1, arayüz öğesi ≥ 3:1.
- [ ] **Kasa hızı:** satış akışına ek dokunuş, animasyon beklemesi ya da küçük hedef ekleme.
- [ ] **Metin:** Türkçe ve sade; başlıkta sonda nokta yok.

## Bitirmeden
- `npm run typecheck`, `npx vitest run tests/keel-tokens.test.ts tests/design-tokens.test.ts tests/koyu-tema.test.ts tests/ui-rules.test.ts`.
- Telefon (390 px) ve koyu temada bir ekran görüntüsüne bak; yeni ekran `e2e/run.mjs` `ROUTES`'a eklenir.
