# Apple Music — frontend system design interview

> “I would design the frontend around uninterrupted listening. Browsing can change
> the screen, a library edit can fail, and recommendations can refresh, but none
> of those events should accidentally restart the track or replace the user's queue.”

This is a proposed 45-minute design for a web music service. It does not describe
Apple's proprietary implementation. The final section connects the design to the
smaller demonstration in this repository.

## 🧭 Scope and experience — 4 minutes

I would clarify whether we are building a browser player or a native application.
I will cover online web playback, search/discovery, personal libraries, and ordered
playlists. Native background policies, offline licenses, lyrics, and shared live
playlist editing are extensions rather than assumptions.

The user should be able to start an album, navigate to an artist, save a track,
and inspect the queue while the same playback instance continues. Network errors
need an explicit recovery path without discarding the user's selections.

| Discussion | Minutes |
|------------|---------|
| Scope and experience | 4 |
| Frontend architecture and contracts | 5 |
| Deep dive: reliable playback | 11 |
| Deep dive: library edits and synchronization | 10 |
| Deep dive: discovery and large collections | 8 |
| Accessibility and validation | 4 |
| Trade-offs and local boundary | 3 |
| Total | 45 |

I would target immediate visual feedback after Play, and p95 audible playback
within one second on supported networks. Those are different milestones. Showing
a pause icon after a successful URL request does not establish that audio started.

The interface must distinguish loading, playing, paused, buffering, unavailable,
and playback blocked by the browser. It should also distinguish an unsaved library
edit from a confirmed one, particularly when the user is offline.

## 🏗️ Frontend architecture and contracts — 5 minutes

I would draw a persistent shell with playback outside the routed page content.
The important division is ownership of side effects, not a large component tree.

```
┌──────────────────────────────────────────────────────────────┐
│ Persistent shell: navigation, routed pages, player bar       │
└──────────────┬────────────────────────────────┬──────────────┘
               ▼                                ▼
┌─────────────────────────────┐  ┌─────────────────────────────┐
│ Playback controller         │  │ Library and discovery       │
│ Media element + queue       │  │ Query cache + pending edits │
└──────────────┬──────────────┘  └──────────────┬──────────────┘
               ▼                                ▼
┌─────────────────────────────┐  ┌─────────────────────────────┐
│ Authorization API + media   │  │ Catalog/library/sync APIs   │
│ Delivery URL or manifest    │  │ Versioned user data         │
└─────────────────────────────┘  └─────────────────────────────┘
```

A playback controller owns the media element, command sequencing, and playback
instance. A small store exposes observable state to controls and track rows.
React renders that state, while the controller performs loading and media actions.

A separate request cache owns catalog and discovery results. User-specific cache
keys include account identity. Local component state owns transient menus, input,
and focus, while a library operation queue owns unacknowledged edits.

I would use Zustand for the small shared stores and a query-cache library for
server data. Neither choice automatically provides persistence, conflict resolution,
or correct media behavior. Those contracts still need to be designed.

| State | Owner | Lifetime |
|-------|-------|----------|
| Current media source and playback events | Playback controller | Active playback instance |
| Queue entries and selected occurrence | Player store | Listening session; optional explicit persistence |
| Catalog pages and search results | Request cache | Bounded freshness by query identity |
| Saved membership and pending edits | Library model | Account-specific durable local state where supported |
| Search text, open menu, focus | Page/component | Current interaction |

The stream response includes the selected rendition, expiry, and playback identity.
The library response includes a revision and operation result. Search returns
stable IDs rather than forcing the UI to identify a recording by its display name.

## 🔧 Deep dive 1: reliable playback — 11 minutes

### One controller owns the media lifecycle

For initial online playback I would use an HTML media element. It already manages
fetching, decoding, and buffering for supported formats. We can later connect it
to an audio-processing graph if equalization or other effects become requirements.

> “I would start with the media element because our first problem is reliable
> playback and queue coordination. I would add lower-level scheduling only when
> a measured audio requirement demands it.”

Web Audio is not inherently incompatible with streaming; a media element can feed
an audio graph. The trade-off is how much scheduling and resource management we
need to own, not a claim that one API can only play and the other can only synthesize.

A long queue should contain metadata and entry IDs, not decoded buffers for every
track. Prefetch is bounded to likely next content and released when the queue changes.
That keeps memory and cellular transfer tied to near-term listening intent.

### Separate a command from an observed result

Pressing Play creates a new intent generation and starts URL acquisition. If the
user selects another track before that request completes, the old response becomes
obsolete. Cancellation helps, but checking the generation on completion is essential.

After setting a compatible source, the controller awaits the playback promise
and observes media events. The browser may reject script-initiated playback or an
unsupported format; the UI must reflect that outcome.
[Media playback contract](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)

The player state is more than a boolean:

| State | Meaning | Useful action |
|-------|---------|---------------|
| Resolving | Current intent is waiting for authorization/asset selection | Cancel or select another track |
| Loading | A valid source is preparing media | Show progress without claiming playback |
| Playing | Media reports active playback | Pause, seek, or skip |
| Buffering | Playback cannot advance for lack of data | Retain queue; explain delay |
| Paused | User or platform paused this instance | Resume the same instance |
| Failed/blocked | Source unavailable or browser refused playback | Retry, choose another track, or request explicit Play |

Events and promise completions also need instance identity. A late error from the
previous source must not mark the new track as failed. Cleanup removes listeners,
cancels pending prefetch, and ends accounting for that playback instance once.

StrictMode and remounts are useful stress cases for that cleanup contract. Duplicate
`ended` listeners can skip two tracks even when each callback is individually correct.

### Model queue occurrences explicitly

The queue has entry IDs because the same recording may appear twice. The current
position refers to an occurrence, not simply the first matching track ID.
Removing an earlier entry must not change the audio currently playing.

I would define previous, next, automatic end, repeat-one, and repeat-all separately.
For example, automatic completion may repeat the current track, while an explicit
Skip should follow the product's chosen behavior rather than accidentally inheriting
an implementation shortcut.

Shuffle should preserve a traversal history. Randomly choosing an index every time
can immediately repeat the same song, skip other songs indefinitely, and make
Previous unrelated to what the user actually heard.

Changing the queue invalidates only affected prefetch work. The controller should
not reauthorize the current track because a new item was appended to the end.

### Quality adaptation and transitions have distinct responsibilities

The server decides which renditions the user may access. The browser supplies
supported codecs, preferences, and useful network/buffer observations. A Wi-Fi
label alone cannot establish sustainable throughput for the whole track.

Whole-file delivery is an acceptable starting point when startup and stalls meet
our targets. It avoids manifest and segment coordination. The cost is limited
adaptation after playback begins and potentially wasteful downloads after skips.

Segmented delivery permits finer buffering and adaptation, but needs a compatible
packaging/player path. Quality changes must respect timeline continuity and codec
capabilities; they are not just replacing a URL while preserving currentTime.

| Approach | Benefit | Cost for this product |
|----------|---------|-----------------------|
| ✅ Media element with a controlled lifecycle | Browser-managed decoding and familiar playback behavior | Must handle browser restrictions and format limits |
| ❌ Decode the entire queue eagerly | Scheduling flexibility once everything is ready | Large memory use and unnecessary transfer after queue edits |
| ❌ Let each page own its own player | Simple page-local code | Navigation interrupts playback and fragments the queue |

I am giving up sample-level scheduling in the first version. If true gapless album
transitions are required, I would test a supported media pipeline with correct
boundary metadata and scheduling. Dual elements plus an `ended` callback can reduce
a delay, but do not justify a sample-accurate or “always under 10 ms” promise.

Crossfade is a different audible effect from gapless playback. The interface and
tests should not substitute one for the other without a product decision.

### Measure listening rather than seeking

A play event uses a playback-instance ID and accumulated eligible listening time.
Pauses, buffering, and seeking should not become time listened merely because the
position moved past a threshold.

The controller reports a qualifying event once, with retry identity if acknowledgement
is lost. Lightweight progress reports can be less durable. Recommendation updates
and play accounting should not be driven by an untracked timeout attached to a track ID.

## 🔧 Deep dive 2: library edits and synchronization — 10 minutes

### Make optimistic state understandable

Saving a track is a good optimistic interaction: the user knows the desired result,
and a failure can be explained without a destructive consequence. I would show the
saved state immediately with a pending indicator when confirmation takes time.

The client records an operation ID, item identity, desired membership, and local
order. The server returns the accepted result and library revision. Repeating the
same operation after a timeout should not create another logical edit.

> “I would preserve the user's intent as an operation until it is acknowledged.
> Optimistic rendering is only a projection of that intent; it is not proof that
> the server has durably saved the track.”

For a definitive rejection, remove or correct that operation and explain the error.
For an ambiguous timeout, keep it pending and retry or reconcile by identity.
Blind rollback can display an unsaved track even though the server committed it.

### Rebase pending work instead of undoing newer choices

Suppose a user saves a track, immediately removes it, and the save request then
fails. Restoring an old snapshot as “rollback” can reintroduce the track and erase
the later removal intent.

I would keep a confirmed server base and a small ordered set of pending operations.
The displayed library is the base with those operations applied. Acknowledgement
or rejection removes the relevant operation and recomputes the projection.

This model also helps on reconnect. Download remote changes into the confirmed
base, then reapply pending local intent according to the agreed conflict rules.
We do not need to postpone every sync indefinitely whenever any edit is pending.

| Approach | Benefit | Cost for this interaction |
|----------|---------|---------------------------|
| ✅ Confirmed base plus identified pending operations | Responsive UI with recoverable concurrent edits | Reconciliation and durable local queue management |
| ❌ Restore the whole previous array on any error | Easy optimistic prototype | Can erase later local or remote changes |
| ❌ Wait for the server before every visual change | Simpler client state | Poor feedback on slow mobile connections |

I would accept more client state logic for library membership because repeated
use makes latency noticeable. A complicated bulk destructive edit may warrant a
server-confirmed preview instead of applying the same optimistic policy everywhere.

### A sync cursor is a completeness promise

The browser starts from a consistent snapshot, then requests pages after its last
applied revision. It advances only after applying the entire page successfully.
Each change carries enough identity to update or remove the intended item.

The server must ensure the cursor cannot pass an unseen committed change. The
frontend cannot repair an unreliable feed by polling more often: once the cursor
skips a change, every later poll may consistently omit it.

I would ask the backend to serialize each owner's membership, change-log entry,
and revision in one transaction. A token from a database sequence alone does not
establish commit order. A later separately read maximum is also unsafe as a page cursor.

If the device returns after log retention has expired, the API explicitly requests
a new snapshot. We replace the confirmed base atomically, retaining pending local
operations for reconciliation. A full snapshot is a valid recovery tool, not an
inherently lossy conflict-resolution algorithm.

Push can tell devices that newer revisions exist, while the delta API remains the
recovery source of truth. Lost push messages must not permanently lose edits.
A refresh on foreground/reconnect is a useful initial solution before adding sockets.

### Keep account and playlist boundaries explicit

Local library data and pending operations are scoped to an account. Signing out
must not leave one user's queue of mutations ready to run as the next user.
Account changes cancel requests and clear or isolate user-specific caches.

Playlist entries need stable occurrence IDs and a playlist revision. Dragging an
entry can be rendered optimistically, but the server may reject a stale reorder
when another device has edited that playlist.

For the initial single-owner product, I would refresh and explain that conflict
rather than inventing a full collaborative editing protocol. A retained operation
can be retried against the new revision if its intent remains meaningful.

## 🔧 Deep dive 3: discovery and large collections — 8 minutes

### Cache results by the question they answer

Catalog metadata and personalized sections have different freshness and privacy
requirements. Album details can use an album/version key; recommendations need
account identity and an expiry appropriate to the product's update frequency.

Cached content stays visible while refreshing when it remains useful. If a section
fails, keep the player and other sections usable. A search error should not be
presented as “no matching songs,” and failed personalization should not silently
show a previous account's recommendations.

I would have section contracts distinguish albums, tracks, artists, playlists,
and radio. A renderer should handle each supported type deliberately, with an
observable fallback for an unsupported response rather than an empty heading.

### Debounce search, then guard response identity

After a short debounce, query text and filters identify the request. Results are
accepted only while that identity remains current. An older slow response must
not overwrite a newer query or reappear after clearing the field.

The search input can use a combobox when results are an interactive suggestion
list. A full categorized results page has different navigation semantics. I would
choose one understandable pattern and support keyboard selection and dismissal.

Genre and search filters belong in validated route state when they should survive
navigation or sharing. Changing a URL parameter without consuming it in the data
query creates a control that looks functional while doing nothing.

The backend can start with basic text matching for a small catalog, but the UI
should not promise typo-tolerant autocomplete unless the retrieval API supports it.
Ranking and pagination also need stable tie-breaking to avoid repeating results.

### Virtualize large lists without losing user context

For a large library I would use TanStack Virtual and cursor-based page loading.
Only visible rows plus overscan enter the DOM. Catalog records and loaded pages
still require a separate memory policy; virtualization does not bound fetched data.

A responsive album grid can virtualize rows, with the column count derived from
available width. Measurement updates should preserve the user's scroll anchor
when images load or text wraps rather than repeatedly jumping the viewport.

| Approach | Benefit | Cost for this collection |
|----------|---------|--------------------------|
| ✅ Paged data plus virtualization for large collections | Bounds transfer and DOM work independently | Scroll restoration, measurement, and focus management |
| ❌ Render every loaded item indefinitely | Straightforward markup | Large libraries create layout and memory pressure |
| ❌ Virtualize but fetch the entire catalog first | Smaller DOM | Still pays the full download and data-memory cost |

I would keep small discovery sections simple. Virtualization adds little value to
ten album cards and can make focus behavior harder. It belongs where measured
list size and rendering cost justify it.

Focused rows should not vanish while the user is operating their menu. Keyboard
movement may need to scroll a target into the rendered window before transferring
focus. Stable entry IDs preserve selection as pages arrive or ordering changes.

### Keep playback updates from repainting the library

The progress slider needs frequent updates; thousands of track rows do not.
Rows subscribe to the minimal current-entry/playing state they display, while
progress rendering is isolated in the player.

Memoization still depends on correct identity. Ignoring all prop changes except
track ID can leave the title, saved state, or playback highlight stale. Optimize
measured work without freezing information the user expects to change.

## ♿ Accessibility and validation — 4 minutes

Transport buttons and seek/volume sliders need accessible names and values.
Track rows need a keyboard-operable play action rather than only a clickable div.
Menus must be reachable without hover and restore focus when dismissed.

Announce meaningful track changes and recoverable playback errors. Do not announce
every progress tick. Keep controls usable on narrow screens and avoid animations
that obscure buffering or conflict states.

I would test the coordination failures that a happy-path screenshot misses:

- Select two tracks while the first URL request is deliberately delayed.
- Reject playback permission and verify the player offers a truthful retry state.
- Mount/unmount the controller and verify one end event advances exactly once.
- Pause or seek around the play threshold without inventing listening time.
- Save/remove the same item rapidly while acknowledgements arrive out of order.
- Reconnect with pending edits and a cursor older than the retention floor.
- Switch accounts while library and recommendation requests remain in flight.

Measure audible-start latency, stalls, long tasks during scrolling, retained media
buffers, and sync convergence. Server URL timing and a rendered player bar cannot
substitute for those user-visible outcomes.

## ⚖️ Trade-offs and local implementation boundary — 3 minutes

The proposed frontend gives playback, server results, and pending user edits
separate owners. Its main cost is explicit lifecycle and reconciliation logic.
That cost protects continuous listening and prevents late responses from undoing
what the user just selected.

The local project uses React, TanStack Router, Zustand, and a single HTML audio
element. It has no media prefetch, gapless pipeline, query-cache library, persisted
player, virtualization, optimistic operation queue, or browser delta-sync consumer.

The supplied seed has no audio objects or audio-file records. Settings and several
admin/editor controls are display-only. Playback requests lack generation guards,
listeners lack cleanup, and the history timer measures position rather than actual
listening time. Those are current implementation boundaries, not completed features.

The [architecture](./architecture.md#implementation-notes) records the source details.
I would first establish a real playable fixture and a reliable controller lifecycle,
then connect recoverable library edits before adding more sophisticated discovery
or audio processing.
