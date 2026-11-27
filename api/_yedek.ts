/**
 * Bulut yedeği (server/sync/yedek.ts): kasa şifreli yedeğini kısa süreli imzalı adrese doğrudan yükler ve oradan
 * indirir; Blob anahtarı (BLOB_READ_WRITE_TOKEN, Vercel › Storage'daki özel yedek deposu; adı shared/eski-adlar.ts `BLOB_DEPOSU`) yalnız burada. Kasanın
 * istekleri ASILPOS_CLOUD_SECRET ile ya da şubenin kendi anahtarıyla (ASILPOS_CLOUD_SECRET_<ŞUBE>) imzalı. Yedekler `yedek/<dükkân>/<an>.lpy`; dükkân başına son 30 yedek kalır.
 * Dosyalar kasada şifrelenir (anahtar buraya hiç gelmez): Blob'u açan biri de içeriği okuyamaz.
 */
import { del, issueSignedToken, list, presignUrl } from '@vercel/blob';
import type { Kafe } from './_kafe.js';

export interface YedekDeps {
  /** Kasanın imzası (ortak anahtar ya da şubenin kendi anahtarı): tutarsa kasanın kimliği, tutmazsa null */
  kafe: (body: string) => Kafe | null;
  shop: string;
  /**
   * Dükkânlardan bu kasanın açabildikleri: şubeye bağlı dükkânın yedekleri yalnız o şubenin kendi anahtarıyla
   * (api/_kafe.ts; ortak anahtarı bilen başka şubenin kasası listeleyemez, indiremez, yükleyemez)
   */
  acik: (kafe: Kafe, shops: string[]) => Promise<Set<string>>;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status: number, error: string, code: string) => json({ error, code }, status);

const KEEP = 30;
const MAX_BYTES = 1024 * 1024 * 1024;
const URL_MS = 15 * 60_000;
const SHOP_RE = /^[a-z0-9-]{1,40}$/;

export const blobReady = () => !!process.env.BLOB_READ_WRITE_TOKEN;

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

async function backupsOf(shop: string) {
  const out: { pathname: string; size: number; at: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: `yedek/${shop}/`, cursor, limit: 1000 });
    for (const b of page.blobs) out.push({ pathname: b.pathname, size: b.size, at: new Date(b.uploadedAt).getTime() });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => b.at - a.at);
}

export async function yedek(req: Request, path: string, deps: YedekDeps): Promise<Response> {
  if (req.method !== 'POST') return fail(405, 'Yalnız POST', 'method');
  const raw = await req.text();
  if (raw.length > 2000) return fail(413, 'İstek çok büyük', 'too_large');
  const kafe = deps.kafe(raw);
  if (!kafe) return fail(401, 'İmza geçersiz', 'bad_signature');
  const kapali = () => fail(403, 'Bu dükkânın yedekleri şubesinin kendi anahtarıyla açılır', 'branch_key_required');
  if (!blobReady()) return fail(503, 'Bulut yedek deposu bağlı değil (Vercel › Storage › Blob)', 'not_configured');
  if (!SHOP_RE.test(deps.shop)) return fail(400, 'Dükkân kimliği anlaşılamadı', 'bad_body');
  let body: Record<string, unknown>;
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return fail(400, 'İstek okunamadı', 'bad_body');
  }

  // Yükleme: dükkânın klasöründe yeni bir ad, 15 dakikalık imzalı PUT; eskiler (30'dan fazlası) silinir
  if (path === 'uzaktan/yedek/yukle') {
    if (!(await deps.acik(kafe, [deps.shop])).has(deps.shop)) return kapali();
    const size = Number(body.boyut);
    if (!Number.isInteger(size) || size <= 0 || size > MAX_BYTES) return fail(400, 'Yedeğin boyu anlaşılamadı', 'bad_body');
    const pathname = `yedek/${deps.shop}/${stamp(Date.now())}.lpy`;
    const validUntil = Date.now() + URL_MS;
    const token = await issueSignedToken({ pathname, operations: ['put'], allowedContentTypes: ['application/octet-stream'], maximumSizeInBytes: MAX_BYTES, validUntil });
    const { presignedUrl } = await presignUrl(token, { operation: 'put', pathname, access: 'private', allowedContentTypes: ['application/octet-stream'], maximumSizeInBytes: MAX_BYTES, addRandomSuffix: false, allowOverwrite: false, validUntil });
    const old = (await backupsOf(deps.shop)).slice(KEEP - 1);
    if (old.length) await del(old.map((b) => b.pathname));
    return json({ ok: true, pathname, url: presignedUrl });
  }

  // Liste: bu dükkânın yedekleri (en yeni üstte). `dukkan` başka bir kimlik isterse (bilgisayar değişti, eski kurulum)
  // onun yedekleri: aynı ortak anahtarı bilen kasa bağsız dükkânların sahibidir; şubeye bağlı dükkân yalnız o şubenin
  // kendi anahtarıyla görünür (`acik`)
  if (path === 'uzaktan/yedek/liste') {
    const shop = typeof body.dukkan === 'string' && SHOP_RE.test(body.dukkan) ? body.dukkan : deps.shop;
    const shops = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: 'yedek/', mode: 'folded', cursor, limit: 1000 });
      for (const f of page.folders ?? []) shops.add(f.replace(/^yedek\//, '').replace(/\/$/, ''));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    const acik = await deps.acik(kafe, [...new Set([shop, ...shops])]);
    if (!acik.has(shop)) return kapali();
    return json({ shop, dukkanlar: [...shops].filter((s) => acik.has(s)), yedekler: await backupsOf(shop) });
  }

  // İndirme: yalnız yedek klasöründen, 15 dakikalık imzalı GET
  if (path === 'uzaktan/yedek/indir') {
    const pathname = String(body.pathname ?? '');
    if (!/^yedek\/[a-z0-9-]{1,40}\/\d{8}-\d{6}\.lpy$/.test(pathname)) return fail(400, 'Yedek adı anlaşılamadı', 'bad_body');
    const shop = pathname.split('/')[1]!;
    if (!(await deps.acik(kafe, [shop])).has(shop)) return kapali();
    const validUntil = Date.now() + URL_MS;
    const token = await issueSignedToken({ pathname, operations: ['get'], validUntil });
    const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname, access: 'private', validUntil });
    return json({ ok: true, url: presignedUrl });
  }
  return fail(404, 'Yedekte böyle bir uç yok', 'not_found');
}
