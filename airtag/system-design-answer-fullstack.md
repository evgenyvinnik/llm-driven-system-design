# AirTag — Full-Stack System Design

*A 45-minute discussion of the journey from a nearby observation to an owner's map.*

This is a proposed item-finding system, not a description of Apple's internal
implementation. The repository is a server-trusted web simulation; its concrete
behavior and limitations are documented in [architecture.md](./architecture.md).

## 📋 Frame the product and its promises — 4 minutes

> “I would start with the owner who has misplaced a backpack. They need to know
> where it was last observed, how old that observation is, and what they can do
> next. A convincing dot on a map is not enough if it suggests certainty we lack.”

A small tag broadcasts a changing identifier. Nearby participating devices observe
it and upload encrypted reports. An authorized owner retrieves and decrypts those
reports, then sees an approximate location and time.

There are three experiences to consider:

- The owner manages items, views observations and enables lost-item contact options.
- A finder device contributes reports through a platform integration.
- Someone near an unwanted tracker receives a safety warning and useful next steps.

The web application can implement the owner's dashboard. Background Bluetooth
scanning, secure pairing, ranging and tracker safety require native/platform work.
I would establish those boundaries before committing to a browser-only solution.

For the interview, I would prioritize pairing, reporting, history, lost mode and
unwanted-tracker protection. Navigation and nearby sound/ranging are integrations
whose availability depends on the item and the current platform.

I would assume one billion reports/day, about one kilobyte each, and seven days of
retention. That is roughly 11,600 reports/second on average and one terabyte/day
before indexes and replicas. These figures size a proposal; they are not measurements.

Two product constraints guide the design:

1. The report service should not hold keys that decrypt location contents.
2. The UI must distinguish an old observation from a failed attempt to refresh it.

A third constraint is safety: protecting an owner's privacy cannot mean ignoring
people affected by an unwanted tracker.

## 🏗️ Draw the observation-to-screen path — 5 minutes

```
┌─────────────┐     ┌────────────────────┐     ┌─────────────────┐
│ Item beacon │────▶│ Nearby finder / OS │────▶│ Ingestion API   │
│ Rotating key│ BLE │ Encrypt and upload │     │ Durable accept  │
└─────────────┘     └─────────┬──────────┘     └────────┬────────┘
                             │                         ▼
                    ┌────────▼──────────┐     ┌─────────────────┐
                    │ Local safety path │     │ Report log/store│
                    │ Detect and inform │     │ Opaque envelopes│
                    └───────────────────┘     └────────┬────────┘
                                                       │
┌───────────────────────┐     ┌─────────────────────────▼──────┐
│ Owner app             │◀───▶│ Query API and bounded cache    │
│ Keys → decrypt → map  │     │ Token batches and continuation │
└───────────────────────┘     └────────────────────────────────┘
```

I would explain one report through this drawing rather than add a box for every
library. The finder encrypts an observation using the advertised material. The
service durably accepts the envelope. A worker makes it queryable. The owner app
retrieves candidate envelopes, decrypts them locally and updates the observation view.

A reviewed protocol defines how pairing, rotating public material and owner keys
work. We would use a vetted implementation, not invent cryptography during this
interview. Rotating lookup tokens alone do not provide owner-only decryption.

Account services manage item names, ownership and access to encrypted key material.
They do not become a back door that hands the report service plaintext private keys.

The report store initially exposes an append-and-query interface. We can start with
a relational implementation at development scale, then partition by token hash and
time bucket as report volume requires. A durable log helps absorb production bursts.

Map rendering, external tiles and navigation are also part of the privacy boundary.
An encrypted report service does not prevent a map provider from observing tile
requests that reveal a viewport. We need an explicit provider and logging policy.

## 💾 Agree on data and interaction contracts — 4 minutes

| Data | Contents and responsibility |
|------|-----------------------------|
| Item metadata | Owner, display name, capabilities and ownership version |
| Protected owner key material | Local/private key state and encrypted recovery or synchronization material |
| Report envelope | Stable report identity, lookup token, ciphertext, receipt time and expiry |
| Owner observation | Decrypted location, accuracy, observation time and validation outcome; private client state |
| Lost-mode preference | Enabled state, intended contact details and a version for updates |
| Notification delivery | Event identity, recipient policy, delivery state and retry history |

Observation time and receipt time answer different questions. A finder may upload
an observation much later. The report store can order ingestion by trusted receipt
metadata; the owner app chooses the latest usable observation from decrypted data.

| Operation | Contract |
|-----------|----------|
| Pair/register an item | Establish ownership and protected key custody |
| Submit report | Retry with the same identity; acknowledge the documented durability boundary |
| Retrieve reports | Bounded token batch, time coverage and continuation for newly received reports |
| Change lost mode | Authorized update with a version and clear notification preference |
| Request nearby action | Return capability, delivery and completion states where supported |
| View safety information | Provide a platform-supported warning and relevant next steps |

These are proposed contracts, not a promise that every route exists in this demo.
The backend cannot truthfully offer a plaintext “latest coordinate” endpoint while
also claiming that it cannot decrypt report contents.

For the frontend, I would organize the screen around an item list, selected-item
summary, map/history and an action panel. A notification/safety entry point remains
reachable independently of the selected item's map.

Shared UI state holds the signed-in identity, item selection and lightweight display
preferences. A query layer holds account- and item-scoped results. Private keys live
behind a narrow platform/key-store interface, not in a general debugging-friendly store.

## 🔧 Deep dive 1: Keep privacy intact through the whole feature — 8 minutes

### Decision: decrypt on the authorized owner device

> “I would keep the report service unable to decrypt locations. That protects the
> stored report contents if the service's data is exposed, but it moves meaningful
> work into pairing, recovery, query design and the client.”

The finder needs enough public material to encrypt a report. It should not receive
the owner's private key. The owner derives or retrieves the matching private material
through the pairing and protected synchronization protocol.

The server stores ciphertext and indexes it with lookup tokens. During retrieval,
the owner requests bounded sets of tokens for the desired interval and decrypts the
returned envelopes locally. Failed validation does not produce a map point.

The UI should have distinct states for:

- No reports were returned for the covered interval.
- Reports exist but none could be validated/decrypted.
- The device's protected keys are unavailable on this client.
- Retrieval failed before the requested interval was fully covered.

Collapsing those states into “not found” makes recovery harder and hides real defects.
We can phrase them simply without exposing protocol details to the owner.

### Why not keep a decrypting key service on the backend?

It simplifies search, recovery and notification generation. It also changes the
trust promise: a service with access to all keys can reconstruct location histories.
Putting that key service behind an internal API does not remove the capability.

A hardware security module can protect server-held secrets against some attacks,
but it does not make an authorized server decryption flow owner-only. I would choose
server-trusted encryption only if the product explicitly accepts that trust model.

For owner-side decryption, the cost is harder recovery. Losing all authorized keys
may mean losing access to historical reports. An encrypted backup/synchronization
mechanism needs its own account recovery and threat analysis.

### Metadata and the UI still matter

The server may observe query timing, token batches and account relationships.
Ciphertext confidentiality does not automatically conceal those associations.
We should minimize retention and access to such metadata, then assess whether the
remaining exposure is acceptable for the threat model.

The owner app is privileged because it sees plaintext. Analytics, crash logs, URLs
and screenshots can expose location data after decryption. Event reporting should
use coarse operational outcomes rather than precise coordinates or item secrets.

A browser client also depends on the integrity of delivered application code.
Protecting keys from accidental serialization is useful, but malicious same-origin
code may still access or use sensitive capabilities. Platform storage is one layer,
not an excuse to ignore script supply and application security.

On logout or account change, clear in-memory private results and stop pending work.
If we support local history, choose an explicit expiry and deletion policy. Offline
storage is a product decision with privacy costs, not an automatic performance win.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Owner-side decryption | Report service lacks plaintext location contents | Key recovery, client validation and query complexity |
| ❌ Server decryption for this trust model | Easier history queries and server-side rules | Service can reconstruct owner locations |

The deciding requirement is who may learn the location. Database encryption at rest
still helps operationally, but does not answer that product-level question.

## 🔧 Deep dive 2: Deliver updates without lying about freshness — 8 minutes

### Decision: reliable report identities and dated observations

> “I would connect backend delivery semantics to what the owner sees. Accepted,
> queryable and recently observed are three different conditions. Calling all three
> ‘live’ would hide both delayed uploads and storage failures.”

A finder assigns a stable identity before its first upload and preserves that identity
on retry. The ingestion service validates envelope size and admission policy, then
acknowledges a durable boundary: either a committed report or a durable log record.

Workers may receive the same envelope more than once. The report sink enforces a
unique identity so a retry does not add another history entry. Notification work uses
its own event identity; inserting a report once does not automatically send a push once.

If a worker commits a report and crashes before acknowledging the queue message,
redelivery finds the existing report. It can safely continue any separately tracked
follow-up work. We do not depend on an in-memory flag to remember that transaction.

### Why not use a Redis “seen” marker as the guarantee?

A marker written before the durable insert can suppress a retry after an insert fails.
A marker written after the insert has a crash window that allows duplicate inserts.
The two writes do not form a transaction simply because they usually happen quickly.

Redis can reduce repeated work, but the durable sink must preserve the invariant.
The price is a stable identity, uniqueness enforcement and a defined retry lifetime.
Those costs are justified when users depend on report history and notifications.

### Delayed reports change query and screen design

Imagine a point observed at 10:00 arriving at 10:20, after a 10:15 observation is
already visible. The new arrival can extend history, but should not move the latest
marker backward in time merely because its HTTP response arrived last.

The app selects the newest valid observation using observation time, subject to
reasonable clock validation. It separately shows when retrieval last succeeded.
A successful refresh cannot make a yesterday observation become “seen just now.”

For incremental retrieval, the server's continuation tracks receipt/index progress.
If it only tracks the newest observation timestamp, an older late upload may be
missed forever. The app deduplicates by report identity while incorporating new pages.

With rotating tokens, a refresh needs bounded coverage of the supported late-arrival
window, including older token periods where delayed reports may appear. A continuation
scheme must preserve that coverage; rotating the current token is not sufficient.

The latest-location display includes observation age and uncertainty. History can
show separate points or segments; a connecting line must not imply that we measured
the complete path between sparse reports.

### Prevent cross-item and cross-account races

The owner selects Keys, then Backpack before the Keys request finishes. A response
for Keys must never appear under Backpack's name, even if cancelling the network
request failed or the response was already queued for processing.

I would scope results by account, item and query coverage, and check a request or
selection generation before changing the visible selection's state. Cancellation
reduces wasted work; identity checks establish correctness.

The same rule applies after logout. A late response from the previous session cannot
repopulate the new account's private data. Query caches and pending operations follow
the account lifetime, not just the lifetime of a mounted map component.

### Polling and push trade-off

A selected item can poll at a moderate interval while the app is visible, with backoff
and manual refresh. Pause or reduce work in the background where the platform allows.
Batch latest-summary retrieval for the item list instead of unbounded per-item fan-out.

Push is useful for lost-item events, but a push should prompt retrieval rather than
serve as the sole source of history. It may arrive late, duplicate or be disabled.
Continuous socket connections do not create finder observations when none exist.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Durable identities plus bounded refresh | Recoverable delivery and understandable freshness | Sink constraints, continuation and client reconciliation |
| ❌ Cache flags plus “last response wins” | Simple happy-path implementation | Lost retries, duplicate history and misleading map changes |

I would first make the observation-to-screen contract correct. Then measurements
can guide whether polling, push hints or a persistent connection improve the experience.

## 🔧 Deep dive 3: Lost mode and safety need separate responsibilities — 8 minutes

### Decision: keep safety detection near the affected person

> “Lost mode helps an owner recover an item. Unwanted-tracker protection helps
> someone who may not own that item. I would design both paths explicitly rather
> than expect one server notification worker to solve them.”

In the proposed privacy model, the report backend cannot inspect coordinates to
infer that a tag is travelling with a particular person. A nearby device/platform
has the local radio observations needed for a safety assessment.

The protocol must support that safety path while identifiers rotate. Counting a
single hash for an hour is not a complete design if normal identifiers change more
often. This is a protocol and platform question, not just a database aggregation.

Local detection can consider sustained proximity, movement and ownership context.
Those signals need validation against noise, shared transport and other ordinary
situations. I would not present a toy distance/count threshold as a proven safety rule.

### Why not centrally join everyone's location history?

It could make some correlations easier, but would require collecting information
that conflicts with the location-confidentiality goal and creates a sensitive new
dataset. It also depends on observing the affected person, not only the item owner.

Keeping detection local reduces central exposure and can operate when uploads are
unavailable. The costs are device power, platform integration, incomplete observations
and careful cross-platform protocol support. Those costs must be planned, not hidden.

### Turn alerts into a usable experience

A safety alert should explain what was detected and when, with access to supported
ways to identify or locate the tracker and relevant guidance. The exact actions
depend on hardware/platform capability and should be checked at the time of use.

A generic notification titled “Unknown tracker” with no follow-up screen is incomplete.
The person needs meaningful next steps, accessible text and a path back to guidance.
A map or color indicator alone cannot carry the warning.

No alert is not proof that no unwanted tracker is present. The interface should
avoid both unwarranted reassurance and claims that an uncertain signal proves intent.

### Make lost-mode state changes clear and recoverable

The owner edits contact details and notification preferences. These are private
account-scoped drafts tied to the selected item, not one shared form that survives
an item switch with another item's phone number still in it.

On save, the client sends the intended fields and the version it edited. The server
checks ownership and detects conflicting updates. A stale second device should not
silently overwrite a newer contact or notification preference.

For reports that might trigger a lost-item notification, the backend needs a privacy-
compatible routing design. One option is an explicit, time-limited subscription to
lookup tokens; that leaks a token-to-account relationship and must be evaluated.
Another is for authorized owner devices to retrieve and evaluate reports themselves.

I would make that trade-off visible rather than claim that an opaque backend can
magically match every report to a lost item with no metadata exposure.

Delivery retries use stable event identities and a cooldown/coalescing policy.
An owner usually needs a meaningful update, not a notification for every nearby
finder that submitted nearly identical observations.

### Hardware commands have their own state machine

“Play sound” is available only when a supported path can reach the item. An HTTP
acknowledgement may mean the request was accepted, not that a speaker made a sound.
Show sending, acknowledged/completed where observable, timeout and unsupported states.

Directions should use the chosen observation's coordinates and age. Nearby ranging
should identify its platform requirement. A simulated action belongs to an explicitly
labelled demo mode and should not imply a working hardware integration.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Local safety path plus explicit lost-mode policy | Serves affected people while limiting central plaintext collection | Native integration, protocol review and metadata trade-offs |
| ❌ One central location-correlation worker | Convenient single implementation point | Incompatible with opaque reports and incomplete safety context |

## 📈 Scale and degrade deliberately — 4 minutes

The first backend pressure is likely report ingestion and retention, not item-name
metadata. Partition reports by token hash and time bucket; route bounded queries to
relevant partitions. Expire data through an enforced retention process.

Replication, indexes and replay capacity multiply raw storage estimates. Hot areas
can create concentrated report activity, so test skew and bursts rather than relying
only on average reports per second.

The first client pressure is repeated work: per-item requests, overlapping refreshes,
large history payloads and too many rendered map points. Bound query pages and history
resolution before adding a complex global state framework.

A queue outage should produce an explicit acceptance failure unless another durable
path offers the same identity semantics. A worker outage can allow durable acceptance
while query freshness degrades; those states need different metrics and UI messages.

A query outage can leave the last valid observation visible with its original age
and an update error. It must not display an empty response as evidence the item moved
or disappeared. Private local caching, if offered, has an expiry and account boundary.

If map tiles fail, the item summary, time, approximate place and accessible actions
remain useful. If key access fails, we explain the need for an authorized device or
recovery path without pretending that the report service can decrypt on request.

## ✅ Validate the end-to-end promises — 4 minutes

I would prioritize tests around what the user might otherwise misunderstand:

1. Retry the same upload after a lost response and after a worker crash.
2. Deliver an older observation after a newer one without regressing the latest marker.
3. Retrieve a delayed report from an older rotation period through bounded continuation.
4. Switch items or accounts while requests and private-cache fills are in flight.
5. Keep an old observation visible with an honest age during a network failure.
6. Exercise conflicting lost-mode edits and notification retries.
7. Distinguish a simulated command, an unreachable item and confirmed hardware behavior.

Crypto compatibility needs reviewed test vectors and independent assessment. Safety
and nearby behavior need platform/hardware tests; HTTP mocks cannot establish them.
Accessibility testing includes keyboard selection, focus after dialogs and warnings
that remain understandable without relying on the map.

Operationally, measure durable acceptance latency, time until reports are queryable,
query completeness, client validation failures and notification outcomes. Avoid raw
coordinates, secrets and sensitive lookup tokens in routine logs or analytics.

The repository demonstrates useful pieces of this journey: item management, seeded
history, simulated reports and map rendering. It currently decrypts on the server,
has incomplete queue/cache semantics and lacks real radio, sound and safety integration.
That makes it a learning implementation rather than evidence that this proposed
privacy and reliability contract is already delivered.

> “I would judge the system by whether the owner sees a trustworthy observation,
> whether delivery survives ordinary failures, and whether people near a tracker
> have a meaningful safety path. Each promise has both a backend invariant and a
> visible product behavior.”
