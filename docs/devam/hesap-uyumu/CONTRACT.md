# Implementation contract: LafPOS ↔ ladmin (lafmaliyet) ↔ laffogato hesap uyumu

This file is the single source of truth for every implementation agent. Read it fully. Background maps (code
locations, current behaviour) are in the same folder under `maps/*.md`; read the ones named for your package.
The owner's original task text is summarised here; where this file and a map disagree, this file wins.

Repos (all already cloned, deps installed):
- LafPOS: `/home/user/lafpos` (Vite + server, vitest, sqlite/sql.js). Rules: `/home/user/lafpos/AGENTS.md`.
- ladmin = lafmaliyet: `/home/user/lafmaliyet` (Next.js 16, Drizzle, Postgres, node:test via tsx). Rules: its
  `AGENTS.md` (+ `docs/planlar/*`); Next 16 differs from training data, read `node_modules/next/dist/docs/` before
  touching Next APIs.
- laffogato (site): `/home/user/laffogato` (Next.js 16, pg). Code, identifiers and commit messages in English;
  UI text Turkish. Rules: its `CLAUDE.md` + `AGENTS.md`.

Local Postgres is running: `postgres://ci:ci@localhost:5432/test` (superuser `ci`). lafmaliyet DB tests:
`TEST_DATABASE_URL=postgres://ci:ci@localhost:5432/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db [-- files]`.
Never touch live databases or live sites. No network calls to laffogato.net / ladmin.laffogato.net.

## 0. Global rules for every package

1. Money: LafPOS integer kuruş (`shared/money.ts`, `shared/order-calc.ts`). On the wire (day body) TL with 2
   decimals (`toTL`). lafmaliyet stores TL doubles, rounds with `round2`. `tl` in lafmaliyet is `min(0)`; any
   field that can be negative uses `signedTl`.
2. Day body stays `version: 1`, camelCase. Every new field is OPTIONAL and ADDITIVE. lafmaliyet reads every new
   field with `.optional()` (and `.nullable()` where it makes sense) **and `.catch(undefined)`** so a malformed
   new field never rejects the day (a 400 is permanent in LafPOS). Stored jsonb is re-parsed by the same
   schemas, so a required field would silently drop old stored days.
3. Every bug fix has a test that FAILS without the fix. Write the test first, run it, see it fail, then fix.
   Report the failing-before evidence (test name + the assertion message) in your final report.
4. KVKK: no person names in the day body. No user ids. Free-text reasons are capped at 200 chars.
5. Turkish UI text, natural, no trailing period in headings; touch targets ≥ 44 px (LafPOS); LafPOS screens/admin
   sections added go into `e2e/run.mjs` ROUTES.
6. Schema changes: `npm run db:generate` (both repos) and commit the generated migration; never hand-write SQL
   (laffogato uses its own `db/migrations/*.sql` + `npm run db:bundle` convention, follow its docs).
   lafmaliyet PATCH bodies: `patchOf(schema)` not `.partial()` (LafPOS rule 9; check lafmaliyet's equivalent).
7. LafPOS server code also runs in the browser demo (`demo/`); no new Node builtins or disk reads without a shim.
   New disk reads at runtime go into the Windows package (`scripts/kasa/windows/kurulum/derle.mjs`).
8. Sync budget (LafPOS AGENTS rule 6 spirit applies to ladmin too): no automatic signed request to ladmin more
   often than every 5 minutes, except the existing day push; nothing at all when `LAFMALIYET_URL` is not configured.
9. Before declaring done: LafPOS `npm run typecheck && npm test` (+ `npm run build && npm run e2e` if UI touched);
   lafmaliyet `npx next typegen && npx tsc --noEmit && npm run lint && npm test && npm run test:db`;
   laffogato `npm run typecheck && npm run lint && npm run test:sube` (+ DB tests with TEST_DATABASE_URL if any).
   All must pass. Commit locally on your branch with a clear message (Turkish for lafpos/lafmaliyet, English for
   laffogato), ending with the two attribution lines below. DO NOT PUSH. DO NOT open PRs. The orchestrator does.
   Commit trailer (exactly):
   ```
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01TUBQ8Lf9KYfVePeoU8oPcc
   ```
10. Shared doc `docs/hesap-sozlesmesi.md`: copy byte-for-byte from
    `/tmp/claude-0/-home-user-lafpos/087a595d-df9f-592b-88ce-6553c15994c5/scratchpad/hesap-sozlesmesi.md`
    (only in the packages that say so). Guard test `tests/hesap-sozlesmesi.test.ts` asserts its SHA-256 equals a
    constant; the constant is the same in both repos. Link it from LafPOS `docs/03-ENTEGRASYON.md` §4 and
    lafmaliyet `docs/LAFPOS.md`.
11. Golden body: LafPOS `tests/fixtures/lafmaliyet-gun.golden.json` == lafmaliyet
    `tests/fixtures/lafpos-gun.golden.json` (byte-identical). Regenerate in LafPOS with
    `LAFPOS_GOLDEN=1 npx vitest run tests/lafmaliyet-gun.test.ts`. The acceptance day fixture (§6) is a second shared
    file with the SAME name in both repos: `tests/fixtures/kabul-gunu-2026-11-22.json`.

## 1. Owner decisions (asked 23.11.2026, binding)

1. Branch selling price: YES, needed → site first (laffogato), then ladmin, LafPOS small.
2. Staff identity link: YES. Owner note: "ladmin already has their accounts; make sure the correct account is
   linked". → explicit, confirmed links only; never auto-link; ladmin validates every ref.
3. Cash moves line by line into ladmin "Kasadan çıkanlar": YES (LAFPOS.md "Soru 5" answered).
4. Business-wide (işletme geneli) expenses on branch screens: an explicitly labelled info row
   "İşletme geneli payı (bilgi)" that does NOT reduce branch profit; "Tümü" counts them once.
5. Purchase invoices: unchanged (not split by branch; no transfer / branch stock).
6. Multi-branch LafPOS in ladmin (per-branch switch day + key): DEFERRED to Tuzla's switch. Do not build.
7. "Deneme" ödenmez = product trial → consumption, stays in reports. No code change; doc note only.
8. 22.11 voids: the rule decides (`prepared` = startedAt || readyAt).
9. During the session the owner added: "LafPOS Uzaktan does not show the ModPOS-era data we entered for Marina;
   fix it too." (see package LP-D).
10. Bank POS rate (asked later): BOTH branches 2%, editable in settings → `branches.pos_rate` double precision
    NOT NULL DEFAULT 0.02 (drizzle-generated migration sets existing rows to 0.02), admin-editable in Ayarlar ›
    Şubeler (or wherever branches are edited). The global `settings.komisyon` (0.025) is left as is; it only feeds
    the legacy fallback for months without kasa card data (Excel goldens). Say this in the PR body.
11. Staff meal card: only Marina staff for now (Alper, Cem) → per-staff flag, default off.
12. Part-time: the weekly fixed "Part-time çalışan" item STAYS for November 2026; from December the daily model
    applies (owner enters daily wage, meal, extra pay per person himself). Code must support per part-time person:
    daily wage, meal card flag (daily amount × called days), extra pay (not grossed up). Owner data action: set
    endMonth 2026-11 on the weekly item (do not do it in code).

## 2. Day body additions (LafPOS → ladmin, `POST /api/pos/gun`, v1)

All TL amounts 2 decimals, ≥ 0 unless marked signed. Field names exactly as below.

Top level:
- `revision`: integer ≥ 1. Deterministic: 1 + number of already SENT (`sentAt` set) outbox rows with dedupeKey
  `gun:<date>` at build time. Never Date-based.
- `correction`: `{ kind: "reopen" | "recount", reason: string(≤200) }` — present when the day was reopened (store
  the reopen reason in a new `business_days.reopenReason` column, migration) or counted again after close; absent
  otherwise. A Pavo end-of-day resend is a new revision but NOT a correction.
- `offDevice`: `{ card, cash }` — sales payments not on any fiscal receipt (summary.offDevice; recompute for old Zs).
- `refunds`: `[{ amount, zField, name, channel, reason }]` — refunded (cancelled) payments of the day; `name` is the
  payment TYPE name (e.g. "Kredi kartı"), never a person; `channel` same keys as `payments[].channel` or null;
  net out `REFUND_REWRITE` re-written payments exactly like `refundReport`. Max 2000.
- `iptal`: `[{ posName, siteMenuId, slot, qty, listValue, prepared, reason, refund }]` — voided items of the day's
  POS orders, split into main/add-on parts with `itemParts` like ikram (same posName/siteMenuId/slot keys as
  lines). `prepared` = item `startedAt != null || readyAt != null`. `refund: true` when voidReason starts with
  `'İade: '` (also appears in `refunds`). Max 2000.
- `cashMoves` (LP-B): `[{ id (ULID 26), kind: "harcama"|"teslim"|"giris", amount, description (≤200, may be ""),
  at (ISO), categoryId: int|null }]`. Always sent (also `[]`) once LP-B is in, so ladmin can tell "none" from
  "old LafPOS". Invariants: Σharcama = z.cashOut, Σteslim = z.handedOver, Σgiris ≤ z.cashIn. No userId.
- `workedStaffRefs` (LP-C): `string[]` of `"s:<ladmin staff.id>"`, sorted, unique. Sent ONLY when at least one
  LafPOS user has a `staffRef`; absent otherwise.

`z` additions:
- `listValue` = Σ list (sold + ikram + ödenmez, service line included; zayi excluded).
- `ikramTotal`, `odenmezTotal`, `zayiTotal` (list values by compKind; ikram = compKind null or 'ikram').
  Invariant: ikramTotal + odenmezTotal + zayiTotal = offRevenue; zTotal = listValue − discounts − ikramTotal −
  odenmezTotal.
- `vat`: `[{ rate, base, vat }]` from summary.kdv (closed POS orders, service included), base/vat TL.
- `openedAt`, `closedAt`: ISO strings from business_days (last close).
- `okcZNo`: string|null — the fiscal Z no of the latest completed fiscal receipt of the day (keep leading zeros);
  null when none.
- (LP-B) `openingDiff`: signed TL (counted opening − expected opening), null when no expected opening;
  `openingReason`: string|null (≤200); `expectedOpening`: TL|null.

`lines[]` additions:
- `gross`: line list value before discount (after happy hour; = Σ parts of `itemParts(i, qty*unitPrice)`;
  service line gross = service amount). Invariant: Σ(gross − revenue) over lines = z.discounts.
- `isAddon`: true when the merged line contains add-on parts (EXTRA SHOT / SYRUP / ALTERNATIF SÜT parts, `k>0` in
  itemParts). Do NOT change the merge key (posName must stay unique per day; ladmin 400s on duplicates).
- (LP-E) `listPrices`: `[{ price, qty }]` — distinct frozen list unit prices (main part: `basePrice`; add-on:
  option price) with quantities; max 20; omitted when empty.

`ikram[]` additions: `kind`: "ikram"|"odenmez"|"zayi" (compKind ?? "ikram"); `personKind`:
"personel"|"musteri"|"patron"|null (only ödenmez: customer→musteri; user→ users.role patron→patron else personel).
Keep the existing `reason` prefixes ("Ödenmez: ", "Zayi: ").

`bankPos` addition: `errorCode`: string|null. LafPOS comparison basis (`cardBasis` in `server/okc/service.ts`)
must subtract off-device card (summary.offDevice.card) and card payments of receipts voided on the ÖKC after close
(`fiscal_receipts.status='fis_iptal'`). First check the 22.11 situation in tests: off-device card 870 must not be
expected in Pavo's batch.

## 3. ladmin responses and new signed endpoints

- 200 of `POST /api/pos/gun` adds (in `handlePosDay`, not `receivePosDay`, so receivePosDay deepEqual tests stay):
  `nextOpening: { amount: TL, source: "kasa_raporu" | "lafpos" } | null` — from the stored `cash_reports` row of
  (date, branch) if any: countedCash − handedOver; else `z.countedCash`; null when the day is not counted.
  LC: `staff: { counted: string[], unknown: string[], otherBranch: string[] }` when workedStaffRefs was sent.
- `GET /api/panel/pos/devir?date=YYYY-MM-DD` (signed, LAFPOS_SYNC_SECRET, like `/api/panel/pos/urunler`):
  `{ version: 1, date, nextOpening }` (same object). LafPOS fetches it lazily (see LP-B), ≥ 5 min apart.
- `GET /api/panel/pos/gider-kategorileri` (signed): `{ version: 1, now, items: [{ id, name, section }] }` — only
  staff-usable categories (`cashOutCategories("staff")` / `staffCategory`), no amounts.
- `GET /api/panel/pos/personel?sube=marina` (signed; `sube` ≠ LAFPOS_BRANCH_ID → 409 wrong_branch):
  `{ version: 1, now, sube, items: [{ ref: "s:<id>", name, active, account: string|null }] }` — staff rows of that
  branch in range this or last month; `account` = the linked ladmin login's display name (staff.userId, see LM-4)
  or null. No salary, email or months. `Cache-Control: no-store`.
- Each new signed path gets a signature vector in LafPOS `tests/signature.test.ts` AND lafmaliyet
  `tests/lafpos.test.ts` (same vector both sides).

## 4. Packages, branches, order

Base branches: LafPOS `main` = 633165e (maps were written at 81f372f; #163–#165 merged since, re-check lines);
LP-D worktree already exists at `/home/user/wt/lafpos-modpos` on branch `claude/modpos-gecmis` (node_modules is a
symlink to /home/user/lafpos/node_modules; if vite/vitest resolution breaks, run `npm ci` there instead);
lafmaliyet `main` = 7740898; laffogato `main` = 9f7783e.
Stacked packages branch from the previous package's branch tip.

### LafPOS lane (repo /home/user/lafpos)
- **LP-A** branch `claude/sleepy-knuth-144kr7` (exists, = main): Faz 2 sender: all §2 fields except those marked
  LP-B/LP-C/LP-E; `revision`/`correction` (+ `reopenReason` column); `bankPos.errorCode` + `cardBasis` fix;
  `sube` lock (PUT /admin/settings branchId → 409 `branch_locked` once any lafmaliyet day push got a 200, unless
  body has `confirmBranchChange: true` from patron; UI in SettingsAdmin shows the lock and a confirm step; audit
  `settings.branchId` severity uyari); `docs/hesap-sozlesmesi.md` + guard test; docs/03 §4 updated (fields, KVKK
  sentence: personKind only); golden regenerated (extend the golden scenario so new fields are non-trivial:
  a discount, a void prepared + not prepared, an ödenmez with person, a zayi, a refund, off-device payment);
  ACCEPTANCE DAY fixture (§6) generated from seeded orders + assertions. Faz 2 docs note "Deneme" ödenmez = ürün
  denemesi (decision 7).
- **LP-B** branch `claude/kasa-zinciri` from LP-A: Faz 3: opening suggestion (last real counted day; `GET
  /cash/day` exposes `{suggested, source, fromDate}` to number-seeing users, `{check:true}` to blind), mandatory
  reason when |opening − expected| ≥ 100 kuruş (422 `opening_reason_required`; blind message "Sayımınız
  beklenenden farklı; nedenini yazın" with no amounts), columns `expectedOpening/openingDiff/openingReason` on
  business_days, audit `day.open` with data + severity; z.openingDiff/openingReason/expectedOpening in body;
  read `nextOpening` from the day's own sent outbox row response; lazy signed GET `/api/panel/pos/devir` (≥5 min,
  only when configured and no day is open) to refresh; prefer ladmin value over local chain when present;
  expense categories: lazy signed GET (≥5 min, cached in sync_state, offline keeps last list), `cash_movements`
  gets `categoryId` + `categoryName` snapshot, harcama modal category chips (≥44 px), POST accepts categoryId
  only for harcama; `cashMoves[]` in body; e2e flow for "Günü aç" with suggestion + reason (leave setup mode in
  the flow); docs/03 §3.2/§4/§5 (budget rows). Golden + acceptance fixture regenerated.
- **LP-C** branch `claude/personel-baglanti` from LP-B: staff link: `users.staffRef` (nullable, unique partial
  index), `GET /api/admin/ladmin-personel` (personel.yonet; fetch on demand, memory cache ≤5 min, 503 when not
  configured/unreachable), PATCH /users/:id `staffRef` validated against a fresh list (active, not linked to
  another user → 409 `staff_ref_taken`; link refused offline, unlink allowed offline), audit `user.staff_link`
  (no ladmin name in audit), UserDrawer picker with tr-TR folded name-similarity hint, NEVER preselect, confirm
  dialog showing both sides ("LafPOS: Ayşe · Kasiyer ↔ ladmin: Ayşe Yılmaz · hesap: ayse@… / Marina"), extra
  "Eminim" checkbox on low similarity; badge "ladmin'de bulunamadı" when ref missing; `workedStaffRefs` from
  activity signals (orders waiter/openedBy/closedBy, orderItems.createdBy, payments.userId, cashMovements.userId,
  shiftCounts, businessDays openedBy/closedBy) mapped to staffRef, resolved at SEND time like `sube`; plus a
  "Bugün çalışanlar" correction on Kasa › Geçmiş günler stored as `business_days.workedUserIds` json that
  overrides the derived list; parse `staff` in the 200 answer and show unknown/otherBranch in Entegrasyon. docs/03
  KVKK sentence: "ad gitmez; yalnız ladmin personel kimliği". Golden: unchanged bytes when no links (add a second
  test case with links).
- **LP-D** branch `claude/modpos-gecmis` from main, in a SEPARATE git worktree `/home/user/wt/lafpos-modpos`
  (node_modules symlinked): Faz 4 + owner's Uzaktan report. See §5 (REVISED). Depends on the LM-M endpoint shape
  (§5.1); build against that shape with a fake ladmin server in tests.
- **LP-E** branch `claude/sube-fiyati-kasa` from LP-C: branch price consumption: `lines[].listPrices`; read
  optional `nextPriceAt` from the signed panel menu and schedule one forced menu sync at that instant while the
  day is open (and on day open if passed); when the signed panel read fails, do NOT overwrite existing linked
  products' prices with public (Tuzla) prices; tests. Golden + acceptance regenerated.

### ladmin lane (repo /home/user/lafmaliyet)
- **LM-1** branch `claude/hesap-uyumu-faz1` from main: Faz 1 (§4 Faz 1 items 1–7), see §7. Also adds
  `docs/hesap-sozlesmesi.md` + guard test, and per-branch POS rate.
- **LM-2** branch `claude/lafpos-gun-alanlari` from LM-1: Faz 2 reader for §2 fields of LP-A (store + show);
  version table; prepared voids → zayi consumption; golden + acceptance fixture copied from LP-A; acceptance DB test.
- **LM-3** branch `claude/kasa-zinciri` from LM-2: Faz 3 reader: `nextOpening` in 200, `GET /api/panel/pos/devir`,
  `GET /api/panel/pos/gider-kategorileri`, `cashMoves` → `cash_outs` (unique `lafpos_id`, adopt matching manual
  row one-to-one, remove absent LafPOS rows, lock LafPOS-owned fields, staff may still attach photo/category;
  giris not in cash_outs; only for counted LafPOS days), openingDiff/openingReason into the cash report note;
  Soru 5 answered in docs; golden copied from LP-B.
- **LM-4** branch `claude/personel-sube-kira` from LM-3: staff link reader + Faz 5: `GET /api/panel/pos/personel`,
  `workedStaffRefs` ingest/classification (`pos_day_reports.worked_staff`), `staff.userId` (explicit link of a
  payroll row to a ladmin login account in Maaşlar, validated unique, admin only) and `staff.personRef` for Vardiya
  people without account; meal card as its own sub-row (settings `mealCardDaily` 330, `mealCardDays` 26,
  per-staff flag; worked days from LafPOS `worked_staff` when every counted LafPOS day of the month carries the
  field, else default) — must not double count with extras or the business-wide "Personel yemeği" (warn);
  part-time model (staff kind part_time + daily wage; pay = Vardiya work shifts × daily wage); rent model
  (landlord type şahıs/şirket on kira fixed items: şahıs → no VAT, stopaj 20% on official rent, single source
  (no double with "Kira stopajı" reminder); şirket → 20% VAT, no stopaj); "İşletme geneli payı (bilgi)" row on
  branch screens (not in branch profit; Tümü once); Tuzla data stays data (owner, Faz 0). Golden from LP-C.
- **LM-5** branch `claude/sube-fiyati` from LM-4: branch price write path + report (see §8).

- **LM-M** branch `claude/modpos-donemi` from main, in a SEPARATE worktree `/home/user/wt/lafmaliyet-modpos`
  (node_modules symlinked): the signed `GET /api/panel/pos/modpos-gunler` endpoint of §5.1 + loader + tests (DB test
  with Marina 13–21.11 kasa reports / föy rows and a ModPOS sales list → exact §6 numbers) + docs. No migration
  expected. Use `flock /tmp/lafmaliyet-db.lock` for test:db (shared DB with the other ladmin lane).

### laffogato lane (repo /home/user/laffogato)
- **LF-1** branch `claude/branch-prices` from main: see §8.

## 5. LP-D details (Faz 4 + Uzaktan) — REVISED after owner answers (23.11, ~21:00)

Owner facts: in LafPOS Uzaktan › Raporlar › "Geçen hafta" (16–22.11) the days 16–21 are MISSING entirely (only 22.11
shows). The ModPOS data was entered BOTH in LafPOS (merkez geçmiş ciro, earlier session) and in ladmin. Owner wants the
details (indirim, ödenmez, KDV, products) to come AUTOMATICALLY FROM LADMIN, and the kasa's own Raporlar to show the
ModPOS days too (labelled "ModPOS"). NO upload UI in Merkez (owner: not needed). Do NOT change the fillHistory
"bigger wins" rule; do NOT add a live/training flag. We cannot read live Redis, so the fix must work whatever the
cloud state is (history under another shop key, partial upload, stale training reports): the KASA itself makes the
ModPOS days appear under its own shop id.

Design:
1. ladmin (package LM-M) serves `GET /api/panel/pos/modpos-gunler?sube=<LAFPOS_BRANCH_ID>` (signed with
   LAFPOS_SYNC_SECRET like /api/panel/pos/urunler; other sube → 409 wrong_branch; no-store):
   ```
   { "version": 1, "now": ISO, "sube": "marina", "switchDay": "2026-11-22" | null,
     "days": [{ "date", "ciro", "kart", "nakit", "yemek", "online", "diger", "indirim", "odenmez", "ikram",
                "fis", "zNo": string|null, "kdv": [{ "rate", "base", "vat" }] }],
     "urunler": { "from", "to", "rows": [{ "ad", "boy": "M"|"L"|null, "adet", "tutar" }] } | null }
   ```
   TL 2 decimals. `days`: the LafPOS branch's ModPOS-era days strictly BEFORE switchDay (none when switchDay is
   null), last 400 days max, from ladmin's own per-day sources (kasa raporu first, ModPOS föy fallback — same
   precedence ladmin already uses in TillRow). `ciro` = Σ payments (kart+nakit+yemek+online+diger) = Z after
   discount, ödenmez/ikram excluded. `kdv`: if ladmin has no per-day breakdown, one row at the day's rate (10%) with
   matrah = round(ciro×100/110). `urunler`: the ModPOS product sales list of that branch for the same period
   (pre-discount; Marina 13–21.11: 31 rows, 240 qty, 29.415,00), null if none. No names, no amounts beyond these.
   Signature vector in both repos. Docs: lafmaliyet docs/LAFPOS.md + LafPOS docs/03 §4.x.
2. LafPOS kasa (package LP-D): `pullModposDays()` signed GET, budget: at most once per business day automatically
   (first tick after the day opens or after 05:00) + manual "ModPOS dönemini çek" in Yönetim › Entegrasyon, never
   more than once per 5 min, nothing when not configured; keeps last good data on errors (pattern `pullCosts`).
   Stored in sync_state `lafmaliyet.modpos` as a HistoryStore-like record (kaynak "ModPOS", source "ladmin").
   Converted to `HistoryDay` (kuruş) with the new optional fields (indirim, odenmez(+ikram as comp), kdv, z) and the
   store-level `urunler` block.
3. One kasa helper `historyDays()` merges `merkez.gecmis` (manual) and `lafmaliyet.modpos` per date; the ladmin day
   wins for the same date. Used by patronStats (comparisons), summaryReport/hourlyReport/productReport of the kasa's
   Raporlar (ModPOS days labelled "ModPOS"; products tab shows the period block as its own "ModPOS · indirim öncesi"
   block only when the range covers the whole block period, else a note), never by the Z report, business_days,
   the Z chain or the lafmaliyet outbox (isolation test).
4. Cloud: the kasa PUSHES the ModPOS days to Uzaktan as day reports through the existing signed report push
   (server/sync/cloud-reports.ts → /api/uzaktan/rapor) under its own shop id, built with `historyReport(day)`
   (kaynak 'ModPOS', zText), only for dates that have no real LafPOS business day, and only when the day's content
   changed (hash in sync_state). This overwrites stale cloud reports for those dates and makes "Geçen hafta" show
   16–21 regardless of where the manual history was stored. The cloud rapor endpoint must accept these (validate
   the new optional fields), and its retention (420 days) applies.
5. `HistoryDay` gains optional `indirim`, `odenmez`, `kdv: [oran, dahil, matrah, kdv][]` (Σdahil = ciro; default
   `splitKdv(ciro,10)`), `z` (ModPOS Z text). `historyReport`: gross = ciro + indirim, comp = odenmez (incl. ikram),
   odenmez, disc = indirim, list = gross + comp, kdv rows; `kaynak: 'ModPOS'`, `zText` on RemoteDayReport.
   Uzaktan sumSummary then gives for 13–22.11 (with the LafPOS 22.11 day): discount 2.156,25, ciro dışı 2.565,00,
   ciro 33.633,75, KDV hariç 30.576,15 (KDV 3.057,60), receipts 161; daily table/chart label ModPOS days; products
   tab shows the period block; extras tabs show a ModPOS note.
6. Patron ETag `liveTag` includes the history stamp (so a new manual upload is not hidden behind a 304).
7. Tests (failing-before where they reproduce the owner's bug): a cloud report test where manual history sits under
   a different shop key (or is absent) and "Geçen hafta" 16–22 misses 16–21 today; after the kasa push of
   ladmin-derived days the same request returns all 7 days. Plus §6 month numbers, isolation, budget (no URL → no
   request; one request per business day; manual refresh ≥5 min).
8. Docs: docs/07-UZAKTAN-ERISIM.md (Geçmiş ciro + ladmin source), docs/03 (new endpoint + budget row), gecmis.ts header.

## 6. Acceptance numbers (synthetic; must come out EXACTLY)

ModPOS days (Marina, 13–21.11.2026; TL):
| Gün | Ciro | Kart | Nakit | İndirim | Ödenmez | Fiş | ModPOS Z |
| 13.11 | 390,00 | 195,00 | 195,00 | 0,00 | 0,00 | 2 | Z-2026-002 |
| 14.11 | 3.311,00 | 2.687,25 | 623,75 | 249,00 | 0,00 | 14 | Z-2026-003 |
| 15.11 | 5.753,00 | 4.146,50 | 1.606,50 | 517,00 | 190,00 | 27 | Z-2026-004 |
| 16.11 | 2.670,00 | 2.140,00 | 530,00 | 0,00 | 0,00 | 9 | Z-2026-005 |
| 17.11 | 1.641,25 | 1.171,25 | 470,00 | 153,75 | 455,00 | 12 | Z-2026-006 |
| 18.11 | 2.419,25 | 1.814,50 | 604,75 | 315,75 | 400,00 | 16 | Z-2026-007 |
| 19.11 | 2.535,75 | 1.472,50 | 1.063,25 | 204,25 | 200,00 | 19 | Z-2026-008 |
| 20.11 | 4.008,00 | 2.914,25 | 1.093,75 | 397,00 | 255,00 | 19 | Z-2026-009 |
| 21.11 | 4.620,50 | 3.203,00 | 1.417,50 | 229,50 | 0,00 | 17 | Z-2026-010 |
Total: ciro 27.348,75 · kart 19.744,25 · nakit 7.604,50 · indirim 2.066,25 · ödenmez 1.500,00 · fiş 135 · yemek 0.
ModPOS product list for the period: 31 lines, 240 qty, 29.415,00 pre-discount (= ciro + indirim).

Marina 22.11.2026 acceptance day (LafPOS, `tests/fixtures/kabul-gunu-2026-11-22.json`):
- list 7.440,00; discount 90,00 (52,50 + 37,50: two order discounts); ikram 130,00; ödenmez 935,00;
  ciro 6.285,00; card 5.030,00; cash 1.255,00; meal card 0; receipts 26; VAT 10%: base 5.713,64, VAT 571,36.
- sold products 58 qty, add-ons 2 qty (isAddon); a "SYRUP" line with revenue 92,50; a "LATTE…" line 570,00.
- off-device card 870,00, cash 200,00; refunds 2 (50,00 + 45,00, card); iptal 12 parts totalling listValue
  2.395,00 (mix of prepared and not prepared; decision 8 = rule).
- cash: opening 1.120,00 · cash sales 1.255,00 · harcama 800,00 (one move, "Diğer fatura dışı", fişsiz) ·
  expected 1.575,00 · counted 1.279,50 · diff −295,50 · carry 1.279,50; 23.11 expected opening 1.279,50 (LP-B).
Marina November (13–22.11): ciro 33.633,75 · card 24.774,25 · cash 8.859,50 · meal 0 · discount 2.156,25 ·
ödenmez+ikram 2.565,00 · receipts 161 · KDV hariç (days summed) 30.576,15 (month-level rounding 30.576,14) ·
bank POS commission 495,49 on BOTH Satışlar and Gelir-gider (Marina POS rate 2%).
Staff employer cost: Alper 57.065 (35.000 net + SGK + 8.580 meal card), Cem 52.909 (32.000 + SGK + 8.580),
Damla 49.059 (30.000 + 7.500 extra, extra not grossed up), Berkan 44.329 (32.000, from November).
Tuzla rent 160.000/month to a person, no VAT, stopaj on official rent 100.000 (single source), only on Tuzla.
Marina rent: Nov 0; from Dec 160.000 excl. VAT, cash plan 192.000, VAT 32.000.
"Tümü" = Marina + Tuzla + business-wide once; nothing counted twice.

## 7. LM-1 (Faz 1) decisions
1. −90 ₺: discount is subtracted only on ModPOS-list days (use `lafposSales.countFrom` boundary, not just switch
   day). Fix all four places (sales-client diff → pure helper, insights alerts/consistency, engine listPeriod) AND
   `insights.ts:640` dashboard `discountsNet` (same bug).
2. "%8 fazla": compare ModPOS list − ModPOS discount with Z (`modposOverZText` extra param; `zOf` returns
   discounts); `zTotalBetween(from, through, branchId)` filters branch and sums discounts; list total filtered by
   branch. Test: list 29.415,00, discount 2.066,25, Z 27.348,75 → no warning (today warns "%8 fazla").
3. Bank POS commission: ONE function `posCommission` = Σ branch (Σ card (meal excluded) × branch POS rate), used
   by Satışlar (spread to lines by revenue share) and Gelir-gider. New `branches.pos_rate` double precision NOT NULL
   DEFAULT 0.02 (owner decision 10; migration via db:generate), editable where branches are edited (Ayarlar ›
   Şubeler), admin only. Months without
   kasa card data keep the old Excel-golden formulas (tests/calc.test.ts must stay green). `TillMonth` gains
   `card`/`mealCard` sums. Marina Nov test: 24.774,25 × 0.02 = 495,49 on both pages.
4. Cash form hint: "havale, cari…" (no ikram). Source test.
5. Commission & payout respects branch scope: loader filters cash_reports/pos_day_reports by scope, per-scope
   first report and closed days; bell/Bugün/digest/weekly stay business-wide via `withBranchScope(ALL_BRANCHES)`.
   From the LafPOS switch month on, unbranded amounts (Tuzla Z meal/online, pre-switch, channel-less) are NOT piled
   onto the sole active channel: show a group-level "Marka belirsiz" row. Recover Tuzla brands from ModPOS föy
   (`modposChannels`) where available. Months before the switch month keep the legacy `tek` rule. Invoices are
   business-wide: in a single-branch view show branch sales and branch commission = branch sales × business-wide
   rate, with a `branchViewNote`-style note; rates computed business-wide. Update KOMISYON.md pile-on sentences.
6. Fixed expense end: `setPnlCell` refuses a NEW value for `fixed:<id>`/`stopaj:<id>` when month > endMonth (or
   the id is deleted) and no entry exists (UserError Turkish); editing an existing value and clearing stay allowed;
   UI cell read-only when outOfRange && !overridden. Engine unchanged (old values keep counting). Duplicate-expense
   warning: pure detector — same month (+ same branch where the data has a branch) where the same item/supplier
   (tr-folded name) appears both as a fixed expense and as an invoice (supplier/category), a monthly expense entry
   or a manual P&L cell → `alerts()` entry + `warn` on the `fixed:<id>` cell.
7. Every fix: failing-before test with the §6 Marina numbers where applicable.

## 8. Branch price (LF-1, LM-5, LP-E)
Site (LF-1): append-only table `menu_item_branch_prices("menuItemId", branch, "priceMinor" int null (null = follow
base), "priceMinorL" int not null default 0, "effectiveFrom" text ISO, "createdAt", "createdBy")`, PK
(menuItemId, branch, effectiveFrom); only future rows may be deleted (cancel). Pure core `priceAtBranch`,
`nextPriceAt`. `GET /api/panel/menu?branch=X` (X ≠ home): priceMinor/priceMinorL = effective price now; items gain
`basePriceMinor`, `basePriceMinorL`, `priceFrom`; top-level `nextPriceAt`; for the `panel` caller also
`branchPrices[]`. Home read unchanged. `POST /api/panel/menu` optional `branchPrice: {priceMinor|null, priceMinorL,
effectiveFrom}` or `{effectiveFrom, cancel:true}`: requires branch ≠ home and panel caller (LafPOS 403), not with
priceMinor/priceMinorL/isActive, effectiveFrom ≥ now−5min and ≤ 90 days, option items refused, duplicate → 409
stale, audited, announced `writes.branchPrice: true`. Branch digest includes price rows. Customer pricing at a
branch (`resolveCafeLines(branch)`, `listMenuForCustomerLive(branch)`) applies `priceAtBranch`; public mobile menu
`?branch=` (known branches only) with remembered-read scope per branch and `validUntil = nextPriceAt`. Docs updated.
ladmin (LM-5): read `branchPrices` into integration_state; write branch prices (single + bulk) with a "Şube"
selector and "Geçerlilik" (default next business day 05:00 Istanbul) on Fiyatlar; parse/store `lines[].listPrices`
(`pos_daily_sales.list_prices jsonb`); "Eski fiyattan satılanlar" report tab + per change status Bekliyor /
Uygulandı · <gün> / Uygulanmadı / Bilinmiyor (never inferred from revenue/qty).

## 9. Addendum (owner answers 23.11 ~21:00 TR) — apply in LM-M follow-up and LP-D
- Owner is NOT sure how Marina's 13–21.11 days were entered in ladmin (daily kasa reports, föy or month totals).
- Föy-only days (no kasa report, closed ModPOS föy): owner asked "sence nasıl olsun?" → orchestrator decision: ALWAYS
  send them from `/api/panel/pos/modpos-gunler` regardless of "Ay rakamına yedek" (Uzaktan must not show empty days),
  each day gets `kaynak: "kasa_raporu" | "foy"`; on föy days `indirim` is `null` (unknown, not 0) and LafPOS shows
  "indirim bilinmiyor" (gross = ciro, no discount line). ladmin's own month rule stays unchanged (doc note).
- VAT: Marina has 20% only for karaoke, everything else 10%. Per day: use the kasa report's fiscal breakdown when it
  equals ciro; else the ModPOS föy/Z VAT breakdown if ladmin stores one; else one 10% row. Never assume 20% blindly.
- Owner (23.11 ~21:05 TR): from now on ModPOS will NEVER be used at Marina. Marina's ModPOS era is closed: only
  13–21.11.2026. Consequences: Marina's post-switch ModPOS data (if any arrives) is never counted; ladmin's backup ModPOS
  pull for Marina after the switch day can be turned off/ignored (note for LM follow-ups, no live action); screens/
  texts that still offer "ModPOS'a işle" or ModPOS fallbacks for Marina after the switch should say LafPOS; Tuzla stays
  on ModPOS until its own switch (deferred decision 6).
