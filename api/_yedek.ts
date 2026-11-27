/**
 * Bulut yedeği (server/sync/yedek.ts): kasa şifreli yedeğini kısa süreli imzalı adrese doğrudan yükler ve oradan
 * indirir; Blob anahtarı (BLOB_READ_WRITE_TOKEN, Vercel › Storage'daki özel yedek deposu; adı shared/eski-adlar.ts `BLOB_DEPOSU`) yalnız burada. Kasanın
 * istekleri ASILPOS_CLOUD_SECRET ile imzalı. Yedekler `yedek/<dükkân>/<an>.lpy`; dükkân başına son 30 yedek kalır.
 * Dosyalar kasada şifrelenir (anahtar buraya hiç gelmez): Blob'u açan biri de içeriği okuyamaz.
 */
import { del, issueSignedToken, list, presignUrl } from '@vercel/blob';

export interface YedekDeps {
  signed: (body: string) => boolean;
  shop: string;
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
  if (!deps.signed(raw)) return fail(401, 'İmza geçersiz', 'bad_signature');
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
  // onun yedekleri: aynı ortak anahtarı bilen kasa zaten bütün dükkânların sahibidir
  if (path === 'uzaktan/yedek/liste') {
    const shop = typeof body.dukkan === 'string' && SHOP_RE.test(body.dukkan) ? body.dukkan : deps.shop;
    const shops = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: 'yedek/', mode: 'folded', cursor, limit: 1000 });
      for (const f of page.folders ?? []) shops.add(f.replace(/^yedek\//, '').replace(/\/$/, ''));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return json({ shop, dukkanlar: [...shops], yedekler: await backupsOf(shop) });
  }

  // İndirme: yalnız yedek klasöründen, 15 dakikalık imzalı GET
  if (path === 'uzaktan/yedek/indir') {
    const pathname = String(body.pathname ?? '');
    if (!/^yedek\/[a-z0-9-]{1,40}\/\d{8}-\d{6}\.lpy$/.test(pathname)) return fail(400, 'Yedek adı anlaşılamadı', 'bad_body');
    const validUntil = Date.now() + URL_MS;
    const token = await issueSignedToken({ pathname, operations: ['get'], validUntil });
    const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname, access: 'private', validUntil });
    return json({ ok: true, url: presignedUrl });
  }
  return fail(404, 'Yedekte böyle bir uç yok', 'not_found');
}
