# Facebook News Feed — System Design Answer (Frontend Focus)

*45-minute system design interview format — Frontend Engineer Position*

This is a proposed experience built from the local demo's ideas. The demo has a virtualized home list and simple optimistic likes, but no stable feed sessions, bounded page cache, restored scroll state, persisted draft, or working live-update client. Media upload, video, shares, and a post-detail route are proposed extensions rather than current features.

| Discussion | Minutes |
|------------|---------|
| Opening and requirements | 4 |
| Architecture and initial questions | 4 |
| Pagination deep dive | 11 |
| Virtualization deep dive | 11 |
| Optimistic interaction deep dive | 9 |
| Selected lifecycle/accessibility/testing follow-ups | 4 |
| Close and questions | 2 |

Use the later sections as follow-up notes; choose the ones relevant to the interviewer rather than reciting every topic.

---

## 📋 Opening Statement

"A news feed is the hardest ordinary-looking UI in software. It's an infinite, ranked, mutating list where every item is expensive to render, the ordering is non-chronological, and the user's scroll position is sacred.

Three things make it genuinely difficult, and none of them is 'render a list of posts'. **Pagination has to be stable** even though the feed is ranked and new content arrives constantly — paging a freshly changing order by offset can duplicate and skip posts. A ranked reading session needs an explicit continuity contract. **Memory has to stay bounded** while someone scrolls through hundreds of items with images and video. And **interactions have to feel instant** while remaining correct, which means optimistic updates with a rollback story.

There's also a wrinkle from the backend: the feed is assembled from two sources — precomputed items for ordinary authors, pulled-at-read-time posts from high-follower accounts — and merged. The client has to be robust to that merge producing slightly different results between requests."

---

## 🎯 Requirements

### Functional

1. **Infinite feed** with ranked ordering
2. **Post** text and media
3. **Interact** — like and comment — with immediate feedback; sharing is a follow-up extension
4. **Live updates** when new content arrives, without disrupting reading
5. **Profiles and post detail** reachable and returnable-from

### Non-functional

| Requirement | Target | Why |
|-------------|--------|-----|
| Scroll performance | 60fps sustained | Feed scrolling is the product's core motion |
| Memory over a long session | Bounded | Hundreds of media-heavy items must not accumulate |
| Interaction feedback | Immediate | A like that waits for the network feels broken |
| Pagination integrity | Stable candidate order within a session; no duplicate IDs | Current permissions can still remove content |
| Return-to-feed | Restore the same visible post and offset when retained | Explain session expiry or removed content |
| Composer draft safety | Survives ordinary navigation; explicit recovery state | Bound and account-scope persisted drafts |
| Time to first post | < 1.5s | A blank feed on open is the moment users leave |
| New-post disruption | Zero | Content must never shift under a reading user |

### Non-goals

No real-time collaborative editing, stories, messaging, or notifications UI in the initial scope. The local schema has a notifications table, but neither its UI nor the live feed channel is wired end to end. The proposed refresh-hint channel could later support carefully scoped notification hints.

A ranking-explanation interface is outside this first version. Still label ranked/discovery modes and avoid claiming the user has seen every eligible post; those are basic expectations to settle with the interviewer.

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────┐
│ Virtual feed / composer / detail view                │
│ Stable post IDs, measured rows, bounded media        │
└───────────────────────────┬──────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────┐
│ Feed store + account/session controller              │
│ Ordered pages / optimistic intent / refresh hint     │
└────────────┬───────────────────────────┬─────────────┘
             │ HTTP pages + mutations    │ live hints
             ▼                           ▼
┌──────────────────────────────────────────────────────┐
│ API: authorized hydration + ranked feed session      │
│ Pushed candidate IDs + pulled author timelines       │
└──────────────────────────────────────────────────────┘
```

One thing the diagram deliberately omits: any client-side ranking. **Scores are computed server-side and the client renders the order it's given.** Re-ranking locally would mean the client and server disagree about position, which breaks cursor pagination immediately — the server resumes from where *it* thinks you are.

**The merge is the client's problem too, but the server must supply continuity.** Gathering two sources afresh on every page changes membership and rank. I would ask for a short-lived server feed session that freezes ordered candidate IDs. The client deduplicates defensively and treats the session cursor as opaque; deduplication alone cannot repair posts skipped by unstable pagination.

---

## 🧭 Questions I'd Ask First

**"Is ordering chronological or ranked?"** It changes pagination fundamentally. Chronological ordering can use a timestamp-plus-ID cursor with defined eligibility. Ranked scores drift, so stable continuation needs a frozen order or an explicitly approximate contract. I'll design for ranked because that's what this system does, but I'd want the interviewer to see I know the cheaper version exists.

**"How fresh must the feed be?"** A feed that may be minutes stale can be aggressively cached and paged without re-ranking. A feed that offers posts from seconds ago needs timely invalidation or polling. New content can be offered without reranking the page the user is reading.

**"What fraction of users are on low-end mobile?"** Virtualization, overscan and media budgets should be tuned against the slowest realistic device, not the median. This number decides whether the design is comfortable or tight.

> "The ranking question is the one I'd press on, because 'ranked feed' and 'reverse-chronological feed' are often used interchangeably in a brief and they imply different pagination architectures."

---

## 🔍 Deep Dive 1: Paginating a List That Changes While You Read It (11 minutes)

This is the defining correctness problem, and it's where most feed implementations are quietly broken.

### Why offset pagination fails

The obvious approach is `LIMIT 20 OFFSET 40`. It works on a static list and breaks on a feed, because the feed mutates between requests:

```
  t0   page 1 = [P20 P19 ... P1]        (20 items, offset 0)
       ↓ three new posts arrive at the head
  t1   page 2 = offset 20 into the new order
       [P23 P22 P21 P20 ... P1 ...]
       → P3, P2, P1 appear AGAIN on page 2
```

New content at the head shifts everything down, so the next offset lands on items the user already saw. Deletions produce the opposite: content silently skipped. **The user sees duplicates, which reads as a bug, or misses posts, which they never find out about.**

### Options

| Approach | Duplicates | Gaps | Cost |
|----------|-----------|------|------|
| ❌ Offset/limit | Yes, on any insertion | Yes, on deletion | Trivial to implement |
| ✅ **Cursor on an immutable total order** | Avoids repeats | Preserves eligible continuity | Requires a stable order and tie-breaker |
| ✅ Snapshot ranked IDs per session | Avoids repeats | Preserves examined positions | Server state/expiry; recheck current permissions |
| ⚠️ Client-side dedupe on top of offset | Hides duplicates | Doesn't fix gaps | A patch, not a fix |

### What I'd build

**A cursor into a frozen ranked feed session.** The first request creates a bounded ordered candidate list and returns a session-bound cursor. Later pages continue that same list for a limited lifetime, perhaps ten minutes. A position index is safe inside this immutable session; it is unsafe when used to offset into a freshly changing feed. New arrivals belong to the next session, offered through a refresh affordance.

Two complications specific to *this* feed:

**Ranked order makes the cursor harder.** A timestamp-plus-ID works for a chronological order; a score-plus-ID only resolves ties in ranked order. It does not prevent a score from changing and moving an unseen post above the cursor. I would freeze candidate rank for the session, while rechecking deletion and current audience permissions on each page. The cursor advances across examined positions, including newly hidden rows, and an expired session returns an explicit reset.

**The two-source merge needs deduplication before ranking.** The same post can be present in both candidate sources during a distribution-policy transition. The server deduplicates the session list, and **the client also deduplicates by post ID** to tolerate repeated responses and overlaps with an author-created post. Repeats are recoverable; unseen posts omitted by a drifting score cursor are not something the client can infer.

> "The rule I'd state is that the client must treat post ID as the identity for everything — dedupe, keys, optimistic updates, scroll anchoring. Position in a list is never identity in a feed, because position isn't stable."

---

## 🔍 Deep Dive 2: Virtualization With Variable Heights and Media (11 minutes)

An infinite feed of media-rich posts cannot render every item, and virtualizing this list is meaningfully harder than virtualizing a table.

### What makes it hard

| Problem | Why a simple virtualizer fails |
|---------|-------------------------------|
| Variable heights | A text post and a photo post differ by hundreds of pixels; fixed-height windowing misplaces everything |
| Heights change after render | An image loading changes its container's height *after* the virtualizer measured it |
| Scroll anchoring | Adjusting a height above the viewport shifts content below it, jumping the user |
| Return navigation | Coming back from a post must restore both scroll offset and loaded pages |

**Estimated heights plus measurement is the workable approach**: estimate a size to lay out the scrollbar, then measure real elements as they render and correct. The correction is where the jumping comes from, and the mitigation is the important part — **reserve space for media before it loads**, using known aspect ratios so a post's height is right on first layout rather than after the image arrives.

This removes an important source of layout shift. It is also a data contract: return intrinsic dimensions or an aspect ratio with processed media. If unavailable, a fixed-aspect placeholder or crop is a fallback with a visual trade-off, rather than pretending the browser knows the future height.

### Overscan is a real trade-off

Rendering a few items beyond the viewport avoids blank space during fast scrolling, at the cost of more DOM and more image requests. Too little and users see gaps; too much and you've undermined virtualization. A small overscan of a few items is the right default, tuned by measuring on the slowest target device rather than the developer's machine.

### What I would *not* do

**I wouldn't keep every video player mounted forever.** Retain at most the active player and perhaps one nearby warm player, pause off-screen playback, and save playback position separately by post ID before disposal. Recreating a player has a cost, but retaining hundreds contradicts bounded memory. Video is an extension; the local demo only renders images.

**I would benchmark before adding virtualization to a small list.** It adds measurement, restoration, and accessibility complexity. A bounded set of fifty heavy media cards can still benefit, while fifty lightweight text rows may not. Virtualization bounds mounted rows; independently cap retained data, for example five 20-post pages around the reading anchor, with controlled page reload as the user moves.

> "The failure I'd watch for is that virtualization *hides* items from find-in-page and from screen readers that rely on document order. That's a real regression for a text-heavy product, and it's the cost people forget to name."

---

## 🔍 Deep Dive 3: Optimistic Interactions and What Happens When They Fail (9 minutes)

Interactions should give immediate feedback. Likes can update optimistically; comments/posts can show a recoverable pending state. Feedback does not require pretending every mutation is already confirmed. Shares are outside the initial working demo.

### Why optimism is correct here, when it wasn't elsewhere

The distinction I'd draw against a system like signing or payment: **a like is usually low-consequence and reversible, but it is not automatically self-correcting.** A definite rejection can restore the latest valid base; a timeout may follow a committed write and needs reconciliation. The user's mental model tolerates it. That's the opposite of a signature or a charge, where showing success before the server agrees is a lie with consequences.

So the rule is not "optimistic UI is good" or "bad" — it's that **optimism fits when the product can explain pending state and reconcile an inexpensive, reversible action.**

### The failure modes to design for

| Failure | Naive result | Correct handling |
|---------|-------------|------------------|
| Like request fails | Old rollback overwrites newer intent | Resolve unknown outcomes; apply rejection only to its own operation |
| Rapid toggle (like/unlike/like) | Requests race; final state may not match final intent | Track intent, send the last one, reconcile to the server's answer |
| Server returns a different count | Local +1 vs server's authoritative number | Replace with the server value, never add to it |
| Optimistic comment then failure | Comment vanishes with no explanation | Keep it visible, marked failed, with retry |

The **rapid-toggle** case is the one that produces persistent wrongness. I'd keep one in-flight desired-state operation per viewer/post and coalesce subsequent taps into the latest intent. The server treats repeated liked=true as the same state and returns a versioned canonical result. When the current operation settles, reconcile the base, then send any remaining intent. An old failure cannot blindly decrement the current count or undo a newer operation.

**Versioned absolute counts replace the authoritative base.** Ignore stale responses and apply only the outstanding local overlay that is not already reflected in the server result. Adding an optimistic +1 to a total that includes it double-counts. A protocol carrying deltas would need different rules; the local like API currently returns a message without a count/version.

### New posts arriving while reading

Live updates over WebSocket create the same conflict as any streaming list: inserting a new post at the top shifts everything down and displaces the reader.

**Offer refresh instead of inserting underneath the reader.** Coalesce an authorized hint into a "New posts available" affordance, with a capped approximate count if useful. Clicking requests a new ranked session and returns to its top. A hint should not carry private content or replace the current permission check; it is a freshness signal, not a complete buffer of every incoming post.

---

## 🖼️ Media Is Most of the Bytes and Most of the Jank

Worth separating from virtualization, because they get conflated and the fixes are different.

**Dimensions from the API are a valuable input.** Reserving the expected aspect ratio prevents image-load height changes; text wrapping, expanded comments, and viewport changes still need measurement. Without them, every image is a height correction after load — and in a virtualized list those corrections compound, because the virtualizer's estimates were wrong for every unmeasured row below.

**Responsive sources, not one size scaled down.** A feed thumbnail and a full-width photo are different assets. Serving the large one and constraining it in CSS wastes bandwidth on exactly the connection least able to spare it.

**If video is added**, make playback a user-controllable policy: at most one active player, pause off-screen, disable automatic motion for reduced-motion preferences, and respect data-saving choices. Browser autoplay rules and user preference can require an explicit Play button. Save position separately and dispose distant players.

**Decode cost is real on low-end devices.** Even correctly sized images consume decoding resources and decoded memory, and loading many at once can interfere with rendering. Browser decoding work is not necessarily all on the main thread. `decoding="async"` and letting the browser schedule it is the cheap mitigation.

---

## 🗄️ State: Server Data, View State, and Optimistic Overlay

| State | Owner | Home | Note |
|-------|-------|------|------|
| Feed pages | Server | Normalized store plus ordered session pages | Deduped; bounded working window |
| Cursor | Server | Store | Opaque to the client — never constructed locally |
| Optimistic overlay (likes in flight) | Client | Store, per post ID | Reconciled when its own operation resolves; preserve newer intent |
| New-post hint | Client | Capped count/refresh flag | No unbounded retained post payloads |
| Scroll position + loaded pages | Client | Restored on back-navigation | The most-felt state in the product |
| Composer draft | Client | Account-scoped local persistence | Retain text/pending IDs with a quota and expiry |

**Keying everything by post ID rather than array index** is what makes the optimistic overlay and the dedupe possible at all. Once identity is stable, an update can find its target regardless of where the merge placed it.

Storing posts in a map keyed by ID with a separate ordered list of IDs is the shape I'd reach for. It makes three operations cheap that are awkward with a plain array: updating one post's like count without touching the list, deduping on ingest, and replacing a session order without rewriting every entity. The cost is one extra indirection at render time, which is nothing next to what it buys.

Update the draft in memory on every keystroke and persist asynchronously with a short bounded debounce and a navigation flush. Avoid synchronous localStorage writes on every keystroke for large drafts. Account-scope stored text, handle quota errors, and clear submitted/discarded drafts. A browser crash can still lose the unsaved tail; do not promise perfect durability from a debounce.

The cursor deserves a note too: it's **opaque to the client**. The client stores and returns it without interpreting it, which lets the server change its pagination strategy — a versioned session position or a chronological time-plus-ID boundary — without a client release. A client that parses the cursor has coupled itself to a server implementation detail it has no business knowing.

---

## 🎭 Ranking the User Can't See

The feed is ranked by engagement × recency decay × affinity, and none of that is visible. That's conventional, and it's worth treating as a design decision rather than a default.

**The client's honesty problem:** a ranked feed looks like a chronological one. Users assume they're seeing everything from everyone they follow, in order, and they aren't — posts below the fold in ranking terms may never be seen at all. The interface makes no claim either way, which is how the assumption forms.

Two cheap things a client can do:

- **Consider a chronological mode.** It gives users a different reading choice, but needs its own eligibility, candidate coverage, cursor, and cache/session identity. Sorting an already rank-truncated subset by time does not create a complete chronological feed.
- **Don't imply completeness.** An "end of feed" state that says "you're all caught up" is a claim the ranking can't support. Something more accurate — an indication that older posts remain — avoids asserting something false.

There's also an empty-feed case the backend handles by falling back to globally popular posts. **That fallback needs an explicit mode in the API and UI**, so the viewer can distinguish public discovery from followed content. The actual response has no mode field, so the client cannot reliably infer it. "Popular right now, while you find people to follow" costs one line and prevents that.

---

## ♿ Virtualization Versus Accessibility

Windowed rendering creates two real accessibility problems, and honesty about them matters more than claiming they're solved.

**Items outside the window don't exist in the DOM**, so browser find-in-page cannot see them and a screen reader navigating by heading skips them. For a text-heavy feed that's a genuine loss of capability, not a cosmetic issue. Mitigations: ensure the scroll container is properly labeled and that reaching content by scrolling actually renders it, and provide search that queries the server rather than relying on find-in-page.

**Focus can be destroyed by recycling.** If a focused element is unmounted as it scrolls out, focus jumps to the body and keyboard users lose their place. Retain a focused/editing row within a small explicit exception budget, or move focus deliberately with an explanation before disposal. Do not keep every previously focused row mounted indefinitely.

In the proposal, each post is an `article` with a meaningful accessible name, interaction buttons state both action and count ("Like, 42 likes"), and the new-posts affordance is announced politely so a screen-reader user knows content is waiting rather than discovering it by accident.

---

## 🧪 Testing a List That Mutates

The bugs here are all about sequence and timing, and none of them appear when clicking through a static fixture.

| Scenario | Simulation | Protects |
|----------|-----------|----------|
| Ranking changes while paging | Add/rerank content between pages | Same session order; refresh starts a new one |
| Two-source repeat | Return the same celebrity post on consecutive pages | Ingest dedupe by post ID |
| Rapid like toggling | Reorder failures, successes, and refresh data | Latest intent reconciles with canonical version |
| Count reconciliation | Optimistic +1, then a server count that already includes it | Replaced, not accumulated |
| Image height correction | Resolve images after first paint | Reserved space prevents jump |
| Back-navigation | Scroll deep, open a post, return | Offset and loaded pages restored |
| Live posts while reading | Deliver repeated hints mid-scroll | Coalesced refresh affordance; no reordering |

The pagination and toggle tests are the highest value because both produce *persistent* wrongness rather than a transient glitch — a duplicated post stays duplicated, and a mis-toggled like stays wrong until reload.

I'd assert on **store contents rather than rendered output** for most of these. With virtualization, "is the post on screen" depends on scroll position and window size, which makes render assertions flaky for reasons unrelated to the bug being tested.

---

## 🔗 Navigation and Scroll Restoration

A central reading behavior that depends on both retained client state and a server feed session that still exists.

The flow is: scroll deep, tap a post, read it, go back. Getting back to the same place requires restoring **three** things, and most implementations restore one:

| What | If missing |
|------|-----------|
| Scroll offset | Lands at the top of the feed |
| Loaded pages | Offset is meaningless — the content isn't there to scroll to |
| Virtualizer measurements | Estimated heights differ from measured ones, so the offset points somewhere else |

**Virtualization makes this materially harder**, which is the cost people don't price in when they adopt it. A virtualized list benefits from retained measurements or an anchor-based remeasurement pass. Even a plain list can drift if its media or content changed; a pixel offset alone does not establish the reading position.

For in-app detail navigation, I might retain one **bounded** feed behind a detail route, making the hidden feed inert and pausing its media/background work. That retains measurements and view state, but it does not eliminate all restoration: content may be removed and the viewport can change. Do not retain a new full feed tree for every navigation.

Where that isn't possible — a genuine navigation, a shared link — the fallback is to retain the feed-session ID, anchor post/offset, and bounded page references, then reload the compatible page if it is still available. If the session expired or permission changed, explain the reset and choose the nearest valid anchor. **Anchoring to content is more robust than anchoring to a coordinate**, because content identity survives measurement differences.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Rejected | Rationale |
|----------|--------|----------|-----------|
| Pagination | ✅ Cursor into frozen ranked IDs | ❌ Offset/drifting score over fresh rank | Stable ID tie-breakers do not freeze scores |
| Identity | ✅ Post ID everywhere | ❌ Array position | Two-source merge makes position meaningless |
| Duplicate handling | ✅ Server/client dedupe by ID | ❌ Treat list position as identity | Handles source overlap and repeated responses |
| Rendering | ✅ Virtualize with measurement | ❌ Render everything | Unbounded feed; media-heavy rows |
| Media layout | ✅ Reserve space from known dimensions | ❌ Measure after load | Post-load height changes are the main source of jank |
| Interactions | ✅ Intent overlay + canonical version | ❌ Blind increment/rollback | Old outcomes cannot undo newer intent |
| Counts | ✅ Replace with server value | ❌ Accumulate locally | Local addition drifts upward over a session |
| New posts | ✅ Coalesced hint + user refresh | ❌ Insert at top | Preserves session order and reading position |
| Video | ✅ Bounded active/warm players | ❌ Keep all players mounted | Save position separately; bound decoded resources |
| Composer draft | ✅ Async account-scoped persistence | ❌ Only persist on submit | Preserves ordinary navigation with bounded write cost |

---

## ✍️ Composing a Post

The write path is small compared to the read path, and it has two decisions worth defending.

**A mobile composer can be a route** so browser Back has clear behavior, but routing alone does not preserve a draft. Keep text and upload references in the account-scoped draft store across navigation. The current demo has an inline composer.

**Media upload happens before submit, not with it.** Uploading images as they're selected means the post submission is a small JSON request, and a failed upload can be retried on its own without losing the written text. A combined multipart transfer can require retrying more bytes; it need not discard the text if draft state is handled correctly. Separate uploads need owned upload IDs, retry/progress state, and orphan cleanup. Same reasoning as the e-signature flow — **separate the expensive, failure-prone transfer from the cheap, meaningful action.**

**Where optimism applies:** a new post may appear in the author's own view with an explicit pending status and operation ID. Preserve its text on failure and reconcile the server receipt before calling it confirmed. Alternatively, wait for acceptance, as the local composer does. That's different from inserting *other people's* new posts, which is disruptive. The asymmetry is about whose intent it was.

---

## 🚀 What Breaks First

**Scroll restoration on back-navigation**, before any performance concern. Opening a post and returning to the top of the feed — having lost twenty loaded pages — loses the reader's context. Preserving it needs both a retained anchor and a server session that can still serve the referenced order. It's also made harder by virtualization, because restoring requires both the scroll offset and the loaded page set.

**Then image weight.** A feed is mostly images, and bytes dominate everything the framework does. Responsive sources, correct dimensions, lazy loading below the fold. None of this is React work — which is worth saying in an interview, because the instinct is to reach for a rendering optimization when the win is in the asset pipeline.

**Then the optimistic overlay's complexity**, as more interaction types accumulate. Likes are simple; reactions with types, saves, and follow-from-feed each add another piece of local state that must reconcile with server truth. The pattern that keeps this manageable is one overlay structure keyed by post ID with a uniform reconcile rule, rather than bespoke handling per interaction type — otherwise every new action adds its own drift bug.

**Then live-update volume**, if a user follows very active accounts. The buffered "N new posts" affordance bounds the *disruption*, but not the memory held by buffered posts — that buffer needs its own cap, and past it the honest behavior is to retain a refresh flag rather than every full post. Fetch the current authorized view when the user asks.

**Then ranking staleness.** A feed loaded an hour ago is ranked against an hour-old world. At some point the client should offer a refresh rather than continuing to page into a stale ordering — and deciding *when* is a product question the client can't answer alone.

**Request volume also needs a budget.** Prefetch, images, comment expansion, search-as-you-type, and reconnection across a large audience can overload dependencies. Deduplicate and cancel stale requests, bound prefetch, and debounce search with generation checks. Browser performance and server pressure are connected; virtualization alone addresses neither network load nor durable mutation correctness.

---

## 📝 Summary

Three ideas:

1. **Position is never identity.** Use post IDs for entity identity and a cursor into frozen ranked IDs for continuity. An index may represent a position inside that immutable session, but cannot identify an entity across changing lists. Dedupe protects overlap; it does not repair gaps from reranking.
2. **Reserve space before you have content.** Most feed jank is height correction after images load, and the fix is a data requirement — image dimensions from the API — rather than a rendering trick. Ask for dimensions early, and define the fixed-aspect fallback when they are unavailable.
3. **Optimism is a judgment about reversibility.** Likes are cheap to get wrong and instant feedback matters, so they're optimistic. Other people's new posts should not reorder an active reading session; coalesce refresh hints and let the viewer choose a new session. The same feed uses both strategies, chosen by consequence rather than by habit.


## 🔎 Local Implementation Checkpoint

The [current implementation](./architecture.md#implementation-notes) has no frozen feed sessions or live frontend channel. The home cursor is a native Date string but the Redis path parses it numerically; celebrity candidates ignore the cursor, and final hydration omits current privacy checks. The per-author cap can report the feed finished early.

The [home store](./frontend/src/stores/feedStore.ts) appends without deduplication or a memory limit, retains data across logout, and rolls back likes without operation identity. Profile cards call that home store rather than updating their profile-local data. The [virtualized route](./frontend/src/routes/index.tsx) uses dynamic measurement but no stable virtualizer item-key override, composer scroll margin, or restoration controller. Card-local comment drafts vanish on unmount; the composer does not persist drafts. These are the gaps the proposed contracts address.
