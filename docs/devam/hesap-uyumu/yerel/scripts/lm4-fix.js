export const meta = {
  name: 'lm4-finish',
  description: 'Finish lafmaliyet LM-4 (Faz 5): fix remaining review findings test-first, independent review, fix, full checks',
  phases: [
    { title: 'Fix', detail: 'major 3 + 5 minor findings, test-first, one commit each' },
    { title: 'Review', detail: 'fresh reviewer on the whole package diff, targeted tests only' },
    { title: 'Fix2', detail: 'apply verified review findings, full checks once' },
  ],
}

const LAF = '/Users/okanberkmanavoglu/laf'
const S = `${LAF}/wt/lafpos-notlar/docs/devam/hesap-uyumu`
const CONTRACT = `${S}/CONTRACT.md`
const REPO = `${LAF}/wt/lafmaliyet-faz5`
const DB = 'postgres://ci:ci@localhost:5433/test_faz5'
const LOCAL = `LOCAL ENVIRONMENT (overrides any /home/user or cloud-container instruction in the contract, maps or scripts):
- macOS (Apple Silicon), 8 CPU, only 8 GB RAM. /home/user/X in any document means ${LAF}/X. Main clones ${LAF}/lafpos, ${LAF}/lafmaliyet, ${LAF}/laffogato: never change their checked-out branch.
- Node: ALWAYS prefix shell commands with \`export PATH=$HOME/.local/node/node-v24.22.2-darwin-arm64/bin:$PATH;\` (Node 24 = CI). sed on macOS: \`sed -i ''\`.
- Postgres 16 at localhost:5433 (NOT 5432 — that is the owner's own Postgres 14, never touch it). This lane's test DB: ${DB} (own DB; another lane uses test_gunsonu). If Postgres is down: \`LC_ALL=en_US.UTF-8 /opt/homebrew/opt/postgresql@16/bin/pg_ctl -D ${LAF}/pgdata -o "-p 5433 -k /tmp" -l ${LAF}/pgdata.log start\`.
- RAM is tight and another workflow runs in parallel: wrap EVERY heavy command (tsc, npm test, lint, test:db, next build) in \`flock /tmp/laf-heavy.lock <cmd>\`. Stop anything you start.
- \`npx next build\` does not work with the symlinked node_modules; CI builds. Do not try to work around it.
- Known timing-only failures on this slow Mac when the machine is loaded: lafpos tests/audit-raporlar.test.ts (10 s perf budget) and tests/lafmaliyet-gecis.test.ts (10 s hook timeout). Both pass when run alone (verified at baseline). If ONLY these fail in a full run, re-run them alone; green alone counts as green (say so in checks).
- Commit trailer: ONLY \`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\` (replaces CONTRACT §0 rule 9's two lines).
- No live services or live DBs. Do NOT push, do NOT open PRs (the orchestrator does).`

const FULL = `cd ${REPO} && export PATH=$HOME/.local/node/node-v24.22.2-darwin-arm64/bin:$PATH && flock /tmp/laf-heavy.lock npx next typegen && flock /tmp/laf-heavy.lock npx tsc --noEmit && flock /tmp/laf-heavy.lock npm run lint && flock /tmp/laf-heavy.lock npm test && flock /tmp/laf-heavy.lock flock /tmp/lafmaliyet-db.lock env TEST_DATABASE_URL=${DB} TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db`

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
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, line: { type: 'number' },
      summary: { type: 'string' }, scenario: { type: 'string' } }, required: ['severity', 'file', 'summary', 'scenario'] } },
    checks: { type: 'string' },
  },
  required: ['findings', 'checks'],
}

const SCOPE = `lafmaliyet LM-4 = Faz 5 (CONTRACT §4 LM-4 bullet minus the LafPOS staff-link reader, which is LM-4b; owner decisions 4, 11, 12; §6 staff/rent/Tümü acceptance lines): staff meal card sub-row (mealCardDaily 330 × mealCardDays 26, per-staff flag, not grossed up), part-time daily model from 2026-12 (staff.kind, dailyWage × Vardiya work shifts, staff.userId / staff.personRef explicit link), rent landlord type (şahıs: no VAT, 20% stopaj on official rent, single source; şirket: 20% VAT, no stopaj), "İşletme geneli payı (bilgi)" row on single-branch views (business-wide items do NOT reduce branch profit; Tümü counts them once; Marina profit + Tuzla profit − business-wide = Tümü profit).`

phase('Fix')
const fix1 = await agent(`${LOCAL}

You finish package LM-4 in lafmaliyet. Worktree ${REPO}, branch claude/personel-sube-kira (already checked out; node_modules symlinked). Work only there. The branch already has the implementation (9af9f0a, 6489cb4), origin/main merged (bc230a7), and fixes for review findings 1 and 2 (569711b reminder paths use the landlord type; fe24851 business-wide full-month items use the company's days in branch view).
Scope of the package: ${SCOPE}
Read: the contract ${CONTRACT} (§0, §1 decisions 4/11/12, §4 LM-4, §6), the map ${S}/maps/ladmin-faz5.md (older commit; re-verify lines), the repo's AGENTS.md/CLAUDE.md (binding), and the review file ${S}/LM-4-impl-review.json (keys impl = implementer report, review.findings = 8 findings). Findings 1 and 2 are DONE. Fix the remaining 6, each TEST-FIRST (write the test, run it, see it fail for the right reason, fix, see it pass) and each as its own commit (Turkish message):
- Finding 3 (major, engine.ts ~1873 / insights.ts ~697 netProfitStandard, fixedStandardTotalFor, breakEvenOf used by Genel bakış, Giderler, Analiz): orchestrator decision (binding, owner decision 4): in a single-branch view the "Excel temeli" net profit and the break-even EXCLUDE business-wide items exactly like the profit basis does; Tümü unchanged. Test with the finding's scenario (Marina view, business-wide Excel fixed items + Alper 35.000 net + meal card → branch fixed total 57.065, not 351.760).
- Finding 4 (minor, Excel 'Personel' sheet, workbook.ts ~1533): the row and TOPLAM must reconcile: add explicit columns for the meal card and for part-time wages (or an equivalent that makes net/brüt/SGK/ek/meal/part-time add up to the total), TOPLAM covers everyone. Test: Alper row columns sum to 57.065; a part-time row reconciles.
- Finding 5 (minor, Tümü 'Şube kırılımı', gelir-gider page ~125): costs assigned to a non-physical branch (e.g. online) must appear in their own column (or a "Diğer kanallar" column), not in the residual; the residual note must stay true. Test.
- Finding 6 (minor, staff.userId uniqueness, costs.ts ~321): make the link check race-safe (e.g. pg_advisory_xact_lock in the same transaction as the check + write) and keep the rule "one account per overlapping month range"; document in the code that an ended row and its resumed row may share the account and that LM-4b's personel list must emit one item per account (leave a note in docs for LM-4b). DB test where possible.
- Finding 7 (minor, landlord type dialog, expenses-client.tsx ~1182): choosing a landlord type must not wipe stored officialAmount/officialBasis or overwrite the owner's vatRate; the engine already ignores fields that do not apply to the type. Switching back restores the previous behaviour. Test (pure helper for the save payload if the component is hard to test).
- Finding 8 (minor, meal card version snapshot, engine.ts ~245): turning the meal card on/off from month X must not silently drop in a later pre-entered salary version: carry the flag change into later existing versions on save (or block with a clear Turkish message) — choose the safest, test it, and make the version label show "+ yemek kartı".
Then run the FULL checks ONCE at the end, all green: ${FULL}
Return the report for the FINAL state of the branch (all commits since origin/main): prTitle (Turkish, no trailing period), prBody (complete Turkish PR body: start from the implementer's prBody in the review file, update it for findings 1–8 and their tests, keep owner actions; mention lafmaliyet CI does not run DB tests and that test:db passed locally with the count), commits (hash + subject), failingBefore (test name + assertion message per finding), checks (exact commands + pass counts), deviations, ownerActions, openIssues.`, { label: 'fix:LM-4', phase: 'Fix', schema: IMPL_SCHEMA, agentType: 'general-purpose' })

phase('Review')
const review = await agent(`${LOCAL}

You are an independent, skeptical code reviewer for package LM-4 (lafmaliyet Faz 5). Do NOT edit any file and do NOT commit.
Worktree ${REPO}, branch claude/personel-sube-kira. Review \`git -C ${REPO} diff origin/main...HEAD\` (whole package) with extra attention to the newest commits (the fixes after fe24851).
Spec: ${CONTRACT} (§0, §1 decisions 4/11/12, §4 LM-4, §6). Map: ${S}/maps/ladmin-faz5.md. Earlier review findings and the implementer report: ${S}/LM-4-impl-review.json (all 8 findings should now be fixed — verify each one really is, with a probe or by reading the test).
Scope: ${SCOPE}
Fixer's summary (do not trust it, verify): ${JSON.stringify({ commits: fix1?.commits, deviations: fix1?.deviations, openIssues: fix1?.openIssues, checks: fix1?.checks, failingBefore: fix1?.failingBefore }).slice(0, 5000)}
Hunt for: wrong numbers vs §6 (Alper 57.065, Cem 52.909, Damla 49.059, Berkan 44.329; Tuzla rent 160.000 no VAT + stopaj 20.000 on official 100.000 only in Tuzla; Marina rent Nov 0, Dec 160.000 + VAT 32.000, cash plan 192.000; Marina + Tuzla − business-wide = Tümü); double counting (meal card vs "Personel yemeği", part-time weekly item vs daily rows, Kira stopajı reminder vs stopaj row); branch-scope leaks; tests that would pass without the fix (check a sample by reverting the fix locally in a scratch copy, never in the worktree); migrations not generated with db:generate (journal + snapshot present); patchOf; staff never see cost/profit; Turkish copy. Run only the tests that touch the diff (under flock /tmp/laf-heavy.lock; DB tests with TEST_DATABASE_URL=${DB} under flock /tmp/lafmaliyet-db.lock). Report only real problems with severity (blocker = wrong numbers/data loss/contract break/failing checks; major = real bug or missing scope; minor), file, line, summary, concrete failure scenario. Empty findings is valid.`, { label: 'review:LM-4', phase: 'Review', schema: REVIEW_SCHEMA, agentType: 'general-purpose' })

let final = fix1
if ((review?.findings ?? []).length) {
  phase('Fix2')
  final = await agent(`${LOCAL}

You are the fix agent for package LM-4 (lafmaliyet Faz 5). Worktree ${REPO}, branch claude/personel-sube-kira. Spec: ${CONTRACT}. Scope: ${SCOPE}
An independent reviewer reported:
${JSON.stringify(review?.findings ?? [], null, 1).slice(0, 20000)}
Reviewer's checks: ${(review?.checks ?? '').slice(0, 3000)}
For each finding: verify it against the code first. Fix the real ones test-first (failing-before evidence); skip wrong ones with a one-line reason. Commit each fix (Turkish message). Then run the FULL checks ONCE at the end until green: ${FULL}
Return the same report shape describing the FINAL branch state: prTitle, prBody (complete Turkish PR body, updated with these fixes), commits (all since origin/main), failingBefore, checks (final), deviations, ownerActions, openIssues with "fixed: …" / "skipped: … (reason)" lines first.
Previous report: ${JSON.stringify(fix1 ?? {}).slice(0, 10000)}`, { label: 'fix2:LM-4', phase: 'Fix2', schema: IMPL_SCHEMA, agentType: 'general-purpose' })
}
return { fix1, review, final }
