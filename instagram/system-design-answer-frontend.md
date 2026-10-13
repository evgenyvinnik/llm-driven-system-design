# 📸 Instagram — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "Instagram's web client is an endless list of large images that has to scroll at 60 frames per second on a mid-range phone, plus a composer that uploads several megabytes over a connection that drops in elevators. The two hard parts are rendering — a feed of variable-height, image-heavy rows that never janks or jumps — and trust: a heart that fills instantly and never lies, and a Share button that can be tapped twice, retried and refreshed without ever posting twice."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, Web Vitals budgets, devices, accessibility |
| A — Architecture | 8 min | Component tree, who owns which state, the data layer |
| D — Data model | 5 min | Client entities and cache keys |
| I — Interface | 5 min | The API as the client sees it; component contracts |
| O — Optimizations & deep dives | 18 min | Feed rendering, the upload flow, optimistic interactions |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll confirm who uses this and on what, because that sets every budget. I'll assume mobile web first — most traffic is phones — with a desktop layout."

### Functional requirements

1. **Home feed**: a story tray on top, then posts newest first with infinite scroll; each post has a photo carousel, like, save, comment and a caption.
2. **Create**: pick up to ten photos, crop and filter them, add a caption, share; see the post appear.
3. **Post detail** with comments, **profile** with a photo grid, **Explore** grid with user search.
4. **Stories viewer**: full-screen, auto-advancing, tap to skip.
5. **Interactions** feel instant: double-tap to like, save, follow.

Out of scope: direct messages and video editing; I'll mention where the DM socket would live.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| LCP | < 2.5 s on a mid-range Android over 4G | The first photo is the product |
| INP | < 200 ms, including like and scroll | Taps must feel immediate |
| CLS | < 0.05 | Images loading must not push content around |
| Scrolling | 60 fps with hundreds of posts loaded | People scroll fast and far |
| JavaScript | < 150 KB gzipped for the feed route; composer and stories viewer lazy | Most sessions never post |
| Images | Never download more pixels than the slot shows | Data plans and memory |
| Accessibility | WCAG 2.2 AA; screen reader announces likes and failures | Icon buttons are most of the UI |
| Network | Uploads survive a dropped connection and a refresh | Phones lose signal |

---

## 🏗️ A — Architecture (8 min)

"This is a logged-in, highly interactive app with no SEO on the feed, so I'd build a client-rendered SPA with route-level code splitting. Profiles and single posts are shared publicly, so I'd server-render those two routes for link previews and a fast first paint — the feed doesn't need it."

```
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │ App shell · TanStack Router · one lazy chunk per route                                       │
 │ URL state: /  /explore  /create  /post/$postId  /profile/$username?tab=                      │
 └─────────────┬────────────────────────────────┬────────────────────────────────┬──────────────┘
               ▼                                ▼                                ▼
 ┌────────────────────────────┐   ┌────────────────────────────┐   ┌────────────────────────────┐
 │ FeedList + StoryTray       │   │ PostCard                   │   │ Composer                   │
 │ virtualized, measured rows │   │ like, save, comment        │   │ pick, crop, filter, share  │
 └─────────────┬──────────────┘   └─────────────┬──────────────┘   └─────────────┬──────────────┘
               │ (1) next page                  │ (2) optimistic like            │ (3) submit
               ▼                                ▼                                ▼
 ┌─────────────────────────────────────────────────────────────┐   ┌────────────────────────────┐
 │ Query cache · server state                                  │   │ Upload queue               │
 │ ['feed'] pages · ['post', id] · ['profile', name] · ['tray']│   │ draft + key K in IndexedDB │
 └──────────────────────────────┬──────────────────────────────┘   └─────────────┬──────────────┘
                                │ fetch, mutate, AbortSignal                     │ PUT, then POST
                                ▼                                                ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │ API client · cookie session · Idempotency-Key · typed errors (status) · retry policy         │
 └──────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                │ HTTPS: REST calls, signed PUT, image GETs
                                                ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Backend: Instagram API /api/v1 · image CDN · object storage (signed uploads)                 │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Scroll (1).** `FeedList` renders only the rows in view; near the end it asks the query cache for the next page using the cursor from the previous one.
2. **Like (2).** `PostCard` updates the cached post immediately, sends the request, and rolls back if it fails.
3. **Share (3).** The composer writes the draft and its idempotency key to the upload queue, which uploads the photos, then creates the post — retrying with the same key until it gets an answer.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Server data: feed pages, posts, profiles, tray | Query cache (TanStack Query) | Dedupe, retries, cancellation and invalidation without hand-written loading flags |
| Route, profile tab, Explore query | URL | Shareable and restored by the back button |
| Session: user, role | Small client store (Zustand) | Every route guard needs it; tiny |
| Draft, idempotency key, upload progress | Upload queue, persisted in IndexedDB | Survives a refresh and a lost connection |
| Carousel index, open menus, story progress | Component state | Never shared |

"The rule I'm applying: server data never gets copied into a client store. Once you copy it you own its staleness by hand, and a liked post would show liked in the feed and unliked on its detail page."

### Key interaction: liking a post

```
User                PostCard                      Feed cache                 Post API
  │                     │                              │                         │
  │ 1 double-tap photo  │                              │                         │
  │────────────────────▶│                              │                         │
  │                     │ 2 snapshot; liked, count +1  │                         │
  │                     │─────────────────────────────▶│                         │
  │ 3 heart fills now   │                              │                         │
  │◀────────────────────│                              │                         │
  │                     │                              │ 4 POST /posts/:id/like  │
  │                     │                              │────────────────────────▶│
  │                     │                              │ 5 200 {idempotent}      │
  │                     │                              │◀────────────────────────│
  │                     │   6 idempotent? undo the +1  │                         │
  ················ on error: restore snapshot, announce failure ··················
  │                     │                              │                         │
```

"Likes are optimistic because they almost always succeed and are trivial to undo. Two details make it honest: a second tap while the first request is in flight is ignored, so like and unlike can't race to the server; and the server answers `idempotent: true` when the post was already liked — say, from another tab — so I keep the heart filled but undo my +1, because the server's count already included it."

### Key interaction: sharing a post

```
User     Composer                      Feed cache   Post API   S3
  │          │                              │           │       │
  │ 1 Share  │                              │           │       │
  │─────────▶│                              │           │       │
  │          │ 2 resize to 1080 px; key K   │           │       │
  │          │ 3 POST /uploads                          │       │
  │          │─────────────────────────────────────────▶│       │
  │          │ 4 signed PUT URLs                        │       │
  │          │◀─────────────────────────────────────────│       │
  │          │ 5 PUT photo (progress bar)                       │
  │          │─────────────────────────────────────────────────▶│
  │          │ 6 POST /posts + Idempotency-Key K        │       │
  │          │─────────────────────────────────────────▶│       │
  │          │ 7 202 post, processing                   │       │
  │          │◀─────────────────────────────────────────│       │
  │          │ 8 prepend "processing" card  │           │       │
  │          │─────────────────────────────▶│           │       │
  ····· failure or timeout: Retry resends with the same K ·······
  │          │                              │           │       │
```

"Creation is not optimistic in the usual sense: the post id and image URLs only exist once the server assigns them. What I can show immediately is a 'processing' card at the top of my own feed with the local preview, which the cache replaces with the real post once it's published."

### Key interaction: scrolling the feed

```
User                       FeedList            Feed cache                Feed API
  │                            │                    │                        │
  │ 1 scrolls near the end     │                    │                        │
  │───────────────────────────▶│                    │                        │
  │                            │ 2 fetchNextPage()  │                        │
  │                            │───────────────────▶│                        │
  │                            │                    │ 3 GET /feed?cursor=c2  │
  │                            │                    │───────────────────────▶│
  │                            │                    │ 4 20 posts + c3        │
  │                            │                    │◀───────────────────────│
  │                   5 append page, skip seen ids  │                        │
  │                            │ 6 new rows         │                        │
  │                            │◀───────────────────│                        │
  │ 7 render rows in view + 3  │                    │                        │
  │◀───────────────────────────│                    │                        │
  │                            │                    │                        │
```

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Cache key | Freshness |
|--------|-------|-----------|-----------|
| `Post` | `id`, author (`username`, `avatarUrl`), `caption`, `media[]` (`url`, `width`, `height`, `filter`), `likeCount`, `isLiked`, `isSaved`, `status`, `createdAt` | `['post', id]` and inside feed pages | Patched by mutations; refetched on focus after 60 s |
| `FeedPage` | `posts: Post[]`, `nextCursor`, `degraded?` | `['feed']` (infinite query) | Head refetched on pull-to-refresh; older pages kept |
| `StoryRing` | `userId`, `username`, `avatarUrl`, `storyCount`, `hasSeen` | `['tray']` | 60 s; patched when I view a story |
| `Profile` | counts, `isFollowing`, `isPrivate`, grid pages | `['profile', username]` | Patched on follow |
| `Draft` | files, crops, filters, caption, `idempotencyKey`, `stage`, `progress` | IndexedDB `drafts` | Deleted after success |
| `Session` | `id`, `username`, `role` | Client store | Revalidated on focus and on any `401` |

Two modeling decisions:

- **One post, two places.** A post lives in a feed page and in `['post', id]`. A like mutation updates both through one helper, so the feed and the detail page never disagree. A fully normalized store would avoid the double write, but with four entity types it isn't worth a GraphQL-style cache.
- **`media` carries width and height.** The server sends dimensions with every image, so each row can reserve its exact aspect ratio before a single byte of the image arrives. That is what keeps CLS near zero in a virtualized list.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
GET    /api/v1/feed?cursor=&limit=20     → {posts, nextCursor, degraded?}
GET    /api/v1/posts/{id}                → Post incl. status, isLiked, isSaved | 404
POST   /api/v1/posts/{id}/like           → {idempotent}   DELETE to unlike
POST   /api/v1/uploads                   → signed PUT URLs
POST   /api/v1/posts                     multipart or JSON + Idempotency-Key → 202 {post, status}
GET    /api/v1/stories/tray              → StoryRing[]
POST   /api/v1/stories/{id}/view         → 200
GET    /api/v1/feed/explore?cursor=      → grid thumbnails + nextCursor
```

- The feed cursor is opaque (`<ms>_<id>`); the client passes it back untouched and never computes offsets.
- `404` means "not found or not visible", which is what the UI shows for a post from an account that went private.
- `degraded: true` means the server is protecting itself; the UI shows a banner rather than "you follow nobody".
- A `202` create response returns `status: processing`; the post page shows that state until it becomes `published`.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `<FeedList>` | Virtualized rows with measured heights; asks for the next page within ~2 screens of the end |
| `<PostCard post>` | Owns the carousel; like, save and comment through hooks; never fetches on its own |
| `useOptimisticToggle(active, count, on, off)` | Instant flip, in-flight guard, rollback on error, idempotent reconciliation |
| `<Composer>` / `useUploadQueue()` | Draft lifecycle: pick → edit → queue → upload → create, all retries with one key |
| `<StoryViewer users startIndex>` | Full-screen dialog with focus trap; preloads the next story's image |

---

## 🔧 O — Optimizations & Deep Dives (18 min)

### Deep dive 1: a feed that scrolls at 60 fps (7 min)

"The decision: virtualize the feed with measured rows, and treat images as the main performance budget."

**Virtualization with real heights.** Each post holds an image, actions and a caption — a few hundred posts would be thousands of DOM nodes and hundreds of decoded images, and mobile browsers kill the tab. A virtualizer renders only the rows in view plus three of overscan. Post heights vary (portrait versus square photos, one-line versus long captions), so rows are measured after render instead of assuming a fixed height; a fixed estimate accumulates offset error and makes the scrollbar jump.

**Images are the budget.**

1. Reserve space from the server's width and height (`aspect-ratio`), so nothing shifts when the image lands.
2. Ask for the right size: `srcset` with 320, 640 and 1080 renditions and `sizes` matching the column width, so a phone never downloads the 1080 version for a 360-pixel slot.
3. Load the first image eagerly with high fetch priority (it's the LCP element) and the rest lazily; decode off the main thread.
4. Show a tiny blurred placeholder (a few hundred bytes, sent inline with the post) while the real image loads.
5. Prefetch the next page's first images when the user is two screens from the end.

**Filters are applied where the photo is made, not where it's shown.** One option is to store the filter name and apply a CSS filter at render time — cheap, but every platform must reproduce the filter identically, and the image in someone's download isn't what they saw. I'd bake the filter into the pixels on the client (canvas or WebGL) before upload, and keep the CSS version only for the live preview.

| Approach | Verdict |
|----------|---------|
| ✅ Virtualized, measured rows + responsive images | Constant DOM size; pixels match the slot |
| ❌ Render every loaded post | Fine for 20, kills mobile tabs at 500 |
| ❌ Pagination buttons | Simple, but breaks the core scroll gesture |

**What I give up.** Measurement costs a layout read per row; fast flings into unmeasured territory can still shift slightly; and find-in-page can't see rows that aren't rendered.

### Deep dive 2: an upload flow that never posts twice (6 min)

"The scenario I design for: someone taps Share in an elevator, the request times out, and they tap again — or close the tab."

1. **Prepare on the device.** Resize to 1080 pixels and apply the filter in a Web Worker with `OffscreenCanvas`, so the main thread stays responsive and the upload is around 300 KB instead of 5 MB.
2. **Persist the draft.** Files, edits, caption and a fresh idempotency key (`crypto.randomUUID()`) go into IndexedDB before any network call. Editing the draft afterwards makes a new key, because it's now a different request.
3. **Upload, then create.** Photos go to signed URLs with a progress bar; then `POST /posts` with the key. Any retry — automatic, the Retry button, or a reopened tab that finds a pending draft — reuses the same key, and the server returns the original post instead of creating another.
4. **Show processing honestly.** The `202` says `processing`. My own feed shows the card with the local preview; the post page says "still processing"; the card swaps to the real images when the status turns `published`.

| Approach | Verdict |
|----------|---------|
| ✅ Persisted draft + idempotency key + processing state | Correct across timeouts, refreshes and double taps |
| ❌ Disable the button while pending | Stops double taps, not retries after a timeout or a reload |
| ❌ Fully optimistic post in followers' feeds | The server hasn't published it; followers can't see it yet anyway |

**What I give up.** IndexedDB code and a small state machine (`queued → uploading → creating → processing → done | failed`), plus storage for drafts until they succeed.

### Deep dive 3: optimistic interactions that don't lie (4 min)

- **One request at a time per toggle.** Double-tap sends at most one like; taps during a pending request are ignored, so the server never receives like and unlike out of order.
- **Snapshot and rollback.** On error, restore the post in every cache location and announce it in a polite `aria-live` region ("Couldn't like this post").
- **Reconcile with the server.** `idempotent: true` means the server already had that state: keep it, undo the count change.
- **Visibility changes.** A `404` on like means the post is gone or went private: remove it from cached pages instead of retrying.

### Deep dive 4: accessibility and security (1 min)

- Icon buttons have labels and `aria-pressed`; images have `alt` text from the caption or "Photo by {username}"; the stories viewer is a dialog with a focus trap, pause on focus, and reduced motion respected.
- Captions and comments render as text, never as HTML; links in them are parsed into elements with an `http`/`https` allow-list. The session cookie is `HttpOnly` and `SameSite=Lax`, and a strict Content-Security-Policy backs it up.

---

## 🧯 Loading, Error and Empty States (2 min)

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| First feed load | Three skeleton cards with real aspect ratios | Pending state of the first page only |
| Loading more | A spinner row at the bottom | Next-page pending state |
| Feed request failed | "We couldn't load your feed" + Try again | Error state; no automatic retry loop on every scroll |
| Paging failed | Loaded posts stay; "Couldn't load more · Retry" | Error held until an explicit retry |
| Server degraded | Banner "Your feed is temporarily unavailable" | `degraded: true` instead of an empty-feed message |
| Follows nobody | Suggested accounts to follow | Empty state as onboarding |
| Upload interrupted | Draft card with "Retry" | Draft and key in IndexedDB; retry reuses the key |
| Post still processing | Local preview with "Processing…" | `status: processing` from the server |
| Post no longer visible | "This post isn't available" | `404` handled as a state, not an error toast |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | SPA, SSR only for shared profile and post pages | SSR everywhere | The feed is private; previews need SSR |
| Server state | Query cache | Copying into a client store | One source per entity, no hand-written staleness |
| Long list | Virtualized, measured rows | Render everything | Constant DOM and memory |
| Images | `srcset`, reserved aspect ratio, placeholders | One full-size image | Pixels match the slot; no layout shift |
| Likes | Optimistic, in-flight guard, rollback | Wait for the server | Instant and still truthful |
| Create | Persisted draft + idempotency key | Disabled button | Survives retries and refreshes |
| Filters | Baked into pixels before upload | CSS at render time | What you see is what everyone sees |

"With more time I'd add a service worker that serves the last feed page and its images offline, background sync for queued uploads, and real-user Web Vitals by route and device class."
