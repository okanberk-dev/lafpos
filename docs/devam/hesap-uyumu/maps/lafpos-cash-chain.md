# LafPOS cash chain and day opening (Faz 3): code map

The repos were only read. Nothing was edited. LafPOS HEAD is `81f372f`; lafmaliyet HEAD is `7740898`.

## 1. Day opening today

**Server**
- Route `server/routes/cash.ts:131-138`, `POST /api/cash/day/open`. The body is `z.object({ openingCash: kurus })` (`kurus` is defined at `server/lib/http.ts:85`: int, 0 to 1e9). It calls `write()` (`server/routes/pos.ts:29-34`), which runs one transaction and then `fx.flush()`. After that it calls `onlineOrdersDayOpened()`.
- There is no `requirePermission` on the route itself. `openDay` checks `needDirect(actor,'kasa.gun')`.
- Service `server/services/days.ts:30-58` `openDay(t, actor, fx, {openingCash})`, in order:
  1. 409 `day_open` if a day is already open.
  2. 409 `day_closed_today` if today's business date is already closed.
  3. Computes `zNo` with `nextZNo(lastZNo(t), zNoStart)`.
  4. Stores `openingCash = max(0, trunc(input))` as given.
  5. Runs `claimEarlyOnlineOrders`.
  6. Writes the audit row at `:54`: `{action:'day.open', amount: openingCash, message:"… günü açtı (Z n, açılış ₺…)"}`. There is no `data` and no severity (defaults to info).
  7. Emits `cash/day.opened` and `settings/day.opened`.
- **No suggestion exists, the previous day is not compared, and no reason is asked.** No `devir` or `nextOpening` concept exists anywhere in LafPOS (grep is empty).
- `GET /api/cash/day` (`cash.ts:78-95`): when there is no open day it returns `{day:null, summary:null, movements:[], shiftCounts:[], blind, closedToday}`. A suggestion field would go here.
- Other callers of open: `demo/scenario.ts:64` (150000), `e2e/lib.mjs:137` `seedFloor` (100000), `e2e/internet.mjs:76`, and 88 test files that call `/cash/day/open` with arbitrary amounts.

**UI**
- `src/pages/cash/CashPage.tsx`:
  - `openDay()` at `:116-130` posts `{openingCash: parseTL(opening||'0')}`.
  - The "Günü aç" card at `:357-384` (Numpad and `TypedAmount`) only shows when there is no day **and no `closedToday`**.
  - The reopen card (`:298-355`) already has a working "Neden" Field and error pattern (`reasonError`, `reasonRef`). The new opening-reason field can copy it.

## 2. Cash figures (kuruş) and what is sent

`computeSummary` (`days.ts:192-325`, lines `:280-285`) computes:
- `cashSales` = sales payments with `zField==='cash'` (amount + tip)
- `cashCollections` = cash collections with no order
- `cashIn` = Σ movements `giris`
- `cashOut` = Σ `harcama`
- `handedOver` = Σ `teslim`
- `expectedCash = openingCash + cashSales + cashCollections + cashIn − cashOut − handedOver`

At close, `closeDay` (`:379-441`) sets `diff = counted − expectedCash` (`:410`). It stores `countedCash`, `expectedCash`, `cashDiff`, `summary`, and `trainingDay: trainingDayNow()` (`:425`). The audit row is `day.close`, with severity based on `alertCashDiffKurus` (default 10000, `server/lib/settings.ts:80,156`).

`recordCount` (`:606-644`) writes the count after close and re-enqueues the day (`cash.ts:184`). `reopenDay` (`:332-359`) clears `countedCash`, `cashDiff`, `trainingDay` and `exportedAt`.

`lafmaliyetZ` (`:479-502`) converts to TL with `toTL`. `cash_in` (`:498`) is `max(0, expected − opening − byZField.cash + cashOut + handedOver)`, so it covers giriş, cash collections and cash tips.

`buildDayPayload` (`server/sync/lafmaliyet.ts:240-331`) builds the `z` block at `:293-315`: zNo, receipts, zTotal, cash, card, mealCard, online, other, offRevenue, discounts, **openingCash, cashOut, countedCash, handedOver, cashDiff, cashIn, expectedCash**, cardTips, cardCollections. `sube` is rewritten at send time (`:521`).

**Carry-over (`devir`):** in LafPOS a `teslim` can only be written while the day is open (`addCashMovement` uses `requireOpenDay`, `days.ts:88`). It is already subtracted from expected before counting, so **LafPOS has no end-of-day handover after the count, and the carry-over equals `countedCash`.** lafmaliyet reaches the same result: `autoValuesOf` (`src/lib/lafpos/gun-sonu.ts:81-103`) writes `handedOver: 0` and moves teslim into cashOut. lafmaliyet's chain `previousCarryOver` (`src/server/data/cash-reports.ts:178-186`) is `counted − handedOver` of the previous `cash_reports` row of the same branch. It differs from LafPOS only if someone edits the report in the panel, which is the reason to prefer ladmin's value.

## 3. Training/setup days

- `trainingMode()` = `demoMode || okcProvider==='simulator'`; `trainingDayNow()` = `liveSince==null && trainingMode()` (`settings.ts:202-212`).
- `realDay = d.trainingDay === false` (`lafmaliyet.ts:344`). `null` (closed before the flag existed, or currently open) also counts as not real.
- **The seed starts in setup mode** (`server/db/seed.ts:168`: `demoMode:true, okcProvider:'simulator'`). Every harness test and the e2e run therefore produce training days. A suggestion that excludes training days will not appear in tests or e2e unless they call `updateSettings({demoMode:false}); updateSettings({okcProvider:'kapali'})`, as `tests/lafmaliyet-gecis.test.ts:123-125` does, or set `liveSince`.
- This is also good news: making the reason mandatory only when a real previous day exists leaves the 88 existing tests untouched.

## 4. Blind cashier

- `seesCashNumbers` (`server/lib/auth.ts:450-452`) is `kasa.rakam` **or** `rapor.gor`. The task says only `kasa.rakam`; `rapor.gor` also lifts blindness.
- The default `kasiyer` role has neither, so it is blind (`shared/permissions.ts:62-77`). The harness user `kasa` (PIN 1111) is blind.
- How each endpoint hides numbers:
  - `GET /day` sends `summary:null`.
  - Close and count return `summary:null, blind:true`.
  - Shift counts are masked by `blindShiftCount` (`cash.ts:61-65`).
  - Z is filtered by `zSummaryFor` and `summaryFor` (`server/lib/kor-kasa.ts:16,27`).
- `dayToDTO` (`days.ts:19-23`) sends `openingCash` to everyone.
- Alerts (audit rows with non-info severity) only reach `patron.panel` holders (`server/routes/events.ts:41`).

## 5. Audit helper

- `Effects.audit(t, {userId, approverId, action, severity:'info'|'uyari'|'alarm', orderId, entity, entityId, amount, message, data})` at `server/lib/effects.ts:33-53` writes `audit_log` (`server/db/schema.ts:717-733`).
- The audit row is written **inside the transaction**. If the request then throws (for example 422 "reason required"), the audit row is rolled back. Failed opening attempts cannot be audited unless they are written in a separate `write()` or the endpoint returns a non-throwing "needs reason" response.
- The UI label for `day.open` is at `src/pages/admin/AuditAdmin.tsx:68`.
- Tests read audit rows with `GET /admin/audit?limit=100` as patron (`tests/vardiya-sayim.test.ts:26`).

## 6. Cash moves

- `cash_movements` (`schema.ts:341-356`): `{id, dayId, kind:'harcama'|'teslim'|'giris', amount, description, userId, createdAt}`. **There is no category column.**
- `addCashMovement` (`days.ts:86-108`): `need(actor,'kasa.hareket')`, so another person's PIN can approve. A `harcama` without description fails with 400 `reason_required`. The audit action is `cash.<kind>`; severity is `uyari` for amounts ≥ 100000 (giriş is always info).
- Route `cash.ts:189-194`.
- UI modal at `CashPage.tsx:521-560`, the "Açıklama" Field at about `:548`.

## 7. Signed fetch, budget, configuration

- `signedFetch(secret, method, url, body?, timeoutMs=8000)` (`server/lib/signature.ts:51-91`) does not follow redirects and updates the internet state.
- `configured()` = `LAFMALIYET_URL` plus `LAFMALIYET_SYNC_SECRET` ≥ 32 characters (`lafmaliyet.ts:334`). These come from `server/env-config.ts:17-24` and are editable in Yönetim › Bağlantı bilgileri (`shared/baglanti.ts:41-42,59-60`).
- With an empty `LAFFOGATO_URL`, no request goes to the site.
- Model for a signed GET: `pullCosts` (`lafmaliyet.ts:712-739`), with state in `sync_state` via `getSyncState`/`setSyncState` (`settings.ts:241-253`). It keeps the previous data on a bad body and fails with 502.
- Model for a 5-minute throttle: `KARAOKE_AUTO_MIN_MS = 5*60_000` (`server/sync/laffogato-karaoke.ts:37`), auto tick at `:276-285`, on-demand refresh that only pulls when stale (`:292-303`).
- Jobs: `server/jobs.ts:276-282`; outbox flush every 60 s.
- Rule 6 in `AGENTS.md` names only laffogato. For lafmaliyet the budget lives in `docs/03-ENTEGRASYON.md` §5, which needs a new row.

## 8. ladmin (lafmaliyet) side today

- `POST /api/pos/gun` (`src/app/api/pos/gun/route.ts:25-54`) leads to `handlePosDay` (`src/server/lafpos/status.ts:138-171`). The 200 body is `{ok, date, lines, matched, unmatched, counted, switchDay}` (`:170`). **There is no `nextOpening`.**
- The cash report is written **after** the response (`after(() => runLafposDayEnd…)`, `route.ts:45-48`). A `nextOpening` returned in the same 200 must be computed synchronously: the existing report for `date` (counted − handed) if there is one, otherwise `z.countedCash`, otherwise null.
- The comment at `status.ts:134-137` says "LafPOS yanıtın gövdesini okumaz", which is outdated: LafPOS does read it.
- `posZSchema` (`src/lib/lafpos/day.ts:45-75`) is a plain `z.object`, so unknown keys are stripped. Adding `openingDiff` and a reason to `z` therefore cannot break ladmin, but ladmin ignores them until the schema reads them.
- ladmin already has the matching rule:
  - `CASH_TOLERANCE = 1` TL (`src/lib/cash-report.ts:81`)
  - `carryCheck` (`:220-226`, diff = opening − carry)
  - `openingNeedsNote` (`:281-284`, a note is required on mismatch)
  - `autoValuesOf` writes "Açılış önceki raporun devrinden X az/fazla" into the note (`gun-sonu.ts:81-90`). A LafPOS reason could fill this note.
- Expense categories: `expense_categories` (`src/server/db/schema.ts:742-756`: id, name unique, section, panelGroup, active, sortOrder…). **No signed endpoint exists.** The model to copy is `GET /api/panel/pos/urunler` (`route.ts`) with `servePosProducts`, which uses `checkLafposRequest` (`src/server/lafpos/products.ts:21-29`).
- Golden: `cmp` confirms the two golden files are byte-identical. ladmin's test is `tests/lafpos.test.ts:675-717`.

## 9. What has to change

**A. Suggested opening**
- Add `suggestedOpening(t)` in `services/days.ts`:
  - Take the last day with `closedAt` set and `trainingDay === false`, ordered by zNo descending.
  - Source 1 (`lafmaliyet`): the ladmin `nextOpening` (see D).
  - Source 2 (`lafpos`): `countedCash`.
  - Otherwise null. Uncounted days (automatic end of day before the count sheet is entered) give no suggestion.
- Expose it in `GET /cash/day` when there is no day, as `{suggested, source, fromDate}` for users who see numbers. Blind users get only `{check:true}`.
- UI: prefill or show it on the "Günü aç" card.

**B. Mandatory reason on mismatch**
- Extend the body: `z.object({openingCash: kurus, reason: z.string().max(200).nullish()})`.
- In `openDay`: if `|openingCash − expected| ≥ 100` kuruş (matches ladmin's 1 TL) and there is no reason, throw 422 `opening_reason_required`.
  - Message for blind users: "Sayımınız beklenenden farklı; nedenini yazın", with no amounts in `extra`.
  - For other users, `extra` carries `{expected, diff}`.
- New columns on `business_days`: `expectedOpening`, `openingDiff`, `openingReason`, added in `server/db/schema.ts:310-339`, then `npm run db:generate` and commit the migration. `demo/migrations.ts` picks it up through its glob.
- Audit at `days.ts:54`: add `data: {expected, diff, source, reason}` and severity by `alertCashDiffKurus`, similar to `day.close` at `:430-437`.
- **Risk:** a blind cashier can probe amounts (each mismatch answers "farklı", so they can find yesterday's count). Mitigations: audit each attempt outside the rolled-back transaction, or limit attempts.

**C. Body fields**
- In `buildDayPayload` `z` (`lafmaliyet.ts:304-315`), add `openingDiff` (TL, signed, nullable) and a reason field.
- Prefer the name `openingReason`. The task's plain `reason` collides with `ikram[].reason`.
- Regenerate the golden with `LAFPOS_GOLDEN=1 npx vitest run tests/lafmaliyet-gun.test.ts`, copy it to `lafmaliyet/tests/fixtures/lafpos-gun.golden.json`, extend ladmin `posZSchema`, and update §4 of `docs/03-ENTEGRASYON.md`.

**D. nextOpening from the ladmin 200 response**
- ladmin: add it to the `status.ts:170` body.
- LafPOS:
  - Add `nextOpening: z.number().finite().min(0).nullable().optional().catch(undefined)` to `answerShape` and to the `DayAnswer` interface (`lafmaliyet.ts:396-423`).
  - Mirror the field in the UI copy at `src/lib/lafmaliyet.ts:7`.
  - Convert TL to kurus with `Math.round(x*100)`.
- **Read it from the day's own outbox row, not `lastAnswer`.** `sendDue` (`:506-570`) keeps only the last row of a batch, and backfilled older days are sent after newer ones.
  - Use the newest row with `sentAt` set whose dedupe key is `gun:<date>`.
  - If a newer unsent row exists for that date (a recount is pending), use the local `countedCash`.
  - The `response` column is stored at `:542`.

**E. Expense categories**
- ladmin: new signed GET, for example `/api/panel/pos/gider-kategorileri`, returning `{version:1, items:[{id,name,section,active}]}`. Add a signature vector to `tests/signature.test.ts` on both sides.
- LafPOS: `pullExpenseCategories()` modelled on `pullCosts`.
  - State in `sync_state` `lafmaliyet.expenseCategories` `{at, items, lastError}`.
  - Throttle to ≥ 5 min: pull on demand when the harcama modal opens or the day opens, only if stale. No pull at night, and no pull when not configured.
- Add `categoryId` or a category name snapshot to `cash_movements` (migration), the movements body (`cash.ts:190`), and `addCashMovement`.
- UI: a category select in the harcama modal, falling back to free text.

## 10. How to test

All of these use `startApp` (`tests/harness.ts`):
- **Suggestion and mismatch:** first leave setup mode (`updateSettings({demoMode:false}); updateSettings({okcProvider:'kapali'})`). Then open, close with `countedCash: X`, and open again with `≠X`.
  - Today this returns 200. After the change it should return 422.
  - The next day needs a date shift: `day_closed_today` blocks a same-date reopen, so either set the closed row's `date` to yesterday directly through `db`, or use the `staleDayId` style in `tests/vardiya-sayim.test.ts:38`.
- **Blind behaviour:** follow `vardiya-sayim.test.ts:59-64,129`. The blind user is `kasa`; `mudur` sees numbers.
- **Golden and payload:** `tests/lafmaliyet-gun.test.ts` (`freshDay` at `:72-80`).
- **nextOpening and categories:** use the fake ladmin HTTP server in `tests/lafmaliyet-gecis.test.ts:31-47` with `dayReply`, `costsReply` and the `calls[]` counters. It has no `nextOpening` today. Assert one GET per 5-minute window.
- Every server test also runs under sql.js (`vitest.config.ts`, project `sqljs`).

## 11. UI screens, e2e and demo

- **Screens:**
  - `CashPage.tsx`: Günü aç card, move modal, reopen card.
  - `src/pages/cash/ZView.tsx:131,199`: "Açılış nakdi".
  - `src/lib/print.tsx:532`: Z print row.
  - `AuditAdmin.tsx:68`.
  - `src/pages/admin/IntegrationAdmin.tsx` with `src/lib/lafmaliyet.ts` `answerText`, for the lafmaliyet answer and category status.
- **e2e:**
  - `ROUTES` is at `e2e/run.mjs:110`; the kasa role covers `/kasa` and `vardiya` (`:279-288`).
  - `tests/ui-rules.test.ts:73-83` only checks `ADMIN_SECTIONS`, so the AGENTS rule 11 check covers admin sections only.
  - The "Günü aç" card is never swept, because `seedFloor` opens the day first, and setup mode means no suggestion would appear anyway. It needs a flow in `e2e/flows.mjs`, modelled on the reopen flow at `:1279-1301`. The 44 px targets and overflow checks are already done there.
- **Demo:**
  - `demo/vite-plugin.ts:9-26` swaps `server/env.ts` and `db/client.ts` and maps Node builtins to `demo/shims/*` (crypto supports `createHash`/`createHmac`).
  - `demo/env.ts` has empty URLs, so `configured()` is false and no requests are made. The demo does not start jobs.
  - New code must not add Node builtins or disk reads without a shim.
  - `demo/scenario.ts:64` opens with 150000 and runs in setup mode, so no reason prompt will appear there.

## 12. Corrections to the task

1. "Blind = `kasa.rakam`": `rapor.gor` also lifts blindness.
2. "devir = counted − end-of-day handover": LafPOS has no post-count handover, so the carry-over is `countedCash`. The formula is ladmin's, from its panel report.
3. `nextOpening`, `openingDiff`, a reason field and the expense-category endpoint do not exist in either repo yet.
4. The ladmin comment says LafPOS does not read the 200 body; it does.
5. Setup mode is the default in the seed, the tests and e2e.
