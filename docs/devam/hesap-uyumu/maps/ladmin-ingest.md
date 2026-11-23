# lafmaliyet side of `POST /api/pos/gun`: reader (Faz 2) and response (Faz 3)

Repo: `/home/user/lafmaliyet` (HEAD 7740898). Every path below is in that repo unless it says otherwise.

## 0. Where the task is wrong vs the code
- **Money on the wire is TL, not kuruş.** Amounts are TL with two decimals. `tl` and `signedTl` round them with `round2` (`src/lib/lafpos/day.ts:23-27`), and they are stored as TL in `doublePrecision` and jsonb. LafPOS converts with `toTL()` (`/home/user/lafpos/server/sync/lafmaliyet.ts:240-336`). Only `GET /api/panel/pos/urunler` uses kuruş (`costMinor`). The golden fixture is TL too (`zTotal: 2485`).
- **What LafPOS reads from the 200 is more than "ok, date".** It first checks `ok === true && date === sentDate` (`/home/user/lafpos/server/sync/lafmaliyet.ts:538`). It then reads `lines`, `matched`, `unmatched`, `counted` and `switchDay` through `answerShape` (`:413-430`, a `z.object`, so unknown keys are stripped and `nextOpening` is ignored safely). `PERMANENT = {400,409,413,422}` (`:441`) parks those statuses with no retry.
- **"Soru 5" is a single line.** It is `docs/LAFPOS.md:244`, inside the section "Gün içinde çıkan: panelin Kasadan çıkanlar'ı kaynak (denetim E-35)" (`:241-251`). It is not a block at 237-247.
- **No zayi is written to `waste_entries` today.** LafPOS zayi arrives as `ikram[]` rows whose reason starts with `"Zayi: "`. It is classified when read (`lafposLineKind`, `src/lib/lafpos/ikram.ts:44`) and never written into `waste_entries`.
- **"net" already has a meaning in Satışlar.** It means VAT-exclusive (KDV hariç): `engine.ts:1374` computes `revenue/(1+kdv)`, and `sales-client.tsx:1153` says "Altında KDV hariç net ciro". A new "net after discount" column needs a different name. LafPOS `lines[].revenue` is already after discount (`lineNet`, LafPOS `salesOf`).
- **None of the proposed fields exist yet on either side**: `gross`, `isAddon`, `offDevice`, `refunds`, `kind`, `personKind`, `errorCode`, `listValue`, `ikramTotal`, `odenmezTotal`, `zayiTotal`, `vat[]`, `openedAt`, `closedAt`, `revision`, `nextOpening`.
- **Stale docs and comments:**
  - `docs/LAFPOS.md:105` gives the lock key as `lafpos-gun:<gün>`. The code uses `` `lafpos-gun:${LAFPOS_BRANCH_ID}:${date}` `` (`src/server/lafpos/ingest.ts:50`).
  - `docs/LAFPOS.md:111` says `(date,pos_name)` is unique. The index is `(date,branch_id,pos_name)` (`schema.ts:2231`).
  - The comment in `route.ts:20` lists the 200 body without `matched`/`unmatched`.

## 1. Reader pipeline as it is today
1. **Route** (`src/app/api/pos/gun/route.ts:25`, `POST`):
   - no secret → 503;
   - `content-length > POS_DAY_MAX_BYTES` (256*1024, `day.ts:21`) → `noteUnverified` + 413;
   - otherwise `handlePosDay`;
   - on a 200 with `counted`, it calls `after(runLafposDayEnd(...))` (`:45-48`). That writes the cash report and sends the email **after** the response.
2. **`handlePosDay`** (`src/server/lafpos/status.ts:141`) wraps `receivePosDay`:
   - on 200 it adds `counted = isLafposDay(date, switchDay)` and `switchDay` (`:160-170`);
   - it records rejections and the 401/413 counter.
3. **`receivePosDay`** (`ingest.ts:123`) runs:
   - `checkLafposRequest` (`src/lib/lafpos/request.ts:174`): 503, then the byte size via `Buffer.byteLength` (413), then `verifySignature` from `src/lib/karaoke/signature.ts` (timestamp, method, path, sorted query, sha256 of the body, ±5 min);
   - `parsePosDay`;
   - the `sube` check: `sube !== LAFPOS_BRANCH_ID` → **409 `{error:"wrong_branch", sube, expected}`** (`:133`);
   - `storePosDay`;
   - z_conflict → **409 `{error:"z_conflict", date, zNo}`** (`:135`);
   - success → 200 `{ok, date, lines, matched, unmatched}` (`:136`).
4. **`parsePosDay`** (`day.ts:190`):
   - strict JSON (otherwise `field:"body"`);
   - `posDaySchema.safeParse`, returning the path of the first issue;
   - `date > businessDate(now)` → `field:"date"`;
   - logs a warning for an unreadable `bankPos`;
   - rejects a duplicate `posName` with `lines.i.posName`.
5. **`storePosDay`** (`ingest.ts:46`), all in one transaction:
   - `pg_advisory_xact_lock`;
   - reads the stored row for `(date, LAFPOS_BRANCH_ID)`; if `stored.z.zNo !== day.z.zNo` it returns `{ok:false, zNo}` (`:56`);
   - resolves products with `resolvePosLine` (`day.ts:233`);
   - upserts `pos_day_reports` (`bankPos` is kept when absent, `:86`);
   - deletes and re-inserts the day's `pos_daily_sales`;
   - runs `onLafposDaySaved` (closed-day clearing).

**Schema** (`day.ts`):
- `posZSchema` (`:45-75`). Late-added fields are optional: `cashIn`, `expectedCash`, `cardTips`, `cardCollections`.
- `lineSchema` (`:77`): `posName`, `siteMenuId`, `slot`, `qty`, `revenue`, `isService`.
- `ikramSchema` (`:87`): `reason` is trimmed to 200 characters.
- `paymentSchema` (`:101`).
- `bankPosSchema` (`:123`): an unknown `status` becomes `"unknown"`; `acquirers` max 50.
- `posDaySchema` (`:155-170`):
  - `version: z.literal(1)`, `source: "lafpos"`;
  - `sube` is optional, regex `^[a-z][a-z0-9-]{1,23}$`;
  - `lines.max(3000)`, `ikram.max(2000)`, `payments.max(200)`;
  - `bankPos` uses `.nullable().optional().catch(undefined)`.

Zod is ^4.6.7, so `z.object` strips unknown keys. Any new key is silently dropped today.

**Size limit.** A real line is about 110 bytes, so 3000 lines ≈ 330 KB. The 256 KB cap therefore binds before the array caps. Adding `gross` and `isAddon` (about 30 B per line) reduces the headroom.

**Re-parsing stored jsonb.** Stored jsonb is parsed again with the same schemas:
- `src/server/lafpos/gun-sonu.ts:78,80,245`
- `src/server/data/lafpos-day.ts:84,104,120`
- `src/server/data/branch-day.ts:66`
- `src/server/data/cash-reports.ts:385`
- `src/server/data/lafpos-ikram.ts:21,55`
- `src/server/data/commission.ts:141`

So **every new field must be `.optional()`** (and nullable where it makes sense). A required field would make each older stored day fail `safeParse`, and the day would be skipped silently.

**Branch and switch day.**
- `LAFPOS_BRANCH_ID = "marina"` (`src/lib/lafpos/switch.ts:47`).
- Switch-day setting key `lafposGecisGunu` (`switch.ts:16`). It is read by `readLafposSwitchDay` (`src/lib/constants.ts:58`, minimum `LAFPOS_SWITCH_MIN = "2026-10-01"` at `:43`).
- `isLafposDay` (`switch.ts:34`), `branchSwitchDay` (`:59`).
- Days before the switch day are stored as trial days and never counted.

## 2. Storage (`src/server/db/schema.ts`)
- **`pos_daily_sales`** (`:2206-2232`): `date`, `branch_id`, `pos_name`, `product_id`, `site_menu_id`, `slot`, `qty`, `revenue`, `is_service`, `lafpos_service`, `created_at`. Unique on (date, branch, pos_name).
- **`pos_day_reports`** (`:2238-2257`): PK (date, branch_id); jsonb `z`, `payments`, `ikram`, `bank_pos`; `source`; `received_at`. There is no revision column: each push overwrites the previous one, and only `received_at` changes.
- **`lafpos_day_ends`** (`:2263`): automation state. Its `dayHash` (`src/lib/lafpos/gun-sonu.ts` `dayHash` = FNV over `[z, payments, ikram]`) changes when new z or ikram keys appear, which triggers one extra "düzeltildi" email per resent day.
- **`cash_reports`** (`:1381-1458`) with `okc_z_no` (text), `okc_vat` (jsonb `OkcVatLine{rate,total,vat}`, `src/lib/okc-z.ts:99`) and `revision`.
- **`cash_report_revisions`** (`:1466-1490`): the pattern a version-history table should copy.
- **`waste_entries`** (`:1551-1588`):
  - `kind zayi|ikram`, `product_id`/`ingredient_id`, `qty`, `unit`, `factor`, `reason`;
  - `created_by_name` is NOT NULL;
  - `client_key` is unique;
  - there is no source or lafpos column.
- **`modpos_cash_sheets`** (`:2293-2325`): `revision` plus a `previous` jsonb. This is the other history pattern.
- **Removing a day:** `removeLafposDay` (`src/server/lafpos/admin.ts:56`) deletes both tables. It is the z_conflict fix path.

## 3. Per-item: CURRENT behaviour → CHANGE → WHERE → how to reproduce today

**Repro base for all items.**
- Pure test: `tests/lafpos.test.ts`, with helpers `sample()` (`:68`), `read`, `NOW`, `SECRET`, and the golden test at `:676-715`.
- Add a field to `sample()` or to the golden body, call `parsePosDay`, and assert `!("x" in r.data…)`. That passes today and proves the field is stripped.
- DB test: `tests/lafpos-db.test.ts`, with `push()` (`:50`), `line()` (`:77`), `send()` (`:79`) and `rowsOf()` (`:85`).

**`lines[].gross` / `lines[].isAddon`**
- **Current:** both are stripped; `pos_daily_sales` has only `revenue` (net of discount, VAT included). Add-ons can already be recognised by `siteMenuId` mnu-0080/0081/0082 (`OPTION_PRODUCTS`, `src/lib/site-sales/calc.ts:147`).
- **Change:**
  - add both to `lineSchema` as optional;
  - add columns `gross double precision` and `is_addon boolean` (nullable or defaulted) with a migration;
  - write them in the `rows` map (`ingest.ts:67-83`);
  - aggregate in `loadLafposMonthSales` (`src/server/data/lafpos-sales.ts:28`, the `sum(d.revenue)` select at `:44-52`);
  - add to `LafposMonthLine` (`src/lib/lafpos/sales.ts:23`) and `SalesLine` (`src/lib/calc/types.ts:227`);
  - add the columns in `src/app/panel/satislar/sales-client.tsx` and `page.tsx`.
- **Consistency checks:**
  - LafPOS day: Σnet = `z.zTotal`. Today no such check exists anywhere.
  - ModPOS day: Σgross − discount = Z. Today only `modposOverZText` (`sales.ts:182`, 5% margin) exists, and it states "Liste ürün cirosudur (indirimden önce), Z indirimden sonra".
  - Put the new check in `lafposMonthNotes` warnings (`sales.ts:195`) or in the settings card.
- **Repro:** `tests/lafpos-satis.test.ts` (pure) or `lafpos-satis-db.test.ts`.

**`offDevice` and `refunds[]`**
- **Current:** both are dropped. LafPOS sends no refunded payments: `isNull(refundedAt)` is used only for `cardTips`.
- **Change:** an optional jsonb column on `pos_day_reports` (migration) or a nested optional field in `z`. Readers would be the cash-day view (`src/server/data/lafpos-day.ts`) and the email (`src/lib/lafpos/gun-sonu.ts`).

**Cancelled but already-prepared items → zayi**
- **Current:** LafPOS builds `ikram[]` only from closed orders with `voided=false` (LafPOS `buildDayPayload` `:247-252`). lafmaliyet turns `reason ^Zayi:` into `kind:"zayi"` (`ikram.ts:44`), loads it in `loadLafposIkram` (`src/server/data/lafpos-ikram.ts:37`), and feeds it into the engine's `countedWaste` with `source:"lafpos"` (`src/lib/calc/engine.ts:1036-1041`) for material consumption, and into Zayi/kasa through `dayWaste` (`src/server/data/waste.ts:116-145`).
- **Change, simplest:** LafPOS emits these items as `ikram[]` rows with reason `"Zayi: İptal (hazırlanmıştı)"`. No lafmaliyet change is needed.
- **Alternative:** insert into `waste_entries`. That needs a source or idempotency column (re-push must delete and re-insert per date and branch), `createdByName` set to "LafPOS (otomatik)", and the per-branch rules in `src/server/waste/core.ts`. Not recommended.

**`ikram[].kind` / `personKind`**
- **Current:** both stripped; the kind comes from the reason prefix (`compReasonText` in LafPOS `shared/comp.ts`).
- **Change:** add both to `ikramSchema` as optional (stored in jsonb, no migration). `lafposLineKind` prefers `kind` and falls back to the prefix. Show them on the Zayi page and in `LafposIkramLine` (`ikram.ts:23`).
- **Repro:** `tests/lafpos-ikram.test.ts`.

**`bankPos.errorCode`**
- **Current:** stripped. Because of `.catch(undefined)`, a malformed `errorCode` after adding it would drop the whole comparison silently.
- **Change:** `bankPosSchema` (`day.ts:123`) plus `pavoView` (`src/lib/lafpos/bank-pos.ts:48`). No migration.

**`z.okcZNo`**
- **Current:** `cash_reports.okc_z_no` comes only from the yazarkasa photo or the form. `AUTO_FIELDS` (`src/lib/lafpos/gun-sonu.ts:16-34`) excludes okc fields, and `autoMissing` always lists `bankPos`.
- **Change:** add it to `posZSchema` as an optional string, keeping leading zeros. Add an `okcZNo` auto field and map it in `autoValuesOf` (`:79`). Note that `writeCashReport` recomputes `okcServerColumns` when `okcZNo` changes (`src/server/cash/report-store.ts:341`).

**`z.listValue`, `ikramTotal`, `odenmezTotal`, `zayiTotal`**
- **Current:** lafmaliyet derives `ikramValue`, `zayiValue` and `listValue` itself (`waste.ts:96-145`) and compares `offRevenue` with `listValue` (`lafposIkramCheck`, `ikram.ts:128`; used in `src/server/notify/cash-report-template.ts:169`).
- **Change:** optional z fields. Use them as LafPOS's own totals in that check.

**`z.vat[]`**
- **Change:** an optional array shaped like `OkcVatLine`.

**`z.openedAt` / `closedAt`**
- **Change:** optional ISO strings. The email currently uses `received_at`.

**`revision` and corrections → version history**
- **Current:**
  - same date and same zNo: the previous body is lost (the overwrite is asserted in `lafpos-db.test.ts:186`, the 409 case at `:229-269`);
  - a different zNo: 409 and nothing is written;
  - `wrong_branch`: 409.
- **Change:**
  - add `revision: z.number().int().min(1).optional()` and an optional `correction`;
  - add a new table, e.g. `pos_day_revisions (id, date, branch_id, revision, body jsonb, received_at)`, inserted inside `storePosDay`'s transaction for every accepted body;
  - decide whether `removeLafposDay` keeps or removes the history.
- **Repro:** send the same day twice in `lafpos-db.test.ts` and assert that a history row exists. That fails today because no table exists.

## 4. Faz 3: the response
- **Current 200 from `handlePosDay`:** `{ok, date, lines, matched, unmatched, counted, switchDay}`.
- **Exact-body assertions that break if a key is added:**
  - `tests/lafpos-durum-db.test.ts:129,132,133,209` (deepEqual through `handlePosDay`);
  - `tests/lafpos-db.test.ts:232,251` (deepEqual on the `receivePosDay` body).
  - Add `nextOpening` in `handlePosDay` (`status.ts:168-170`) so that `receivePosDay` tests stay unchanged.
- **Devir (carry-over):**
  - It is never stored. It is `countedCash − handedOver` of that day's `cash_reports` row: `computeCash.carryOver` (`src/lib/cash-report.ts:153`), `previousCarryOver` (`src/server/data/cash-reports.ts:178`).
  - The next day's opening is pre-filled from it (`src/app/panel/kasa/cash-form.tsx:152`).
  - It is edited by editing the report's counted or handed-over amounts:
    - path: `submitCashReport` (`src/server/actions/cash-report.ts:54`) → `saveCashReport` (`src/server/cash/report-store.ts:423`) → `writeCashReport` (`:259`), which writes `cash_report_revisions`;
    - staff correction requests: `src/server/cash/requests.ts`;
    - the automatic report: `writeAutoReport` (`src/server/lafpos/gun-sonu.ts:105`, with `mergeAuto` keeping manual edits).
  - The automatic report sets `handedOver: 0` and `countedCash: z.countedCash` (`src/lib/lafpos/gun-sonu.ts:96-100`).
- **Proposed `nextOpening`:** if a `cash_reports` row exists for (date, marina), return `{amount: countedCash − handedOver, source: "kasa_raporu"}`; otherwise `{amount: z.countedCash, source: "lafpos"}`, or null when not counted.
- **Caveat:** on the first push the automatic report is written in `after()`, after the response. A ladmin correction usually happens after day D's push but before day D+1 opens, so the response alone cannot carry it. LafPOS would need a re-push or a signed GET.
- **LafPOS side:** extend `answerShape`/`DayAnswer` (`/home/user/lafpos/server/sync/lafmaliyet.ts:396-430`).

## 5. Signed GET pattern and expense categories
- **The only signed GET:** `src/app/api/panel/pos/urunler/route.ts` → `servePosProducts` (`src/server/lafpos/products.ts:21`), which calls `checkLafposRequest` with `method:"GET", body:"", maxBytes:0` and returns `{version, now, items}`.
  - `/api/*` is outside the proxy matcher (`src/proxy.ts:53`), so there is no session.
  - Signature vectors are in `tests/lafpos.test.ts:~93-101`. The path is part of the signature, so a new endpoint needs its own vector.
- **Expense categories** are DB rows, not constants:
  - `expense_categories` (`schema.ts:742`: `name`, `section`, `panelGroup`, `invoiceCategory`, `monthly`, `active`, `sortOrder`, `taxDoc`);
  - managed by `saveExpenseCategory` (`src/server/actions/expenses.ts:223`);
  - cash-out expenses link to them through `expense_entries.cash_out_id` and `category_id` (`src/server/cash-outs/write.ts:49,133`).
- `INVOICE_CATEGORIES` (`src/lib/constants.ts:122`) are invoice categories, a separate list.
- There is no endpoint that serves expense categories to LafPOS. LafPOS sends only `cashOut` and `handedOver` totals (Soru 5, `LAFPOS.md:244`).

## 6. Docs structure
**`docs/LAFPOS.md`** (680 lines):
- `### Gün sonu: POST /api/pos/gun` at `:59`, with the **field table at `:63-73`**, the whitelist, check order and 200 example at `:75-95`, and "Saklanan" plus migrations at `:110-119`;
- Günlük satış `:120`;
- Kasa raporu `:188` (E-09 `:226`, E-35 / Soru 5 `:241-251`, bankPos `:252`, card `:260`, mapping `:286`);
- Komisyon `:316`;
- İkram `:328`;
- Ürün maliyetleri `:354`;
- Gün sonu otomasyonu `:371`;
- Geçiş günü `:414` (Şubeler `:446`);
- Durum ve onarım `:529`;
- Dosyalar `:642`.

**`docs/SUBE.md`** (315 lines):
- registry table at `:16`;
- "LafPOS'a geçiş günü şubenin kasasınındır" at `:252`.

**Docs tests:** `tests/belgeler.test.ts:178` only checks that KALAN-ISLER mentions `docs/LAFPOS.md`.

## 7. Migrations and DB tests
- **Generate:** `npm run db:generate -- --name <ad>` (`drizzle-kit`; `package.json:13`). Never hand-written SQL.
- **Latest migration:** `drizzle/0068_pavo_karsilastirma.sql` (journal idx 68). The next one is 0069.
- **R2** (`docs/planlar/KALAN-ISLER.md:657`; `docs/DEPLOY.md:315-328`):
  - generate right after merging main;
  - if main moved: restore `drizzle/meta/_journal.json` from main, delete the branch's `00NN_*.sql` and `meta/00NN_snapshot.json`, then regenerate;
  - one migration branch merges at a time;
  - never regenerate or edit an applied migration.
- **Journal tests:** `tests/migrations.test.ts` requires strictly increasing `when` values, sequential tags and a snapshot for each entry.
- **jsonb-only additions need no migration:** new z, ikram or bankPos keys. New `pos_daily_sales` columns, a new `pos_day_reports` column, or a revisions table do need one.
- **DB tests** (skipped by `npm test`; run with `TEST_DATABASE_URL=postgres://localhost/… npm run test:db [-- files]`, `scripts/test-db.ts`):
  - LafPOS files: `tests/lafpos-db.test.ts` (env `LAFPOS_TEST_DATABASE_URL`, days in 2029-03), `lafpos-durum-db`, `lafpos-gun-sonu-db`, `lafpos-kasa-db`, `lafpos-satis-db`, `lafpos-komisyon-ikram-db`, `lafpos-metin-db`;
  - helpers: `tests/helpers/subeler.ts` (`seedBranches`, `LAFPOS_SUBE`, `MODPOS_SUBE`);
  - pattern: stub `server-only` with `require.cache`, then `createDb(URL, 4)`;
  - always give `assert.ok` a message (`scripts/test-db.ts` header explains the hang).
- **Golden fixture:** `tests/fixtures/lafpos-gun.golden.json` is byte-identical to `/home/user/lafpos/tests/fixtures/lafmaliyet-gun.golden.json` (verified with diff). Regenerate it in LafPOS and copy it over.
