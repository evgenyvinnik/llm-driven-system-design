# Settings Service — System Design Answer (Full-Stack Focus)

*Full-stack interview · 45 minutes · Requirements → Architecture → Data model → Contract → Client state → Sync → Deep dives → Traces → Scale*

> "We have a preferences screen, and the job is everything behind it: persistence, APIs, validation and sync. I'll keep the system deliberately small, because the trap here is to draw queues and shards while leaving the basic question open: what exactly happens when two devices write. My plan is one relational schema, one PATCH contract I can state as a decision table, a client that is honest about what it knows, and sync where every message carries a revision. Then I'll spend the deep dives on the three places this goes wrong in real products: the storage model when a new setting ships, concurrent writes, and lost responses."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~4 min | Few writes, many reads and connections; correctness is the product |
| Architecture and data model | ~7 min | Stateless API, PostgreSQL truth, Valkey fan-out; sparse key-value rows |
| Contract | ~7 min | Resolution with source and lock; merge-patch PATCH with per-key conflicts |
| Client | ~5 min | Server doc + pending edits, one write in flight, revision-keyed sync |
| Deep dives | ~14 min | Storage, concurrency end to end, propagation and lost responses |
| Traces, checklist, follow-ups | ~6 min | One success, one failure, six review questions |
| Scale and wrap-up | ~2 min | Connections and org-wide refetches break first |

---

## 🎯 Requirements (~4 min)

### Clarifying questions (and the answers I'll assume)

| Question | Assumption |
|----------|------------|
| User settings, org settings, or both? | Both. Orgs can set defaults, enforce values, and own a few settings outright |
| Does the list of settings change without releases? | Yes: a server-side catalog, with old clients in the field for months |
| How many devices per user? | 2-3, plus several browser tabs |
| How fast must changes propagate? | Tabs instantly; devices within ~2 s |
| Is last-write-wins acceptable? | Not for the same key; different keys must both survive |
| Save button or save-as-you-go? | Save as you go, per control |

### Functional requirements

1. Read all settings as `{value, source, locked}`, plus a revision.
2. Write one or more settings conditionally; reset to inherited.
3. Org admins set defaults, enforce and un-enforce; org-only settings are read-only to users.
4. Add definitions at runtime; deprecate with a grace window.
5. Validate per definition; reject unknown keys with per-field errors.
6. Sync to other tabs, devices and admins' changes, live.

### Non-functional requirements

| Property | Target |
|----------|--------|
| Read availability / latency | 99.99%, p99 < 50 ms |
| Write latency | p99 < 150 ms, optimistic in the UI |
| Propagation | Same frame across tabs; p99 < 2 s across devices |
| Correctness | No silent last-write-wins on one key; no "saved" shown before it is |

### Capacity

| Quantity | Estimate |
|----------|----------|
| Users / daily active | 50M / 10M |
| Stored rows (explicit choices only) | ~250M, ~30 GB |
| Reads / writes | ~15k/s peak / ~150/s |
| Open live connections | ~3M |
| Worst fan-out | 200k members refetching after one enforcement |

> "So the database is not the problem. Connections and one-click fan-out are. I'll design the contract first."

---

## 🏗️ Architecture (~3 min)

```
┌────────────┐◀─BroadcastChannel─▶┌────────────┐    ┌────────────┐
│ Tab A      │                    │ Tab B      │    │ Phone      │
└─────┬──────┘                    └─────┬──────┘    └─────┬──────┘
      │ REST (PATCH, GET) + SSE         │                 │
      ▼                                 ▼                 ▼
┌──────────────────────────────────────────────────────────────┐
│                     Load balancer                            │
└───────────────┬──────────────────────────────┬───────────────┘
                ▼                              ▼
       ┌─────────────────┐            ┌─────────────────┐
       │ Settings API A  │            │ Settings API B  │
       │ resolve, plan,  │            │ catalog cache,  │
       │ validate, SSE   │            │ SSE fan-out     │
       └──┬──────────┬───┘            └───┬─────────┬───┘
          │          └──▶ Valkey pub/sub ◀┘         │
          │               sessions, limits          │
          ▼                                          ▼
       ┌──────────────────────────────────────────────────┐
       │ PostgreSQL: definitions · org policy · user      │
       │ values · revisions · change log                  │
       └──────────────────────────────────────────────────┘
```

> "Every API instance is identical. A write commits in PostgreSQL, then publishes one event. Every instance subscribes and writes the event to the streams allowed to see it. That's how a write on A reaches the phone whose stream is on B."

---

## 💾 Data Model (~4 min)

| Table | Key columns | Notes |
|-------|-------------|-------|
| setting_definitions | key, type, scope (user/org), default, allowed values, range, length, format, deprecated_at, sunset_at, replaced_by | Catalog as data; never deleted |
| org_settings | (org, key), value, enforced, rev | Null value = tombstone (cleared policy) |
| user_settings | (user, key), value, rev, updated_by | Only explicit choices; null value = tombstone (reset) |
| users | settings_revision | Per-user revision counter |
| organizations / catalog_state | policy_revision / revision | Org and catalog revisions |
| setting_changes | who, device, key, old, new, revision | Append-only, same transaction |

> "Each row's rev is the revision at which it last changed. That's what lets two devices write different keys without conflicting. Tombstones keep that revision across a reset."

---

## 🔌 The Contract (~7 min)

### Endpoints

```
GET    /api/v1/definitions                    catalog + catalogRevision
GET    /api/v1/me/settings                    {revision, orgRevision, catalogRevision, settings{}}, ETag = revision
PATCH  /api/v1/me/settings                    merge patch {key: value | null}, If-Match required
GET    /api/v1/events                         SSE: hello, user, org, catalog
GET    /api/v1/admin/org                      policy + member override counts
PUT    /api/v1/admin/org/policy/:key          {value, enforced}, If-Match = org revision
DELETE /api/v1/admin/org/policy/:key          clear policy
POST   /api/v1/admin/definitions              add definition
POST   /api/v1/admin/definitions/:key/deprecate {graceDays, replacedBy}
```

### Resolution

| Key scope | Precedence | Locked |
|-----------|------------|--------|
| user | enforced org value → user value → org default → global default | when enforced |
| org | org value → global default | always |

When enforcement shadows a user's own choice, the response includes it as userValue. The UI says "your choice is kept and applies again if the policy is lifted", and lifting it is one row, with no migration.

### PATCH, per key, in order

| Step | Condition | Result |
|------|-----------|--------|
| 1-2 | Unknown key / retired key | 422 UNKNOWN_KEY / RETIRED |
| 3 | Deprecated, in grace window | Accepted, ignored, warning |
| 4-6 | Org-only / invalid value / enforced | 422 NOT_USER_WRITABLE / type code / LOCKED |
| 7 | Stored value already equals request | No-op |
| 8 | Key changed after If-Match revision | 409 with conflicts + current doc |
| 9 | Otherwise | Applied: one revision bump for the whole patch |

The whole patch is atomic. Precedence: 400 → 428 (no If-Match) → 412 (If-Match ahead) → 422 → 409 → 200.

> "The rule in one line: the server rejects a key only if *that key* changed since the client's revision, and never rejects a write that changes nothing. The first half lets a phone and a laptop edit different settings from the same stale revision. The second half makes a retry after a lost response a no-op instead of a false conflict."

---

## 🖥️ The Client (~5 min)

| Piece | Responsibility |
|-------|----------------|
| Server document | Last document from the server; replaced only by one that isn't older |
| Pending edits | key → value + status (queued, saving, unknown, conflict, error); display = pending ?? server |
| Write queue | One PATCH in flight; edits made meanwhile merged into the next, with the newest revision |
| Live sync | SSE events judged by revision; BroadcastChannel to sibling tabs; refetch on focus |
| Controls | Rendered from definitions: switch, select, slider, number, time, time zone, text; each commits a complete value |

| Server answer | Client state | UI |
|---------------|--------------|----|
| 200 | cleared | "Your choice", new revision in the sync pill |
| 409 | conflict | "Changed on Phone to Daily after you loaded r12. Keep Daily / Use mine" |
| 422 | error | Inline field error; LOCKED also triggers a refetch |
| No response / 5xx | unknown | "Response lost. Checking the server…" → refetch → reconcile |

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: Storage, and what happens when a new setting ships

**Decision.** Key-value rows, one per user and key, storing only explicit choices, each with its changed-at revision.

**Why it works.** Shipping a new setting is one catalog row and a catalog revision bump. No user has a row for it, so everyone resolves to the default on the next read, and open clients learn about it from a catalog event. There's no backfill and no deploy, and "explicitly chose the default" stays different from "never chose". Per-key revisions come with the rows, and org policy has the same shape, so resolution merges three sparse maps.

**Why typed columns fail.** One column per setting turns every new setting into a schema migration and a release, the opposite of a runtime catalog. A column default can't tell "chose" from "inherited", so you can't later change a default for the people who never chose. One row per user means one row version: the phone's theme write and the laptop's language write conflict for no reason, unless you add a version column per setting.

**Why a JSON document fails.** Reads are one row, but every rule moves inside the blob: per-key versions in a nested map, careful partial updates, and a backfill or a read-time merge for every new default. The admin's "how many members override this?" becomes a scan of every document.

**What I give up.** The database doesn't type-check values; the definition does, on every write path. A read is a ~5-row range scan instead of one row. Analytics need a pivot. At 250M rows I'd hash-partition by user, which is mechanical because every query is per user.

### Deep dive 2: Concurrency, end to end

**Decision.** On the server: one revision per user, a changed-at revision per key, If-Match carrying the client's revision, per-key conflict detection, the equal-value no-op, atomic patches, and 428 on a missing If-Match. On the client: one PATCH in flight, later edits merged, conflicts shown with "keep theirs / use mine".

**Why it works.** Phone and laptop both hold revision 12. The phone writes the theme (last changed at 0): applied at 13. The laptop writes the language from 12 (last changed at 5): applied at 14. Both survive. If the laptop then writes the theme from 12, the theme changed at 13, so it gets a 409 with the value that won, who changed it, and the current document. Nothing is saved, and the user decides. On the client, the queue stops the user from conflicting with themselves. Without it, a quick on-off toggle sends two writes from revision 12, and the second gets a 409 against the first.

**Why the alternatives fail.** A whole-document ETag makes every overlapping session a conflict, even for unrelated settings, and users learn to ignore the dialog. Last-write-wins silently reverts the phone's change when a stale laptop writes, and the user sees a setting "flip back" with no explanation. That's the bug this prompt is about. Client-held per-key versions work, but every client must track a version for every key, including keys it never showed. One revision does both change detection and conflict detection.

**What I give up.** Writes per user serialise on a row lock for milliseconds, which never contends at 2-3 devices. Clients that want last-write-wins must ask for it explicitly with `If-Match: *`.

### Deep dive 3: Propagation and the lost response

**Decision.** Publish after commit to Valkey pub/sub; every instance fans out to its streams with per-stream access checks. Events carry revisions. User events carry the changed entries (a delta); org and catalog events are invalidations. On every connect the stream starts with hello and the current revisions. Tabs also share documents over BroadcastChannel. Responses are classified as success, refused (a 4xx with our envelope) or outcome unknown (anything else).

**Why it works.** A client holding N applies a user event at N+1, if it was resolved against the same org and catalog revisions, with zero requests. It ignores anything at or below N (including the echo of its own write, which often beats the PATCH response). Anything else is a gap, and a gap means refetch. Dropped events, dropped connections and sleeping laptops all reduce to that one action. Org events can't carry deltas because each member's effective value differs, so members refetch with jitter. The lost response is handled the same way: the client doesn't guess. It shows "checking", refetches, and compares its own value for each key it sent. If it matches, the write landed. If not, it resends, which is safe because PATCH sets values and an equal value is a no-op.

**Why the alternatives fail.** Polling every couple of seconds would make "nothing changed" responses the service's dominant load, and still needs revision logic. A durable event log adds offsets and retention to protect events that revalidation already repairs. Rolling back on a network error reverts a change that probably saved. A blind retry without the no-op rule would turn every lost response into a false conflict.

**What I give up.** Delivery is best-effort: after a Valkey hiccup, a device can be stale until its next hello, focus or gap. That's fine for preferences. I'd add a transactional outbox at scale to shorten that window, not to make it correct. And each tab holds a stream until I add leader-tab election.

---

## 🗂️ Unknown, Deprecated and Retired Keys (~1 min)

| Key state | Read | Write |
|-----------|------|-------|
| Never existed | — | 422 UNKNOWN_KEY, per field; nothing in the patch saved |
| Deprecated, in grace | Returned, flagged | 200, ignored, warning with replacement and sunset |
| Retired | Not returned | 422 RETIRED with replacement; name never reused |

> "Each instance caches the catalog. To never reject a key that was created a second ago on another instance, an unknown key forces one catalog reload before the 422. A catalog event and a 30-second TTL handle the rest."

---

## 📜 Execution Traces (~4 min)

### Successful trace

1. On the phone, Alice switches Theme to Dark. The control and the app shell change at once; the row says Saving. The queue sends a PATCH with theme dark and If-Match 12 to API-A.
2. API-A locks her user row (12), loads org and user rows, plans: valid, not enforced, different value, theme last changed at 1. Change.
3. It bumps to 13, upserts the theme row at 13 labelled Phone, logs the change, commits, publishes the user event (13, org 6, catalog 1, theme entry), and responds 200 with the full document.
4. The phone adopts 13 and clears the pending edit.
5. API-B delivers the event to the laptop's stream. The laptop holds 12, so it applies the delta. The row flashes "changed on Phone just now", the page turns dark, and the tab posts the document to its sibling tabs.

### Failed trace

1. The laptop has been asleep at 12 while the phone set the email digest to Daily (13). Alice sets the digest to Off on the laptop; it sends If-Match 12.
2. The digest changed at 13, after 12, and the value differs: 409 with the conflict and the current document. Nothing is saved.
3. The laptop adopts 13 and shows "Changed on Phone to Daily after you loaded r12. Keep Daily / Use mine: Off". She picks hers. The resend with If-Match 13 applies at 14, and the phone applies the delta.
4. Acme has enforced read receipts. An old build sends read receipts off and gets 422 LOCKED. The client refetches and the control locks with "Enforced by Acme".
5. The next write's response is dropped after commit (revision 15). The laptop sees no envelope, so the outcome is unknown. It refetches, finds its value at 15, and marks the edit reconciled.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | PostgreSQL commit: revision bump, value rows and log row in one transaction. The client shows saved only after a 2xx, or after a refetch proves it |
| Retry after a lost response? | Refetch and compare the own value per key; resend what didn't land. Safe because PATCH sets values and equal means no-op |
| Failure between two steps? | Before commit: nothing. After commit, before publish: only the event is lost, repaired by hello, focus or gap. After publish, before response: the lost-response path |
| Required ordering? | Per user, by revision: writes serialised by the row lock, reads from one snapshot, clients never adopt older documents |
| Access with caches and fan-out? | Session-scoped endpoints, per-stream filtering at delivery, events carrying only the recipient's own entries, a public-only catalog cache |
| What breaks first? | 3M open streams, then 200k-member refetch storms. Not the ~150 writes/s |

---

## ❓ Follow-ups the Answer Must Handle

| Follow-up | Answer |
|-----------|--------|
| Phone and browser update different preferences at once | Both survive: conflicts are per key, so both apply at consecutive revisions, and each device applies the other's delta |
| A client submits a setting that no longer exists | 422 UNKNOWN_KEY per field (atomic, nothing saved). Deprecated in grace: 200, ignored, with a warning. Retired: 422 RETIRED with the replacement |
| Admin-enforced settings vs personal preferences | Enforced wins at read time; the personal value is kept as userValue and returns when lifted. User writes get LOCKED. Open screens lock live via an org event |
| The update succeeded but the response was lost | Outcome unknown: refetch, reconcile per key, resend if needed. Never "saved" early, never rolled back |
| How does another open tab learn about a change? | BroadcastChannel from the writing tab, instantly; SSE keyed by revision for other devices; a refetch on focus as the safety net |

---

## 📖 The Read Path and Policy UX (~2 min)

| Step | Server | Client |
|------|--------|--------|
| 1 | Catalog from instance memory | Fetch definitions and settings in parallel |
| 2 | User revision, org rows and user rows from one REPEATABLE READ snapshot | Render rows from definitions, grouped by category |
| 3 | Resolve each non-retired key; flag deprecated keys | Badge per source; lock and explanation for enforced and org-only keys |
| 4 | ETag = user revision, no-store | Store the revision for the next If-Match; open the stream |

> "The snapshot in step 2 isn't pedantry. If the revision and the values came from different moments, a client could hold revision 15 with values from 14, then ignore event 15 as already seen, and stay stale until the next refetch."

| Row source | What the user sees |
|------------|--------------------|
| Your choice | "Changed on Phone 2 min ago", reset button |
| Org default | "Acme default" |
| Enforced | Lock, "Acme requires this. Your own choice (Off) is kept and applies again if the policy is lifted." |
| Org-only | Lock, "Only Acme administrators can change this." |
| Deprecated | Disabled, "retires 26 Nov" |

---

## 🔐 Security, Observability and Failure Handling (~2 min)

| Concern | Approach |
|---------|----------|
| Whose data | User and org from the session on every endpoint; no ids in URLs |
| Admin scope | Org admins edit only their org's policy; platform admins own the catalog |
| Two admins editing | Org revision in If-Match; a stale same-key edit gets 409 |
| Stream leaks | Each event filtered per stream at delivery; a Globex member never sees an Acme event |
| Runaway clients | 120 PATCHes per user per minute, 100 keys per patch, a 64 KB body |

| Metric | Why |
|--------|-----|
| PATCH outcomes (applied, noop, conflict, invalid, locked) | A rising conflict rate means clients aren't applying events |
| Keys ignored as deprecated | When it's safe to sunset a key |
| Events published vs delivered per instance | Valkey health, fan-out balance |
| Open SSE streams | The first saturation point |

| Failure | Behaviour |
|---------|-----------|
| PostgreSQL down | Reads and writes fail; clients keep their last document; edits show "not saved" |
| Valkey down | Sessions fail; writes that do commit lose only their event, and revalidation repairs it |
| Instance dies mid-PATCH | Before commit, rolled back; after commit, found by the client's refetch |
| Restore from backup | 412 on writes, a lower revision in hello; clients adopt the server's state |

---

## 🧪 How I'd Prove the Contract (~1 min)

| Layer | What gets tested | How |
|-------|------------------|-----|
| PATCH planner | Every row of the decision table: unknown, retired, deprecated, org-only, invalid, locked, no-op, conflict, tombstone ABA | Pure-function unit tests, no database |
| Resolution | Every source combination, shadowed userValue, a new definition for an existing user | Pure-function unit tests |
| Client sync rules | Response classification, apply/ignore/refetch on events, hello after a restore, reconciliation | Pure-function unit tests, no browser |
| Whole system | Different keys from one stale revision, same-key 409, LOCKED, new definition on the other instance, lost response, SSE across instances | A live script against two running instances |
| Lost response | Exactly one dropped response after commit | An armed-count chaos switch, not a failure rate |

> "Putting the contract in pure functions is the cheapest way to make it reviewable. The decision table in this answer is the same table the tests walk through."

---

## 📈 Scale (~2 min)

1. **Connections** (3M): move streams to a push tier sharded by user; one leader tab per browser; mobile push plus revalidate-on-resume.
2. **Org-wide refetches** (200k): wider jitter, effective-document caching keyed by user, user revision, org revision and catalog revision, or org rows in the event so clients re-resolve.
3. **Reads** (~15k/s): read replicas. Safe because clients never adopt an older revision, and the PATCH response gives read-your-writes.
4. **Storage**: partition user_settings by user and the change log by month.
5. **Writes** (~150/s): last to matter; sharding by user is mechanical.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Storage | Sparse key-value rows | Typed columns / JSON doc | No backfill; per-key revisions |
| Conflicts | Per-key against one If-Match revision | Whole-doc ETag / last-write-wins | No false conflicts, no silent reverts |
| Retries | Equal value = no-op | Idempotency keys | PATCH sets values |
| Enforcement | Read-time shadowing + LOCKED | Overwrite member values | Reversible, one row |
| Deprecation | Grace window → RETIRED | Immediate rejection | Old clients keep working |
| Client state | Server doc + pending map | Mutate-in-place + rollback | Truth kept for conflicts and reconciliation |
| Client writes | One in flight, merged | Request per change | Never conflicts with itself |
| Live updates | SSE + revisions; deltas for user events | Polling / always refetch | Zero-request common case |
| Tabs | BroadcastChannel | Server round trip | Instant, works when SSE is down |
| Fan-out | Pub/sub, events as hints | Durable log | Revalidation repairs loss |

---

## 📝 Wrap-up (~1 min)

> "The architecture is deliberately boring: stateless API, PostgreSQL, a pub/sub channel. The design is in the contract. Four-layer resolution that says where a value came from. A PATCH that sets values atomically and conflicts per key. Exact errors for every bad key. A client that keeps server truth separate from pending intent. And revisions on every message, so every sync failure reduces to 'refetch'."

### How the local implementation compares

- **Built:** two API instances (`/api` → A, `/api-b` → B behind the Vite proxy), PostgreSQL, Valkey pub/sub and sessions. A pure PATCH planner and resolver with unit tests. A catalog cache with three invalidation paths. An armed-count chaos switch that drops the next PATCH response after commit. A React preferences screen rendered from the catalog, a two-devices view with one device per instance, org policy and catalog consoles, and a 75-check live end-to-end script.
- **Simplified:** session auth, one database, publish-after-commit, streams served by the API, one stream per tab.
- **Omitted:** mobile push, per-device settings, automatic mapping of deprecated keys to their replacements.
