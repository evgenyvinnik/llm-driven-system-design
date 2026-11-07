# Settings Service — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Data model → API contract → Resolution → PATCH semantics → Deep dives → Traces → Scale*

> "The prompt: here is an existing preferences screen, design its APIs and server side. I want to say up front what I think the trap is. This is a small system. Settings change at human speed, a few hundred writes a second at most, and none of it needs Kafka or sharding on day one. What it does need is a contract with no ambiguity in it. What does a PATCH mean? What happens when my phone and my laptop write at the same time? What if the response is lost? What if a client sends a key we deleted last month? And what does the user see when their admin enforces something? So I'll keep the boxes modest and spend the time on the contract: one relational schema, four-layer resolution, per-key conditional writes, and revision-keyed sync."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Few writes, many reads, many open connections; correctness over scale |
| Data model | ~5 min | Key-value rows storing only explicit choices, with per-key revisions |
| API contract | ~8 min | Merge-patch PATCH, If-Match, exact status codes, per-field errors |
| Resolution and policy | ~4 min | enforced > user > org default > global default, with source and lock |
| Deep dives | ~14 min | Storage model, concurrency contract, propagation and lost responses |
| Traces, checklist, follow-ups | ~6 min | One success, one failure, six review questions |
| Scale and wrap-up | ~3 min | Connections and org-wide invalidations break first, not the database |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Are settings per user, per org, or both? | Decides the resolution order | Both. Users choose; orgs can default or enforce; some settings belong only to the org |
| Can the set of settings change without a deploy? | Decides catalog vs hard-coded schema | Yes. Product adds and retires settings; old app versions stay in the field for months |
| How many devices per user? | Concurrency is the core question | Typically 2-3: phone, laptop, sometimes several tabs |
| How fast must a change show up elsewhere? | Push vs poll | Other tabs at once; other devices within a couple of seconds |
| Is last-write-wins acceptable? | The heart of the contract | Not for the same key. Two different keys must both survive |
| Who manages the catalog? | Access model | A platform team; org admins only set policy for their org |

### Functional requirements

1. Read every setting as an effective value with its source and whether it is locked.
2. Write one or more settings conditionally; reset a setting to inherited.
3. Org admins set org defaults, enforce values, and lift enforcement.
4. Org-scoped settings (message retention, session timeout) are read-only to users.
5. Add a definition at runtime; deprecate one with a grace window and a replacement.
6. Validate type, enum, range, length and format; reject unknown keys per field.
7. Propagate changes to other tabs and devices; log every change.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Read availability | 99.99% | Read path has no dependency beyond the database and session store |
| Read latency | p99 < 50 ms | One indexed range scan plus a cached catalog |
| Write latency | p99 < 150 ms | One short transaction; no synchronous fan-out |
| Propagation | p99 < 2 s across devices | Push (SSE), not polling |
| Durability | No acknowledged write lost | Commit before responding; PostgreSQL is the truth |
| Correctness | Never silent last-write-wins on one key | Conditional writes with a revision |

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Users | 50M, 10M daily active | Large consumer plus business app |
| Explicit choices per user | ~5 | Most users touch a handful of settings |
| Stored rows | ~250M, ~30 GB with indexes | Sparse storage: only explicit choices |
| Reads | ~3k/s average, ~15k/s peak | App starts and focus revalidations |
| Writes | ~150/s | Human-speed toggling |
| Open SSE streams | ~3M at peak | Online devices |
| Worst fan-out | 200k refetches | Enforcing a key at the largest org |

> "These numbers tell me where not to spend effort. 150 writes a second is idle for one PostgreSQL primary. The two numbers that will hurt are 3 million open connections and the one admin click that makes 200 thousand clients refetch at once. I'll design the contract first and come back to those."

---

## 🏗️ High-Level Architecture (~3 min)

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Browser tab  │◀▶│ Browser tab  │  │ Phone app    │
│              │BC│              │  │              │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ REST + SSE      │                 │
       ▼                 ▼                 ▼
┌──────────────────────────────────────────────────┐
│          Load balancer (TLS, cookies)            │
└──────────┬──────────────────────────┬────────────┘
           ▼                          ▼
┌──────────────────────┐   ┌──────────────────────┐
│ Settings API         │   │ Settings API         │
│ resolve · validate · │   │ in-memory catalog ·  │
│ plan PATCH · SSE     │   │ SSE fan-out          │
└───┬──────────┬───────┘   └──────┬──────────┬────┘
    │          └── publish/subscribe ──┘      │
    │              ┌───────────────────┐      │
    │              │ Valkey pub/sub,   │      │
    │              │ sessions, limits  │      │
    │              └───────────────────┘      │
    ▼                                         ▼
┌──────────────────────────────────────────────────┐
│ PostgreSQL — the only source of truth            │
│ definitions · org policy · user values · log     │
└──────────────────────────────────────────────────┘
```

> "Stateless API instances, one database, one pub/sub channel. BC is BroadcastChannel between tabs of one browser. The API does three things: resolve the effective value, plan a PATCH against the current state, and fan change notifications out to open streams. Everything that must be correct lives in one PostgreSQL transaction. Everything in Valkey is either a session or a hint."

---

## 💾 Data Model (~5 min)

| Table | Key columns | Notes |
|-------|-------------|-------|
| setting_definitions | key (PK, dotted lower-case), type, scope (user or org), default_value, allowed_values, min/max, max_length, format, deprecated_at, sunset_at, replaced_by | The catalog is data. A key moves active → deprecated → retired, and is never deleted |
| org_settings | (org_id, key) PK, value (nullable), enforced, rev | rev = org policy revision of last change; null value = tombstone (policy cleared) |
| user_settings | (user_id, key) PK, value (nullable), rev, updated_at, updated_by | Only explicit choices. rev = the user's revision when this key last changed; null value = tombstone (reset) |
| users | id, org_id, role, settings_revision | settings_revision is the per-user revision counter, bumped once per changing PATCH |
| organizations | id, policy_revision | Org events and admin If-Match use it |
| catalog_state | single row: revision | Catalog events and client cache keys |
| setting_changes | scope, org, user, key, old, new, revision, actor, device label | Append-only, same transaction as the change |

> "Two choices in this table carry the whole design. First, users store only what they explicitly chose. No row means inherit. That's why a new setting needs no backfill. Second, a reset doesn't delete the row; it leaves a tombstone with its revision. Otherwise a stale device could write a key someone else just reset, and nothing would notice. Tombstones are bounded by the catalog size, so they cost nothing."

---

## 🔌 API Design (~4 min)

```
GET    /api/v1/definitions                       catalog: active + deprecated keys, catalogRevision
GET    /api/v1/me/settings                       effective doc: revision, orgRevision, catalogRevision, settings{}
PATCH  /api/v1/me/settings                       merge patch {key: value | null}; If-Match required
GET    /api/v1/me/history                        this user's change log
GET    /api/v1/events                            SSE: hello, user, org, catalog

GET    /api/v1/admin/org                         policy + member override counts (org admin)
PUT    /api/v1/admin/org/policy/:key             {value, enforced}; If-Match = org revision
DELETE /api/v1/admin/org/policy/:key             clear policy; If-Match
POST   /api/v1/admin/definitions                 add a definition (platform admin)
POST   /api/v1/admin/definitions/:key/deprecate  {graceDays, replacedBy}
```

Every read entry is `value`, `source` (enforced, user, org, default), `locked`, `lockReason`, the key's `rev`, and `userValue` when an enforcement shadows the user's own choice. The user and org always come from the session; no endpoint takes another user's id.

| PATCH status | When | Body |
|--------------|------|------|
| 200 | Applied, or nothing to change | Full effective doc, `applied`, `unchanged`, `warnings` |
| 400 | Body not a JSON object, empty, or over 100 keys | Error envelope |
| 428 | No If-Match | "send the revision you read, or * to overwrite" |
| 412 | If-Match ahead of the server (restore) | Current doc |
| 422 | Any per-field error; nothing saved | `fields[]` with key, code, message, replacedBy |
| 409 | A key changed after the client's revision; nothing saved | `conflicts[]` plus the current doc |

> "Precedence is part of the contract: 400, then 428, 412, 422, 409, 200. A malformed request learns nothing about state, so validation beats conflict. And the error envelope matters for retries: a 4xx with our envelope means the server definitely refused; anything else, including a 5xx or a proxy page, means the client doesn't know."

---

## 🧮 Effective Value Resolution (~3 min)

| Key scope | Order (first match wins) | Locked? |
|-----------|--------------------------|---------|
| user | enforced org value → user value → org default → global default | Only when enforced |
| org | org value → global default | Always |

> "Enforcement is a read-time rule, not a write. When Acme enforces read receipts, I write one org row. Alice's own choice, Off, stays in her row, and the response reports it as userValue. The UI says 'your choice is kept and applies again if the policy is lifted'. Lifting the policy is one row too, and her Off comes back with no migration. The alternative, overwriting members' values, would write 200 thousand rows for a big org and is irreversible."

**Writes to enforced keys are rejected.** A user write to an enforced key gets a per-field `LOCKED` error. Storing it silently would be harmless to the effective value, but the user would believe they had changed something. The race is benign: if the enforcement commits first, the write is rejected and the client refetches; if the write commits first, enforcement still wins at read time. Either order gives a correct effective value, so this needs no lock across the two tables.

---

## ✍️ PATCH Semantics (~5 min)

The body is a JSON merge patch over the flat key map: a value sets the user's choice, null resets it to inherited. The patch is atomic: every key applies or none does. Each key is checked in this order:

| Step | Condition | Outcome |
|------|-----------|---------|
| 1 | Not in the catalog | 422 UNKNOWN_KEY |
| 2 | Past its sunset | 422 RETIRED, with the replacement |
| 3 | Deprecated, inside grace window | Accepted and ignored, warning DEPRECATED_IGNORED |
| 4 | Org-scoped key | 422 NOT_USER_WRITABLE |
| 5 | Value fails type, enum, range, length or format | 422 with the specific code |
| 6 | Enforced by the org | 422 LOCKED |
| 7 | Stored value already equals the requested value | Unchanged (no-op) |
| 8 | This key changed after the If-Match revision | 409 conflict |
| 9 | Otherwise | Change |

> "Steps 7 and 8 are the interesting ones and I'll defend their order in the deep dive. In one sentence: the server rejects a key only if that key moved since the client's revision, and never rejects a write that changes nothing."

The transaction is short: lock the user row (`FOR UPDATE`), read org rows and user rows, plan, then bump the revision once, upsert the changed rows with the new revision, and insert change-log rows. Commit. Publish the event. Respond.

### The read path

| Step | What happens | Why |
|------|--------------|-----|
| 1 | Catalog from the instance's memory | Validation and resolution are on every request; ~200 definitions fit trivially |
| 2 | One REPEATABLE READ snapshot: user revision, org policy rows, user rows | The revision and values must come from the same instant |
| 3 | Resolve every non-retired key; flag deprecated ones | Old clients that still render a deprecated key keep working |
| 4 | Respond with ETag equal to the user revision, no-store | The ETag is what the client sends back in If-Match |

> "Step 2 is easy to get wrong. If the revision is read in one statement and the rows in another, a write can land in between. The client then stores revision 15 next to values from 14, and when the event for 15 arrives, it ignores it as already seen. That user would be stuck on a stale value until the next refetch. A snapshot read costs nothing here and closes the gap."

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: Typed columns vs a JSON document vs key-value rows

**Decision.** One row per user and key, storing only explicit choices, with a per-row revision. Values are JSONB primitives; types are enforced by the definition at write time.

**Why it works here.** Three requirements fall out of the shape. A new setting with a default is one catalog row: nobody has a row for it, so everyone resolves to the default immediately, and "chose the default" stays distinguishable from "never chose". Per-key concurrency is natural, because each row carries the revision of its last change. And the org overlay has exactly the same shape (org_settings), so resolution is a simple merge of three sparse maps over the catalog.

**Why typed columns fail.** A column per setting means a schema migration and a deploy for every new setting, which contradicts "settings change without a deploy". `ADD COLUMN … DEFAULT` is cheap in modern PostgreSQL, but then the default lives in the schema: changing it later rewrites history, and a user who explicitly picked the old default is indistinguishable from one who never chose. Concurrency is worse: one row per user means either a row version (the phone's theme change conflicts with the laptop's language change, a false conflict) or a version column per setting, which doubles the schema. Typed columns are right for five settings that never change, and wrong for a catalog.

**Why a JSON document fails.** One blob per user makes reads trivial, but every hard rule hides inside it. Whole-document versioning gives the same false conflicts. Per-key merging needs a version map inside the JSON and careful `jsonb_set` updates. A new default means backfilling millions of documents, or resolving at read time anyway, at which point you've rebuilt key-value semantics inside a blob without indexes on keys. "How many members override this key?" (the admin screen's question before enforcing) becomes a full scan.

**What I give up.** Column types don't protect me; the definition does, so validation must run on every write path (it's one pure function). A read is a range scan of ~5 rows instead of one row, which is trivial on a primary-key index. Analytics need a pivot. At 250M rows I'd hash-partition by user_id; every query is per user, so that's mechanical.

### Deep dive 2: The concurrency contract: one revision, per-key changed-at revisions, If-Match

**Decision.** Each user has one revision counter. Each stored key remembers the revision at which it last changed. The client sends the revision it last read in If-Match. The server rejects a key only if that key's revision is greater than the client's, and only if the requested value differs from what's stored. The whole patch is atomic, and a missing If-Match is 428, never an implicit overwrite.

**Why it works.** The phone and the laptop both read revision 12. The phone sets theme: theme last changed at 0, which is not after 12, so it applies at 13. The laptop sets language from its stale 12: language last changed at 5, not after 12, so it applies at 14. Both survive, which is the follow-up the interviewer will ask first. If the laptop then sets theme from its stale 12, theme changed at 13, after 12, so it gets 409 with the conflicting value, who changed it, and the current document. Nothing is saved. The client shows "changed on your phone to Dark; keep Dark or use mine". Using mine resends with revision 14, as an explicit user decision.

**Why the alternatives fail.** A whole-document ETag (standard If-Match semantics) turns every concurrent edit into a conflict: the laptop's language change would be rejected because the phone touched theme. Users would hit "someone else changed your settings" constantly, for edits that never overlapped. Client-held per-key versions would work, but every client must then track and send a version per key, including keys it never displayed, and old clients get it wrong. Plain last-write-wins is what the prompt is fishing for: the laptop's stale write silently undoes the phone's change, and the user sees their setting "flip back" with no explanation.

**Why "equal value is a no-op" comes before the conflict check.** A PATCH sets values; it never toggles. If the stored value already equals the request, the write changes nothing, whatever the revision. That makes every PATCH idempotent by construction. A retry after a lost response carries the old revision, finds its own value already stored, and returns 200 with `unchanged` instead of a false 409. No idempotency-key table needed. Two devices that independently pick the same value also don't conflict, because they agree.

**Why tombstones.** If a reset deleted the row, the key's revision would vanish. A stale device holding 12 could then write a key that was reset at 15, and the check would see "no row, revision 0" and let it through. That's the classic ABA hole in per-key versioning. The tombstone keeps revision 15, so the stale write correctly conflicts.

**What I give up.** Writes for one user serialise on the user-row lock for a few milliseconds. With 2-3 devices per user, that never contends, and different users never contend at all. And a client that wants last-write-wins must say so explicitly with `If-Match: *`. That's a feature, not a cost.

### Deep dive 3: Propagation and the lost response

**Decision.** After commit, publish one event to a Valkey pub/sub channel that every API instance subscribes to. Each instance writes it to the SSE streams allowed to see it. Events carry revisions and are hints; the database revision is the truth. Tabs of one browser also share results over BroadcastChannel.

**Event semantics.** A user event carries the new revision, the org and catalog revisions it was resolved against, and the changed keys' new entries. A client holding revision N applies the delta only if the event is N+1 with the same org and catalog revisions; ignores it if it's N or older (its own echo, or a replay); and refetches on a gap. Org events can't carry a delta, because effective values differ per member, so they're invalidations: members refetch, with jitter. On reconnect, the server's first event (hello) carries the current revisions; any difference means "you missed something, refetch". If the server's revision is lower than the client's, as after a restore from backup, the client adopts it anyway.

**Why pub/sub and not a durable stream.** Losing an event is already tolerated by design. Hello on reconnect, revalidation when a tab regains focus, and gap detection all repair it. A durable log like Kafka or Valkey Streams would add per-instance consumer offsets and retention for no correctness gain. What it would buy is propagation during a Valkey outage, and at scale I'd get that with a transactional outbox rather than a heavier broker.

**Why BroadcastChannel as well as SSE.** The tab that wrote can tell its sibling tabs instantly, without a server round trip and even if SSE is down. Each tab keeps its own SSE stream for other devices. A document from another tab is adopted only if it isn't older, and is never re-broadcast, so tabs can't ping-pong. At scale, one leader tab per browser would hold the stream; I'd add that when connection count matters.

**The lost response.** The client classifies every outcome. 2xx means applied. A 4xx with the error envelope means refused, nothing saved. Anything else (connection reset, timeout, 5xx, a gateway page) means outcome unknown. For a settings write that's the honest state: the transaction may have committed. The client marks the key "checking", refetches, and compares its own value for that key with what it sent. If they match, the write landed and we're done. If not, it didn't land, and the edit goes back through the normal write path. If someone else changed the key in the meantime, that path yields a 409 and the user decides. A blind resend would also be safe, thanks to the no-op rule, but refetching first lets the UI show the user what happened.

**What I give up.** Delivery is best-effort, so there is a window (until the next hello, focus or gap) where a device can be stale after a Valkey failure. For preferences that's acceptable; for a bank balance it wouldn't be. And the client needs a write queue: one PATCH in flight, later edits merged into the next one with the newest revision. Without it, a fast on-off toggle sends two PATCHes from the same base, and the second conflicts with the first.

---

## 🗂️ Catalog Evolution: Unknown and Obsolete Keys (~2 min)

| State | Read | Write |
|-------|------|-------|
| Active | Returned | Validated and stored |
| Deprecated (grace window) | Returned, flagged deprecated | 200, ignored, warning with replacement and sunset date |
| Retired (after sunset) | Not returned | 422 RETIRED with replacement; the name can never be reused |
| Never existed | — | 422 UNKNOWN_KEY |

> "The grace window exists because old app versions live in the field for months. Rejecting their writes the day we deprecate a key would break them; silently storing would keep a dead key alive. Accept-and-ignore with a warning keeps them working and shows up in metrics, so we can see when it's safe to sunset. After sunset, a precise 422 says which key replaced it. Each API instance caches the catalog, so a brand-new key could be unknown to one instance for a moment. On any unknown key, the instance reloads its catalog once before rejecting. Pub/sub invalidation and a 30-second TTL cover the rest."

---

## 📜 Execution Traces (~4 min)

### Successful trace: phone sets the theme, laptop picks it up on another instance

1. The phone holds revision 12 and sends a PATCH setting theme to dark, with If-Match 12, to API-A.
2. API-A's catalog knows the key. It opens a transaction and locks Alice's user row: revision 12.
3. It reads Acme's policy rows and Alice's rows, and plans: active, user-scoped, valid, not enforced, stored value light differs, theme last changed at revision 1. Result: change.
4. It sets the revision to 13, upserts the theme row with revision 13 and device label "Phone", inserts a change-log row, and commits. The write is durable now.
5. It publishes a user event (revision 13, org revision 6, catalog revision 1, theme's new entry) and returns 200 with the full document and ETag 13.
6. API-B's subscriber receives the event and writes it to Alice's laptop stream.
7. The laptop holds 12; the event is 13 with matching org and catalog revisions, so it applies the delta. The row shows "changed on Phone just now", and the tab posts the new document to its sibling tabs over BroadcastChannel.
8. The laptop now sets week start from revision 13. A different key: applied at 14.

### Failed trace: stale write, locked key, then a lost response

1. The phone was backgrounded holding 12. Meanwhile the laptop set the email digest to daily (revision 13), and Acme enforced read receipts.
2. The phone wakes and, before its stream reconnects, sends a PATCH setting the digest to off with If-Match 12.
3. API-A locks the row (13) and plans: digest last changed at 13, after 12, and the stored value differs. Conflict. Rollback. It returns 409 naming the key, both revisions, both values, and "changed on Laptop", with the current document.
4. The phone adopts revision 13 and asks Alice: keep Daily or use mine. She picks hers; the resend with If-Match 13 applies at 14.
5. A stale build sends read receipts off. It gets a 422 with key read receipts, code LOCKED. The client marks the field and refetches, because LOCKED means the policy moved under it.
6. Chaos is armed. She sets the language to German. API-A commits revision 15 and publishes, then the connection is cut. The phone gets no response, so the outcome is unknown. It refetches: revision 15, language German, source user. Reconciled. If the value hadn't been there, it would have resent; a resend of an already-applied value is a no-op 200.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | PostgreSQL. When the transaction commits: revision bump, value rows and log rows together. The event is published after, as a hint |
| Retry after a lost response? | Refetch and compare the user's own value per key. A blind resend is also safe: equal stored value means a no-op, even with a stale If-Match |
| Failure between two steps? | Before commit: nothing happened (one transaction). After commit, before publishing: only the event is lost, and hello, focus revalidation and gap detection repair it. After publishing, before responding: the lost-response path |
| Ordering actually required? | Per user only. The user-row lock serialises writes, revisions strictly increase, and events for one user arrive in order on one stream. Reads come from one REPEATABLE READ snapshot, so a revision never pairs with older values |
| Access with caches and async jobs? | Session-derived user and org on every endpoint. Each event is filtered per stream at delivery (user → that user, org → members). Events carry only the recipient's own entries or key names. The catalog cache holds public definitions only |
| What breaks first at scale? | Open connections (3M streams), then org-wide refetch storms (200k from one click). The write path is ~150/s with no cross-user contention |

---

## ❓ Follow-ups the Answer Must Handle

| Follow-up | Answer |
|-----------|--------|
| Phone and browser update different preferences at once: do both survive? | Yes. Conflicts are per key: a key is rejected only if it changed after the client's revision. Different keys from the same stale revision both apply, at consecutive revisions |
| A client submits a setting that no longer exists | Never existed: 422 UNKNOWN_KEY, per field, and nothing in that patch is saved. Deprecated and in grace: 200, ignored, with a warning naming the replacement and sunset date. Retired: 422 RETIRED with the replacement |
| How do enforced settings interact with personal ones? | Enforced beats the user's value at read time. The user's value is kept and reported as userValue, and returns when the policy is lifted. User writes to an enforced key get 422 LOCKED. An enforcement pushes an org event and open clients lock the control live |
| The update succeeds but the response is lost | The client treats anything but a 2xx or an enveloped 4xx as unknown, refetches, and checks its own value for the key. Equal: done. Not equal: resend. The resend is safe because an equal stored value is a no-op |
| How does another open tab learn about a change? | Instantly through BroadcastChannel from the tab that wrote. From other devices through SSE, keyed by revision: apply a delta on N+1, ignore stale events, refetch on a gap. On reconnect, hello compares revisions |

---

## 🔐 Access, Abuse and Admin Writes (~1 min)

| Concern | Approach |
|---------|----------|
| Whose settings? | Taken from the session, never from the URL. There is no user id to tamper with |
| Who sets policy? | Org admins, for their own org only (the org comes from the session). Platform admins own the catalog |
| Two admins editing policy | The same contract: an org policy revision, a per-key changed-at revision, If-Match on PUT and DELETE, 409 on a stale same-key edit |
| Fan-out leaks | Each event is checked per stream at delivery. A Globex member never receives an Acme org event |
| Runaway clients | 120 PATCHes per user per minute, 100 keys per patch, a 64 KB body. A settings loop that writes faster is a bug and should be told so |
| Catalog misuse | A new definition's default must pass its own rules. A retired key name can't be re-created with a different type, because old clients and stored rows still mean the old thing by it |

---

## 📊 Observability (~1 min)

| Signal | What it tells me |
|--------|------------------|
| PATCH outcomes: applied, noop, conflict, invalid, locked, precondition | A conflict rate above ~1% means clients aren't applying events before writing |
| Keys ignored as deprecated | How many old clients are still writing a key, which tells me when it's safe to sunset |
| Events published vs delivered, per instance | Publish errors mean Valkey trouble; skewed deliveries mean unbalanced connections |
| Open SSE streams per instance | The first saturation point |
| Catalog reloads by reason | Unknown-key reloads that still end in 422 mean a client is sending junk |
| Dropped responses (chaos) | Must be zero in production |

> "I log the instance id on every line, so I can follow one write from the instance that committed it to the instance that delivered its event. In this design, that's the trace you need when a user says 'my laptop didn't update'."

---

## 🚨 Failure Handling (~1 min)

| Failure | Behaviour |
|---------|-----------|
| PostgreSQL down | Reads and writes fail; clients keep their last document and show writes as not saved |
| Valkey down | Sessions fail, so requests fail authentication. Writes would still commit; only events are lost, and revalidation repairs them |
| An instance dies mid-PATCH | Before commit, rolled back; after commit, found on refetch |
| Stale catalog on one instance | Reload on unknown key, pub/sub invalidation, 30 s TTL |
| Restore from backup | 412 on writes and a lower revision in hello make clients adopt server state |

---

## 📈 What Breaks First and How It Scales (~2 min)

1. **Connections.** 3M streams at 20-50k idle streams per Node process means 60-150 processes for connections alone. Move streams to a dedicated push tier sharded by user, and use mobile push plus revalidate-on-resume for backgrounded apps.
2. **Org-wide invalidations.** One enforcement at a 200k-member org means 200k GETs. Widen the client jitter to seconds, cache effective documents keyed by user, user revision, org revision and catalog revision, and at the extreme ship org rows in the event so clients re-resolve locally.
3. **Reads.** Send ~15k/s to replicas. Replica lag is safe because clients never adopt an older revision, and the PATCH response itself gives read-your-writes.
4. **Storage.** Hash-partition user_settings by user once maintenance gets slow; partition the change log by month and expire it.
5. **Writes** come last. ~150/s, per-user locks, no cross-user transactions, so sharding by user is mechanical when it's needed.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Storage | Key-value rows, explicit choices only | Typed columns / JSON document | No backfill, per-key revisions, inherit vs explicit |
| Conflict detection | One revision in If-Match + per-key changed-at revision | Whole-doc ETag / client per-key versions | No false conflicts; one number for clients |
| Missing If-Match | 428 | Implicit last-write-wins | Never silently overwrite |
| Retry safety | Equal value = no-op, before conflict check | Idempotency-key table | PATCH sets values |
| Atomicity | All keys or none | Partial success per key | One outcome to reason about |
| Enforcement | Read-time shadowing, LOCKED on write | Overwrite member rows | Reversible, one row, honest UI |
| Deprecation | Grace window, then RETIRED | Immediate 422 | Old clients keep working |
| Deletes | Tombstones keep revision | Delete rows | No ABA |
| Fan-out | Pub/sub, events as hints | Durable stream | Revalidation tolerates loss |
| Tab sync | BroadcastChannel + per-tab SSE | SSE only | Instant, works when SSE is down |

---

## 📝 Wrap-up (~1 min)

> "The system is a schema, a pure planning function and a pub/sub channel. What makes it correct is the contract: four-layer resolution that reports its source, a PATCH that sets values atomically and conflicts per key, a precise error for every bad key, and sync that treats events as hints and the revision as truth. I'd rather walk out with that nailed down than with a diagram full of queues."

### How the local implementation compares

- **Built:** two API instances behind a Vite proxy (`/api` → A, `/api-b` → B), PostgreSQL, Valkey pub/sub and sessions. The PATCH planner and resolver are pure functions with unit tests. Catalog cache with three invalidation paths. An armed-count chaos switch that drops the next PATCH response after commit. A two-devices screen that puts one device on each instance, and a live end-to-end script covering every case above (75 checks).
- **Simplified:** session auth instead of SSO, one database without replicas, publish-after-commit instead of an outbox, SSE from the API instances instead of a push tier.
- **Omitted:** mobile push, per-device settings, automatic translation of deprecated keys to their replacements, cleanup of retired-key rows.
