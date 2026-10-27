export const meta = {
  name: 'lafpos-servis-modu',
  description: 'Service modes (self, semi-self, table service) as a business setting that changes the LafPOS flow; build, adversarial review, follow-up',
  phases: [
    { title: 'Build', detail: 'design and implement the three service modes with tests' },
    { title: 'Review', detail: 'independent reviewer tries to break the modes' },
    { title: 'Follow-up', detail: 'fix review findings that came with a failing probe' },
  ],
}

const W = '/Users/okanberkmanavoglu/Downloads/lafpos-wt-servis-modu'
const RULES = `Rules: work ONLY in ${W} (branch claude/servis-modu, from main). Other agents edit other worktrees (lafpos, lafpos-fix, lafpos-wt-*) at the same time: never touch them. node_modules is a symlink: never npm install. AGENTS.md rules apply (money in kuruş via shared/order-calc.ts, server-side permissions, audit log for sensitive actions, one transaction per write + bus.publish, patchOf for PATCH, natural Turkish UI copy without trailing periods in headings, touch targets ≥ 44 px, new screens added to e2e/run.mjs ROUTES). Gates before every commit: \`npm run typecheck\` and \`npx vitest run\`; also \`npm run build\`. Do not run npm run e2e (shared machine). Commit in Turkish, last line exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>. Never push, merge or rebase. If you add a migration use \`npm run db:generate\` (another branch may also add 0004; that is fine, the integrator renumbers).`

const BUILD = `Build "servis modu" for LafPOS, a café POS (Hono + SQLite server in server/, React client in src/, shared/ pure code).

The owner asked (Turkish): "seçenekler yap self servis, yarı self servis ve masaya servis gibi işletme ayarlarından yapılsın ve buna göre sistem değişsin sistemi de sen kodla". So: a business setting with three modes, chosen in Yönetim › İşletme ayarları (patron/ayar.yonet only), and the whole system adapts.

Modes and the intended flow (refine with what Square "dining options", Toast "service modes / order-and-pay-at-counter", Loyverse and Turkish café POS do; you may WebSearch their help docs briefly):
- self (Self servis): customer orders and pays at the counter, gets a number, picks up when the pickup board (Çağrı ekranı, /cagri, already exists) calls it. Cashier home = new counter sale; the flow nudges pay-first (after adding items, the primary action is "Öde"); the pickup number is prominent on the payment success and on bar tickets; Masalar is secondary (hidden from the main nav unless tables exist and are used).
- yari_self (Yarı self servis): order and pay at the counter, staff brings it to the table: after payment (or before sending) ask for "Masa no / numaratör" (optional, quick numeric pad, remembered per order), show it on bar tickets, kitchen screen and pickup board instead of a pickup number; Masalar stays available for occupancy but new sales start at the counter.
- masa (Masaya servis): today's flow (waiter opens a table, orders, pays at the end). This must stay the default for existing installs so nothing changes for them unless the owner switches.

What to adapt (read the code first: server/lib/settings.ts, bootstrap DTO, src/lib/nav.ts homePath, src/components/AppShell nav, src/pages/FloorPage.tsx, src/pages/order/OrderPage.tsx, src/lib/counter.ts openCounterSale, server/services/floor.ts pickupBoard, src/pages/KitchenPage.tsx, src/pages/PickupBoardPage.tsx, src/pages/admin/SettingsAdmin.tsx, e2e/run.mjs and e2e/flows.mjs, docs/*.md, PRODUCT.md): setting + validation + audit entry when changed; bootstrap exposes it; home path and nav per mode and role; new-sale defaults; pay-first nudges (UI flow only: payment rules on the server do not change; items still go to the bar exactly as today unless you find a clear, safe reason); table number / numaratör capture for yari_self (store it on the order; if a schema change is needed add one nullable column via migration); tickets, kitchen screen and pickup board show the right identifier; settings page explains each mode in one short line. Keep it simple and fast for staff: fewer taps than today in self modes.

Tests: unit tests for pure helpers (home path / nav / labels per mode), server tests for the setting (permission, validation, audit, bootstrap) and for numaratör storage and display data, all in tests/servis-modu.test.ts; add an e2e flow per non-default mode to e2e/flows.mjs (it will be run later by the integrator) and keep existing flows passing for masa mode. Update docs (PRODUCT.md, docs/02-PLAN.md or the most fitting doc) with a short section.

${RULES}

Return a concise report: what each mode changes (screens, flows), files touched, tests added, any schema change, open questions.`

const REVIEW = (report) => `Adversarially review the new service modes in LafPOS. Worktree ${W} (branch claude/servis-modu); review \`git diff origin/main..HEAD\` there. Builder's report:
${report}

Try to break it: switching modes with open orders, roles without ayar.yonet changing the mode, existing installs (default must be masa, nothing changes), blind-cash cashier, split bills and per-item payments in self modes, online (site-paid) orders, pickup board and kitchen identifiers, numaratör edge cases (empty, duplicate, very long, non-numeric), offline/LAN clients with stale bootstrap, reports and Z unaffected. Also check AGENTS.md rules (audit, permissions, patchOf, Turkish copy, 44 px targets, ROUTES). Every finding must be demonstrated with a vitest probe in ${W}/tests/probe-servis.test.ts (run only that file), include the probe source and failing output, then delete the probe. Do not modify other files, do not commit. Return findings (empty if it holds).`

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, severity: { type: 'string' }, description: { type: 'string' }, probe: { type: 'string' }, output: { type: 'string' }, fix: { type: 'string' } },
        required: ['title', 'severity', 'description', 'probe', 'output', 'fix'],
      },
    },
  },
  required: ['findings'],
}

phase('Build')
const report = await agent(BUILD, { label: 'build:servis-modu', phase: 'Build' })
phase('Review')
const review = await agent(REVIEW(report), { label: 'review:servis-modu', phase: 'Review', schema: FINDINGS })
let follow = null
if (review && review.findings.length) {
  phase('Follow-up')
  follow = await agent(`Fix these review findings in LafPOS service modes. Worktree ${W} (branch claude/servis-modu). Each came with a failing probe:
${JSON.stringify(review.findings, null, 1)}

Turn each probe into a regression test in tests/servis-modu.test.ts, confirm it fails, fix the root cause, confirm it passes. If a finding asserts behaviour the owner would not want, explain and skip it.

${RULES}

Return a short report.`, { label: 'follow:servis-modu', phase: 'Follow-up' })
}
return { report, review, follow }