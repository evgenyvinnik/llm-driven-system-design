# Salesforce CRM — Development with Claude

## Project Context

A CRM looks like the easy project in this repo — it's CRUD over five entities, with no realtime feed, no distributed lock, no matching engine. The difficulty is somewhere else: the *relationships* are the product. An account has contacts, contacts sit on opportunities, opportunities roll up into a pipeline forecast, leads become all three at once, and activities attach to any of them. Almost every screen is a join, and almost every number on the dashboard is an aggregate over a different slice of the same few tables.

The one genuinely dangerous operation is lead conversion. Everything else is a single-row write; conversion creates an account, a contact, and optionally an opportunity, then marks the lead converted — four writes that must either all happen or none. A half-converted lead is the worst possible state, because it isn't visibly broken: the sales rep sees a new account, no contact, and a lead still sitting in their queue, and there's no way to tell whether that's a bug or just how someone entered it.

The second theme is that the reporting workload and the transactional workload share one database. A pipeline report groups every opportunity by stage; the dashboard runs seven aggregates before it can render. Those are OLAP queries wearing OLTP clothes, and where they run — and whether their results are cached — is the scaling question this project actually raises.

**Learning goals:** multi-entity transactional writes with explicit rollback, polymorphic associations and what they cost, denormalization-free aggregate reporting, integer-cents money handling, and kanban drag-drop as a state machine with server-enforced valid transitions.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts` → `app.ts`) | **3001** | Single Express process; `dev:server2`/`dev:server3` on 3002/3003 |
| **PostgreSQL 16** | 5432 | Eight related tables with real FK constraints. The reporting queries (`GROUP BY`, `FILTER`, `DATE_TRUNC`) are the reason this is SQL and not a document store |
| **Valkey (Redis)** | 6379 | `express-session` store via `connect-redis` (prefix `salesforce:session:`) and `rate-limit-redis` for shared rate limits |
| **Frontend** (Vite) | 5173 | Proxies `/api` → `localhost:3001` |

Schema in `backend/src/db/init.sql`, mounted into the Postgres container's `docker-entrypoint-initdb.d`: `users`, `accounts`, `contacts`, `opportunities`, `leads`, `activities`, plus `custom_fields` and `custom_field_values`. Seven domain route files under `backend/src/routes/` (dashboard, accounts, contacts, opportunities, leads, activities, reports) sit over three services: `leadConversionService.ts` (the transaction), `dashboardService.ts` (KPIs), `reportService.ts` (pipeline by stage, revenue by month, leads by source). Cross-cutting: `services/db.ts`, `redis.ts`, `rateLimiter.ts`, `circuitBreaker.ts`, `metrics.ts`, `logger.ts`.

Frontend is React 19 + TanStack Router + Zustand + Tailwind. `components/KanbanBoard.tsx` + `KanbanColumn.tsx` use @dnd-kit with a `DragOverlay`; `EntityForm.tsx` is one modal serving all four entity types; `ConvertLeadModal.tsx` drives conversion; `PipelineChart.tsx` and `ReportChart.tsx` are CSS-only bar charts. `AccountDetail.tsx` is the tabbed view (contacts / opportunities / activities) that motivates the polymorphic activity model.

## Key Design Decisions

### 1. Lead conversion is one transaction with explicit ROLLBACK, not a saga

`convertLead` checks out a dedicated client from the pool, issues `BEGIN`, re-reads the lead with `converted_at IS NULL` as a guard, inserts the account, inserts the contact, optionally inserts the opportunity, updates the lead, and commits — with `ROLLBACK` in the catch and `client.release()` in the finally.

Doing these as four independent requests is the version that fails in the field. Each write succeeds or fails on its own, so a network blip after the account insert leaves an orphan account with no contact and a lead that still looks unconverted. The rep retries, and now there are two accounts for the same company. Nothing errors; the data is just quietly wrong, and it stays wrong because there's no signal that anything happened. A saga with compensating actions would technically handle it, but compensations here are deletions of rows a user may already have edited — you'd be building rollback machinery to undo work someone might have done on purpose.

Since all four writes live in one Postgres instance, a plain transaction gives real atomicity for free. Checking out a dedicated client (rather than using `pool.query`) is load-bearing and easy to get wrong: `pool.query` can hand each statement a *different* connection, so `BEGIN` and `INSERT` would land on separate sessions and the transaction wouldn't cover anything.

What we give up is that the transaction holds a connection for its full duration, and the `converted_at IS NULL` check is a read-then-write without `FOR UPDATE` — two simultaneous conversions of the same lead could both pass the check. It's a narrow window and the practical guard is that one rep owns a lead, but it's a race, not a proof.

### 2. Activities are polymorphic — `related_type` + `related_id`, no foreign key

One `activities` table serves calls, emails, meetings, and notes attached to accounts, contacts, opportunities, or leads, indexed on `(related_type, related_id)`.

The relational-purist alternative is four join tables (`account_activities`, `contact_activities`, …) or four nullable FK columns with a CHECK that exactly one is set. Both preserve integrity and both make the *actual* query pattern painful. Every entity detail page shows the same timeline, so with separate tables the frontend needs four different endpoints returning four shapes, and `ActivityTimeline` becomes four components — or one component with a type switch, which is the polymorphic model reimplemented in TypeScript with none of the database's help. Adding a fifth entity type would mean a migration rather than a string.

The cost is genuine and should be stated plainly: **the database cannot enforce that `related_id` points at anything**. Delete an account and its activities remain, pointing at a UUID that resolves to nothing. That's tolerable here specifically because activities are an append-only audit log — an orphaned "Called about renewal" row is inert, invisible in the UI (nothing queries it), and arguably *should* survive as history. This reasoning would not hold for a table whose rows drive behavior; the safety comes from the data being a log, not from the pattern being sound.

### 3. Money is integer cents, everywhere

`opportunities.amount_cents` is an `INTEGER`. Nothing in this project stores a currency value as a float, and the frontend divides by 100 only at render time (`PipelineChart.formatCurrency`).

Floating point cannot represent most decimal fractions exactly, and a CRM does exactly the operation that exposes it: summing many values. `SUM(amount)` over a pipeline of a few hundred float opportunities accumulates error, and the pipeline total on the dashboard disagrees with the sum of the rows on the opportunities page by a few cents. That is the kind of bug that destroys trust in a sales tool, because the number a rep reports to their manager doesn't reconcile — and it is unfixable after the fact, since the error is in the stored values. `NUMERIC` would also be exact, but integers are faster to aggregate and make it structurally impossible to accidentally store a fractional cent.

What we give up: `INTEGER` caps at ~2.1 billion cents, or about $21.5 million per opportunity, and every read path must remember to divide. The division is a rendering concern that leaks into the client; a `BIGINT` would remove the ceiling for a one-character migration.

### 4. Kanban stage changes go through a dedicated endpoint that owns probability

`PUT /api/opportunities/:id/stage` validates against `VALID_STAGES` and applies the stage→probability mapping itself. The general `PUT /api/opportunities/:id` accepts an explicit `probability` and lets the user override.

Letting the kanban drag send a generic update means the *client* decides the new probability, and every client must then carry the same mapping table. The moment those drift — a mobile client, an integration, a stale bundle — forecasts computed from `probability` silently diverge from forecasts computed from `stage`, and nobody can say which is right. Putting the mapping behind a narrow endpoint makes the server the single authority for the common path while still permitting a deliberate override through the full update. Validating the stage string server-side matters for the same reason: `stage` is a plain `VARCHAR` with no CHECK constraint in the schema, so the route handler is the only thing standing between a typo and an opportunity in a stage that no report will ever count.

The trade-off is two write paths for one field, and no state-machine constraint on *which* transitions are legal — you can drag a Closed Won opportunity back to Prospecting, and the pipeline report will happily re-count it as open.

### 5. Charts are CSS, not a charting library

`PipelineChart` and `ReportChart` render proportional-width divs with a hardcoded per-stage color map. No Recharts, no Chart.js — the frontend's only non-React runtime dependencies are TanStack Router, Zustand, and @dnd-kit.

A charting library is 100–200KB gzipped, brings its own SVG renderer and animation loop, and is the largest thing in the bundle — to draw seven horizontal bars whose lengths are `value / max * 100%`. For a fixed, known set of simple visualizations, `width: ${pct}%` on a coloured div is the whole implementation, and it inherits the design system for free instead of needing theme configuration to match.

What we give up is everything a real charting library provides and a bar chart eventually wants: tooltips, axis ticks, responsive label collision handling, animated transitions, legends, and any chart type that isn't a bar. The moment a time-series line chart or a stacked breakdown is needed, this decision reverses — and it should, because hand-rolling axis math is where the CSS approach stops being cheap.

## Current State

Runs with `docker-compose up -d` (Postgres, Valkey), then `npm run db:migrate` in `backend/`, then `npm run dev` (API on 3001). Implemented: session auth with bcrypt over Redis-backed sessions, full CRUD for accounts / contacts / opportunities / leads / activities with search and pagination, transactional lead conversion with optional opportunity creation, the kanban board with drag-drop stage updates and automatic probability mapping, an account detail page with tabbed contacts/opportunities/activities, a dashboard with eight KPIs, three reports (pipeline by stage, revenue by month via `DATE_TRUNC`, leads by source), CSS bar charts, Prometheus metrics at `/metrics`, pino/pino-http structured logging, Redis-backed rate limiting on `/api`, and `/api/health`. Vitest is configured.

Seeded logins: `alice` / `password123` (admin) and `bob` / `password123`, with sample accounts, contacts, opportunities across stages, leads, and activities.

Simulated or omitted: `custom_fields` and `custom_field_values` exist in the schema with a working design (per-entity-type field definitions, `options` JSONB for select fields, a UNIQUE on `(field_id, entity_id)`) and **no routes touch them at all** — a grep across `routes/` and `services/` returns nothing. Also absent: email integration, workflow automation, permissions beyond a `role` column, territory/team hierarchy, bulk operations, an audit trail of field changes, and any admin UI.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** restructured this file and corrected a claim it made about code that doesn't exist. The old "Learnings" section asserted *"Dashboard KPI queries can be parallelized with Promise.all for significant latency reduction (8 sequential queries → 1 round-trip)"* and Phase 2 described a *"Dashboard service with parallel KPI queries"* — but `getDashboardKPIs` issues **seven sequential `await pool.query(...)` calls**, and `grep -rn "Promise.all" backend/src/` returns zero hits across the entire backend. The optimization was documented as done and never written. It's a real and easy improvement; it just isn't the current state.
- **Backend port pinned to 3001:** `dev` is `PORT=3001 NODE_ENV=development tsx watch src/index.ts`, matching the Vite proxy target. Note `scripts/screenshot-configs/salesforce.json` still declares `"backendPort": 3000`, which nothing binds.
- **`dev:server2` / `dev:server3` are no-ops:** written as `PORT=3002 npm run dev`, but `dev` itself starts with `PORT=3001`, so the inner assignment wins and every variant lands on 3001. Same defect as retool and supabase-dashboard, which share this backend scaffold.
- **Stage validation lives only in the route layer:** `opportunities.stage` is a bare `VARCHAR` with no CHECK constraint, so `VALID_STAGES` in `routes/opportunities.ts` is the sole guard. Any write that bypasses the route (a seed edit, a psql session) can create a stage that silently vanishes from every report's `GROUP BY`.
- **Lead conversion guard is a read-then-write:** the `converted_at IS NULL` check inside the transaction has no `FOR UPDATE`, so simultaneous conversions of one lead can both pass. Narrow in practice — leads are single-owner — but it is a genuine race, not a guarantee.
- **2026-08-04 — screenshot coverage missed the two most distinctive screens.** The app itself was healthy (dashboard KPIs, pipeline bars, and all list views rendered real seeded data), but the config only captured dashboard/leads/accounts/contacts — not the **kanban opportunities board**, which is the headline UI and the subject of decision 4, nor the reports page that decision 5's CSS charts exist for. Both added; 5 → 7 screenshots.
- **CI:** the repo-wide smoke-test workflow was removed; a runner can't provide Postgres and Valkey for these paths. Verification is local (`npm run triage salesforce`).

## Open Questions

1. `getDashboardKPIs` runs seven aggregates sequentially on every dashboard load. `Promise.all` is the obvious fix — but does the dashboard instead want a short Redis TTL, given that a pipeline total that's 60 seconds stale is indistinguishable from a fresh one to a sales rep?
2. Reports scan the full `opportunities` and `leads` tables with `GROUP BY` on every request. At what row count does the reporting workload need to leave the transactional database — and is a read replica the answer, or precomputed rollups on a schedule?
3. The custom-field tables are designed and completely unexposed. Is EAV the right model to actually build on (queryable, but every filtered list becomes a join per custom field), or should custom fields be a JSONB column on each entity like the retool project's app documents?
4. Kanban updates are last-write-wins with no version check, so two reps dragging the same opportunity silently overwrite each other. Is optimistic locking on an `updated_at` comparison worth the "someone else changed this, reload" UX, or is the collision rate too low to justify it?
5. Nothing constrains stage *transitions* — Closed Won can move back to Prospecting and re-enter the open pipeline. Should the server enforce a state machine, or is a CRM's reality (deals genuinely do reopen) an argument for leaving it permissive and fixing the reports instead?

## Resources

- [PostgreSQL transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html) — BEGIN/COMMIT/ROLLBACK semantics behind lead conversion
- [node-postgres transactions](https://node-postgres.com/features/transactions) — why a transaction must check out a dedicated client rather than use `pool.query`
- [PostgreSQL aggregate functions and FILTER](https://www.postgresql.org/docs/current/functions-aggregate.html) — the conversion-rate and report queries
- [dnd-kit DragOverlay](https://docs.dndkit.com/api-documentation/draggable/drag-overlay) — the kanban drag pattern
- [Martin Fowler: Money pattern](https://martinfowler.com/eaaCatalog/money.html) — the integer-cents argument
