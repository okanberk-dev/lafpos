export const meta = {
  name: 'lafpos-fix-audit',
  description: 'Fix the 74 LafPOS audit claims in 7 parallel worktrees: reproduce, fix with regression tests, adversarial review, fix review findings',
  phases: [
    { title: 'Fix', detail: 'one fixer per area in its own worktree: reproduce each claim, fix the root cause, regression test, commit' },
    { title: 'Review', detail: 'independent reviewers try to break each area fixes (break and regression lenses)' },
    { title: 'Follow-up', detail: 'fix only review findings that came with a failing probe' },
  ],
}

const SP = args.sp
const BASE = args.base

const CONTEXT = `LafPOS is a café POS (Hono + better-sqlite3 + Drizzle server in server/, React 19 client in src/, pure money/time code in shared/). Turkish UI, Turkish code comments and test names.

Since the audit ran (on commit 78704a1) the integration branch moved to ${BASE}: review fixes (counter "Yeni satış" order reuse per device, isEmptyOrder used by day close and the automatic day end, privacy-sanitized cloud snapshot, media fetch with redirect:'error', LafPOS Uzaktan ignores stale pushes, patron panel counts only checks with total > 0, product report returns service separately), report hardening (comparison(), waterfall, KDV by rate, reconciliation, tests/report-reconciliation.test.ts), the ÖKC provider layer (server/okc/providers/*, applyResult(receiptId, FiscalResult)), merged report tabs, suggestCash. File and line references in the claims may be stale: find the current code. The finders' original probe scripts are under ${SP}/audit/<dimension>-r1/ (they may import old paths); reuse their ideas.`

const RULES = `Rules:
- Work ONLY inside your worktree. Other agents are editing the other worktrees (/Users/okanberkmanavoglu/Downloads/lafpos, lafpos-fix, lafpos-wt-*) at the same time: never read-modify-write them, never run git commands that change other branches. node_modules is a symlink to the main clone: never run npm install / npm ci.
- AGENTS.md rules apply (it is the project rule file): money is integer kuruş and computed only with shared/order-calc.ts and shared/money.ts; the server recomputes totals; permissions are enforced on the server; sensitive operations are written to the audit log; every write is one transaction followed by bus.publish; PATCH bodies use patchOf(); UI copy is natural Turkish with no trailing period in headings.
- Do not change server/db/schema.ts or add migrations unless your instructions explicitly allow it; if a fix truly needs a schema change, mark the claim 'deferred' and describe the design.
- Gates before every commit, from your worktree: \`npm run typecheck\` and \`npx vitest run\` (full suite) must both pass. Do NOT run npm run build or npm run e2e (the machine is shared by many agents). If a test unrelated to your change fails, investigate whether you caused it.
- Commit on your branch in small logical commits. Commit messages in Turkish, first line short, and the last line exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>. Never push, merge or rebase.
- If you change behaviour a doc in docs/*.md, README.md or DESIGN.md describes, update that doc in the same commit.`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          outcome: { type: 'string', enum: ['fixed', 'already_fixed', 'not_real', 'deferred'] },
          summary: { type: 'string', description: 'what was wrong and what changed, or why nothing changed (1-3 sentences)' },
          test: { type: 'string', description: 'regression test file and name, or empty' },
        },
        required: ['id', 'outcome', 'summary', 'test'],
      },
    },
    commits: { type: 'array', items: { type: 'string' }, description: 'sha + subject of each commit' },
    notes: { type: 'string', description: 'anything the integrator must know: behaviour changes, client changes, docs, risks' },
  },
  required: ['claims', 'commits', 'notes'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          description: { type: 'string' },
          probe: { type: 'string', description: 'full source of the vitest probe that fails on the current branch' },
          output: { type: 'string', description: 'excerpt of the failing probe output' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'file', 'description', 'probe', 'output', 'fix'],
      },
    },
    checkedDismissals: { type: 'string', description: 'which already_fixed / not_real outcomes you checked and whether you agree' },
  },
  required: ['findings', 'checkedDismissals'],
}

const LENS = {
  break: `Lens BREAK: try to break the fixes. For every claim marked fixed, attack variants the fix may have missed: other entry points (routes, jobs, sync, ÖKC results, admin), replays and double submits, partial and per-item payments, split bills (Paylaş), merged and transferred orders, day close / reopen / automatic day end, blind-cash roles (kasa.rakam off), room timers, happy hour, online (site-paid) orders. Check money invariants: payments vs totals, Z vs reports, nothing silently lost, audit log written.`,
  regress: `Lens REGRESS: look for regressions and rule violations the fixes introduced: behaviour other features or the client rely on (read every caller of changed functions, and src/ for changed error codes or response shapes), loosened permission checks, missing audit entries, transactions split, docs drift, tautological or wrong tests. Also re-check each already_fixed / not_real / deferred outcome: was the claim wrongly dismissed? If so, report it as a finding with a probe.`,
}

function fixPrompt(g) {
  return `You are fixing audited bugs in LafPOS, area "${g.title}".

Worktree: ${g.worktree} (branch claude/fix-${g.key}, starts at ${BASE}). cd there first.
Claims for your area (JSON, with the finder's description, probe, evidence, proposed fix, and earlier verifier votes where they exist): ${SP}/audit/group-${g.key}.json

${CONTEXT}

${g.hints}

Your branch may already hold commits from an earlier attempt that was stopped for usage limits, including one titled "YARIM: ..." whose gates never ran. Start by reading \`git log ${BASE}..HEAD\` and those diffs: keep what is correct, finish or fix the rest in new commits (never amend or rewrite: the branch is already on GitHub), and do not redo finished work.

For each claim, in order of severity:
1. Reproduce it on the current code as a vitest test that uses tests/harness.ts (startApp, h.ok/h.call, PINS; see tests/review-fixes.test.ts and tests/report-reconciliation.test.ts for patterns). Put your tests in tests/audit-${g.key}.test.ts.
2. If it does not reproduce (already fixed), or the claimed expected behaviour is wrong for this project (documented and intended, or harmless; weigh the earlier verifier votes), change no code and record already_fixed or not_real with the precise reason. Claims with a majority of refuted votes should normally be not_real unless you find concrete harm.
3. Otherwise fix the root cause, not the symptom, in the style of the surrounding code; keep the reproducing test as the regression test (it must fail before your fix and pass after).
4. Claims that duplicate each other: fix once, record both ids.

${RULES}

Return the structured result for every claim id in the file.`
}

function reviewPrompt(g, lens, fix) {
  return `Adversarial review of bug fixes in LafPOS, area "${g.title}".

Worktree: ${g.worktree} (branch claude/fix-${g.key}). Review \`git diff ${BASE}..HEAD\` there and the commits. The original claims are in ${SP}/audit/group-${g.key}.json. The fixer reported:
${JSON.stringify(fix, null, 1)}

${CONTEXT}

${LENS[lens]}

Every finding must be demonstrated: write a vitest probe to ${g.worktree}/tests/probe-${g.key}-${lens}.test.ts (use tests/harness.ts), run only that file with \`npx vitest run tests/probe-${g.key}-${lens}.test.ts\`, and include the full probe source and the failing output in the finding. Report only what the probe shows; theoretical concerns without a failing probe are not findings. Delete your probe file before you return. Do not modify any other file, do not commit, do not touch other worktrees. Return an empty findings list if the fixes hold.`
}

function followPrompt(g, findings) {
  return `Fix review findings in LafPOS, area "${g.title}".

Worktree: ${g.worktree} (branch claude/fix-${g.key}). An earlier agent fixed the audit claims in ${SP}/audit/group-${g.key}.json; independent reviewers then found these problems, each with a failing probe:
${JSON.stringify(findings, null, 1)}

${CONTEXT}

Your branch may already hold commits from an earlier follow-up attempt that was stopped for usage limits, including ones titled "YARIM: ..." whose gates never ran: read \`git log -8\` and those diffs first, keep what is correct, finish the rest in new commits (never amend: the branch is on GitHub).

For each finding: turn its probe into a regression test in tests/audit-${g.key}.test.ts, confirm it fails, fix the root cause, confirm it passes. If a finding is wrong (the probe asserts behaviour this project does not want), say why and leave the code. Duplicate findings: fix once.

${RULES}

Return the structured result; use the finding titles as ids.`
}

const results = await pipeline(
  args.groups,
  (g) => agent(fixPrompt(g), { label: `fix:${g.key}`, phase: 'Fix', schema: FIX_SCHEMA }),
  (fix, g) => {
    if (!fix) return null
    return parallel(
      g.lenses.map((lens) => () => agent(reviewPrompt(g, lens, fix), { label: `review:${g.key}:${lens}`, phase: 'Review', schema: REVIEW_SCHEMA })),
    ).then((rs) => ({ fix, reviews: rs.filter(Boolean) }))
  },
  (r, g) => {
    if (!r) return null
    const findings = r.reviews.flatMap((x) => x.findings || [])
    if (!findings.length) return { key: g.key, fix: r.fix, reviews: r.reviews, follow: null }
    return agent(followPrompt(g, findings), { label: `follow:${g.key}`, phase: 'Follow-up', schema: FIX_SCHEMA }).then((follow) => ({ key: g.key, fix: r.fix, reviews: r.reviews, follow }))
  },
)
const done = results.filter(Boolean)
log(`${done.length}/${args.groups.length} areas finished`)
return done