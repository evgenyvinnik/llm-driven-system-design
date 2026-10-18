# Console Growth: Development with Claude

## Project Context

Practice for the **growth engineering take-home** format. You get a small, working developer console for an LLM API, a fictitious metrics snapshot and an experiment framework. The task is to find growth opportunities, size them, and ship two as instrumented A/B experiments with tests and a written readout. [ROADMAP.md entry 17](../ROADMAP.md#17-console-growth-take-home) explains where it fits.

Everything here was written for this repository: the starter app, the seed account, [METRICS.md](./METRICS.md), and the worked answer in [EXPERIMENTS.md](./EXPERIMENTS.md). It reconstructs the *format* of such an assessment from its brief, not its starter code.

The design is in [architecture.md](./architecture.md). This file records how it was built, the choices that aren't obvious from the code, and how to use it for practice.

## Practice Mode

The project was built in two stages so the bare starter can be practiced on its own:

| Stage | What it contains |
|-------|------------------|
| **Starter** | Product pages, experiment framework (`useExperiment`, `getAssignment`, overrides, Dev toolbar), `track()`, seed, METRICS.md, a blank EXPERIMENTS.md template, 20 API smoke tests. One example experiment (`dashboard_welcome_copy`) |
| **Solution** | Both experiments, the instrumentation they needed, `simulate-usage`, the readout, 43 more server tests and 24 client tests, and the filled-in EXPERIMENTS.md |

The starter is the commit titled **`console-growth: starter app`**. To practice, export it to a scratch folder and set a two-hour timer:

```bash
git archive $(git log --format=%H --grep='console-growth: starter app' -1) console-growth | tar -x -C /tmp
cd /tmp/console-growth && npm install && npm run dev
```

The files the solution touches, so you can compare afterwards:
- `server/`
  - `experiments.config.js`, `lib/billing.js`, `lib/runway.js`, `lib/readout.js`, `lib/usage.js`
  - `routes/billing.js`, `routes/usage.js`, `routes/workbench.js`, `routes/dev.js`
- `client/src/`
  - `experiments/*`, `components/Layout.jsx`, `components/DevToolbar.jsx`
  - `pages/Usage.jsx`, `pages/Dashboard.jsx`, `pages/settings/Billing.jsx`
- `test/experiments.spec.js`, `runway.spec.js`, `growth-events.spec.js`, `readout.spec.js`
- `EXPERIMENTS.md`, `scripts/readout.js`

**Opportunities the data supports beyond the two that were built.** Useful for checking your own list: new-org activation, Build → Scale for heavy spenders, team invites, and lost-key support load. All are ranked in EXPERIMENTS.md §1.

## Deviations from Repository Defaults (and why)

The goal is to rehearse the assessment's environment, so the stack follows the brief rather than the repo defaults:

| Repo default | Here | Why |
|--------------|------|-----|
| TypeScript | Plain JS and JSX (ESM) | The brief's files are `.js`/`.jsx` (`experiments.jsx`, `experiments.config.js`), and practice should match what you'll edit |
| Frontend 5173, API 3000 | Web 3000, API 3001 | The brief's ports. The API reads `API_PORT`, not `PORT` (see repair log #1) |
| Docker: PostgreSQL, Valkey | All state in memory, reset from the seed | The brief has no infrastructure; Reset in the Dev toolbar is part of the workflow |
| vitest everywhere | mocha + supertest for the API, vitest + Testing Library for components | The brief's tests are mocha; component tests need a DOM, which vitest + jsdom gives cheaply |
| TanStack Router, Zustand, Tailwind | react-router-dom, React context, one CSS file | A small, familiar starter; design polish is out of scope |
| `architecture.md` + three interview answers | `architecture.md`, METRICS.md, EXPERIMENTS.md; no interview answers | A take-home, not a system design question. [Experimentation Platform](../ROADMAP.md#9-experimentation-platform) is the interview version |

## Development Phases

1. **Starter first.** Server (catalog, seed, store, billing, usage, experiments, analytics, routes), then client (pages, `useExperiment`, Dev toolbar), then METRICS.md and the starter's smoke tests. The seed and METRICS.md were written together, so the account is a typical case from the data: a growing Tier 1 org with 2.8 days of credit and 412 recent 429s.
2. **Starter snapshot** before any experiment code.
3. **Large experiment.** Runway on the server, the instrumentation gaps it needed (source, depletion and tier events), then the banner and modal.
4. **Small experiment** on the same instrumentation.
5. **Tests.** Mocha for the framework, runway rules and events; vitest for the hook's exposure rules and both components in both arms.
6. **Browser verification** of both variants through the Dev toolbar, including the depleted state and control parity. Then screenshots through the repo harness.
7. **Readout as code** (`server/lib/readout.js`) so the metric definitions in EXPERIMENTS.md §4 are executable and tested. Then docs.

## Key Implementation Decisions

- **Exposure has its own endpoint** (`POST /api/experiments/:key/exposure`). The server attaches the variant, so the client can't log the wrong one. The generic `/api/events` refuses `$` names.
- **The experiment components gate themselves.** Each one is split into a *slot* that checks eligibility and renders nothing otherwise, and an inner component that calls `useExperiment`. Exposure is therefore logged exactly when an eligible org would see the change, in both arms. The tests pin this down: not eligible → no exposure; eligible control → exposure and no UI.
- **Eligibility lives on the server** (`runway.atRisk`, `rateLimit`) as facts returned to everyone, so there is one tested rule and the control's UI really is unchanged.
- **Conversions are server events; clicks are client events.** `credits_purchased`, `auto_reload_*`, `usage_tier_upgraded` and `credit_balance_depleted` come from `server/lib/billing.js`. The `*_action` client events are funnel diagnostics only.
- **Event properties were extended, not renamed**, so starter-era analyses of `credits_purchased` and `auto_reload_updated` still work.
- **The control is today's behavior, checked by eye and by test.** The Billing page's tier-upgrade toast only appears for `source=rate_limit_nudge` purchases, the one flow that promised an upgrade. Showing it for everyone would have changed the control.

## Iteration and Repair Log

1. **The API started on port 3000, colliding with Vite.** The preview tool that launched `npm run dev` sets `PORT=3000` for the web server, and the API read `PORT`. Fix: the API reads `API_PORT` (default 3001), and `npm start` sets `API_PORT=3000`.
2. **Seeded "last used" timestamps were in the future** when the UTC date was ahead of the local date. `daysAgo()` now clamps to now.
3. **The seed's 429 share was 12%,** an implausible outage, because requests were sized at 1,100 input tokens. Smaller requests give 11,000 requests a week and a 3.6% 429 share, consistent with METRICS.md.
4. **METRICS.md contradicted itself twice:**
   - Growth deltas didn't match the weekly table; they were recomputed.
   - A "median 11 days to advance" sat next to "54% haven't advanced by day 30". Fixed by saying the median covers orgs that advance, and adding the 14-day rate (33%) that the nudge's primary metric needs.
5. **The Dashboard tier card went stale** after the runway banner's auto-reload pushed Northwind to Tier 2. Found in the browser, not by a test. Limits now refetch when cumulative purchases change.
6. **A client test for "assignments fail to load" passed for the wrong reason.** `mockRejectedValueOnce` ran after `render()`, whose `act()` had already flushed the provider's fetch. The harness now takes a `loadError` option.
7. **`npm run dev` must not kill other projects.** The brief's "stop whatever holds 3000/3001" is unsafe in a repo where port 3000 is every project's API. `scripts/stop.js` only stops processes whose working directory or command line is inside this project, and reports anything else.
8. **The repo screenshot harness couldn't choose a `<select>` option,** which is how the Dev toolbar forces variants. Added a generic `{ "select": selector, "value": … }` step to `scripts/screenshots.mjs`.
9. **Screenshots took ~30 s per screen.** The Dev toolbar opened its SSE stream on page load, so the page never went network-idle and every navigation waited for the harness timeout. The stream now connects when the panel is first opened, which loses nothing because it replays recent events on connect.

## Verification

- `npm test`: 63 mocha tests (API smoke, framework, runway, growth events, readout) and 24 vitest tests (hook exposure rules, both experiments in both arms).
- Browser checks through the Dev toolbar:
  - Control on all pages, with `$exposure` logged for both experiments and no UI change.
  - Runway treatment: warning, then one-click auto-reload with an immediate charge, then the banner gone.
  - Depleted state via simulated traffic, and a Workbench 402.
  - Nudge treatment: Billing prefilled with $15, then purchase, then the Tier 2 toast, with `source: rate_limit_nudge` on the events.
  - Workbench, key creation and billing in control.
- `scripts/screenshot-configs/console-growth.json` captures 7 screens with the frontend running (`node scripts/screenshots.mjs console-growth`). `--start` doesn't apply, because the harness expects `frontend/` and `backend/` folders.

## Open Questions / Next Steps

See EXPERIMENTS.md §4, "With one more week". On the engineering side:
- Server-side exposure dedupe (per org per day) instead of per browser session.
- Confidence intervals and CUPED in `readout.js`.
- An `Idempotency-Key` on `POST /api/billing/credits`.
- A second seeded member with a Dev toolbar "act as" switch, to demo that org-unit experiments show teammates the same variant.
- Making `npm run triage` and smoke-test generation understand the `client/`/`server/` layout.
