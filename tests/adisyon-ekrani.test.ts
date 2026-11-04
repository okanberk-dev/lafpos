import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO, OrderItemDTO } from '@shared/types';
import { cartGroupOf, groupCartItems } from '../src/pages/order/cartGroups';
import { type Harness, PINS, startApp } from './harness';

/**
 * Adisyon ekranının yenilenmesi (4 Kasım 2026): kalemler duruma göre gruplu (Gönderilmedi, Barda, Hazır, Teslim, İptal),
 * kalem işlemleri kalemden tek dokunuşta (ikram, ödenmez, zayi, indirim, taşı, not, iptal), tek birincil eylem mürekkep
 * "Öde · ₺X", gönderilmemiş varsa ikincil "Bara gönder (N)", hızlı işlemler (Böl, İndirim, Taşı, Hesap yazdır,
 * İşlemler), telefonda önce ürünler ve yapışkan sepet çubuğu. Davranış, istekler ve yetki denetimleri aynen kalır.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const src = (file: string) => readFileSync(new URL(`../src/pages/order/${file}`, import.meta.url), 'utf8');
const item = (over: Partial<OrderItemDTO>) => ({ voided: false, stationId: 'bar', status: 'yeni', ...over }) as Pick<OrderItemDTO, 'voided' | 'stationId' | 'status'>;

describe('kalemlerin grupları', () => {
  it('iptal her şeyden önce; istasyonsuz kalem teslim; hazır ve servis ayrı; bekleyen ve hazırlanan barda', () => {
    expect(cartGroupOf(item({ voided: true, status: 'hazir' }))).toBe('iptal');
    expect(cartGroupOf(item({ stationId: null, status: 'servis' }))).toBe('teslim');
    expect(cartGroupOf(item({ stationId: null, status: 'yeni' }))).toBe('teslim');
    expect(cartGroupOf(item({ status: 'yeni' }))).toBe('barda');
    expect(cartGroupOf(item({ status: 'hazirlaniyor' }))).toBe('barda');
    expect(cartGroupOf(item({ status: 'hazir' }))).toBe('hazir');
    expect(cartGroupOf(item({ status: 'servis' }))).toBe('teslim');
  });

  it('sıra hep Barda, Hazır, Teslim, İptal; boş grup çizilmez; grubun içinde ekleniş sırası', () => {
    const items = [item({ status: 'servis' }), item({ status: 'hazir' }), item({ voided: true }), item({ status: 'yeni' }), item({ status: 'hazirlaniyor' })];
    const groups = groupCartItems(items);
    expect(groups.map((g) => g.label)).toEqual(['Barda', 'Hazır', 'Teslim', 'İptal edilenler']);
    expect(groups[0].items).toEqual([items[3], items[4]]);
    expect(groupCartItems([item({ status: 'hazir' })]).map((g) => g.key)).toEqual(['hazir']);
  });
});

describe('gönderilmiş kaleme not', () => {
  it('not yazılır ve silinir; iptal edilmiş kaleme ve kapanmış adisyona yazılmaz; sipariş yetkisi ister', async () => {
    const product = h.boot.products.find((p) => p.name === 'Latte')!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product.id, size: 'M', qty: 2 }] });
    const it = o.items[0];
    o = await h.ok<OrderDTO>('garson', 'PUT', `/orders/${o.id}/items/${it.id}/note`, { note: '  az buzlu  ' });
    expect(o.items[0].note).toBe('az buzlu');
    // Bar fişi notu görür
    const tickets = await h.ok<{ items: { id: string; note: string | null }[] }[]>('kasa', 'GET', '/kitchen');
    expect(tickets.flatMap((t) => t.items).find((x) => x.id === it.id)?.note).toBe('az buzlu');
    o = await h.ok<OrderDTO>('kasa', 'PUT', `/orders/${o.id}/items/${it.id}/note`, { note: '' });
    expect(o.items[0].note).toBeNull();
    expect((await h.call('kasa', 'PUT', `/orders/${o.id}/items/${it.id}/note`, { note: 'x'.repeat(201) })).status).toBe(422);
    // Bar ekranı rolünün sipariş yetkisi yok
    await h.login('bar', '3333');
    expect((await h.call('bar', 'PUT', `/orders/${o.id}/items/${it.id}/note`, { note: 'bar' })).status).toBe(403);
    // İptal edilen kaleme not yok
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items/${it.id}/void`, { reason: 'Yanlış giriş', approverPin: PINS.mudur });
    expect((await h.call('kasa', 'PUT', `/orders/${o.id}/items/${it.id}/note`, { note: 'geç' })).status).toBe(409);
  });
});

describe('ekranın kuralları (kaynak)', () => {
  const page = src('OrderPage.tsx');
  const cart = src('CartPanel.tsx');

  it('tek birincil eylem mürekkep "Öde"; gönderilmemiş varken ikincil "Bara gönder (N)"', () => {
    expect(page).toContain("const sendLabel = `Bara gönder (${pendingCount})`;");
    expect(page).toMatch(/variant="ink"[^>]*onClick=\{\(\) => void sendAndPay\(\)\}/);
    expect(page).toMatch(/<PayLabel action="Öde" amount=\{due\} inline \/>/);
    expect(page).not.toMatch(/action="Ödeme"/);
  });

  it('hızlı işlemler: Böl, İndirim, Taşı, Hesap yazdır, İşlemler; İşlemler telefonda başlıkta', () => {
    for (const label of ["label: 'Böl'", "label: 'İndirim'", "label: 'Taşı'", "label: 'Hesap yazdır'", "label: 'İşlemler'"]) expect(page).toContain(label);
    expect(page).toMatch(/aria-label="Hızlı işlemler"/);
    expect(page).toMatch(/<div className="md:hidden">\s*<IconButton label="İşlemler"/);
  });

  it('telefonda önce ürünler, yapışkan sepet çubuğu sepeti açar', () => {
    expect(page).toContain('aria-label={`Sepet: ${itemCount} ürün, ${tl(cartTotal)}`}');
    expect(page).not.toContain('role="tablist"');
    expect(page).toContain('Ürün ekle');
  });

  it('telefonda sepet çubuğu kalemsiz adisyonda da durur (oda sayacı, "Masayı boşalt" sepette); tutar kısa ve kesilmez', () => {
    expect(page).toContain('const cartBar = (\n');
    expect(page).not.toMatch(/const cartBar = \(itemCount > 0/);
    expect(page).toContain("{itemCount > 0 ? `${itemCount} ürün` : 'Sepet boş'}");
    expect(page).toContain('whitespace-nowrap font-headline text-lg font-bold">{tlShort(cartTotal)}');
    // Dar çubukta görünen ad kısa, erişilebilir ad adetli ("Bara gönder (N)")
    expect(page).toMatch(/aria-label=\{sendLabel\} className="shrink-0 px-4">\s*Bara gönder\s*</);
  });

  it('gönderilmemiş adet rozeti iki temada okunur: amber dolgu üstünde beyaz değil, yumuşak zemin ve koyu amber yazı', () => {
    expect(page).toContain('bg-[var(--admin-warning-soft)] px-1 text-center text-[11px] font-semibold leading-5 text-[var(--admin-warning)]');
    expect(page).not.toMatch(/bg-\[var\(--admin-warning\)\][^"]*text-white/);
  });

  it('telefonda görünüm geçişi odağı öteki görünümün geçiş düğmesine verir; bildirim alt bloğun ölçülen boyunun üstünde', () => {
    expect(page).toContain("(tab === 'adisyon' ? addProductRef : cartBarRef).current?.focus();");
    expect(page).toContain('ref={addProductRef}');
    expect(page).toContain('ref={cartBarRef}');
    // Bütün geçişler showView'dan (odak bayrağı); düz setTab('menu' | 'adisyon') kalmadı
    expect(page).not.toMatch(/setTab\('(menu|adisyon)'\)/);
    expect(page.match(/ref=\{measureActionBar\} data-action-bar=""/g)?.length).toBe(2);
    expect(page).toContain("root.style.setProperty('--action-bar-h'");
    expect(page).toContain("root.style.removeProperty('--action-bar-h')");
  });

  it('kalem penceresinde taşı ve not yalnız sipariş alınabilen adisyonda (yalnız ödeme alan rolde, kapanmış, online yok)', () => {
    expect(page).toMatch(/onMoveItem=\{\s*editable\s*\?/);
    expect(page).toContain('canNote={editable}');
    expect(cart).toContain('{canNote && (');
  });

  it('kalemler gruplu, işlemleri kalemden: taşı ve not da', () => {
    expect(cart).toContain('groupCartItems(visibleItems)');
    expect(cart).toContain('title="Taşı"');
    expect(cart).toMatch(/title=\{item\.note \? 'Notu değiştir' : 'Not ekle'\}/);
    expect(cart).toContain('put(`${base}/note`');
  });
});
