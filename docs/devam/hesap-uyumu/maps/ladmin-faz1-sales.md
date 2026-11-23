# lafmaliyet Faz 1, items 1–3: code reading report

## Corrections to the task text

- **Money.** lafmaliyet does not store integer kuruş. It stores TL in `doublePrecision` columns and rounds with `r2` (`src/lib/cash-month.ts:125`, `src/server/db/schema.ts:1391-1395`). The `/api/pos/gun` body also carries TL decimals: LafPOS converts with `toTL` (`/home/user/lafpos/server/sync/lafmaliyet.ts:237,316`). Only LafPOS's internals are in kuruş.
- **POS rate.** It is not 2% in code. It is the single global `settings.komisyon`, default `0.025` (`src/lib/constants.ts:6`; the seed `excel-data.json:9` is also 0.025). There is no per-branch POS rate anywhere: the `branches` table (`schema.ts:140-166`) has no rate column. A "Marina 2%" rate needs a new field.
- **Denominator.** "÷ Z" is really ÷ `posRevenue`, which is Z minus the ödenmez already inside Z (`cash-month.ts:263`). The comments say "÷ Z toplamı".
- **Line numbers.**
  - `sales-client.tsx:273-278` (task cited 275-277).
  - The discount rule appears in three places in `insights.ts`: `:1001-1004` (alerts), `:1197-1202` (`consistency`) and `:640` (`dashboard` `discountsNet`).
  - `engine.ts:1099` is correct (`listPeriod`).
  - `engine.ts:1369-1375` is correct.
  - `engine.ts:2263-2266`; the label/hint are at `:2462-2465`.
  - `lafpos/sales.ts:174-185`.
  - `actions/sales.ts:137-145`.
- **File paths.** The engine is `src/lib/calc/engine.ts` and insights is `src/lib/calc/insights.ts` (not `src/lib/*.ts`).

## Item 1: "-90 TL" (discount subtracted again from LafPOS net lines)

**Fact.** LafPOS lines are already net of discounts.
- LafPOS `salesOf` uses `totals.lineNet` (`/home/user/lafpos/server/sync/lafmaliyet.ts:197-201`).
- `lineNet` is "every line's share after all discounts" (`shared/order-calc.ts:58`, with the order discount allocated at `:136-149`).
- The doc says Σlines = `z_total` (`docs/03-ENTEGRASYON.md:560`), and the golden body sums to exactly 2485.
- On LafPOS days the kasa report's `discounts` is prefilled from LafPOS `z.discounts` (`src/lib/lafpos/prefill.ts:92`).

So on LafPOS days, list − discount − Z = −discount.

**Current behaviour (every place that applies "liste − indirim − pos"):**
1. `src/app/panel/satislar/sales-client.tsx:273-278`: `discNum = byList.discounts | effective("discounts")`; `diff = list - discNum - posNum`. It is displayed at `:520-528`. The values come from `page.tsx:93,303-308` (`listTotal = sales.revenue`, `listPeriod.discounts`).
2. `src/lib/calc/insights.ts:1001-1004` `alerts()`. The threshold is ≥1000, so −90 does not trigger it.
3. `insights.ts:1197-1202` `consistency()`: `sales.discounts/computed/diff/ok`. It is shown on the Tutarlılık page (`tutarlilik/page.tsx:104-121,279`), in the workbook (`api/export/workbook.ts:879,1011`) and in the weekly summary (`server/weekly/collect.ts:248`).
4. `engine.ts:1085-1103` `listPeriod()`: `discounts: c.till.discounts` (from the `salesCoverage` till, built in `dataset.ts:210-214`). It includes LafPOS-day discounts.
5. **Not in the task, same bug:** `insights.ts:640` `dashboard().theoretical.discountsNet` subtracts all discounts from the recipe-based net profit. It flows into `scenarioBase` (`:1493`), `applyScenario` (`:1515,1524`), `analiz/breakdowns.ts:116,122,235,325`, `panel/page.tsx:269`, `dashboard-breakdowns.ts:342`, `workbook.ts:618` and `mcp/answers/month.ts:155,164`.

**How LafPOS days and ModPOS days are distinguished today:**
- `settings.lafposGecisGunu` (the switch day). The dataset scopes it with `scopeSwitchDay` (`dataset.ts:167`): it is null in Tuzla scope.
- `LAFPOS_BRANCH_ID = "marina"`, `isLafposBranch`, `branchSwitchDay` and `isLafposDay(day, sw)` (`src/lib/lafpos/switch.ts:34-61`).
- The most accurate per-day boundary is the start day of LafPOS sales: `lafposSalesCountFrom` (`lafpos/sales.ts:51-57`), exposed as `Dataset.lafposSales.countFrom` (`server/data/lafpos-sales.ts:151`). In the transition month a ModPOS list that runs past the switch day pushes this boundary later (overlap). That is why `isLafposDay(date, switchDay)` alone is wrong in the overlap case.
- Synthetic LafPOS lines carry `lafpos: { days }` and a negative id. They have no `branchId` and are implicitly Marina (`mergeSalesSources`, `lafpos/sales.ts:95-105`; `SalesLine`, `types.ts:227-248`).
- There is no `source` column on cash reports. `TillRow.source` (`cash-month.ts:48-56`) only marks fallback rows ("lafpos" = a LafPOS gün sonu without a kasa report, "modpos" = föy). A kasa report on a LafPOS day has no source. A ModPOS föy row has `discounts: null` (`cash-reports.ts:445`).

**What must change:**
- In `tillMonths` (`cash-month.ts:180-291`), split the discount by day. Rows with `isLafposBranch(r.branchId) && countFrom && r.date >= countFrom` are LafPOS-list days; every other row is a ModPOS-list day.
- Add a field to `TillMonth` (`types.ts:129-196`), for example `listDiscounts` = Σ discounts of ModPOS-list days.
- `tillMonths` needs `countFrom`, which `dataset.ts` has after `mergeSales` (`:195`). Pass it to `monthsOf` (`:226-227`) and to the `salesCoverage` call (`:213`). `tillMonths` already has 8 positional parameters, so add an options object.
- `resolveBranchMonths`/`combineMonths` (`cash-month.ts:390-462`) must carry the field through `kasa.till`, as `combineMonths` already does for `till`.
- Add one pure helper, for example `listDiscountOf(info, month, lp?)`:
  - Discount from kasa: use the till field.
  - Discount typed manually: 0 in a `monthSource === "lafpos"` month, the typed amount otherwise. In the transition month a typed amount cannot be split, so this needs a decision.
- Use that helper in `listPeriod` (`engine.ts:1099`), `insights.ts:640`, `:1004` and `:1199`.
- The UI needs a server-passed value: a new `MonthInfoForm` prop from `page.tsx:303-308`. Then move the diff into a pure function in `src/app/panel/satislar/sales-logic.ts` so it can be tested.

**How to reproduce today (no DB).** Follow `tests/lafpos-satis.test.ts:198-230` plus `tests/satis-donemi.test.ts:30-58,113-132`:
- `base = excelToDataset(seed)`.
- Build lines with `mergeSalesSources({switchDay:"2026-11-01", lafposLines: laf(...)})`. The `laf` and `line` helpers are at `lafpos-satis.test.ts:36-37`, and `line` defaults to `branchId: "marina"`.
- Build months with `resolveMonth("2026-11", undefined, tillMonths(rows))`, where the rows have `branchId:"marina"`, Z = Σlines, and `discounts: 90` on one day.
- Set `settings: {...base.settings, lafposGecisGunu:"2026-11-01"}` and `lafposSales: {switchDay, countFrom:"2026-11-01", months:[]}`.
- Today `consistency(model,"2026-11").sales.diff === -90` (it should be 0) and `dashboard(...).theoretical.discountsNet === 90/1.1` (it should be 0).
- Transition-month variant: ModPOS gross lines for 1–9 Nov with a discount on those days, plus LafPOS days from 10 Nov with a discount. Today diff = −(LafPOS discount).

## Item 2: "%8 fazla" (gross list compared with net Z)

**Current behaviour:**
- `modposOverZText(revenue, z, from, through)` (`lafpos/sales.ts:174-185`) warns when `revenue > z*1.05`. `revenue` is the ModPOS list, which is before discount; `z` is after discount.
- The band path: `lafposMonthNotes` (`:232-236`) gets `st.modposZ` from `mergeWithLafpos` (`server/data/lafpos-sales.ts:138`). `zOf` is defined in `dataset.ts:449-468` over `reportRows = till.filter(isReportRow && isLafposBranch)`. It is already filtered to Marina, but it sums only `zTotal` and ignores discounts. LafPOS fallback rows and ModPOS föy rows are excluded.
- The import path: `importSales` (`actions/sales.ts:155-225`). At `:209-215` it calls `zTotalBetween(\`${month}-01\`, through)`.
- `zTotalBetween` (`:137-145`) has **no branch filter**. It sums `cash_reports.z_total` for every branch, so Tuzla's Z inflates Marina's Z and hides the warning (a false negative). It also ignores discounts.
- The list total at `:210-213` uses `currentBranchWhere` (the scope) rather than `eq(branchId, sube)`. This only matters in theory, because in "Tümü" the write branch is Tuzla, whose switch day is null, so no warning is produced there.

**What must change:**
- Make `zOf` return `{ z, discounts }` (Σ `r.discounts ?? 0` over the same rows).
- Add `modposDiscounts` to `LafposSalesMonth` (`types.ts:~600-610`) and fill it in `lafposMonthStatus` (`lafpos/sales.ts:120-163`).
- Change `modposOverZText` to compare `revenue − discounts` against `z` (as an extra parameter). Update the comment at `:178-181` and possibly the 5% tolerance.
- Change `zTotalBetween(from, through, branchId)`: add `eq(t.branchId, sube)` and `sum(t.discounts)` (the column is nullable). Better still, share one pure helper with `zOf`.
- Use `eq(s.salesLines.branchId, sube)` for the list total.

**How to reproduce:**
- Pure: following `tests/lafpos-satis.test.ts:264-269`, `modposOverZText(108_000, 100_000, …)` warns today ("%8 fazla") even though an 8,000 discount explains the gap. Line 268 pins the current semantics ("%5'e kadar olağan (liste indirimden önce)") and will need updating.
- DB: `tests/lafpos-satis-db.test.ts:346-370` (`LAFPOS_TEST_DATABASE_URL`, `lafposTest`, the `report(date, zTotal, branchId)` helper at `:93`, the `MODPOS_SUBE` and `LAFPOS_SUBE` helpers from `tests/helpers/subeler.ts`). Insert Tuzla reports for 1–9 Nov: today the "%25 fazla" warning disappears, which shows the branch bug. Give the Marina reports discounts: today it still warns.

## Item 3: bank POS commission (two formulas)

**Current behaviour:**
- **Satışlar / sales report** (`engine.ts:1365-1376` `monthSales`): per line `line.revenue × st.komisyon × cardShareOf(month).rate`.
  - `cardShareOf` (`:925-930`) is (card + meal card) ÷ posRevenue from the till, or the manual value, or `st.kartOrani` (0.856).
  - So the base is Σ list revenue and meal cards are included.
  - The total `MonthSales.commission` (`:1413`) feeds the gross profit of every line.
- **Gelir-gider** (`engine.ts:2263-2266` `pnlMonth`): `info.posRevenue × st.komisyon × bankShareOf(month).rate`.
  - `bankShareOf` (`:940-948`) is Σcard ÷ posRevenue rounded to 4 decimals, with meal cards excluded; with a manual card share it subtracts the meal-card share.
  - The info text comes from `bankShareText` (`:588-595`); the label "BANKA POS KOMİSYONU (%x)" and hint are at `:2462-2465`.
  - Because the share is rounded, the result is only ≈ Σcard × rate, and it is wrong when `posRevenue` was typed manually.
- **Where card and meal-card totals come from** (`TillRow.card`/`mealCard`):
  - `cash_reports.card`/`meal_card` (`cash-reports.ts:319-340`). On LafPOS days the kasa form is prefilled from LafPOS `z.card`/`mealCard` (`prefill.ts:86-87`).
  - LafPOS fallback rows from `pos_day_reports.z` (`lafposTillRows`, `cash-reports.ts:374-399`).
  - ModPOS föy rows (`modposTillRow`, `~:440`).
  - `tillMonths` aggregates them at `cash-month.ts:261-263`, but `TillMonth` exposes **only ratios** (`cardShare`, `bankShare`; `types.ts:156,161`). There is no Σcard amount, so a new `TillMonth.card` (and `mealCard`) sum is needed. The per-branch values are reachable through `Month.byBranch[id].kasa.till` in "Tümü" and through `Month.kasa.till` in single-branch scope.
  - LafPOS `z.card` excludes `cardTips` and `cardCollections`, which do go through the bank POS. Decide whether to add them.
- **Where the rate lives:** `Settings.komisyon` (`types.ts:24-25`; settings table key `komisyon`; sanity check at `server/actions/settings.ts:112`; Ayarlar › "KDV ve komisyon oranları"). The target needs per-branch rates: a new `branches` column through `npm run db:generate`, or a settings key per branch, plus a Dataset field.
- **Target:** one function in the engine, `posCommissionOf(month)` = Σ over branches (Σcard_b × rate_b). Apply it to the `commission:pos` cell, and spread it across `monthSales` lines by revenue share (`total × line.revenue / Σ revenue`).
- **Fallback for months without card data is mandatory.** `tests/calc.test.ts:51-71,74-81,105-121` pins the Excel golden values (`tests/golden.json`): per line `revenue × 0.025 × 0.856`, and Gelir-gider `posRevenue × 0.025 × 0.856`, with different bases. A single total would break one of them unless months without kasa data keep the old formulas.
- **Every caller or display to update:**
  - `engine.ts:1369-1375`, `:2263-2266`, `:2278` (`bankShareText`), `:2462-2465`, the exports at `:2590-2592`.
  - `satislar/page.tsx:151` (`salesBreakdowns(..., cardShareOf)`), `satislar/breakdowns.ts:124,161,211`.
  - `panel/page.tsx:273-274`, `dashboard-breakdowns.ts:186-189`.
  - `insights.ts:657,1495,1517`, `analiz/breakdowns.ts:116,122,228,324`, `analysis-client.tsx:885`.
  - `workbook.ts:345,458-459,620,1073,1078`, `mcp/answers/month.ts:153,164`.
  - Separate and not covered by the target: product economics `engine.ts:160` and `prices/bulk.ts:113` (`komisyon × kartOrani`), and `cash-plan.ts:886`.
- **Tests pinning the current formulas:**
  - `tests/kasa-ay-bilgisi.test.ts:264-297`.
  - `tests/gelir-gider-komisyon.test.ts:66-89,132-149`; its fixture `novemberRows` has card 200k, meal card 30k, Z 300k.
  - `tests/gelir-gider-db.test.ts:76-84` (`GELIR_GIDER_` or `FIFO_TEST_DATABASE_URL`).
  - `tests/modpos-ay.test.ts:126`, `tests/odenmez-ciro.test.ts:103`.
- **How to reproduce:** with the `gelir-gider-komisyon.test.ts` pattern, build Marina rows (`branchId:"marina"`) whose Σcard is 24,774.25 and set a Marina rate of 0.02. Expect `commission:pos === 495.49` and Σ `monthSales.commission === 495.49`. Today you get `posRevenue × 0.025 × round4(card/posRevenue)` and a different Satışlar figure.

## Test infrastructure

- `npm test` runs `tsx --test tests/*.test.ts` (node:test plus `assert/strict`).
- **DB tests.** Every `*-db.test.ts`, plus `ekim-sayimi`, `modpos-sabah`, `sayim-ekle`, `vergi-migration` and `yedek-geri-yukleme`, is skipped unless its `<NAME>_TEST_DATABASE_URL` is set. Relevant names: `LAFPOS_` (`lafpos-satis-db`, `lafpos-db`, `lafpos-kasa-db`, `lafpos-komisyon-ikram-db`), `MODPOS_` (`modpos-ay-db`) and `GELIR_GIDER_`/`FIFO_`. `npm run test:db` (`scripts/test-db.ts`) maps all of them to `TEST_DATABASE_URL` and runs the files one at a time. Most DB tests create their own temporary database and run the migrations.
- **Engine tests** follow this recipe:
  1. `base = { ...excelToDataset(JSON seed src/server/db/seed/excel-data.json), currentMonth }`.
  2. Build `TillRow[]` fixtures, then `tillMonths(rows, through)`, then `resolveMonth(month, entry?, till)`, and add the result to `months`.
  3. Get LafPOS lines from `mergeSalesSources`.
  4. Add `salesCoverage` for `listPeriod`.
  5. Call `createModel(ds)`, then `consistency`/`alerts`/`dashboard`/`pnlMonth`.
- **Fixtures.** There are no Marina/Kasım fixtures with real figures; nothing contains 24,774.25 or 495.49. Marina rows appear in `kasa-ay-bilgisi.test.ts:426-450`. `lafpos-satis*.test.ts` use the switch day S = 2026-11-10 with Marina. The LafPOS golden body is `tests/fixtures/lafpos-gun.golden.json` (identical to the LafPOS copy).
- **Source-regex tests that will break.**
  - Changing `dataset.ts` or `actions/sales.ts`: `tests/lafpos-satis.test.ts:316-340` and `tests/satis-donemi.test.ts:76-97`. The latter asserts `r.date.slice(0, 7) === month && r.date <= upto` and the `importSales` call text.
  - Changing `tillMonths`: `tests/kasa-ay-bilgisi.test.ts:66-106`.
