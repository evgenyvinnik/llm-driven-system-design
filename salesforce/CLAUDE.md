# Salesforce CRM — Development with Claude

## Project Context

A CRM looks like the easy project in this repo — it's CRUD over five entities, with no realtime feed, no distributed lock, no matching engine. The difficulty is somewhere else: the *relationships* are the product. An account has contacts, contacts sit on opportunities, opportunities roll up into a pipeline forecast, leads become all three at once, and activities attach to any of them. Almost every screen is a join, and almost every number on the dashboard is an aggregate over a different slice of the same few tables.

The one genuinely dangerous operation is lead conversion. Everything else is a single-row write; conversion creates an account, a contact, and optionally an opportunity, then marks the lead converted — four writes that must either all happen or none. A half-converted lead is the worst possible state, because it isn't visibly broken: the sales rep sees a new account, no contact, and a lead still sitting in their queue, and there's no way to tell whether that's a bug or just how someone entered it.

The second theme is that the reporting workload and the transactional workload share one database. A pipeline report groups every opportunity by stage; the dashboard runs seven aggregates before it can render. Those are OLAP queries wearing OLTP clothes, and where they run — and whether their results are cached — is the scaling question this project actually raises.

**Learning goals:** multi-entity transactional writes with explicit rollback and row locking, record-level access control (ownership vs admin), polymorphic associations and what they cost, denormalization-free aggregate reporting, integer-cents money handling, and kanban drag-drop as a state machine with server-enforced valid transitions.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts` → `app.ts`) | **3001** | Single Express process; `dev:server2`/`dev:server3` on 3002/3003 |
| **PostgreSQL 16** | 5432 | Eight related tables with real FK constraints. The reporting queries (`GROUP BY`, `FILTER`, `DATE_TRUNC`) are the reason this is SQL and not a document store |
| **Valkey (Redis)** | 6379 | `express-session` store via `connect-redis` (prefix `salesforce:session:`). Rate limits are **in-memory per process**; `rate-limit-redis` is a dependency but not wired |
| **Frontend** (Vite) | 5173 | Proxies `/api` → `localhost:3001` |

Schema in `backend/src/db/init.sql`, mounted into the Postgres container's `docker-entrypoint-initdb.d`: `users`, `accounts`, `contacts`, `opportunities`, `leads`, `activities`, plus `custom_fields` and `custom_field_values`. Seven domain route files under `backend/src/routes/` (dashboard, accounts, contacts, opportunities, leads, activities, reports) sit over three domain services: `leadConversionService.ts` (the transaction), `dashboardService.ts` (KPIs), `reportService.ts` (pipeline by stage, revenue by month, leads by source). Every route asks `accessPolicy.ts` who may see a record; both opportunity write paths plan stage changes through `opportunityStages.ts`; `queryParams.ts` validates pagination, search and money input. Cross-cutting: `services/db.ts` (pool + int8/DATE type parsers), `redis.ts`, `rateLimiter.ts`, `circuitBreaker.ts` (unused), `metrics.ts`, `logger.ts`.

Frontend is React 19 + TanStack Router + Zustand + Tailwind. The account list route is `accounts.index.tsx` so it is a sibling of `accounts.$accountId.tsx`. `components/KanbanBoard.tsx` + `KanbanColumn.tsx` use @dnd-kit with a `DragOverlay`; `EntityForm.tsx` is one modal serving all four entity types; `ConvertLeadModal.tsx` drives conversion; `PipelineChart.tsx` and `ReportChart.tsx` are CSS-only bar charts. `AccountDetail.tsx` is the tabbed view (contacts / opportunities / activities) that motivates the polymorphic activity model.

## Key Design Decisions

### 1. Lead conversion is one transaction with explicit ROLLBACK, not a saga

`convertLead` checks out a dedicated client from the pool, issues `BEGIN`, reads the lead with `SELECT … FOR UPDATE`, checks the caller owns it (or is an admin) and that `converted_at` is null, inserts the account, inserts the contact, optionally inserts the opportunity, updates the lead `WHERE converted_at IS NULL`, and commits — with `ROLLBACK` in the catch and `client.release()` in the finally. The new records belong to the lead's owner, so an admin converting a rep's lead doesn't take the rep's customer.

Doing these as four independent requests is the version that fails in the field. Each write succeeds or fails on its own, so a network blip after the account insert leaves an orphan account with no contact and a lead that still looks unconverted. The rep retries, and now there are two accounts for the same company. Nothing errors; the data is just quietly wrong, and it stays wrong because there's no signal that anything happened. A saga with compensating actions would technically handle it, but compensations here are deletions of rows a user may already have edited — you'd be building rollback machinery to undo work someone might have done on purpose.

Since all four writes live in one Postgres instance, a plain transaction gives real atomicity for free. Checking out a dedicated client (rather than using `pool.query`) is load-bearing and easy to get wrong: `pool.query` can hand each statement a *different* connection, so `BEGIN` and `INSERT` would land on separate sessions and the transaction wouldn't cover anything.

Atomicity is not the same as single-shot. Without the row lock, two simultaneous conversions both passed the `converted_at IS NULL` read and each created an account and a contact. `FOR UPDATE` makes the second wait, re-read, and get a 409; the live check fires two conversions in parallel and sees exactly one 200 and one 409. What we give up is that the transaction holds a connection and a row lock for its full duration.

### 2. Activities are polymorphic — `related_type` + `related_id`, no foreign key

One `activities` table serves calls, emails, meetings, and notes attached to accounts, contacts, opportunities, or leads, indexed on `(related_type, related_id)`.

The relational-purist alternative is four join tables (`account_activities`, `contact_activities`, …) or four nullable FK columns with a CHECK that exactly one is set. Both preserve integrity and both make the *actual* query pattern painful. Every entity detail page shows the same timeline, so with separate tables the frontend needs four different endpoints returning four shapes, and `ActivityTimeline` becomes four components — or one component with a type switch, which is the polymorphic model reimplemented in TypeScript with none of the database's help. Adding a fifth entity type would mean a migration rather than a string.

The cost is genuine and should be stated plainly: **the database cannot enforce that `related_id` points at anything**. Delete an account and its activities remain, pointing at a UUID that resolves to nothing. That's tolerable here specifically because activities are an append-only audit log — an orphaned "Called about renewal" row is inert, invisible in the UI (nothing queries it), and arguably *should* survive as history. This reasoning would not hold for a table whose rows drive behavior; the safety comes from the data being a log, not from the pattern being sound.

### 3. Money is integer cents, everywhere

`opportunities.amount_cents` and `accounts.annual_revenue_cents` are `BIGINT`. Nothing in this project stores a currency value as a float; the API rejects fractional or negative cents with a 400, dollars from a form are converted to cents exactly once, and the frontend divides by 100 only at render time.

Floating point cannot represent most decimal fractions exactly, and a CRM does exactly the operation that exposes it: summing many values. `SUM(amount)` over a pipeline of a few hundred float opportunities accumulates error, and the pipeline total on the dashboard disagrees with the sum of the rows on the opportunities page by a few cents. That is the kind of bug that destroys trust in a sales tool, because the number a rep reports to their manager doesn't reconcile — and it is unfixable after the fact, since the error is in the stored values. `NUMERIC` would also be exact, but integers are faster to aggregate and make it structurally impossible to accidentally store a fractional cent.

BIGINT has its own trap: node-postgres returns int8 as a **string**. The kanban column total computed `sum + o.amount_cents` and concatenated, so the Closed Won column read "$22000000.5M". `services/db.ts` now parses int8 to a number (throwing if a value would lose precision; cents here are far below 2^53). What we give up: every read path must remember to divide, and that rendering concern leaks into the client.

### 4. Kanban stage changes go through a dedicated endpoint that owns probability

`PUT /api/opportunities/:id/stage` validates against `VALID_STAGES` and applies the stage→probability mapping itself. The general `PUT /api/opportunities/:id` accepts an explicit `probability` and lets the user override.

Letting the kanban drag send a generic update means the *client* decides the new probability, and every client must then carry the same mapping table. The moment those drift — a mobile client, an integration, a stale bundle — forecasts computed from `probability` silently diverge from forecasts computed from `stage`, and nobody can say which is right. Putting the mapping behind a narrow endpoint makes the server the single authority for the common path while still permitting a deliberate override through the full update. Validating the stage string server-side matters for the same reason: `stage` is a plain `VARCHAR` with no CHECK constraint in the schema, so the route handler is the only thing standing between a typo and an opportunity in a stage that no report will ever count.

Both paths now plan through `opportunityStages.ts`: a stage change without an explicit probability applies the stage default, closed stages are pinned at 100/0, and **reopening a closed deal (or flipping Won to Lost) needs an admin**, a 409 for reps. Deals do reopen, so it is gated rather than forbidden. `closed_at` is stamped on entering a closed stage and cleared on leaving it, and the revenue report books deals by it; it used to group by `updated_at`, so editing a deal won in March moved its revenue to this month. Writes are compare-and-set on the stage they were planned from (`WHERE stage = $read`, 409 on a mismatch), and stage/probability/amount are also CHECK constraints now. The remaining trade-off is two write paths for one field.

### 5. Charts are CSS, not a charting library

`PipelineChart` and `ReportChart` render proportional-width divs with a hardcoded per-stage color map. No Recharts, no Chart.js — the frontend's only non-React runtime dependencies are TanStack Router, Zustand, and @dnd-kit.

A charting library is 100–200KB gzipped, brings its own SVG renderer and animation loop, and is the largest thing in the bundle — to draw seven horizontal bars whose lengths are `value / max * 100%`. For a fixed, known set of simple visualizations, `width: ${pct}%` on a coloured div is the whole implementation, and it inherits the design system for free instead of needing theme configuration to match.

What we give up is everything a real charting library provides and a bar chart eventually wants: tooltips, axis ticks, responsive label collision handling, animated transitions, legends, and any chart type that isn't a bar. The moment a time-series line chart or a stacked breakdown is needed, this decision reverses — and it should, because hand-rolling axis math is where the CSS approach stops being cheap.

### 6. Records are private to their owner; admins see everything

One policy module, `services/accessPolicy.ts`, used by every route. A rep (`role = 'user'`) sees and changes only the accounts, contacts, opportunities, leads and activities they own; an admin sees and changes all of them. Invisible records are a 404, not a 403, as are malformed IDs. List queries and report aggregates get an `owner_id = $caller` condition, and `UPDATE`/`DELETE` carry it in their own `WHERE`, so the check and the write can't race. References are checked too: a rep can't hang a contact, deal or activity off someone else's account. Activity *reads* follow the parent (anyone who can see a deal sees its whole timeline); edits stay with the author or an admin. Reports honour `?all=true` only for admins and say which scope they used.

Why Private rather than Public Read Only: before this, any signed-in user could read, edit or delete any record, and `?all=true` gave anyone the org's whole pipeline. With Private as the baseline, one rule answers both "can I open this?" and "does this count in my numbers?". Given up: there is no role hierarchy or sharing yet, so a manager can't see their team's deals.

## Current State

Runs with `docker-compose up -d` (Postgres, Valkey), then `npm run db:migrate` and the seed (`backend/db-seed/seed.sql`), then `npm run dev` in `backend/` (API on 3001; `dev:server2`/`dev:server3` on 3002/3003). Implemented: session auth with bcrypt over Redis-backed sessions (regenerated on login), record-level access (owner or admin), full CRUD API for accounts / contacts / opportunities / leads / activities with search and clamped pagination, transactional and row-locked lead conversion with optional opportunity creation, the kanban board with optimistic drag-drop, server-owned probability and gated reopening, New Opportunity from the board, an account detail page with tabbed contacts/opportunities/activities, a dashboard with eight KPIs, three reports (pipeline by stage, revenue by month of `closed_at`, leads by source) scoped per caller, CSS bar charts, Prometheus request metrics at `/metrics`, pino/pino-http structured logging, in-memory rate limiting (reports per user), and `/api/health`. 45 vitest tests (supertest routes with in-memory sessions, stage rules, conversion, input parsing).

Seeded logins: `alice` / `password123` (admin, sees everything) and `bob` / `password123` (rep, sees only Vertex, Lumen and their deals and leads), with sample accounts, contacts, opportunities across stages, leads (one already converted), and activities (one note by alice on bob's deal).

Simulated or omitted: `custom_fields` and `custom_field_values` exist in the schema with a working design (per-entity-type field definitions, `options` JSONB for select fields, a UNIQUE on `(field_id, entity_id)`) and **no routes touch them at all** — a grep across `routes/` and `services/` returns nothing. Also absent: edit/delete UI (the API has both), email integration, workflow automation, role hierarchy and sharing rules, bulk operations, an audit trail of field changes, a version column for non-stage edits, and any admin UI.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** restructured this file and corrected a claim it made about code that doesn't exist. The old "Learnings" section asserted *"Dashboard KPI queries can be parallelized with Promise.all for significant latency reduction (8 sequential queries → 1 round-trip)"* and Phase 2 described a *"Dashboard service with parallel KPI queries"* — but `getDashboardKPIs` issues **seven sequential `await pool.query(...)` calls**, and `grep -rn "Promise.all" backend/src/` returns zero hits across the entire backend. The optimization was documented as done and never written. It's a real and easy improvement; it just isn't the current state.
- **Backend port pinned to 3001** (later superseded: see 2026-11): the port moved from the `dev` script to the config default so `dev:server2`/`dev:server3` work.
- **`dev:server2` / `dev:server3` were no-ops** (fixed 2026-11): `dev` itself set `PORT=3001`, so the inner assignment won.
- **Stage validation lived only in the route layer** (fixed 2026-11: CHECK constraints).
- **Lead conversion guard was a read-then-write** (fixed 2026-11: `FOR UPDATE`).
- **2026-08-04 — screenshot coverage missed the two most distinctive screens.** The app itself was healthy (dashboard KPIs, pipeline bars, and all list views rendered real seeded data), but the config only captured dashboard/leads/accounts/contacts — not the **kanban opportunities board**, which is the headline UI and the subject of decision 4, nor the reports page that decision 5's CSS charts exist for. Both added; 5 → 7 screenshots.
- **CI:** the repo-wide smoke-test workflow was removed; a runner can't provide Postgres and Valkey for these paths. Verification is local (`npm run triage salesforce`).
- **2026-11 — authorization, integrity, and the screens that never worked.**
  - *Broken:* nothing checked ownership. Any signed-in user could list, read, edit or delete any record, browse another rep's account sub-lists and timelines, attach records to other reps' accounts, convert their leads, and pull org-wide reports with `?all=true`.
    - *Fix:* `accessPolicy.ts` (decision 6).
  - *Broken:* lead conversion had no row lock (double conversion), echoed Postgres errors in its 400s, and gave converted deals Qualification at 10%.
  - *Broken:* stage changes via the full update kept the old probability ("Closed Won at 10%"), any rep could drag a closed deal back open, and revenue was grouped by `updated_at`.
    - *Fix:* decision 4, plus `closed_at` and compare-and-set writes.
  - *Broken:* leads could be set to "Converted" by hand, and deleting any converted account, contact or opportunity was an FK-violation 500.
    - *Fix:* CHECK constraints and `ON DELETE SET NULL`. `init.sql` gained an idempotent upgrade block.
  - *Broken:* `limit=-1`, `page=abc`, `months=abc` and malformed UUIDs were 500s, and LIKE wildcards were unescaped.
  - *Broken:* login didn't regenerate the session, and `/metrics` histograms were never observed.
  - *Broken:* the seed used statuses and sources the API rejects ('Working', 'Cold Call').
  - *Broken, frontend:*
    - The account detail page was unreachable: the `accounts.tsx` parent had no `<Outlet/>`. Renamed to `accounts.index.tsx`.
    - int8 strings concatenated in kanban totals (decision 3).
    - Column charts drew no bars: a percentage height inside an auto-height flex column (now px).
    - Nothing could create an opportunity. EntityForm's opportunity mode was never rendered and labelled cents as dollars.
    - Drags waited, then re-fetched with a loading flash, and swallowed refusals. They are now optimistic with revert and an error banner.
    - DATE values showed a day early west of UTC, and activity due dates were sent with no time zone.
    - The store survived logout.
    - There was no `<main>`, so generated smoke tests failed.
  - *Found in the live run:* the report limiter (30/min per IP) was exhausted by the dashboard's own pipeline call plus StrictMode doubling, and charts showed "No data". It is now 60/min per user.
  - *Verified:* 45 unit tests and 88 live checks across alice, bob and a newly registered rep (three clean-reset runs). 14 screenshots, including bob's own-records kanban/reports and his 404 on alice's account. 14/14 smoke tests.

## Open Questions

1. `getDashboardKPIs` runs seven aggregates sequentially on every dashboard load. `Promise.all` is the obvious fix — but does the dashboard instead want a short Redis TTL, given that a pipeline total that's 60 seconds stale is indistinguishable from a fresh one to a sales rep?
2. Reports scan the full `opportunities` and `leads` tables with `GROUP BY` on every request. At what row count does the reporting workload need to leave the transactional database — and is a read replica the answer, or precomputed rollups on a schedule?
3. The custom-field tables are designed and completely unexposed. Is EAV the right model to actually build on (queryable, but every filtered list becomes a join per custom field), or should custom fields be a JSONB column on each entity like the retool project's app documents?
4. Stage writes are compare-and-set, but other fields (amount, close date, name) are still last-write-wins. Is a version column on every entity worth the "someone else changed this, reload" UX now that only the owner and admins can write a record?
5. Reopening a closed deal is admin-only. Should reps be able to reopen within a grace period (an accidental drag), and should reopening be logged once an audit trail exists?
6. The next access layer is a role hierarchy (managers see their team). Does `owner_id = $caller` become `owner_id = ANY($visible_owners)` resolved per request, or does it need the rollup-per-owner design from the backend interview answer once reports grow?

## Resources

- [PostgreSQL transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html) — BEGIN/COMMIT/ROLLBACK semantics behind lead conversion
- [node-postgres transactions](https://node-postgres.com/features/transactions) — why a transaction must check out a dedicated client rather than use `pool.query`
- [PostgreSQL aggregate functions and FILTER](https://www.postgresql.org/docs/current/functions-aggregate.html) — the conversion-rate and report queries
- [dnd-kit DragOverlay](https://docs.dndkit.com/api-documentation/draggable/drag-overlay) — the kanban drag pattern
- [Martin Fowler: Money pattern](https://martinfowler.com/eaaCatalog/money.html) — the integer-cents argument
