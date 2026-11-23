# lafmaliyet Faz 1 items 4–6 (+ Faz 0 refs): code reading report

Repo HEAD: `7740898` (#122, 23 Nov 2026). All paths below are relative to `/home/user/lafmaliyet` unless marked otherwise.

## Corrections to the task text
- **docs/KOMISYON.md:129 is already fixed.** It now reads "ModPOS'ta kalan şube (Tuzla; geçiş günü yalnız Marina'nın kasasınındır…)". Commit #122 says: "ModPOS'ta kalan şube Tuzla, LafPOS'un şubesi Marina; belge ve yedi yorum ters yazıyordu". Nothing is left to fix there. The doc changes needed for item 5 are the *tek-kanal pile-on* sentences at KOMISYON.md:50, 90-91, 122-123 ("Grupta tek kanal varsa o tutar ona yazılır"), 126, 131 and 154-155.
- **Marina's start date is not in code.** The code only says "21 Kasım 2026 kararı". `LAFPOS_BRANCH_ID = "marina"` is at `src/lib/lafpos/switch.ts:47`. The actual switch day is the DB setting `lafposGecisGunu` (`LAFPOS_SWITCH_KEY`), so "since 22.11.2026" cannot be checked from code.
- **The wire format is TL, not kuruş.** LafPOS converts with `toTL()` (`/home/user/lafpos/server/sync/lafmaliyet.ts:329`), the golden file has `"zTotal": 2485` and payments like `{"name":"Pluxee","zField":"meal_card","channel":"pluxee","count":1,"amount":290}`, and lafmaliyet stores `doublePrecision` TL.
- **The quoted line numbers are accurate:** report.ts 503-505 and 774, engine.ts 2112-2115, 2221-2228, 2229-2239 and 415-419, muhtasar.ts 203-209, cash-form.tsx 1197.

## 4) Cash form "Diğer" hint
- **CURRENT:** `src/app/panel/kasa/cash-form.tsx:1197` has `field("other", "Diğer", { hint: "havale, cari, ikram…" })`. The next line, 1198, is the separate `offRevenue` field "Ödenmez / ikram" (off-revenue). So the hint tells staff to put ikram in a revenue field, which contradicts `src/lib/cash-revenue.ts:12`, `src/lib/modpos/z.ts:9-10,42-47` (`IKRAM`/`ODENMEZ` → `off`) and `src/lib/photo-read/kasa.ts:266-299` (ikram read into offRevenue).
- **CHANGE:** use "havale, cari…" or similar.
- **OTHER PLACES:** a repo-wide grep (src, docs, tests, scripts; LafPOS and laffogato too) found no other "ikram" inside a Diğer/other hint. Related hints are already correct:
  - `src/app/panel/kasa/okc-card.tsx:157`: "varsa (havale, kupon…)"
  - `docs/KASA-RAPORU.md:13`, `docs/FOTOGRAF.md:13`, `docs/planlar/kasa.md:313` list "ödenmez / ikram" separately.
- **TEST:** follow the source-test style: `read("src/app/panel/kasa/cash-form.tsx")` plus `assert.doesNotMatch(src, /hint: "[^"]*ikram/)` on the `other` field. Examples are in `tests/kasa-raporu-sade.test.ts` and `tests/lafpos-kasa.test.ts`, which already read cash-form.tsx.

## 5) Komisyon & hakediş and branch selection

### How branch selection works
- **Cookie `laf_sube`** (`BRANCH_COOKIE`, `src/lib/branches.ts:59`) is the only source of truth. "Tümü" is `ALL_BRANCHES = "hepsi"` (:55). `?sube=` (`BRANCH_PARAM`, :60) is adopted into the cookie once per link by `src/components/panel/branch-picker.tsx` (`branchLinkStep`, lib/branches.ts:241) through `chooseBranchScope` (`src/server/actions/branches.ts:139`), then dropped from the URL. **Pages never read `?sube=`.**
- **Server side** (`src/server/branch-scope.ts`):
  - `currentBranchScope()` (:127) uses React `cache` over the cookie, plus the staff lock (`lockedBranch`). Outside a request it returns "hepsi".
  - `withBranchScope(scope, fn)` (:136) is an AsyncLocalStorage override; business-wide screens use it with `ALL_BRANCHES`.
  - Query helpers: `branchWhere(col, scope)` (:224, no condition in Tümü) and `branchWhereWithShared` (:233, branch OR null for expenses).
  - `parseBranchScope` falls back to "hepsi".
  - `loadModel({ scope })` is in `src/server/data/dataset.ts:495`.
  - `scopeSwitchDay(switchDay, scope)` (`src/lib/lafpos/switch.ts:68`) returns null for Tuzla and online. `isLafposBranch` (:50) treats a null branch as Tuzla.

### CURRENT behaviour
The commission feature ignores the selection completely:
- `src/server/data/commission.ts` `loadCommissionInput` (:54) reads **all** `cash_reports` rows with `branchId` (:103-113), and `firstReport` is `min(date)` across all branches (:110).
- It reads all `special_days` "kapali" rows (:116), although `specialDays.branchId` is a nullable column.
- `loadLafposPaymentDays` (:144-166) reads all `pos_day_reports` with no branch filter.
- The page `src/app/panel/komisyonlar/page.tsx:57` calls `loadCommissionReport()`. `docs/SUBE.md` does not list Komisyon among the "işletme geneli" screens either.

### How LafPOS `payments[].channel` reaches commission
1. In LafPOS, a payment method carries `channel` (`PaymentMethodDTO.channel`, `/home/user/lafpos/shared/types.ts:147`). `server/sync/lafmaliyet.ts:329` maps it to `{name, zField, channel, count, amount}`.
2. lafmaliyet validates with `posDaySchema` (`src/lib/lafpos/day.ts:167`). `src/server/lafpos/ingest.ts:86-95` upserts `pos_day_reports(date, branch_id=LAFPOS_BRANCH_ID)` with `.payments` as JSONB; `sube` must equal "marina" or it gets 409 (:133).
3. `loadLafposPaymentDays` turns each payment into `LafposPaymentIn {name, zField, channel: lafposChannel(p.channel), rawChannel, amount}` (`src/lib/commission/channels.ts:84`: key or name prefix, otherwise null).
4. `lafposMonth()` (`src/lib/commission/report.ts:487`) buckets the payments:
   - with a channel → `byChannel` of the channel's kind;
   - without a channel, `meal_card`/`online` → `unassigned` and `loose`;
   - Marina cash reports on days without a gün sonu → `fallback`, added to `unassigned`;
   - non-Marina cash reports → `modpos {meal, online}` (:503-505).
5. `lafposSales()` (:743) computes channel sales.

### The bug
- At :774: `zShare = sole ? r2(preTotal + modposTotal + g.unassigned) : 0`. In words: when only one channel of the group is active (`activeOf`, :940ff, which is business-wide: invoices, marks, LafPOS payments), these all land on that single brand:
  - Tuzla's Z total (`modposTotal`);
  - the pre-switch Z total (`preTotal`);
  - channel-less LafPOS payments and Marina fallback days (`g.unassigned`).
- `lafposTill` (:573-583) adds `lm.modpos` to the group Z (`zTotal`).
- The non-LafPOS `tek` rule (:944-946) does the same for whole months: the full group Z goes to the sole channel.
- The group flag text at :1046 says "Bu ay tek kart olduğu için ona yazıldı".
- `tests/lafpos-komisyon.test.ts:258-292` **asserts this pile-on today**: `yemeksepeti` sales `{amount: 1200+3000, source:"lafpos", zShare: 3000}` (Tuzla's online). This test, and 293-320 ("tek kartta yazılır"), will have to change.

### WHAT must change, and WHERE
- **(a) Scope the loader.**
  - In `loadCommissionInput`, filter `cashReports` and `posDayReports` with `branchWhere(…, await currentBranchScope())`, make `firstReport` per scope, and apply branch-aware closed days.
  - Set `lafpos` to null when `scopeSwitchDay(switchDay, scope)` is null.
  - Keep the bell, Bugün, digest and weekly paths business-wide by wrapping them in `withBranchScope(ALL_BRANCHES, …)`, as SUBE.md requires for e-mails. The callers are `loadCommissionAlerts` (via notifications.ts:366), `loadOverduePayouts` (today.ts:276), `loadCommissionDigest` and `weekly/collect.ts:181`.
- **(b) Add a "marka belirsiz" row.** Do not add `zShare` to the sole channel. Instead put an unbranded amount on `GroupMonth` (new field, e.g. `unbranded {pre, modpos, loose, fallback}`) and render it in `meal-total-card.tsx` and the platform summary (`page.tsx`, `texts.ts` `platformTillLine`/`sourceLabel`).
  - `ChannelSales.zShare`, `autoSales.zShare` (report.ts:169, 239, 965) and `channel-month-dialog.tsx:154-155` text then go away or change.
  - `ChannelKey` has no "belirsiz" member, so this must be a group-level row, not a `ChannelMonth`.
- **(c) Decide the scope of (b).** Should the legacy `tek` rule for pure-ModPOS months also stop piling? If it does, all historical single-card months become "satış bilinmiyor".
- **(d) Optional brand recovery for Tuzla.** `modpos_cash_sheets.sheet` (schema.ts:2295) plus the existing, **unused in commission** helper `modposChannels(o)` (`src/lib/modpos/z.ts:78`, tested in `tests/modpos-foy.test.ts:672`) can give Tuzla's brands per ModPOS payment code.

### Open design issue (flag)
`invoices` has **no branch column** (schema.ts:365), and `commission_months` is unique on `(channel, month)` (schema.ts:1805-1830). So invoices, fees, typed statement sales and hakediş are business-wide. In a single-branch view the rate becomes business fees ÷ branch sales, and a typed `sales` mark would apply to both branches. One option is to show rates only in Tümü, with a note in the style of `branchViewNote` (`src/lib/branches.ts:325`).

### Repro test (pure, today)
In `tests/lafpos-komisyon.test.ts`, use `fx({ invoices:[inv("Pluxee","2026-11-30",60)], lafpos:{switchDay:"2026-11-01", days: lafDays("2026-11-01","2026-11-30", () => [pay("Pluxee","meal_card","pluxee",50)])}, till:[...till("2026-10-01","2026-10-31"), ...till("2026-11-01","2026-11-30",{mealCard:200, online:0, branchId:"tuzla"})] })`.
- Today `rowOf(r,"pluxee","2026-11").sales` is `{amount: 7500, source:"lafpos", zShare: 6000}` and the rate is 0.8%. It should be 1500 (rate 4%), with 6000 shown as marka belirsiz.
- Existing helpers: `inv`, `pay`, `lafDays`, `till` (default branch "marina"), `fx`, `rowOf`, `groupOf`, `lafposMonth`, `must`.
- Branch-scoped loading needs a DB test (`withBranchScope` pattern, e.g. `tests/lafpos-kasa-db.test.ts:59-61`, with `inTuzla`).

## 6) Fixed expenses with endMonth and the duplicate-expense warning

### Data model
- `fixed_expenses` (schema.ts:670-711): `name, section, period, amount` (excl. VAT), `vatRate, active, startMonth, endMonth, prorate, officialAmount/officialBasis, taxDoc, taxWithholding, branchId` (nullable; null = işletme geneli). **No supplier link.**
- `fixed_expense_versions` (:713).
- `pnl_entries` (:801-814): `(month, rowKey)` unique, **no branch**. Keys are `fixed:<id>`, `stopaj:<id>`, `manual:*` (`MANUAL_PNL_ROWS`, `src/lib/constants.ts:189-198`: su, dogalgaz, ciro_kirasi, sigorta, harici, diger…), `personnel:*`, `commission:*`, `stock:*`.
- `expense_entries` (:763): `branchId` nullable, `categoryId`.
- `expense_categories` (:742) has `invoiceCategory`: invoices of that category count in the category row (engine.ts:1849-1861 `expenseAmounts`).
- `invoices` (:365): `supplier, category, date`, **no branch**.
- The model's `ExpenseEntry` (`src/lib/calc/types.ts:452`) has no `branchId`; dataset.ts:413-424 drops it.
- Consequence: a "same branch" check is only possible fixed vs expense entry (after adding `branchId` to the mapping). Invoices and manual cells are business-wide. Supplier matching needs either name folding (precedent: `convertFixedToMonthly` matches `fold(c.name) === fold(fe.name)`, expenses.ts:214/287; `foldName` in cash-plan.ts:471; `normalizeSupplier` in engine.ts:84) or a new column.

### Write actions
In `src/server/actions/costs.ts`:
- `saveFixedExpense` (:398; `fixedSchema` :362)
- `endFixedExpense` (:551; message :571-573 already says "Sonraki aylarda elle girilmiş N tutar yine sayılır")
- `deleteFixedExpense` (:607, blocked by `fixed:` entries)
- `deleteFixedExpenseVersion` (:583)
- `fixedExpenseDeleteBlockers` (:680)

Elsewhere:
- `convertFixedToMonthly` (`src/server/actions/expenses.ts:275`) sets `endMonth`.
- Tax classification lives in `actions/tax.ts`.
- **The only pnl writer is `setPnlCell`** (`src/server/actions/pnl.ts:30-63`). It checks only `companyPnlKey` (personnel/commission/stock), with **no range check**, so `fixed:<id>` and `stopaj:<id>` can be written for any month after `endMonth`, and even for deleted ids.

### Engine
- `inRange` is at engine.ts:203.
- In the pnl month loop (:2214-2252): out-of-range items get `cells.set(key,{… outOfRange:true})`, and any override is still added to the section (:2229-2239). Deleted-item overrides count in genel/kira (:2240-2252). Existing test: `tests/history.test.ts:241` ("Aralık dışındaki … her zaman sayılır").

### UI
`outOfRange` is styling only:
- `src/app/panel/gelir-gider/pnl-grid.tsx:170,204` (muted) and :1237-1257 (still `EditableCell`, saves via `onSave`);
- `src/app/panel/gelir-gider/month-view.tsx:350-355` (opens the edit dialog).

### CHANGE for the endMonth rule
- **Server:** in `setPnlCell`, for `/^(fixed|stopaj):(\d+)$/` with `amount !== null`, load the item. If `endMonth && m > endMonth` and there is no existing entry, throw a `UserError`. Decide whether to allow editing an existing value and whether to apply the same rule before `startMonth` and to deleted ids. Clearing (null) must stay allowed.
- **UI:** make the cell read-only when `outOfRange && !overridden`, in both views.
- **Engine:** no change; old values keep counting.

### Repro test (today)
Follow `tests/gelir-gider-db.test.ts` (stubs `server-only`, `next/cache` and `auth/dal`; `pnl = import("../src/server/actions/pnl")`). Insert `fixed_expenses {endMonth: BEFORE}`, then call `pnl.setPnlCell(PREV, \`fixed:${id}\`, 500)`. Today it returns `{ok:true}`, and `loadModel().pnlMonth(PREV).cells.get(key)` has `overridden && outOfRange`.

### Existing warning infrastructure
1. **`alerts(model, month): Alert[]`** (`src/lib/calc/insights.ts:959`, `Alert {level, title, detail, href}` :44). It surfaces in:
   - Genel bakış Uyarılar (`src/app/panel/page.tsx:234`, `dashboard-alerts.tsx`)
   - the bell's "Uyarılar" group (`src/server/actions/notifications.ts:431`, id `uyari-${month}-${title}`)
   - Tutarlılık (`tutarlilik/page.tsx:90`)
   - MCP (`src/lib/mcp/answers/month.ts:205`)
2. **`PnlCell.warn`** (engine.ts:558): a Gelir-gider cell icon and tooltip. The precedent is the `commission:pos` double-count warning (engine.ts:2277-2285), tested in `tests/gelir-gider-db.test.ts:76-111`.
3. Action result messages (the `saveFixedExpense` follow-results pattern, `src/server/data/fixed-follow.ts`).
4. The cash plan's static "Çift sayım" note (`src/lib/cash-plan.ts:2027-2033`).

**Suggestion:** write a pure detector over `model.fixedInMonth(month)`, `expenseAmounts(month)`, `invoicesByMonth` and the pnl `manual:*` cells. Return it from `alerts()` and set `warn` on the `fixed:<id>` cell. Unit-test it in the `tests/history.test.ts` style (`createModel` over `excelToDataset`).

## Faz 0 references (brief)
- **engine.ts:2112-2115 `branchDays`.** In a branch view (`ds.branchView`), `own` is always undefined, so every item, including business-wide ones (`branchId` null, kept by `fixedInScope`, dataset.ts:172), is prorated with the *viewed branch's* `prorationDays`. Business-wide fixed costs therefore appear in full × (Marina days ÷ dim) on Marina's screen and in full on Tuzla's. The two branch views together double-count them; this is the intended "her şubede sayılır" behaviour (`branchViewNote`, lib/branches.ts:325-333). In Marina's opening month the cost is scaled by Marina's open days.
- **engine.ts:415-419 `officialRentGross`:** gross = `officialAmount` if basis is brut, else net ÷ (1 − rate). The rate comes from `rentWithholdingRate(month)` (:409, 2026: 20%).
- **engine.ts:2221-2228:** the `stopaj:<id>` cell = gross × rate × (d/dim), with `d = fullDays` when `prorate === false`. It is added to the item's section **on top of** the fixed amount, and pushed to `officialRent`.
- **src/lib/tax/muhtasar.ts:203-209 `rentWithholdingIn`:** the rent-stopaj part of the muhtasar estimate (`kiraOf(stopaj) + priorKira`), or 0 when there is an accountant filing or the month is deferred (quarterly). A fixed-amount "Kira stopajı" reminder replaces only this part (VG-02; used at `src/lib/tax/view.ts:567` and :913, and in cash-plan.ts:1375). The items come from `muhtasarItemsFromModel` (:254-275): an official-rent item → gross with withholding "kira".
