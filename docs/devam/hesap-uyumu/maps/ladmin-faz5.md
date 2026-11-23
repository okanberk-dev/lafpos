# lafmaliyet Faz 5 (branch, staff, rent): code map, no decisions

Repo: /home/user/lafmaliyet (HEAD 7740898). The golden bodies are identical: `cmp` of LafPOS `tests/fixtures/lafmaliyet-gun.golden.json` and lafmaliyet `tests/fixtures/lafpos-gun.golden.json` passes. The gün body carries no staff or rent data. LafPOS `docs/03-ENTEGRASYON.md:698` says no personal data is sent. LafPOS's own "vardiya" is a cash-drawer handover (`server/services/days.ts:507`) and is unrelated to the ladmin Vardiya plan. laffogato has nothing relevant.

## Where the task is wrong vs the code
- **Money.** lafmaliyet staff and fixed-expense amounts are `doublePrecision` TL, not integer kuruş (`schema.ts:645-646,676`). Only LafPOS uses kuruş.
- **muhtasar.ts ~203-209** is `rentWithholdingIn` (`:207`). The rent logic is elsewhere:
  - official gross used as the stopaj base: `muhtasarItemsFromModel` `:254-263`
  - stopaj calculation: `own()` `:105-122`
  - unknown-stopaj rule: `withholdingUnknown` `:86-93`
- **engine.ts.** `officialRentGross` is at `:414-419` and the P&L stopaj block at `:2219-2229`. Both are close to the task's numbers.
- **docs/SUBE.md line refs:**
  - The "giderler işletme geneli" decision is `:53`; line `:56` is the stock row.
  - `:58-59` (and `docs/planlar/sube.md:105-106`) promise a separate "İşletme geneli" column in the Tümü breakdown. **This is not implemented**; no grep hits in `src/`.
  - `:92-94` (branchWhereWithShared), `:128` and `:133-135` are correct.
- **Part-time.** The seed has "Part-time çalışan" at **3,000 ₺/week**, not 5,000 (`src/server/db/seed/excel-data.json`). The live value is unknown.
- **Meal card default.** The code has no per-person worked days. `acikGun` defaults to **30** (`constants.ts:18`), not 26. The existing "Personel yemeği" item is a business-wide fixed expense: `gunluk` 330 × the business's open days, not per person (seed note: "Kişi başı 330 TL ise ×2").
- **Two staff-cost formulas.** The task's numbers match the P&L formula (Settings rates). The Vergi payroll, which the nakit planı uses, applies different rates (see Staff below).

## Staff: current formula and the four numbers
`staffCost` (`engine.ts:347-361`):
- gross = net ÷ (1 − isciSgk − isciIssizlik)
- total = gross + gross×isverenSgk + gross×isverenIssizlik + **extras** (extras are not grossed up)

Defaults are 0.14, 0.01, 0.1575 and 0.02 (`constants.ts:19-22`). Computed:

| Person | Input | gross | total | Expected |
|---|---|---|---|---|
| Alper | 35,000 net + 8,580 in extras | 41,176.47 | **57,065.29** | 57,065 ✓ |
| Cem | 32,000 + 8,580 | 37,647.06 | **52,909.41** | 52,909 ✓ |
| Damla | 30,000 + 7,500 | 35,294.12 | **49,058.82** | 49,059 ✓ |
| Berkan | 32,000 + 0 | 37,647.06 | **44,329.41** | 44,329 ✓ |

- The numbers only match if the 8,580 sits in `extras`.
- Berkan's net is not stated in the task. 44,329 implies 32,000 net with no extras and no meal card.
- Damla and Berkan therefore get no meal card. Confirm that is intended.
- `tests/personel-rates.test.ts:61` already checks 30,000 → 41,558.82.

**Data model:**
- `staff` table (`schema.ts:640-652`): `branchId` NOT NULL default `tuzla` (`:39,643`), plus `netSalary`, `extras`, `startMonth`/`endMonth`.
- `staff_versions` (`:654-668`) versions **only netSalary and extras**. Branch has no history.
- No fields exist for meal card, daily wage, part-time flag, worked days or a user/vardiya link.
- Types: `types.ts:310-329`.
- UI: the "Yemek / yol / prim (₺)" field (`staff-editor.tsx:1078`, tip "yemek kartı, yol parası, prim") mixes meal card, transport and bonus into one value.

**P&L rows** (`engine.ts:2185-2205`):
- `personnel:net`.
- `personnel:employer` = total − net. This **one cell** holds employee deductions, employer SGK and extras (`PERSONNEL_EXTRA_LABEL` `:568`, `personnelExtraText` `:574-586`).
- There is no meal-card sub-row.
- Other personnel rows: `manual:personel_extra` (`constants.ts:191`) and the fixed items "Personel yemeği" and "Part-time" (section `personel`).
- The Genel bakış group "Personel (maaş + SGK, part-time, yemek)" (`constants.ts:205-209`, `insights.ts:276-277`) sums all of these.
- **Double-count risk:** a per-person meal card in extras plus the business-wide "Personel yemeği" item.

**Vergi / nakit planı payroll:**
- `taxPayrollFromModel` (`tax/payroll.ts:300-320`) uses the legal 2026 rates: employer **19.75%**, PEK, GV/DV, min-wage exemption (header `:1-7`).
- Extras are added without gross-up.
- Nakit planı pays net + extras and its own SGK (`cash-plan.ts:688`).
- All months count as full; there are no days.

**Customer vs staff meal card:**
- Customer meal card: `cash_reports.mealCard`, LafPOS `z.mealCard`/`payments[].channel` (golden: Pluxee 290), commission channels.
- Staff meal card exists only as free text inside extras or "Personel yemeği".
- LafPOS's "Ödenmez: Personel yemeği" is product consumption that lands in ikram (`lafpos/ikram.ts:41`). It is not the cash allowance.
- Mixing risk: a staff-card top-up invoice from Pluxee filed under "Komisyon" would be matched to the commission channel (`engine.ts:2266-2275`).

## Part-time and Vardiya
- **Today:** "Part-time çalışan" is a fixed expense (`personel`, `haftalik`, ×52/12 via `fixedMonthly` `engine.ts:376-389`). Its branchId is null in the seed, i.e. business-wide.
  - `tax/pnl.ts:988` flags it with the regex `/part.?time|yarı zamanlı/`.
  - Nakit planı tests use a weekly "Part-time çalışan" reminder (`tests/nakit-plani.test.ts:343,373`).
- **Removal:** an item used in past months cannot be deleted; it must get an `endMonth` (delete blockers `staffUsedMonths`/`dataMonths`, `costs.ts`, read in ALL_BRANCHES per `SUBE.md:115-119`).
- **Vardiya data:** the `shifts` table (`schema.ts:2415-2440`) is keyed per branch+date+person.
  - `personRef` is `u:<users.id>` or `n:<name>`. `kind` is work or off, with start/end minutes. There is no wage.
  - The roster comes from **`users`**, not `staff` (`vardiya/store.ts:75-86`, filter `users.branchId`).
  - There is **no link between `staff` and `shifts`**, and the model's `Dataset` does not load shifts (`dataset.ts:86-158`).
  - Helpers exist: `shiftMinutes`/`rowMinutes`/`dayHeadcount` (`lib/vardiya.ts:168,293,295`), `loadShiftEntries` (week only; `store.ts:54`). There is no month counter.
- **Moving İbrahim to Tuzla:** changing `staff.branchId` (`saveStaff` `costs.ts:142-235`) rewrites **all past months**.
  - The dataset filters on the current branchId (`dataset.ts:97`), and there is no branch version.
  - Fixed-expense `branchId` behaves the same way.

## Rent and stopaj
**Model:** `fixed_expenses` (`schema.ts:670-711`) has:
- `amount` excl. VAT
- `vatRate`, which defaults to the section rate: kira **0.2** (`constants.ts:167,177-179`)
- `taxDoc` and `taxWithholding`
- `officialAmount` and `officialBasis` brut|net
- `prorate` (schema default true)
- `branchId` nullable (null = işletme geneli)

`officialAmount` has **no history**: one value applies to all months (`types.ts:344-349`).

There are two ways to model a landlord who is a person. They are kept mutually exclusive in code:
- **(A) officialAmount set:**
  - P&L adds a `stopaj:<id>` row = official gross × 20% × day share (`engine.ts:2219-2229`). Kira section = amount + stopaj.
  - Muhtasar base = official gross (`muhtasar.ts:257-262`).
  - Nakit planı pays the landlord amount × (1+vatRate) with no withholding (`cash-plan.ts:693-701`). The stopaj goes out through the muhtasar line.
  - Vergi: rent expense = official gross only; the rest is undocumented (`tests/kira-stopaj.test.ts:64`).
- **(B) `taxWithholding:"kira"` and no officialAmount:**
  - No P&L stopaj row.
  - Muhtasar base is the full amount.
  - Bank pays amount × (1+vat−0.2) (`cash-plan.ts:131,134-139`).
- A fixed-amount "Kira stopajı" reminder can stand in for muhtasar's rent part (`reminders.ts:724`, `cash-plan.ts:1375-1412`, VG-02). This is a third source.

**Tuzla (160k to a person, official 100k):**
- Under (A) with `officialBasis:"brut"`, P&L = 160,000 + 20,000.
- If the basis is `net`, gross is 125,000 and stopaj 25,000 (`officialRentGross` `:415-419`). The task's "100,000" does not say which.
- **Nakit planı pays 192,000 unless the row's `vatRate` = 0.** Seed rows have no vatRate, and the tests patch `vatRate: 0` explicitly (`kira-stopaj.test.ts:21`).
- The live row's `branchId` is unknown. Existing items stayed işletme geneli (`SUBE.md:133`). If still null, Tuzla's rent and stopaj show in Marina's view.

**Marina (company landlord):**
- November is 0 via `startMonth "2026-12"` or a version.
- Nakit planı gives 160,000 × 1.2 = 192,000 by default ✓.
- The **32,000 deductible VAT is counted only from the Paraşüt invoice** (`kdv.ts:143-151`, category "Kira & AVM"), not from the fixed item.
- If taxDoc and taxWithholding are left empty, the kira section makes muhtasar "en az" (unknown stopaj, `muhtasar.ts:86-93`). It needs `taxDoc:"fatura"` or `taxWithholding:"yok"`.
- A new item created while "Tümü" is selected defaults to işletme geneli (`SUBE.md:159`).

**Minor:**
- The stopaj row's existence check hard-codes 0.2 (`engine.ts:2438`), and its hint text hard-codes "%20" and "÷ 0,8" (`:2445`).
- The label switches to "<AD> STOPAJI" when more than one item has an official rent (`:2442`).

## Branch filtering today
- **Scope:** read from the `laf_sube` cookie (`currentBranchScope`, `server/branch-scope.ts`; `branchWhere` `:224`, `branchWhereWithShared` `:233`).
- **Filtered per branch** (`dataset.ts:92-143`): months, salesLines, staff, stockCounts, stockExtras, waste.
- **Expense entries** are filtered "with shared". **Fixed expenses** include the branch's items plus all null-branch items (`dataset.ts:172`).
- **Site sales** only appear in Tümü and the online view.
- **Tümü per-branch day proration:** `branchDays` (`engine.ts:2112-2115`).

**What leaks across branches:**
1. Every business-wide fixed item and harcama counts **100% in every branch view**: Personel yemeği, Part-time, muhasebe, reklam, and possibly the Kira row. This is deliberate (`branchViewNote`, `branches.ts:325-333`). Marina + Tuzla > Tümü, and no allocation or "İşletme geneli" column exists.
2. `manual:*` P&L cells (su, personel_extra, diger_mal) show in every branch (`branches.ts:281`). `pnl_entries` has no branch column (`schema.ts:801-813`).
3. **Commission invoices** ("Komisyon": Pluxee, Multinet, platforms) are not branch-filtered. Invoices load unfiltered (`dataset.ts:94`), and each branch's P&L adds all of them (`engine.ts:2266-2275`).
   - `commission:pos` uses the branch's revenue and the branch's bank share.
   - `personnel:*`, `commission:*` and `stock:*` cannot be edited in a branch view (`companyPnlKey` `branches.ts:291`).
4. The **Komisyon screen** is business-wide.
   - `loadCommissionInput` reads cash_reports of all branches (`server/data/commission.ts:98-108`).
   - LafPOS payment days are read without branchId (`:148-165`).
5. Staff and fixed-item `branchId` has no history, so a move rewrites past months.
6. Business-wide screens are always Tümü: Vergi, Nakit planı, Tutarlılık, Excel (`SUBE.md:96-100`).

## How to reproduce today (patterns and helpers)
- **Pure engine tests:** follow `tests/kira-stopaj.test.ts`. It uses `excelToDataset(seed)` + `createModel`, the `withKira(patch)` and `close()` helpers, `stopajKey`, `muhtasarItemsFromModel` and `bridge`.
- **Branch view:** follow `tests/sube-maliyet.test.ts:24-33`, which sets `branchView` on the dataset. `createModel` does not filter, so the test must filter staff and fixed itself, mimicking `dataset.ts:97,172`.
  - Leak 1: two branch views with a null-branch fixed item, summed vs Tümü.
  - Leak 3: a "Komisyon" invoice that shows in both views.
- **Tuzla 192k:** use `planInputFromModel(createModel(...))` with a Kira row where `vatRate` is null, `officialAmount` is 100,000, and no `vatRate: 0` patch (as in kira-stopaj.test.ts). Assert the fixed `vatRate` is 0.2. Follow `tests/nakit-plani.test.ts:429-485` (`input`, `rem`, `lineAt` helpers).
- **Staff numbers:** `staffCost({netSalary, extras}, DEFAULT settings)`, as in `personel-rates.test.ts:61`.
- **Branch-move history rewrite:** DB test pattern in `tests/sube-silme-engeli-db.test.ts` (`SUBE_TEST_DATABASE_URL`, `withBranchScope`, `costs.saveStaff`). Branch fixtures: `tests/helpers/subeler.ts` (`seedBranches`, `LAFPOS_SUBE="marina"`, `MODPOS_SUBE="tuzla"`).
- **Muhtasar "en az" for Marina's rent:** `withholdingUnknown({section:"kira", withholding:null, doc:null, amount:160000, ...})` returns true (`tests/vergi-muhtasar.test.ts` pattern).
