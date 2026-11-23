# Cash moves line by line (LafPOS → ladmin "Kasadan çıkanlar") and expense categories: code map and design

## 1. LafPOS: what exists today

**Model.** `server/db/schema.ts:341-356` `cash_movements` has these columns: `id` text PK (ULID), `dayId` → business_days, `kind` `'harcama'|'teslim'|'giris'`, `amount` int kuruş, `description` text (default `''`), `userId` → users, `createdAt` epoch ms. Index on `day_id`.
- There is no category, no photo, no void and no edit column, and no edit or delete endpoint. Movements are append-only. The only deletion is the training purge in `server/services/deneme.ts:228,331`.
- IDs come from `ulid()` in `server/lib/ids.ts:11`: 26 characters, Crockford base32, sortable by time. `addCashMovement` uses it at `days.ts:93`.

**Write path.**
- `POST /api/cash/movements` (`server/routes/cash.ts:189-194`) takes zod `{kind, amount: kurus, description ≤200, approverPin}` and calls `write(...)` → `addCashMovement`.
- `addCashMovement` (`server/services/days.ts:86-108`):
  - needs `kasa.hareket` and requires an open day (`requireOpenDay`);
  - rejects a `harcama` with an empty description (`reason_required`);
  - writes an audit entry `cash.<kind>` (severity `uyari` at ≥1000 TL);
  - emits `{topic:'cash', kind:'movement'}`.
- Reads: `movementsOf` (`cash.ts:38-47`) adds `userName`. It is served by `GET /cash/day` (78-95) and `GET /cash/days/:id` (227-240).

**UI.** `src/pages/cash/CashPage.tsx`:
- types and labels at 28-75 (`MOVE_KINDS`, `MOVE_LABEL`, `MOVE_HINT`);
- save at 157-180 (`withApproval` → `post('/cash/movements')`);
- modal at 520-565: numpad and one "Açıklama" field (required for harcama, placeholder "Ör. süt (market), fiş no").
- There is no category or photo picker.

**Aggregation into the day body.**
- `computeSummary` (`days.ts:197`) loads the moves. At 282-285: `cashIn` = sum of giris, `cashOut` = sum of harcama, `handedOver` = sum of teslim, and `expectedCash = opening + cashSales + cashCollections + cashIn − cashOut − handedOver`. These go into the ZSummary at 312-314.
- `lafmaliyetZ` (`days.ts:479-501`) sends `cash_out` and `handed_over` as-is. `cash_in` is **derived**: `max(0, expected − opening − z.cash + out + handed)`, so it includes giris, cash cari collections and cash tips.
- `buildDayPayload` (`server/sync/lafmaliyet.ts:240-331`) puts `z.cashOut` (305), `z.handedOver` (307) and `z.cashIn` (310) into the body as TL (`toTL`, two decimals). The top level has `version:1, source, bankPos?, sube, date, z, lines, ikram, payments`. No person names; this is documented in `docs/03-ENTEGRASYON.md:698`.

**Transport and helpers.**
- `server/lib/signature.ts`:
  - `signedFetch(secret, 'GET'|'POST'|'PUT', url, body?, timeoutMs=8000, extraHeaders)` at 51-91 (no redirects; it tracks internet state);
  - `signedHeaders` at 42 (`x-laf-timestamp`, `x-laf-signature: v1=<hmac>`).
- In the outbox:
  - `enqueueDay` (`lafmaliyet.ts:358-370`) uses dedupe key `gun:<date>` and replaces the pending entry.
  - `sendDue` (506-570) posts `/api/pos/gun`; 400, 409, 413 and 422 are treated as permanent (`PERMANENT` at 441).
  - `flushOutbox` runs every 60 s (`server/jobs.ts:282`).
  - `configured()` (334) requires `LAFMALIYET_URL` and a secret of ≥32 characters.
- The existing signed GET pattern to copy is `pullCosts()` (712-743): it zod-parses the body, caches it in `sync_state` via `getSyncState/setSyncState('lafmaliyet.costs')`, keeps the old data on error and returns 502 `lafmaliyet_costs`. `pullCostsIfStale` (745-757) runs once per business day.

**Sync budget.**
- AGENTS.md rule 6 is written for laffogato's signed endpoints: no automatic request more often than every 5 minutes, and nothing at all when the URL is missing.
- Existing 5-minute floors you can copy: `KARAOKE_AUTO_MIN_MS` (`server/sync/laffogato-karaoke.ts:37`) and `CATCH_UP_MIN_GAP_MS` (`server/sync/catch-up.ts:27`).
- Today LafPOS calls ladmin only for the day push (on close, recount, reopen+close, Pavo end of day) and for costs once a day.

**Contract docs.** `docs/03-ENTEGRASYON.md` §3.2 table (580-584: cash_out, handed_over, cash_in, expected_cash), §4 body (597-712, optional-field notes at 649-650), §4.1 costs GET (714-746).

## 2. ladmin: what exists today

**"Kasadan çıkanlar" table.** `src/server/db/schema.ts:1511-1542` `cash_outs`:
- `id` serial, `branchId`, `date` (business day), `kind` enum **`harcama|teslim` only (no giris)**;
- `amount` double (TL, including VAT), `store`, `description`, `receiptDate`, `receiptNo`, `vat`;
- `docType` `fis|e_arsiv|fatura|yok` (default `yok`), `photoId` → photos;
- `createdBy` int → users (nullable), `createdByName` (not null), timestamps;
- unique index on `photoId`.
- **There is no category column.** The category lives on the linked `expense_entries` row.

**Feeding Aylık harcamalar.**
- `expense_entries` (764-800) has a `cashOutId` with a unique index `expense_entries_cash_out_uq`, plus `photoId`, `vat`, `paymentMethod` and `supplierEntryId`.
- `expense_categories` (742-757): `id, name unique, section(mal|personel|faturalar|kira|genel), panelGroup(kira|personel|reklam|diger), invoiceCategory, monthly, active, sortOrder, taxDoc`.
- `supplier_entries.cashOutId` (559) links a "Teslim · ödeme" to a supplier payment; `cashOutCreated` means the payment created the row itself.

**Write rules.**
- `src/server/cash-outs/write.ts`:
  - `cashOutSchema` (39-60) includes `categoryId` and `toExpenses`.
  - `writeCashOut(tx, me, d, {branchId, author, prev…})` (94-220) creates, updates or deletes the linked expense entry: date from `expenseDateFor`, `paymentMethod 'nakit'`, note `Kasadan · <gün>`, `branchId` = the row's branch. When `branchId` is not given it falls back to `currentTillBranch()`, which is session-based, so ingest must pass it.
  - `removeCashOut` (228-250) also deletes the expense entry and supersedes `kasa-cikan` requests.
  - `attachReceiptPhoto` (257-268) adds a photo to a photo-less harcama row without approval, and sets `docType` to `fis`.
- `src/lib/cash-outs.ts`:
  - `staffCategory` (86) = active, section mal or genel, and panelGroup diger;
  - `staffToExpenses` (95) = harcama with fis or yok;
  - `cashOutWritesExpense` (112-136).
- `cashOutCategories(role)` (`src/server/data/cash-outs.ts:89-92`) already returns the staff subset.

**Approval flow.**
- `staffCashOutGate` (`src/server/cash-outs/guard.ts:43-75`) → `cashOutNeedsApproval` (`src/lib/cash-out-requests.ts:67-75`). Staff go to a `kasa-cikan` request for a closed or old day or an admin-category row, and are refused for rows linked to a supplier payment (`rowLocked`).
- `docs/ONAYLAR.md:39`: `kasa-cikan`, subjects `cikan:<id>` / `cikan-yeni:<anahtar>`, 14-day lifetime.
- `docs/KASA-RAPORU.md:320-357` has the rules table. Request code is in `src/server/cash-outs/requests.ts`, actions in `src/server/actions/cash-outs.ts:52-97`.

**"Soru 5".** `docs/LAFPOS.md:241-252` (and `docs/KASA-RAPORU.md:271-275`), audit finding E-35, summarised:
- Receipted expenses and handovers are entered in the panel's Kasadan çıkanlar, which is the source for Aylık harcamalar and supplier payments.
- LafPOS sends totals only (harcama, teslim).
- The open question to the owner was where these should be entered from now on. Until it is answered, the panel is the source.
- The form's "Gün içinde çıkan" fills from the rows. If LafPOS's combined total differs, "LafPOS'ta 5.450 ₺" shows, but there is no "LafPOS'takini yaz" button (it would create an unreceipted outflow). `lafposOutsCheck` tells staff to add the handover as a "Teslim" row. `lafposHandedGap` stops the late and correction cards from calling the handover amount "fişsiz".
- **The owner's approval now answers Soru 5: LafPOS becomes the line source.**

**What the day ingest does with cashIn/cashOut today.**
- Route: `src/app/api/pos/gun/route.ts:25-54` → `handlePosDay` → `receivePosDay` (`src/server/lafpos/ingest.ts:123-137`). The order is secret 503, size 413, signature 401, `parsePosDay` 400, `wrong_branch` 409, then `storePosDay`.
- `storePosDay` (46-113) runs in one transaction with advisory lock `lafpos-gun:<branch>:<date>`. It upserts `pos_day_reports` (z, payments, ikram, bankPos jsonb; schema 2238-2254) and replaces `pos_daily_sales`. **Nothing reaches `cash_outs`.**
- Schema `src/lib/lafpos/day.ts`: `posZSchema` (45-75) has `cashOut`, `handedOver`, and optional `cashIn` and `expectedCash`. `posDaySchema` (155-170) follows the optional-field pattern `bankPos: bankPosSchema.nullable().optional().catch(undefined)`.
- After a 200 on a counted day, `runLafposDayEnd` → `writeAutoReport` (`src/server/lafpos/gun-sonu.ts:105-200`) reads that day's `cash_outs` rows (115-119). `autoValuesOf` (`src/lib/lafpos/gun-sonu.ts:79-104`) then sets:
  - `cashOut` = **total of the rows if any exist, else `z.cashOut + z.handedOver`**;
  - `cashOutNote` from the rows;
  - `handedOver` = 0;
  - `cashIn` = `z.cashIn ?? 0`.
- Prefill: `lafposTill` and `lafposDayOf` (`src/lib/lafpos/prefill.ts:55-115`) give `till: {spent, handed}`.

**Signed GET pattern.**
- `src/app/api/panel/pos/urunler/route.ts` → `servePosProducts` (`src/server/lafpos/products.ts:21-29`) → `checkLafposRequest({method:'GET', body:'', maxBytes:0})` (`src/lib/lafpos/request.ts:37-58`).
- The secret is `LAFPOS_SYNC_SECRET`. Responses are `no-store`. `src/proxy.ts:53` does not match `/api/pos` or `/api/panel/pos`, so these are machine-only routes.

## 3. Proposed design (minimal, additive, body stays v1)

### Day body (LafPOS → ladmin)
Add an optional top-level `cashMoves` array, sent only when the day has movements or always (better: always, `[]` included, so ladmin can tell "LafPOS sent none" apart from "old LafPOS").
```json
"cashMoves": [
  { "id": "01JDX…(ULID)", "kind": "harcama|teslim|giris", "amount": 120.00,
    "description": "Buz", "at": "2026-11-23T10:14:00.000Z", "categoryId": 7 | null }
]
```
- No `userId` or name (KVKK), and no photo.
- `description` is free text typed by staff and can contain a name. Keep the 200-character cap and add a UI hint.
- Invariants checked in tests:
  - sum of harcama = `z.cashOut`;
  - sum of teslim = `z.handedOver`;
  - sum of giris ≤ `z.cashIn`, because `cashIn` also includes collections and tips.

### ladmin ingest
- `day.ts`:
  - add `cashMoveSchema`: id regex `^[0-9A-HJKMNP-TV-Z]{26}$`, `kind`, `amount` > 0 using `tl`, description trimmed to 200 or null, `at` ISO, `categoryId` int or null;
  - add `cashMoves: z.array(cashMoveSchema).max(1000).optional().catch(undefined)` to `posDaySchema`, so a malformed array never parks the day with a permanent 400; log it like bankPos;
  - make `parsePosDay` reject duplicate ids (or drop them and warn).
- Schema migration 0069 via `npm run db:generate`:
  - `cash_outs.lafpos_id text` (nullable) plus `uniqueIndex("cash_outs_lafpos_uq").on(t.lafposId)`;
  - optionally `pos_day_reports.cash_moves jsonb`, to keep the giris lines and the raw list.
- New `src/server/lafpos/cash-moves.ts` `syncLafposCashOuts(tx, day, now)`, called inside the `storePosDay` transaction under the same advisory lock, and only when `day.cashMoves !== undefined`:
  1. **Upsert by `lafpos_id`** for harcama and teslim:
     - insert with `branchId: LAFPOS_BRANCH_ID` (passed explicitly), `createdBy: null`, `createdByName: "LafPOS"`, `docType: "yok"`, `store: null`, `description` from the move;
     - on resend, update only the fields LafPOS owns (`amount`, `kind`, `date`, `description`), keeping the photo, docType, receipt info and store set in ladmin;
     - reuse `writeCashOut` with a system actor and `author {id:null, name:"LafPOS"}` so the linked expense entry is updated too.
  2. **Aylık harcamalar:** for harcama with a `categoryId` that is active and passes `staffCategory`, call writeCashOut with `toExpenses = true`. Without a category, write the row only; staff or admin pick the category later through the existing dialog.
  3. **Adopt manual rows (no double count):** before inserting, look for an unlinked manual row on the same `(branchId, date, kind)` with `|amount diff| ≤ 0.01` (`lafpos_id IS NULL`, oldest first, one-to-one). If found, set its `lafpos_id`; it keeps its photo, category and supplier link.
  4. **Removal:** a LafPOS row for this (date, branch) whose id is absent from the body is deleted with `removeCashOut`. If a supplier payment links it (`restrict` FK), flag it instead of deleting.
  5. **giris:** keep it out of `cash_outs` (the enum is harcama|teslim, and `cashOutsTotal` and the form assume outflows only). `cashIn` stays the report field. Store the lines in `pos_day_reports.cash_moves` if a breakdown display is wanted.
  6. Write `activity_log` lines, e.g. "Kasadan çıkan (LafPOS) · N satır".
- What follows automatically:
  - `autoValuesOf` already prefers the row total, so the auto report's "Gün içinde çıkan" equals harcama + teslim;
  - `lafposOutsCheck` and `lafposHandedGap` go quiet when they match;
  - leftover un-adopted manual rows still show as a gap ("Panelde X fazla").
- **Guard:** in `guard.ts`/`write.ts`, a row with `lafposId` has amount, kind and date locked for everyone (UserError "LafPOS'tan geldi; LafPOS'ta düzeltin"). Delete is blocked, because a resend would bring the row back. Staff may still attach a receipt (`attachReceiptPhoto`) and pick a category. Admin may set docType, store and category.
- **Manual rows on a LafPOS day:**
  - Option A (recommended): allow them; adoption catches matches, and the panel flags the rest "LafPOS'ta yok" in the day view and the form. Rows only arrive at day close, so staff photographing receipts during the day need this path.
  - Option B: block staff "ekle" for Marina on counted LafPOS days (`isLafposDay(date, branchSwitchDay(...))`) with a message to use LafPOS.

### Expense categories: signed GET
- New `src/app/api/panel/pos/kategoriler/route.ts` → `src/server/lafpos/categories.ts` `servePosCategories`, a copy of `servePosProducts`. It returns `{ version:1, now, items:[{ id, name, section, sort }] }`.
- Filter with `staffCategory`, i.e. reuse `cashOutCategories("staff")`. Personnel categories only: no admin, salary or advance categories, and no amounts.
- LafPOS side, `server/sync/lafmaliyet.ts`:
  - `pullExpenseCategories()` with state in `sync_state` under `'lafmaliyet.categories' {at, items, lastError}`;
  - `categoriesIfStale(now)` with `CATEGORIES_MIN_MS = 5*60_000`;
  - trigger it lazily from a new `GET /api/cash/expense-categories` (`kasa.hareket`), which returns the cached list at once and starts a refresh only if older than 5 minutes, configured, and the day is open. No timer.
  - Offline, the cached list keeps working and the category stays optional.
- LafPOS schema (`db:generate`): `cash_movements.category_id integer`, `category_name text` (a snapshot, so the name is still known offline and the category can't drift). `addCashMovement` accepts a `categoryId` only for harcama, validated against the cache.

## 4. Files to touch

**LafPOS**
- `server/db/schema.ts` + `drizzle/00xx_*.sql` + meta (the demo picks migrations up via `demo/migrations.ts` glob; no disk read, so no `derle.mjs` change)
- `server/services/days.ts` (`addCashMovement` category)
- `server/routes/cash.ts` (POST schema, new GET categories)
- `server/sync/lafmaliyet.ts` (`buildDayPayload.cashMoves`, `pullExpenseCategories`/`categoriesIfStale`, optional status in `lafmaliyetStatus`)
- `src/pages/cash/CashPage.tsx` (category chips ≥44 px in the harcama modal; `Movement` type)
- `docs/03-ENTEGRASYON.md` §3.2, §4, new §4.x
- `tests/lafmaliyet-gun.test.ts` + `tests/fixtures/lafmaliyet-gun.golden.json` (regenerate with `LAFPOS_GOLDEN=1`; fix the movement's id and createdAt in the DB before close, as is already done for `date` at line 135, or the byte-exact compare is flaky)
- `tests/signature.test.ts` (new GET vector)
- a new budget unit test (fake timers: two calls within 5 minutes → one fetch; no URL → no fetch)

**ladmin**
- `src/server/db/schema.ts` + `drizzle/0069_*.sql`
- `src/lib/lafpos/day.ts`
- `src/server/lafpos/ingest.ts`
- new `src/server/lafpos/cash-moves.ts`
- `src/server/cash-outs/guard.ts` and `write.ts` (lafpos lock)
- `src/server/actions/cash-outs.ts` (delete refusal)
- `src/server/data/cash-outs.ts` (expose `lafposId` in the DTO for a "LafPOS" badge)
- `src/app/panel/kasa/cash-history.tsx` / `cash-out-dialog.tsx` (badge, locked fields)
- `src/lib/lafpos/prefill.ts` (texts)
- new `src/app/api/panel/pos/kategoriler/route.ts` + `src/server/lafpos/categories.ts`
- `docs/LAFPOS.md:241-252` (Soru 5 answered), `docs/KASA-RAPORU.md:271-275`
- `tests/fixtures/lafpos-gun.golden.json` (byte copy, `tests/lafpos.test.ts:677-680`)

**laffogato:** nothing. It has no cash-out or expense code.

## 5. Risks
- **Data model gap.** LafPOS cannot void or edit a movement. A mistaken harcama can only be offset with a giris, which ladmin would not subtract from `cash_outs`. Consider a LafPOS "hareket iptali" (`voidedAt`, audited), with voided moves left out of the body so step 4 above removes them.
- **Double counting:**
  - manual rows that don't match on amount;
  - supplier payments created from Tedarikçiler (`cashOutCreated`) and a LafPOS teslim for the same cash. Prefer linking the payment to the existing LafPOS row.
  - Expense double count is guarded by the `expense_entries_cash_out_uq` unique index.
- **Timing.** Rows appear only after gün sonu. During the day, staff still need manual rows (or wait).
- **Switch day.** Apply only for `LAFPOS_BRANCH_ID` and for counted days (`isLafposDay`). Before the switch day the rows are training data and must not create `cash_outs`; gate on `counted`.
- **Malformed `cashMoves` must not 400 the day.** A 400 is permanent in LafPOS (`PERMANENT`).
- **KVKK.** Free-text `description`; and `createdByName` must not become a LafPOS user name.
- **Golden and vectors.** The golden file and both signature vector tests must change in the same PR series in both repos.
- **Size.** 256 KB body limit is fine for ≤1000 moves.

## 6. How to test
- **LafPOS:** `npm run typecheck && npm test` (vitest; server tests also run on sql.js/demo), plus `npm run build && npm run e2e` for the CashPage modal. Unit tests:
  - payload sums match `z`;
  - no `userId` or names in the body;
  - category budget (no URL → zero requests; 5-minute floor);
  - `pullExpenseCategories` keeps the previous list on 401, 5xx or a malformed body.
- **ladmin:** `npm test` (`tsx --test tests/*.test.ts`) for the pure parse tests in `tests/lafpos.test.ts`, covering cashMoves optional, malformed → undefined, duplicate id, and the new signature vector next to line 105. DB tests with `TEST_DATABASE_URL=… npm run test:db -- tests/lafpos-db.test.ts tests/lafpos-gun-sonu-db.test.ts tests/kasa-cikan-istek-db.test.ts` cover:
  - insert, resend idempotency, adopt a manual row, removal on absence;
  - expense entry with a valid staff category, and none with an admin category;
  - auto report `cashOut` equals the row total;
  - staff edit and delete refused, photo attach allowed;
  - `servePosCategories` returns 401 without a signature, and a staff-only list otherwise.
