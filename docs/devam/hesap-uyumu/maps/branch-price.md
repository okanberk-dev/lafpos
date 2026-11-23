# Per-branch selling price: map and design (read-only)

## 1. laffogato (the site, source of prices)

**menu_items** (`db/schema.sql:87-98`):
- Columns: `id` (mnu-xxxx), `"categoryKey"`, `"priceMinor"` int (kuruş, KDV dahil; M or the only size), `"isActive"`, `"updatedAt"` (ISO text).
- `"priceMinorL"` int, where 0 means single size (`schema.sql:648-649`).

**Branches**:
- The site has **no branches table**. Branches live in code (`src/lib/panel/branches.ts`):
  - `HOME_BRANCH="tuzla"` (:42)
  - `SITE_BRANCHES` env, default `tuzla,marina` (`siteBranches` :90)
  - `LAFPOS_BRANCHES`, default `marina`
  - `chooseBranch` (:126): 400 `invalid` or 403 `forbidden`, both with `field:"branch"`
  - `splitBranch` (:157) takes `branch` out of a write body
  - Branch id regex `^[a-z][a-z0-9-]{1,23}$`, the same as lafmaliyet's `branches_id_ck`
- `KARAOKE_BRANCH=HOME_BRANCH`: karaoke is Tuzla's only, and other branches read nothing.
- Migration `db/migrations/20261121150719_branches.sql` added:
  - a `branch` column on orders, cafe_tables and table_calls (default 'tuzla')
  - a **`menu_item_availability`** table, PK `("menuItemId",branch)` with `isActive/updatedAt/updatedBy`. This is the per-branch override pattern to copy.
- The pure core is `src/lib/panel/menu-availability-core.ts`. `itemAtBranch` (:63) returns `{...item, onMenu, isActive, updatedAt}`.

**Signing** (`src/lib/panel/karaoke-sync-core.ts`):
- Headers `x-laf-timestamp`, `x-laf-signature: v1=<hex>` (:40-41). Allowed clock skew is 300 s (:44).
- Signed text (`canonicalString` :116): ts, METHOD, path, sorted query, sha256(body). It is HMAC-SHA256 (`sign`, `signedHeaders` :134, `verifySignature` :154).
- Callers (`signed-callers.ts:58,87`): `panel` signs with `KARAOKE_SYNC_SECRET`, `lafpos` with `LAFPOS_SYNC_SECRET`.

**Signed menu endpoint** (`src/app/api/panel/menu/route.ts`), used by both LafPOS and ladmin:
- **GET** (:116-157) returns `{version:1, now, branch, items:[PanelMenuItem], writes:{expect:true, branch:true}}`.
  - `PanelMenuItem` (`menu-link-core.ts:56-80`) is `{id,name,categoryKey,categoryLabel,priceMinor,priceMinorL,isActive(at branch),onMenu,sortOrder,updatedAt}`.
  - The shape is a whitelist (`toPanelMenuItem` :101).
- **POST** (:159-298) takes `{id, priceMinor?, priceMinorL?, isActive?, actor, expect?, branch?}`.
  - The schema is `.strict()` (`panelMenuChangeSchema` :163), so an unknown field gets 400.
  - LafPOS's key sending a price gets 403 `forbidden` (:184-192).
  - Prices go to the item's own columns for **every branch** (:233-242, `setMenuItemSaleFields`), with `expect` making the write conditional.
  - The write is audited `panel:<actor>`. It expires `pub:menu`, which pings ladmin and moves LafPOS's marker.
- **This POST is the endpoint ladmin writes prices to.**
- `PANEL_MENU_WRITES` (`menu-link-core.ts:53`) is the capability flag. A new optional write field gets announced there.

**Public menu** `GET /api/mobile/v1/menu` (`src/app/api/mobile/v1/menu/route.ts`):
- `Cache-Control: public, s-maxage=60, swr=60` (:38).
- Strong ETag. The ETag is remembered under the menu marker (`rememberedRead`, scope `""`, :72-81), so it answers 304 without a DB read.
- `listMenuForMobile` (`src/lib/mobile/menu.ts:55`) always returns the **HOME_BRANCH (Tuzla)** prices and availability.

**`GET /api/pos/orders/version`** (LafPOS key only, per branch since 23 Nov, #298/#300):
- Returns `{version, karaoke, menu?}`.
- The `menu` value is the branch's digest (`branchMenuDigest` :85-109: item columns plus that branch's availability rows), cached under the global `pub:menu` marker (:149-183).

**Customer-facing pricing**:
- `resolveCafeLines(lines, rates, branch)` (`src/lib/admin/store.ts:4331`) prices an order from `menu_items.priceMinor`. Marina table orders pass `branch=marina`.
- The QR menu uses `listMenuForCustomerLive(branch)` (:7493).
- Option prices come from items mnu-0080/81/82 (S8, `OPTION_MENU_ITEM_IDS`).

**Cache tags**: `TABLE_TAGS` (`src/lib/cache/tags.ts:84-92`, `menu_item_availability: MENU`) and `TABLES` (`src/lib/db/index.ts:366`). A new table must be added to both.

**Migrations**:
- `scripts/db-migrate.mjs` applies `db/migrations/*.sql` in order, each in one transaction, recorded in `_migrations`. Files must be re-runnable, with no `_migrations` insert.
- `npm run db:bundle` regenerates `db/schema.sql` and `src/lib/db/schema-sql.ts`.

**Tests**:
- `npm run test:sube` runs vitest with `tests/sube/vitest.config.mts` (alias `@`, `server-only` shim). It needs **no Postgres**: pure modules, plus signed routes with the data layer mocked by `vi.mock("@/lib/admin/store" | "@/lib/admin/menu-availability")`. See `panel-routes.test.ts`.
- `db.test.ts` and `pre-branch-data.test.ts` run only when `TEST_DATABASE_URL` points at a local Postgres.
- These tests are not in CI. Node engines: 24.x.
- The docs still say "price is one for every branch": `docs/PANEL-MENU.md:286,303`, `docs/LAFPOS.md:101`.

## 2. LafPOS

**Where prices come from** (`server/sync/laffogato-menu.ts`):
- `fetchPublicMenu` (:82) reads the public menu with ETag; it sends **no ?branch**.
- `fetchPanelMenu` (:116) does a signed `GET /api/panel/menu?branch=${siteBranch()}` and checks `version` and `wrongSiteBranch`.
- `withPanelPrices` (:202) takes M/L prices from the **signed panel** when it is available. It is used in `previewMenu` (:237) and `applyMenu` (:367, writing `price/priceL` at :376).
- **Key finding:** once the site's branch GET returns Marina's effective price in `priceMinor/priceMinorL`, LafPOS picks it up with **zero price code change**.
- `siteBranch()` = `getSettings().branchId` (`laffogato-link.ts:22`, default `'marina'` in `server/lib/settings.ts:173`).
- `signedFetch` (`server/lib/signature.ts`) uses the same signature scheme.

**When it syncs** (`server/jobs.ts`):
- A 15-minute poll (`menuTick` :106), but only while a business day is open. A public-menu 304 means **no panel read**.
- The marker `site.menu.changed` (`laffogato-orders.ts:806` → `onSiteMenuChanged` :248) runs a forced sync at most once every 60 s.
- On day open, `onMenuDayOpened` (:258) runs one sync, forced only if `menuDirty`.

**Gaps for branch prices**:
- (a) A future effective-from instant is not a write, so neither the marker nor the ETag moves when it arrives.
- (b) When the panel read fails (`keep`, `panel=null`), `applyMenu` writes **public (Tuzla) prices** over Marina's (:367/:376).

**Storage and freezing**:
- `products.price`/`priceL` are kuruş, KDV dahil (`server/db/schema.ts:182-185`). There is one price per install.
- At line add, `base = sizePrice(p,size)` (`server/services/orders.ts:398`; `server/services/menu.ts:44`). It is frozen as `orderItems.basePrice` (the size list price before options, discount and happy hour; overrides change only `unitPrice`) and `unitPrice` (`schema.ts:549-553`, `orders.ts:463-464`).

**End-of-day body** (`server/sync/lafmaliyet.ts`, `buildDayPayload` :240):
```
{version:1, source:'lafpos', sube, date, z:{…}, lines:[{posName, siteMenuId, slot:'M'|'L'|null, qty, revenue(TL), isService}], ikram:[…], payments:[…], bankPos?}
```
- There is **no unit price.**
- `revenue` is net `lineNet` (after discount and happy hour), split between the main item and add-ons by list-price weights (`itemParts` :120).
- Lines are merged by `posName|siteMenuId|slot` (`mergeParts` :149), so one line can mix two prices on a change day.
- `revenue/qty` is therefore not a list price. ladmin already put "checking the till price from sales" out of scope for this reason (`lafmaliyet docs/FIYATLAR.md:22-23`).

**Tests**:
- `npm run typecheck && npm test` (vitest; server tests also run on sql.js/demo).
- Relevant files: `tests/lafmaliyet-gun.test.ts`, `site-menu.test.ts`, `menu-isareti.test.ts`, `site-sube-uyumu.test.ts`, `signature.test.ts`.
- Node `>=22.11 <25`.

## 3. ladmin (lafmaliyet)

**Schema** (`src/server/db/schema.ts`):
- `branches` table (:140; `kind`, `pos_source` modpos|lafpos|yok).
- `products` (:218): `price` is **double TL**; `site_menu_id`, `site_menu_slot` M|L, unique pair (:253).
- `product_prices` history (:278-302): `price_before, price, source(manual|suggestion|bulk|undo|site|create), on_site, batch_id, note, changed_by, changed_at`. It has **no branch**.
- `pos_daily_sales` (:2209): date, branch_id, pos_name, product_id, site_menu_id, slot, qty, revenue, unique (date,branch,pos_name).
- Owner decision of 4 Nov: "only the selling price and Satışta/Tükendi vary per branch" (`docs/SUBE.md:11`).
- `LAFPOS_BRANCH_ID="marina"` (`src/lib/lafpos/switch.ts:47`).

**Site write path**:
- `updateProductPrice`/`saveRecipe` → `writeSalePrice` (`src/server/prices/write.ts:40`) → `pushSaleChange` (`src/server/site-menu/push.ts:132`).
  - `pushSaleChange` uses `planPush` and `buildPushBody` (`src/lib/site-menu/push.ts:54`). It POSTs `/api/panel/menu` via `callSite` (`sync.ts:160`) → `signedSiteFetch` (`src/server/site-link.ts:30`, 8 s timeout) → `signedRequest` (`src/lib/karaoke/signature.ts:51`). The key is `KARAOKE_SYNC_SECRET` (`siteLinkSecret` :16).
  - It handles `expect` with 409 `stale` / 400 fallback, then `applyPushed` (:196) → `recordPriceChange` (`src/server/prices/record.ts:31`).
- Bulk: `applyBulkPrices` → `applyPriceBatch` (`src/server/prices/batch.ts:55`). `runSiteGroups` (`src/lib/prices/bulk.ts:326`) sends groups of 4, M then L, with a circuit breaker and a 40 s budget. Blocked rows come from `blockReason` (:156).
- Pull: `GET /api/panel/menu` with **no branch** (`sync.ts:179`), i.e. Tuzla/base. The snapshot is stored in `integration_state` under the key `menu_site_items`.
- `listSchema` (`src/lib/site-menu/schema.ts:76-81`) is a non-strict `z.object`, so new top-level fields are safe.
- Screen: `/panel/urunler/fiyatlar` (`page.tsx`, `bulk-editor.tsx`, `price-history.tsx`), documented in `docs/FIYATLAR.md`.

**Day ingest**:
- `parsePosDay` (`src/lib/lafpos/day.ts:190`). `lineSchema` (:77-85) is a non-strict `z.object`, so an unknown field is **stripped**: adding a field is safe for an old ladmin.
- `storePosDay` (`src/server/lafpos/ingest.ts:46`) writes the rows (:66-82).

**Tests**:
- `npm test` runs `tsx --test tests/*.test.ts`.
- `npm run test:db` needs `TEST_DATABASE_URL`, a local Postgres only. The CI job is `veritabani`.
- Relevant files: `lafpos.test.ts`, `lafpos-db.test.ts`, `fiyatlar.test.ts` (fails if any path writes a price without `recordPriceChange`), `site-menusu.test.ts`.
- Migrations: `npm run db:generate` (drizzle-kit, next file is `drizzle/0069_*`). Node 24.x.

## 4. Design proposal (minimal, additive)

### A. Site (first)

1. **Migration** `db/migrations/2026112xxxxxx_menu_item_branch_prices.sql`:
   ```
   menu_item_branch_prices(
     "menuItemId" FK → menu_items on delete cascade,
     branch (check regex),
     "priceMinor" int NULL (null = follow the site price from then on; else > 0),
     "priceMinorL" int not null default 0,
     "effectiveFrom" text (ISO UTC instant),
     "createdAt" text, "createdBy" text,
     PK("menuItemId", branch, "effectiveFrom")
   )
   ```
   - Add an index `(branch,"effectiveFrom")` and enable RLS.
   - The table is append-only, so it is its own history. The only allowed delete is a row whose `effectiveFrom` is still in the future (cancel).
   - Register it in `TABLES` and in `TABLE_TAGS` as `MENU`, then run `db:bundle`.
2. **Pure core** `src/lib/panel/branch-prices-core.ts`:
   - `priceAtBranch(item, rows, at)` → `{priceMinor, priceMinorL, from|null}`. The latest row with `effectiveFrom ≤ at`, else base. If the base L is 0, L is 0 (the site closed L; the same rule as `opensLargeSize`).
   - `nextPriceAt(rows, now)`.
   - `parseBranchPriceWrite`.
   - Data module `src/lib/admin/menu-branch-prices.ts` (list per branch, list all, insert, delete future).
3. **GET `/api/panel/menu?branch=X`** for X ≠ HOME:
   - `priceMinor`/`priceMinorL` become the **effective price at `now`**.
   - Each item gains `basePriceMinor`, `basePriceMinorL` and `priceFrom`.
   - The top level gains `nextPriceAt`.
   - For the `panel` caller, also add top level `branchPrices:[{id,branch,priceMinor,priceMinorL,effectiveFrom,createdAt}]` with all non-home rows.
   - The HOME read keeps `priceMinor` as the base, so ladmin's `applyPlan` is unchanged.
4. **POST `/api/panel/menu`** gets an optional `branchPrice:{priceMinor|null, priceMinorL, effectiveFrom}` (or `{effectiveFrom, cancel:true}`):
   - Requires `branch` ≠ HOME and the `panel` caller. LafPOS gets 403 `field:"branchPrice"`.
   - Cannot be combined with `priceMinor`, `priceMinorL` or `isActive`.
   - `effectiveFrom ≥ now−5min` (no retroactive change), at most 90 days ahead.
   - The ids in `OPTION_MENU_ITEM_IDS` are refused (400 `id`): LafPOS takes option prices from the public `customization`.
   - A duplicate PK gets 409 `stale`.
   - The write is audited `panel:<actor>` with `{branch,effectiveFrom}` and announced as `writes.branchPrice:true`.
5. **Version digest**: `branchMenuDigest` includes the branch's price rows (future ones too).
6. **Customer pricing at a branch**:
   - `resolveCafeLines(branch)` and `listMenuForCustomerLive(branch)` apply `priceAtBranch`, so Marina QR orders are priced and shown at Marina's price.
   - Recommended in the same PR: public `/api/mobile/v1/menu?branch=` (known branches only).
     - The remembered-read scope becomes the branch.
     - Remember a `validUntil=nextPriceAt` and treat the cache entry as a miss once it has passed.
7. **Docs**: `PANEL-MENU.md`, `LAFPOS.md`, `DATABASE.md`.

### B. LafPOS (small)

1. **`fetchPanelMenu`**: read the optional `nextPriceAt` and keep it in sync state.
2. **`jobs.ts`**:
   - After a sync, `scheduleMenuSync(nextPriceAt+5s, force=true)` while the day is open.
   - In `menuTick` and `onMenuDayOpened`, force a sync if a `nextPriceAt` has passed since the last sync.
   - This costs one signed GET per scheduled change, so it keeps AGENTS rule 6.
3. **`applyMenu`/`previewMenu`**: when `rule.keep` (signed panel failed) or no panel while `siteSigned()`, do not overwrite **existing** linked products' prices with public (Tuzla) prices.
4. **Optional**: `fetchPublicMenu` adds `?branch=`.
5. **`lafmaliyet.ts`**:
   - `Part`/`SaleLine` carry `listPrices: Map<kuruş, qty>`. The main part uses `i.basePrice`; add-ons use `op.price`.
   - The body gets `lines[].listPrices?: [{price: TL, qty}]` (optional, at most 20, no names, so KVKK-clean).
   - Update §4 of `docs/03-ENTEGRASYON.md`.
6. **No UI change**, so e2e is not required.

### C. ladmin

1. **Parse and store list prices**: `lineSchema` gets `listPrices: z.array(z.object({price: tl, qty})).max(50).optional().catch(undefined)`.
   - Migration (drizzle generate): `pos_daily_sales.list_prices jsonb null`, written in `storePosDay`.
   - Optional: `product_prices` gets nullable `branch_id` and `effective_from` so the Geçmiş tab shows branch rows.
2. **Read branch prices**: `listSchema` accepts `branchPrices`. `syncSiteMenu` stores them in `integration_state` under `menu_site_branch_prices`, like `menu_site_items`.
3. **Write branch prices**:
   - `src/server/prices/branch-write.ts`: a `pushSaleChange` variant with body `{id, branch, branchPrice, actor}`. One body per site item carries M and L together.
   - Bulk reuses `runSiteGroups`.
   - Fiyatlar › Toplu değiştir gets a "Şube" selector (Tümü/base vs Marina) and "Geçerlilik", defaulting to the next business day at 05:00 Istanbul.
   - `blockReason`: an option item, or the site not announcing `branchPrice`.
4. **"Eski fiyattan satılanlar" report and "Uygulandı" status** (no endpoint):
   - Pure `src/lib/prices/branch.ts` with `effectivePriceAt(rows, base history, t)`.
   - Day window `[D 05:00, D+1 05:00)` Istanbul (`businessDate`, `src/lib/cash-report.ts:179`).
   - For each Marina `pos_daily_sales` row with `siteMenuId+slot+list_prices`:
     - expected = the price in force at the window start
     - a change inside the window marks a "geçiş günü" (both prices accepted)
     - otherwise qty at a price ≠ expected counts as "eski fiyat" (shown as qty, the price, and a loss of (expected−price)×qty)
   - Per change, the status is one of:
     - **Bekliyor**: no sale yet after `effectiveFrom`
     - **Uygulandı · <first day>**: the first day after with qty at the new price
     - **Uygulanmadı**: only the old price after
     - **Bilinmiyor**: no `list_prices` (old LafPOS). Never inferred from revenue/qty.
   - Loader `src/server/data/branch-prices.ts`.
   - UI: a new Fiyatlar tab `?sekme=sube` and a row on the product card's price-history card.
5. **Docs**: `FIYATLAR.md`, `SITE-MENU.md`, `LAFPOS.md`, `SUBE.md`.

## 5. Risks

- **Effective instant with no write**: nothing moves at that moment. It is handled by LafPOS `nextPriceAt` scheduling plus `validUntil` on the public ETag. If LafPOS is offline or the day is closed, it applies at the next day open (the report flags it).
- **Panel-read failure reverting to Tuzla prices** (laffogato-menu.ts:367): fix B3 is mandatory.
- **App table orders**: the app shows Tuzla prices from `/api/mobile/v1/menu`, while a Marina table order is charged the Marina price. A wallet payment gets 409 `totalChanged`; a card payment shows the real total first. lafmobil should read `?branch=<table.branch>`.
- **Option items' prices stay site-wide** (refused in v1).
- **The legal price-list date** (`settings."menuPricesEffectiveDate"`, Fiyat Etiketi Yönetmeliği m.5) is single-site. Marina's printed list needs its own date (out of scope; flag it).
- **ladmin economics stay base-priced**: önerilen fiyat, zam etkisi and cost ratio use `products.price`.
- **Transition day**: orders already open keep their frozen line prices.
- **Order of rollout**: site first, then ladmin writes only after the site announces `writes.branchPrice`, then LafPOS. Old LafPOS and old ladmin keep working; the new fields are optional and ignored by old readers.

## 6. Testing

- **laffogato**:
  - `npm run test:sube`, with new `tests/sube/branch-prices.test.ts` (pure core: effective, future, L-closed, null = base).
  - Extend `panel-routes.test.ts`, mocking `@/lib/admin/menu-branch-prices`: GET Marina price vs Tuzla base, `nextPriceAt`, POST refusals (lafpos 403, home branch, past instant, option id), digest change.
  - Postgres cases in `db.test.ts`: order pricing at a Marina table, run with `TEST_DATABASE_URL`.
  - Also `npm run typecheck`, `npm run lint`, `npm run db:bundle`.
- **LafPOS**:
  - `tests/lafmaliyet-gun.test.ts`: `listPrices` from `basePrice`, mixed prices on one merged line, add-ons.
  - `site-menu.test.ts`: no price overwrite when the panel fails.
  - `menu-isareti.test.ts`: forced sync scheduled at `nextPriceAt`, night → day open.
  - Then `npm run typecheck && npm test`.
- **ladmin**:
  - `tests/lafpos.test.ts`: `listPrices` parsed, malformed one dropped while the day is still accepted.
  - New `tests/sube-fiyat.test.ts`: the classifier across window and transition cases.
  - `lafpos-db.test.ts`: `list_prices` stored.
  - `fiyatlar.test.ts`: branch write path, block reasons.
  - Then `npm test` and `npm run test:db`.
