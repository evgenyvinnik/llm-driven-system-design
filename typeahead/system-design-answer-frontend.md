# Typeahead — System Design Answer (Frontend Focus)

*Staff frontend engineer interview · 45–50 minutes · structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations*

> "A typeahead looks like a text box with a list under it. Three things make it hard. First, latency is measured against typing speed, not page loads: at five characters a second, a list that arrives 200 ms late already describes a prefix the user has typed past. Second, correctness under out-of-order async: it's easy to render suggestions for the wrong prefix. Third, the ARIA combobox is one of the most commonly broken accessibility patterns on the web. I'll design a reusable component that gets all three right once, so product teams don't each get them wrong."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| R — Requirements | ~5 min | Scope, numeric targets, what's out |
| A — Architecture | ~8 min | Headless controller, data access layer, one connected diagram |
| D — Data model | ~5 min | Who owns which state; what a cache entry actually guarantees |
| I — Interface | ~8 min | The server contract that makes caching possible; the component API |
| O — Optimizations | ~18 min | Three deep dives: request lifecycle, caching/prefetch, combobox interaction |
| Wrap-up | ~2 min | Trade-offs and what I'd validate first |

---

## 🎯 R — Requirements Exploration (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it changes the design | Assumption |
|----------|---------------------------|------------|
| One search box, or a component other teams reuse? | Reuse means a headless API, with accessibility owned centrally | Platform component. Web search is the main consumer; people pickers and a command palette reuse it |
| Text completions or rich results? | Rich rows mean variable heights, images, grouped sections | Mostly query completions, some entity rows (thumbnail + subtitle), grouped as "Recent" and "Suggestions" |
| Where does data come from? | Determines caching and cancellation | Remote API for search; local in-memory list for the command palette; one source abstraction serves both |
| Personalized for signed-in users? | Decides whether a response can be shared-cached | Yes, recent searches for signed-in users; anonymous users get global suggestions |
| Devices and networks? | JS budget, touch, virtual keyboard | Desktop and mobile web; the p75 device is a mid-range Android on 4G |
| Languages? | IME composition, RTL, Unicode normalization | 40+ locales including Japanese/Chinese/Korean (IME) and Arabic/Hebrew (RTL) |
| Offline? | Adds a storage layer | Degrade gracefully: show recent searches. No offline suggestions, since there are no offline results either |

### Functional requirements

1. As the user types, show ranked suggestions with the matched portion emphasized.
2. On focus with an empty input, show a zero state of recent searches, each removable.
3. Keyboard (↑ ↓ Home End Enter Esc Tab), pointer and touch selection. Selecting either navigates or fills the input; the consumer decides which.
4. Grouped sections and rich rows come from consumer-supplied renderers.
5. Emit impression and selection telemetry so ranking can learn.

### Non-functional requirements

| Property | Target | Why this number |
|----------|--------|-----------------|
| Input responsiveness | Each keystroke paints within a frame; INP < 100 ms on the p75 device | Suggestion work must never block the input |
| Suggestion latency | Cached prefix: same frame. Network: p75 < 150 ms after the request is sent | ~200 ms is one keystroke behind a normal typist |
| Correctness | Never render results for a prefix that isn't the current input, except an ancestor's results filtered to the current input | A wrong list erodes trust more than a slow one |
| Network efficiency | ≤ ~0.4 requests per keystroke on average | At global scale every keystroke is a request |
| Accessibility | WCAG 2.2 AA, WAI-ARIA APG combobox pattern | It's the primary control on the most-visited page |
| Bundle | Core < 8 KB gzipped; rich renderers lazy-loaded | It sits on the critical path of the landing page |

**Out of scope:** ranking and the index (the server is a black box, but I'll specify the contract I need from it), the results page, voice input.

> "I'll keep 'one keystroke behind' and 'never show the wrong prefix' in the corner of the board. Most of the deep dives come back to those two."

---

## 🏗️ A — Architecture / High-Level Design (~8 min)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER TAB                                                                          │
│                                                                                      │
│  ┌────────────────────┐      ┌─────────────────────────┐      ┌────────────────────┐ │
│  │ Search input       │      │ Suggestion popover      │      │ Live region        │ │
│  │ role=combobox      │      │ listbox · groups · rows │      │ "8 suggestions"    │ │
│  └─────────┬──────────┘      └────────────▲────────────┘      └─────────▲──────────┘ │
│            │ 1 keys · input ·             │ 7 items · activeId ·        │ 7 settled  │
│            │   composition                │   status                    │   count    │
│  ┌─────────▼──────────────────────────────┴─────────────────────────────┴──────────┐ │
│  │ TYPEAHEAD CONTROLLER — headless state machine, one per widget instance          │ │
│  │ inputValue · activeId · open · status · isComposing · lastAcceptedSeq           │ │
│  └─────────┬───────────────────────────────▲───────────────────────────┬───────────┘ │
│            │ 2 request(prefix, seq)        │ 6 merged list + seq       │ 8 select    │
│  ┌─────────▼───────────────────────────────┴───────────┐  ┌────────────▼───────────┐ │
│  │ DATA ACCESS LAYER                                   │  │ SELECTION EFFECTS      │ │
│  │ scheduler: debounce · in-flight cap · seq guard     │  │ onSelect → navigate    │ │
│  │ sources: remote · recent · static                   │  │ record recent search   │ │
│  │ merger: dedupe · group · cap                        │  │ enqueue telemetry      │ │
│  └────────┬───────────────────┬─────────────────┬──────┘  └───┬─────────────┬──────┘ │
│           │ 3 get/put         │ 4 fetch         │ 5 recents   │ 9 write     │ 10     │
│  ┌────────▼────────┐ ┌────────▼────────┐ ┌──────▼─────────────▼───┐ ┌───────▼──────┐ │
│  │ Prefix cache    │ │ HTTP cache      │ │ Recent-search store    │ │ Beacon queue │ │
│  │ memory LRU, TTL │ │ max-age · SWR   │ │ IndexedDB + mirror     │ │ batched      │ │
│  └─────────────────┘ └────┬───────▲────┘ └────────────────────────┘ └───────┬──────┘ │
└───────────────────────────┼───────┼─────────────────────────────────────────┼────────┘
            GET /suggest?q= │       │ q echo · items · ttl       POST /events │
                            ▼       │                                         ▼
  ┌─────────────────────────────────┴────────────────────────────────────────────────┐
  │ SERVER BOUNDARY (black box): Suggest API · History API · Events · CDN for anon   │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

**Walking the arrows for one keystroke and one selection:**

1. Input, keydown and composition events go to the controller, which updates `inputValue` synchronously. The input never waits for anything async.
2. The controller asks the data access layer for suggestions, tagged with a monotonically increasing sequence number.
3. The prefix cache is checked first. A hit answers within the same frame and sends no request.
4. On a miss, the scheduler decides when to send (debounce policy, in-flight cap). The request goes through the browser HTTP cache to the server. The response echoes the normalized `q`.
5. In parallel, the recent-search source prefix-matches the user's local history from an in-memory mirror, in under a millisecond.
6. The merger dedupes and groups. The guard drops any result whose seq is older than the last accepted one, or whose `q` isn't the current input or an ancestor of it.
7. The view renders; the live region announces the count only once results settle.
8. On selection, the controller hands off to selection effects, which (9) record the recent search, (10) queue telemetry (impression list, chosen position, latency), and call `onSelect`.

### Why this decomposition

**Headless controller with prop getters, not a monolithic component.** Product teams render whatever they want, but the core owns state transitions, keyboard handling, ids and every ARIA attribute, so a team can't forget `aria-activedescendant`.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Headless core + prop getters + render slots | One correct a11y/keyboard implementation; unlimited visual freedom | Consumers write more markup; prop-getter APIs need good docs |
| ❌ Monolithic `<Typeahead>` with props | Fastest for the first consumer | Prop explosion by the third team; forks appear and each fork breaks a11y differently |
| ❌ Web component | Framework-agnostic | ARIA id references can't cross shadow roots, so a consumer's own label, input or slotted rows break `aria-labelledby` / `aria-activedescendant`, the exact wiring we need |

**Instance-local state, not a global store.** Keystroke state lives in the controller. If `inputValue` lived in an app-wide store, every keystroke would notify every subscriber and compete with painting the character. The only shared state is the recent-search store: the header box and the page box show the same history, and a `BroadcastChannel` keeps tabs consistent.

**Where computation lives.** The server ranks and returns **match ranges**. The client merges history, dedupes and renders. The server returns highlight ranges rather than the client computing `startsWith`, because the server's normalization decides what matched: accent folding ("zur" matching "Zürich"), transliteration, and locale case rules (Turkish dotted İ). Naive client highlighting gets those wrong.

---

## 💾 D — Data Model (~5 min)

| Entity | Origin | Owner | Key fields | Lifetime |
|--------|--------|-------|------------|----------|
| SuggestResponse | Server | Data access layer | `q` (normalized echo), items, `complete` flag, `ttl`, `rankingVersion` | Cached per prefix |
| SuggestionItem | Server | Popover rows | stable `id`, `kind` (query / entity / navigational), text, match ranges, secondary text, thumbnail, destination URL, badges (trending) | Inside a response |
| RecentSearch | Client, persistent (synced when signed in) | Recent-search store | normalized text, display text, `lastUsedAt`, use count, origin (local / synced) | Capped at 50; user-deletable |
| PrefixCacheEntry | Client, derived | Prefix cache | key = locale + user scope + normalized prefix; response; `fetchedAt`; `complete` | Server TTL; LRU of ~200 |
| TypeaheadState | Client, ephemeral | Controller | `inputValue`, `isComposing`, status, items, `activeId`, highlight source (keyboard / pointer), `lastAcceptedSeq` | Widget lifetime |
| TelemetryEvent | Client → server | Beacon queue | session id, prefix at impression, item ids shown, selected position, latency, cache source | Until flushed |

Four details here prevent most of the bugs:

- **Cache key and display text are different strings.** The key is NFKC-normalized, locale-lowercased, with internal whitespace collapsed. It **keeps a trailing space**, because "new" and "new " are different queries: the first completes to "newsletter", the second to "new york".
- **`activeId`, not `activeIndex`.** When the list changes underneath the user, an index silently points at a different item. An id either still exists or it doesn't. Deep dive 3 builds on this.
- **`complete` means the set is exhaustive.** If "weat" returned fewer than `limit` items, the server has told us every completion, so "weath" can be answered by filtering locally. Without that flag, a parent's top 8 cannot be filtered into a child's top 8, because the child's best item might have been the parent's 9th.
- **"Pending with previous results" and "pending with nothing" are different states.** Only the second ever shows a spinner.

```
┌──────┐  focus, empty   ┌────────────┐  input ≥ minChars   ┌─────────┐
│ idle │────────────────▶│ zero-state │────────────────────▶│ pending │
└──▲───┘                 └─────▲──────┘                     └──┬───▲──┘
   │ blur · Esc                │ input cleared        response │   │ new input
   │                           │                               ▼   │
   │                     ┌─────┴───────────────────────────────────┴────┐
   └─────────────────────┤ showing · empty · error                      │
                         └──────────────────────────────────────────────┘
```

---

## 🔌 I — Interface Definition (~8 min)

### Server contract: what I need from the black box

```
GET    /v1/suggest?q={prefix}&locale={l}&limit=8&client=web   → ranked items for the prefix
GET    /v1/suggest/zero?locale={l}                             → zero-state items (trending) for an empty focus
GET    /v1/history?limit=50                                    → signed-in recent searches, for sync
DELETE /v1/history/{id}                                        → remove one recent search
POST   /v1/events            (sendBeacon, batched)             → impressions, selections, abandonment
```

| Response field | Why the client needs it |
|----------------|-------------------------|
| `q` (normalized echo) | Identity check before rendering. Lets the client drop a mismatched response even when abort didn't happen in time |
| `complete` | Lets the client answer longer prefixes by filtering locally |
| item match ranges | The server's normalization decides what matched; the client can't recompute it correctly |
| `ttl` | The server knows which prefixes are volatile (trending) and which are stable |
| item `id` | Stable keys for rendering and for `activeId` |
| `rankingVersion` | Telemetry joins a selection to the model that produced the list |

**Protocol: HTTP GET, not WebSocket.**

> "A WebSocket would save request headers, but the URL is our cache key. A GET for `q=wea` can be answered by the browser HTTP cache, by a CDN, or by an edge node, without our server ever seeing it. On a socket, every message reaches the origin. HTTP/2 already multiplexes requests and compresses headers, so the per-request overhead WebSocket would save is about a hundred bytes. I'd rather keep the cache hierarchy."

**Personalization must not poison cacheability.** Anonymous responses are `public, max-age=60, stale-while-revalidate=60`, keyed only by URL. I keep personalization out of that URL. Signed-in users' recent searches are synced to the client (50 items, a few KB) and blended locally by the merger. The suggest request can then be **cookieless**: smaller requests, and the CDN can share one cached response across every user typing "wea". The cost: server-side personalization beyond history (interest-based boosts, say) isn't possible on this path. If product needs it, a parallel private `GET /v1/suggest/personal` feeds the same merger, and the global request stays cacheable.

### Component API for consuming teams

| Category (RADIO) | Props | Notes |
|------------------|-------|-------|
| Data | sources, `value` / `defaultValue` (controlled or not), initial items | A source takes a query and an abort signal and resolves items. Cancellation is part of the contract, so every source can be cancelled |
| Callbacks | `onSelect(item, how)`, `onInputChange`, `onOpenChange`, `onHighlightChange`, `onRemoveRecent` | `how` is keyboard, pointer or Tab. Behavior and telemetry differ by method |
| Configuration | `minChars`, debounce policy, `maxItems`, `openOnFocus`, `autoHighlightFirst`, `inlineCompletion`, group order | Defaults tuned per surface: search vs command palette |
| Styling | `className`, per-part class names, density | No inline styles, so it's themeable |
| Render slots | `renderItem`, `renderGroupHeader`, `renderEmpty`, `renderLoading`, `renderFooter` | Inversion of control for rich rows |

The hook also returns **prop getters**: input props, label props, listbox props and option props. Each merges the consumer's handlers with the core's and stamps ids, roles and ARIA state. Of everything in this design, this is the lever that makes accessibility hold across an organization of 30 teams.

**Inter-component communication:** props and callbacks within a widget; a tiny observable store for recent searches (shared by instances, synced across tabs); window events only for the global "/" focus shortcut. No global store for keystroke state.

---

## 🔧 O — Optimizations and Deep Dives (~18 min)

> "I'll go deep on three areas: the request lifecycle, where most shipped typeaheads have bugs; caching and prefetching, where the latency actually goes; and the combobox interaction model, covering accessibility, IME, and what I call the Enter race."

### Deep dive 1: Request lifecycle — debounce, cancellation and ordering (~7 min)

```
keystroke      w         we        wea                weat
time (ms)      0         90        180                260
request        (skip)    (skip)    A "wea"  ─────────────────────────────────┐
                                                      B "weat" ──────┐       │
                                                                     ▼ 420   ▼ 610
                                                          render B (newest)  A lands late:
                                                                             drop, or show as
                                                                             filtered interim?
```

**Debounce is a server-load tool with a latency cost.** A fixed 150 ms debounce adds 150 ms to *every* suggestion served from the network, which is most of the budget. So:

- **No debounce on cache hits.** They're free; answer immediately.
- **On a miss, use a short debounce of 60–100 ms that adapts to the user's measured inter-keystroke interval.** A hunt-and-peck typist at 300 ms per key gains nothing from waiting. A fast typist at 80 ms per key benefits from skipping prefixes they'll never pause on. The scheduler keeps a rolling median of the last few intervals.
- **Throttle is the wrong tool.** It fires mid-word on a fixed clock, which guarantees requests for prefixes nobody pauses on.

**Ordering: three mechanisms that guarantee different things.**

| Mechanism | Guarantees | Does not guarantee |
|-----------|------------|--------------------|
| `AbortController` on each new request | Frees the socket and skips parsing | Correctness. A response that already resolved, or a cache hit that doesn't trigger an abort, can still land late |
| Sequence number (`lastAcceptedSeq`) | An older request never overwrites a newer one | That the result fits the *current* input after a backspace |
| `q` echo checked against the current input | The rendered list belongs to the current input or an ancestor of it | — |

> "Abort is an optimization; the sequence and echo checks are what make it correct. Abort-only implementations have a hole: a synchronous cache hit for 'weat' renders, but nothing aborted the in-flight network request for 'wea', so that request lands 300 ms later and overwrites the right list with the wrong one. Our own demo's API client has exactly this bug. Abort also doesn't save server work: on HTTP/2 the stream is reset after the server has already done the lookup. The real server-side savings are requests you never send."

**Starvation on slow networks.** Abort-on-every-keystroke means a fast typist on a 400 ms RTT connection sees *nothing* until they stop typing. Every request dies before it lands. My policy:

1. Allow up to two requests in flight.
2. Don't abort a request whose prefix is an *ancestor* of the current input. When "wea" lands while the input says "weat", filter it to items starting with "weat" and render that as an **interim** result (flagged in telemetry). It's never wrong, only possibly incomplete.
3. Abort when the in-flight prefix stops being an ancestor (the user backspaced or edited the middle).

| Approach | Outcome |
|----------|---------|
| ❌ Fixed 150 ms debounce + abort-all | Simple, but adds 150 ms to every miss, starves slow networks, and still races on cache hits |
| ❌ Throttle | Requests for prefixes nobody pauses on; still needs an ordering guard |
| ✅ Cache-first, adaptive short debounce, ≤2 in flight, seq + echo guard, ancestor-filtered interim results | More scheduler state, but correct by construction and fast for both slow and fast typists |

What I give up: a slightly more complex scheduler, and interim lists that are occasionally less relevant than the final one. I accept that. A list that is a correct subset beats an empty dropdown, especially on the networks where the dropdown would otherwise stay empty.

### Deep dive 2: Caching and prefetching — making the next keystroke free (~6 min)

> "For every cache layer I'd ask what it catches that the layer above it doesn't. A count of layers doesn't tell you that."

| Layer | Holds | What it catches | Decision |
|-------|-------|-----------------|----------|
| In-memory prefix cache (per tab, LRU ~200, server TTL) | normalized prefix → response | Backspace, retyping, revisits, children derived from `complete` parents | ✅ Ship |
| Browser HTTP cache | URL → response with max-age + SWR | Revisits across navigations and tabs, at no cost | ✅ Ship; it already honors the server's headers |
| IndexedDB, recent searches only | The user's own history (≤50) | Zero state at startup, offline | ✅ Ship; user-owned data has to survive restarts |
| Service worker cache for suggestions | A second copy of the HTTP cache | Nothing the HTTP cache doesn't | ❌ Cut for v1. A stopped worker has to boot before it can answer a fetch, which costs tens of ms on mobile, exactly where we're latency-bound. It also re-implements cache semantics and adds an invalidation surface |
| IndexedDB copy of suggestions / an offline trie | — | Offline suggestions | ❌ Cut. Async reads, storage eviction and stale data for a feature with no offline results page to land on |

**Answers derived without a request:**

- **Backspace** is always free: the parent prefix is in the cache.
- **Exhaustive parents.** If "weat" was `complete`, every longer prefix is a local filter.
- **Non-exhaustive parents** give an interim answer while the real request runs. This is the same ancestor-filter rule as deep dive 1, applied to cached data.

**Prefetching: spend speculation where it pays.**

- **On focus:** preconnect to the suggest origin (TLS setup is 1–2 RTTs on mobile, more than the request itself) and fetch the zero state. Focus-to-first-keystroke is typically 300–800 ms of idle network.
- **No speculative next-character prefetch.** Guessing "weat" from "wea" (by keyboard adjacency or a client model) yields low hit rates. At hundreds of thousands of QPS, a 10% hit rate nearly doubles server load to save a round trip the debounce window already hides.
- **Prefetch the destination, not the suggestion.** What users experience as "search speed" is the time from Enter to the results page. When an item has been highlighted by arrow keys or hovered for ~100 ms, I add a Speculation Rules prefetch for its results URL (prerender only for the top item, at moderate eagerness). Enter then feels instant. This is the largest perceived-latency win in the whole design, and it isn't in the typeahead's own latency numbers.

**Invalidation is mostly unnecessary by construction.** Global suggestions are a pure function of (locale, prefix, ranking version) and expire by TTL. Personal recents come from the local store, so a search the user just ran shows up in recents immediately. Signing in or out clears the prefix cache because the user scope is part of the key. One bound matters: the server keeps `stale-while-revalidate` short (60 s), because each extra staleness window delays a legal takedown on the client.

### Deep dive 3: The combobox interaction model — accessibility, IME and the Enter race (~5 min)

**ARIA 1.2 combobox, done properly:**

- DOM focus **stays on the input**. `aria-activedescendant` points at the highlighted option's id. Moving real focus into the list breaks typing, the caret and IME composition.
- The input has `role=combobox`, `aria-expanded`, `aria-controls` (the listbox id) and `aria-autocomplete="list"`, or `"both"` with inline completion. Options get `role=option` and `aria-selected`. Groups are `role=group` labelled by their header.
- **Live region etiquette:** announce "8 suggestions" politely, ~500 ms after results settle, not on every keystroke. Otherwise screen reader users hear "5 results, 7 results, 6 results" talking over their own typing echo.
- **Row actions break the listbox role.** A "remove" button inside a recent-search row is an interactive control nested in an option, which is invalid. Two options: a keyboard shortcut (Shift+Delete, as in Chrome's omnibox) announced through the option's description, with a pointer-only button; or switch the popup to the grid pattern so each row can have cells. I'd ship the shortcut first. The grid pattern is correct but significantly more complex for every consumer.

**The Enter race.** The user arrows down twice to "weather radar". A late response replaces the list. Index 2 is now "weather tomorrow", and Enter selects something they never saw highlighted. My rule: **never change what Enter will do without the user seeing it.**

- Track `activeId`. If the highlighted item survives the update, keep it highlighted at its new position.
- While the user is navigating by keyboard, **freeze the list**: buffer incoming results until the next character is typed.
- While the pointer is over the list, don't reorder rows under the cursor. Append or defer instead.

**Layout stability.** Keep previous results visible while pending; no flash to a spinner. Show a spinner only after ~300 ms with nothing to display. Use fixed row heights and sized thumbnails so the popover never shifts. Rich renderers are code-split, but their skeleton dimensions are known up front.

**IME composition (Japanese, Chinese, Korean).** While composing, the input holds unconverted text, and Enter *commits the conversion*. It must not select a suggestion, so key handling checks the composition state. Japanese users expect suggestions for the kana reading as they type, so fetching during composition is allowed. But I never rewrite the input value (inline completion) during composition, because that breaks the IME.

**Mobile.** The virtual keyboard covers half the screen. On small viewports the popover becomes a full-screen takeover sized from the `visualViewport`. The input uses `type=search`, `enterkeyhint=search`, autocapitalize/autocorrect/spellcheck off, 44 px touch targets, and the active option is scrolled into view.

**Security.** Suggestions are user-generated strings, which makes them an XSS vector. They're rendered as text, never as HTML. This is the second reason the server returns match *ranges* rather than `<b>` markup.

| Popup pattern | Pros | Cons |
|---------------|------|------|
| ✅ Listbox + keyboard shortcut for row actions | Best screen reader support, simplest for consumers | Row actions are less discoverable |
| ❌ Grid popup | Real per-row actions | Two-dimensional navigation; uneven screen reader support |
| ❌ Moving DOM focus into options | Easy to build | Breaks typing, the caret and IME; fails the APG pattern |

### Resilience and degradation (~1 min)

> "Search has to work even when suggestions don't. Every failure below degrades the dropdown, never the input."

| Condition | Behavior |
|-----------|----------|
| Suggest API slow (> 1 s) or returning 5xx | Keep showing recents and any ancestor-filtered cache entry; no error banner in the dropdown. Retry on the next keystroke, never in a background loop |
| Offline (fetch fails fast) | Zero state and recents only, labelled "Recent searches"; submitting goes to the results page, which owns the offline message |
| Rate limited (429) | Honor `Retry-After` and raise the debounce floor for the rest of the session |
| JS failed or is still loading | The input is a real form field with an action URL, so Enter performs a plain search (progressive enhancement) |
| IndexedDB unavailable (some private modes) | In-memory recents for the session; no error |

### Performance and observability (~2 min)

- **Measure what users feel:** keystroke-to-suggestions-painted, from the input event's timestamp to the frame after commit, split by source (memory / HTTP cache / network / interim). Also INP on the search page, requests per keystroke, stale responses dropped, selection rate, mean selected position, abandonment.
- **No virtualization for 8–10 rows.** It adds `aria-setsize`/`aria-posinset` bookkeeping and scroll-into-view edge cases for no gain. Only the command palette, with thousands of local items, virtualizes.
- **Typing before hydration.** The search input is server-rendered, so users can type before JS loads. On hydrate, the controller reads the input's current value and focus state and issues the first request, so early keystrokes aren't lost. The core (controller + data access layer) loads eagerly; renderers are lazy.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Component shape | Headless core + prop getters | Monolithic component | One a11y implementation, unlimited visuals |
| Keystroke state | Instance-local controller | Global store | Avoids app-wide re-renders on every key |
| Highlighting | Server match ranges | Client `startsWith` | Server normalization decides what matched; no HTML injection |
| Request timing | Cache-first + adaptive short debounce | Fixed 150 ms debounce | No added latency on hits or for slow typists |
| Ordering | Seq + echo guard, abort as optimization | Abort-only | Closes the cache-hit race |
| Slow networks | ≤2 in flight + ancestor-filtered interim | Abort-all | Prevents starvation |
| Protocol | HTTP GET | WebSocket | The URL is the cache key; the CDN absorbs load |
| Personalization | Local blend of synced recents | Personalized server response | Keeps the suggest request public and cookieless |
| Cache layers | Memory + HTTP cache + IndexedDB (recents) | + service worker suggestion cache | The worker catches nothing new and costs a boot |
| Prefetch | Destination (Speculation Rules) on highlight | Next-character guessing | Optimizes time-to-results; avoids load amplification |
| List updates | `activeId` + freeze while navigating | Index-based highlight | Prevents the Enter race |

---

## 📝 Wrap-up (~2 min)

> "To summarize: a headless controller owns state and accessibility; a data access layer owns timing, caching and ordering; and a server contract (normalized echo, `complete`, match ranges, public cacheable responses) lets the client avoid most requests. The hardest decisions were giving up a fixed debounce, treating abort as an optimization rather than a guarantee, and cutting the service worker layer.
>
> What I'd validate first: instrument keystroke-to-paint by source before tuning anything; A/B the adaptive debounce against a fixed one on both requests per keystroke and selection rate; and test the combobox with NVDA, JAWS, VoiceOver and TalkBack, plus Japanese and Korean IMEs, early, because those are the failures you don't see in your own browser."

### How the local implementation compares

The repo's `frontend/` demonstrates part of this design, on two paths. The search page runs `SearchBox` → a Zustand store → `services/api.ts`. The `/widgets` route mounts four widgets on a shared `useTypeahead` hook, which adds an IndexedDB suggestion cache in front of the network. Both use a fixed debounce: 150 ms, or 100 ms in the command palette. Ordering is guaranteed by a request sequence number, as deep dive 1 argues: every settle from a superseded request is ignored, so a memory-cache hit can no longer be overwritten by an older in-flight response. Abort is scoped per input and only saves the wasted request. The client does not compare the echoed `q`. `services/api.ts` keeps a 1,000-entry memory LRU with a 60 s TTL, keyed by prefix, `userId`, limit and fuzzy flag. Personalized requests are fetched with `cache: 'no-cache'` and revalidate against a weak ETag. The service worker (production builds only) serves those only when offline and applies stale-while-revalidate to anonymous API calls. The keyboard-adjacency prefetcher I argue against above was deleted unused. Remaining gaps relative to this answer: the debounce is fixed rather than adaptive, highlighting is computed client-side, and there is no keystroke-to-paint instrumentation (`services/performance.ts` exists but isn't wired in).
