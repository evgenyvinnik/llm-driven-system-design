# AirTag — Architecture

## System Overview

Design an item-finding network in which nearby participating devices report an
approximate observation of a lost item, and its owner retrieves those observations.
The central challenges are protecting location contents, handling delayed reports,
communicating uncertainty, and providing unwanted-tracker protection.

The production design below is a proposal inspired by offline finding. It is not
Apple's internal implementation. Apple's published design describes public-key
report encryption and owner-side decryption, with private key material excluded
from Apple's servers. [Apple Platform Security](https://support.apple.com/en-ie/guide/security/sece994d0126/web)

**This repository implements a server-trusted simulation.** Its backend generates
and stores master secrets, encrypts map-click coordinates, decrypts history and
returns plaintext locations. The final Implementation Notes document that boundary
and other differences from the proposed production system.

## Requirements

### Functional requirements

- Pair an item with an owner and maintain authorized ownership metadata.
- Accept encrypted observations from participating finder devices.
- Retrieve bounded report history and decrypt it on an authorized owner device.
- Show the latest credible observation, its age and uncertainty.
- Support lost-item contact information and a deliberate notification policy.
- Detect potentially unwanted trackers through the nearby device/OS safety path.
- Distinguish nearby hardware actions from remote observations.

BLE scanning, secure pairing, UWB ranging and NFC require a hardware/platform
integration. A web dashboard can visualize results but does not provide those
capabilities merely by drawing their controls.

### Non-functional requirements

These are proposed targets and trust boundaries, not measured results:

| Requirement | Target or rule |
|-------------|----------------|
| Location confidentiality | The report service does not receive owner decryption secrets or plaintext coordinates |
| Ingestion | p99 below 300 ms for durable regional acceptance |
| Retrieval | p95 below 500 ms for a bounded recent query, excluding client decryption |
| Availability | 99.99% ingestion and 99.9% query availability targets |
| Retention | Seven days of report storage initially, enforced by a defined cleanup policy |
| Recovery | Retry the same report identity without multiplying its durable effect |
| Safety | Unwanted-tracker detection and actionable alerts remain a first-class path |
| User feedback | Observation age, report delivery state and network failure are distinguishable |

There is no universal time-to-find guarantee. A tag needs a nearby participating
finder, and that finder needs an upload opportunity. Key rotation is not an upper
bound on observation latency or a reason to delay reporting until the next period.

## Capacity Estimation

Assume one billion reports/day and an encoded envelope of roughly 1 KB. That is
about 11,600 reports/second on average and 1 TB/day of payloads. A 100,000/second
peak allows for geographic and temporal concentration. These are planning assumptions,
not claims about deployed AirTag counts or demonstrated database throughput.

Seven days is about 7 TB of raw payloads, or 21 TB with three copies before indexes,
logs and metadata. Time-bucketed retention and bounded query fan-out matter more
than choosing a database from an unsupported universal writes-per-second limit.

With a hypothetical 15-minute lookup period, one day spans 96 intervals; a query
including both boundary periods may need 97 keys. A week spans 672 intervals plus
possible boundary coverage. More frequent rotation increases lookup work, but should
not require downloading all historical reports every refresh.

### Local Development Scale

The seed creates seven fixed devices and thirteen reports. One Express API connects
to one PostgreSQL, one Valkey and optionally RabbitMQ plus workers. The frontend
uses one latest-location request per listed device and polls selected history every
30 seconds. No local capacity benchmark was performed during this review.

## High-Level Architecture

```
┌──────────────┐       ┌─────────────────────┐       ┌─────────────────┐
│ Item beacon  │──────▶│ Nearby finder / OS  │──────▶│ Ingestion API   │
│ Rotating key │ BLE   │ Encrypt observation │ HTTPS │ Validate, admit │
└──────────────┘       └──────────┬──────────┘       └────────┬────────┘
                                 │ safety signals            ▼
                       ┌─────────▼──────────┐       ┌─────────────────┐
                       │ Local unwanted-   │       │ Durable log /   │
                       │ tracker detection  │       │ report workers  │
                       └────────────────────┘       └────────┬────────┘
                                                            ▼
┌──────────────────────┐      ┌─────────────────┐   ┌─────────────────┐
│ Owner app            │◀────▶│ Bounded query API│◀─▶│ Opaque report   │
│ Keys, decrypt, map   │      │ and read cache  │   │ store + index   │
└──────────────────────┘      └─────────────────┘   └─────────────────┘
```

Account/pairing metadata is a separate concern from report contents. The owner app
obtains its keys through a protected local pairing and encrypted synchronization
flow. The report service has ciphertext and lookup tokens, not a decrypting key store.

The nearby device handles safety observations through a dedicated platform path.
Uploading every person's plaintext movement history to a centralized anti-stalking
service would contradict the location privacy goal unless that additional trust
relationship were explicitly chosen and disclosed.

## Core Components / Request Flows

### Pairing, ownership and key custody

Establish possession and ownership during pairing. Generate key material at the
trusted endpoint, protect it with the platform's available key storage, and define
how another owner device can receive it through encrypted synchronization.

Use a reviewed cryptographic protocol and supported libraries. This document does
not specify a new elliptic-curve construction or claim that a random field named
“ephemeral public key” constitutes a key agreement.

Account authentication and possession of decryption capability are different.
Resetting an account password cannot recover missing keys unless a recovery mechanism
was designed. A server-accessible KMS can protect stored secrets from some attacks,
but does not make that server unable to decrypt.

Rotation reduces stable broadcast identifiers. It does not eliminate correlation
through physical co-movement, timing, network addresses or batched lookup requests.
Apple describes changing derived public keys approximately every 15 minutes in its
published offline-finding design; that is a reference behavior, not a security proof
for this repository's unrelated symmetric demo. [Find My security](https://support.apple.com/guide/security/find-my-security-sec6cbc80fd0/web)

### Observation and durable ingestion

1. The finder observes a beacon and obtains its current public encryption material.
2. It records its approximate location, observation time and accuracy.
3. It encrypts the observation for the owner and creates a stable report identity.
4. It submits the same envelope on retries, subject to bounded local buffering.
5. The service validates envelope shape/size, applies admission controls, and durably accepts it.
6. A worker stores or upserts the report and advances ingestion progress.
7. Queries expose stored reports and distinguish processing lag from absence.

The finder knows the location it observes; encryption protects the contents from
intermediaries and unauthorized readers. Public-key encryption does not prove that
the finder reported a truthful location. The owner must treat observations as evidence
with accuracy and plausibility limits, not infallible coordinates.

Envelope authentication should bind relevant protocol context, including version
and lookup identity. Keep server receipt time distinct from an encrypted observation
time. A server cannot validate a hidden timestamp merely by validating its own clock.

### Owner query and map display

The owner derives lookup tokens for a bounded time window and requests corresponding
ciphertexts. The query service caps tokens, result bytes, time span and pagination
work. For global delivery, define how a token resolves to report storage regardless
of where a finder uploaded it; region-only ingestion without discovery routing can
strand observations away from the owner's query.

The client decrypts each report, validates the payload and merges by report identity.
Sort observations by observation time, with a stable tie-breaker. A late upload of
an old sighting must not move the “latest” marker backward in time.

Show timestamp and accuracy together. A line between sparse observations represents
a sequence, not a measured continuous journey. Empty history, unavailable network,
missing keys and invalid ciphertext need different states.

Map tiles, external directions and analytics can expose the viewed area after
successful local decryption. Include those services in the privacy assessment;
keeping the report database opaque does not automatically protect the whole UI.

### Lost mode and notification choices

A public found-item page should use a deliberate physical-item lookup mechanism
and show only contact information the owner chose to publish. It must not expose
private report history or an account-wide device list.

For “notify when found,” one option is for the owner app to detect newly retrieved
reports. A server subscription to short-lived lookup tokens can reduce polling, but
reveals an association between that subscription and those tokens. Choose and disclose
that metadata trade-off rather than claiming complete unlinkability.

Notification identity, retries and expiry are separate from report identity. The
system should not send an unbounded stream of identical “found” alerts for every
finder observation, or treat push delivery as the only durable record of a report.

### Unwanted-tracker safety

Detection belongs close to the nearby device, with protected short-lived sighting
history and platform-supported signals. The protocol must reconcile rotating
identifiers with recognizing repeated unwanted proximity; grouping unrelated hashes
by guesswork is not a complete solution.

The UI should clearly describe the observation and offer supported next actions.
It must not label a person a stalker from a heuristic, hide essential help behind
multiple steps, or imply that no alert proves safety. Device identification and
disabling instructions should follow maintained platform guidance.
[Apple's unwanted-tracking guidance](https://support.apple.com/en-us/119874)

The repository's thresholds are demo constants, not calibrated safety guarantees.
Detailed local behavior is documented below.

## Database Schema

The complete local schema is in
[backend/src/db/init.sql](./backend/src/db/init.sql). It uses plain PostgreSQL,
not PostGIS, partitioned tables or a distributed report store.

| Table | Important local fields | Relationships and constraints |
|-------|------------------------|-------------------------------|
| `users` | UUID, unique email, bcrypt hash, name, user/admin role | Role check and email uniqueness |
| `registered_devices` | UUID, owner, type, name, emoji, plaintext master secret, active flag | Owner FK with cascade; type check; owner/active indexes |
| `location_reports` | Bigserial ID, identifier hash, encrypted JSON envelope, region, receipt time | No device FK; identifier/time B-tree indexes; no report uniqueness |
| `lost_mode` | Device ID, enabled flag, contact fields, notification preference, enabled time | Device ID is PK/FK with cascade |
| `notifications` | UUID, user/device IDs, type, title/message, read flag and JSON data | User cascade, device set-null; partial unread index |
| `tracker_sightings` | User ID, identifier hash, plaintext coordinates and seen time | User cascade; user/hash and time indexes |
| `decrypted_locations` | Device ID, plaintext coordinates and observation time | Declared but unused by the current application read/write path |
| `session` | Session ID, JSON and expiry | Declared optional PostgreSQL session table; active sessions use Redis |

No foreign key from reports to devices does not establish privacy. The same backend
has every device secret and actively derives report identifiers. Raw encrypted
reports also survive device deletion because there is no cascade relationship or
scheduled retention cleanup for them.

The production model would replace server-held decryption secrets with protected
endpoint key custody. Report storage would add stable report identity, envelope
version, receipt-time retention buckets and a bounded lookup index. Safety history
would move to the nearby trusted endpoint rather than this plaintext server table.

## API Design

The local prefix is `/api`; the application does not implement `/api/v1` contracts.
All location, device, lost-mode, notification and sighting routes require a session,
including the report-submission endpoint.

| Method | Path | Implemented behavior |
|--------|------|----------------------|
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` | Account/session actions |
| GET | `/api/auth/me` | Current database user associated with the session |
| GET / POST | `/api/devices` | List / create devices; responses include stored secret fields |
| GET / PATCH / DELETE | `/api/devices/:id` | Owned device detail / update / removal |
| POST | `/api/devices/:id/play-sound` | Simulated acknowledgement only |
| GET | `/api/locations/:deviceId` | Server-decrypted history; optional startTime/endTime/limit |
| GET | `/api/locations/:deviceId/latest` | Latest plaintext location, including a cache shortcut |
| POST | `/api/locations/:deviceId/simulate` | Owner-supplied coordinates encrypted and stored by the server |
| POST | `/api/locations/report` | Queue supplied envelope, or synchronously store on publication error |
| GET / PUT | `/api/lost-mode/:deviceId` | Read / upsert owned device settings |
| POST | `/api/lost-mode/:deviceId/enable`, `/api/lost-mode/:deviceId/disable` | Quick lost-mode changes |
| GET | `/api/notifications`, `/api/notifications/unread-count` | Inbox / unread count |
| POST | `/api/notifications/:id/read`, `/api/notifications/read-all` | Mark read |
| DELETE | `/api/notifications/:id` | Delete owned notification |
| POST | `/api/anti-stalking/sighting` | Record plaintext sighting and analyze synchronously |
| GET | `/api/anti-stalking/unknown-trackers`, `/api/anti-stalking/sightings/:identifierHash` | Summaries / recent sighting details |
| GET | `/api/admin/stats`, `/api/admin/users`, `/api/admin/devices`, `/api/admin/lost-devices` | Session-role-protected administration reads |

The queued report response is HTTP 202 with status `queued`; synchronous storage
returns HTTP 201 and a report ID. Neither path currently offers a durable operation
lookup or the same deduplication behavior.

A production owner query would submit a bounded set of derived tokens and receive
ciphertexts with continuation metadata. The local device-ID endpoint performs both
lookup derivation and decryption on the server instead.

## Key Design Decisions

### Endpoint decryption versus server-trusted convenience

Owner-side keys protect report contents when storage or an intermediary is compromised.
They also let the backend store opaque observations without interpreting coordinates.
The cost is pairing, recovery, sharing, client processing and secure application delivery.

Server-side decryption simplifies the demo and enables its lost-mode scan and map
API. It also means a backend or database compromise exposes location capability.
Encrypting secrets under a server-accessible key changes storage protection, not
which party can read locations. The local project makes this convenience trade-off.

### Stable report identity versus an expiring processing marker

A finder should reuse one report identity and envelope when retrying a lost response.
Durable storage enforces uniqueness for that identity, with a payload fingerprint
rejecting conflicting reuse. A worker may receive the same message twice and still
produce one report record.

A Redis marker written before storage can survive a failed insert and suppress work
that never completed. A marker written only afterward leaves a duplicate window.
Use the durable sink to establish the effect; an optional cache accelerates duplicate
responses but does not replace the sink's consistency rule.

The cost is a uniqueness/indexing strategy at the actual write volume. It must be
measured. Assuming a database constraint is unaffordable and then claiming exactly-once
behavior from an independent cache hides the failure boundary.

### Freshness-based caching versus rotation-based expiry

Rotated identifiers remain relevant for historical or delayed reports. A report
arriving after its period ends is not automatically useless. Cache policy must be
based on acceptable view staleness and report arrival behavior, not just key rotation.

Use stable bounded time windows, incremental retrieval and short negative-cache
lifetimes for recent periods. Historical buckets may be cached longer only under a
defined late-arrival policy. Include every query dimension and authorization scope.

This adds bookkeeping compared with one fixed TTL, but avoids both stale “not found”
responses and nearly unique cache keys for every millisecond-level refresh.

## Consistency and Idempotency

For the production path, acknowledge ingestion only after a defined durable boundary:
a confirmed append to the chosen ingestion log, or a committed report insert. Worker
acknowledgement follows the idempotent durable effect. Retries and retention must
preserve identity over the supported replay horizon.

If a database transaction also creates a notification intent, use an outbox for
that intent. A relay can publish more than once; the notification consumer therefore
needs its own durable identity and provider-specific retry/reconciliation behavior.
There is no universal exactly-once guarantee for every external delivery.

Lost-mode settings need an expected version or another explicit conflict policy
when edited from multiple owner devices. Pairing/removal and key sharing likewise
need defined lifecycle semantics. None of these follow automatically from using UUIDs.

## Security / Auth

The local app uses bcrypt and Redis-backed express-session cookies. Backend ownership
checks exist on device and history operations, and admin routes check the role stored
in the session. Login does not regenerate the session ID, and role changes in the
database do not immediately replace an existing session's role.

A critical exception is `getLatestLocation`: it returns a device-keyed cache hit
before checking the caller's ownership. Authorization must precede returning any
cached private value. Device deletion also leaves that latest cache intact until TTL.

Device APIs and the admin device list serialize `master_secret`. Frontend TypeScript
interfaces omitting that property do not remove it from the network response or
runtime object. Map simulation logs device IDs and plaintext coordinates; broad
claims of secret/location redaction are therefore inaccurate.

The rate limiter reads the first `X-Forwarded-For` value directly. A production
proxy trust policy must establish which forwarding information is authoritative.
Report shape, coordinates, query ranges and response size also require stronger
validation than the local truthiness checks and TypeScript casts.

## Observability

Measure accepted, stored, rejected and duplicate reports separately. Query latency
needs a matching freshness measure: report processing lag, age of the latest valid
observation, and client time since the last successful refresh are distinct signals.
Safety metrics should not centralize raw personal movement histories.

[shared/metrics.ts](./backend/src/shared/metrics.ts) collects HTTP timing, cache,
selected database operations, duplicate checks and rate-limit events. Queue metrics
are collected in each process; workers have no HTTP metrics server, so their values
are not included in the API endpoint. Session/device gauges are declared but not
updated by their business services.

HTTP route labels can lose the router prefix and combine unrelated paths. Region
labels accept report-supplied values and need bounded cardinality at scale.
Pino request IDs are not propagated through all service calls or queue envelopes,
so the code does not supply end-to-end distributed tracing.

## Failure Handling

| Failure | Proposed production behavior | Local behavior |
|---------|------------------------------|----------------|
| Finder offline | Bounded retry buffer preserving report identity | No real finder client |
| Broker publication uncertain | Resolve/retry same durable identity | Ordinary channel, no publisher confirms |
| Worker SQL failure | Bounded retry and recoverable dead-letter storage | Reject without requeue; no dead-letter binding |
| Cache error | Bounded fallback where authorized | Helpers catch errors; sessions/limits still depend on Redis |
| Query/decryption failure | Distinct unavailable/key/invalid-report state | Many errors become console output or empty-looking UI |
| Broker reconnect | Re-establish consumers and readiness | Connection fields reset; consumers do not resubscribe automatically |

`/health` and `/health/live` are liveness endpoints. `/health/ready` checks PostgreSQL
and Redis, but returns 200 degraded when either alone fails and 503 only when both
fail. It does not inspect RabbitMQ or consumers. The API starts listening without
calling the available dependency-wait helper.

Workers close their AMQP/database/Redis clients on termination, but do not explicitly
cancel consumption and drain active handlers before closing the channel. The API
has no graceful shutdown handler. No circuit breaker is implemented; this is an
omission, not evidence that databases or brokers cannot fail independently.

## Scalability Considerations

Partition high-volume report storage by lookup-token ownership with receipt-time
buckets for retention. Regional ingress can forward to a deterministic token owner
or an explicitly discoverable global index. Geography and encrypted contents cannot
supply routing information the service deliberately does not possess.

Bound report size, token batches, per-token history, query concurrency and client
decryption work. Latest reads need incremental retrieval, not full-week scans for
every card. Duplicate suppression must preserve the durable storage contract across
partition moves and replay.

Drop expired storage buckets through a controlled retention process and include
backups/logs in the policy. Do not infer retention from a query's default seven-day
window. Add a new database or broker only after representative measurements justify
its operational costs; product names have no fixed universal throughput ceiling.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Location contents | Owner-side decryption | Server-held master secrets | Exclude service from plaintext capability |
| Report identity | Durable sink uniqueness | Independent expiring marker | Recover retries and interrupted writes |
| Query caching | Stable windows and freshness policy | Match TTL to rotation blindly | Preserve delayed reports and useful cache reuse |
| Safety history | Protected nearby-device processing | Central plaintext movement database | Avoid expanding location exposure |
| Notification hints | Explicit scoped subscription or owner polling | Assume anonymous global owner lookup | Account for metadata and delivery trade-offs |

## Implementation Notes

### Actual local flow

The API, PostgreSQL and Valkey support the main map demo. RabbitMQ and the two
workers support a separate report-ingestion path. All radio observations are
simulated; no BLE beacon, UWB ranging, NFC reader or Apple network connection exists.

On a map click, [locationService.ts](./backend/src/services/locationService.ts)
checks device ownership, derives the current lookup hash, encrypts the supplied
coordinates using the stored master secret, and calls its synchronous insert path.
History reads derive hashes and decrypt on that same backend, then cache plaintext
in Redis. The browser receives coordinates through ordinary authenticated fetches.

The symmetric key is constant for a device, derived from its master secret and a
fixed label. Fifteen-minute HMAC-derived values change the lookup identifier only.
The `ephemeralPublicKey` field contains random bytes and is unused by decryption.
There is no EC key pair, ECDH or client-side WebCrypto in the running flow.
See [utils/crypto.ts](./backend/src/utils/crypto.ts).

### Patterns actually wired

[shared/cache.ts](./backend/src/shared/cache.ts) implements cache-aside helpers for
history and latest locations. History values use a 900-second TTL, latest values
60 seconds. Device-list and device-by-ID cache helpers exist but are not called by
the device service. Identifier invalidation currently just logs and deletes no keys.

[shared/idempotency.ts](./backend/src/shared/idempotency.ts) uses an atomic Redis
claim in the synchronous submission path. Its key primitive is:

```typescript
await redis.set(key, JSON.stringify({ timestamp: Date.now(), response }), 'EX', IDEMPOTENCY_TTL, 'NX');
```

Atomic claiming prevents two callers from both obtaining that particular claim;
it does not make the subsequent PostgreSQL insert atomic with Redis. The claim
initially has no result, is retained after insert failure, and concurrent duplicates
can receive an undefined response. Identity also uses the server's current minute,
so the same report retried across a minute boundary gets a different key. Timestamp
validation is passed `Date.now()`, not the observation's timestamp.

[shared/queue.ts](./backend/src/shared/queue.ts) declares two durable queues:
`location-reports` with 24-hour message TTL and `notifications` with one-hour TTL.
It sets prefetch to ten and publishes persistent messages to ordinary channels.
The send boolean indicates local backpressure, not a durable broker confirmation.
The API still returns 202 when the boolean is false.

[shared/rateLimit.ts](./backend/src/shared/rateLimit.ts) wires separate one-minute
budgets: auth login/register 10, device POST operations 20, report submission 100,
other location operations 240, admin 20 and general API 100. These are IP-based
unless the forwarding header overrides the key; the per-user helper is unused.
There is no configured in-memory fallback for Redis rate-limit errors.

Pino, Prometheus and liveness/readiness helpers are present under `src/shared`.
Their actual scope is described above; they do not establish a tested service-level
objective or a reliable alert-delivery pipeline.

### Incomplete workflows and correctness gaps

**Queued reports.** The [location worker](./backend/src/workers/location-worker.ts)
inserts every delivery without an idempotency check or unique report constraint.
Both workers reject failures without requeue and without a dead-letter destination.
A crash after insert but before acknowledgement can duplicate effects on redelivery.
A broker error can send the API into synchronous fallback without one shared durable
identity covering both paths.

**Lost mode.** Both submission paths scan all notify-enabled lost devices and derive
only their current hash. Reports delayed across a rotation can miss notification
matching. Matching uses server-held secrets, proving the service can correlate
reports with owners. There is no notification cooldown for repeated found reports,
no optimistic version field, no public found-item page and no NFC flow. Lost-mode
updates are upserts, but ordinary device creation is two separate inserts, not an
idempotent registration transaction.

**History and cache.** Default history calls put fresh millisecond start/end values
in the cache key, limiting reuse. Queries select all reports for derived hashes,
then decrypt, sort and slice in memory; they do not enforce an exact observation-time
filter or SQL result cap. The key-period loop and user-supplied limits are unbounded.
Neither active-flag changes nor device deletion invalidate private location caches.

**Unwanted trackers.** [antiStalkingService.ts](./backend/src/services/antiStalkingService.ts)
runs synchronously after a sighting insert. It requires at least three sightings of
one hash in three hours and either accumulated point-to-point distance over 500 m
or a span over one hour. It is not the distance-and-time rule described in older docs.
GPS noise affects accumulated distance, and hashes are not linked across rotations.
Own-device exclusion compares only current hashes; historical owned observations can
later appear unknown. The summary endpoint checks count, not the full alert rule.
Its one-hour alert cooldown is a read-then-insert check and can race.

**Frontend.** [App.tsx](./frontend/src/App.tsx) uses local tab state, not routing.
[useStore.ts](./frontend/src/stores/useStore.ts) keeps one history array and does not
guard responses by selected device or account generation. A late response can place
one device's points under another device's name, or repopulate state after logout.
Latest-card requests are unbounded concurrent fan-out and map failed reads to missing
locations. Polling runs every 30 seconds while selected without a visibility gate.

[MapView.tsx](./frontend/src/components/MapView.tsx) centers only once per mounted
map and does not reset that flag on device change. Its empty-state overlay can
intercept map clicks. [DeviceDetails.tsx](./frontend/src/components/DeviceDetails.tsx)
initializes a lost-mode form before asynchronous settings arrive and does not reset
it on device changes. Directions uses fixed coordinates; Play Sound is an API
acknowledgement plus a timer. Device cards render the supplied emoji through raw HTML.

Notifications load on panel opening. Mark-read updates happen after the server
response, not optimistically, and concurrent clicks can decrement the badge twice.
The badge is otherwise fetched on authentication, not continuously. Redis publishes
have no subscriber bridge to the UI. Safety API methods exist in the frontend client
but are not connected to a detection or action screen. There is no offline persistence,
service worker, precision finding, hardware disabling or push integration.

### Local substitutions and verification

PostgreSQL replaces a partitioned report store; Valkey holds sessions and plaintext
read caches; map clicks replace finder devices. The SQL `decrypted_locations` and
`session` tables are unused in current business flows. Retention jobs, encrypted
key synchronization/recovery, native hardware adapters, durable replay tooling,
CDN deployment and multi-region infrastructure are omitted.

The seed uses fixed demo secrets and recent encrypted history, preserving existing
users/devices but appending reports and notifications on every run. Its current
password is `password123` for new users; the Playwright login helper still uses
`admin123`. There are no backend tests. Setup alternatives and script details are
in [README.md](./README.md).

This review traced source and configuration, including both report paths, all
services, workers, state, maps, seed and smoke-test setup. It did not run a hardware
integration, security audit, application build or real broker/database recovery test.
The findings above document the implementation; they do not imply fixes to its code.
