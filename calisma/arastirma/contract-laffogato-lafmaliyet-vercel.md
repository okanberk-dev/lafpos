# LafPOS ↔ laffogato ↔ lafmaliyet: production readiness audit (read-only)

**What is still missing:** the code on all three sides matches, and the LafPOS Uzaktan 404 is fixed. Nothing works end to end in production yet because none of the shared keys are set. lafpos.vercel.app also has no Redis and no login password. Beyond those settings, LafPOS has several data-quality bugs and gaps (items 3–12 below). Item 3, product-level POS names merging sizes, sends wrong sizes to lafmaliyet.

Commits audited: lafpos `origin/main` 9d3820c, which is PR #4, merged by another session at 23:30 during this audit with the same tree as the branch tip 4d7dbc4. laffogato `origin/main` d1de10f. lafmaliyet `origin/main` 85650b4.

What was verified directly:
- **Production probes**, no credentials:
  - `laffogato.net/api/pos/orders/version` → 503 `not_configured`.
  - `laffogato.net/api/panel/menu` and `/api/panel/orders` → 401, so the panel key is set there.
  - `www.laffogato.net` → 308 redirect to the apex domain.
  - `ladmin.laffogato.net` and `lafmaliyet.vercel.app` `/api/panel/pos/urunler` → 503 `not_configured`.
  - `/api/pos/gun` answers OPTIONS with 204.
- **Signatures:** LafPOS's `server/lib/signature.ts` reproduces lafmaliyet's pinned vectors for `/api/pos/gun` (5ab02280…) and `/api/panel/pos/urunler` (4693defb…). The Uzaktan client and server agree.
- **Day payload:** I built a realistic day in a throwaway LafPOS database with every integration turned off. It included options, a comped item, a discount, Pluxee, cash with a tip, card, bank transfer, the karaoke room, a tab sale with a cash collection, cash in/out/handover and a short count. lafmaliyet's own schema from `origin/main` accepted the exact `POST /api/pos/gun` body. The uncounted variant (`countedCash`/`cashDiff` null) also passed. Product lines summed exactly to `zTotal`, and lafmaliyet's expected cash equals LafPOS's. Script: `/private/tmp/claude-501/-Users-okanberkmanavoglu-Downloads/36639f88-6c66-4e9d-babe-a70914f282d6/scratchpad/contract.mts`
- **What matches on all three sides:**
  - Signed text: timestamp, method, path, sorted query, body SHA-256; host left out.
  - Headers `x-laf-timestamp` (10 digits) and `x-laf-signature: v1=<64 hex>`; clock skew ±300 s everywhere; constant-time comparison.
  - Endpoint paths and methods.
  - Public menu shape; panel menu shape (`priceMinorL` is 0 for single-size items).
  - LafPOS writes only `{id,isActive,actor}`; the site returns 403 for price fields from LafPOS's key.
  - Order and stage shapes, including the `from` field and the 409 `stale` handling.
  - Amounts: kuruş inside LafPOS, TL with 2 decimals to lafmaliyet. Sizes M/L/TEK map to M/L/single on the site and slot M/L on lafmaliyet (single-size items use M on both).
  - 05:00 Istanbul business-day rule on both LafPOS and lafmaliyet.
  - Same date + same Z replaces the old record. 409 `z_conflict`, 400 and 413 are permanent in LafPOS; 401, 5xx and 503 are retried with backoff up to about 4.3 h.
  - lafmaliyet's proxy does not cover `/api/pos*`, and it has no redirect for `/api`.

## 1. Mismatches and gaps (most severe first)

1. **Blocker: the two LafPOS keys are not set on the site or on lafmaliyet.**
   - Site: `src/app/api/pos/orders/version/route.ts:48-54` and `src/lib/panel/signed-callers.ts:41-46,65-73` (a value equal to `KARAOKE_SYNC_SECRET` counts as unset). lafmaliyet: `src/lib/lafpos/request.ts:14-17` and `src/app/api/pos/gun/route.ts:20-21`.
   - LafPOS needs the matching values: `server/env.ts:56-63`, `.env.example:12-18`.
   - Fix: operator sets them (checklist below).

2. **Blocker for LafPOS Uzaktan: lafpos.vercel.app has no key, no password and no Redis.**
   - `api/uzaktan.ts:123` returns 503 before anything else, including health. `:147-148` needs the password. `:94-97` needs Redis.
   - Production `/api/health` → 503 `not_configured`.
   - Fix: set the env vars on the Vercel side.

3. **High: a product-level POS name merges M and L sales into one line with the wrong size.**
   - LafPOS: `server/services/menu.ts:154-158` (`posNameFor` returns `product.posName` for every size). `server/sync/lafmaliyet.ts:53-59` groups lines by name. `:70-77` takes the size from whichever row came first.
   - Reproduced: Espresso with a POS name, sold L×1 and M×5, arrived as one line `{slot:"L", qty:6}`.
   - lafmaliyet: `src/lib/lafpos/day.ts:153-157` (one line per name) and `:183-186` (matches the product by site item + size). Unique index `(date, pos_name)` at `src/server/db/schema.ts:2022`.
   - Result: costs and stock are booked to the wrong size.
   - Fix (LafPOS): group by site item + size + name, and make the POS name unique per size (add the size suffix, or a separate L name).

4. **Medium: a portion-counter sell-out reaches the site fire-and-forget.**
   - LafPOS: `server/sync/laffogato-orders.ts:224-230` ignores the response status and swallows errors; `server/jobs.ts:114-116` triggers it. There is no retry.
   - Site: `POST /api/panel/menu` can answer 401, 503 or 413 (`src/app/api/panel/menu/route.ts:100-111`).
   - Result: the app and website keep selling an item the till has sold out.
   - Fix (LafPOS): send availability writes through the outbox with retry, and show failures on the Entegrasyon page.

5. **Medium: sold-out state can diverge between the till and the site.**
   - Refilling portions (`server/routes/admin.ts:120`) sets the product active locally but never tells the site. It stays Tükendi online, and the next menu sync takes it off sale in LafPOS again (`server/sync/laffogato-menu.ts:245-251`).
   - Without the site key, Tükendi is local only (`laffogato-orders.ts:202-203`). The next change to the site menu silently puts it back on sale (`laffogato-menu.ts:229-231`), because the public menu lists only items on sale (site `src/lib/mobile/menu.ts:42-50`).
   - Fix (LafPOS): route refills through `setAvailability` (site first). Optionally keep a local "manually sold out" flag that menu sync respects.

6. **Low–medium: no periodic online-order pull while the version signal works.**
   - LafPOS pulls `/api/panel/orders` only when the version value changes (`laffogato-orders.ts:248-255`). The 5-minute pull runs only when the signal fails (`:258-261`).
   - Orders the site drops by time (forgotten after 24 h, ready pickups after 12 h: `src/lib/panel/orders-feed-core.ts:46-49,249-255`) do not change the version, so they stay open on LafPOS's bar screen.
   - Both docs promise "5 dk + ekran açılınca": site `docs/LAFPOS.md:115`, LafPOS `docs/03-ENTEGRASYON.md:69`. In code, opening the screen does not pull; refresh is a manual button only (`src/pages/OrdersPage.tsx:38`).
   - Fix (LafPOS): apply the same 24 h / 12 h staleness rules locally, plus an hourly pull at most. A 5-minute pull would stop the Neon database from sleeping.

7. **Low: LafPOS ignores `complete` and `version` in site responses.**
   - Site: `src/app/api/panel/orders/route.ts:93-96` (at most 200 orders; `complete:false` when cut) and `src/lib/panel/menu-link-core.ts:29-30`.
   - LafPOS closes every local online order missing from the list (`laffogato-orders.ts:131-140`). With more than 200 open orders, some would be wrongly closed.
   - Fix (LafPOS): skip the closing step when `complete` is false, and check `version === 1`.

8. **Low, latent: a service charge is in the Z total but not in the product lines.**
   - LafPOS: `shared/order-calc.ts:112,133` (service sits outside the per-line amounts), and `server/sync/lafmaliyet.ts:65` builds lines from those amounts only. The default service rate is 0 (`server/lib/settings.ts:13`).
   - lafmaliyet would then show less product sales than the Z total.
   - Fix (LafPOS): add a line `{posName:"SERVİS ÜCRETİ", siteMenuId:null, slot:null, isService:true}`. lafmaliyet already treats service lines as HİZMET (`day.ts:182`).

9. **Low: two POS names differing only in spaces reject the whole day.**
   - lafmaliyet collapses spaces before its duplicate check (`day.ts:30-35,153-156`). Two LafPOS names like "LATTE  MEDIUM" and "LATTE MEDIUM" give 400 `lines.N.posName`, which LafPOS treats as permanent (`lafmaliyet.ts:203-210`).
   - Fix (LafPOS): normalise names (trim, collapse spaces) in `posNameFor` and before grouping.

10. **Low, at cutover: the Z number chain restarts at 1.**
    - LafPOS starts at Z 1 (`server/services/days.ts:39`).
    - lafmaliyet's late-report approval card expects Z numbers to rise day to day (`src/lib/cash-report.ts:412-424`, used at `src/app/panel/onaylar/kasa-cards.tsx:291`). ModPOS is around 1200, so the first LafPOS days will show "Z no sırası tutmuyor".
    - Fix: a one-time "first Z number" setting in LafPOS, or lafmaliyet skipping the check across the ModPOS → LafPOS switch.

11. **Low: costs are pulled by hand only, and unmatched lines are invisible to LafPOS.**
    - LafPOS pulls costs only from a button (`server/routes/sync.ts:97-100`, `src/pages/admin/IntegrationAdmin.tsx:98`).
    - lafmaliyet counts matched lines internally but the 200 response leaves the count out (`src/server/lafpos/ingest.ts:61,83`).
    - Fix: pull costs at day close; lafmaliyet returns `matched`; LafPOS shows it.

12. **Docs and tests drift.**
    - LafPOS `docs/03-ENTEGRASYON.md:50-53` and §6 (`:215-221`) still list the site and lafmaliyet changes as unmerged, and say `KARAOKE_SYNC_SECRET` works temporarily. The site rejects that value as LafPOS's key (`docs/LAFPOS.md:143-145`), and the version endpoint answers 401 to the panel's key.
    - `03:81` says tables are matched by name inside the label or by site table code. The code matches only `siteTableCode === label` (`laffogato-orders.ts:64`), e.g. "Masa 4" (site `order-alerts-core.ts:172-181`).
    - `tests/signature.test.ts:16-17` does not pin lafmaliyet's two POS vectors. Add them.

## 2. Env and secrets (names only)

| Where | Variable | Needed for | Who generates | Status now |
|---|---|---|---|---|
| Vercel `laffogato` (Production, Sensitive) | `LAFPOS_SYNC_SECRET` | version signal, panel menu/orders/stage for LafPOS | Operator: `openssl rand`, ≥32 chars, must differ from `KARAOKE_SYNC_SECRET` | **Missing** (503) |
| Vercel `laffogato` | `KARAOKE_SYNC_SECRET`, `PANEL_URL` | Panel link (already used) | Existing | Set (panel routes 401) |
| Vercel `laffogato` | `LAF_DATA_CACHE` | Must not be `off`, or LafPOS pulls orders every 20 s | n/a | Not checked |
| Vercel `lafmaliyet` (Production) | `LAFPOS_SYNC_SECRET` | `POST /api/pos/gun`, `GET /api/panel/pos/urunler` | Operator; a value different from the site's | **Missing** (503) |
| Vercel `lafpos` | `LAFPOS_CLOUD_SECRET` | Café pushes and login tokens | Operator, ≥32 chars | **Missing** (503) |
| Vercel `lafpos` | `LAFPOS_UZAKTAN_PAROLA` | Owner login | Operator, ≥10 chars | Unknown |
| Vercel `lafpos` | `KV_REST_API_URL`, `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL`/`_TOKEN`) | Live snapshot, login rate limit | Upstash integration (Vercel › Storage), injected automatically; keep the default prefix | Unknown |
| Vercel `lafpos` (build) | `VITE_LAFPOS_UZAKTAN=1` | Remote UI | Already inside `vercel.json` buildCommand | OK |
| Café PC `C:\ProgramData\LafPOS\ayarlar.env` | `LAFFOGATO_URL` (=`https://laffogato.net`, not www; LafPOS refuses redirects, `signature.ts:61`), `LAFFOGATO_SYNC_SECRET` (= site's key), `LAFMALIYET_URL` (=`https://ladmin.laffogato.net`), `LAFMALIYET_SYNC_SECRET` (= lafmaliyet's key), `LAFPOS_CLOUD_URL` (=`https://lafpos.vercel.app`; preview URLs sit behind Vercel login), `LAFPOS_CLOUD_SECRET` | Whole loop | Copies of the values above | Not visible |
| Café PC | `TOKENX_*`; optional `LAFPOS_PUBLIC_URL` and `TOKENX_WEBHOOK_SECRET` (leave empty: polling); `LAFPOS_SECRET` (auto-created in `secret.key`) | Fiscal till device | Token (vendor) / LafPOS | Pending |

## 3. Why lafpos.vercel.app was 404, and the merge

**Cause:** old main (bdd18be, production `lafpos-gdj55awse`) had no `vercel.json` and no `api/` folder. Vercel's Vite preset served `dist/`, but `vite.config.ts:25` builds into `dist/web`. Proof: `/web/index.html` answered 200 while `/` and `/api/health` answered 404 `NOT_FOUND`; the build log lists only `dist/web/*`.

**Merge fixed it.** PR #4 (9d3820c, 23:30) brought `vercel.json:3-18`: output directory `dist/web`, `/api/*` routed to `api/uzaktan`, everything else to `index.html`, region fra1. Production `lafpos-3xvtd303o` is Ready with `λ api/uzaktan (11.45KB) [fra1]`. Now `/` and `/patron` answer 200 and `/api/health` answers 503 `not_configured`.

**Still open:**
- Set the env vars and Redis, then redeploy; env values only take effect in a new build.
- After that, `/api/health` must answer 200 `{ok:true,remote:true}`. That is the first proof that the `?yol=` path rebuild works through the rewrite. It cannot be checked on previews without credentials, since they redirect to Vercel login.
- Pin `engines.node` (now `>=22.11`, which Vercel says will jump to the next Node major automatically).
- Pick an Upstash region near fra1. The café pushes up to every 15 s (2 Redis commands each), so check the free plan's command quota.

## 4. Go-live checklist (in order)

1. Generate three separate secrets: site key, lafmaliyet key, cloud key. Keep the site key different from `KARAOKE_SYNC_SECRET`.
2. laffogato: add `LAFPOS_SYNC_SECRET` (Production, Sensitive) and redeploy from main. Check that `/api/pos/orders/version` now answers 401 instead of 503.
3. lafmaliyet: add `LAFPOS_SYNC_SECRET` (Production) and redeploy from main. Check that `ladmin.laffogato.net/api/panel/pos/urunler` answers 401.
4. lafpos: connect Upstash Redis with the default prefix, add `LAFPOS_CLOUD_SECRET` and `LAFPOS_UZAKTAN_PAROLA`, redeploy. Check `/api/health` → 200, and `/api/uzaktan/durum` without a token → 401.
5. Café PC: fill `ayarlar.env` with the six values in the table; the watchdog restarts the server. Make sure Windows time sync is on (±5 min).
6. LafPOS: check the Entegrasyon page, then run Menü › Siteyle eşitle (preview, then apply). Mark one item Tükendi and back, and confirm the app and site follow and the site's audit log shows `lafpos:<name>`.
7. Place a staff test order from the app or table QR. It should reach the bar screen within about 20 s; move it through the stages.
8. Close a day. lafmaliyet Kasa raporu should show the "LafPOS gün sonu" band; use "LafPOS'tan doldur". Days closed before the key existed were never queued: send them from Kasa › Z › Gönder.
9. Entegrasyon › Maliyetleri çek, then check lafmaliyet Satışlar for lines without a product match.
10. Open lafpos.vercel.app, log in, and check the snapshot age.
11. Until items 3, 8 and 10 are fixed: no product-level POS name on two-size products, keep the service rate at 0, and expect the Z-order warning at cutover.
12. Fix items 3–9 in LafPOS with tests (branch `claude/fix-senkron` exists with no commits yet), and update the docs (item 12).

**Work in progress elsewhere:** another session left an untracked `lafpos-fix/scripts/vercel/baglanti-kur.sh` that automates steps 1–4. It looks right. Two notes on it:
- Choose the Frankfurt (eu-central) region when Upstash asks.
- Its closing hint says lafpos `/api/health` should show 401, but it will be 200. It also has no lafmaliyet check URL; add `/api/panel/pos/urunler` → 401.

I edited nothing in the three repos; I only ran `git fetch`. My only files are the scratch script above plus `lm/` and `vcli/` in the same scratchpad folder.