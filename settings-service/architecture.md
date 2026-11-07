# Settings Service - Architecture

## System Overview

An application already has a preferences screen: notifications, appearance, privacy, language and time zone. This system is the server side behind it: where values are stored, how the effective value is decided when an organization has a policy, what a PATCH means exactly, how bad input is rejected, and how every open tab and device learns about a change.

The system is deliberately small. Its value is a precise contract, not a distributed architecture. The candidate report this project is based on (OpenAI: "here is a preferences UI, design its APIs and server side") is a trap for overengineering. A clear relational schema and an exact answer to "what happens when two devices write at once" matter more than queues and shards.

**Learning goals**

- Resolve an effective value from four layers (enforced org value, user value, org default, global default) and return where it came from and whether it is locked.
- Define per-key PATCH semantics: different keys from two devices both succeed, a stale write to the same key gets `409` with the current state, and a retry after a lost response is safe.
- Validate against a runtime catalog, reject unknown keys with per-field errors, and run a deprecation grace window.
- Keep tabs and devices in sync with BroadcastChannel and revision-keyed SSE invalidations across several API instances.
- Defend a storage model (typed columns vs a JSON document vs key-value rows), including what happens when a new setting ships.

## Requirements

### Functional Requirements

1. **Read settings.** `GET /me/settings` returns every setting the client should know, each as `{ value, source, locked }`, plus the user's revision.
2. **Write settings.** `PATCH /me/settings` sets one or more keys. `null` resets a key to its inherited value. Writes are conditional on the revision the client last read.
3. **Org policy.** An org admin sets an org default for a key, or enforces a value. Enforcement locks the key for every member, live.
4. **Org-scoped settings.** Some settings (message retention, session timeout) belong to the org. Users see them read-only.
5. **Catalog.** A platform admin adds a definition at runtime (key, type, rules, default, scope) and deprecates one with a grace window and an optional replacement.
6. **Validation.** Type, enum membership, integer range, string length and format (24-hour time, IANA time zone). Unknown keys are rejected per field.
7. **Sync.** Another tab of the same browser updates instantly. Another device updates within a second. A change by an admin reaches every affected member.
8. **History.** Every change is logged with who, which device, old and new value, and the revision.

### Non-Functional Requirements

| Property | Target | Why |
|----------|--------|-----|
| Availability (reads) | 99.99% | The app reads settings at launch; a failed read blocks rendering |
| Availability (writes) | 99.9% | A failed write can be retried; the UI shows "not saved" |
| Read latency | p99 < 50 ms | On the critical path of app start |
| Write latency | p99 < 150 ms | Interactive toggles; optimistic UI hides most of it |
| Propagation | p99 < 2 s to other devices; instant across tabs | Users test it by holding two devices side by side |
| Durability | No acknowledged write lost | A setting that "comes back" destroys trust |
| Correctness | No silent last-write-wins on the same key | The trap this design exists to avoid |

## Capacity Estimation

### Production Scale (assumptions)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Users | 50M, 10M daily active | A large consumer and business app |
| Organizations | 1M; the largest has 200k members | Business tier |
| Definitions | ~200 | Settings catalogs stay small; 20 per screen |
| Explicit choices per user | ~5 on average | Most users change little; sparse storage pays off |
| User rows | ~250M rows, ~30 GB with indexes | 5 per user × 50M; ~120 B per row |
| Reads | ~3k/s average, ~15k/s peak | 10M DAU × ~25 app opens and focus revalidations per day |
| Writes | ~150/s average | Settings change at human speed: ~1.3 per DAU per day |
| Open SSE connections | ~3M at peak | Concurrently online devices |
| Largest fan-out | 200k refetches from one enforcement | An admin enforcing a key at the largest org |

> The interesting numbers are not throughput. 150 writes a second is nothing for PostgreSQL. What matters is (a) 3 million long-lived connections, and (b) one admin click that makes 200k clients refetch at once.

### Local Development Scale

Two API instances, one PostgreSQL, one Valkey, two organizations, seven users and 21 definitions (19 active, one deprecated in its grace window, one retired). Every component fits in a few hundred MB.

## High-Level Architecture

```
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ Browser tab 1 │ │ Browser tab 2 │ │  Phone app    │
│ (settings UI) │ │               │ │               │
└──────┬────────┘ └──────┬────────┘ └──────┬────────┘
       │ BroadcastChannel│                 │
       │◀───────────────▶│                 │
       │ REST + SSE      │ REST + SSE      │ REST + SSE
       ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────┐
│            Load balancer / API gateway              │
│   (TLS, session cookie, sticky only for SSE)        │
└───────────┬──────────────────────────┬──────────────┘
            ▼                          ▼
┌───────────────────────┐  ┌───────────────────────┐
│  Settings API (N)     │  │  Settings API (N)     │
│  · resolve effective  │  │  · in-memory catalog  │
│  · PATCH planner      │  │  · SSE fan-out        │
│  · validation         │  │                       │
└───┬───────────┬───────┘  └───────┬───────────┬───┘
    │           │  publish /        │           │
    │           │  subscribe        │           │
    │           ▼                   ▼           │
    │     ┌──────────────────────────────┐      │
    │     │ Valkey: pub/sub "events",    │      │
    │     │ sessions, rate limits        │      │
    │     └──────────────────────────────┘      │
    ▼                                           ▼
┌─────────────────────────────────────────────────────┐
│ PostgreSQL (source of truth)                        │
│ setting_definitions · org_settings · user_settings  │
│ users.settings_revision · setting_changes (log)     │
└─────────────────────────────────────────────────────┘
```

At production scale the SSE connections move to a dedicated connection tier and PostgreSQL gets read replicas (see Scalability). The write path stays one primary.

## Core Components

### 1. Effective-value resolution

One rule per key, applied on every read:

```
org-scoped key:   org value                        → source "org",      locked
                  otherwise global default         → source "default",  locked
user-scoped key:  org value with enforced = true   → source "enforced", locked (userValue = the user's own choice, if any)
                  otherwise the user's value       → source "user"
                  otherwise the org default        → source "org"
                  otherwise the global default     → source "default"
```

A shadowed user value is **kept**, not overwritten. Enforcement is a read-time rule, so lifting the policy brings the user's choice back with no migration. The response says so (`userValue`), and the UI tells the user ("your own choice is kept and applies again if the policy is lifted").

Every response entry looks like this:

```json
"privacy.read_receipts": {
  "value": true, "source": "enforced", "locked": true, "lockReason": "enforced",
  "rev": 3, "userValue": false, "updatedAt": "2026-10-25T12:17:18Z", "updatedBy": "Laptop (web)"
}
```

Code: `backend/src/domain/resolve.ts` (pure, unit-tested).

### 2. The PATCH contract

`PATCH /api/v1/me/settings` with `If-Match: "<revision>"` and a JSON merge patch body (RFC 7396 over the flat key map):

```json
{ "appearance.theme": "dark", "regional.language": null }
```

A value sets the user's choice. `null` clears it (back to inherited). The patch is **atomic**: every key applies or none does. Each key goes through these steps in order:

| Step | Condition | Result |
|------|-----------|--------|
| 1 | Key not in the catalog | 422 `UNKNOWN_KEY` |
| 2 | Key past its sunset | 422 `RETIRED` (with `replacedBy`) |
| 3 | Key deprecated, inside grace window | accepted and ignored, warning `DEPRECATED_IGNORED` |
| 4 | Org-scoped key | 422 `NOT_USER_WRITABLE` |
| 5 | Value fails the definition | 422 `INVALID_TYPE` / `NOT_ALLOWED` / `OUT_OF_RANGE` / `TOO_LONG` / `INVALID_FORMAT` |
| 6 | Org enforces the key | 422 `LOCKED` |
| 7 | Stored user value already equals the requested value | unchanged (no-op) |
| 8 | Key's last change revision > If-Match revision | 409 conflict |
| 9 | Otherwise | change |

Validation errors are collected for every key, not just the first, and they win over conflicts: a malformed request learns nothing about state. Then 409 wins over success. Precedence overall: `400` malformed body → `428` no If-Match → `412` If-Match ahead of the server → `422` → `409` → `200`.

**Why step 8 compares a key's revision, not the document's.** Each user has one revision counter, bumped once per PATCH that changes anything. Each stored key remembers the revision at which it last changed. The client sends the document revision it last read. The server rejects a key only if *that key* changed after the client's base:

```
user revision 12; phone and laptop both hold r12
phone:  PATCH {theme: dark}      If-Match "12"  → theme.rev 0 ≤ 12   → applied, r13 (theme.rev = 13)
laptop: PATCH {language: de-DE}  If-Match "12"  → language.rev 5 ≤ 12 → applied, r14   (different key: both survive)
laptop: PATCH {theme: light}     If-Match "12"  → theme.rev 13 > 12   → 409, nothing saved
```

A whole-document ETag would turn the second case into a false conflict. Per-key versions sent by the client would work too, but a client then has to track a version per key. One revision does both jobs: change detection ("has anything changed since r12?") and per-key conflict detection.

**Why step 7 comes before step 8.** A PATCH *sets* values; it never toggles. If the stored value already equals the request, nothing would change, whatever the revision. This is what makes a retry after a lost response safe: the retry carries the old If-Match, the key's revision is now newer, but the value is already there, so it is a no-op `200` instead of a false `409`. It also means two devices that independently pick the same value don't conflict.

The 409 response carries everything the client needs to resolve it without another round trip:

```json
{ "error": { "code": "CONFLICT", "message": "...",
  "conflicts": [{ "key": "appearance.theme", "baseRevision": 12, "changedAtRevision": 13,
                  "yourValue": "light", "currentValue": "dark", "changedBy": "Phone (iOS app)" }],
  "current": { "revision": 14, "orgRevision": 6, "catalogRevision": 1, "settings": { "...": "..." } } } }
```

The UI shows "Changed on Phone to Dark after this screen loaded r12. Keep Dark / Use mine". "Use mine" resends with the fresh revision. That's an explicit user decision, never automatic.

Code: `backend/src/domain/patch.ts` (pure, 20 unit tests), `backend/src/services/settings-service.ts` (transaction).

### 3. Validation, unknown keys and the deprecation lifecycle

The catalog (`setting_definitions`) is data, not code. Each definition has a type, rules and a default. A key moves through three states:

```
active ──deprecate(graceDays, replacedBy)──▶ deprecated ──sunset_at passes──▶ retired
         writes validated and stored           writes accepted, ignored,        writes → 422 RETIRED
                                               200 + warning                    not returned on read
```

- **Unknown key** → 422 with one entry per bad key. An old client that sends a key the server never had gets a precise answer, not a silent drop.
- **Deprecated key inside its grace window** → accepted and ignored with a warning naming the replacement and the sunset date. Old app versions in the field keep working without errors, and the warning shows up in client telemetry. Reads still return the key, flagged `deprecated`, so old clients that render it don't break.
- **Retired key** → 422 `RETIRED` with `replacedBy`. The name is never reused (`KEY_RETIRED` on create). An old client may still send it, and existing rows still hold its old meaning.
- **New definition** → one row and a catalog revision bump. **No user rows are written.** Users store only explicit choices, so every existing user resolves to the new default immediately.

Each API instance caches the catalog in memory. Three things keep the cache honest: a `catalog` pub/sub event invalidates it on every instance, a 30-second TTL bounds staleness if that event is lost, and an unknown key forces one reload before the request is rejected. The last one means a definition created a moment ago on another instance is never refused with `UNKNOWN_KEY`.

### 4. Sync across tabs and devices

```
          PATCH (tab 1) ──▶ API-A ──commit──▶ PostgreSQL
                │                 │
                │                 └─publish {user, r15, changes}──▶ Valkey "events"
                │                                                   │         │
   BroadcastChannel                                            API-A sub  API-B sub
   {doc r15} to tab 2                                              │         │
   (instant, no server)                         SSE to this user's streams on each instance
                                                                   ▼         ▼
                                                     tab 1, tab 2 (ignore: r15 ≤ held)   phone (r14 → apply delta)
```

Three event types, each carrying the revision it describes:

| Event | Audience | Payload | Client rule |
|-------|----------|---------|-------------|
| `user` | that user's streams | new revision, org and catalog revisions used, changed keys' new entries | `r ≤ held` → ignore; `r = held+1` and same org/catalog revision → apply delta; otherwise → refetch |
| `org` | members of that org | org revision, keys | newer → refetch (with 0-400 ms jitter) |
| `catalog` | everyone | catalog revision, keys | newer → refetch definitions and settings |
| `hello` | the new stream | current user, org and catalog revisions | any difference → refetch; server behind client (restore) → refetch and adopt anyway |

User events carry a delta because the common case (my other device changed one key) shouldn't cost a GET. Org events can't carry a delta: effective values differ per member, so they are invalidations. Every event is a hint. The revision is the truth, and the client revalidates on reconnect (`hello`) and when a tab becomes visible.

**BroadcastChannel and SSE together.** The tab that wrote posts the new document to its sibling tabs at once. That works even if SSE is down, and costs no server work. Each tab still has its own SSE stream, for changes from other devices. A document is adopted only if its revisions are not older than the one held, and a document received from another tab is never re-broadcast, so tabs can't ping-pong.

**Client write queue.** At most one PATCH is in flight per client. Edits made meanwhile are merged into the next PATCH, which uses the newest revision as its If-Match. Without this, a quick on-off toggle would send two PATCHes based on the same revision, and the second would conflict with the first.

### 5. Lost responses

Response classification on the client (`frontend/src/lib/sync-rules.ts`):

| Response | Meaning | Client action |
|----------|---------|---------------|
| 2xx | Applied (or already applied) | Adopt the returned document |
| 4xx with the error envelope | The server refused; nothing saved | Show the per-field error or conflict |
| No response, timeout, 5xx, a proxy page | **Outcome unknown**: it may have committed | Mark the key "checking", refetch, reconcile |

Reconciliation compares the user's own value for each sent key (the value if `source = user`, or `userValue` if shadowed) with what was sent. If they match, the write landed and the edit is done. If not, it didn't land (or someone else changed the key since), and the edit goes back through the normal write path. If someone else did change it, that path produces the 409, so the user decides.

The dev chaos switch (`PUT /api/v1/dev/chaos {"dropNextPatchResponses": 1}`) is an **armed count**, not a rate. The next PATCH from that user, on any instance, commits, publishes its event, then has its socket destroyed. The two-devices screen shows the whole path: "Response lost → refetched r10 → appearance.theme found on the server, reconciled".

### Worked example: one successful trace

Alice has the preferences screen open in a laptop tab (holding r12) and her phone app open (holding r12). The phone's SSE stream is on API-B.

1. **Phone:** she sets Theme to Dark. The client marks `appearance.theme` as saving and sends `PATCH {"appearance.theme":"dark"}` with `If-Match: "12"` to API-A.
2. **API-A:** the catalog is cached (revision 1); the key is known. It begins a transaction and runs `SELECT settings_revision FROM users WHERE id = $1 FOR UPDATE` → 12.
3. **API-A:** it loads Acme's org rows and Alice's user rows in the same transaction and plans the patch: known, active, user-scoped, valid enum, not enforced, stored value `light` ≠ `dark`, `theme.rev = 1 ≤ 12` → change.
4. **API-A:** `UPDATE users SET settings_revision = 13`; upsert `user_settings (alice, appearance.theme, "dark", rev 13, updated_by "Phone (iOS app)")`; insert a `setting_changes` row. COMMIT. The write is durable from here.
5. **API-A:** it resolves the new document and publishes `{type: user, userId, revision 13, orgRevision 6, catalogRevision 1, changes: {appearance.theme: {...dark, source user}}}` to Valkey, then returns 200 with the full document and `ETag: "13"`.
6. **Phone:** it adopts r13 and drops the pending edit.
7. **API-B:** its subscriber receives the event, sees Alice's laptop stream, and writes `event: user`.
8. **Laptop tab:** it holds r12; the event is r13 with the same org and catalog revisions → apply the delta. The Theme row flashes and shows "Changed on Phone (iOS app) just now"; the page turns dark. It posts the document to its sibling tabs over BroadcastChannel.
9. **Laptop:** she sets Week starts on to Monday: `If-Match: "13"` → `week_start.rev 0 ≤ 13` → r14. If the laptop had still held r12, the result would be the same: a different key never conflicts.

### Worked example: one failed trace

The phone was backgrounded with the app holding r12 (its SSE stream is closed). Meanwhile the laptop changed the email digest to Daily at r13, and an admin enforced Read receipts.

1. **Phone:** the app wakes up and, before its stream reconnects, Alice sets Email digest to Off. It sends `PATCH {"notifications.email_digest":"off"}` with `If-Match: "12"` to API-A, and arms nothing.
2. **API-A:** it locks the user row (r13) and plans: valid, not enforced, stored `daily` ≠ `off`, `email_digest.rev 13 > 12` → conflict. ROLLBACK. It returns `409` with `conflicts[0] = {key, baseRevision 12, changedAtRevision 13, yourValue off, currentValue daily, changedBy "Laptop (web)"}` and the current r13 document.
3. **Phone:** it adopts r13 (the conflict response carries it) and shows "Changed on Laptop (web) to Daily after this screen loaded r12. Keep Daily / Use mine: Off". Nothing was saved, so no other device changed.
4. **Phone:** Alice taps "Use mine". The client resends with `If-Match: "13"` → applied at r14, and the laptop gets the event.
5. **Phone:** she also tries to switch off Read receipts, but the control is locked. A stale build that sends it anyway gets `422 {fields: [{key: "privacy.read_receipts", code: "LOCKED"}]}`. The client marks the field and refetches, because a LOCKED error means the policy changed under it.
6. **Same session, chaos armed:** she sets Language to Deutsch. API-A commits r15 and publishes, then destroys the socket. The phone sees no response → "outcome unknown" → GET → r15, and `regional.language` is `de-DE` with source `user` → reconciled, done. Had it not landed, the client would have resent the same PATCH; with the value already stored, a resend is a no-op 200.

### Design Review Checklist

1. **Source of truth, and when a write counts.** PostgreSQL. A write succeeds when its transaction commits: revision bump, value row and change-log row together. The SSE event comes after commit and is a hint.
2. **Retry after a lost response.** The client refetches and compares its own value per key. A blind retry is also safe, because a PATCH sets values and an equal stored value is a no-op even with a stale If-Match. No idempotency-key table is needed for this contract.
3. **Failure between two important steps.** A crash before commit leaves nothing (one transaction). A crash after commit but before publishing loses only the event: other devices catch up on their next `hello`, tab focus or revision gap. A crash after publishing but before responding is the lost-response case above.
4. **Ordering and consistency required.** Per user: writes are serialised by the user-row lock, and revisions are strictly increasing. That is the only ordering needed, and SSE events for one user arrive in revision order on one stream. Across users nothing needs ordering. Reads come from one REPEATABLE READ snapshot, so a revision never pairs with values from a different revision.
5. **Access with caches and async fan-out.** Endpoints take the user and org from the session, never from the URL. SSE fan-out filters every event per stream (user → that user, org → members). Events carry only that user's own effective entries, or key names for org and catalog events. The catalog cache holds public definitions only.
6. **What breaks first at scale.** Long-lived connections (3M SSE streams), then org-wide invalidation storms (200k refetches from one click). Not the database: 150 writes per second, and per-user locks never contend across users. See Scalability Considerations.

## Database Schema

The full schema is `backend/src/db/init.sql`. Key tables:

```sql
CREATE TABLE organizations (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  policy_revision  BIGINT NOT NULL DEFAULT 0,       -- org events + admin If-Match
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                 UUID PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id),
  username           TEXT NOT NULL UNIQUE,
  display_name       TEXT NOT NULL,
  role               TEXT NOT NULL CHECK (role IN ('member', 'org_admin', 'platform_admin')),
  password_hash      TEXT NOT NULL,
  settings_revision  BIGINT NOT NULL DEFAULT 0,      -- the per-user revision counter
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE catalog_state (id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id), revision BIGINT NOT NULL DEFAULT 0);

CREATE TABLE setting_definitions (
  key             TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  type            TEXT NOT NULL CHECK (type IN ('boolean', 'enum', 'integer', 'string')),
  scope           TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user', 'org')),
  default_value   JSONB NOT NULL CHECK (jsonb_typeof(default_value) IN ('boolean', 'number', 'string')),
  allowed_values  JSONB,                              -- enum options
  min_value       INTEGER, max_value INTEGER,         -- integer range
  max_length      INTEGER,                            -- string length (characters)
  format          TEXT CHECK (format IN ('hhmm', 'timezone')),
  category        TEXT NOT NULL, label TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  display_order   INTEGER NOT NULL DEFAULT 1000,
  deprecated_at   TIMESTAMPTZ,
  sunset_at       TIMESTAMPTZ,                        -- end of grace window; retired from here
  replaced_by     TEXT REFERENCES setting_definitions(key),
  catalog_rev     BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sunset_at IS NULL OR deprecated_at IS NOT NULL)
);

CREATE TABLE org_settings (
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  key         TEXT NOT NULL REFERENCES setting_definitions(key),
  value       JSONB,                                  -- NULL = tombstone (policy cleared)
  enforced    BOOLEAN NOT NULL DEFAULT false,
  rev         BIGINT NOT NULL,                        -- org policy revision of last change
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES users(id),
  PRIMARY KEY (org_id, key)
);

CREATE TABLE user_settings (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL REFERENCES setting_definitions(key),
  value       JSONB,                                  -- NULL = tombstone ("reset to inherited")
  rev         BIGINT NOT NULL,                        -- user revision of last change
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,                                   -- device label for "changed on Phone"
  PRIMARY KEY (user_id, key)
);
CREATE INDEX user_settings_key_idx ON user_settings (key) WHERE value IS NOT NULL;

CREATE TABLE setting_changes (                        -- append-only, same transaction as the change
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('user', 'org', 'catalog')),
  org_id TEXT, user_id UUID, key TEXT NOT NULL,
  old_value JSONB, new_value JSONB, enforced BOOLEAN,
  revision BIGINT NOT NULL, actor_id UUID, client_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Tombstones.** A reset doesn't delete the row; it sets `value = NULL` and keeps `rev`. If the row were deleted, its revision would be lost: a stale client could then write the key after someone else had reset it, and nothing would detect the conflict. Tombstones are bounded by the catalog size per user.

## API Design

```
POST   /api/v1/auth/login                         → session cookie
POST   /api/v1/auth/logout
GET    /api/v1/auth/me

GET    /api/v1/definitions                        → { catalogRevision, definitions[] } (active + deprecated)
GET    /api/v1/me/settings                        → { revision, orgRevision, catalogRevision, settings{} }; ETag "revision"
PATCH  /api/v1/me/settings                        → merge patch; If-Match required; 200/409/412/422/428
GET    /api/v1/me/history                         → this user's change log
GET    /api/v1/events                             → SSE: hello, user, org, catalog

GET    /api/v1/admin/org                          → org policy + member override counts; ETag "orgRevision"   (org_admin)
PUT    /api/v1/admin/org/policy/:key              → { value, enforced }; If-Match org revision                 (org_admin)
DELETE /api/v1/admin/org/policy/:key              → clear the policy; If-Match                                 (org_admin)
GET    /api/v1/admin/org/history                  → policy and catalog change log                              (org_admin)
POST   /api/v1/admin/definitions                  → add a definition                                           (platform_admin)
POST   /api/v1/admin/definitions/:key/deprecate   → { graceDays, replacedBy }                                  (platform_admin)

GET    /api/v1/dev/chaos · PUT /api/v1/dev/chaos  → { dropNextPatchResponses }  (dev only, per user)
GET    /health · /ready · /metrics
```

**PATCH examples**

```http
PATCH /api/v1/me/settings
If-Match: "12"
Content-Type: application/merge-patch+json
X-Client-Id: tab-3f9a2c1e
X-Client-Label: Laptop (web)

{ "appearance.theme": "dark", "appearance.compact_mode": true }
```

```json
200 OK   ETag: "13"
{ "revision": 13, "orgRevision": 6, "catalogRevision": 1,
  "applied": ["appearance.theme"], "unchanged": [],
  "warnings": [{ "key": "appearance.compact_mode", "code": "DEPRECATED_IGNORED",
                 "replacedBy": "appearance.density", "sunsetAt": "2026-11-26T12:00:00Z", "message": "..." }],
  "settings": { "...": "full effective document" } }
```

```json
422 Unprocessable Entity
{ "error": { "code": "VALIDATION_FAILED", "message": "One or more settings were rejected; nothing was saved",
  "fields": [ { "key": "appearance.colour", "code": "UNKNOWN_KEY", "message": "No such setting" },
              { "key": "appearance.font_scale", "code": "OUT_OF_RANGE", "message": "Must be at most 150" } ],
  "warnings": [] } }
```

`If-Match: *` is an explicit unconditional write: the client opts into last-write-wins and says so. A missing If-Match is `428`, never an implicit overwrite.

## Key Design Decisions

### 1. Storage: key-value rows, storing only explicit choices

| Option | New setting with a default | Different-key concurrency | Type safety | Org overlay | Verdict |
|--------|----------------------------|---------------------------|-------------|-------------|---------|
| ❌ Typed columns (`user_prefs.theme`, `.language`, …) | A migration and a deploy per setting. `ADD COLUMN … DEFAULT` is cheap in PostgreSQL 11+, but now the default lives in the schema and can't tell "chose the default" from "never chose" | One row per user: either a row version (different keys conflict) or a version column per setting | Strong (column types, CHECKs) | Needs a parallel `org_prefs` table and a nullable "inherit" convention per column | Good for 5 fixed settings; wrong for a catalog that changes at runtime |
| ❌ JSON document per user (`user_prefs.doc JSONB`) | Backfill every document, or resolve defaults at read time. "Inherit" vs "explicitly default" needs a convention inside the JSON | Whole-document version → false conflicts; per-key merge needs `jsonb_set` plus a per-key version map inside the JSON | App-level only | Org document merged at read time | Simple reads, but every concurrency and inheritance rule hides inside one blob |
| ✅ Key-value rows (`user_settings(user_id, key, value, rev)`) | One row in the catalog. No user rows; everyone resolves to the default at once | Natural: each row carries its own changed-at revision | App-level, enforced by the definition at write time; JSONB type CHECKs in the DB | Same shape as `org_settings` | Chosen |

What I give up: types aren't enforced by column types (only `jsonb_typeof` CHECKs and the definition), a read is a small range scan (~5 rows per user, primary-key ordered) instead of one row, and analytics queries need a pivot. At 250M rows, the table is a classic candidate for hash partitioning by `user_id`. The win is that the three hard requirements (no backfill, per-key concurrency, inherit vs explicit) fall out of the shape for free.

### 2. One revision per user, plus per-key changed-at revisions

The If-Match is the user's document revision. Each key also remembers the revision of its last change. This gives standard change detection (ETag, SSE events keyed by revision, a gap means "refetch") and per-key conflict detection, without the client tracking a version per key. The alternatives were a whole-document ETag (false conflicts between a phone and a browser) and client-held per-key versions (a bigger client contract, and every key needs a version even if the client never saw it).

### 3. Equal value = no-op, checked before the conflict

This makes PATCH idempotent by construction, so a lost response needs no idempotency-key table. The cost is that two clients writing the same value never learn about each other. That's fine: they agree.

### 4. Enforcement shadows, it doesn't overwrite

Enforcing a value writes one org row. Members' rows are untouched. A member's choice comes back the moment the policy is lifted, and the admin screen shows how many members an enforcement would shadow. Overwriting would be irreversible and would write 200k rows for a large org.

### 5. Reject a write to an enforced key, don't store it silently

Storing it and shadowing it would be harmless to the effective value, but the user would think they had changed something. A per-field `LOCKED` error matches what the locked control shows. Race: if an admin enforces a key between a client's read and its write, the write gets `LOCKED` and the client refetches. If the write commits first, enforcement still wins at read time. Either order is correct, so this check needs no cross-table lock.

### 6. Events are hints with revisions; deltas only for one user's own changes

Delivering the changed entries in `user` events saves a GET in the common case. The `orgRevision` and `catalogRevision` they were resolved against let a client detect that a delta is stale. Org and catalog events are invalidations because the effective value differs per member.

### 7. Valkey pub/sub, not a durable stream

Losing an event is tolerated by design (hello, focus revalidation, revision gaps), so the fan-out channel doesn't need durability. A durable stream (Kafka, Valkey Streams) would add consumer offsets per instance for no correctness gain. At production scale I would add a transactional outbox, not for correctness but to stop a Valkey outage from delaying propagation until the next revalidation.

## Consistency and Idempotency

- **Write atomicity.** Revision bump, value rows and change-log rows are in one transaction. The event is published after commit.
- **Per-user serialisation.** `SELECT … FOR UPDATE` on the user row. Two devices writing different keys serialise for a few milliseconds and both succeed. Different users never contend.
- **Snapshot reads.** `GET /me/settings` runs in a `REPEATABLE READ READ ONLY` transaction, so revision, org policy and user rows are mutually consistent. Without this, a client could store revision 15 with values from 14, then ignore the event for 15 as "already seen".
- **Idempotency.** PATCH sets values; an equal stored value is a no-op regardless of If-Match. Admin PUT and DELETE follow the same rule. Creating a definition is not idempotent by design: a second create of the same key is `409 KEY_EXISTS`, which a retrying client can treat as success after checking the definition.
- **Future revisions.** `If-Match` ahead of the server (after a restore from backup) is `412` with the current document; the client adopts it. `hello` with a lower revision makes the client adopt even though it looks older.
- **Catalog cache ordering.** The catalog read that started last wins (a load sequence number), so a slow older read can't overwrite a newer one, and the cache can still go backwards after a restore.

## Security / Auth

- **Sessions.** Opaque id in an httpOnly, SameSite=Lax cookie; session data in Valkey (7-day TTL). Logout deletes it.
- **Roles.** `member` (own settings), `org_admin` (own org's policy), `platform_admin` (catalog, plus their own org's policy). Checked per route.
- **No ids in URLs.** `/me/settings` and `/admin/org` take the user and org from the session. There is no other user's id to tamper with.
- **SSE filtering.** Every event is checked per stream. A Globex member never sees an Acme org event (covered by the end-to-end script).
- **Rate limits.** Login: 30 per minute per IP. PATCH: 120 per minute per user (a loop that writes faster is a bug).
- **Input limits.** 64 KB JSON body, at most 100 keys per patch, device labels sanitised to 60 characters.
- **Dev chaos.** The chaos routes are mounted only when `CHAOS_ENABLED` (default on outside production), and they're scoped to the caller's own user.

## Observability

Prometheus metrics per instance (`backend/src/shared/metrics.ts`):

| Metric | Labels | Use |
|--------|--------|-----|
| `settings_patch_total` | outcome: applied, noop, conflict, invalid, locked, precondition | A conflict rate above ~1% means clients aren't refetching on events |
| `settings_patch_keys_total` | result: changed, unchanged, deprecated_ignored | `deprecated_ignored` shows how many old clients are still in the field before a sunset |
| `settings_policy_changes_total` | outcome | Admin activity |
| `settings_events_published_total` / `settings_events_delivered_total` | type, result | Publish errors mean Valkey trouble; deliveries per instance show fan-out balance |
| `settings_sse_connections` | — | The first thing to saturate |
| `settings_catalog_reloads_total` | reason: cold, ttl, invalidated, unknown_key | `unknown_key` reloads that still end in 422 point to a client sending junk |
| `settings_chaos_dropped_responses_total` | — | Should be 0 outside dev |
| `http_request_duration_seconds` | method, route, status | Latency SLOs |

Structured logs (pino) carry the instance id on every line, so a write on api-a and its delivery on api-b can be followed. `/health` is liveness; `/ready` checks PostgreSQL and Valkey.

## Failure Handling

| Failure | Behaviour |
|---------|-----------|
| PostgreSQL down | Reads and writes fail (503 from `/ready`). Clients keep their last document and show writes as "not saved". |
| Valkey down | Sessions fail, so requests fail authentication. Event publishing fails: writes still commit (logged and counted), and other devices catch up on the next revalidation. |
| An API instance crashes mid-PATCH | Before commit: rolled back, and the client sees "outcome unknown", refetches and resends. After commit: the client refetches and finds it. |
| Event lost (publish failed, subscriber reconnecting) | `hello` on reconnect, focus revalidation and gap detection repair it. |
| SSE stream drops | EventSource reconnects after 2 s; `hello` carries the revisions. |
| Stale catalog on one instance | 30 s TTL, pub/sub invalidation, reload on unknown key. |
| Client clock skew | Irrelevant: ordering uses server revisions, never timestamps. |
| Restore from backup (revisions go backwards) | `412` on writes and a `hello` with a lower revision make clients adopt the server's state. |

## Scalability Considerations

What breaks first, in order, with the evidence:

1. **Long-lived connections.** 3M concurrent SSE streams. Node handles ~20-50k idle streams per process before memory and file descriptors bite, so that's 60-150 processes for connections alone. The fix is a dedicated connection tier (or a managed push service) subscribed to events by user-id shard, so the API tier scales with requests, not with connections. Mobile apps in the background use push notifications plus revalidation on resume, not open streams.
2. **Org-wide invalidation storms.** Enforcing a key at a 200k-member org makes every online member refetch within a second, 50-100× the normal read rate. Mitigations: client jitter (implemented, 0-400 ms; widen it to several seconds at scale), an org-revision-aware cache of effective documents keyed by `(user, userRev, orgRev, catalogRev)`, and, at the extreme, org events that carry the org rows so clients re-resolve locally.
3. **Read volume.** About 15k reads per second at peak go to read replicas. Snapshot reads tolerate replica lag, because a client holding a newer revision ignores an older document (`isNewerOrSame`). For read-your-writes, the PATCH response itself is the fresh document.
4. **Storage.** 250M rows and ~30 GB is comfortable for one primary. Hash-partition `user_settings` by `user_id` when vacuum or index rebuilds get slow; every query is by user. `setting_changes` grows forever: partition it by month and expire it.
5. **The write path is not a bottleneck.** 150 writes per second, one row lock per user, no cross-user contention. Sharding by user is the eventual path, and the schema already has no cross-user transactions.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Storage model | Key-value rows, explicit choices only | Typed columns / JSON document | No backfill, per-key revisions, inherit vs explicit for free |
| Conflict detection | Document revision in If-Match vs per-key changed-at revision | Whole-document ETag / client-held per-key versions | No false conflicts across keys; one number for the client |
| Missing If-Match | 428 | Implicit last-write-wins | Never silently overwrite |
| Retry safety | Equal value = no-op, before the conflict check | Idempotency-key table | PATCH sets values; the retry case is free |
| Patch atomicity | All keys or none | Partial success with per-key status | One outcome to reason about; the client resends what remains |
| Enforcement | Read-time shadowing; reject user writes with LOCKED | Overwrite user rows / silently store | Reversible, no fan-out writes, honest UI |
| Deprecation | Grace window (accept, ignore, warn) → retired (422) | Immediate 422 | Old clients in the field keep working until the sunset |
| Deletes | Tombstones keep the revision | Delete rows | No ABA on reset-then-set |
| Fan-out | Valkey pub/sub, events as hints | Kafka / durable streams | Losing an event is tolerated by revalidation |
| User events | Delta with revisions | Pure invalidation | Saves a GET per remote change; gaps still refetch |
| Org events | Invalidation + jitter | Per-member deltas | Effective values differ per member |
| Tab sync | BroadcastChannel + per-tab SSE | SSE only / leader-tab election | Instant, works offline; leader election is the scale step |
| Catalog cache | TTL + pub/sub invalidation + reload on unknown key | Read the catalog every request | Validation on the hot path without stale rejections |

## Implementation Notes

### Local architecture

```
browser ──▶ Vite :5173 ──/api────▶ api-a :3000 ─┐
                         └─/api-b──▶ api-b :3001 ─┼──▶ PostgreSQL :5432
                                                  └──▶ Valkey :6379 (sessions, chaos, pub/sub "ss:events")
```

`npm run dev` in `backend/` starts both instances. The two-devices screen puts the phone on api-a (`/api`) and the laptop on api-b (`/api-b`), so every cross-device change in the demo crosses instances through Valkey.

### Production-grade patterns actually implemented

- **The PATCH contract as a pure function** (`backend/src/domain/patch.ts`). The whole decision table above is one function with 20 unit tests, so the contract is reviewable apart from I/O.
- **Snapshot reads and per-user row locks** (`backend/src/services/settings-service.ts`). Without the snapshot, a client could pair revision N with values from N-1 and then ignore event N forever.
- **Tombstones with monotonic revisions** (`init.sql`, `domain/patch.ts`). This prevents ABA on reset-then-set, which is the bug that slips past most per-key version schemes.
- **Catalog cache with three invalidation paths** (`backend/src/services/catalog.ts`). It's on the hot path for validation; a stale cache must never reject a key that exists.
- **Cross-instance SSE fan-out with per-stream filtering** (`backend/src/api/live.ts`). Access is checked at delivery, not only at subscribe time.
- **Armed-count chaos switch in Valkey** (`backend/src/shared/chaos.ts`). A Lua take-one makes "drop exactly the next response" deterministic on whichever instance handles it.

  ```ts
  if (config.chaosEnabled && (await takeDrop(user.id))) {   // after commit and publish
    req.socket.destroy()                                     // the client sees no response
    return
  }
  ```

- **Client sync rules as pure functions** (`frontend/src/lib/sync-rules.ts`, 13 tests): response classification, event decisions, hello decisions, reconciliation after an unknown outcome.
- **A client write queue** (`frontend/src/lib/settings-store.ts`). One PATCH in flight, later edits merged, so a client never conflicts with itself.
- **Prometheus metrics, pino logs with the instance id, health and readiness, and rate limits** (`backend/src/shared/`).

### Simplified or substituted

- **Session auth** instead of OAuth/OIDC and SSO-provisioned org membership.
- **One PostgreSQL** instead of a primary with read replicas; no partitioning.
- **Valkey pub/sub publish after commit** instead of a transactional outbox.
- **SSE from the API instances** instead of a dedicated connection tier; one stream per tab (no leader-tab election).
- **A platform admin role inside an org** stands in for an internal catalog-management tool or a deploy pipeline that owns definitions.

### Omitted

- Push notifications to backgrounded mobile apps (the native-app side of propagation).
- Per-device settings (e.g. "this device only" notification overrides), which would be a third scope between org and user.
- Translating deprecated keys onto their replacements (`compact_mode: true` → `density: compact`). Deprecated writes are ignored with a warning instead.
- A cleanup job that deletes rows of retired keys, and expiry of the change log.
- Multi-region, Kubernetes, CDN.
