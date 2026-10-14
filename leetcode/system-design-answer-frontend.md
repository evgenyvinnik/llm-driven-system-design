# 🧑‍💻 LeetCode (Online Judge) — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "The frontend of an online judge is two products in one page. The problem statement is a document — public, read far more than it's solved, and worth ranking in search. The editor is an application — heavy, stateful, and the place where a coder can lose twenty minutes of work to a refresh. Around both sits an asynchronous verdict that takes seconds to arrive. So I'll design for three things: code is never lost, a submission is never duplicated or misreported, and the page feels fast even though the editor is the heaviest thing on it."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, performance and accessibility targets |
| A — Architecture | 9 min | Rendering split, component tree, who owns which state |
| D — Data model | 5 min | Client entities, cache keys, freshness |
| I — Interface | 5 min | The API as the client sees it; component contracts |
| O — Optimizations & deep dives | 17 min | The editor, submit and verdict UX, the problem list |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll confirm who uses this and on what, because it sets the performance budget and the editor choice."

### Functional requirements

1. **Problem list**: ~3,000 problems with difficulty, solved status and acceptance rate; filter, search and sort.
2. **Problem workspace**: statement with examples on one side; editor with language picker, Run and Submit on the other; resizable panes.
3. **Run**: results per sample case — input, expected, actual, error.
4. **Submit**: live progress ("Running test 3 of 10") and a verdict with the failing test when allowed.
5. **History and progress**: past submissions per problem, solved counts by difficulty.
6. **Contests**: countdown, problem set, and a scoreboard with "my rank".

Out of scope: discussions, video solutions, collaborative editing.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| LCP on a problem page | < 2.0 s on a mid-range laptop, < 2.5 s on mobile | The statement is what people came to read |
| INP | < 100 ms while typing in a 500-line file | Input lag in an editor feels broken |
| CLS | < 0.1 | The editor and verdict panel reserve their space |
| JavaScript | < 150 KB gzipped before the editor; editor chunk loaded in parallel with the statement | Most visits to a statement come from search |
| Durability of drafts | Survive refresh, language switches, closed tabs, expired sessions | Losing code is the worst thing this UI can do |
| Accessibility | WCAG 2.2 AA; full keyboard use; verdicts announced | The verdict is an asynchronous result |
| Devices | Desktop-first; mobile for reading and light edits | People solve on laptops, browse on phones |

---

## 🏗️ A — Architecture (9 min)

### Rendering: the statement is a document, the editor is an app

"Problem statements are public, change rarely and bring in search traffic, so I pre-render them to static HTML at the CDN and revalidate when a problem changes. The workspace — editor, Run, Submit, history — is client-rendered inside that page and loaded as its own chunk, starting while the statement paints. A pure SPA would make search engines and first-time visitors wait for JavaScript to see a statement; server-rendering the editor buys nothing, because it's useless until hydrated and depends on the user's session and drafts."

```
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │ App shell · React Router · RootLayout restores the session once                              │
 │ URL state: /problems?difficulty=…&q=…  ·  /problems/:slug  ·  /contests/:id?page=…           │
 └──────────────────────┬────────────────────────────────┬──────────────────┬───────────────────┘
                        │                                │                  │
                        │ /problems/:slug (lazy)         │ /problems?q=…    │ /contests/:id (lazy)
                        ▼                                ▼                  ▼
 ┌────────────────────────────────────────────┐  ┌───────────────┐  ┌───────────────────────────┐
 │ ProblemWorkspace                           │  │ ProblemTable  │  │ StandingsPage             │
 │ Statement · CodeEditor · RunPanel          │  │ virtualized   │  │ rank table · my rank      │
 │ VerdictPanel (aria-live)                   │  │ <table>       │  │ contest countdown         │
 └──┬──────────────┬─────────────────┬────────┘  └───────┬───────┘  └───────┬───────────────────┘
    │              │                 │                   │                  │
    │ save draft   │ (1) submit      │ (2) poll          │ catalog          │ (3) standings
    │ (500 ms)     │ + key K         │ with backoff      │                  │ every 15 s
    │              │                 │                   │                  │
    ▼              ▼                 ▼                   ▼                  ▼
 ┌──────────────┐ ┌─────────────────────────────────────────────────────────────────────────────┐
 │ Draft store  │ │ Server-state cache · TanStack Query                                         │
 │ Zustand +    │ │ ['problems', filters] · ['problem', slug] · ['submission', id, 'status']    │
 │ localStorage │ │ ['standings', contestId, page] · dedupe, retries, refetchInterval           │
 └──────────────┘ └─────────────────────┬───────────────────────────────────────────────────────┘
                                        │
                                        │ fetch
                                        ▼
                  ┌─────────────────────────────────────────────────────────────────────────────┐
                  │ API client · fetch + AbortSignal · Idempotency-Key header                   │
                  │ typed errors (ApiError, RateLimitError) · 401 → login · Retry-After         │
                  └─────────────────────┬───────────────────────────────────────────────────────┘
                                        │
                                        │ HTTPS · session cookie
                                        ▼
                  ┌─────────────────────────────────────────────────────────────────────────────┐
                  │ Backend · Submission API (/api/v1) · Contest Service                        │
                  └─────────────────────────────────────────────────────────────────────────────┘
```

1. **Submit (1).** The workspace flushes the draft, freezes the code with a fresh idempotency key, and runs a mutation through the query cache; the API client sends the key in a header and retries network errors with the same key.
2. **Poll (2).** The verdict panel subscribes to the submission's status query. Its refetch interval backs off from 0.5 s to 5 s and stops at the first terminal status; progress goes to an `aria-live` region.
3. **Standings (3).** The contest page's standings query refetches every 15 s, only while the tab is visible.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Problems, problem detail, history, standings, submission status | Server-state cache (TanStack Query) | Dedupe, retries, cancellation, refetch intervals and invalidation without hand-written loading flags |
| Code drafts per problem and language, preferred language | Zustand store persisted to `localStorage` | Client-owned data that must outlive the page |
| Pending submit's idempotency key | Component state mirrored to `sessionStorage` | A refresh mid-submit can resend the same key |
| Filters, search, sort, contest page | URL search params | Shareable, bookmarkable, back-button friendly |
| Pane sizes, open tab, dialogs | Local component state (pane sizes persisted) | Never shared |

"The rule I'm applying: server data never gets copied into a client store, and client-owned data — drafts — never round-trips through the server on every keystroke. Each piece of state has exactly one owner."

### Key interaction: submitting

```
 Coder         Workspace              Query cache          API client                Backend
   │               │                       │                    │                       │
   │ 1 Ctrl+Enter  │                       │                    │                       │
   │──────────────▶│                       │                    │                       │
   │               │ 2 flush draft, new key K, disable button   │                       │
   │               │ 3 mutate(code, K)     │                    │                       │
   │               │──────────────────────▶│                    │                       │
   │               │                       │ 4 submit(code, K)  │                       │
   │               │                       │───────────────────▶│                       │
   │               │                       │                    │ 5 POST (key K)        │
   │               │                       │                    │──────────────────────▶│
   │               │                       │                    │ 6 network error       │
   │               │                       │                    │◀──────────────────────│
   │               │                       │                    │ 7 retry, same K       │
   │               │                       │                    │──────────────────────▶│
   │               │                       │                    │ 8 202 {submissionId}  │
   │               │                       │                    │◀──────────────────────│
   │               │ 9 start status query  │                    │                       │
   │               │◀──────────────────────│                    │                       │
   │               │                       │                    │                       │
```

"Submit is deliberately *not* optimistic: there's no verdict to show until the judge produces one, and pretending otherwise would lie. What I make instant is feedback — the button switches to 'Submitting…' in the same frame — and what I make safe is the retry, by reusing the key."

### Key interaction: waiting for the verdict

```
VerdictPanel                  Status query                API client                   Backend
      │                             │                          │                          │
      │ 1 subscribe(id)             │                          │                          │
      │────────────────────────────▶│                          │                          │
      │                             │ 2 getStatus(id, signal)  │                          │
      │                             │─────────────────────────▶│                          │
      │                             │                          │ 3 GET …/status           │
      │                             │                          │─────────────────────────▶│
      │                             │                          │ 4 running, test 3 of 10  │
      │                             │                          │◀─────────────────────────│
      │ 5 progress → aria-live      │                          │                          │
      │◀────────────────────────────│                          │                          │
      │                             │ 6 poll again (1–5 s)     │                          │
      │                             │─────────────────────────▶│                          │
      │                             │                          │ 7 wrong_answer, test 4   │
      │                             │                          │◀─────────────────────────│
      │ 8 verdict; refresh history  │                          │                          │
      │◀────────────────────────────│                          │                          │
      ···························· the coder leaves the page ······························
      │ 9 unmount → abort           │                          │                          │
      │────────────────────────────▶│                          │                          │
      │                             │                          │                          │
```

"Polling is just a query whose refetch interval depends on the data: half a second at first, because most runs finish in a few seconds, then backing off to five. It stops on a terminal status, aborts its in-flight request when the coder leaves the page, and keeps going through network errors. Because every status change lands in a polite live region, a screen-reader user hears 'Running test 3 of 10' and then 'Wrong Answer on test 4' without losing their place in the editor."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Cache key | Freshness |
|--------|-------|-----------|-----------|
| `ProblemSummary` | `id`, `slug`, `title`, `difficulty`, `acceptance`, `myStatus` | `['problems', {difficulty, q, sort}]` | Catalog index fetched whole; `staleTime` 5 min |
| `Problem` | statement (markdown), examples, limits, starter code per language, sample cases | `['problem', slug]` | Static per problem version; long `staleTime` |
| `SubmissionStatus` | `status`, `currentTest`, `testCasesTotal`, `runtimeMs`, `errorMessage` | `['submission', id, 'status']` | Polled until terminal, then immutable |
| `SubmissionSummary` | `id`, `language`, `status`, `runtimeMs`, `createdAt` | `['submissions', slug]` | Invalidated when a verdict arrives |
| `StandingsPage` | `rows[50]`, `myRank`, `frozen`, `asOf` | `['standings', contestId, page]` | Refetch every 15 s while visible |
| `Draft` | `code` | `drafts['two-sum:python']` in the persisted store | Saved 500 ms after typing stops |

Two modeling decisions:

- **Terminal statuses are immutable.** Once a status query returns `accepted` or any other final verdict, I set its `staleTime` to infinity. The server guarantees verdicts never change, so the client never needs to ask again.
- **Drafts are keyed by problem *and* language.** Switching from Python to C++ and back must restore the Python code; one draft per problem would overwrite it with the C++ starter.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
GET  /api/v1/problems?difficulty&q&sort        → {problems, pagination}   (the whole index, paged at 500)
GET  /api/v1/problems/{slug}                    → statement, samples, limits, starter code
POST /api/v1/runs                               {slug, language, code}         → 202 {runId}
POST /api/v1/submissions                        {slug, language, code} + Idempotency-Key → 202 {submissionId} | 200 duplicate | 422 | 429
GET  /api/v1/submissions/{id}/status            → status, progress, verdict; Retry-After while running
GET  /api/v1/problems/{slug}/submissions        → my history for the problem
GET  /api/v1/contests/{id}/standings?page       → {rows, myRank, frozen, asOf}
```

- Errors carry a status the client can act on: `401` sends the coder to log in with drafts intact; `404` on a status poll stops polling; `422` means a client bug (key reuse); `429` and `503` include `Retry-After`, which the UI turns into a countdown on the button.
- A `200` with `duplicate: true` on submit is not an error: the same code is already being judged, so the UI attaches to that submission.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `<CodeEditor language value onChange />` | Controlled; never re-mounts on language change; exposes a keymap for Ctrl+Enter (submit) and Ctrl+' (run) |
| `useDraft(slug, language)` | Returns the saved draft or the starter code; debounced save; flushes on language switch and before submit |
| `useSubmit()` | Freezes code, owns the idempotency key and the retry policy; returns the submission id |
| `useSubmissionStatus(id)` | Backoff polling, abort on unmount, stops at terminal statuses; returns `{data, stalled}` |
| `<VerdictPanel status />` | Renders progress and verdicts inside one polite live region |
| `<ProblemTable problems filters />` | Virtualized `<table>` with fixed 48 px rows, `aria-rowcount` and `aria-rowindex` |

---

## 🔧 O — Optimizations & Deep Dives (17 min)

### Deep dive 1: an editor that is fast to load and never loses code (6 min)

**Choosing the editor.**

| Option | Verdict |
|--------|---------|
| ✅ CodeMirror 6 | Modular: core plus one language pack is a fraction of Monaco; works on touch devices; language packs load on demand |
| ❌ Monaco (VS Code's editor) | Megabytes of JavaScript and workers for IntelliSense that a single-file algorithm problem doesn't need; poor on mobile |
| ❌ A plain `<textarea>` | Tiny, but no highlighting, bracket matching or indentation — people would paste from their IDE instead |

"In this repository the whole workspace route — CodeMirror, two language packs, the theme and the markdown renderer — is a 235 KB gzipped chunk, and moving it behind a lazy route cut the initial bundle from 339 KB to 106 KB gzipped. I'd go further in production: start fetching the editor chunk from the statement page's `<head>` with a preload, so it downloads while the statement paints, and load language packs only when picked."

**Never losing code.** Drafts live in a persisted client store keyed by problem and language. I save 500 ms after typing stops rather than on every keystroke, because the persist middleware serializes every draft on each write — with fifty saved drafts that's a noticeable stall in the middle of typing, which shows up directly as INP. The pending save is flushed synchronously on a language switch and before submit, so neither can lose the last half-second. Reset clears the draft and restores the starter code, behind a confirmation.

**What I give up.** Drafts are per device. Server-side draft sync is the next step if people move between machines, but it adds write load and conflict handling for something `localStorage` does well.

### Deep dive 2: submit and verdict UX that tells the truth (6 min)

"Three failure modes I'm designing out: a duplicate submission after a timeout, a coder stuck on 'Submitting…' forever, and a verdict that changes after being shown."

1. **Duplicates.** One idempotency key per Submit, created after the draft is flushed and the code frozen, kept in `sessionStorage` until a response arrives. Network errors and `5xx` are retried twice with the same key; the server returns the original submission. Editing the code after a failure creates a new key on the next click — it's a different request.
2. **Stuck states.** Every async state has an exit: polling gives up after five minutes with "still judging — your verdict will appear in Submissions"; a `401` mid-poll shows a login dialog over the workspace with the draft untouched; a `503` on Run shows "Judge busy, try again in 30 s" from `Retry-After`.
3. **Flip-flopping verdicts.** The server only moves statuses forward and never changes a verdict, and the client treats terminal statuses as immutable. A sandbox outage arrives as `pending` with "judge temporarily unavailable, retrying" and, at worst, a final `system_error` styled as "our fault, please resubmit" — never as Wrong Answer.

| Approach | Verdict |
|----------|---------|
| ✅ Pessimistic submit + key + backoff polling | Honest, cheap for the server, and safe to retry |
| ❌ Optimistic "Accepted" | There is nothing to be optimistic about until the judge runs |
| ❌ WebSocket per tab | Connection management for a result that arrives in seconds; I'd add Server-Sent Events only for contest banners |

**Accessibility of the workspace.** CodeMirror captures Tab for indentation, which is a keyboard trap unless there's a documented exit: Escape, then Tab, moves focus out, and I announce that in the editor's accessible description. Run and Submit have keyboard shortcuts shown in their tooltips. The verdict panel is one `role="status"` region so updates are announced politely, and verdict colors always come with text.

### Deep dive 3: a 3,000-row problem list that stays responsive (3 min)

- **Load the index once.** 3,000 rows × ~100 bytes is ~300 KB of JSON, ~40 KB gzipped. I fetch it in pages of 500 and filter and sort in memory, so typing in the search box never waits on the network. Server-side search would be the answer at 300,000 rows; at 3,000 it would just add latency to every keystroke.
- **Virtualize, but keep table semantics.** Only the ~20 visible rows plus overscan render; two spacer rows pad the rest. Because rows that aren't rendered don't exist for assistive technology, the table carries `aria-rowcount` and each row its `aria-rowindex`.
- **Filters in the URL.** `/problems?difficulty=medium&q=tree` survives refresh and can be shared, and the back button restores the view.
- **Prefetch on intent.** Hovering a row prefetches the problem query and the editor chunk, so the workspace usually opens from cache.

### Deep dive 4: security checklist (2 min)

- **Statements are markdown from trusted setters, rendered without raw HTML**, so a statement can't inject script; examples render as text in `<pre>`. A strict Content-Security-Policy (`script-src 'self'`) backs that up.
- **Code is never executed in the browser.** Run goes to the judge, so a malicious "solution" shared in a link can't run in someone else's session.
- **CSRF**: session cookie with `SameSite=Lax`, JSON-only mutations, and CORS restricted to the app's origin.

---

## 🧯 Loading, Error and Empty States (2 min)

| Situation | What the coder sees | How |
|-----------|---------------------|-----|
| Problem page first load | Statement from the CDN immediately; an editor-sized skeleton until the chunk loads | Fixed-size placeholder, so CLS stays near zero |
| Submit in flight | "Submitting…" on the button; Run still available | Button disabled, key held in `sessionStorage` |
| Waiting for a judge | "Waiting for a judge…" then "Running test 3 of 10" | Status query with backoff; polite live region |
| Judge outage | "Judge temporarily unavailable — retrying (attempt 1 of 3)" | Server keeps the job; client keeps polling |
| Rate limited | "Try again in 42 s" countdown on Submit | `429` with `Retry-After` |
| Session expired mid-solve | Login dialog over the workspace; draft untouched | Drafts are local; the query cache refetches after login |
| Offline | Banner; editing and drafts keep working; Submit waits | Mutations pause until the browser is back online |
| No submissions yet | "No submissions yet — press Ctrl+Enter to submit" | The empty state teaches the shortcut |
| No problems match the filter | "No problems match 'trie' in Hard" plus a clear-filters button | An empty table with headers looks broken |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | Static statement + client-rendered workspace | Pure SPA; full SSR | Search traffic gets HTML; the editor needs the client anyway |
| Editor | CodeMirror 6, lazy chunk | Monaco | A fraction of the size; works on touch |
| Server state | Query cache with data-driven refetch | Copying responses into a global store | Polling, dedupe and invalidation for free |
| Drafts | Persisted store, debounced, per language | Save on every keystroke; server autosave | No INP cost; survives refresh |
| Submit | Pessimistic + idempotency key + retry | Optimistic; disabled button only | Truthful and duplicate-free |
| Verdict delivery | Backoff polling, aria-live | WebSocket | Seconds-long jobs; no connection state |
| Problem list | Whole index, virtualized `<table>` | Server search per keystroke | 3,000 rows filter instantly in memory |

"With more time I'd add Server-Sent Events for contest verdicts, a diff view against the previous submission, and per-route real-user Web Vitals so the editor chunk's cost is measured, not guessed."
