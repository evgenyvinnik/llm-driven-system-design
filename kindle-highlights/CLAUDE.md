# Kindle Community Highlights — Development with Claude

## Project Context

A social reading platform modeled on Kindle's "Popular Highlights": readers highlight passages, sync them across devices, and see aggregated community highlights ("N readers highlighted this") without exposing who highlighted what. Three tensions make it interesting: **cross-device sync** must feel instant (<2s) over flaky mobile links, **community aggregation** must count highlights across millions of readers without a contended write on every save, and **privacy** must let people opt highlights out of the community count entirely.

**Learning goals:** a gap-free per-user change feed (sequence numbers issued under a row lock) instead of timestamps or device queues; idempotent uploads with client-generated ids; field-level last-writer-wins with tombstones and a resync horizon; a transactional outbox feeding the popular-highlights aggregate; and privacy enforced where data enters (consent) and where it leaves (a distinct-reader threshold).

## Architecture at a Glance (what actually runs)

PostgreSQL + Valkey (`docker-compose.yml`), four Express services and one worker (`backend/package.json`), and a React SPA whose Vite proxy routes each path to its owning service (`frontend/vite.config.ts`).

| Component | Port | Role |
|-----------|------|------|
| **Highlight service** | 3000 | Single-item create/edit/delete, list + `ILIKE` search, library, export |
| **Social service** | 3001 | Auth (scrypt passwords, Redis sessions, logout), follows, friends' highlights, share, privacy settings. 3001 is the `PORT` in `npm run dev` that the screenshot harness waits on |
| **Sync service** | 3002 | `GET /api/sync/changes` (cursor pull), `POST /api/sync/push` (offline outbox), WebSocket `/api/sync/ws` (pokes via per-user Redis channels) |
| **Aggregation service** | 3003 | Popular / trending / heatmap / count, all thresholded; `/health` reports outbox lag and worker heartbeat |
| **Aggregation worker** | — | Drains `aggregation_outbox` (SKIP LOCKED + per-book advisory lock), recomputes distinct readers, reconciles every 6 h, reaps tombstones after 90 days |

All writes go through `backend/src/shared/highlights.ts`; merge rules are in `shared/lww.ts`, grouping and counting in `shared/passage.ts`, the threshold in `shared/privacy.ts` (`POPULAR_MIN_READERS`, default 5). Design rationale lives in `architecture.md`; this file keeps the history.

## Current State

Runs end to end with PostgreSQL + Redis only. Implemented: highlight CRUD with client-generated ids (retries replay), a per-user change feed with cursor pull and resync, batched offline push with per-operation results, field-level LWW with clamped device clocks, tombstone deletes, WebSocket pokes across processes, the outbox-driven aggregation worker with a privacy threshold on every public endpoint, mutual-follow friends' visibility, scrypt passwords with legacy-hash upgrade, export, and the React SPA (library, book tabs, trending, export; a localStorage outbox for note edits and deletes; a sync status indicator). `npm test` runs 46 vitest tests.

Seed users: `alice@example.com`, `bob@example.com`, `charlie@example.com` and `reader01`–`reader09@example.com`, all `password123`. The seed is re-runnable and built to show the threshold: three passages publish, two stay hidden.

Not built: Kafka, sharding, sentence-anchored passages (no book text is stored, so 100-location windows are used), an IndexedDB client store, a create-highlight UI (highlights come from the API or the seed), rate limiting, metrics.

## Iteration & Repair Log

- **DB migrate/seed scripts added.** `db:migrate` runs `src/db/init.sql` and `db:seed` loads demo data. Part of the repo-wide "missing schema-apply path" repair.
- **Schema location corrected in docs.** The schema is `src/db/init.sql`, not `src/db/migrations/001_initial_schema.sql`.
- **Search description corrected.** Search is `ILIKE` substring matching; there is no Elasticsearch.
- **CLAUDE.md rewrite.** Replaced the Phase 1–4 checklist with architecture and decision rationale.
- **2026-10-10 — implementation review and documentation rewrite.**
  - *The app didn't work through the dev proxy.* `/api/highlights` and `/api/books/:id/popular` were proxied to the social service and 404ed, so `Promise.all` rejected and the library showed "No books with highlights yet" for seeded users. Every create returned 500 (the INSERT named an `idempotency_key` column that `init.sql` never had), and share returned 500 (no `highlight_shares` table). The proxy now routes by path ownership, and the code's port defaults match `npm run dev`.
  - *Sync was mostly simulated.* WebSocket `highlight_*` messages were broadcast but never stored, REST writes never reached the sync service, the per-device Redis queue was only written for sockets still in the map (so offline devices got nothing), and the `updated_at > lastSync` cursor could skip late commits. Replaced with a per-user `sync_seq` issued under a row lock, `GET /api/sync/changes` + `POST /api/sync/push`, field-level LWW, tombstone rows (`deleted_at` replaces `archived` + `deleted_highlights`), `purged_through_seq` + resync, and Redis pub/sub pokes with first-message auth and heartbeats.
  - *Popular highlights leaked and never aggregated seeded data.* `?minCount=1` lowered the threshold, heatmap/count/trending had none, the friends feed checked the owner's *default* visibility (alice's private highlight was served to charlie, a one-way follower), consent and visibility changes never left the counts, and Redis counts were highlights, not readers. Replaced with an outbox + recount worker publishing only passages with at least `POPULAR_MIN_READERS` distinct consenting readers; the API filters again. Trending now requires a recent contribution; it previously matched every passage the worker touched.
  - *Smaller fixes:* the list cache invalidated a key it never wrote (stale lists for 60 s), so it was removed; non-overlapping worker cycles (`setInterval` could overlap); `KEYS` removed; boundary validation (bad ids/JSON/limits are 4xx, not 500); graceful shutdown; CSV quoting; export errors surfaced in the UI; trending React keys made unique across books.
  - *Verified* with PostgreSQL 16 + Redis on spare ports: the schema applied twice on a fresh database and on one built from the old schema (legacy rows backfilled into the feed); the seed run twice; curl and WebSocket checks of replay/409/422, pokes, LWW merge, tombstones, purge → resync, consent recounts, 20 concurrent same-id uploads (one insert) and gap-free sequences; two workers draining 900 outbox rows with counts matching a ground-truth query.
  - *Docs:* `architecture.md` and the three interview answers rewritten around one layered overview and generated sequence diagrams.

## Open Questions

1. **Edit stamps use device wall clocks** (clamped to server time + 5 minutes). Hybrid logical clocks would stop a device with a slow clock losing same-field conflicts it should win. Worth the protocol change?
2. **The worker recomputes a whole book per batch.** Exact and idempotent, but its cost grows with a book's public highlights. When does this need the production design (Kafka + incremental reader sets), and should the recompute stay as a nightly drift check?
3. **Trending is approximate**: published passages with a contribution in the window, ranked by total readers. Readers gained per window would need time-bucketed counts in the worker.
4. **The web outbox lives in localStorage and is cleared on logout**, so offline edits pending at logout are dropped. Move to IndexedDB, and keep queued edits per account?
5. **Passage windows fragment.** "Victory Mansions" groups under `200-300`, while a longer selection ending at the same words groups under `100-300`. Sentence anchoring needs book text in the schema.

## Resources

- [Amazon Kindle Popular Highlights](https://www.amazon.com/gp/help/customer/display.html?nodeId=201630920)
- [Local-First Software](https://www.inkandswitch.com/local-first/) — offline-first and sync philosophy
- [CRDTs](https://crdt.tech/) — the conflict-resolution path we deliberately did not take
- [RFC 6455 — The WebSocket Protocol](https://tools.ietf.org/html/rfc6455)
