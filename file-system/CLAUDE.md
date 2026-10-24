# File System - Development with Claude

## Project Context

Practice for a **four-level online coding assessment** in which one problem grows over about 90 minutes, and the next level unlocks only when the current one's hidden tests pass. A 2026 preparation guide lists a cloud storage or file system simulation among the variants of Anthropic's assessment, although most reports describe an in-memory database. [ROADMAP.md entry 16](../ROADMAP.md#16-file-system) records the sources and how strong they are.

Everything here was written for this repository: the spec in [levels.md](./levels.md), its method names and examples, the tests, and the demo data. It reconstructs the *format* and the reported *themes* (files, queries, users with quotas, history), not any real assessment. Anthropic's candidate guidance asks that take-home and live assessments be done without AI help unless stated otherwise, so this project is practice for *before* an assessment.

The design is in [architecture.md](./architecture.md). This file records how the project was built, the choices that aren't obvious from the code, and the practice log.

## Architecture at a Glance (what actually runs)

| Piece | Where | Notes |
|-------|-------|-------|
| Worked answer, all four levels | `backend/src/fs/file-store.ts` | One file map; every change through `link`, `unlink`, `resize` |
| Level tests | `backend/src/fs/tests/level*.test.ts` | Import `createStore` from `../subject.js`, so the same files test the worked answer, PostgreSQL, and a practice attempt |
| Onsite bonus | `backend/src/fs/dedup.ts` | Staged duplicate detection; `dedup.test.ts` checks its cost |
| Practice runner | `backend/src/practice/cli.ts` | Copies one level's spec and tests at a time into `backend/practice-attempt/` |
| API | `backend/src/api/` on :3000 | Express over an `FsBackend`: `PgBackend` (default) or `MemoryBackend` |
| PostgreSQL backend | `backend/src/store/pg-backend.ts` | Primary-key placement rules, reserve-first quotas, one lock order |
| Frontend | `frontend/` on :5173 | Files (`/?path=`) and Users (`/users`) |
| PostgreSQL 16 | docker-compose, :5432 | `init.sql` via `npm run db:migrate`; demo via `npm run db:seed` |

## Practice Log

Record each timed attempt here (`npm run practice -- status` prints the splits). The useful column is the last one: what the data model had to change when the next level arrived.

| Date | Track | L1 | L2 | L3 | L4 | Total | What changed between levels |
|------|-------|----|----|----|----|-------|------------------------------|
| | | | | | | | |

## Deviations from Repository Defaults (and why)

| Repo default | Here | Why |
|--------------|------|-----|
| Session auth with Valkey | No login; the UI can act as any user | Users are quota principals in the spec. Authentication isn't what this project practices, and the admin page's purpose is to act on others' accounts |
| PostgreSQL + Valkey | PostgreSQL only | Nothing needs a cache or sessions at this scale. Production caching is in the design docs |
| Backend is a set of services | One API process plus a library | The core deliverable is a library. The service exists to show the same rules under concurrency |
| `architecture.md` + three answers | Plus `levels.md` and a practice runner | The roadmap entry asks for a different format: practice for a timed coding assessment |
| Port 5173 for the frontend | Still 5173 | `.claude/launch.json` starts it on 5180 because, during the build, another app on the machine held 5173 |

## Development Phases

1. **Spec before code.** `levels.md` first, with worked examples per level. Every example is also a test (`… the worked example in levels.md`), so the spec can't drift from the answer.
2. **Worked answer, level tests and the dedup bonus**: 86 tests, all passing on the first run.
3. **PostgreSQL backend, held to the same tests** through `subject.ts` and a spec adapter, then concurrency tests with SQL invariant checks. This phase found the deadlock design flaw (repair log 1).
4. **Practice runner**, exercised end to end: a stub fails, the next level stays locked, and the worked answer passes every level.
5. **API, seed and frontend**, verified in the browser against PostgreSQL.
6. **Benchmark**, then docs. The scaling sections cite measured numbers rather than predictions.

## Key Implementation Decisions

- **One set of level tests, three subjects.** Tests `await` every call, so they run unchanged against the synchronous worked answer, the async PostgreSQL adapter, and a learner's synchronous attempt. The time-track tests skip under PostgreSQL, which doesn't implement that track.
- **The memory backend explains failures by asking.** The spec's methods only return `null` or `false`. `MemoryBackend` finds the reason by querying the store right after a failure. That's exact because the store is synchronous and a failed call changes nothing. The worked answer stays a clean answer to the spec, with no error-code plumbing.
- **Directories are rows, and the root isn't.** A directory row carries its total and file count, so `listDir` and `dirSize` are index reads. The root has no row, so it can't be the single row every write updates; its totals are summed from its children.
- **Restores use a savepoint per file.** An unavailable path rolls back only its own partial work (ancestor upserts, quota charge), and is reported as skipped.
- **The seed tells the restore story.** alice backs up while she owns `/shared/roadmap.md`, deletes it, and bob creates his own. Restoring alice then demonstrates every rule at once: a skipped path, a deleted post-backup file, and a reverted size.
- **The dedup hint sits outside the practice markers.** The first draft of `levels.md` described the staged approach inside the practice section, which gave the answer away. It now states only the constraints, with the approach after the markers.
- **Quota refusals are 409, not 507**, because clients retry 5xx.
- **BIGINT parsed as a number once.** `pg` returns int8 as a string by default (repo bug class 7); `shared/db.ts` sets one type parser instead of converting at every call site. Sizes stay far below 2^53.

## Iteration & Repair Log

1. **Ten deadlocks per run in the mixed race test.** The first lock order was namespace rows, then the user, for add, update and delete, but merge and restore locked users first. Each deadlock cost PostgreSQL's one-second detection timeout, so the test took 3-6 s instead of 0.3 s, and it once timed out at 5 s. Fix: one order everywhere, user rows then ancestors top-down then the file. Restore also locks every directory it will touch, up front and in path order, because it interleaves deletes and inserts. Update and delete read the owner before locking and re-verify after (`lockOwnerOf` and `RetryTransaction`). Repeated runs since show zero deadlocks, and the only retries are intended lock-then-verify reruns.
2. **An invariant query that PostgreSQL rejected.** `(a, b) IS DISTINCT FROM (SELECT …, …)` isn't allowed with a subquery; rewritten as a `LATERAL` join. That was a bug in the test, not the backend.
3. **A folder vanishing cascaded navigation to the root.** After deleting a folder's last file, the page moved up correctly, but the old path's "vanished" state and its nearest-ancestor result carried over to the new path, so it kept moving up with a toast at each level. Fix: every hook result is stored with the path it belongs to, and a vanish is handled once per path.
4. **Quota messages in raw bytes** ("needs 2097152 more bytes but has 1047376 left"). Both backends now format sizes ("needs 2.0 MB more but has 1023 KB left"), and the UI shows the server's message verbatim.
5. **Disk full mid-build.** A file write failed with ENOSPC and the build paused until space was freed. Nothing was lost; the failed file was rewritten.

## Verification Environment Notes

- **Port 5173 was held by another app on this machine** (a Next.js dev server from a different repository). In `--start` mode, the screenshot harness kills whatever process holds the configured frontend port. So the harness was run *without* `--start`, against servers started from `.claude/launch.json` (API on 3000, Vite on 5180), with `frontendPort` set to 5180 for that run only. The committed config keeps 5173. Playwright smoke tests ran the same way, using a `BASE_URL` override that `playwright.config.ts` now accepts.
- **Benchmark numbers vary between runs** (about 1,900-2,200 creates/s separate, 590-770/s shared). The docs quote ranges.
- `npm run test:pg` and `npm run bench` use `file_system_test`, which they create and wipe, never the seeded `file_system` database.

## Open Questions / Next Steps

- **Idempotency keys** on writes. A retried create currently gets `409 PATH_EXISTS` for the client's own file. Doing it properly means storing the key in the write's transaction, which means threading a client through `FsBackend`.
- **Rename and move**, which would push the PostgreSQL backend from path keys toward the inode model the design describes.
- **The time track in SQL** (versioned rows), which is also the copy-on-write backup design.
- **Practice variants.** An in-memory database spec in the same four-level shape, since that's the variant most reports describe. Also a Python stub, in case the assessment is taken in Python.
- **Listing cache and virtualization** in the frontend, which the frontend answer designs but the demo's small directories don't need.
