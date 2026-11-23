export const meta = {
  name: 'hesap-uyumu-wave',
  description: 'Implement, independently review and fix the hesap-uyumu packages named in args.ids',
  phases: [
    { title: 'Implement', detail: 'one agent per package, in its own repo/worktree' },
    { title: 'Review', detail: 'fresh skeptical reviewer per package, read-only + full checks' },
    { title: 'Fix', detail: 'apply verified findings, rerun checks, commit' },
  ],
}

const S = '/tmp/claude-0/-home-user-lafpos/087a595d-df9f-592b-88ce-6553c15994c5/scratchpad'
const CONTRACT = `${S}/CONTRACT.md`

const PKGS_ALL = [
  {
    id: 'LM-M', repo: '/home/user/wt/lafmaliyet-modpos', branch: 'claude/modpos-donemi', base: '7740898',
    maps: ['ladmin-faz1-sales.md', 'ladmin-ingest.md', 'lafpos-modpos-history.md'],
    scope: `lafmaliyet (ladmin): the signed endpoint GET /api/panel/pos/modpos-gunler of CONTRACT §5.1 (REVISED §5 — read it fully). Work ONLY in the worktree /home/user/wt/lafmaliyet-modpos (branch claude/modpos-donemi, base 7740898; node_modules is a symlink to /home/user/lafmaliyet/node_modules — if Next typegen/tsc/eslint resolution breaks, run npm ci there). Never touch /home/user/lafmaliyet (another agent works there).
Why: the owner sees LafPOS Uzaktan › Raporlar › "Geçen hafta" missing Marina's ModPOS days 16–21.11; the kasa will pull the ModPOS-era days of its branch from ladmin and push them itself. Build: route src/app/api/panel/pos/modpos-gunler/route.ts + core in src/server/lafpos/ (pattern servePosProducts/checkLafposRequest, GET, no body, sube query param validated, 409 wrong_branch for other branches, no-store), loader that reads ladmin's existing per-day ModPOS-era data for LAFPOS_BRANCH_ID strictly before the switch day (kasa raporu first, ModPOS föy fallback, same precedence as TillRow/tillMonths; find how discounts, ödenmez, ikram, receipts (fiş), Z no are stored) and the ModPOS product sales list for that period (sales_lines of that branch; pre-discount), shape exactly as §5.1 (TL 2 decimals, ciro = Σ payments, kdv one 10% row via round(ciro×100/110) when no breakdown). Tests: pure shape/validation tests + signature vector in tests/lafpos.test.ts (same vector string LafPOS will use: compute with the existing helper and print it in your report so the orchestrator can mirror it), a DB test seeding Marina 13–21.11 per §6 table (kasa reports or föy rows) and a 31-line/240-qty/29.415,00 sales list, asserting the exact §6 totals in the response, 401 without signature, 409 for sube=tuzla, empty days when switchDay is null. Docs: docs/LAFPOS.md (new endpoint section + budget: LafPOS pulls at most once per business day automatically, ≥5 min manual). Full checks: npx next typegen && npx tsc --noEmit && npm run lint && npm test && flock /tmp/lafmaliyet-db.lock env TEST_DATABASE_URL=postgres://ci:ci@localhost:5432/test TEST_DB_FILE_TIMEOUT_MS=120000 npm run test:db.`,
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
- Run the FULL check suite for this repo (CONTRACT §0 rule 9) at the end; everything must be green. If a pre-existing test must change because the old behaviour was the bug, change it and say so.
- Commit on ${p.branch} (one or a few logical commits, Turkish messages for lafpos/lafmaliyet, English for laffogato) with the exact trailer from CONTRACT §0 rule 9. Do NOT push, do NOT open PRs, do NOT touch other repos (except reading), do NOT touch live services.
- If something in the contract is impossible or wrong against the code, choose the safest reasonable option, implement it, and list it under deviations.
Return: prTitle (Turkish for lafpos/lafmaliyet, English for laffogato; no trailing period), prBody (markdown in the same language: Özet/Summary, what changed per area, tests incl. failing-before evidence, how verified, owner actions/data steps, merge order notes), commits (hashes + subjects), failingBefore, checks (exact commands + pass counts), deviations, ownerActions, openIssues.`

const reviewPrompt = (p, impl) => `You are an independent, skeptical code reviewer for package ${p.id}. Do NOT edit any file and do NOT commit.
Repo: ${p.repo}, branch ${p.branch}, base ${p.base}. Review \`git -C ${p.repo} diff ${p.base}..HEAD\` (and the commit list).
Spec: ${CONTRACT} (read §0, §1, §2/§3 as relevant, the ${p.id} entries in §4/§5/§7/§8, and §6). Background maps: ${p.maps.map(m => `${S}/maps/${m}`).join(', ')}.
Package scope given to the implementer:
${p.scope}

Implementer's own summary (do not trust it, verify): ${JSON.stringify({ commits: impl?.commits, deviations: impl?.deviations, openIssues: impl?.openIssues, checks: impl?.checks }).slice(0, 4000)}

Hunt for: correctness bugs with a concrete failing input; contract deviations (field names, shapes, optionality, .catch(undefined) on the reader side, TL vs kuruş, rounding); missing scope items; tests that would pass even without the fix (re-run a sample: stash the fix or check the assertion really exercises it); idempotence/re-send issues; KVKK leaks (names/user ids in the body, audit data); repo rule violations (hand-written SQL, missing db:generate migration/journal/snapshot, patchOf, 44px targets, Turkish copy, e2e ROUTES, demo shims, branch scope); regressions in existing behaviour. Run the full check suite yourself (CONTRACT §0 rule 9; use \`flock /tmp/lafpos-e2e.lock\` for lafpos e2e and \`flock /tmp/lafmaliyet-db.lock\` for lafmaliyet test:db) and report the results in checks.
Report only real problems, each with severity (blocker = wrong numbers/data loss/contract break/failing checks; major = real bug or missing scope; minor = small), file, line, summary, and a concrete failure scenario. Empty findings is a valid answer.`

const fixPrompt = (p, impl, review) => `You are the fix agent for package ${p.id}. Repo ${p.repo}, branch ${p.branch} (base ${p.base}). Spec: ${CONTRACT}.
An independent reviewer reported these findings:
${JSON.stringify(review?.findings ?? [], null, 1).slice(0, 20000)}
Reviewer's check results: ${(review?.checks ?? '').slice(0, 3000)}

For each finding: verify it against the code first. Fix the real ones (test-first where it is a behaviour bug); skip wrong ones with a one-line reason. Then run the FULL check suite (CONTRACT §0 rule 9; flock locks as in the review) until green. Commit the fixes as new commit(s) on ${p.branch} with the CONTRACT trailer. Do NOT push or open PRs.
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
