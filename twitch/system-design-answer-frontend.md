# Twitch (Live Streaming) — System Design Answer (Frontend Focus)

*45-minute system design interview format — Frontend Engineer Position*

---

## 📋 Opening Statement

"A live streaming client is two demanding applications sharing one screen, and they compete for the same resources.

The **player** is a bandwidth and buffer problem: adaptive bitrate over HLS, where the client continuously decides which quality it can sustain, and every wrong guess is either a stall or a needlessly blurry picture. The **chat** is a throughput and rendering problem: a sustained stream of messages that must render without dropping frames, next to a video decoder already consuming the machine.

They interact badly. Chat rendering steals main-thread time from the player's buffer management; the player's bandwidth use constrains what chat can afford. Designing them independently produces a page where video stutters whenever chat gets busy — which is exactly when people are watching.

I'll go deep on adaptive bitrate from the client's side, on chat rendering under load, and on the surprisingly hard problem of what the viewer count actually means."

---

## 🎯 Requirements

### Functional

1. **Watch a live stream** with automatic quality adaptation and manual override, plus volume and fullscreen
2. **Read and post chat** in real time, with badges and emotes
3. **Browse** live channels and categories
4. **Follow/subscribe**, and see followed channels
5. **Creator dashboard** — stream key, live status, basic stats
6. **Moderation** — bans, timeouts, slow mode, visible to the people they affect

### Non-functional

| Requirement | Target | Why |
|-------------|--------|-----|
| Time to first frame | < 3s | The dominant abandonment point |
| Rebuffer ratio | < 1% of watch time | Stalls are the most-hated video defect |
| Chat render | 100+ msg/sec without dropped frames | Popular channels sustain this |
| Player unaffected by chat | Always | Video stuttering during busy chat is the failure to avoid |
| Reconnect | Automatic for both, independently | One dying must not take the other down |
| Emote rendering | No layout shift after load | Height changes break the virtualized list |

### Non-goals

No broadcasting from the browser, no VOD or clips, no extensions platform. Also worth stating plainly: **the video here is simulated** — the backend generates HLS manifests without real transcoded segments — so I'll describe the player design that the manifests imply rather than claiming playback fidelity that isn't there.

---

## 🏗️ Architecture

```
        ┌────────────────────────────────────────────────┐
        │                    Browser                      │
        │  ┌──────────────────────┐  ┌────────────────┐  │
        │  │   Player (hls.js)    │  │      Chat      │  │
        │  │  · ABR ladder        │  │  · bounded log │  │
        │  │  · buffer target     │  │  · badges      │  │
        │  └──────────┬───────────┘  └───────┬────────┘  │
        │             │ HTTP segments        │ WebSocket │
        └─────────────┼──────────────────────┼──────────┘
                      ▼                      ▼
              ┌───────────────┐    ┌──────────────────┐
              │  CDN / origin │    │  Chat gateway    │
              │  (manifests + │    │  Redis pub/sub   │
              │   segments)   │    │  across instances│
              └───────────────┘    └──────────────────┘
```

**The two halves share nothing but the machine, and that's the point.** Separate transports, separate failure domains, separate reconnection. A chat outage must leave video playing; a video stall must leave chat scrolling. The only coupling worth having is deliberate: chat can *inform* the player (a raid, a mode change), never block it.

---

## 🧭 Questions I'd Ask First

**"What's the latency target?"** Standard HLS runs 15–30 seconds behind live, which is fine for passive viewing and fatal for anything interactive — a streamer reading chat reactions to something viewers saw half a minute ago. Low-latency HLS or WebRTC changes the player entirely, and it's the question that most affects this design.

**"What's the p50 viewer device and connection?"** ABR policy, chat window size, and emote budgets should all be tuned against the constrained case, not the developer's laptop. A design that's comfortable on fibre and unusable on a mid-range phone has failed for most of the audience.

**"How large do chat rooms get?"** A hundred concurrent chatters and a hundred thousand are different rendering problems, and the second one needs message sampling — deliberately dropping messages before render — which is a product decision, not a technical one.

> "I'd push hardest on latency, because 'live' means two very different things at 20 seconds and at 2, and only one of them supports chat that feels like a conversation."

---

## 🔍 Deep Dive 1: Adaptive Bitrate Is a Client-Side Guess (11 minutes)

HLS gives the client a manifest of quality variants. Choosing among them, continuously, is the player's core job — and every decision is a prediction about the immediate future.

### The trade-off in one sentence

**Pick too high and the buffer drains and the video stalls; pick too low and the viewer watches an unnecessarily bad picture.** Stalls are far worse than softness, which makes the correct bias conservative — but a player that's too conservative on good connections is the most common complaint about video quality.

### What the client is actually deciding

| Signal | What it suggests | Why it can mislead |
|--------|-----------------|-------------------|
| Recent throughput | Bandwidth available | A CDN edge burst overestimates sustainable rate |
| Buffer level | Safety margin | Healthy buffer can mask a connection that just degraded |
| Segment download time vs duration | Whether we're keeping up | The most direct signal, and it lags by a segment |
| Viewport size | Whether high quality is even visible | Rendering 1080p into a 400px player wastes bandwidth for nothing |

There's a fifth signal the client has and rarely uses: **whether the tab is visible.** A backgrounded player has no reason to fetch the top rung, and dropping to the lowest quality (or pausing entirely) while hidden saves bandwidth for content nobody is looking at.

**The last row is the cheapest win and the most-missed.** A player at a quarter of the screen doesn't need the top rung of the ladder; capping quality to what the element can actually display saves bandwidth with literally zero perceptual cost. It matters most on mobile, where the constraint is tightest and the player is smallest.

### Startup versus steady state

These need different policies, and using one policy for both is a classic mistake.

**At startup there's no data** — no throughput history, no buffer. Starting at the highest quality risks a slow first segment and a long black screen; starting at the lowest gets a fast first frame that looks bad at the exact moment a viewer decides whether to stay. Starting at a **middle rung and adapting up quickly** is the standard compromise, and it's right because time-to-first-frame dominates abandonment.

**In steady state** the buffer is the primary signal and the policy should be asymmetric: **step up cautiously, drop immediately.** Climbing a rung on a brief bandwidth spike causes a stall a few seconds later; dropping late guarantees one. The asymmetry is the whole ABR heuristic in one line.

There's also a hysteresis requirement that follows from it. A player oscillating between two rungs every few seconds is more annoying than sitting on the lower one — visible quality changes draw attention in a way that consistent slight softness does not. So an upward step should require the improved conditions to persist, not merely to occur once.

### What manual override means

Offering a quality selector is worthwhile, and the interesting question is what "1080p" means once the user picks it. If it's a hard pin, a viewer whose connection degrades gets endless stalls because they asked for something they can't sustain. If it silently falls back, the setting is a lie.

I'd treat manual selection as a **ceiling, not a pin** — never exceed it, but drop below when the connection can't hold it, and *say so*. The UI showing "1080p (currently 720p)" is honest and keeps the user's intent while avoiding the stall spiral.

> "The framing I'd use is that ABR is a controller with a strong asymmetry: the cost of being wrong upward is a stall, and the cost of being wrong downward is softness. Everything about the policy follows from those costs not being equal."

---

## 🔍 Deep Dive 2: Chat Must Not Cost the Player Its Frames (11 minutes)

Chat and video compete for one main thread, and chat is the one that can be made to behave.

### Why the naive chat kills the player

A popular channel sustains a high message rate. The obvious implementation appends each message to an array in state and renders the list. That produces a state update per message, a re-render of a growing list, and unbounded DOM growth — and every one of those competes with the player's need to fetch, append and manage buffered segments on time.

**The symptom users report is "the video keeps buffering", and the cause is chat.** That's what makes this a shared problem rather than two separate ones.

### The techniques, and why each

| Technique | Effect on the player |
|-----------|---------------------|
| ✅ **Bounded message window** | Caps DOM and memory so long sessions don't degrade |
| ✅ **Coalesce updates to one per frame** | Removes redundant reconciliation competing for the thread |
| ✅ **Virtualize the message list** | DOM size independent of session length |
| ✅ **Pause chat rendering when hidden** | A background tab shouldn't process a firehose |
| ❌ Render every message eagerly | Directly causes the stutter |

The **bounded window** is again the first decision: a live chat has no scrollback expectation beyond a screen or two, so keeping a few hundred messages turns an unbounded problem into a constant one. This is the same conclusion as any live log, and it's load-bearing here for a different reason — not memory alone, but protecting a real-time decoder.

### The auto-scroll rule, and why it also helps the player

Same intent-based rule as any live chat: follow the bottom when the user is at the bottom, pin and show a "new messages" affordance when they've scrolled up.

The bonus is that **a paused chat is a cheap chat.** A user reading scrollback isn't receiving continuous DOM updates, so the player gets the thread back precisely when the viewer is least focused on chat. Designing for the reader's comfort and designing for playback stability turn out to be the same change.

### Sampling, when a window isn't enough

At extreme rates — a large channel during a moment — even a bounded window and per-frame coalescing aren't enough, because the sheer volume of arriving messages costs more than rendering them. At that point the honest answer is **sampling: deliberately dropping messages before they reach the list.**

That sounds unacceptable and isn't, for the same reason batching works at all — nobody can read a thousand messages a second. A viewer perceives "chat is going wild", not individual lines. Dropping a proportion preserves the experience and is what real platforms do.

It has to be a *product* decision though, not a silent technical one, and two rules make it defensible: never drop messages from the viewer themselves or from moderators, and indicate that sampling is active rather than pretending the visible stream is complete.

### Emotes are the hidden cost

Chat isn't text — it's text with images interleaved, and every message may contain several. Each is a network request and a layout event, and a hundred messages a second with two emotes each is two hundred image loads a second.

Three things matter: **cache aggressively** (an emote set is small and reused constantly), **give every emote fixed dimensions** so a message's height doesn't change after images load, and **serve them at display size** rather than scaling down large sources. The fixed-dimension point is the one that interacts with virtualization — a message whose height changes post-load breaks the virtualizer's measurements and jumps the scroll.

> "The insight I'd want to land is that chat is not a feature next to the player, it's a competitor for the player's resources. Once you frame it that way, windowing and per-frame coalescing stop being chat optimizations and become video quality work."

---

## 🔍 Deep Dive 3: What Does the Viewer Count Mean? (8 minutes)

A small number in the corner, and it's genuinely hard — worth raising because it exposes how distributed state reaches a UI.

### Three different numbers

| Source | What it measures | Problem |
|--------|-----------------|---------|
| Sockets on this server | Chat connections held by one instance | Wrong by construction with multiple instances |
| Sum across instances | Chat connections everywhere | Counts chat-only lurkers, misses silent viewers |
| Playback sessions | People actually watching | Requires player-side reporting and heartbeats |

**In this system the chat header takes its count from the channel record** — the same figure the player caption shows — rather than from the local socket set. That's the right call for consistency: two numbers on one page disagreeing is worse than one approximate number, and the socket-set count is meaningless the moment there's more than one gateway.

### Why exactness isn't the goal

A viewer count is a **social signal**, not an accounting figure. Nobody makes a decision differently at 1,203 versus 1,210. What matters is order of magnitude, direction of change, and internal consistency.

That justifies real simplifications: update it on a slow cadence rather than per join, show it rounded at large values, and never animate it per-event. Precision implies a rigor the underlying data doesn't have, and it costs updates that compete with the two things on this page that genuinely need the thread.

**What would actually be needed for accuracy** is presence with heartbeat expiry — clients periodically asserting they're watching, with entries expiring when they stop — because a socket that dies without a clean close otherwise counts forever. That's a real service, and it's the honest answer to "make the number correct".

---

## 🗄️ State: Two Subsystems, Deliberately Separate

| State | Owner | Home | Note |
|-------|-------|------|------|
| Playback (quality, buffer, playing) | Player | Player instance, mirrored minimally | The player library owns this; don't duplicate it into a store |
| Chat messages | Server | Bounded store | Evicted from the head |
| Chat connection status | Client | Store | Drives the honest disconnected state |
| Emote map | Server | Fetched once, cached | Small and reused constantly |
| Viewer count | Server | Polled slowly | Approximate by design; see Deep Dive 3 |
| Followed channels | Server | Fetched | Cross-device |
| Chat mode (slow, sub-only) | Server | Pushed with chat state | Drives composer constraints |
| Volume, quality preference | Client | Persisted locally | User preference, survives navigation |

The chat and player stores are deliberately separate too, not one `streamStore`. A combined store means any chat message notionally invalidates player subscribers, and even with careful selectors it's an invitation to accidental coupling. **Two stores make the independence structural rather than a convention someone has to remember.**

**Not mirroring player state into the global store** is the decision worth defending. It's tempting — you want to show the current quality in the UI — but the player library is the source of truth for buffer, position and level, and a copy in a store is immediately stale and invites components to *set* it, which fights the player's own controller. Read from the player, subscribe to its events, don't shadow it.

---

## 🏅 Badges, Moderation and Chat Semantics

Chat here isn't a flat message list — it carries role and status that change what a message means.

**Badges are resolved server-side and travel with the message**, which is the right split. Resolving subscriber tier, moderator status and admin role on the client would mean the client fetching role data for every author, and would produce a moment where messages render without badges and then reflow as they arrive — a height change that breaks virtualization. Denormalizing the badge array onto the message is a small duplication that removes an entire class of layout bug.

**Chat modes change the composer, not the list.** Slow mode, subscribers-only and emote-only are constraints on posting, and each needs to be visible *before* the user types rather than surfacing as a rejection. A composer that accepts input and then refuses it is the worst version; a composer that explains "Slow mode: 30s" and shows the remaining cooldown is the right one.

**Deleted messages are the awkward case.** Removing an item from the middle of a virtualized, bottom-anchored list shifts everything below it. Replacing the message with a "deleted by moderator" placeholder of similar height avoids the jump and is also more honest — it shows moderation happened rather than silently rewriting history.

**Bans should be visible to the banned user.** A chat that accepts messages and discards them silently is a dark pattern; disabling the composer with a reason is the honest treatment, and it stops the user generating load by retrying.

One implementation note worth stating because it's a real failure mode: ban enforcement here **fails open** — if the check errors, the user is let through. That's the right default for availability, and it means the client should never treat "I can post" as proof of standing. It also means a moderator's ban may not appear to take effect immediately during a backend hiccup, which is worth surfacing in the moderation UI rather than showing a confident success.

---

## 🔌 Two Connections, Two Failure Modes

Because the halves are independent, their failures must be too — and each needs its own honest signal.

| Failure | Player | Chat |
|---------|--------|------|
| Transport dies | Segments fail; retry, then show an error with reload | Socket closes; reconnect with jittered backoff |
| Recovers | Resume at the live edge, not where it stalled | Re-fetch recent history — messages sent while disconnected are gone |
| Degraded | Drop quality | Show "reconnecting" and keep the composer enabled if posting uses a separate path |

**Resuming at the live edge rather than the stall point** is the non-obvious one. This is live content; catching up from where playback stopped means watching a delayed stream forever, drifting further behind with every stall. The player should seek to live on recovery — and tell the user it did, because content was skipped.

The chat side mirrors the reconnect gap in any WebSocket system: no replay, so a reconnect needs a history re-fetch rather than a resumed stream, or the transcript silently loses the disconnected window.

---

## 🎛️ The Creator Dashboard Is a Third Application

Small, and it has requirements unlike either viewer surface.

**It shows a secret.** The stream key is a bearer credential — anyone holding it can broadcast as that channel — and it's routinely leaked by streamers screen-sharing their own dashboard. So it should be masked by default with an explicit reveal, and the copy action should work *without* revealing it. That single affordance prevents the most common way these keys escape.

**Its numbers are operational, not decorative.** A creator checking whether they're live, and whether viewers are arriving, is making a decision — restart the encoder, check the connection. So this is the one surface where a slightly faster refresh is justified, and where a stale number is genuinely costly.

**It must be honest about ingest state.** "Live" derived from a database flag rather than from actual incoming video will tell a creator they're broadcasting when they aren't. That's the worst failure on this screen, and it's worth distinguishing "marked live" from "receiving video" if the backend can tell them apart.

The dashboard is also the natural home for the one thing viewers can't see: whether the stream's quality ladder is being produced correctly. A creator whose transcode is failing has no other way to find out.

---

## ♿ Live Video and Live Text Are Both Accessibility Hazards

- **Captions are the single biggest gap.** Live streaming without captions excludes deaf and hard-of-hearing viewers entirely. It's out of scope here, and it's the first thing I'd add — worth naming rather than omitting silently.
- **The player must be fully keyboard-operable** — play/pause, volume, quality, fullscreen — with visible focus. Custom players routinely lose this by replacing native controls with unlabeled buttons.
- **Chat must not be a live region at this rate**, for the same reason as any high-volume log: announcements queue unboundedly. On-demand reading of the recent window is the workable pattern.
- **Emotes need alt text.** An emote conveys meaning; rendered as an unlabeled image, the message reads as truncated nonsense.
- **Autoplay must respect reduced-motion and muted-autoplay rules**, and the UI has to handle the browser blocking playback — a player that silently fails to start looks broken. The recovery is a visible play affordance, not a retry loop.
- **Flashing content is a real hazard.** Streams and animated emotes can both flicker at rates that trigger photosensitive reactions, and `prefers-reduced-motion` should at minimum freeze animated emotes.

---

## 🧪 Testing Video and Chat Together

Most of these bugs only appear under conditions a developer machine never produces.

| Scenario | Simulation | Protects |
|----------|-----------|----------|
| Bandwidth collapse mid-stream | Throttle to 2G after 30s | Player drops quality rather than stalling indefinitely |
| Bandwidth recovery | Restore after throttling | Steps up, and not so eagerly it re-stalls |
| Chat firehose during playback | 200 msg/sec while video plays | **Dropped-frame count on the player**, not chat correctness |
| Small player element | Render at 320px wide | Quality capped; no 1080p fetched |
| Chat socket dies, video fine | Kill only the WebSocket | Video keeps playing; chat shows reconnecting |
| Video stalls, chat fine | Block segment requests | Chat unaffected; player recovers to live edge |
| Emote height stability | Load messages with slow emotes | Scroll doesn't jump after images resolve |

**The third row is the important one and the one nobody writes.** The assertion isn't "did chat render" — it's whether the player dropped frames while chat was busy. That single test encodes the central claim of this design, and without it the coupling between the two halves is invisible until users report it.

The two independent-failure tests matter almost as much, because the natural implementation shares a reconnect path or an error boundary between the halves, and then one failure blanks both.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Rejected | Rationale |
|----------|--------|----------|-----------|
| ABR startup | ✅ Middle rung, adapt fast | ❌ Highest or lowest | Time-to-first-frame dominates abandonment |
| ABR steady state | ✅ Step up slow, drop fast | ❌ Symmetric | Stall costs far more than softness |
| Quality cap | ✅ Cap to player element size | ❌ Always allow max | Bandwidth spent on pixels nobody sees |
| Manual quality | ✅ Ceiling, with honest fallback label | ❌ Hard pin | A pin turns a bad connection into endless stalls |
| Chat volume | ✅ Bounded window + virtualize | ❌ Render everything | Chat rendering steals the player's frames |
| Chat updates | ✅ One per frame | ❌ Per message | Redundant reconciliation competes with buffering |
| Auto-scroll | ✅ Follow only when at bottom | ❌ Always | Yanks readers, and costs frames |
| Emotes | ✅ Fixed dimensions, cached | ❌ Natural sizing | Post-load height changes break virtualization |
| Viewer count | ✅ One channel-wide figure | ❌ Local socket count | Per-instance counts are meaningless and inconsistent |
| Player state | ✅ Read from the player | ❌ Mirror into a store | A copy goes stale and invites conflicting writes |
| Reconnect (video) | ✅ Seek to live | ❌ Resume at stall point | Otherwise the viewer drifts permanently behind |
| Badges | ✅ Denormalized onto the message | ❌ Resolved client-side | Avoids reflow that breaks virtualization |
| Deleted messages | ✅ Placeholder of similar height | ❌ Remove from the list | Removal shifts the list; placeholder is also more honest |
| Stores | ✅ Separate chat and player | ❌ One stream store | Makes independence structural, not conventional |
| Stream key | ✅ Masked, copy without reveal | ❌ Displayed plainly | Screen-shared dashboards leak it constantly |

---

## 📺 Browse, and the Cost of Thumbnails

The browse and category pages are the least novel surfaces and still worth two decisions.

**Live status must be truthful.** A grid showing channels as live when they ended minutes ago sends viewers to dead streams — the most disappointing possible click. Since the grid is fetched rather than pushed, it should re-validate on focus and be explicit about when it last updated, rather than presenting a cached list as current.

**Categories are a navigation problem, not a listing one.** Browsing by game is how most viewers find streams, so the category grid deserves the same care as the channel grid rather than being treated as an index page.

**Thumbnails are the payload.** A stream grid is images, and the same rules apply as any media list: explicit dimensions to prevent reflow, lazy loading below the fold, and sizes matched to display. Animated preview-on-hover is the feature everyone wants and it's expensive — it should be gated on a deliberate hover intent delay and disabled entirely under reduced-motion or a constrained connection.

**Viewer counts in the grid follow the same logic as the player's**: approximate, rounded, and updated on a slow cadence. A grid animating dozens of counters is spending frames on a number nobody reads precisely.

---

## 🚀 What Breaks First

**Chat at peak, taking the player with it.** The first real failure is a popular stream where chat rendering starves the video pipeline. It presents as a video problem, which is what makes it hard to diagnose — and it's why the chat work above is framed as playback protection.

**Then emote image volume**, which is a request-count problem before it's a bytes problem. Caching and correct sizing address it; a sprite or atlas is the next step if it persists.

This one has a subtlety worth flagging: emote requests compete with **video segment requests** on the same connection pool. A burst of emote loads during a busy moment can delay a segment fetch, which is another path by which chat degrades playback — and it's invisible unless you're looking at request waterfalls rather than at either subsystem alone.

**Then memory on long sessions.** A stream open for hours accumulates chat unless the window is enforced, and mobile is where that ends in a terminated tab. The player contributes too — a buffer target tuned for stability on desktop is memory a phone may not have, which is another place where the two halves trade against each other.

**Then the browse pages**, which are ordinary media-heavy grids and the least interesting problem on this list — though animated hover previews would move them up sharply, since each one is a second video decode running alongside the grid.

One more worth naming because it's invisible in development: **a viewer who leaves the tab open overnight.** The player keeps buffering, chat keeps accumulating, and neither has a reason to stop. Pausing playback and chat rendering on `visibilitychange` isn't only a battery courtesy — it's what prevents a forgotten tab from becoming a memory leak and a bandwidth drain, and it removes load from the CDN and gateway for an audience that isn't watching.

Notably absent: video bandwidth. That's a CDN and encoding concern, and the client's only lever — choosing the right rung, and not exceeding what the element displays — is already covered by ABR.

---

## 📝 Summary

Three ideas:

1. **ABR is a controller with asymmetric costs.** A stall is much worse than a soft picture, so the policy climbs cautiously and drops immediately — and the cheapest quality win is refusing to fetch more pixels than the player element can show.
2. **Chat is a competitor for the player's resources, not a sibling feature.** Windowing, virtualization and per-frame coalescing are video-quality work; the clearest sign of getting this wrong is video that stutters exactly when a stream gets popular.
3. **Two subsystems, two failure domains, one honest page.** Separate transports and reconnection mean neither half can take down the other — and where they must agree, like the viewer count, they should show one approximate number rather than two precise ones that disagree.
