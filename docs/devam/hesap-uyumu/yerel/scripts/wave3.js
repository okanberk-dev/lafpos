export const meta = {
  name: 'hesap-uyumu-wave3',
  description: 'Implement, independently review and fix the hesap-uyumu packages named in args.ids',
  phases: [
    { title: 'Implement', detail: 'one agent per package, in its own repo/worktree' },
    { title: 'Review', detail: 'fresh skeptical reviewer per package, read-only + full checks' },
    { title: 'Fix', detail: 'apply verified findings, rerun checks, commit' },
  ],
}

const S = '/Users/okanberkmanavoglu/laf/wt/lafpos-notlar/docs/devam/hesap-uyumu'
const CONTRACT = `${S}/CONTRACT.md`

const PKGS_ALL = [
  {
    id: 'LP-C', repo: '/Users/okanberkmanavoglu/laf/lafpos', branch: 'claude/personel-baglanti', base: 'claude/kasa-zinciri',
    maps: ['lafpos-body.md', 'staff-link.md'],
    scope: `LafPOS staff link (owner decision 2: "ladmin'de hesapları var; doğru hesabı bağladığından emin ol" → explicit, confirmed links only, never auto-link, never preselect). FIRST: \`git -C /Users/okanberkmanavoglu/laf/lafpos checkout claude/kasa-zinciri && git -C /Users/okanberkmanavoglu/laf/lafpos checkout -b claude/personel-baglanti\` (stacked on LP-B, PR okanberk-dev/lafpos for claude/kasa-zinciri; review diff base claude/kasa-zinciri). Spec: CONTRACT §4 LP-C bullet (authoritative item list), §2 (workedStaffRefs), §3 (GET /api/panel/pos/personel?sube=… shape and the 200 answer's staff {counted, unknown, otherBranch}). ladmin's endpoint does not exist yet (LM-4 builds it later from YOUR shape): build against the §3 shape with a fake ladmin server in tests; add the signature vector for GET https://ladmin.laffogato.net/api/panel/pos/personel?sube=marina at ts 1760000000 with the existing test secret to tests/signature.test.ts (LM-4 will copy it). Items: users.staffRef (nullable, unique partial index; npm run db:generate), GET /api/admin/ladmin-personel (personel.yonet; on demand, memory cache ≤5 min, 503 when not configured/unreachable), PATCH /users/:id staffRef validated against a fresh list (active, not linked to another user → 409 staff_ref_taken; link refused offline, unlink allowed offline; patchOf), audit user.staff_link with no ladmin name, UserDrawer picker with tr-TR folded name-similarity hint, confirm dialog showing both sides, extra "Eminim" checkbox on low similarity, badge "ladmin'de bulunamadı" when the ref is missing; workedStaffRefs from activity signals resolved at SEND time like sube; Kasa › Geçmiş günler "Bugün çalışanlar" correction stored as business_days.workedUserIds overriding the derived list (audited); parse staff in the 200 answer and show unknown/otherBranch in Entegrasyon; docs/03 KVKK sentence "ad gitmez; yalnız ladmin personel kimliği"; demo shims if needed (AGENTS.md rule 13). Golden: unchanged bytes when no user has a staffRef (assert), plus a second golden case with links. 44 px targets, Turkish copy, e2e ROUTES if a new screen (rule 11). FULL checks: npm run typecheck && npm test && npm run build && flock /tmp/lafpos-e2e.lock npm run e2e.`,
  },
  {
    id: 'LM-3', repo: '/Users/okanberkmanavoglu/laf/lafmaliyet', branch: 'claude/kasa-zinciri', base: 'claude/lafpos-gun-alanlari',
    maps: ['ladmin-ingest.md', 'cash-moves.md'],
    scope: `lafmaliyet Faz 3 READER (kasa zinciri + cash moves line by line, owner decision 3 = LAFPOS.md "Soru 5" answered: yes). FIRST: \`git -C /Users/okanberkmanavoglu/laf/lafmaliyet checkout claude/lafpos-gun-alanlari && git -C /Users/okanberkmanavoglu/laf/lafmaliyet checkout -b claude/kasa-zinciri\` (stacked on LM-2; review diff base claude/lafpos-gun-alanlari). Sender: LafPOS branch claude/kasa-zinciri (LP-B, finished): read \`git -C /Users/okanberkmanavoglu/laf/lafpos diff claude/sleepy-knuth-144kr7..claude/kasa-zinciri -- server/sync/lafmaliyet.ts server/services/devir.ts docs/03-ENTEGRASYON.md tests/signature.test.ts tests/fixtures\` for the exact shapes (openingDiff/openingReason/expectedOpening in z, cashMoves[], the devir and gider-kategorileri GETs). Spec: CONTRACT §4 LM-3 bullet, §2, §3, §6. Items: (1) the 200 of POST /api/pos/gun adds nextOpening {amount TL, source "kasa_raporu"|"lafpos"} | null in handlePosDay (not receivePosDay): stored cash_reports row of (date, branch) → countedCash − handedOver, else z.countedCash, null when not counted; (2) signed GET /api/panel/pos/devir?date=YYYY-MM-DD → {version:1, date, nextOpening}; (3) signed GET /api/panel/pos/gider-kategorileri → {version:1, now, items:[{id,name,section}]} only staff-usable categories, no amounts; both with LAFPOS_SYNC_SECRET like /api/panel/pos/urunler, Cache-Control no-store, and the SAME signature vectors as LafPOS tests/signature.test.ts (copy them into tests/lafpos.test.ts); (4) schemas read openingDiff/openingReason/expectedOpening/cashMoves optional + .catch(undefined); (5) cashMoves → cash_outs: unique lafpos_id, adopt a matching manual row one-to-one, remove LafPOS rows absent from a resent body, lock LafPOS-owned fields in the UI/actions, staff may still attach photo/category; giris rows not in cash_outs; only for counted LafPOS days; never double count with manual rows (migration via npm run db:generate, R2); (6) openingDiff/openingReason into the cash report note / day view; (7) docs/LAFPOS.md: Soru 5 answered, new endpoints, 200 body; (8) golden tests/fixtures/lafpos-gun.golden.json and tests/fixtures/kabul-gunu-2026-11-22.json byte-identical to the LafPOS claude/kasa-zinciri tip (git show … | cmp); (9) acceptance: the 22.11 day answers nextOpening 1.279,50 (§6) and the 800 TL "Diğer fatura dışı" fişsiz harcama lands once in cash_outs (DB test). (10) LP-B heads-up: the LafPOS golden z values changed (countedCash 1835→1685, handedOver 0→200, cashIn 0→50, expectedCash 1845→1695), so tests/lafpos.test.ts assertions on the golden (around line 708) must be updated, not only the fixture copied. (11) Stale nextOpening in the 200: ladmin writes the auto cash report in after(), i.e. AFTER answering, so the answer to a re-push (recount, or reopen + re-close) computes nextOpening from the PREVIOUS push's stored report and echoes the old count as source kasa_raporu. LafPOS LP-B works around it (docs/03 §4.6 on claude/kasa-zinciri), but fix it at the source: when the stored cash_reports row for (date, branch) is LafPOS's own auto report not edited by a person, compute nextOpening from the incoming body (same formula the auto report will store); a person-edited report keeps winning. Test-first (recount re-push answers the new count). FULL checks: npx next typegen && npx tsc --noEmit && npm run lint && npm test && flock /tmp/lafmaliyet-db.lock env TEST_DATABASE_URL=postgres://ci:ci@localhost:5433/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db.`,
  },
  {
    id: 'LP-E', repo: '/Users/okanberkmanavoglu/laf/lafpos', branch: 'claude/sube-fiyati-kasa', base: 'claude/personel-baglanti',
    maps: ['branch-price.md'],
    scope: `LafPOS branch price consumption (owner decision 1). FIRST: \`git -C /Users/okanberkmanavoglu/laf/lafpos checkout claude/personel-baglanti && git -C /Users/okanberkmanavoglu/laf/lafpos checkout -b claude/sube-fiyati-kasa\` (stacked on LP-C; review diff base claude/personel-baglanti). The site side is done in laffogato branch claude/branch-prices (PR okanberk-dev/laffogato#301): read /Users/okanberkmanavoglu/laf/laffogato/docs/PANEL-MENU.md "Şube fiyatı" and src/app/api/panel/menu/route.ts for the signed read (priceMinor = price in force now at the branch, basePriceMinor/basePriceMinorL/priceFrom per item, top-level nextPriceAt). Spec: CONTRACT §4 LP-E bullet, §2 (lines[].listPrices), §8. Items: lines[].listPrices in the day body; read optional nextPriceAt from the signed panel menu and schedule exactly one forced menu sync at that instant while the day is open (and at day open if it has passed); when the signed panel read fails, do NOT overwrite existing linked products' prices with public (Tuzla) prices (keep last signed price; log/Entegrasyon note); old site without the new fields keeps working; respect the sync budget (AGENTS.md rule 6). Tests test-first; golden + acceptance fixture regenerated (LAFPOS_GOLDEN=1). FULL checks: npm run typecheck && npm test && npm run build && flock /tmp/lafpos-e2e.lock npm run e2e.`,
  },
  {
    id: 'LM-4', repo: '/Users/okanberkmanavoglu/laf/wt/lafmaliyet-faz5', branch: 'claude/personel-sube-kira', base: '2854165',
    maps: ['ladmin-faz5.md'],
    scope: `lafmaliyet Faz 5: staff meal card, part-time daily model, rent landlord type, "İşletme geneli payı (bilgi)" (owner decisions 4, 11, 12; CONTRACT §4 LM-4 bullet minus the LafPOS staff-link reader, which is a later package LM-4b; §6 staff/rent/Tümü acceptance lines). Work ONLY in the git worktree /Users/okanberkmanavoglu/laf/wt/lafmaliyet-faz5 (branch claude/personel-sube-kira, already checked out at 2854165 = the LM-3 tip; node_modules is a symlink to /Users/okanberkmanavoglu/laf/lafmaliyet/node_modules). LM-3 (branch claude/kasa-zinciri in /Users/okanberkmanavoglu/laf/lafmaliyet) is still under review and may get more commits: do NOT merge or rebase it, the orchestrator merges later. Migrations: npm run db:generate (R2). Money in lafmaliyet is TL doublePrecision (not kuruş). Use flock /tmp/lafmaliyet-db.lock for test:db (shared DB with the other lane).
Items:
(1) Staff meal card as its OWN sub-row: settings mealCardDaily (default 330) and mealCardDays (default 26) editable in Ayarlar; per-staff flag mealCard (default off; owner turns it on for Marina's Alper and Cem himself — DATA, do not seed names). Employer cost of a flagged person adds mealCardDaily × days, NOT grossed up, shown as its own P&L personnel sub-row (e.g. "Personel yemek kartı") and on Maaşlar; worked days = mealCardDays for now (LM-4b will switch to LafPOS worked days when every counted LafPOS day of the month carries them — leave a clean hook). §6 numbers with DEFAULT settings: Alper 35.000 net + meal card → 57.065, Cem 32.000 + meal card → 52.909, Damla 30.000 + 7.500 extra (not grossed up) → 49.059, Berkan 32.000 from November → 44.329 (staffCost; round to TL for the assertion). No double count: warn (Genel bakış/alerts + on the staff editor) when, in the same month and branch scope, a flagged person exists AND the business-wide fixed item "Personel yemeği" is active, and when a flagged person's extras text/amount looks like a meal card (only a hint; never auto-change data). The staff editor's "Yemek / yol / prim" tip must say the meal card is now its own field. Nakit planı / Vergi payroll: the meal card is a cash outflow like extras (not grossed up); keep the legal tax payroll unchanged except where it must include it; document the treatment.
(2) Part-time daily model from 2026-12: staff kind full_time | part_time; a part-time person has dailyWage (TL, the business's cost per called day, no SGK gross-up — say so in the UI hint and docs and list it as an owner confirmation in the PR body), mealCard flag (mealCardDaily × called days) and extras (not grossed up). Called days = Vardiya work shifts (shifts.kind = work) of that person in the month in that branch. Link a staff row to its Vardiya person explicitly: staff.userId (a ladmin login account; admin only; unique; validated; never auto-linked; the Vardiya ref is then u:<userId>) or staff.personRef n:<name> for people without an account; the Maaşlar editor offers a picker with both sides visible and never preselects. The weekly fixed item "Part-time çalışan" STAYS for 2026-11 (owner sets its endMonth 2026-11 himself; do not change data); warn when a month has both the weekly part-time fixed item active and a part-time daily staff row with called days (double count risk). A part-time person without a Vardiya link shows a warning, not a guessed amount.
(3) Rent landlord type on kira fixed items: landlordType şahıs | şirket | null. şahıs → no VAT anywhere (P&L, nakit planı pays amount with no VAT even if vatRate is null/0.2 — today it would pay 192.000 for Tuzla's 160.000), stopaj 20% on the official rent (officialAmount + officialBasis) as the single source: P&L stopaj row + muhtasar base; the fixed "Kira stopajı" reminder must not double count it (suppress or warn, test). şirket → 20% VAT, no stopaj, muhtasar does not go "en az" for it (taxDoc fatura implied). null keeps today's behaviour. §6: Tuzla 160.000/month to a person, no VAT, stopaj on official 100.000 (brüt basis → 20.000), only in Tuzla's view (when the row's branch is tuzla); Marina: Nov 0 (startMonth 2026-12), from Dec 160.000 excl. VAT, nakit planı 192.000, VAT 32.000. The UI exposes the landlord type on kira items. Row data (branch, official rent) is the owner's (Faz 0); tests build their own rows.
(4) "İşletme geneli payı (bilgi)": on a single-branch view (Marina or Tuzla), business-wide items (fixed items with null branch, expense entries without branch, manual:* P&L cells which have no branch column, and other unbranched costs the branch view currently adds 100% — see the map's leak list) no longer reduce the branch's profit; instead one explicitly labelled info row "İşletme geneli payı (bilgi)" shows their total for the period (the full business-wide amount, not an allocation — no allocation key was decided; the row's hint says "Şubenin kârına girmez; Tümü'de bir kez sayılır"). "Tümü" counts them exactly once; add the "İşletme geneli" column to the Tümü per-branch breakdown that docs/SUBE.md already promises. Acceptance: Marina profit + Tuzla profit − business-wide = Tümü profit, nothing counted twice (pure + DB test). Keep business-wide screens (Vergi, Nakit planı, Tutarlılık, Excel) unchanged. Update docs/SUBE.md, the relevant docs (personel / kira / vergi docs that exist) and docs/LAFPOS.md only if touched.
Tests test-first with failing-before evidence for each item. FULL checks: npx next typegen && npx tsc --noEmit && npm run lint && npm test && flock /tmp/lafmaliyet-db.lock env TEST_DATABASE_URL=postgres://ci:ci@localhost:5433/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db (run from /Users/okanberkmanavoglu/laf/wt/lafmaliyet-faz5).`,
  },
  {
    id: 'LM-4b', repo: '/Users/okanberkmanavoglu/laf/lafmaliyet', branch: 'claude/personel-baglanti', base: 'claude/personel-sube-kira',
    maps: ['staff-link.md'],
    scope: `lafmaliyet reader of the LafPOS staff link (owner decision 2: "ladmin'de hesapları var; doğru hesabı bağladığından emin ol" → explicit links only, ladmin validates every ref). FIRST: \`git -C /Users/okanberkmanavoglu/laf/lafmaliyet checkout -b claude/personel-baglanti claude/personel-sube-kira\` (claude/personel-sube-kira is checked out in the worktree /Users/okanberkmanavoglu/laf/wt/lafmaliyet-faz5 — do not check it out here, only branch from it; review diff base claude/personel-sube-kira). Sender: LafPOS branch claude/personel-baglanti (LP-C): read \`git -C /Users/okanberkmanavoglu/laf/lafpos diff claude/kasa-zinciri..claude/personel-baglanti -- server docs/03-ENTEGRASYON.md tests/signature.test.ts tests/fixtures\` for workedStaffRefs, the personel GET it calls and its signature vector (copy the vector into tests/lafpos.test.ts). Spec: CONTRACT §4 LM-4 bullet (staff-link parts), §1 decision 2, §3. Items: signed GET /api/panel/pos/personel?sube= (LAFPOS_SYNC_SECRET; sube ≠ LAFPOS_BRANCH_ID → 409 wrong_branch; items [{ref "s:<staff.id>", name, active, account}] for staff rows of that branch in range this or last month; account = the linked login's display name via staff.userId (built in LM-4) or null; no salary/email/months; Cache-Control no-store); workedStaffRefs read optional + .catch(undefined), stored in pos_day_reports.worked_staff, classified, and answered in the 200 as staff {counted, unknown, otherBranch} (in handlePosDay, not receivePosDay); the LM-4 meal card hook switches to LafPOS worked days only when every counted LafPOS day of the month carries worked_staff, else keeps mealCardDays; Maaşlar shows per person "LafPOS'ta çalıştığı gün" when available. Golden + kabul fixture byte-identical to the LafPOS claude/personel-baglanti tip (cmp). Migrations via npm run db:generate. Docs: docs/LAFPOS.md (KVKK: ad gitmez; yalnız personel kimliği). FULL checks: npx next typegen && npx tsc --noEmit && npm run lint && npm test && flock /tmp/lafmaliyet-db.lock env TEST_DATABASE_URL=postgres://ci:ci@localhost:5433/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db.`,
  },
  {
    id: 'LM-5', repo: '/Users/okanberkmanavoglu/laf/lafmaliyet', branch: 'claude/sube-fiyati', base: 'claude/personel-baglanti',
    maps: ['branch-price.md'],
    scope: `lafmaliyet branch price write path + report (owner decision 1). FIRST: \`git -C /Users/okanberkmanavoglu/laf/lafmaliyet checkout claude/personel-baglanti && git -C /Users/okanberkmanavoglu/laf/lafmaliyet checkout -b claude/sube-fiyati\` (stacked on LM-4b; review diff base claude/personel-baglanti). Site side: laffogato branch claude/branch-prices (PR okanberk-dev/laffogato#301): docs/PANEL-MENU.md "Şube fiyatı" and src/app/api/panel/menu/route.ts are the exact contract (branchPrice write shapes, 409 stale body with branchPrices, writes.branchPrice announcement, idempotent re-send). LafPOS side: branch claude/sube-fiyati-kasa (lines[].listPrices). Spec: CONTRACT §8 "ladmin (LM-5)". Items: read branchPrices into integration_state; offer branch price writes only when the site's read announces writes.branchPrice; write single + bulk with a "Şube" selector and "Geçerlilik" (default next business day 05:00 Europe/Istanbul) on Fiyatlar, cancel of a future row; parse/store lines[].listPrices (pos_daily_sales.list_prices jsonb, .catch(undefined)); "Eski fiyattan satılanlar" report tab + per change status Bekliyor / Uygulandı · <gün> / Uygulanmadı / Bilinmiyor (decided from listPrices on day-end lines, never inferred from revenue/qty). Migrations via npm run db:generate. Golden copied byte-identical from LafPOS claude/sube-fiyati-kasa. FULL checks: npx next typegen && npx tsc --noEmit && npm run lint && npm test && flock /tmp/lafmaliyet-db.lock env TEST_DATABASE_URL=postgres://ci:ci@localhost:5433/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db.`,
  },
]

const PKGS = PKGS_ALL.filter(p => (args && args.ids ? args.ids : []).includes(p.id))
if (!PKGS.length) throw new Error('no packages selected')
log(`packages: ${PKGS.map(p => p.id).join(', ')}`)

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    package: { type: 'string' },
    branch: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    prTitle: { type: 'string' },
    prBody: { type: 'string' },
    failingBefore: { type: 'array', items: { type: 'string' } },
    checks: { type: 'string' },
    deviations: { type: 'array', items: { type: 'string' } },
    ownerActions: { type: 'array', items: { type: 'string' } },
    openIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['package', 'branch', 'commits', 'prTitle', 'prBody', 'checks'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          scenario: { type: 'string' },
        },
        required: ['severity', 'file', 'summary', 'scenario'],
      },
    },
    checks: { type: 'string' },
  },
  required: ['findings', 'checks'],
}

const implPrompt = (p) => `You are the implementation agent for package ${p.id}.
Repo: ${p.repo} — branch ${p.branch} (already checked out; base commit ${p.base}). Work only in this directory.
FIRST read the whole contract: ${CONTRACT}. Then read the background maps: ${p.maps.map(m => `${S}/maps/${m}`).join(', ')} (written against slightly older commits; re-verify line numbers).
Then read the repo's own rules (AGENTS.md / CLAUDE.md) — they are binding.

SCOPE:
${p.scope}

How to work:
- Test-first for every fix/feature: write the test, run it, confirm it fails for the right reason, implement, confirm it passes. Record failing-before evidence.
- Keep diffs focused on the scope; no drive-by refactors. Follow existing patterns and naming.
- Run the FULL check suite for this repo (CONTRACT §0 rule 9) ONCE at the end; everything must be green. Work fast: no redundant re-runs, no browser screenshots beyond the e2e suite, no re-verifying things you already proved. If a pre-existing test must change because the old behaviour was the bug, change it and say so.
- Commit on ${p.branch} (one or a few logical commits, Turkish messages for lafpos/lafmaliyet, English for laffogato) with the exact trailer from CONTRACT §0 rule 9. Do NOT push, do NOT open PRs, do NOT touch other repos (except reading), do NOT touch live services.
- If something in the contract is impossible or wrong against the code, choose the safest reasonable option, implement it, and list it under deviations.
Return: prTitle (Turkish for lafpos/lafmaliyet, English for laffogato; no trailing period), prBody (markdown in the same language: Özet/Summary, what changed per area, tests incl. failing-before evidence, how verified, owner actions/data steps, merge order notes), commits (hashes + subjects), failingBefore, checks (exact commands + pass counts), deviations, ownerActions, openIssues.`

const reviewPrompt = (p, impl) => `You are an independent, skeptical code reviewer for package ${p.id}. Do NOT edit any file and do NOT commit.
Repo: ${p.repo}, branch ${p.branch}, base ${p.base}. Review \`git -C ${p.repo} diff ${p.base}..HEAD\` (and the commit list).
Spec: ${CONTRACT} (read §0, §1, §2/§3 as relevant, the ${p.id} entries in §4/§5/§7/§8, and §6). Background maps: ${p.maps.map(m => `${S}/maps/${m}`).join(', ')}.
Package scope given to the implementer:
${p.scope}

Implementer's own summary (do not trust it, verify): ${JSON.stringify({ commits: impl?.commits, deviations: impl?.deviations, openIssues: impl?.openIssues, checks: impl?.checks }).slice(0, 4000)}

Hunt for: correctness bugs with a concrete failing input; contract deviations (field names, shapes, optionality, .catch(undefined) on the reader side, TL vs kuruş, rounding); missing scope items; tests that would pass even without the fix (re-run a sample: stash the fix or check the assertion really exercises it); idempotence/re-send issues; KVKK leaks (names/user ids in the body, audit data); repo rule violations (hand-written SQL, missing db:generate migration/journal/snapshot, patchOf, 44px targets, Turkish copy, e2e ROUTES, demo shims, branch scope); regressions in existing behaviour. Do NOT rerun the full check suite (the implementer already ran it; the fixer runs it again): run only the tests touching the diff (and a scratch revert to prove a suspicious test, if needed). No browser screenshots. Be fast: report only findings you are sure about.
Report only real problems, each with severity (blocker = wrong numbers/data loss/contract break/failing checks; major = real bug or missing scope; minor = small), file, line, summary, and a concrete failure scenario. Empty findings is a valid answer.`

const fixPrompt = (p, impl, review) => `You are the fix agent for package ${p.id}. Repo ${p.repo}, branch ${p.branch} (base ${p.base}). Spec: ${CONTRACT}.
An independent reviewer reported these findings:
${JSON.stringify(review?.findings ?? [], null, 1).slice(0, 20000)}
Reviewer's check results: ${(review?.checks ?? '').slice(0, 3000)}

For each finding: verify it against the code first. Fix the real ones (test-first where it is a behaviour bug); skip wrong ones with a one-line reason. Then run the FULL check suite ONCE at the end (CONTRACT §0 rule 9; flock /tmp/lafpos-e2e.lock for lafpos e2e, flock /tmp/lafmaliyet-db.lock for lafmaliyet test:db) until green. No extra browser screenshots beyond the e2e suite; work fast, no redundant re-verification. Commit the fixes as new commit(s) on ${p.branch} with the CONTRACT trailer. Do NOT push or open PRs.
Return the same report shape as the implementer, describing the FINAL state of the branch: prTitle, prBody (complete, updated, includes the reviewer-driven fixes), commits (all commits on the branch since ${p.base}), failingBefore, checks (final), deviations, ownerActions, openIssues — and put "fixed: …" / "skipped: … (reason)" lines at the top of openIssues.
Previous implementer report for reference: ${JSON.stringify(impl ?? {}).slice(0, 8000)}`

const results = await pipeline(
  PKGS,
  (p) => agent(implPrompt(p), { label: `impl:${p.id}`, phase: 'Implement', schema: IMPL_SCHEMA, agentType: 'general-purpose' }),
  (impl, p) => agent(reviewPrompt(p, impl), { label: `review:${p.id}`, phase: 'Review', schema: REVIEW_SCHEMA, agentType: 'general-purpose' }).then(review => ({ impl, review })),
  ({ impl, review }, p) => {
    const real = (review?.findings ?? []).length
    if (!real) return { id: p.id, impl, review, final: impl }
    return agent(fixPrompt(p, impl, review), { label: `fix:${p.id}`, phase: 'Fix', schema: IMPL_SCHEMA, agentType: 'general-purpose' })
      .then(final => ({ id: p.id, impl, review, final }))
  },
)
return results
