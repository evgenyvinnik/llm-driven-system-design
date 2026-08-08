# Strava — Development with Claude

## Project Context

Most social apps store posts. This one stores *paths* — a run is a few thousand timestamped coordinates — and the interesting features all come from asking geometric questions about them. The hardest is segment matching: given a new activity's GPS track, which of the world's predefined segments did this athlete just ride, where in the track did each one start and end, and how long did it take? That's a curve-similarity problem answered against a table that only grows, on every single upload.

The second theme is that one write triggers a cascade. Uploading a GPX file parses it, filters it through the athlete's privacy zones, computes metrics, encodes a polyline, writes thousands of GPS rows, matches segments, updates leaderboards, checks achievements, and fans out to every follower's feed. Deciding which of those must happen before the HTTP response and which can happen after is most of the design.

**Learning goals:** two-phase geospatial matching (cheap bounding-box filter, then expensive point-wise comparison), leaderboards as Redis sorted sets, fan-out-on-write feeds, content-derived idempotency for file uploads, and privacy as a transformation applied at ingest rather than a filter applied at read.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts`) | **3001** | Single Express process; `dev:server2`/`dev:server3` on 3002/3003 for multi-instance testing |
| **PostgreSQL 16 + PostGIS** (`postgis/postgis:16-3.4`) | 5432 | Relational activity/social data plus the `gps_points` track store; the PostGIS image is used for the extension, though the matching math is currently in application code |
| **Valkey (Redis)** | 6379 | Three roles: segment leaderboards (sorted sets), per-user feeds (sorted sets, trimmed to 1000), and the `express-session` store via `connect-redis` |
| **Frontend** (Vite) | 5173 | Proxies `/api` → `localhost:3001` |

The upload pipeline is `backend/src/routes/activities/` split by concern: `upload.ts` (GPX ingest and the cascade), `simulate.ts` (synthesize an activity without a GPX file), `analysis.ts`, `get.ts`, `update.ts`, `sync.ts`. The geometry lives in `backend/src/utils/gps.ts` — `parseGPX`, `haversineDistance`, `encodePolyline`/`decodePolyline`, `calculateBoundingBox`, `applyPrivacyZones`, `calculateMetrics`. Segment logic is `backend/src/services/segmentMatcher.ts`; `services/achievements.ts` handles badge checks. Redis helpers (leaderboard, PR tracking, feed fan-out) are in `backend/src/utils/redis.ts`. Cross-cutting modules in `backend/src/shared/`: `metrics.ts`, `logger.ts`, `health.ts`, `config.ts`, `idempotency.ts`.

Frontend is React 19 + TanStack Router + Zustand + Tailwind, with Leaflet/react-leaflet for maps (`components/ActivityMap.tsx`) and the `polyline` package decoding tracks client-side.

## Key Design Decisions

### 1. Segment matching is two-phase: bounding box in SQL, then point-wise walk in Node

`matchActivityToSegments` first calls `findCandidateSegments`, a plain SQL range query against the `min_lat`/`max_lat`/`min_lng`/`max_lng` columns on `segments` (indexed as `idx_segments_bbox`), with a ~100m buffer and a filter on `activity_type`. Only the survivors get the expensive treatment: `tryMatchFromPoint` walks the activity track and the segment polyline with two pointers, advancing whichever is behind, and rejects as soon as any point deviates more than 50m (2× the 25m threshold).

Skipping phase one and running the point-wise comparison against every segment is the version that doesn't scale, and the reason is the cost asymmetry. The bounding-box test is four float comparisons on an indexed column — the database rejects a segment in Portugal against a ride in Oakland without reading the polyline at all. The point-wise walk decodes a polyline and computes Haversine distances across potentially thousands of points, which is milliseconds *per segment*. At a realistic segment count that's the difference between an upload finishing and an upload timing out, and it grows linearly with the global segment table rather than with the local one.

What we give up: bounding boxes are axis-aligned, so a long diagonal segment has a box far larger than the segment, and a diagonal ride overlaps boxes it never touches. Those false positives all pay the expensive phase. A real geospatial index (PostGIS `ST_Intersects` on a geometry column, GiST-indexed) would cut them — the extension is installed and the image is PostGIS, but the columns are plain decimals and the matching is application-side. That's the obvious next refactor and it's honest to say it hasn't happened.

### 2. Leaderboards are Redis sorted sets keyed by segment, with PRs tracked separately

`updateLeaderboard` keeps `leaderboard:{segmentId}` as a sorted set scored by elapsed time (lower is better) and `pr:{userId}:{segmentId}` as a plain key holding the athlete's best. A new effort only touches the sorted set if it beats the stored PR.

Computing this from Postgres instead — `SELECT user_id, MIN(elapsed_time) … GROUP BY user_id ORDER BY … LIMIT 10` over `segment_efforts` — is correct and gets slow in the specific way leaderboards always do: it's a sort over every effort ever recorded on a popular segment, recomputed on every page view, and the index (`idx_segment_efforts_segment`) helps the scan but not the grouping. Sorted sets make the write O(log N) and the read O(log N + k), and rank lookup — "you're 47th" — is a single `ZRANK` instead of a window function over the whole table.

The separate PR key is what makes the sorted set *correct*, not just fast. A sorted set holds one score per member, so writing every effort would overwrite an athlete's best time with their most recent one — ride the segment slowly on a recovery day and you'd lose your KOM. Checking the PR first means the leaderboard only ever moves in the right direction.

The trade-off is that Redis is now holding derived state with no rebuild path in the code. `segment_efforts` in Postgres is the durable record, so the data isn't lost, but there's no job that repopulates the sorted sets after a Redis flush — the leaderboard would just be empty until athletes set new PRs.

### 3. Feeds are fanned out on write, into capped Redis sorted sets, with a SQL fallback

On upload, `fanoutToFollowers` writes the activity ID into `feed:{followerId}` for every follower, then trims each to the newest 1000 entries. Reading a feed is a `ZREVRANGE` plus one query to hydrate the activity rows. If the Redis feed is empty, `routes/feed.ts` falls back to querying activities from followed users directly.

Fan-out on read — join `follows` to `activities`, order by time — is simpler and puts the cost on the reader. That's the wrong place here: feed reads vastly outnumber activity uploads (an athlete records a few activities a week and opens the app daily), so fan-out on read means paying the join on the frequent operation to save work on the rare one. Fan-out on write inverts it, and the trim bounds the memory: 1000 IDs per user regardless of how prolific the people they follow are.

Two costs, both real. First, write amplification — a pro athlete with 100,000 followers triggers 100,000 Redis writes on one upload, in a loop, inside the request path. Real Strava solves this with a hybrid (fan out for normal users, fan in at read time for celebrities); this doesn't. Second, the trim is time-ordered, so a burst from one heavily-active follow can push everyone else out of your feed. The SQL fallback quietly papers over both — an empty or evicted feed still renders — which is good for demo robustness and does hide the failure mode.

### 4. Privacy zones are applied at ingest, and the discarded points are never stored

`upload.ts` loads the athlete's `privacy_zones` rows and runs `applyPrivacyZones` on the parsed track *before* computing metrics, encoding the polyline, or inserting into `gps_points`. Points inside a zone radius are dropped, permanently.

The alternative is to store the full track and filter on read, which is what you'd do if privacy were a display preference. It fails as a privacy mechanism for a simple reason: the data is still there. Every future read path — the map, the segment matcher, an analysis endpoint, a CSV export, a backup, a query someone writes next year — has to remember to apply the filter, and the first one that forgets publishes the athlete's home address. Filtering at ingest means there is nothing to leak, and correctness doesn't depend on the discipline of code that doesn't exist yet.

What we give up is significant and not reversible: the athlete can't change their mind. Widening a zone later doesn't retroactively protect old activities, and *narrowing* one can't recover points that were never written. The derived metrics are also computed on the filtered track, so distance and elevation are slightly understated for activities that start or end at home — the numbers are wrong by design, and preferring that to leaking a location is the actual decision.

### 5. Upload idempotency is derived from the file's content, not from a client header

`checkIdempotency(userId, gpxContent, startTimestamp)` fingerprints the upload itself; a repeat returns the existing activity with `duplicate: true` and HTTP 200 rather than creating a second one. A client-supplied `X-Idempotency-Key` is *also* honored, but it's the secondary path.

Header-only idempotency is the standard approach and it misses this domain's actual duplicate source. The common case here isn't a network retry — it's a human. The athlete's watch syncs the ride, then they also export the GPX and upload it manually, or a device sync runs twice after a reconnect. Those are separate requests with no shared key, minutes or hours apart, and only the content reveals that they're the same ride. Since a GPX file for a given athlete and start time is effectively unique, the content *is* the natural key.

The cost is fragility to trivial differences: re-export the same ride from different software, get one extra whitespace character or a rewritten `<metadata>` block, and the fingerprint changes — you get a duplicate activity. A tolerant version would hash the point sequence rather than the file bytes.

## Current State

Runs end to end with `docker-compose up -d` (PostGIS + Valkey), then `npm run db:migrate` and `npm run seed` in `backend/`, then `npm run dev` (API on 3001). Implemented: session auth over `express-session` + `connect-redis`, GPX upload with multer, activity simulation for testing without a GPX file, privacy-zone filtering, metric computation, polyline encoding, full GPS track storage, two-phase segment matching, segment creation from an activity range, Redis leaderboards with PR detection and top-3 `pr_rank` stamping, follows/kudos/comments, fan-out feeds with SQL fallback, achievements with auto-checking against seeded criteria, per-user stats, Prometheus metrics, structured pino logging, and health/readiness routes. Frontend covers feed, activity detail with a Leaflet map, upload, explore, segments with leaderboards, profiles with followers/following, and a stats dashboard.

Seeded logins (all `password123`): `alice@example.com`, `bob@example.com`, `charlie@example.com`, `diana@example.com`, and `admin@example.com` (admin role).

Simulated or omitted: no real device integrations (Garmin/Wahoo/Apple Health) — activities come from uploaded GPX or the simulator. No WebSocket or push notifications. No photo uploads or object storage. No route planning, heatmaps, or flyby. No fraud detection, though it's the obvious use for the speed/elevation data already being computed. Segment matching runs in-process on upload rather than in a queue.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. It listed "Implement privacy zones fully" under *Remaining* and `- [ ] Implement privacy zones` under Next Steps — while `applyPrivacyZones` was already being applied to every upload in `routes/activities/upload.ts:140`, before any point was persisted. It also called Phase 3 monitoring "Not started" against a `shared/metrics.ts` full of prom-client instruments and a `httpMetricsMiddleware` wired into `index.ts`.
- **docker-compose `services:`/`volumes:` malformation (fixed by deletion):** this project had the same broken Compose file as robinhood, with a Kafka block nested under the top-level `volumes:` key. Here it was **removed rather than repaired**, because nothing in `backend/src/` imports `kafkajs` — a grep of the whole source tree returns zero hits. It was aspirational config for a queue that was never wired up. (`kafkajs` is still an unused entry in `backend/package.json` and could go too.)
- **Seed users live in TypeScript, not SQL (repo-wide harness fix):** `backend/db-seed/seed.sql` contains only the achievement definitions — no `INSERT INTO users` — because athletes, activities, and GPS tracks are generated by `backend/src/seed.ts`. The screenshot harness used to run `seed.sql` alone, report "Database seeded", and then fail login with no users in the table. `scripts/screenshots.mjs` now detects a `seed.sql` with no user inserts and runs the project's own `seed` script afterward.
- **Schema is not auto-loaded by Compose:** unlike most projects here, `docker-compose.yml` does *not* mount `init.sql` into `docker-entrypoint-initdb.d`. `npm run db:migrate` (which runs `src/migrate.ts`, not the unrelated `src/db/migrate.ts` referenced by the `db:rollback`/`db:status` scripts) is mandatory before first run.
- **Backend port pinned to 3001:** `dev` is `PORT=3001 tsx watch src/index.ts`, matching the Vite proxy. `index.ts` still defaults to 3000 without `PORT`, so launching it directly bypasses the proxy.
- **CI:** the repo-wide smoke-test workflow was removed — a runner can't provide PostGIS and Valkey. Verification is local (`npm run triage strava`).

- **2026-08-07 (simulated activities were physically impossible):** the activity cards read "3.17 km / 2:18 / 82.7 km/h" with a max speed of 97.4 km/h — for a *bike ride* — and the Leaflet map drew a straight line out across San Francisco Bay. Two bugs in `generateSampleRoute` (`utils/gps.ts`), both purely in test-data generation rather than the pipeline it feeds:
  1. **Distance per sample was a fixed number of degrees, not a speed.** A ride advanced 0.0005 degrees (~55m) every 2s, which is ~99 km/h. Replaced with a metres-per-second table per sport (ride 6.9, run 3.1, hike 1.3, walk 1.4) converted to degrees using 111,320 m/degree of latitude and the cosine-corrected value for longitude — the correction matters at San Francisco's 37.8°, where a degree of longitude is ~12% shorter.
  2. **The heading was redrawn inside a fixed north-east arc on every point**, so every route from a downtown start marched consistently offshore. The heading now drifts by a small random delta per point, producing a curving course that stays in the neighbourhood.
  - This only ever affected seeded/simulated data — `parseGPX` and `calculateMetrics` were computing correctly from whatever points they were handed. But it made every screenshot and every demo of the flagship map view obviously wrong, which is its own kind of broken.
- **Screenshots:** 3 → 7, adding the activity detail view (the Leaflet map with the GPS track, which is the project's signature visual and had never been captured), the segments list, a segment leaderboard, and the stats dashboard.
- **2026-08-07 (answer docs):** `system-design-answer-fullstack.md` was 624 lines — well over the 350–550 band — and two of its sections were **code in disguise**: "Shared Type Definitions" was a set of Zod schemas and "Shared Utilities" was a Haversine implementation plus polyline encode/decode pseudocode, each drawn inside Unicode boxes. Box-drawing characters don't stop a schema dump from being a schema dump. Rewrote both as prose plus tables built around the actual trade-offs (why `Activity` is denormalized, why the polyline is a rendering artifact that can't be queried), and added emoji headers → 548 lines. `system-design-answer-frontend.md` was 555 with no emoji headers; added them and converted the future-enhancements bullet list to a table → 542 lines. Both files renamed "Trade-offs and Alternatives" to the repo-standard "Trade-offs Summary".

## Open Questions

1. PostGIS is installed and the image is `postgis/postgis`, but coordinates are stored as `DECIMAL` columns and all geometry runs in Node. Is moving candidate selection to a GiST-indexed `geography` column with `ST_DWithin` worth it, or does the bounding-box prefilter already cut enough that the remaining cost is the point-wise walk anyway?
2. Segment matching runs synchronously inside the upload request. At what track length does the athlete notice — and is the answer a queue, or just a 202 response with the efforts appearing a moment later?
3. The 25m match threshold is a single global constant. Road cycling and trail running have very different GPS error profiles; should the threshold vary by `activity_type`, or by the segment's own recorded point density?
4. Redis holds leaderboards with no rebuild job. `segment_efforts` has the durable data — is a "rehydrate leaderboards from Postgres" command worth writing, or is an empty leaderboard after a flush an acceptable dev-only failure?
5. Fan-out has no celebrity path. At what follower count does the in-request write loop become the upload's dominant cost, and is a hybrid (fan out below a threshold, fan in above it) worth the read-path complexity here?

## Resources

- [Strava Engineering blog](https://medium.com/strava-engineering)
- [Google encoded polyline algorithm](https://developers.google.com/maps/documentation/utilities/polylinealgorithm) — the format in `activities.polyline` and `segments.polyline`
- [PostGIS reference](https://postgis.net/docs/reference.html) — `ST_DWithin`/`ST_Intersects`, the path not yet taken
- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) — leaderboards and feeds
- [Leaflet documentation](https://leafletjs.com/reference.html) — map rendering in `ActivityMap.tsx`
