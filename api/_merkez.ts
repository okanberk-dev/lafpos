/**
 * Merkez (lafpos.laffogato.net/merkez): dükkânlar, lisans ve seçerek güncelleme. api/uzaktan.ts yolu `merkez/` ile
 * başlayan istekleri buraya verir (alt çizgili dosya Vercel'de ayrı işlev olmaz).
 *
 * Kurulum kaydı (ilk görüşte güven): kasa ilk açılışta kurulum kimliği ve gizli anahtar üretir, internete ilk çıktığında
 * `POST merkez/kayit` ile bildirir; Merkez'de "Onay bekliyor" görünür. Kayıt bir kez açılır: aynı kimliğe başka anahtar
 * yazılamaz. Sonraki istekler (`merkez/nabiz`) kurulumun anahtarıyla imzalıdır (server/lib/signature.ts kuralı).
 *
 * Nabzın yanıtı kasanın lisans kaydı ve çalıştıracağı derleme (hedef): "otomatik" dükkânda kanalın son derlemesi,
 * "ben gönderince" dükkânda sahibin son gönderdiği derleme (hiç gönderilmediyse kurulu olan).
 *
 * Redis: `lafpos:merkez:kurulum:<id>` (JSON), `lafpos:merkez:kurulumlar` (kimlik kümesi). Panel uçları yalnız gerçek
 * oturumla (üye ya da parolalı giriş); parolasız görünümde Merkez kapalıdır.
 */
import { type LicenseRecord, licenseState, ONLINE_MS, UPDATE_LABELS } from '../shared/lisans.js';

export interface Install {
  id: string;
  /** Kurulumun imza anahtarı (kasada üretilir); panele hiç dönmez */
  key: string;
  ad: string | null;
  createdAt: number;
  lastSeen: number | null;
  surum: string | null;
  build: number | null;
  guncelleme: { durum: string; mesaj: string; yeni: { surum: string; build: number } | null } | null;
  gunAcik: boolean | null;
  lisans: LicenseRecord;
  mod: 'elle' | 'otomatik';
  /** "Ben gönderince" dükkânda sahibin gönderdiği derleme */
  hedef: number | null;
  gonderildi: number | null;
}

/** Güncelleme kanalının son derlemesi (surum.json'dan, kısa değişiklik notuyla) */
export interface Release {
  version: string;
  build: number;
  date: string;
  not: string | null;
}

export interface MerkezDeps {
  redis: (...cmd: (string | number)[]) => Promise<unknown>;
  /** İmzayı verilen anahtarla doğrular (api/uzaktan.ts verifyPush) */
  verify: (key: string, req: Request, url: URL, body: string) => boolean;
  /** Panel için gerçek oturum var mı (üye ya da parolalı giriş) */
  admin: () => Promise<boolean>;
  /** Kafe bağlanmadan önceki örnek gün: panel örnek listeyi salt okunur gösterir */
  demo: boolean;
  fetchRelease: () => Promise<Release | null>;
  now?: () => number;
  /** Patrona bildirim (api/_bildirim.ts): güncelleme sorun çıkarıp eski sürüme dönünce */
  notify?: (n: { kind: string; title: string; body: string; at: number; shop?: string | null }) => Promise<void>;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status: number, error: string, code: string) => json({ error, code }, status);

const SET_KEY = 'lafpos:merkez:kurulumlar';
const installKey = (id: string) => `lafpos:merkez:kurulum:${id}`;
export const ID_RE = /^[a-z0-9]{20,40}$/;
const MIN_KEY = 32;

async function readInstall(deps: MerkezDeps, id: string): Promise<Install | null> {
  const raw = (await deps.redis('GET', installKey(id))) as string | null;
  return raw ? (JSON.parse(raw) as Install) : null;
}
const writeInstall = (deps: MerkezDeps, i: Install) => deps.redis('SET', installKey(i.id), JSON.stringify(i));

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : null);
const intOrNull = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);

/** Kasanın çalıştıracağı derleme: otomatikte kanalın sonu, elle gönderilende sahibin gönderdiği (yoksa null: kurulu kalır) */
export function targetFor(i: Pick<Install, 'mod' | 'hedef'>, release: Release | null): number | null {
  if (i.mod === 'otomatik') return release?.build ?? i.hedef;
  return i.hedef;
}

/** Panelin gördüğü satır: anahtar yok; lisans ve güncelleme durumu sade adıyla */
export function installView(i: Install, release: Release | null, now: number) {
  const lic = licenseState(i.lisans, { installedAt: i.createdAt, now });
  const behind = release != null && i.build != null && i.build < release.build;
  return {
    id: i.id,
    ad: i.ad,
    surum: i.surum,
    build: i.build,
    createdAt: i.createdAt,
    lastSeen: i.lastSeen,
    online: i.lastSeen != null && now - i.lastSeen < ONLINE_MS,
    gunAcik: i.gunAcik,
    guncelleme: i.guncelleme ? { ...i.guncelleme, etiket: UPDATE_LABELS[i.guncelleme.durum] ?? i.guncelleme.durum } : null,
    lisans: { ...i.lisans, ...lic },
    mod: i.mod,
    hedef: i.hedef,
    gonderildi: i.gonderildi,
    /** Kanalda daha yeni derleme var ve bu dükkâna henüz gönderilmedi */
    bekleyen: behind && targetFor(i, release) !== release!.build,
  };
}

/** Kafe bağlanmadan önce panelin örnek satırları (gerçek kurulum değil, salt okunur) */
function demoInstalls(release: Release | null, now: number) {
  const base: Install = {
    id: 'ornekkurulum00000000001',
    key: '',
    ad: 'Örnek dükkân',
    createdAt: now - 20 * 86_400_000,
    lastSeen: now - 60_000,
    surum: release?.version ?? '0.2.0',
    build: release?.build ?? null,
    guncelleme: { durum: 'guncel', mesaj: 'Güncel', yeni: null },
    gunAcik: true,
    lisans: { durum: 'aktif', bitis: null },
    mod: 'elle',
    hedef: release?.build ?? null,
    gonderildi: null,
  };
  return [installView(base, release, now)];
}

export async function merkez(req: Request, url: URL, path: string, deps: MerkezDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)();

  // ─── Kasa: kayıt (imzasız, ilk görüşte güven) ───
  if (path === 'merkez/kayit' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = String(body.id ?? '');
    const key = String(body.anahtar ?? '');
    if (!ID_RE.test(id) || key.length < MIN_KEY || key.length > 200) return fail(400, 'Kurulum kimliği ya da anahtarı anlaşılamadı', 'bad_body');
    const fresh: Install = {
      id,
      key,
      ad: null,
      createdAt: now,
      lastSeen: now,
      surum: text(body.surum, 40),
      build: intOrNull(body.build),
      guncelleme: null,
      gunAcik: null,
      lisans: { durum: 'bekliyor' },
      mod: 'elle',
      hedef: null,
      gonderildi: null,
    };
    // Kasa kendi kuruluş anını söyler (internete geç çıkan kurulumun deneme süresi kuruluştan sayılır); gelecekte olamaz
    const installedAt = intOrNull(body.kurulus);
    if (installedAt && installedAt <= now) fresh.createdAt = installedAt;
    if ((await deps.redis('SET', installKey(id), JSON.stringify(fresh), 'NX')) === 'OK') {
      await deps.redis('SADD', SET_KEY, id);
      return json({ ok: true, yeni: true });
    }
    // Aynı kasa yeniden bildiriyorsa (yanıtı almadan internet kesildi) sorun yok; başka anahtar kabul edilmez
    const existing = await readInstall(deps, id);
    if (existing && existing.key === key) return json({ ok: true, yeni: false });
    return fail(409, 'Bu kurulum kimliği başka bir anahtarla kayıtlı', 'install_exists');
  }

  // ─── Kasa: imzalı nabız ───
  if (path === 'merkez/nabiz' && req.method === 'POST') {
    const id = req.headers.get('x-laf-kurulum') ?? '';
    if (!ID_RE.test(id)) return fail(400, 'Kurulum kimliği yok', 'bad_body');
    const raw = await req.text();
    if (raw.length > 20_000) return fail(413, 'Nabız çok büyük', 'too_large');
    const inst = await readInstall(deps, id);
    if (!inst) return fail(404, 'Kurulum kayıtlı değil', 'not_registered');
    if (!deps.verify(inst.key, req, url, raw)) return fail(401, 'İmza geçersiz', 'bad_signature');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return fail(400, 'Nabız okunamadı', 'bad_body');
    }
    const g = body.guncelleme as Record<string, unknown> | null | undefined;
    const yeni = g?.yeni as { surum?: unknown; build?: unknown } | null | undefined;
    const release = await deps.fetchRelease();
    const next: Install = {
      ...inst,
      lastSeen: now,
      surum: text(body.surum, 40) ?? inst.surum,
      build: intOrNull(body.build) ?? inst.build,
      gunAcik: typeof body.gunAcik === 'boolean' ? body.gunAcik : inst.gunAcik,
      guncelleme:
        g && typeof g.durum === 'string'
          ? { durum: g.durum.slice(0, 20), mesaj: text(g.mesaj, 300) ?? '', yeni: yeni && typeof yeni.surum === 'string' && intOrNull(yeni.build) ? { surum: yeni.surum.slice(0, 40), build: yeni.build as number } : null }
          : inst.guncelleme,
    };
    await writeInstall(deps, next);
    // Güncelleme sorun çıkardı (eski sürüme dönüldü): patrona bir kez haber
    const failedNow = next.guncelleme?.durum === 'geri-dondu' || next.guncelleme?.durum === 'hata';
    if (failedNow && inst.guncelleme?.durum !== next.guncelleme?.durum) {
      await deps.notify?.({ kind: 'guncelleme', title: 'Güncelleme sorunu', body: next.guncelleme!.mesaj || 'Yeni sürüm kurulamadı; eski sürüm çalışıyor', at: now, shop: next.ad }).catch(() => undefined);
    }
    return json({ ok: true, ad: next.ad, lisans: next.lisans, mod: next.mod, hedef: targetFor(next, release), at: now });
  }

  // ─── Panel ───
  if (path === 'merkez/kurulumlar' && req.method === 'GET') {
    const release = await deps.fetchRelease();
    if (deps.demo) return json({ kurulumlar: demoInstalls(release, now), enYeni: release, demo: true });
    if (!(await deps.admin())) return fail(401, 'Merkez için üye girişi gerekir', 'unauthorized');
    const ids = ((await deps.redis('SMEMBERS', SET_KEY)) as string[] | null) ?? [];
    const rows: Install[] = [];
    if (ids.length) {
      const raws = (await deps.redis('MGET', ...ids.map(installKey))) as (string | null)[];
      for (const r of raws) if (r) rows.push(JSON.parse(r) as Install);
    }
    rows.sort((a, b) => (a.ad ?? '￿').localeCompare(b.ad ?? '￿', 'tr') || a.createdAt - b.createdAt);
    return json({ kurulumlar: rows.map((i) => installView(i, release, now)), enYeni: release });
  }

  if (req.method === 'POST' && (path === 'merkez/kurulum' || path === 'merkez/gonder')) {
    if (deps.demo) return fail(403, 'Örnek görünümde değişiklik yapılmaz', 'remote_readonly');
    if (!(await deps.admin())) return fail(401, 'Merkez için üye girişi gerekir', 'unauthorized');
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    if (path === 'merkez/kurulum') {
      const id = String(body.id ?? '');
      const inst = ID_RE.test(id) ? await readInstall(deps, id) : null;
      if (!inst) return fail(404, 'Kurulum bulunamadı', 'not_found');
      const next: Install = { ...inst };
      if ('ad' in body) next.ad = text(body.ad, 60) || null;
      if (body.mod === 'elle' || body.mod === 'otomatik') next.mod = body.mod;
      if (body.lisans === 'aktif') {
        const bitis = body.bitis == null || body.bitis === '' ? null : String(body.bitis);
        if (bitis != null && !/^\d{4}-\d{2}-\d{2}$/.test(bitis)) return fail(400, 'Bitiş tarihi anlaşılamadı', 'bad_body');
        next.lisans = { durum: 'aktif', bitis };
      } else if (body.lisans === 'pasif') {
        // Zaten pasifse uyarı süresi baştan başlamaz
        next.lisans = { durum: 'pasif', pasifAt: inst.lisans.durum === 'pasif' ? (inst.lisans.pasifAt ?? now) : now };
      } else if (body.lisans === 'bekliyor') {
        next.lisans = { durum: 'bekliyor' };
      }
      await writeInstall(deps, next);
      return json({ ok: true, kurulum: installView(next, await deps.fetchRelease(), now) });
    }

    // Güncelleme gönder: seçilen dükkânların hedefi kanalın son derlemesi
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)).slice(0, 200) : [];
    if (!ids.length) return fail(400, 'Dükkân seçin', 'bad_body');
    const release = await deps.fetchRelease();
    if (!release) return fail(503, 'Güncelleme kanalı okunamadı; biraz sonra yeniden deneyin', 'no_release');
    let sent = 0;
    for (const id of ids) {
      const inst = await readInstall(deps, id);
      if (!inst) continue;
      await writeInstall(deps, { ...inst, hedef: release.build, gonderildi: now });
      sent++;
    }
    return json({ ok: true, gonderilen: sent, build: release.build });
  }

  return fail(404, "Merkez'de böyle bir uç yok", 'not_found');
}
