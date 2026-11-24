import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type FC } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { badgeText, bellLabel, shouldRing } from '../src/components/ui/bell';
import { passwordStrength } from '../src/components/ui/passwordStrength';
import type { Tone } from '../src/lib/toastStore';

/**
 * rare-ui'den uyarlanan üç parça: gelen işin şeritlerindeki sallanan zil (kayan rakamlı rozet), bildirim kartının ikon
 * karosu ve şifre kutusu. Güvenlik kuralı: gizli şifrenin karakterleri sayfaya yazılmaz
 */
const root = join(__dirname, '..');
// Bileşenler (.tsx) yol değişkeniyle yüklenir: testlerin tsconfig'i (sunucu) JSX ve DOM tiplerini derlemez, vitest çizer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (p: string): Promise<any> => import(/* @vite-ignore */ join(root, p));
const { default: NotificationBell } = (await load('src/components/ui/NotificationBell.tsx')) as { default: FC<Record<string, unknown>> };
const { PasswordInput } = (await load('src/components/ui/PasswordInput.tsx')) as { PasswordInput: FC<Record<string, unknown>> };
const { Field } = (await load('src/components/ui/Field.tsx')) as { Field: FC<Record<string, unknown>> };
const { toast, ToastItem } = (await load('src/lib/toast.tsx')) as { toast: Record<string, unknown>; ToastItem: FC<{ t: { id: number; tone: Tone; text: string; duration: number } }> };
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const NEW_FILES = ['src/components/ui/bell.ts', 'src/components/ui/NotificationBell.tsx', 'src/components/ui/InboxBell.tsx', 'src/components/ui/PasswordInput.tsx', 'src/components/ui/passwordStrength.ts', 'src/lib/toast.tsx'];

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('zil: kurallar', () => {
  it('rozet yazısı: boşta yok, 99 üstü "99+", geçersiz sayı yok', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-3)).toBe('');
    expect(badgeText(Number.NaN)).toBe('');
    expect(badgeText(1)).toBe('1');
    expect(badgeText(2.7)).toBe('2');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
  it('ekran okuyucu adı Türkçe', () => {
    expect(bellLabel(0)).toBe('Bildirimler');
    expect(bellLabel(3)).toBe('Bildirimler, 3 okunmamış');
  });
  it('sayı artınca ve şerit belirince sallanır; azalınca ve hareket azaltmada sallanmaz', () => {
    expect(shouldRing(null, 1, false)).toBe(true);
    expect(shouldRing(1, 2, false)).toBe(true);
    expect(shouldRing(3, 2, false)).toBe(false);
    expect(shouldRing(2, 2, false)).toBe(false);
    expect(shouldRing(null, 0, false)).toBe(false);
    expect(shouldRing(null, 2, true)).toBe(false);
    expect(shouldRing(1, 5, true)).toBe(false);
  });
});

describe('zil: çizim', () => {
  it('tek başına: "Bildirimler, N okunmamış" adı, rozette sayı', () => {
    const out = html(createElement(NotificationBell, { count: 3, tone: 'signal' }));
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="Bildirimler, 3 okunmamış"');
    expect(out).toContain('bg-[var(--admin-signal)]');
    expect(out).toMatch(/>3</);
  });
  it('şeritte süs: şeridin yazısı söyler, zil ikinci kez okunmaz', () => {
    const out = html(createElement(NotificationBell, { count: 120, tone: 'violet', label: false }));
    expect(out).toMatch(/^<span[^>]*aria-hidden="true"/);
    expect(out).not.toContain('aria-label');
    expect(out).toContain('99+');
  });
  it('şeritler zili kullanır; ses, "Gördüm" ve sayının kaynağı aynı', () => {
    const platform = read('src/components/PlatformInbox.tsx');
    const site = read('src/components/SiteInbox.tsx');
    expect(platform).toContain('<InboxBell count={pending.length} tone="signal" />');
    expect(site.match(/<InboxBell count=\{total\} tone="violet" \/>/g)?.length).toBe(2);
    expect(platform).toContain("beep('yeni')");
    expect(site).toContain('ring(ringLevel(list, volume))');
    expect(site).toContain('else beep(cue.sound, p.volume)');
    expect(site).toContain('const total = calls.length + pending.length;');
  });
  it('hareket kütüphanesi tembel parçada: kabuk, şeritler, bildirim ve şifre kutusu motion yüklemez', () => {
    expect(read('src/components/ui/InboxBell.tsx')).toContain("lazy(() => import('./NotificationBell'))");
    for (const f of ['src/components/ui/InboxBell.tsx', 'src/components/PlatformInbox.tsx', 'src/components/SiteInbox.tsx', 'src/components/AppShell.tsx', 'src/lib/toast.tsx', 'src/components/ui/PasswordInput.tsx', 'src/components/ui/Field.tsx']) {
      expect(read(f), f).not.toMatch(/from 'motion/);
    }
    expect(read('src/components/ui/InboxBell.tsx')).not.toMatch(/^import \{[^}]*\} from '\.\/NotificationBell'/m);
  });
});

describe('bildirim kartı', () => {
  const card = (tone: Tone, text = 'Ayarlar kaydedildi') => html(createElement(ToastItem, { t: { id: 1, tone, text, duration: 4000 } }));
  it('API aynı: ok, err, info, warn, dismiss', () => {
    expect(Object.keys(toast).sort()).toEqual(['dismiss', 'err', 'info', 'ok', 'warn']);
  });
  it('her tonda ikon karosu: işaret çizilerek gelir, karo ekran okuyucudan gizli, "Kapat" Türkçe', () => {
    for (const tone of ['ok', 'err', 'info', 'warn'] as const) {
      const out = card(tone);
      expect(out, tone).toContain(`data-tone="${tone}"`);
      expect(out, tone).toMatch(/<span aria-hidden="true" class="toast-ic toast-tile[^"]*"/);
      expect(out, tone).toMatch(/<path class="draw" pathLength="1"/);
      expect(out, tone).toContain('aria-label="Kapat"');
      expect(out, tone).toContain('Ayarlar kaydedildi');
    }
    // Hata çarpısı iki çizgi, uyarı ve bilgi çizgi ve nokta
    expect(card('err').match(/class="draw"/g)?.length).toBe(2);
    expect(card('warn')).toContain('class="dot"');
    expect(card('info')).toContain('class="dot"');
  });
  it('köşeler eş merkezli: kart 18 (Keel), karo 10 + iç pay 8; hareket azaltmada çizim hemen yerinde', () => {
    const src = read('src/lib/toast.tsx');
    expect(src).toContain('rounded-[var(--r-card)] p-2');
    expect(src).toContain('size-8 shrink-0 place-items-center rounded-[10px]');
    const css = read('src/index.css');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.toast-tile,\s*\.toast-tile \.draw,\s*\.toast-tile \.dot,/);
    expect(css).toMatch(/\.toast-tile \.draw \{\s*stroke-dashoffset: 0;\s*\}/);
  });
});

describe('şifre kutusu: güç', () => {
  it('Zayıf / Orta / İyi / Güçlü', () => {
    expect(passwordStrength('')).toBe(0);
    expect(passwordStrength('abc')).toBe(1);
    expect(passwordStrength('Ab1!')).toBe(1);
    expect(passwordStrength('abcdefgh')).toBe(1);
    expect(passwordStrength('abcdefg1')).toBe(2);
    expect(passwordStrength('Abcdefg1')).toBe(3);
    expect(passwordStrength('Abcdefgh1!xy')).toBe(4);
    // Türkçe harfler harf sayılır: büyük Ş ve küçük ğ birlikte
    expect(passwordStrength('Şekerliğ12')).toBe(3);
    // Uzaktan üyeliği en az 10: dokuz karakter ne içerirse içersin Zayıf
    expect(passwordStrength('Abcdef1!x', 10)).toBe(1);
  });
});

describe('şifre kutusu: gizliyken karakter sayfada yok', () => {
  const SECRET = 'Gizli-Parola9ğ';
  const render = (props: Record<string, unknown> = {}) => html(createElement(PasswordInput, { id: 'parola', name: 'parola', value: SECRET, onChange: () => {}, ...props }));

  it('gizli: yalnız noktalar, ne karakter ne value özniteliği', () => {
    const out = render();
    expect(out).toContain('type="password"');
    expect(out).not.toContain('value=');
    for (const piece of [SECRET, 'Gizli', 'Parola', 'ğ', 'a9']) expect(out, piece).not.toContain(piece);
    expect(out.match(/class="pw-dot /g)?.length).toBe([...SECRET].length);
    expect(out).not.toContain('pw-char');
    expect(out).toContain('aria-label="Şifreyi göster"');
  });
  it('gösterilince karakterler yerinde, düğme "Şifreyi gizle"', () => {
    const out = render({ defaultVisible: true });
    expect(out).toContain('type="text"');
    const chars = [...out.matchAll(/<span class="pw-char whitespace-pre">([^<]*)<\/span>/g)].map((m) => m[1]).join('');
    expect(chars).toBe(SECRET);
    expect(out).toContain('aria-label="Şifreyi gizle"');
  });
  it('parola yöneticisi ve form: id, name, autocomplete aynı; düğme alanı denetler', () => {
    const out = render({ autoComplete: 'new-password' });
    expect(out).toContain('id="parola"');
    expect(out).toContain('name="parola"');
    expect(out).toContain('autoComplete="new-password"');
    expect(out).toContain('aria-controls="parola"');
    expect(render()).toContain('autoComplete="current-password"');
  });
  it('güç çubuğu yalnız istenince ("Şifre gücü"), alanın açıklaması', () => {
    expect(render()).not.toContain('Şifre gücü');
    const out = render({ strength: true });
    expect(out).toContain('Şifre gücü');
    expect(out).toContain('aria-describedby="parola-guc"');
    expect(out).toContain('id="parola-guc"');
    expect(out).toContain('data-level="4"');
  });
  it('etiketli alanda göz düğmesi adın parçası olmaz: düğme <label> dışında, etiket alana for ile bağlı', () => {
    // <label> içindeki düğmenin adı alanın adına karışır ("Parola Parolayı göster"); etiket yalnız yazıyı sarar
    const field = (props: Record<string, unknown> = {}, child: Record<string, unknown> = {}) =>
      html(createElement(Field, { label: 'Parola', ...props }, createElement(PasswordInput, { value: SECRET, onChange: () => {}, showLabel: 'Parolayı göster', ...child })));
    for (const out of [field(), field({ hint: 'En az 10 karakter, harf ve rakam karışık', error: 'Parola yanlış' }), field({}, { id: 'parola' })]) {
      const labels = [...out.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)];
      expect(labels.length, out).toBe(1);
      expect(labels[0][1]).toContain('Parola');
      expect(labels[0][1]).not.toContain('<button');
      expect(labels[0][1]).not.toContain('<input');
      const id = /<input[^>]*\sid="([^"]+)"/.exec(out)?.[1];
      expect(id).toBeTruthy();
      expect(labels[0][0]).toContain(`for="${id}"`);
      expect(out).toContain(`aria-controls="${id}"`);
    }
    expect(field({}, { id: 'parola' })).toContain('id="parola"');
    // Hata ve uzun ipucu yine alanın açıklaması
    const err = field({ hint: 'En az 10 karakter, harf ve rakam karışık', error: 'Parola yanlış' });
    const described = /<input[^>]*aria-describedby="([^"]+)"/.exec(err)?.[1].split(' ') ?? [];
    expect(described.length).toBe(2);
    expect(err).toContain('aria-invalid="true"');
  });
  it('Field şifre kutusunu içe aktarmaz (şifre kutusu ana pakete inmez, kullanan ekranla gelir)', () => {
    expect(read('src/components/ui/Field.tsx')).not.toMatch(/from '\.\/PasswordInput'/);
    // Uzaktan girişi App.tsx'te statik: kasa build'inde ağaçtan atılır, modülün üst düzeyi yan etkisiz kalmalı
    const src = read('src/components/ui/PasswordInput.tsx');
    expect(src).toContain('= /*#__PURE__*/ forwardRef<');
    expect(src).toContain('= /*#__PURE__*/ Object.assign(');
  });
  it('dokunmatikte alan ve göz düğmesi 44 px', () => {
    const src = read('src/components/ui/PasswordInput.tsx');
    expect(src).toContain('pointer-coarse:h-11');
    expect(src).toContain('pointer-coarse:w-11');
    expect(src).toMatch(/className="peer absolute inset-0 size-full/);
  });
});

describe('şifre kutusu: yerleri', () => {
  it('uygulamada yerli type="password" kalmadı (PIN tuş takımı hariç, o zaten yazı alanı değil)', () => {
    const bad = walk(join(root, 'src'))
      .filter((f) => !f.endsWith('PasswordInput.tsx'))
      .filter((f) => /type(?:=|:\s*)(?:"password"|'password'|\{[^}]*'password')/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
  it('güç çubuğu yalnız yeni parolada (üyelik), girişte ve PIN alanlarında yok', () => {
    const login = read('src/pages/RemoteLoginPage.tsx');
    expect(login).toContain('strength={creating}');
    expect(login).toContain('strengthMin={10}');
    expect(login.match(/strength[=\s{]/g)?.length).toBe(1);
    for (const f of ['src/pages/cash/ShiftHandover.tsx', 'src/components/admin/CloudBackupCard.tsx', 'src/components/admin/DenemeCard.tsx', 'src/pages/admin/ConnectionsAdmin.tsx']) {
      const src = read(f);
      expect(src, f).toContain('<PasswordInput');
      expect(src, f).not.toMatch(/<PasswordInput[^>]*\sstrength/);
    }
    expect(read('src/pages/cash/ShiftHandover.tsx')).toContain('showLabel="PIN\'i göster"');
    // Uzaktan › Ekip'in PIN alanları: şifre kutusu, parola yöneticisi karışmaz, yalnız rakam
    const ekip = read('src/pages/kontrol/EkipSekmesi.tsx');
    expect(ekip.match(/<PasswordInput /g)?.length).toBe(2);
    expect(ekip).toContain("'data-1p-ignore': ''");
    expect(ekip).toContain("'data-lpignore': 'true'");
    expect(ekip).toContain('setPin(pinGirdisi(e.target.value))');
  });
});

describe('rare-ui renkleri ve logosu yok', () => {
  it('yeni parçalarda sabit renk yok, yalnız Keel belirteçleri', () => {
    for (const f of NEW_FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, f).not.toMatch(/rare-ui\.(?:com|dev)|figma-squircle|@radix-ui\/react-slot/);
    }
  });
});
