import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { answerText } from '../src/lib/lafmaliyet';

/**
 * Eski kasa programı (sahibin isteği, 28 Kasım 2026: "ModPOS kısımlarını kaldır, yani 'direkt başlasın mı' gibisinden"):
 * ayar ve durum metinleri eski programın adını anmaz, Entegrasyon'daki "ModPOS dönemi" bölümü yalnız o döneme ait gün ya
 * da hata varken çizilir. ModPOS'tan veri çekimi, geçmiş günler ve raporlardaki "ModPOS" etiketi aynen kalır (veri adı;
 * tests/modpos-kasa.test.ts, tests/modpos-gecmis.test.ts). Kasa açılışındaki soru: tests/masaustu-programi.test.ts
 */
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

describe('eski kasa programı: ayar ve durum metinleri', () => {
  it('İlk Z numarası ipucu önceki kasa programını adıyla anmaz', () => {
    const page = src('pages/admin/SettingsAdmin.tsx');
    expect(page).toContain('<Field label="İlk Z numarası" hint="Önceki kasa programının son Z numarasının bir fazlası. Geçiş gününden önce bir kez girilir');
    expect(page).not.toMatch(/ModPOS/);
  });

  it('geçiş günü seçilmemiş lafmaliyet yanıtı aynı bilgiyi eski programın adı olmadan verir', () => {
    const t = answerText({ date: '2026-11-03', at: 0, counted: false, switchDay: null });
    expect(t.tone).toBe('idle');
    expect(t.text).toContain('geçiş günü seçilmedi, AsilPOS henüz asıl kasa sayılmıyor');
    expect(t.text).toContain('Gün deneme olarak saklandı, hesaplara girmez');
    expect(t.text).not.toMatch(/ModPOS/i);
    expect(src('lib/lafmaliyet.ts')).not.toMatch(/ModPOS/);
  });
});

describe('Entegrasyon › ModPOS dönemi yalnız gün ya da hata varken', () => {
  const page = src('pages/admin/IntegrationAdmin.tsx');

  it('bölüm yalnız döneme ait gün ya da son çekimden sonraki hata varken çizilir (ModPOS\'u olmayan şubede görünmez)', () => {
    expect(page).toContain('const showModpos = (m: ModposStatus) => m.days > 0 || !!modposError(m);');
    expect(page).toContain('{modpos && showModpos(modpos) && <ModposSection m={modpos} canSync={canSync} run={run} busy={busy} />}');
    expect(page.match(/<ModposSection /g)).toHaveLength(1);
    // Hata: son başarılı çekimden sonraki (bölümün içinde de aynı tanım)
    expect(page).toContain('const modposError = (m: ModposStatus) => (m.error && (!m.pulledAt || (m.error.at ?? 0) > m.pulledAt) ? m.error.message : null);');
    expect(page.slice(page.indexOf('function ModposSection'), page.indexOf('function LafmaliyetCard'))).toContain('const error = modposError(m);');
  });

  it('işlev aynı: başlık, durum, açıklama ve elle çekim düğmesi', () => {
    const section = page.slice(page.indexOf('function ModposSection'), page.indexOf('function LafmaliyetCard'));
    expect(section).toContain('<h3 className={SECTION_TITLE}>ModPOS dönemi</h3>');
    expect(section).toContain("run('/sync/lafmaliyet/modpos/pull', 'ModPOS dönemi çekildi')");
    expect(section).toContain('ModPOS dönemini çek');
    expect(section).toContain('“ModPOS” etiketiyle görünür');
  });
});
