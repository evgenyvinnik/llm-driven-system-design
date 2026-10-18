# Console Growth: Architecture

## System Overview

Console is the developer console for an LLM API: a Workbench to try models, API keys, usage and limits, and prepaid billing. This project is about the **growth layer** on top of it:
- an experiment framework (deterministic assignment, exposure logging, overrides, a kill switch);
- an event pipeline (client and server `track()`);
- two experiments built with them, a credit-runway warning and a rate-limit upgrade nudge.

The product pages are deliberately plain. The interesting parts are where exposure is logged, which side emits each conversion, and how a metric is computed from the log.

**Learning goals:** exposure vs. assignment; choosing the randomization unit; server-side conversions; turning a product problem into a metric that reads in weeks; and designing a change so the control really is unchanged.

## Requirements

**Functional**
- Every experiment is registered with a key, unit (`user` or `org`), variants, weights and an on/off switch.
- The same unit always gets the same variant. Different experiments are assigned independently.
- Staff can force a variant for QA. Forced traffic is flagged and kept out of analysis.
- `$exposure` is logged once per session when a user meets the difference, in both arms.
- Conversions (purchases, auto-reload changes, tier upgrades, depletions) are recorded with their source surface.
- Turning an experiment off returns everyone to the control and stops exposure logging.

**Non-functional (production targets)**
- Assignment adds under 1 ms: it is a hash and an in-memory ruleset, with no network call on the request path.
- Kill switch reaches every API instance within 60 seconds.
- Server-side conversion events: loss under 0.1%. Client events are best effort; about 5% of sessions block them.
- Sample-ratio mismatch on exposures detected within a day of launch.
- An analytics failure never fails a product request.

## High-Level Architecture

```
┌──────────────┐   REST + X-Experiment-Overrides    ┌──────────────────────────────────────────┐
│   Browser    │ ──────────────────────────────────▶│              Console API                 │
│  React app   │                                    │  ┌──────────────┐  ┌──────────────────┐  │
│ useExperiment│ ◀── assignments (GET /experiments) │  │ assignment   │  │ billing / runway │  │
│ track()      │ ── $exposure, client events ──────▶│  │ (hash + rule │  │ tiers / usage    │  │
└──────────────┘                                    │  │  set cache)  │  └────────┬─────────┘  │
                                                    │  └──────┬───────┘           │ conversions│
                                                    └─────────┼───────────────────┼────────────┘
                                   ruleset snapshots ▲        │ track()           │ track()
                                                     │        ▼                   ▼
                                       ┌─────────────┴──┐   ┌────────────────────────────────┐
                                       │ Experiment     │   │ Event collector ──▶ Kafka topic │
                                       │ registry (DB + │   └───────────────┬────────────────┘
                                       │ admin UI)      │                   ▼
                                       └────────────────┘   ┌────────────────────────────────┐
                                                            │ Warehouse: events, exposures   │
                                                            │ ──▶ readout jobs (per-arm      │
                                                            │     metrics, SRM, CIs)         │
                                                            └────────────────────────────────┘
```

Locally, the registry is a JS file, the collector is `track()` writing to memory and `data/events.ndjson`, and the readout is `npm run readout`.

## Core Components and Request Flows

### Assignment

1. `bucket = uint32(sha256("<key>:<unitId>")[0..4]) mod 10,000`. The unit id is the org id for `org` experiments and the user id for `user` experiments.
2. Each variant owns a contiguous bucket range sized by its weight. Because the key is in the hash, experiments are assigned independently of each other.
3. A valid override in the `X-Experiment-Overrides` header wins, and the result is marked `overridden: true`. Overrides that name a variant that doesn't exist are ignored.
4. `enabled: false` returns the first variant (the control) for everyone.

The client never hashes. `GET /api/experiments` returns the server's assignments, so client and server can't disagree.

### Exposure

```
Layout renders <CreditRunwayBanner billing>
   └─ billing.runway.atRisk?  no ──▶ render nothing, no hook call, no exposure
                              yes
                               ▼
      <RunwayBanner> calls useExperiment('credit_runway_autoreload', { exposureProps })
         └─ on mount, once per session per variant:
            POST /api/experiments/credit_runway_autoreload/exposure { props }
               └─ server resolves the variant itself → track('$exposure', {...props, variant, unit_id, overridden})
      control   ──▶ returns null (today's UI)
      treatment ──▶ banner
```

The rule this encodes: **log exposure where the difference would appear, under the same condition, in both arms.** Calling the hook in the Layout would log every page view by every org, most of which would never see a banner. The few real effects would be diluted by thousands of orgs the treatment couldn't have touched. Logging only in the treatment would leave the control with no comparable population. The rate-limit nudge follows the same pattern on the Usage page.

### Conversions

The server records conversions at the moment the state changes:

| Event | Emitted by | When |
|-------|-----------|------|
| `credits_purchased` | `purchaseCredits()` | A purchase, with `source`, `tier_before` and `tier_after` |
| `auto_reload_updated` | `updateAutoReload()` | A settings change, with `source` and `was_enabled` |
| `auto_reload_charged` | `chargeAutoReload()` | A reload, with `trigger: enabled \| threshold` |
| `usage_tier_upgraded` | `addCredits()` | A purchase or reload that moves the tier |
| `credit_balance_depleted` | `debit()` | Once, when a debit takes the balance from above $0 to $0 or below |
| `api_requests_rejected` | Workbench route, traffic simulator | Requests refused at $0 |

The client only records intent (`runway_banner_action`, `rate_limit_nudge_action`): which button was clicked, in what state. Those are for diagnosing the funnel, not for deciding the experiment.

### Runway

`computeRunway(state, now)`:
1. Average daily spend over the **last 7 complete days**. Today is excluded: it is partial, and a burst of Workbench runs would skew it.
2. `daysLeft = balance / avg`. It is 0 if the balance is at or below $0, and null if there was no spend.
3. `atRisk = plan is Build ∧ auto-reload off ∧ (depleted ∨ daysLeft ≤ 7)`.
4. Suggested auto-reload settings: threshold = 3 days of spend (at least $5); amount = 14 days (between $10 and $500), both rounded up to $5.

It is returned on `GET /api/billing` for everyone. It is a fact about the account; the UI decides what to show.

## Database Schema

Local state is one in-memory object ([server/seed.js](./server/seed.js)): `org`, `users`, `keys`, `usage[]` (one row per date and model), and `billing` (balance, auto-reload, transactions, cumulative purchases, first purchase). In production the experiment and event tables would be:

```sql
CREATE TABLE experiments (
  key          TEXT PRIMARY KEY,            -- also the hash salt; never reused
  unit         TEXT NOT NULL CHECK (unit IN ('user', 'org')),
  variants     TEXT[] NOT NULL,             -- variants[1] is the control
  weights      INT[] NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  version      INT NOT NULL DEFAULT 1,      -- bumps on every change; clients cache by version
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only; partitioned by day in the warehouse.
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  event       TEXT NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  source      TEXT NOT NULL,                -- 'server' | 'client'
  user_id     TEXT,
  org_id      TEXT,
  session_id  TEXT,
  props       JSONB NOT NULL
);
CREATE INDEX events_exposure_idx ON events ((props->>'experiment'), org_id, ts) WHERE event = '$exposure';
CREATE INDEX events_org_ts_idx ON events (org_id, ts);
```

## API Design

```
GET  /api/me                              → user and org
GET  /api/keys · POST /api/keys · PATCH/DELETE /api/keys/:id
POST /api/workbench/complete              → mock completion, billed to credits; 402 at $0
GET  /api/usage?days=7|14|21              → daily series, by model, 429s
GET  /api/limits                          → tier, next tier, monthly spend, rateLimit summary
GET  /api/billing                         → balance, auto-reload, transactions, runway
POST /api/billing/credits                 → { amountCents, source }
PUT  /api/billing/auto-reload             → { enabled, thresholdCents, amountCents, source }
GET  /api/experiments                     → assignments with overrides applied
POST /api/experiments/:key/exposure       → logs $exposure with the server-resolved variant
POST /api/events · GET /api/events · GET /api/events/stream (SSE)
POST /api/dev/reset · /api/dev/clear-events · /api/dev/simulate-usage
```

## Key Design Decisions

**Exposure is reported to an experiment-specific endpoint, not `POST /api/events`.** The browser says "the user saw `credit_runway_autoreload` here"; the server attaches the variant from its own assignment. A stale tab or a buggy client therefore can't log a variant the org isn't in, and `$`-prefixed events are refused from the generic endpoint. The cost is one more endpoint, which is small next to an analysis where the exposure log can't be trusted.

**Both experiments randomize by org.** Billing and rate limits belong to the org: two teammates looking at the same balance must see the same banner, or one of them turns on auto-reload because of a warning the other never saw. Org randomization gives fewer units (about 60,000 Build orgs, not their users) and so wider confidence intervals. The power estimate in EXPERIMENTS.md shows that is still enough at these effect sizes.

**Conversions are emitted server-side.** A purchase is a fact the server knows. Recording it from the browser would lose ~5% to ad blockers and closed tabs, and the loss wouldn't be random: a treatment that sends people to Billing in the same tab would look better than it is. Client events record intent only.

**Eligibility is computed on the server as a domain fact.** `runway.atRisk` and `rateLimit` are returned to every org whatever its arm. That keeps one definition, tested in mocha, and lets the same rule drive future emails or headers. The control's UI ignores them, so the control is unchanged.

**New properties, not renamed events.** `credits_purchased` and `auto_reload_updated` existed; they gained `source`, `tier_before`/`tier_after` and `was_enabled`. Renaming them would have broken every dashboard that counts purchases.

**The runway rate uses complete days.** Including today undercounts in the morning and overreacts to a burst of Workbench runs. The cost is up to a day's lag for a fast-growing org. The proper fix is a trend-aware forecast, listed as next work.

## Consistency and Idempotency

- **Exposure dedupe** is per browser session per variant: an in-memory set, mirrored to `sessionStorage`. Forcing a different variant logs a new exposure flagged `overridden`, and the readout drops orgs seen in both variants. In production, dedupe would move server-side, per org per day.
- **Depletion fires once per crossing.** It is emitted only when a debit takes the balance from above $0 to $0 or below. Later rejected requests emit `api_requests_rejected` instead.
- **Purchases aren't idempotent locally.** In production, `POST /billing/credits` would take an `Idempotency-Key`, so a retried click can't buy twice. The banner and nudge only link to Billing, so they add no new purchase path.
- **Attribution is bounded.** The Billing page clears `?source=` after one purchase, so a second purchase in the same visit isn't credited to the banner.

## Security

- `source` is checked against an allow-list (`billing_page`, `runway_banner`, `rate_limit_nudge`); anything else is recorded as `other`.
- Client event names must be snake_case and can't start with `$`. Props are capped at 4 KB.
- Locally, anyone can send overrides. In production, the override header would be honored only for staff sessions, and is flagged `overridden` either way.
- There is no login, by design. Every request acts as the seeded user.

## Observability

- The Dev toolbar's live stream (SSE) of every event, client and server, with `$exposure` highlighted.
- `npm run readout` for per-arm metrics. In production, the same definitions run as warehouse jobs with a sample-ratio check on exposures, CUPED and confidence intervals.
- Launch checks: exposures per arm, depletion and auto-reload events per hour, auto-reload charge failures, refund tickets.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| `GET /api/experiments` fails | `useExperiment` reports `ready: true` with the control, and no exposure is logged |
| `track()` or exposure POST fails | Swallowed; the product never waits on analytics |
| Unknown experiment key | Server throws (a programming error); the client warns in development and renders the control |
| Kill switch | `enabled: false`: everyone gets the control and exposure logging stops |
| Auto-reload card declined | Not simulated locally. In production this is still a depletion, and the banner would ask for a new card |

## Scalability Considerations

- **Assignment** is stateless: a hash plus a ruleset snapshot cached in each API process and refreshed by version. Nothing to scale except the registry's read path.
- **Events** go through a collector to Kafka and on to the warehouse, partitioned by day. Readouts are batch jobs keyed by `(experiment, org_id)`. The exposure index above keeps "first exposure per org" cheap.
- **Runway** is computed on read from daily usage aggregates; it is cheap per org. Emailing every at-risk org daily would need it precomputed in a nightly job over the usage table.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Where exposure is logged | In the component that renders the difference, both arms | On page load or at assignment | Analyze only units the change could affect |
| Exposure transport | `POST /experiments/:key/exposure` with a server-resolved variant | Generic `track('$exposure')` | Client can't misreport its arm |
| Randomization unit | Org | User | Billing and limits are shared by the team |
| Conversion events | Server-side | Client `track()` | No ad-blocker or closed-tab loss, no biased loss |
| Eligibility | Server domain fact (`runway.atRisk`) | Client-side check | One tested definition, reusable for email |
| Runway rate | Last 7 complete days | Including today, or a trend model | Stable and simple; trend model next |
| Event schema change | Add properties | Rename events | Existing dashboards keep working |
| Exposure dedupe | Per session per variant | Server-side per org per day | Simple locally; server-side is the production fix |

## Implementation Notes

**Implemented and production-shaped**
- Deterministic sha256 bucketing, weights, independent salts, overrides flagged in the data, and a kill switch ([server/lib/experiments.js](./server/lib/experiments.js)), with tests for balance and independence over 10,000 units.
- Server-resolved exposures, and `useExperiment()` with automatic and manual exposure and session dedupe ([client/src/lib/experiments.jsx](./client/src/lib/experiments.jsx)).
- Server-side conversions with source attribution and validation ([server/lib/billing.js](./server/lib/billing.js)).
- Metric definitions as code ([server/lib/readout.js](./server/lib/readout.js)): exposed population, first-exposure arm, contamination and override exclusion, windows.

**Simplified**
- The registry is a JS file, not a database with an admin UI.
- Events go to memory and an NDJSON file instead of a collector, Kafka and a warehouse.
- One seeded org and user, with no login. The mock model returns deterministic text.
- Payments always succeed. API traffic is simulated (`/api/dev/simulate-usage`).

**Omitted**
- Statistical tests in the readout, CUPED, and automated sample-ratio alerts.
- Email and webhook notification channels.
- Server-side exposure dedupe, multi-region, real authentication.
