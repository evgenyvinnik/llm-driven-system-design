# Settings Service — System Design Answer (Frontend Focus)

*Frontend engineer interview · 45 minutes · Requirements → Client architecture → State model → Writes → Sync → Policy UX → Deep dives → Traces*

> "I've been handed an existing preferences screen and asked what it needs to work correctly. From the client's side, 'correctly' means four things. The control shows the value that actually applies, and says why. A change feels instant but never lies about whether it saved. Two devices changing different things don't fight, and when they do touch the same thing, the user decides. And an open tab never shows a stale value for long. The backend contract I'll lean on is small: a document with a revision, a PATCH conditioned on that revision, per-field errors, and revision-keyed change events. Most of the design is the client state machine around it."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~4 min | Correct-and-honest beats clever; few settings, many surfaces |
| Client architecture | ~5 min | One settings client per surface: server doc, pending edits, write queue, live sync |
| Rendering and policy UX | ~5 min | Catalog-driven controls; source badges; locked and shadowed values |
| Writes | ~6 min | Optimistic display, one PATCH in flight, 409 and 422 handling, outcome unknown |
| Deep dives | ~15 min | State model, sync protocol, lost-response UX |
| Traces, checklist, follow-ups | ~7 min | One success, one failure, six review questions |
| Wrap-up | ~2 min | What I'd build next |

---

## 🎯 Requirements (~4 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Is the screen's list of settings fixed in the app? | Hard-coded controls vs catalog-driven | No. The server's catalog drives it, so a new setting appears without an app release |
| Save button or save-as-you-go? | Write granularity | Save as you go, per control, like every modern preferences screen |
| Can an org lock settings? | UX for locked controls | Yes. Admins enforce values; some settings are org-only |
| Multiple tabs and devices? | Sync scope | Yes. Tabs must agree instantly; devices within a couple of seconds |
| Does appearance apply live? | Settings affect the app shell | Theme, density, text size and reduced motion apply immediately, everywhere |
| Offline? | Queueing | Short outages only. Edits made then show "not saved" and retry; no offline-first store |

### Functional requirements

1. Render every setting from its definition: toggle, select, range, time, time zone, text.
2. Show the effective value, its source (yours, org default, enforced, default) and a lock.
3. Save each change immediately, with visible saving, saved, conflict and error states.
4. Reset a setting to its inherited value.
5. Reflect changes from other tabs, other devices and admins without a reload.
6. Org admin console: defaults, enforcement, member override counts. Catalog console: add and deprecate definitions.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Perceived latency | Instant on toggle | Optimistic display |
| Honesty | Never show "saved" for something that may not have saved | Explicit pending states, including outcome unknown |
| Cross-tab freshness | Same frame as the writing tab | BroadcastChannel |
| Cross-device freshness | p99 < 2 s | SSE push, not polling |
| Resilience | Any number of dropped events or connections heals itself | Revisions plus revalidation on reconnect and focus |
| Accessibility | Every control labelled; locks and errors announced | role=switch, aria labels, role=alert on conflicts |

---

## 🏗️ Client Architecture (~5 min)

```
┌──────────────────────────────────────────────────────────────┐
│ Preferences screen / admin console / app shell (theme etc.)  │
└──────────────────────────┬───────────────────────────────────┘
                           │ selectors (per key)
┌──────────────────────────▼───────────────────────────────────┐
│ Settings client (one per surface/device)                      │
│  ┌──────────────┐ ┌───────────────┐ ┌──────────────────────┐ │
│  │ server doc   │ │ pending edits │ │ write queue          │ │
│  │ revision,    │ │ key → value,  │ │ ≤ 1 PATCH in flight, │ │
│  │ org/catalog  │ │ status        │ │ later edits merged   │ │
│  │ revisions,   │ │ (saving,      │ └──────────┬───────────┘ │
│  │ entries      │ │ unknown,      │            │             │
│  └──────▲───────┘ │ conflict,     │            │             │
│         │         │ error)        │            │             │
│         │         └───────────────┘            │             │
│  ┌──────┴──────────────────────────────────────▼──────────┐  │
│  │ live sync: SSE (hello, user, org, catalog) ·           │  │
│  │ BroadcastChannel · refetch on focus                    │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────┬───────────────────────────────────┘
                           │ REST + SSE
                     Settings API (any instance)
```

> "The core abstraction is a settings client: a small store that owns one surface's view of one user's settings. This browser tab has one, and the app shell reads appearance from it. The demo screen creates two more, a 'phone' and a 'laptop', each with its own revision and stream, pointed at different API instances. Everything about sync lives in pure functions next to the store, so the rules are unit-tested without a browser."

| Piece | Responsibility |
|-------|----------------|
| Server document | The last document the server sent, with user, org and catalog revisions. Replaced only by a document that isn't older |
| Pending edits | What the user changed and hasn't been confirmed. Display value = pending value if present, else server value |
| Write queue | Sends one PATCH at a time with the newest revision as If-Match; merges edits made meanwhile |
| Live sync | Applies or ignores events by revision, refetches on gaps, shares results with sibling tabs |
| Sync rules (pure) | Response classification, event decisions, hello decisions, reconciliation after a lost response |

---

## 🎨 Rendering and Policy UX (~5 min)

### Catalog-driven controls

| Definition | Control | Commit point |
|------------|---------|--------------|
| boolean | Switch (role=switch) | On click |
| enum | Select with human labels | On change |
| integer, short range | Slider with live number | On release, key-up or blur, never per pixel |
| integer, wide range | Number field | On blur or Enter |
| string, hh:mm | Time input | On a complete value |
| string, time zone | Select of IANA zones | On change |
| string | Text field with a character counter | On blur or Enter |

> "Each control commits a complete value. PATCH sets values, it never toggles, so the switch sends 'off', not 'flip'. That one rule makes retries safe end to end. Sliders and text fields commit on release, so dragging doesn't send forty writes."

### What each row tells the user

| Source | Badge | Extra line |
|--------|-------|------------|
| Your choice | indigo "Your choice" | "Changed on Phone 2 min ago", plus a reset button |
| Org default | blue "Acme default" | — |
| Enforced | amber lock "Enforced by Acme" | "Acme requires this. Your own choice (Off) is kept and applies again if the policy is lifted." |
| Org setting | blue lock "Set by Acme" | "Only Acme administrators can change this." |
| Default | grey "Default" | — |
| Deprecated | grey chip "Deprecated · retires 26 Nov" | Control disabled; the old value is still shown |

> "The enforced row is where most screens fail users. A greyed-out toggle with no explanation reads as a bug. Saying who locked it, and that your own choice is kept underneath, turns it into a policy. The server already returns userValue for exactly this."

### Appearance applies live

Theme, density, text size and reduced motion are applied to the document root from the display value, pending edit first. Changing the theme on the phone turns the laptop's whole page dark when the event arrives. Surfaces use CSS variables, so the theme swaps one set of tokens instead of adding a dark variant to every element.

---

## ✍️ Writes (~6 min)

```
user edits key ─▶ pending[key] = queued ─▶ queue idle? ─▶ PATCH {all queued keys}
                                                           If-Match: held revision
       ┌─────────────────────┬─────────────────────┬──────────────────┬───────────────────┐
       ▼                     ▼                     ▼                  ▼                   ▼
      200                   409                   422             412                no response /
 adopt doc;            adopt current doc;     mark fields      refetch (force),     5xx / timeout
 clear keys whose      conflict on those      as error;        requeue              mark "unknown";
 value didn't change   keys; requeue the      requeue others;                       refetch; reconcile
 in flight             others                 refetch if LOCKED
```

| Response | Pending state | UI |
|----------|---------------|----|
| 200 applied | Cleared | Badge becomes "Your choice"; sync pill shows the new revision |
| 200 with warnings | Cleared | Warning banner (deprecated key ignored, use X) |
| 409 | conflict | Inline: "Changed on Laptop to Daily (r13) after this screen loaded r12. Nothing was saved. Keep Daily / Use mine: Off" |
| 422 | error | Inline per field: code and message, with dismiss |
| Outcome unknown | unknown | "Response lost. Checking the server…" with a spinner, then saved or retried |

> "The pending map is what keeps the optimistic UI honest. The control shows your new value immediately, but the row also says 'Saving…' until the server confirms. If confirmation never comes, it says so. The value never silently snaps back, and 'saved' never appears early."

---

## 🔧 Deep Dives (~15 min)

### Deep dive 1: Client state: server document plus a pending map

**Decision.** Keep the server's document untouched and keep the user's unconfirmed edits in a separate map keyed by setting. The display value is derived: pending value if present, otherwise server value. The server document is replaced only by a whole document from the server (a PATCH response, a GET, a 409's current state, a delta event, or another tab) that isn't older than the one held.

**Why it works here.** Every way the server can answer maps cleanly onto one key's pending entry: confirmed (delete it), conflict (mark it and keep the user's value for "use mine"), rejected (mark it with the field error), unknown (mark it and reconcile after a refetch). Remote updates replace the server document without touching pending edits, so a delta for the theme arriving while you're editing the language never clobbers your edit. And because revisions only move forward, a slow GET that started before a PATCH can't overwrite the PATCH's newer response.

**Why mutate-in-place fails.** Writing the optimistic value straight into the cached document (the common "optimistic update, roll back on error" pattern) loses the server's truth. On a 409 you no longer know what the server had. On an unknown outcome you have nothing to compare against. When a remote event lands mid-flight, you can't tell whether a field is yours or theirs. Rollback-on-error also does the wrong thing for "outcome unknown": it reverts a change that probably saved.

**Why a generic mutation library alone fails.** A per-request mutation cache (TanStack Query style) tracks requests, not keys. Two quick edits to one key become two independent mutations with independent rollbacks, and the second is based on a revision the first is about to invalidate. It can be made to work, but the per-key queue and merge logic still has to be written on top. At that point the library is only adding indirection.

**What I give up.** A hand-written store (~250 lines, plus ~100 lines of pure, tested rules) instead of a library's conventions, and the discipline that every server answer goes through one adopt function.

### Deep dive 2: Sync protocol: BroadcastChannel, revision-keyed SSE, revalidation

**Decision.** Three channels with one rule. The tab that wrote posts the new document over BroadcastChannel. Every tab holds an SSE stream for changes from other devices and from admins. Every tab refetches when it becomes visible. All three are judged by the same revision rules.

| Incoming | Rule |
|----------|------|
| user event at revision N | N ≤ held: ignore (own echo or replay). N = held + 1 with the same org and catalog revision: apply the delta. Otherwise refetch (a gap) |
| org event | Newer org revision: refetch after a random 0-400 ms delay |
| catalog event | Newer: refetch definitions and settings |
| hello (on every connect) | Any revision differs: refetch. The server is behind us (a restore): refetch and adopt anyway |
| document from another tab | Adopt if not older; never re-broadcast |

**Why it works.** The common case, another device changing one key, costs zero requests: the event carries the new entry, and the revision proves nothing was missed in between. Every failure mode collapses into "refetch": a dropped event shows up as a gap, a dropped connection as a hello mismatch, a sleeping laptop as a focus refetch. The UI never needs to know which one happened. The rule "never adopt older" makes all three channels safe to race each other. That race is real: the SSE echo of my own write often arrives before my PATCH response.

**Why polling fails.** Polling every 30 seconds misses the 2-second target. Polling every 2 seconds is ~1,800 requests per hour per open tab, almost all returning "nothing changed". At millions of tabs that's the dominant load on the service, spent on nothing. And it still needs the same revision logic to avoid regressions.

**Why SSE alone fails for tabs.** Two tabs of the same browser would each wait for a server round trip to learn about the other's change, and if SSE is down (corporate proxies do kill streams) they'd disagree until the next focus. BroadcastChannel is instant, free and works offline.

**Why not WebSockets.** Nothing flows client-to-server on the live channel. Writes are ordinary PATCH requests that need status codes, If-Match and per-field errors. SSE gives automatic reconnect and plain HTTP semantics.

**What I give up.** Each tab holds its own stream. Ten tabs means ten connections, and HTTP/1.1 allows six per origin. The fix is one leader tab per browser (Web Locks) holding the stream and rebroadcasting. I'd add it when connection counts matter; the revision rules don't change. Org events are invalidations, not deltas, so a big enforcement costs one GET per online member, spread by the jitter.

### Deep dive 3: Writes that can't conflict with themselves, and the lost response

**Decision.** At most one PATCH in flight per settings client. Edits made while it's in flight are merged into the next PATCH, which uses the newest revision. Any outcome other than a 2xx or an enveloped 4xx is "outcome unknown". The client refetches and reconciles per key instead of guessing.

**Why one in flight.** Toggle notifications on, then off, within 200 ms. With a request per change, both PATCHes carry revision 12. The first applies at 13, and the second fails with a 409 against the user's own first write. The user sees a conflict with themselves. With a queue, the second edit waits, merges into one PATCH with the latest value, and goes out with revision 13. The same queue coalesces bursts: five quick changes become at most two requests.

**Why debouncing isn't enough.** A 500 ms debounce reduces requests but doesn't remove the race. A slow response still overlaps the next debounced write, and debouncing adds latency to every single change.

**The lost response.** The connection resets after the server committed. The client cannot know whether the change saved, and it must not show "saved", and must not roll back either. It shows "Response lost. Checking the server…", refetches, and compares the user's own value for each sent key. That's the value when the source is "user", or the shadowed userValue when enforced. If it matches, the change is reconciled as saved. If not, the edit goes back into the queue, and the server's rules decide: a no-op if it actually landed, a 409 if another device changed it meanwhile. If even the refetch fails, the entry stays "unknown" and is reconciled on the next hello. The demo's chaos switch drops exactly one response after commit, so the whole path can be watched in the sync log.

**What I give up.** Writes from one surface serialise, so a slow request delays the next edit's confirmation (not its display). The client needs the server's no-op rule (equal value means 200 even with a stale revision). Without it, every reconcile-then-resend could be a false conflict.

---

## 🧪 The Two-Devices Demo and the Admin Screens (~2 min)

| Screen | What it proves |
|--------|----------------|
| Two devices: phone on instance A, laptop on instance B | Different keys both survive; a write on A appears on B's stream with "written on api-a by Phone" |
| Freeze sync on the laptop | A backgrounded device keeps its old revision, so its next same-key write gets the 409 with keep/use-mine |
| "Drop next response" | Outcome unknown → refetch → reconciled, shown in the log |
| Contract probes | Deprecated key (200 + warning), retired key (RETIRED), unknown key, out of range, enforced key (LOCKED) |
| Org policy | Value, enforce switch, "own value: 3 / 4 members" before enforcing; changes push live |
| Catalog | Add a definition and every open preferences screen renders it with its default |

---

## 📜 Execution Traces (~4 min)

### Successful trace: theme changed on the phone, laptop and a second tab follow

1. On the phone, Alice picks Dark. The pending entry is "queued"; the select shows Dark at once, the app shell turns dark, and the row says Saving.
2. The queue is idle, so it sends a PATCH with theme dark and If-Match 12.
3. The SSE echo arrives first: revision 13, the theme entry. The phone holds 12, so it applies the delta. The pending entry stays, because its value equals the confirmed one.
4. The 200 arrives with revision 13. The document isn't older, so the phone adopts it. The pending entry's value equals what was sent, so it's cleared. The badge reads "Your choice".
5. The laptop's stream on the other instance receives revision 13. It holds 12, with matching org and catalog revisions, so it applies the delta. The row flashes "changed on Phone just now" and the page turns dark.
6. The laptop tab posts its new document over BroadcastChannel. A second laptop tab adopts it in the same frame, without waiting for its own stream.

### Failed trace: frozen laptop, same-key conflict, lost response

1. The laptop is frozen (backgrounded) at revision 12. The phone sets the email digest to Daily (revision 13).
2. On the laptop, Alice sets the digest to Off. The PATCH goes out with If-Match 12.
3. 409: the digest changed at 13, by Phone. The laptop adopts the current document from the 409 and marks the digest row as a conflict. The select still shows her Off; the alert offers "Keep Daily" or "Use mine: Off". Nothing was saved anywhere.
4. She keeps Daily. The pending entry is dropped and the row shows the server's Daily.
5. Chaos is armed. On the phone she picks Monday for week start. The server commits revision 14, but the response comes back as a gateway error without our envelope, so the outcome is unknown.
6. The row shows "Response lost. Checking the server…". The client refetches revision 14 and finds week start Monday with source "user". Reconciled. The log reads "Response lost → refetched r14 → regional.week_start found on the server".

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer from the client's side |
|----------|-------------------------------|
| Source of truth; when is a write successful? | The server's committed revision. The UI shows saved only after a 2xx, or after a refetch proves the value is there |
| Retry after a lost response? | Refetch, compare the user's own value per key, resend only what didn't land. The resend is safe because PATCH sets values |
| Failure between two steps? | A reload loses pending edits that never got a response; everything confirmed is on the server. A dropped stream heals on hello; a sleeping tab on focus |
| Ordering required? | Per user, by revision. Never adopt an older document; apply deltas only at held + 1; refetch on any gap |
| Access with caches and async? | Each client holds one user's own document. Streams are filtered server-side. Logout reloads the page, dropping every store, stream and pending edit of the old identity |
| What breaks first at scale? | Connections: one stream per tab. Leader-tab election, then a push tier for mobile. Org-wide refetch storms are spread by jitter |

---

## ❓ Follow-ups the Answer Must Handle

| Follow-up | Answer |
|-----------|--------|
| Phone and browser update different preferences at once: do both survive? | Yes. The server conflicts per key, so both PATCHes apply at consecutive revisions, and each device applies the other's delta from its stream |
| A client submits a setting that no longer exists | Unknown: a 422 per field, shown inline, and nothing in that patch saved. Deprecated: 200 with a warning banner naming the replacement. Retired: 422 RETIRED. The screen itself renders from the catalog, so it never shows a retired key |
| Enforced settings vs personal preferences | The control locks with "Enforced by Acme" and the kept personal value is explained. An enforcement arrives as an org event, and open screens lock the control without a reload. Lifting it brings the personal value back the same way |
| The update succeeds but the response is lost | Outcome unknown: never "saved", never rolled back. Refetch, reconcile per key, resend what didn't land |
| How does another open tab learn about the change? | BroadcastChannel from the writing tab, instantly. SSE for other devices, keyed by revision. A refetch on focus as the safety net |

---

## 🧱 Component Structure (~1 min)

| Component | Reads from the store | Notes |
|-----------|----------------------|-------|
| Preferences page | status, definitions, settings | Groups definitions by category; a sticky section nav |
| Category section | settings, pending, flash for its keys | One card per category |
| Setting row | one entry, one pending edit | Label, source badge, meta line, control, pending note |
| Setting control | definition + display value | Switches on type and format; owns local drafts for sliders and text |
| Pending note | one pending edit | Saving, unknown, conflict (keep / use mine), error (dismiss) |
| Sync pill | revision, live state, instance | "r14 · live via api-b" in the header and on each device |
| Device pane, device log | a whole device client | The demo screen only |

> "Rows subscribe to their own key, so an event that changes the theme re-renders one row, not twenty. The store hands out per-key selectors, and a recently changed row flashes for two seconds, so a remote change is visible without a toast storm."

---

## 🚦 Startup, Loading and Errors (~1 min)

| Moment | Behaviour |
|--------|-----------|
| First load | Definitions and settings fetched in parallel; skeleton until both arrive; the stream opens straight after |
| Stream connects before the GET returns | The event is held as "no document yet → refetch", which the in-flight GET satisfies |
| GET fails at startup | Error card with the message; the stream's hello retries it on reconnect |
| Refetch fails later | The current document stays on screen; the failure goes in the log; the next hello or focus retries |
| Session expires | Writes return 401 with the envelope; the auth check sends the user to sign in |
| Logout | Full page reload, so no store, stream or pending edit outlives the identity |

---

## ♿ Accessibility and Feedback (~1 min)

- Switches use role=switch with aria-checked and an aria-label from the definition. Selects and inputs are labelled by the setting name.
- Pending states use role=status ("Saving…", "Checking the server…"). Conflicts and errors use role=alert, so screen readers announce them.
- Locked controls are disabled, *and* the reason is text in the row. A disabled control alone explains nothing.
- Reduced motion is itself a setting: when on, the root drops every transition and animation, including the flash on remotely changed rows.
- Text size scales the root font size, so every rem-based size follows. Layouts use wrapping rows, so 150% doesn't overflow.

---

## 🚨 Client Failure Handling (~1 min)

| Failure | What the user sees |
|---------|--------------------|
| Server unreachable during a write | "Response lost. Checking the server…", then saved, or back in the queue once the server answers |
| Stream drops | The sync pill turns amber ("reconnecting"); EventSource retries every 2 s; hello repairs anything missed |
| Event lost silently | The next event shows a gap, a refetch heals it; focus revalidation catches the rest |
| Backend restored from backup | A 412 on write or a lower revision in hello makes the client adopt the server's state |
| Policy changed under an edit | 422 LOCKED inline; the client refetches and the control locks |

---

## 🛡️ The Admin Console (~1 min)

| Concern | Design |
|---------|--------|
| Before enforcing | Each row shows how many members have their own value ("3 / 4"), and that enforcing shadows them, it doesn't delete them |
| Two admins at once | Saves carry the org revision as If-Match. A stale save gets a 409; the row reloads and the notice says another admin changed it first |
| Live view | The page reloads its data whenever the app's own stream reports a newer org or catalog revision. No second stream is needed |
| Catalog edits | The add-definition form shows the server's per-field errors (bad key format, default outside its own range). Deprecate asks for grace days and a replacement |

---

## 📈 Client Performance and Scale (~1 min)

1. **Connections per browser.** One stream per tab hits the six-per-origin HTTP/1.1 limit with many tabs. Fix: a leader tab (Web Locks) holds the only stream and rebroadcasts over BroadcastChannel, or serve over HTTP/2.
2. **Thundering refetches.** An org enforcement reaches every online member at once. Jitter spreads it; at a very large org I'd widen the window to seconds, or have the event carry the org rows so clients re-resolve locally.
3. **Render cost.** ~20 rows with per-key selectors are trivial. The catalog is small enough to never need virtualization.
4. **Payload.** The full document is a few KB. Deltas carry only changed keys, so most remote changes cost one small event and no request.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| State | Server doc + pending map | Optimistic mutate-in-place | Keeps the truth for conflicts and reconciliation |
| Write concurrency | One PATCH in flight, merged edits | Request per change / debounce | A client never conflicts with itself |
| Unknown outcome | Refetch and reconcile | Roll back / blind retry | Honest, and shows the user what happened |
| Live updates | SSE keyed by revision | Polling / WebSockets | Push without wasted requests; writes stay plain HTTP |
| Tabs | BroadcastChannel + per-tab SSE | SSE only / leader tab | Instant and offline-safe; leader election is the scale step |
| Remote deltas | Apply at held + 1, else refetch | Always refetch | Zero requests in the common case |
| Org changes | Invalidate + jitter | Per-member payloads | Effective values differ per member |
| Controls | Rendered from the catalog | Hard-coded screen | New settings ship without an app release |
| Locked UX | Who locked it + kept value | Silent disabled control | Policy, not a bug |

---

## 📝 Wrap-up (~2 min)

> "On the client, a settings screen is a small state machine: server truth, pending intent, and a rule for every answer the server can give, including no answer. With a revision on every document and every event, all sync failures reduce to 'refetch'. Next I'd add leader-tab election to cut connections, and an offline queue for mobile."

### How the local implementation compares

- **Built:** React 19, TanStack Router and Zustand. A settings-client factory used by the preferences screen, the app shell and two simulated devices. Pure, unit-tested sync rules (13 tests). BroadcastChannel plus SSE plus refetch on focus. Live appearance via CSS variables. Conflict, error and outcome-unknown states. Org policy and catalog consoles that reload when the app's own stream reports a newer org or catalog revision.
- **Simplified:** one stream per tab (no leader election); no offline queue across reloads.
- **Omitted:** native mobile clients and push notifications; per-device settings.
