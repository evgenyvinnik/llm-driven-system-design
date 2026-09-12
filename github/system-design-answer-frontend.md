# GitHub — frontend system design interview

This is a 45-minute design conversation for a code-hosting frontend. I would draw one
small system diagram and spend most of the interview on three decisions: stable code
navigation, large diff rendering, and preserving review intent through changes and
retries. The proposal extends the local teaching application; it does not describe all of
its current behavior.

## 🎯 Scope and requirements — 3 minutes

> “I want a developer to find a file, understand a proposed change, and leave a review on exactly the code they saw. Those three actions will shape the frontend.”

I would clarify whether the interviewer wants a browser editor or a code review product. I
will assume browsing and review. Editing code happens through Git elsewhere. Running CI,
editing files collaboratively, organization administration, and a complete notification
center are outside this first version.

The main screens are a repository browser, a pull request comparison with comments, and
code search. Public and private repositories use the same navigation model, but every
response must respect the current viewer's access. The client can hide controls for
convenience; the server still makes the permission decision.

The difficult scale is not just millions of users. A single repository can contain 100,000
files, and a single pull request can change hundreds of files. A small number of
pathological files with extremely long lines can be more expensive to highlight than many
ordinary files.

| Requirement | What I would measure or guarantee |
|-------------|----------------------------------|
| Useful navigation | First useful bounded file content within one second at p95 on an agreed network/device |
| Review correctness | Each comment and approval identifies its original comparison |
| Responsiveness | Scrolling and typing remain usable while code loads or tokenizes |
| Accessibility | Keyboard access, source-line labels, focus preservation, and a readable fallback |
| Recovery | Drafts survive a failed request; an uncertain merge stays pending until verified |

These latency figures are targets to test, not claims about the demo. I would not promise
to display a multi-gigabyte file interactively or make a clone finish within a fixed
metadata-response budget.

## 🏗️ Architecture and state boundaries — 5 minutes

I would draw this and label the identities crossing the arrows:

```
┌─────────────────────────────┐     ┌──────────────────────────────────────┐
│ Router + review UI          │────▶│ Authorized repository API            │
│ URL / drafts / focus        │     │ Commits / comparisons / receipts     │
└─────────────────────────────┘     └──────────────────────────────────────┘
               │                                       │
               ▼                                       ▼
┌─────────────────────────────┐     ┌──────────────────────────────────────┐
│ Query cache + workers       │────▶│ Git storage + SQL                    │
│ Bounded text / diff rows    │     │ Current policy / durable writes      │
└─────────────────────────────┘     └──────────────────────────────────────┘
```

The router owns shareable context: repository, requested branch or commit, directory/file
path, pull request number, comparison revision, and search filters. Back and forward
should restore that context rather than depend on whatever happened to remain in a
component.

The query cache owns server data. A file's key includes repository identity, immutable
commit, path, and representation version. A diff's key includes the comparison inputs and
display options that change the result. A private repository's cache also sits inside an
account/access context and is discarded when that context changes.

Local UI state owns expanded folders, active panels, scroll anchors, and unsent drafts. I
might use Zustand for cross-component UI state and a query library for fetching and
retries. The important boundary is who owns each fact; a particular state library does not
create correct cache keys or safe retries automatically.

I would load the repository shell and permissions first. Once the requested ref resolves
to a commit, independent directory and file requests can run concurrently. The shell can
stay visible while a content panel loads. Authentication refresh should not unnecessarily
unmount the review composer and discard text.

| Data | Identity | Lifetime |
|------|----------|----------|
| Branch lookup | Repository + branch + access context | Short-lived; explicitly refreshed |
| File bytes | Repository + commit + path | Reusable while permitted and retained |
| Diff | Base/head/merge-base commits + options | Stable comparison artifact |
| PR metadata | Repository + number + server revision | Revalidated after mutations/events |
| Review draft | Account + PR + comparison + local draft ID | Until submitted or deliberately discarded |

I would keep response validation at the client boundary for values the UI depends on, such
as encoding, source coordinates, and result status. TypeScript types alone cannot verify a
server response. A small explicit contract is more valuable here than sharing every
database field with the browser.

## 🔧 Deep Dive 1: Browse a stable revision with bounded work — 9 minutes

### The branch is a starting point

> “When I click a file in a directory listing, I expect the file to belong to the version of the directory I was looking at.”

Suppose the directory request reads `main` at commit A. Before the file request arrives,
another developer pushes commit B, renaming the file. If both requests independently
resolve the moving branch, the user can see a broken link or different code despite taking
one coherent navigation action.

I would resolve `main` once and carry commit A through the browsing session. The address
bar can still explain that the user started from `main`, while a permalink includes A. A
fresh-commit indicator offers an intentional refresh to B. It should not replace the
current file while the developer is reading or selecting text.

This also changes caching. The bytes at commit A and a given path can be reused because
that content identity is stable. The meaning of `main` is not stable. Giving both cache
entries the same long lifetime would make the UI fast while showing inconsistent code.

The server checks repository access before serving even a cached immutable file. The
browser clears private data on logout or account change, aborts old requests, and ignores
responses carrying the previous account generation. Evicting a cache cannot erase code
somebody already downloaded, but it prevents accidental display in the next session.

### Load the tree people actually explore

I would fetch immediate directory children on expansion rather than download the full
recursive tree. This reduces initial transfer for a repository where most users open only
a few folders. Directory results are cached at the resolved commit, so collapsing and
reopening does not require a new request.

A wide directory still needs a bound. The API can page a stable directory order with a
cursor tied to the commit and directory identity. A directory tree is not automatically
cheap merely because it is lazy; one level can itself contain tens of thousands of files.

For an expandable sidebar, I would flatten only loaded, expanded nodes into visible rows
and virtualize that list. Stable row keys use repository, commit, and path. A flattened
array index is not a durable identity when an earlier folder expands and shifts everything
below it.

If the product only needs directory-at-a-time browsing, an ordinary paginated list of
links is simpler and often more accessible. I would add the full tree widget when users
need rapid navigation across multiple open folders. That avoids paying a complex
focus-management cost for a product requirement we do not have.

| Choice | Benefit | Cost |
|--------|---------|------|
| ✅ Commit-pinned, lazy directory browsing | Coherent navigation and bounded initial work | Explicit refresh and old-revision retention |
| ❌ Resolve the branch on every request | Always asks for the newest tip | Related panels can describe different versions |
| ❌ Fetch the entire recursive tree upfront | Simple local traversal afterward | High initial bytes, parsing, and memory for rarely visited paths |

### File rendering has several separate budgets

A file response should identify encoding, byte size, and whether content is truncated or
unsupported. Binary files get a suitable preview or download action. A huge text file can
have a bounded preview without pretending that the complete file was loaded.

I would show escaped plain text first, then tokenize eligible files in a worker. The
worker receives an immutable file key and job generation; its late result is discarded if
the user has moved to another file. Moving computation off the main thread helps
responsiveness but does not remove the need for size and time limits.

Language grammars can load when needed, with a shared in-flight request per grammar.
Unsupported or expensive highlighting falls back to readable text. For multiline syntax,
tokenization needs surrounding lexical state; independently highlighting each visible line
can miscolor a string or comment that began above the viewport.

Virtualization then bounds mounted rows. It does not stop the browser from holding a giant
string or the worker from parsing it. I would also bound response bytes, worker jobs,
cached content, and the longest individual line. These controls address different parts of
the cost.

I would test navigation while two file responses finish in reverse order. The UI must
retain the latest requested file and its commit. Cancellation saves resources when
supported; a request-generation check supplies correctness even when cancellation arrives
too late.

## 🔧 Deep Dive 2: Render a large diff without losing its meaning — 10 minutes

### Comparison identity comes before layout

A pull request is a mutable conversation around a changing branch. Its number is not
sufficient to identify the code being compared. The server should return an explicit
comparison ID containing or referring to the base, head, merge base, and diff settings.

If the head moves while a reviewer is reading, I would keep the old comparison on screen
and show that a newer revision exists. The reviewer can finish a historical comment or
choose to refresh. An approval of the old head must not appear as approval of the new one.

The initial request returns a file summary: paths, change types, additions/deletions,
binary status, and whether detailed content is available. Detailed hunks load as files are
opened. A thousand-file pull request should not require downloading and tokenizing a
thousand complete patches before the first file appears.

I would default to a unified view, especially on small screens, and add split view for
reviewers who need it. The same semantic diff model drives both. Changing the layout must
not change the stored comment location.

### A source line is different from a rendered row

A hunk can contain headers, removed lines, added lines, context, and comment panels. Row
50 in that rendered list may correspond to old line 120, new line 127, or no source line
at all. Using the visual row index would attach a review to the wrong code after layout
changes.

| Anchor field | Why it is needed |
|--------------|------------------|
| Comparison identity | Identifies the exact code pair |
| Old/new path | Handles renames and deletions |
| Side and source range | Distinguishes removed code from added code |
| Original context | Helps display or cautiously map an outdated comment |
| Comment/draft identity | Survives virtual row movement and retries |

The server validates that a submitted range exists on the named side of the comparison. It
rejects malformed anchors rather than storing a coordinate that happens to be within the
rendered patch length. A deleted file can still have comments on its old side.

When a new comparison arrives, I would preserve the original anchor and mark unresolved
mappings as outdated. A contextual match can suggest a new location, but ambiguous
repeated lines should not silently move a comment. It is better to show the original code
than to misrepresent what a reviewer meant.

### Progressive rendering and focus

For a moderate diff, collapse unchanged context and render an opened file normally. For
very large opened files, virtualize hunks or line groups with measured heights. Comment
panels and wrapped lines make fixed row-height assumptions unreliable.

A scroll anchor should identify a comparison, file, source line, and offset within the
visible row. If a comment thread expands above the viewport, restore that anchor after
measurement. Raw scrollTop alone cannot preserve the reader's place when content heights
change.

The active editor and its draft must live outside the disposable virtual row. I can pin
the active row while typing or render the editor in a stable panel associated with its
anchor. Unmounting an offscreen row must not destroy an unsent review comment.

Keyboard navigation needs equally deliberate handling. Before moving focus to an offscreen
line, scroll it into view, wait for it to mount, then focus the control. Do not set an
active descendant to an element that does not exist in the DOM. Provide explicit old/new
source-line labels rather than relying only on red and green.

Virtualization has real costs. Browser find and native text selection may cover only
mounted rows. I would provide file-level search, copy/download of the permitted complete
artifact, and a paginated nonvirtual reading mode. Accessibility is a product behavior to
test, not a property obtained by choosing a virtualization library.

| Approach | Why I would choose or reject it |
|----------|---------------------------------|
| ✅ File summaries, lazy hunks, measured virtualization where needed | Reduces bytes and DOM work while preserving semantic anchors |
| ❌ One giant HTML patch | Simple initially, but large parsing/layout tasks block reading and commenting |
| ❌ Full editor framework by default | Useful for editing, but adds weight and may make inline review placement harder |

A custom review renderer gives control over comment placement, but we must implement
correct coordinates, focus, selection, and fallback behavior. If the product later needs
editing, an editor framework may become worth its cost. I would benchmark the actual
interaction before treating either choice as universally faster.

## 🔧 Deep Dive 3: Preserve review intent through writes and retries — 9 minutes

### Draft, submitting, and accepted are different states

> “A comment can feel immediate without pretending the server has already accepted it. A merge needs an even more careful status.”

A draft stores text, anchor, account, comparison, and its own local revision. It can be
displayed immediately next to the code with an unsent indicator. Submitted reviews can
include a bounded batch of comments and an overall decision.

The request carries one stable client operation key and a digestible payload. The server
transaction claims that scoped key and stores the review, comments, and receipt together.
If the response is lost, the client retries the same request key and payload. A fresh key
means a new user action, not another attempt at the same submission.

I would snapshot the draft revision being submitted. If the user types more text while the
request is in flight, success clears only the submitted revision. It must not erase the
new text. Similarly, a late failed response must not roll back a newer accepted comment or
a different account's state.

| State | What the reviewer sees | Allowed recovery |
|-------|------------------------|------------------|
| Draft | Editable text with its comparison | Edit or discard deliberately |
| Submitting | Pending marker and preserved text | Avoid duplicate action; query/retry same operation |
| Accepted | Server comment/review identity | Reconcile by operation ID |
| Rejected | Reason and intact draft | Fix or refresh the comparison before a new submission |
| Outcome unknown | Submission status unavailable | Recover the existing operation before duplicating it |

An event and an HTTP response may arrive in either order. The cache should merge them by
server identity or client operation key, not append both. A monotonically increasing
resource revision prevents an older response from replacing newer metadata.

### Merge is not an optimistic color change

For a star, a desired-state request can optimistically update a small reversible UI state.
A merge publishes shared code. I would immediately show a pending button state but keep
the PR's authoritative state unchanged until the server confirms the operation.

The merge request names the reviewed head, expected base, PR version, strategy, and
operation key. The server rechecks current permission and policy when accepting it. If
either branch has moved, it returns a conflict that explains why a refreshed comparison is
required.

The backend may accept a durable operation and return a pending identifier. The UI polls
that operation with bounded backoff or receives an update and refetches it. A transport
timeout is not proof that Git did nothing. Showing “merge failed, try again” without
recovery can invite a duplicate or inconsistent action.

I would show three distinct terminal outcomes: published, rejected/conflicted, and a
still-unresolved operation requiring recovery. If code was published but metadata
reconciliation is delayed, the interface remains pending with an explanation. It does not
let the client invent a merged state from its own expectations.

The cost is more state handling and occasionally a visible wait. The benefit is that the
user can trust the green or purple status they see. For this workflow, correctness of the
reported outcome matters more than saving one network round trip through optimistic
presentation.

### Keeping a page current

Initially I would revalidate on successful mutation, focus, and a modest polling interval
while the PR is open. If update latency becomes a requirement, server-sent events can
carry resource revision notifications. Reviews and comments still use HTTP writes; this
does not require a bidirectional typing channel.

An event is a hint to fetch authoritative state, not a command to replace unsent drafts.
On reconnect, revalidate the active PR even if events were missed. If the system offers
resumable event IDs, it must also define the retained replay window and a reset path after
that window expires.

| Choice | Benefit | Cost |
|--------|---------|------|
| ✅ Explicit pending mutations and durable operation recovery | Preserves intent across lost responses | More UI states and receipt handling |
| ❌ Optimistically mark a merge complete | Appears instant | Can claim shared code changed when it did not |
| ❌ Refetch everything and replace all local state | Simple server-state refresh | Can destroy drafts, focus, and reading position |

## 🔎 Search and navigation contracts — 4 minutes

I would encode the submitted query, category, language, repository scope, and cursor in
the URL. The typed input can be a separate draft until submission or a short debounce.
Updating a filter resets pagination and starts a new request generation.

A late response for query A must not overwrite query B. The key includes the complete
normalized query and access context. During a refetch, the interface labels retained
results as belonging to the previous query or clears them; it must not display them
beneath the new heading as if they matched.

Search results identify their indexed commit and link to that revision. Indexing may lag a
push, so an old result should still open the code it describes. The server applies current
permission checks before returning snippets, and a result can disappear if access is
revoked.

I would accept snippet text plus match ranges and render escaped text with highlighted
segments. Raw code can contain HTML-like text; treating a search-engine fragment as
trusted HTML is unsafe. The same boundary applies to filenames and Markdown content.

The results page distinguishes loading, empty, failed, and partially available states. A
search outage should not appear as “no code found.” Pagination is bounded, and any result
count should state whether it is exact or approximate within the permitted search scope.

A limited cache of recent permitted results improves back navigation. I would bound cached
pages and content bytes rather than accumulating every search forever. Private offline
caches are an explicit product and retention decision, not a default consequence of adding
localStorage.

## 🧪 Accessibility, failures, and validation — 3 minutes

I would test keyboard browsing, directory expansion, source-line navigation, comment
submission, and returning focus after closing a panel. Focused controls must remain
mounted or have an intentional replacement. A modal needs actual focus containment and
restoration; a visual overlay alone is insufficient.

The useful performance fixture is a large diff with long lines and several expanded
comment threads on a slower device. Measure transfer, parsing, worker time, mounted rows,
long tasks, and input delay separately. A low DOM count cannot prove the page is
responsive if highlighting still blocks the main thread.

Correctness tests would reverse response order, switch accounts during a fetch, move the
PR head while a review is open, lose a successful submission response, and deliver the
same event twice. I would verify the displayed commit, preserved draft text, and final
operation identity, not just that the page has a heading.

The local project illustrates why those checks matter. Its generated nested routes need
missing outlets, its code viewer highlights only the first line, and its diff numbers
patch rows. Those source limitations do not invalidate the proposed design; they identify
the next concrete work needed to implement it.

## ⚖️ Trade-offs and closing — 2 minutes

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Browsing context | ✅ Resolve a commit and refresh explicitly | ❌ Re-resolve moving branches per panel | Keep related views coherent |
| Large diffs | ✅ Bound bytes, load progressively, virtualize selectively | ❌ Render an entire patch at once | Control each source of UI cost |
| Review state | ✅ Comparison-bound drafts and receipts | ❌ Comments tied only to current line positions | Preserve what the reviewer meant |
| Merge feedback | ✅ Pending until a recoverable server result | ❌ Optimistic completed merge | Report shared history accurately |

> “The design is built around stable identities: a commit for browsing, a comparison for a review, and an operation for a write. Once those identities are clear, caching, rendering, and recovery can improve the experience without changing its meaning.”

If there were more time, I would explore one concrete large-diff interaction or force-push
recovery trace. I would leave editor internals and notification feature catalogs for a
separate discussion. The full implementation mapping belongs in
[architecture.md](./architecture.md), with setup and current limitations in
[README.md](./README.md).
