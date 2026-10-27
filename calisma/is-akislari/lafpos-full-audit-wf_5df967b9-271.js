export const meta = {
  name: 'lafpos-full-audit',
  description: 'Whole-system adversarial audit of LafPOS: 8 dimensions, reproduce-first findings, 3-lens verification, loop until dry',
  phases: [
    { title: 'Find', detail: '8 dimension finders write and run probe tests' },
    { title: 'Verify', detail: '3 independent lenses per finding (reproduce, correctness, impact)' },
  ],
}

const REPO = '/Users/okanberkmanavoglu/Downloads/lafpos'
const SP = '/private/tmp/claude-501/-Users-okanberkmanavoglu-Downloads/36639f88-6c66-4e9d-babe-a70914f282d6/scratchpad/audit'

const PROBE_RECIPE = (dir) => `
How to write runnable probe tests WITHOUT touching the repository (never edit files under ${REPO}):
- Work only in ${dir} (create it). Symlink node_modules: ln -s ${REPO}/node_modules ${dir}/node_modules
- Create ${dir}/vitest.probe.config.mts with exactly:
  const REPO = '${REPO}'; const HERE = '${dir}';
  export default { root: REPO, resolve: { alias: { '@shared': REPO + '/shared' } }, server: { fs: { allow: [REPO, HERE] } }, test: { environment: 'node', dir: HERE, include: ['**/*.probe.test.ts'], testTimeout: 30000 } };
- Probe files are named *.probe.test.ts in ${dir}; import the in-process app harness with: import { startApp, PINS } from '${REPO}/tests/harness'; (see ${REPO}/tests/harness.ts and existing tests in ${REPO}/tests for usage: h.ok(who, method, path, body), h.call(...), h.login(who, pin), h.boot; demo PINs kasa 1111, garson 2222, mudur 2468, patron 1897, bar 3333 (h.login('bar','3333') first). Each test file gets its own fresh database.)
- Run: cd ${REPO} && npx vitest run --config ${dir}/vitest.probe.config.mts
- A finding counts ONLY if a probe demonstrates it (failing assertion of correct behavior, or output showing the wrong number/permission/state). Report the probe path and the relevant output lines.`

const RULES = `Project rules to judge against (from ${REPO}/AGENTS.md): money is integer kuruş, computed only via shared/order-calc.ts and shared/money.ts, server recomputes totals and never trusts client amounts; prices include KDV, rate frozen on the item at sale; permissions enforced server-side via requirePermission (role sets editable; patron locked; without kasa.rakam the cashier must not see interim report / expected cash / closed order payment breakdown = blind cash); sensitive actions are audited; every write is one DB transaction and publishes a live event; online-paid orders are never charged and never go to the lafmaliyet sales list; one Z per business date (05:00 rule) with reopen; PATCH bodies via patchOf.`

const DIMENSIONS = [
  { key: 'money', prompt: `Money math and order totals. Read shared/order-calc.ts, shared/money.ts, server/services/orders.ts (items, discounts percent/amount at item and order level, comps (ikram), voids before/after send, service charge, happy hour, manual price override, per-item payments, split-bill shares, refunds, reopen, transfer/merge/move between tables, room timer charges). Hunt for: totals that do not reconcile (sum of live payments vs total at close; paid > total; negative totals; rounding drift across many lines; discount larger than line; percent discounts with odd values; KDV breakdown not summing to totals), any path where the client amount is trusted, and any write that is not atomic.` },
  { key: 'reports', prompt: `Reports, Z (day close) and revenue statistics must NEVER be wrong. Read server/services/reports.ts, server/services/days.ts (computeSummary, closeDay, reopen, auto day end), server/routes/reports.ts, server/routes/cash.ts, server/sync/lafmaliyet.ts (day push payload, sales list CSV), src/pages/reports/ReportsPage.tsx and src/pages/patron/PatronPage.tsx. Build realistic days with probes (cash, card, meal cards, open account (cari) sales and collections, tips, discounts, comps, voids after send, refunds of payments, split shares, service charge, online orders from the site, a reopened day, orders spanning midnight and the 05:00 business-date rule, multiple days ranges). Check invariants: net sales identical across /reports/summary, /reports/patron, the Z summary and the lafmaliyet payload; payment-method totals sum to net sales (+tips handled consistently); KDV breakdown base+kdv = gross; category/product/hourly/staff reports sum to the same total; range report equals the sum of its days; previous-period comparisons; expected cash = opening + cash sales + cash in - cash out - handovers; blind cashier sees no numbers; CSV exports match and are not vulnerable to formula injection.` },
  { key: 'auth', prompt: `Authorization and authentication. Read server/lib/auth.ts, shared/permissions.ts and EVERY route file in server/routes/ plus server/okc and server/sync route handlers. For each endpoint confirm the permission check matches its purpose; try every demo role against every write endpoint with probes. Check approval-PIN flows (approver must actually hold the permission; approver cannot be self where forbidden), PIN lockout per device and network-wide, session expiry and logout, role/permission editing (no privilege escalation, last patron), blind cash filtering on all endpoints that return orders, cash or reports, and the public routes (/api/public/*, /media/*, /api/health) for data leaks.` },
  { key: 'state', prompt: `State machines and concurrency. Read server/services/orders.ts, server/services/days.ts, server/services/floor.ts, server/okc/service.ts, server/services/reservations*.ts if present. Check order status transitions (acik/kapali/iptal/birlesti), operations on closed or merged orders, day open/close/reopen/auto day end with open orders, items in kitchen states, room timer start/stop, moving/merging/splitting orders with payments or pending fiscal baskets, and duplicate submissions (same payment/items request sent twice quickly or replayed) — does anything double-charge, double-count or leave an order stuck? Use Promise.all in probes to simulate concurrent requests.` },
  { key: 'fiscal', prompt: `Fiscal device (ÖKC / yazarkasa POS) flows. Read docs/04-YAZARKASA.md and server/okc/* (tokenx.ts, basket.ts, service.ts) and server/routes/okc.ts, src/pages/order/OkcPanel.tsx, src/pages/DevicePage.tsx (training simulator). With the simulator provider and with a mocked TokenX (stub global fetch in probes) check: basket lines (quantities x1000, tax percent, section mapping by KDV, discounts distributed so the basket total equals the order remaining exactly, comps/voids excluded, service charge line), per-item baskets, result handling (paid, cancelled by cashier, receipt voided 99, locked/unlocked), refunds, forced cancel with approval, late results after cancel, split bill with device, webhook auth. Any mismatch between device total and LafPOS total is critical.` },
  { key: 'sync', prompt: `Integrations and sync. Read server/sync/* (laffogato-menu.ts, menu-sync.ts, laffogato-orders.ts, lafmaliyet.ts, cloud.ts), server/services/media.ts, api/uzaktan.ts, server/lib/signature.ts, docs/03-ENTEGRASYON.md. Check: menu sync applying price/size/sold-out/deleted products without corrupting open orders or historical items; ETag handling; online orders ingestion idempotency and stage transitions; lafmaliyet outbox retries, 409 handling, cashIn/expectedCash fields; cloud snapshot privacy (no PIN hashes, secrets, costs, customer phones/addresses beyond first names) and the Vercel function's auth (signature replay window, token forgery, password rate limit, read-only enforcement, the ?yol= path handling); media thumbnail SSRF and cache behaviour. Stub global fetch in probes for remote services.` },
  { key: 'client', prompt: `Client-side correctness (React app in src/). Read src/pages/order/* (OrderPage, CartPanel previewTotals, PaymentModal incl. split shares and tips/change, OptionsModal estimates incl. manual price), src/lib/cart.ts, src/lib/boot.ts estimateUnit, src/lib/display.ts, src/pages/reports/ReportsPage.tsx, src/pages/patron/PatronPage.tsx, src/pages/cash/*, shared/time.ts (Europe/Istanbul business date with 05:00 cutoff). Compare client estimates with server results for the same inputs (write probes that import client pure functions where possible, or compute through server APIs), check money formatting (tl, tlShort) for edge values, percentage displays, negative/zero states, date range pickers and business-date math around midnight, and anything that shows a wrong revenue figure to the owner.` },
  { key: 'input', prompt: `API input validation and robustness. Read server/lib/http.ts (body/query/patchOf helpers) and all routes in server/routes/. With probes, send malformed, missing, huge, negative, fractional, NaN-like, very long strings, unicode, arrays at limits, unknown ids, ids of other entities, invalid dates/ranges to every endpoint. Anything that returns 500, crashes the process, stores invalid data, accepts negative money, or allows unbounded work (e.g. giant ranges, huge pagination) is a finding. Also check HTML/receipt printing (src/lib/print.tsx) for injection of user-entered names/notes, and CSV exports for formula injection.` },
]

const FINDINGS = {
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
          line: { type: 'number' },
          description: { type: 'string' },
          probe: { type: 'string', description: 'absolute path of the probe test that demonstrates it' },
          evidence: { type: 'string', description: 'relevant probe output lines' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'file', 'description', 'probe', 'evidence', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: { real: { type: 'boolean' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] }, reason: { type: 'string' } },
  required: ['real', 'severity', 'reason'],
}

const LENSES = [
  { key: 'reproduce', ask: 'Re-run the probe yourself (or write your own minimal probe) and confirm the behaviour actually happens on the current code. If it does not reproduce, real=false.' },
  { key: 'correctness', ask: 'Decide whether the claimed expected behaviour is actually correct for a Turkish café POS and this project (read the code, docs/*.md, AGENTS.md rules, tests in tests/). If the current behaviour is intentional and documented or harmless, real=false.' },
  { key: 'impact', ask: 'Judge real-world impact: can it lose or misreport money, corrupt the Z or reports, leak data, bypass permissions, crash the server, or mislead staff? If the impact is negligible or purely theoretical, real=false. Default to real=false when uncertain.' },
]

const keyOf = (f) => `${(f.file || '').split('/').pop()}::${(f.title || '').toLowerCase().replace(/[^a-z0-9ğüşıöç]+/g, ' ').trim().slice(0, 60)}`

const seen = new Set()
const confirmed = []
let round = 0
let dry = 0
while (dry < 1 && round < 3) {
  round++
  phase('Find')
  log(`Round ${round}: ${DIMENSIONS.length} finders`)
  const already = confirmed.map((c) => `- ${c.title} (${c.file})`).join('\n') || '(none yet)'
  const results = await pipeline(
    DIMENSIONS,
    (d) =>
      agent(
        `You are auditing LafPOS (repo ${REPO}), a café POS: Hono + better-sqlite3 + Drizzle server, React client, shared/ pure money and time code. Dimension: ${d.key}.\n\n${d.prompt}\n\n${RULES}\n\n${PROBE_RECIPE(`${SP}/${d.key}-r${round}`)}\n\nAlready confirmed in earlier rounds (do not report again; find NEW issues):\n${already}\n\nReturn only issues you demonstrated with a probe. Prefer depth over breadth: a few real, reproduced bugs beat many guesses. Return an empty list if you find nothing real.`,
        { label: `find:${d.key}:r${round}`, phase: 'Find', schema: FINDINGS },
      ),
    (r, d) => {
      const fresh = (r?.findings || []).filter((f) => !seen.has(keyOf(f)))
      fresh.forEach((f) => seen.add(keyOf(f)))
      return parallel(
        fresh.map((f) => () =>
          parallel(
            LENSES.map((lens) => () =>
              agent(
                `Adversarially verify a claimed bug in LafPOS (repo ${REPO}; do NOT modify repo files; scratch work under ${SP}/verify-${d.key}-r${round}). Lens: ${lens.key}. ${lens.ask}\n\nClaim: ${f.title}\nSeverity claimed: ${f.severity}\nFile: ${f.file}:${f.line ?? ''}\nDescription: ${f.description}\nProbe: ${f.probe}\nEvidence: ${f.evidence}\nProposed fix: ${f.fix}\n\n${RULES}\n\n${PROBE_RECIPE(`${SP}/verify-${d.key}-r${round}-${lens.key}`)}`,
                { label: `verify:${lens.key}:${d.key}`, phase: 'Verify', schema: VERDICT },
              ),
            ),
          ).then((vs) => {
            const votes = vs.filter(Boolean)
            const yes = votes.filter((v) => v.real)
            return { ...f, dimension: d.key, real: yes.length >= 2, votes: votes.map((v) => `${v.real ? 'real' : 'refuted'} (${v.severity}): ${v.reason}`) }
          }),
        ),
      )
    },
  )
  const judged = results.filter(Boolean).flat().filter(Boolean)
  const fresh = judged.filter((j) => j.real)
  confirmed.push(...fresh)
  log(`Round ${round}: ${judged.length} new claims, ${fresh.length} confirmed (total ${confirmed.length})`)
  if (!fresh.length) dry++
}
const rejected = [...seen].length - confirmed.length
log(`Done: ${confirmed.length} confirmed, ${rejected} refuted or unverified`)
return { confirmed, rounds: round }
