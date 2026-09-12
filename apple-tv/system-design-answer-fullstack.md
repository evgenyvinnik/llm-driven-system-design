# Apple TV+ — fullstack system design interview

A 45-minute design for a subscription video library, balancing the viewer experience
with backend correctness. This is a proposed system, not Apple's internal
architecture. The local project supplies catalog/account workflows and a simulated
player; the production media pipeline is an extension.

| Discussion | Minutes |
|------------|---------|
| Establish scope and success | 4 |
| Draw one viewing journey | 5 |
| Deep dive: publish a playable title | 9 |
| Deep dive: start and sustain playback | 9 |
| Deep dive: resume in the right profile | 8 |
| Failure handling, scale and observability | 6 |
| Validate the design and relate it to the demo | 4 |
| Total | 45 |

## 🎯 Establish scope and success — 4 minutes

> “I would begin with one complete journey: an administrator publishes a movie, a
> subscriber watches it, and the same person resumes it on another device. That
> connects the frontend and backend choices without trying to design every streaming
> feature.”

Assume subscription video on demand, with movies, series/episodes, household profiles,
watchlists and basic recommendations. Each playable title has rights restrictions,
compatible media renditions and required audio/caption tracks.

Search and discovery should help people find something to watch, while playback makes
the final availability decision. Billing is integrated through a provider, and the
server owns entitlement state. A client-side paid badge is only a display of that
state.

I would defer live channels, offline downloads and sophisticated recommendation
models. Each adds a substantial problem: live timing, device license persistence or
model/data operations. The initial design should make a real title reliably playable
first.

For the frontend, I would assume responsive web plus contracts that native clients can
reuse. Television remote navigation and native media/protection adapters remain
platform-specific work.

My proposed target is p95 below two seconds from Play to the first rendered frame on
an agreed supported-device/network cohort. Backend authorization has a separate p99
200-millisecond target. I would track failed starts and rebuffering so a fast response
does not hide a broken experience.

I also want acknowledged progress to survive an API restart, profile switches to
isolate personal data, and publication never to expose a missing mandatory asset.
Those correctness properties matter before an ambitious availability percentage is
meaningful.

| Requirement | What the viewer or operator can observe |
|-------------|----------------------------------------|
| Complete publication | A ready title can start with every required track |
| Resilient playback | Transient failures have bounded recovery or a clear explanation |
| Profile isolation | Another viewer's history cannot flash into the active profile |
| Resume | An acknowledged position is recoverable after handoff |
| Rights enforcement | Stale catalog results do not bypass playback authorization |

## 🏗️ Draw one viewing journey — 5 minutes

> “I would draw media delivery separately from the control APIs. That separation
> explains both the scale and the client responsibilities.”

```
┌────────────────┐                  ┌────────────────┐
│ Viewer apps    │─ media ─────────▶│ CDN + shield   │
│                │                  │                │
└────────────────┘                  └────────────────┘
        │ control                           │ cache miss
        ▼                                   ▼
┌────────────────┐                  ┌────────────────┐
│ Domain APIs    │                  │ Private origin │
│ SQL / cache    │                  │                │
└────────────────┘                  └────────────────┘
                                            ▲ publish
                                            │
                                    ┌────────────────┐
                                    │ Encode workers │
                                    │ Queue / jobs   │
                                    └────────────────┘
```

Domain APIs cover accounts/profiles, catalog, playback authorization, progress and
subscription state. A protected license service participates in playback where the
chosen platform requires DRM. Its keys and personalized responses do not become public
CDN objects.

The browser route identifies a title or episode. A request cache owns fetched catalog
and personal data; a small store owns active context and controls. The media engine
owns buffering, decoding and rendition selection, and reports actual playback events
to the UI.

An administrator creates a draft source revision. Workers prepare immutable media,
validate it and publish an active revision. Catalog and search projections can update
asynchronously, while the playback API uses authoritative eligibility.

A Play request binds account, profile, title revision and device capabilities into a
playback session. The client receives bounded delivery authorization, prepares media
and resumes from accepted progress. Subsequent progress updates refer to the same
session.

The contracts are intentionally small:

| Contract | Required information |
|----------|-----------------------|
| Title detail | Stable title ID, episodes, availability, active media revision |
| Playback session | Session ID, media revision, access lifetime and license endpoint |
| Progress update | Session generation, sequence, position and base revision |
| Progress response | Accepted position/revision or an explicit conflict |
| Publish operation | Expected draft revision and required validated asset set |
| Subscription event | Verified provider event identity and ordered state |

At two million peak viewers averaging 6 Mb/s, media throughput is roughly 12 Tb/s.
Six-second video segments produce around 333,000 requests per second before audio and
retries. That is why bytes go through the CDN rather than the account API.

Fifteen-second progress saves still mean roughly 133,000 updates per second at peak.
This is a separate write-scaling problem, which I would address through coalescing and
profile ownership rather than placing progress writes in the media-serving path.

## 🔧 Deep dive: publish a playable title — 9 minutes

### Give the admin interface truthful states

> “I would distinguish an accepted upload from a published movie. The interface should
> never say Ready merely because a database row was inserted.”

The admin creates a draft with source identity, metadata, rights and required tracks.
The upload service permits a bounded upload to private storage, then verifies
completion and checksum. The UI displays the current durable phase and failed
validation reason.

Encoding jobs are identified by source revision and rendition profile. Retrying an
upload or job uses the same operation identity, so a lost response does not create
unrelated duplicate work. A new source edit receives a new revision.

The interface can poll job state while processing continues. It does not need a
WebSocket simply to show a minutes-long encode; a modest interval with a final refresh
is sufficient. The durable backend state, not the browser connection, determines
whether work exists.

A worker writes outputs to immutable paths and records validation. It checks
referenced objects, timing and track compatibility before reporting success. The
publication coordinator requires the complete mandatory set before advancing the
active pointer.

Optional high-quality outputs may follow later as another revision if a valid baseline
is allowed. That is different from exposing a playlist that names files still being
encoded.

### Make retries safe across boundaries

The database and queue do not share one transaction. I would commit the job with an
outbox record; a dispatcher publishes the queue message and retries until it has a
durable acknowledgement trail.

The worker can receive a job repeatedly. It checks the durable result for that
revision/profile and uses a claim version to prevent late workers from overwriting
accepted work. A worker lease helps recover a crash, but conditional acceptance is
what prevents a stale worker from winning later.

Uploads also need identity. Finding a filename is insufficient if it contains a
partial or different output. Validate the expected revision/checksum and keep
incomplete work outside the published namespace.

The final publication operation checks the expected draft revision. If an editor
changed the source while encoding was running, the old job cannot publish over the new
draft. The interface reports that conflict instead of silently discarding the newer
edit.

Existing viewers retain the revision with which they started. New viewers get the new
active revision. This avoids mixing tracks from different edits and makes rollback an
explicit pointer change.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Validate a revision before publication | Consistent playback, cache reuse, clear rollback | Upfront encode/storage cost and release coordination |
| ❌ Encode when the first viewer arrives | Less work for never-watched titles | Unpredictable first-view latency and release spikes |
| ❌ Make each finished asset visible immediately | Earlier partial output | Playlists can name an incomplete track set |

The cost I accept is work on content that may not attract viewers. I would control
that with a measured ladder and baseline-first policy, rather than make viewer startup
wait for encoding.

### Treat withdrawal as an access change

Withdrawing a title denies new playback authorization and updates discovery. It does
not instantly retract segments already buffered or licenses already issued. We need an
explicit expiry/revocation policy for existing playback.

The admin UI should distinguish catalog removal from that stronger access policy. It
should also show propagation status if a search or cache projection still has an older
revision.

Source/media retention must keep revisions used by active sessions long enough to
finish or expire. Garbage collection needs evidence that references are no longer
valid, not just that a newer revision exists.

## 🔧 Deep dive: start and sustain playback — 9 minutes

### Coordinate one playback attempt

> “On the frontend, Play is an intent. On the backend, authorization grants bounded
> access. Neither means a frame has appeared.”

The controller captures title, profile and a new playback generation. It asks the
server for authorization and fetches resume state. The server revalidates
account/profile association, entitlement, rights and supported device policy before
returning the selected media revision.

The client prepares a supported media engine, attaches the source and seeks after
timeline metadata is available. It reports Playing only after the engine does.
Unsupported media, a blocked autoplay request or license failure gets an explicit
state.

HLS provides adaptive renditions and can use fragmented MP4 as well as
transport-stream segments. The choice of protocol, package and protection system
follows the supported clients; HLS versus DASH is not a universal efficiency ranking.
[RFC 8216](https://www.rfc-editor.org/rfc/rfc8216)

For Apple-platform protected playback, integrate the documented FairPlay
client/key-server workflow with appropriate deployment credentials. Other supported
platforms need their own compatible protection integration. A base64 playback token
does not implement DRM. [Apple FairPlay
Streaming](https://developer.apple.com/streaming/fps/)

The media engine starts conservatively, observes sustainable throughput and buffer
depth, and changes quality with headroom. It should downgrade under pressure and avoid
repeated upgrades near a threshold. A manual quality selection needs a defined
fallback when the network cannot sustain it.

Quality and buffering labels reflect actual engine state. A catalog's HDR flag or the
presence of a quality menu cannot prove the bytes are HDR or that adaptive switching
happens.

### Separate delivery from control

The CDN serves immutable media after validating bounded authorization. The origin is
private. Authorized viewers of the same revision can reuse cached objects, using the
CDN's supported separation of credential checking and object cache identity.

Routing each segment through a database-backed account API would couple media scale to
session and subscription storage. Making the whole bucket public would avoid that
overhead but bypass the access decision.

License traffic stays on its protected path. Clear keys and user-specific license
responses are not shared public cache entries. Credentials have a renewal policy so an
otherwise healthy long film does not fail when access expires.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Bounded authorization plus CDN delivery | Media and account load scale separately | Expiry, renewal and revocation-window handling |
| ❌ Central API on every segment | Straightforward per-request checks | Dependency outages and bandwidth pressure affect every viewer |
| ❌ Public media bucket | Simple delivery | Anyone with a URL can bypass subscription/rights checks |

Shorter access lifetime limits stale authorization but increases renewal load and
outage sensitivity. I would choose the lifetime from product rights requirements and
measured renewal reliability, not treat one arbitrary TTL as universally correct.

### Handle races and failures together

If the viewer switches from movie A to B while A is authorizing, the old response must
not replace B. The controller increments its generation, cancels old work and checks
the generation again when callbacks arrive.

Cleanup removes listeners and destroys the old engine. It captures final progress
before clearing player state. The server receives that progress with the original
session identity, never whichever profile happens to be active when the request
completes.

A transient media fetch failure gets bounded retry. Expired credentials get one
coordinated renewal for the session. A repeated decode failure should stop retrying
and explain the problem. These categories need stable server/client error contracts.

CDN failover also needs a budget. Sending all viewers to origin when an edge fails can
turn a regional problem into a global outage. Preserve the playback session and
position while choosing a healthy path, and stop when recovery cannot meet the
contract.

I would use a supported media-engine adapter rather than an application-written ABR
loop. That adds integration work, but leaves specialized buffer and decoder behavior
with the component designed to handle it.

## 🔧 Deep dive: resume in the right profile — 8 minutes

### Bind personal state to its owner

> “A household profile is both a data boundary and a viewing context. I would make
> that identity explicit in requests, caches and progress records.”

Persisted profile selection is only a restoration preference. At startup, the client
obtains authenticated account/profile state from the server. A deleted or foreign
stored profile cannot unlock personal views.

When switching profiles, stop or hand off playback, confirm the new profile with the
server, clear personal rows and begin a new request generation. Public images can stay
cached; watchlists, recommendations and progress need profile-scoped keys.

Cancellation does not guarantee that every callback disappears. A late response checks
the captured account/profile generation before repainting the active screen. Otherwise
another family member's history can appear under the new avatar.

The server repeats ownership and policy checks on personal operations. A valid
selection from yesterday does not prove a profile still exists or belongs to the same
authenticated account today.

Kids restrictions must cover direct details and playback as well as discovery. A
hidden card is not an access check. Administrative roles similarly require server
enforcement even when the UI hides the admin tab.

### Model resume as accepted intent

Periodic progress updates carry a playback session, sequence and position. A
server-assigned revision identifies the accepted durable snapshot. Repeated delivery
of the same operation returns the same accepted result.

Within one session, higher sequences supersede lower ones. An explicit handoff
establishes a new active generation, so delayed work from the old device cannot
silently move the resume pointer.

The reason is concrete: a television reaches minute forty, then a laptop intentionally
rewinds to minute ten. Maximum-position merging loses the rewind. Client-clock
ordering can also fail when an old device has a fast clock or uploads after being
offline.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Session sequence and explicit handoff | Predictable retry/replay and intentional rewind | Extra state and a conflict policy |
| ❌ Largest position wins | Simple merge | Cannot preserve restart or rewind intent |
| ❌ Device wall-clock wins | Easy timestamp comparison | Skew and delayed delivery can choose stale state |

If the product allows simultaneous independent viewers on one profile, I would ask how
resume should behave. It may show multiple devices or let the person choose; no
storage algorithm can infer that choice without a policy.

### Keep history and synchronization distinct

Completion is a deduplicated viewing event, separate from the current resume pointer.
A rewatch has a new session, while repeated final saves from the same session do not
repeatedly add history.

The progress transition and required event publication intent commit consistently.
Otherwise a successful position update followed by a failed history insert leaves a
partial outcome that ordinary retries may not repair.

A fifteen-second save interval bounds typical abrupt-exit loss to about that interval
plus pending work. The controller keeps a stable scheduler that reads the latest
position; recreating it every second can prevent it from firing.

Pause, meaningful seek and handoff trigger additional saves. Capture a snapshot before
navigation cleanup. An unload send is useful but best effort, so it cannot replace
periodic acknowledgement.

During short disconnects, retain a bounded latest snapshot with
account/profile/session identity. On return, reauthenticate and compare its base
revision. An old offline snapshot should not overwrite a newer device's accepted
progress without resolving the conflict.

Watchlist updates can be optimistic if the contract sets membership explicitly. A
failed old Add must not roll back a newer Remove, and neither result may affect a
different profile. This uses the same intent/context discipline as progress without
needing the same high-frequency pipeline.

## ⚙️ Failure handling, scale and observability — 6 minutes

### Protect the viewing path

Recommendation failure should leave a useful generic catalog that still respects
availability policy. Progress failure should allow current media playback while
showing save uncertainty. A billing-provider incident should not force every segment
request through that provider.

Current entitlement comes from verified provider events and deliberate reconciliation.
Deduplicate webhook identities and handle out-of-order state so an old success cannot
resurrect a cancelled subscription. Client Subscribe feedback is not the authority.

For account and catalog reads, cache response dimensions deliberately. A key must
include profile/policy, filters and pagination where they change the result.
Publication events invalidate or version relevant projections, and operators can see
lag.

For encoding, isolate worker compute and use queue backpressure. Track the oldest
unprocessed job, not just the number of processes. A healthy worker process can still
be stuck on every useful job.

For progress, coalesce writes, partition by profile and keep history/analytics
asynchronous. If acknowledgement means a durable log append, handoff reads need a path
to that accepted revision even before a slower projection catches up.

Circuit breakers protect unhealthy dependencies but do not make successful fallback
media. A placeholder JSON body returned from a segment URL with HTTP 200 is still
failed playback. Timeouts also do not automatically cancel downstream work.

### Make frontend scale visible

Load a first useful shelf quickly, prioritize its hero artwork and reserve image
dimensions. Fetch independent rows concurrently, lazy-load lower shelves and paginate
large catalogs. Avoid one watchlist-check request per card when contextual membership
can be batched.

Virtualization is useful for large lists when it preserves focus and interaction.
Never unmount the focused TV card or an active player as an incidental scroll
optimization. Start with bounded lists and measure before adding complexity.

The player should not rerender every catalog component whenever time changes. Keep
high-frequency media state close to the controller and expose narrow subscriptions to
controls that need it.

Accessibility includes named buttons, keyboard/touch seeking, caption selection, focus
management and controls that stay visible while focused. Hover effects are optional
decoration, not the only way to discover Play or My List.

### Measure the actual outcome

| Signal | Interpretation |
|--------|----------------|
| Authorization success without first frame | Delivery, licensing or decode may be failing |
| Rebuffer ratio by supported device/network cohort | Quality policy may be too aggressive |
| CDN misses and origin saturation | Cache identity or release/failover strategy needs work |
| Progress acknowledgements versus projection revision | Handoff may read behind accepted writes |
| Publication/outbox age | Admin changes are accepted but not reaching viewers |
| Profile-context discard counts | Reveals races and rapid-switch behavior |

Keep account and session IDs in controlled correlation events, not unbounded metric
labels. Redact access credentials and license material. Aggregate telemetry should not
require exposing each person's viewing history to every operator.

A health response proves only the checks it performs. Database connectivity is not
proof that media exists, licensing works or the player renders. Use a representative
synthetic playback journey alongside component diagnostics.

## 🧪 Validate the design and relate it to the demo — 4 minutes

I would test the complete journey with deliberate failures. Upload a source, kill a
worker after object creation, redeliver the job and confirm that only a complete
revision becomes active. Then publish an edit while the old encode is finishing and
verify it cannot overwrite the new draft.

On the client, start A then B and delay A's authorization/progress responses. B must
remain the active title. Switch profiles during personal requests and verify neither
old data nor an old error appears in the new context.

For synchronization, lose a progress response after commit and retry it. The accepted
position should be recoverable without duplicate history. Rewind, hand off to another
device, then deliver the old device's pending update; the handoff policy must hold.

For delivery, expire credentials, withdraw a title, slow the network and fail the
license service. Check both visible recovery and access enforcement. A test that only
asserts an HTTP success cannot validate streaming.

| Decision | Resulting behavior | Cost acknowledged |
|----------|--------------------|-------------------|
| Revision-gated publication | Ready means required media is complete | Job validation and release coordination |
| Separate media/control paths | CDN capacity does not depend on every account query | Credential lifecycle and failure budgets |
| Explicit context and progress identity | Profile switches and retries preserve intent | State transitions and conflict handling |

The local application already has React routes, session/profile APIs, catalog SQL,
watchlists, simple recommendations and an admin dashboard. Its player advances time
over an image. Manifest URLs are stored but not played, video/audio segments are
empty, and DRM, transcoding, CDN and offline downloads are unimplemented.

Its progress timer, stale profile context, optional Redis replay middleware and
separate progress/history writes illustrate why the contracts above matter. The
[architecture](./architecture.md#implementation-notes) records those source-backed
limits, and the [README](./README.md) explains actual setup and the two incompatible
seed paths. I would validate one complete real-media journey before making claims
about production playback quality.
