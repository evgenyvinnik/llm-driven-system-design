# AirTag — Backend System Design

*A 45-minute discussion of private report contents, durable ingestion and bounded retrieval.*

This answer proposes an item-finding backend that cannot decrypt location reports.
The repository's backend does hold secrets and decrypt locations; its actual design
is described in [architecture.md](./architecture.md).

## 📋 Establish the trust model and scale — 4 minutes

> “I would begin by asking which parties are allowed to know an item's location.
> If the report service must not learn it, that changes key custody, queries,
> notifications and even how we approach unwanted-tracker detection.”

A nearby finder observes a tag, encrypts an approximate location for its owner and
uploads the report. The owner retrieves reports and decrypts them on an authorized
device. The backend stores and serves ciphertexts.

The finder necessarily knows its own observation. The owner learns the location.
The service sees some metadata, such as request timing and lookup tokens. Protecting
report contents does not automatically make all those interactions anonymous.

I would exclude radio firmware and a new cryptographic protocol from this interview.
We need a reviewed pairing/encryption protocol with explicit interfaces, not a
hand-written curve implementation on the whiteboard.

Assume one billion reports/day, roughly one kilobyte each, with a peak of one hundred
thousand reports per second. Average load is about 11,600 per second and raw storage
is about one terabyte/day. These are sizing assumptions, not deployed usage figures.

At seven days of retention, payloads occupy about seven terabytes before replication
and indexes. I would target regional durable acceptance below 300 ms at p99 and
bounded retrieval below 500 ms at p95, then validate those targets under load.

Time to find an item has no fixed bound: no nearby finder means no new observation.
Our backend latency target starts when a report reaches us, not when the owner
first notices that the item is missing.

## 🏗️ Architecture and responsibility — 4 minutes

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ Finder devices  │─────▶│ Ingestion API   │─────▶│ Durable log     │
│ Encrypted report│      │ Validate, admit │      │ Stable identity │
└─────────────────┘      └─────────────────┘      └────────┬────────┘
                                                           ▼
                                                  ┌─────────────────┐
                                                  │ Storage workers │
                                                  │ Idempotent sink │
                                                  └────────┬────────┘
                                                           ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ Owner device    │◀────▶│ Query API/cache │◀────▶│ Report store    │
│ Derive, decrypt │      │ Bounded batches │      │ Token/time index│
└─────────────────┘      └─────────────────┘      └─────────────────┘
```

Account and pairing metadata can live in PostgreSQL. Report storage has a different
access pattern: append opaque envelopes and retrieve them by rotating token and
bounded time range. Its partitioning can evolve independently.

The durable log absorbs bursts and gives workers a replay source. At a smaller scale,
a direct transactional report insert is a simpler valid acceptance boundary. I would
choose between them based on measured burst handling and replay requirements.

A cache accelerates queries but does not decide whether a report was durably accepted.
Notification work has its own identity and consumer. Safety detection belongs in a
nearby device/platform path, not in a worker that supposedly reads encrypted coordinates.

The key manager is intentionally on the owner side of the diagram. Adding a server
helper that derives all owner keys would invalidate the central confidentiality claim,
even if the report table still contained only encrypted JSON.

## 💾 Data model and service contracts — 4 minutes

| Record | Key fields | Purpose |
|--------|------------|---------|
| Account / pairing metadata | Account, item reference, authorized endpoints and lifecycle state | Manage ownership without storing report decryption secrets |
| Report envelope | Stable report ID, lookup token, protocol version and ciphertext | Preserve one report identity across retries |
| Stored report | Envelope plus server receipt time and storage bucket | Bounded retrieval and retention |
| Ingestion progress | Durable position and sink outcome | Replay and visibility lag |
| Notification intent | Notification ID, subscription scope, event version and expiry | Independent delivery/recovery lifecycle |
| Consumer receipt | Consumer identity and event identity | Avoid repeating that consumer's database effect |

The encrypted observation contains its claimed observation time, location and accuracy.
The server records receipt time independently. It cannot validate an encrypted time
by checking the time on its own clock.

| Contract | Required semantics |
|----------|--------------------|
| Submit report | Validate envelope, preserve identity, acknowledge a defined durable boundary |
| Query reports | Cap tokens, time span, result count and bytes; provide continuation |
| Manage pairing | Verify the relevant ownership/possession transition |
| Update lost mode | Define contact visibility and concurrent-edit behavior |
| Subscribe for hints | Define token association, expiry and notification scope |

An authenticated request can support quotas without proving ownership of every lookup
token. Confidentiality still depends on decryption keys, and the privacy cost of
linking a query batch to an account must be acknowledged.

I would keep cryptographic envelope versioning explicit so validation and client
support can evolve without accepting arbitrary unbounded JSON as a protocol.

## 🔧 Deep dive: Protect contents without claiming complete anonymity — 9 minutes

> “The privacy boundary is about who has decryption capability. A missing foreign
> key is useful schema separation, but it is not a cryptographic guarantee.”

### Key custody decides the boundary

Pairing establishes key material on the trusted item/owner endpoints. A nearby finder
can encrypt to the item's broadcast public material without receiving the owner's
private decryption secret.

The service stores the envelope under a lookup token. The owner derives the required
tokens and corresponding private capability for the requested period, retrieves
ciphertexts and decrypts locally.

I would use a reviewed protocol and implementation. Merely hashing a master secret
and adding a random “ephemeral key” field does not create asymmetric encryption.
The encryption and lookup derivation must have their intended security relationships.

If the server stores the master secret, it can derive report identities and decrypt.
Encrypting that secret with a server-accessible KMS improves some storage protections,
but the running service still has the capability. It remains a server-trusted design.

The price of endpoint custody is recovery complexity. Losing every authorized copy
of the keys can make historical reports unreadable. Account recovery and encrypted
key recovery must be designed separately, not assumed to be the same operation.

### Rotation limits one kind of linkage

Rotating broadcasts removes a persistent radio identifier. It can make passive
linkage harder, but observations close in time and space may still be correlated.
A strong privacy claim needs a threat model rather than a statement that rotation
makes tracking impossible.

The service also sees request timing, sizes and network metadata. An owner sending
many tokens in one authenticated batch associates them within that request, even
when no database foreign key connects them to a device.

I would avoid logging token lists together with account identifiers unless there is
a specific need and retention policy. Aggregate latency and processing measurements
should not become an easier location-correlation dataset than the report store.

More frequent rotation increases the number of query tokens and the work needed
for historical retrieval. It does not require discarding a valid observation just
because its broadcast period has ended.

### Separate confidentiality from authenticity

A finder encrypting a location does not prove that it was physically at that location.
If anyone with public beacon material can submit an envelope, fabricated observations
are possible even when ciphertext integrity is correct.

Admission credentials, rate limits and plausibility checks can reduce abuse, but
each has limits and privacy costs. I would not promise a universal way for the
backend to verify physical truth without seeing the encrypted observation.

The owner client validates decrypted shape, timestamps and accuracy, and can compare
multiple reports before presenting a confident estimate. A report is evidence,
not an authoritative command to move the item on a map.

Bind the relevant protocol context to authenticated encryption so a valid ciphertext
cannot silently be interpreted under a different envelope version or lookup context.
The precise mechanism belongs in the reviewed protocol rather than improvised API logic.

### Keep safety processing compatible with privacy

An opaque-report backend cannot calculate a person's travel distance from hidden
coordinates. A centralized plaintext sighting service would be a new trust decision,
not a free feature of the same encrypted pipeline.

I would keep nearby unwanted-tracker observations in the platform's protected local
safety path. That path needs protocol support for repeated proximity despite identifier
rotation, and evaluation against both missed cases and ordinary shared-item use.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Endpoint key custody with minimized service metadata | Excludes service from location contents | Recovery, sharing and client security work |
| ❌ Server-held secrets described as “zero knowledge” | Convenient queries and notifications | Service compromise exposes decryption and correlation capability |

The chosen design also limits server features. Location-based analytics or geofencing
cannot simply be added to opaque storage; they must run on an authorized endpoint
or change the stated trust model.

## 🔧 Deep dive: Durable acceptance and idempotent effects — 8 minutes

> “I would define exactly what an accepted report means before choosing a broker.
> A client write buffer accepting bytes is not the same as durable storage.”

### Give a report one retry identity

The finder creates an ID for an observation and retains the same encrypted envelope
while retrying. If it re-encrypts with new random values for each attempt, a content
hash alone may treat every retry as a new report.

At the durable sink, the report identity has a uniqueness rule and a payload
fingerprint. The same identity and payload converge to one stored report. Conflicting
reuse is rejected rather than silently replacing an earlier observation.

An identity based on the server's current minute is not stable across network delay.
The same upload retried just after a minute boundary must not acquire a new logical
identity merely because the service received it later.

### Choose and expose the durable boundary

With a direct database path, return success after the report transaction commits.
With a log-based path, return accepted after the log confirms the required durability,
and expose that indexing may still be pending.

The worker writes the idempotent report effect, then acknowledges its log position
or queue delivery. If it crashes after storage but before acknowledgement, replay
finds the existing report instead of inserting another row.

The client may also lose the acknowledgement after acceptance. It retries the same
identity. The protocol must remain correct whether the first attempt reached the
service, reached storage, or only lost its response.

### Why a Redis claim is insufficient

Consider setting a cache marker before the database insert. If the insert fails,
a later retry can be labelled duplicate even though no report was stored. If the
marker contains no completed result, the duplicate response cannot prove success.

Setting the marker after the insert reverses the gap: a crash after insert but
before marking allows another insert. These are two sides of the same missing atomic
boundary between Redis and the durable database.

A cache can accelerate completed-result lookup, but the sink establishes whether
the effect exists. I would not replace that rule with an unmeasured claim that durable
uniqueness is too slow for the workload.

### Retry failures without silently discarding evidence

Transient failures need bounded retries and delay. Permanently invalid envelopes
should be classified, counted and placed in controlled diagnostic/dead-letter storage
where appropriate, with retention and privacy limits.

A queue only has dead-letter behavior if its configuration actually routes rejected
or expired messages somewhere. Rejecting with no requeue and no destination discards
work; logging the error is not a replay mechanism.

On reconnect, consumers must resubscribe and become ready again. Resetting a connection
variable does not restart an already registered consumer. Shutdown should stop new
work and drain or release active deliveries predictably.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Durable report identity and idempotent sink | Safe replay after lost responses and worker crashes | Indexing, replay horizon and recovery tooling |
| ❌ Independent cache claim plus ordinary insert | Simple fast-looking path | Lost unfinished work or duplicate durable effects |

If a stored report creates notification work, write a notification intent with that
effect or through a recoverable event pipeline. Each consumer deduplicates within
its own scope. A global “processed” marker cannot stand for several different effects.

Broker choice follows measured partitioning, replay and operational needs. There is
no universal throughput threshold at which one named product stops working and
another guarantees correctness.

## 🔧 Deep dive: Retrieve useful history with bounded cost — 8 minutes

> “Rotating identifiers make the owner do more than request one device row. I would
> bound that fan-out and design freshness around report arrivals, not around a
> coincidentally equal cache TTL.”

### Bound the lookup window

With a hypothetical 15-minute period, one day contains 96 intervals, plus possible
boundary coverage. A week is hundreds of lookup tokens. Arbitrarily long requests
can become expensive before the database is even queried.

Cap the token batch, time span, result count and bytes. Use continuation tied to
the query identity and storage order. A limit applied after fetching and decrypting
all matches does not bound server work.

Separate latest-location refresh from full historical retrieval. The owner can keep
known reports locally and fetch newer server arrivals, then insert their observations
into the correct historical order.

Use receipt-time progress for incremental delivery. If progress is based only on
the latest observation timestamp, a late-uploaded older observation can be skipped.
The client selects its latest location separately by observation time.

### Route reports independently of plaintext geography

A finder may upload in one region and the owner may query from another. Routing only
by reporter region requires a way to discover every region that may hold a matching
report, which can create expensive global fan-out.

I would route a token to a deterministic storage owner, or maintain an explicit
index directory. Regional ingress can forward to that owner while preserving the
report identity and the chosen durable-acceptance semantics.

Within storage, use token-based distribution and receipt-time buckets. This spreads
many tokens while allowing retention cleanup. Very hot tokens may need subpartitioning
or per-token caps, with a query strategy that knows about those subdivisions.

The owner cannot query on latitude if the service does not have it. That privacy
constraint shapes the index; it cannot be wished away by adding a spatial database.

### Cache by query and freshness

Stable time windows and cursors make cache reuse possible. Including freshly generated
millisecond timestamps in every key can produce a new cache entry on every poll.
Canonicalization needs to preserve the actual requested bounds.

Recent negative results should have a short lifetime because a delayed finder can
upload a useful report at any moment. A key-period boundary does not mean reports
for that period are complete or irrelevant.

Longer historical caching needs an explicit late-arrival policy or version. Otherwise
an owner querying yesterday can continue seeing an old incomplete bucket after a
new report arrives for it.

If any endpoint serves account-private derived data, authorization precedes cache
return. A device-keyed cache hit does not prove the requesting user owns the device.
The same rule applies after ownership changes or device deletion.

### Retention is storage behavior

A default seven-day query window is not a retention policy. Old rows remain until
an actual cleanup process removes them. Include raw reports, diagnostic queues,
backups and logs in the intended lifecycle.

Use controlled bucket expiration where appropriate, and monitor that cleanup runs.
Dropping data earlier than the promised recovery window can make otherwise correct
retry and historical-query semantics impossible to honor.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Token routing, receipt-time progress and bounded queries | Predictable cost and late-report recovery | Directory/partition management and explicit freshness policy |
| ❌ Full-history polling with rotation-matched cache expiry | Simple initial query | Repeated work, stale misses and missed late data |

I would begin with PostgreSQL at local scale and validate its indexes and query plans.
A distributed wide-column store becomes a candidate when measured volume warrants
it; changing storage does not remove query bounds or replay requirements.

## 🛡️ Lost mode, safety and operational access — 4 minutes

Lost mode has two distinct features: publishing chosen contact information for a
physical finder, and notifying the owner that useful new reports may exist.
Neither requires exposing the owner's entire location history publicly.

For notifications, the owner can poll for new reports or register scoped short-lived
token subscriptions. The latter reduces polling but lets the service associate those
tokens with a delivery destination. That metadata trade-off must be explicit.

Contact settings need versioned updates or a clear conflict policy. Ownership checks
apply on every change. Disabling lost mode should not accidentally retain an active
subscription indefinitely, and a late notification should resolve against current state.

Unwanted-tracker safety uses platform-supported nearby observations and maintained
actions. Do not equate a simple count/distance heuristic with calibrated protection,
or report an alert count as the number of actual stalking incidents.

Admin access should expose the operational information needed to run the service,
not owner decryption keys. UUIDs and missing foreign keys are not authorization
controls. Logs and metrics must not recreate the private associations the data model
was meant to avoid.

A report service also needs bounded admission and a trusted proxy policy. Authentication,
per-client quotas and envelope limits should work together; accepting arbitrary
forwarding headers as authoritative undermines IP-based controls.

## 🧪 Validate guarantees and failure modes — 4 minutes

I would test the trust and durability boundaries with real components:

1. Verify that backend storage, logs and APIs contain no owner decryption secrets.
2. Retry one envelope across time boundaries and lost acknowledgements.
3. Crash a worker after insert but before acknowledgement and replay it.
4. Receive an old observation after the owner's newest known observation.
5. Query across rotation boundaries with bounded pages and continuation.
6. Exercise broker reconnection, poison messages and retention cleanup.
7. Change ownership while a private cache entry exists.

Crypto test vectors and review establish protocol compatibility; a successful
round-trip with the same buggy helper does not establish a secure protocol.
Radio and safety behavior require platform/hardware validation beyond HTTP tests.

Track durable acceptance latency, storage lag, retry outcomes, query cost and cache
freshness separately. A healthy HTTP process does not mean workers are connected or
that accepted reports are becoming queryable.

The local repository is useful for studying these boundaries precisely because its
server-held keys, separate synchronous/queued semantics, unfinished deduplication
and stale-cache behavior differ from this proposal. Those differences belong in
the implementation document instead of being hidden by a production diagram.

> “The backend can be simple about location contents because it stores opaque
> reports. It still needs careful identities, bounded queries and recoverable
> delivery. Privacy changes what it may know; it does not remove distributed-system
> failure modes.”
