# AirTag — Frontend System Design

*A 45-minute discussion of location evidence, private client state and safety actions.*

This answer proposes an item-finding client with owner-side decryption. The local
React demo instead receives server-decrypted locations; its actual capabilities and
gaps are mapped in [architecture.md](./architecture.md).

## 📋 Clarify what “find my item” means — 4 minutes

> “I would start with the owner selecting an item and seeing the best available
> observation. The interface must explain how old that observation is and what
> the user can do next. A marker on a map is not proof the item is there now.”

The core screens are an item list, selected-item map, observation details, lost-mode
settings and notifications. Nearby finding and sound playback are available only
through supported hardware/platform capabilities.

I would ask whether we are building a web dashboard, a native mobile client or both.
For this answer, I use a web presentation layer and a platform adapter for capabilities
that require a native app. I would not promise background radio scanning from an
ordinary browser tab.

Unwanted-tracker alerts are also in scope. Their audience is the person who may be
carrying an unknown item, which is a different role from the item's owner.
The two flows must not expose each other's private observations.

I would keep family sharing, AR overlays and a full historical playback editor out
of the first design. The priority is a clear, reliable transition from last known
location to an appropriate next action.

The experience should distinguish four situations:

- A recent approximate observation is available.
- Only an older observation is available.
- The client cannot currently refresh or decrypt.
- No valid observation is known for the selected time window.

These are not interchangeable “offline” states. In particular, no report does not
prove that the item is unreachable or that an unknown tracker is absent.

## 🏗️ Draw the client boundaries — 5 minutes

```
┌─────────────────────┐       ┌────────────────────────────┐
│ Item list / map     │◀─────▶│ Observation data layer     │
│ Time, accuracy,     │       │ Identity, merge, freshness │
│ selected item       │       └────────────┬───────────────┘
└─────────────────────┘                    │
                                  ┌───────▼──────────────┐
┌─────────────────────┐           │ Owner key / decrypt  │
│ Lost mode / alerts  │           │ boundary             │
└──────────┬──────────┘           └───────┬───────────────┘
           │                             ▼
           └───────────────────▶┌────────────────────────┐
                                │ Auth / report APIs    │
┌─────────────────────┐         └────────────────────────┘
│ Native capability   │
│ adapter / safety UI │
└─────────────────────┘
```

I would use React and TypeScript for the web UI. A small store can hold selected
item identity and shared UI state. A data layer handles request keys, cancellation,
response validation and observation merging.

Cryptographic operations live behind a narrow interface rather than inside map
components. The key manager can report locked, available, unavailable or recovery
required. The UI cannot interpret every decryption failure as an empty result.

The native adapter reports capabilities and progress for nearby finding, sound and
safety actions. Unsupported hardware gets an honest unavailable state, not a fake
arrow or successful command acknowledgement.

For the web map, Leaflet is a reasonable starting point for markers and simple
history. Native clients may use platform maps. I would choose each based on actual
platform requirements rather than assume one web library supplies native radio access.

I would draw only these boundaries initially. The interview should focus on where
truth and authority come from, not an exhaustive component tree.

## 💾 Own state and request identity — 4 minutes

| State | Owner | Important boundary |
|-------|-------|--------------------|
| Selected item and time window | Route or explicit client navigation state | Restorable without putting secrets in the URL |
| Device metadata | Authenticated data layer | Scoped to current account and ownership |
| Ciphertext reports | Report cache | Stable report IDs and bounded retention |
| Decrypted observations | Protected client state | Do not send to analytics or generic server caches |
| Keys | Dedicated key boundary | Never ordinary persisted UI state |
| Lost-mode draft | Form state | Separate unsaved edits from accepted settings |
| Safety alert | Nearby platform's safety state | Independent of the owner's item list |

Every request belongs to an account generation, item and time window. A response
must match those identities before it changes the visible screen. This also applies
to a decryption worker finishing after a user changes accounts.

| API or adapter operation | UI contract |
|--------------------------|-------------|
| List items | Stable IDs, display metadata and authorization state |
| Query reports | Envelopes, report IDs, continuation and processing status |
| Decrypt batch | Valid observations plus per-report failure information |
| Update lost mode | Accepted version or a conflict; explicit contact disclosure |
| Nearby action | Capability, progress and observed result |
| Read safety alert | Evidence summary and supported next actions |

The server and client should distinguish transport success from a useful new
observation. An HTTP 200 with old reports does not mean the item was just seen.

## 🔧 Deep dive: Show location evidence without inventing movement — 8 minutes

> “The hardest map bug is often a state bug. A delayed response can put one item's
> coordinates under another item's name, and a late old report can make the marker
> appear to move backward.”

### Separate observation time from refresh time

A finder may observe an item at 10:00, upload at 10:20 and have the owner retrieve
it at 10:21. The item was last observed at 10:00. “Updated just now” would be misleading
unless it clearly refers only to the refresh operation.

I would store observation time, receipt time where available, and the client's last
successful refresh separately. The visible location label leads with observation age
and accuracy. Network status is an additional indicator.

A successful refresh with no new reports preserves the older observation and its
age. A failed refresh also preserves it, but says that new information could not be
retrieved. Neither outcome should move the marker or reset its timestamp to now.

### Merge by identity and guard selection changes

Reports have stable identities. Decrypt and validate them independently, then merge
by ID so retries do not duplicate points in the history. Select the latest credible
observation by observation time, with a deterministic tie-breaker.

If an older report arrives late, add it to the history where it belongs. Do not use
arrival order alone to choose the main marker. An implausible future timestamp needs
an explicit policy rather than remaining “latest” indefinitely.

When the user switches from keys to luggage, clear or retain data only under the
correct item key. Cancel old requests when possible and reject old response identities
when they return. The same rule applies to work already running in a background thread.

Account changes invalidate all relevant generations. Clearing a store at logout is
insufficient if an earlier request can immediately repopulate it with private data.

### Keep the map stable and accessible

Center the map when an item is first selected or when the user chooses Recenter.
Do not automatically drag the viewport away from someone inspecting history on every
poll. Selecting another item should reset the relevant centering state deliberately.

Show an accuracy region when supported by the observation. The marker is an estimate,
not a precise doorway. Sparse history points can be connected to show order, but the
line must not imply the item was measured continuously along that route.

Keep a text alternative with item name, time and location/accuracy description.
Keyboard users need access to selection and details without operating the map.
Do not make color the only difference between recent, stale and unavailable states.

### Choose a refresh strategy

Start with polling while the item view is active, plus an explicit refresh action.
Pause or reduce work when hidden, avoid overlapping requests, and back off after
failures with a clear retry affordance.

The interval is a product and resource decision. Key rotation does not establish a
required polling interval; reports can arrive during or after a key period. Measure
how often refreshes produce useful information and their battery/network cost.

A push hint can trigger an incremental query, but reconnecting must still recover
reports from durable history. The hint is not the only record of a location update.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Identity-based incremental refresh with observation age | Stable maps and honest freshness | Merge logic and more explicit states |
| ❌ Replace one global array after each request | Easy initial implementation | Cross-item races, duplicate history and misleading latest points |

I would take the additional state modeling because a wrong item/location association
is much worse than a small delay. The interface can remain fast while retaining
uncertainty; it should not manufacture certainty to look responsive.

## 🔧 Deep dive: Owner-side keys and useful offline behavior — 8 minutes

> “Client-side decryption moves a privacy boundary, but it also makes key lifecycle
> part of the user experience. A login session alone does not guarantee this device
> can read location history.”

### Keep cryptographic capability separate

The owner obtains keys through secure pairing or encrypted synchronization from an
authorized device. The report server returns ciphertexts. The client derives the
necessary lookup tokens and decrypts reports locally.

I would use a reviewed protocol and supported crypto implementation rather than
designing elliptic-curve details in the UI. The interface exposes bounded operations:
unlock, derive query tokens, decrypt a batch and clear active material.

Browser crypto APIs do not promise hardware-backed storage on every platform.
Non-extractable keys can reduce accidental export, but malicious same-origin code
may still invoke operations or read decrypted output. Script integrity and dependency
control remain part of the privacy design.

Decryption can run in bounded batches off the main rendering path when needed.
Return progress for large histories, keep a cancellation generation, and render useful
valid observations without waiting for every malformed report to finish.

A failed envelope should not discard the entire batch. Separate unsupported version,
authentication failure and absent key states so the client can recover appropriately
without exposing raw cryptographic errors as confusing user messages.

### Define recovery honestly

If the user has no key on this device, show the supported transfer or recovery flow.
If recovery was never designed and all key copies are lost, the report server cannot
reconstruct plaintext from the account password alone.

Sharing an item also means distributing decryption capability. Removing a user from
an account list does not erase keys or plaintext they already received. The product
needs explicit future-access and key-rotation semantics rather than a misleading
instant-revocation claim.

The web client should never put key material into URLs, crash reports or general
Zustand persistence. Decrypted location history also needs a clear retention boundary
on shared devices, including logout and account switching.

### Make offline state useful without overstating it

Cache the application shell and a deliberately bounded set of report data. If keys
are available locally, the client can decrypt previously retrieved reports offline.
It cannot receive a new remote observation without a network path.

A last-known view should show both the observation's age and that refresh is currently
unavailable. Missing map tiles should not hide the text details or the selected item.
Plan tile access according to the chosen provider's supported caching policy.

I would start with opt-in or short-lived location persistence, especially for a web
client on a shared computer. Keeping unlimited plaintext history for convenience
creates a second location database outside the service's privacy controls.

Lost-mode edits made offline remain a draft. Do not display the setting as active
on the server until it is accepted. On reconnection, compare versions and preserve
conflicting drafts for the user to review.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Owner-side decryption and bounded protected offline data | Keeps report contents outside the service | Key recovery, client security and retention complexity |
| ❌ Server decryption with unrestricted browser persistence | Simple map API and easy reloads | Server and shared-device caches gain location access |

The choice is justified if excluding the report service from location contents is
an actual requirement. If the product chooses server-trusted tracking instead, the
documentation should say so. Merely naming a payload “encrypted” does not decide
which parties can read it.

## 🔧 Deep dive: Safety alerts and capability-aware actions — 8 minutes

> “An unwanted-tracker alert needs clear evidence and immediate useful actions.
> It should neither accuse a person from a heuristic nor reassure someone that a
> lack of alerts proves they are safe.”

### Separate the safety role from the owner role

An owner asks where their belongings were observed. A potentially affected person
asks why an unknown item appears to be moving with them. These are distinct data and
authorization contexts even when they share map components.

The nearby platform provides safety signals and a protected observation history.
I would not derive a stranger's full location history from the owner's tracking API
or upload every user's movements merely to simplify alert rendering.

Rotating identifiers complicate recognizing repeated proximity. The UI consumes a
reviewed platform/protocol result; it cannot assume all sightings with different
hashes are the same item, or that one hash remains stable for hours.

### Present evidence and actions together

An alert states that an unknown item was observed moving with the user, with relevant
time information and the source of that assessment. Essential help is visible at
first presentation; deeper technical detail can be disclosed separately.

A history map shows where observations occurred. It does not prove where another
person travelled or when an owner opened their tracking app. Avoid captions that
make those unsupported inferences.

Offer supported actions such as identifying the item, playing a sound when available,
viewing maintained disabling guidance and obtaining help. If the item can no longer
be reached, explain the unavailable action rather than claiming it was disabled.

Use platform-maintained guidance for specific devices. The application should not
substitute its own universal hardware instructions across different accessory models.
[Apple's unwanted-tracking guidance](https://support.apple.com/en-us/119874)

### Distinguish command acceptance from action completion

For sound, the states are request sent, connecting, command accepted, observed
completion where supported, and failure/unknown. A backend acknowledgement alone
cannot prove a physical accessory made a sound.

Nearby finding likewise needs a supported ranging signal and confidence. If direction
is unavailable, show that state instead of retaining an old arrow. A coarse radio
signal can support proximity feedback without proving an exact distance or bearing.

Haptic, visual and optional audio feedback can make supported finding more usable.
Each channel needs user control and accessible alternatives. Avoid requiring someone
to stare at a moving arrow while navigating an unsafe environment.

A Disable action in a demo that only changes a database flag must be labelled as
such. It cannot stand in for verified hardware disablement or stop a real tracker
from participating in another network.

### Balance alert fatigue and missed information

Do not suppress safety alerts solely because a user dismissed a prior notification.
Maintain a deliberate policy for repeat evidence and cooldown, with access to prior
alerts and clear limits on any acknowledgement.

Measure false positives, missed scenarios and time to useful warning with appropriate
consented evaluation. A fixed count/distance threshold is a starting heuristic,
not evidence that the system is calibrated for personal safety.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Clear evidence, visible help and verified capability states | Supports action without unsupported claims | More states and platform-specific integration |
| ❌ Minimal generic alert plus always-successful buttons | Compact UI and simple mocks | Hides useful help and can falsely imply protection |

I would keep language calm and direct while making the significance and next steps
clear. The design goal is informed action, not reducing concern by minimizing what
the system observed.

## ⚡ Performance, privacy and accessible controls — 4 minutes

Most owners have a small item list, so I would first bound network fan-out and report
history. Bulk latest summaries or bounded concurrency avoid launching hundreds of
independent requests if shared or organizational use expands.

Render the selected item's recent observations first. Older history can load on
demand. Cluster or simplify large point sets for display without modifying the
underlying evidence or using a smoothed line as a claim of an exact route.

Map tiles and external directions reveal a viewed area to another service. Make
external navigation deliberate and use the selected observation's actual coordinates.
Do not send location values to analytics merely to measure a button click.

Use labelled buttons for item selection, sound and notifications. Modal dialogs
need focus management, Escape behavior and focus restoration. A clickable card made
only from an unlabelled generic container is insufficient keyboard navigation.

Safety status changes need meaningful announcements, with enough restraint to avoid
re-reading every polling update. Color, animation and sound all require a text or
other accessible equivalent.

Protect form drafts from asynchronous replacement. Loading lost-mode settings after
opening a form must not silently overwrite user edits, and switching items must
not carry one item's contact message into another item's settings.

## 🧪 Validate the states that can mislead a user — 4 minutes

I would prioritize these scenarios over a test that merely finds a map container:

1. An old item's request completes after another item is selected.
2. Logout occurs while decryption and requests are still running.
3. A late upload contains an older observation than the current marker.
4. A request fails while useful cached history remains available.
5. Keys are unavailable, one envelope is invalid, or a protocol version is unsupported.
6. Lost-mode settings change in another session while a draft is open.
7. A nearby command is accepted but the accessory cannot be reached.

Use deterministic observation fixtures and controlled response ordering. Test keyboard
and screen-reader flows for the map alternative and safety actions. Real hardware
validation is required before claiming ranging, background scanning or sound behavior.

Measure time to useful observation, stale-view age, failed refresh recovery, main-thread
work and successful safety-action completion. Keep those measurements free of raw
location histories or key material.

The local project currently decrypts on the backend, polls selected history and
simulates actions. It lacks client key custody, offline storage, native safety
integration and several response-identity guards. Those are implementation limits,
not reasons to describe the proposed frontend as already built.

> “The map should preserve the difference between what was observed, what is known
> now and what the device can actually do. That distinction makes the product useful
> even when location data is delayed, connectivity is poor or a safety action fails.”
