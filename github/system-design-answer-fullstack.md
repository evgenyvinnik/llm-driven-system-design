# GitHub — fullstack system design interview

This is a 45-minute conversation about a code-hosting and review product. I would follow
one developer journey from browsing code to reviewing and merging it, with three deep
dives on revision identity, review state, and recoverable publication. This is a proposed
design, with a short comparison to the local implementation at the end.

## 🎯 Define the user journey — 3 minutes

> “A developer opens a repository, reads a proposed change, leaves a review, and merges it. I want the browser and backend to agree about which code each step refers to.”

I would clarify whether this is primarily a code editor, Git hosting service, or review
product. I will focus on hosting and review. Git transport supplies code changes; the
browser provides file navigation, pull request comparisons, comments, and search.

Personal and organization repositories can be public or private. Reading a file, a
discussion, or a search snippet requires the same underlying permission decision. Creating
an issue is a different capability from publishing a branch update, so authentication
alone is not sufficient authorization.

I would start with same-repository pull requests and merge commits. Browser editing, CI
execution, fork workflows, multiple merge strategies, and a rich notification center can
follow. Those are meaningful extensions, but including all of them would crowd out the
consistency decisions this interview needs.

| Goal | User-visible contract |
|------|-----------------------|
| Coherent browsing | Directory, file, and permalink identify the same commit |
| Reliable review | Comment anchors and approvals identify the code actually reviewed |
| Responsive UI | Large files/diffs do not freeze typing or navigation |
| Correct merge | Pending until the server can prove publication or conflict |
| Private data | Current access checked before any code or snippet is returned |

For capacity, assume 200M repositories and 100M browser/API reads per day, about 1,157
reads/s on average before peak allowance. The interactive challenge also includes
individual very large repositories. I would target p95 small metadata reads below 200 ms
and first useful bounded file content within a second on a specified network/device. These
are testable targets, not measured demo performance.

## 🏗️ A small architecture and explicit contracts — 5 minutes

```
┌─────────────────────────────┐     ┌──────────────────────────────────────┐
│ Browser / Git transport     │────▶│ Git storage authority                │
│ Auth + repository routing   │     │ Objects / refs / operation journal   │
└─────────────────────────────┘     └──────────────────────────────────────┘
               │                                       │
               ▼                                       ▼
┌─────────────────────────────┐     ┌──────────────────────────────────────┐
│ Collaboration API + SQL     │────▶│ Event processing                     │
│ PRs / intents / receipts    │     │ Reconcile / index / notify           │
└─────────────────────────────┘     └──────────────────────────────────────┘
```

The browser has a router, a query cache, a review/draft model, and bounded code/diff
rendering. The API supplies authorized metadata and comparison contracts. Git storage owns
code objects and ref publication, while PostgreSQL owns users, permissions, issues,
reviews, and operation intents.

A Git storage service fronts a repository's writer and its durable operation history. The
collaboration API does not write arbitrary ref files directly. Search consumes durable
changes and remains a derived view. Redis and CDN caches can accelerate permitted reads,
but neither decides who can read a repository.

I would make three identities explicit in the API: a commit for browsing, a comparison for
review, and an operation for a mutation. They answer different questions. The branch name
says where the user started; the PR number says which conversation they opened; neither
alone identifies immutable code.

| Contract | Backend responsibility | Frontend responsibility |
|----------|------------------------|-------------------------|
| File view | Resolve commit; return bounded typed content | Keep revision visible; ignore stale responses |
| Comparison | Identify base/head/merge base and diff options | Preserve that comparison while reviewing |
| Review submission | Validate anchors; atomically record receipt and comments | Preserve draft and reuse the operation key on retry |
| Merge operation | Check expected inputs; durably recover publication | Show pending/conflict/success accurately |
| Search result | Check access; return indexed commit and safe text | Open that revision and render escaped highlights |

The router owns URLs and back/forward history. The query cache owns server responses.
Local state owns expanded folders, panel selection, draft text, and scroll/focus anchors.
A shared state library can coordinate them, but the boundaries are more important than
choosing a particular library.

I would validate critical fields at API boundaries: supported encodings, bounded page
sizes, revision IDs, source-line ranges, and mutation result states. Shared schemas can
reduce drift, but backend authorization and state-machine checks remain server
responsibilities. Reusing a TypeScript interface cannot establish those invariants.

## 🔧 Deep Dive 1: Make a file click mean one revision — 9 minutes

### Follow the request across the stack

A developer opens `main` and clicks a file from its directory listing. Between those
requests, somebody pushes a commit that renames the file. If each request resolves `main`
independently, the browser can show a directory from one revision and a missing or changed
file from another.

I would have the API resolve the branch once and return the commit identity with the
directory. The browser uses that commit for related requests and links. It can offer a
fresh-commits indicator, but the current reading view remains stable until the user
chooses to refresh.

The directory endpoint returns immediate children at that commit. Expansion or navigation
requests only the next directory. A wide directory is paginated with a cursor bound to its
commit and directory identity, so lazy loading does not hide an unbounded single-directory
response.

The file endpoint returns content identity, encoding, byte size, and whether the result is
complete, truncated, binary, or unsupported. These states have different UI presentations.
An error must not be disguised as a successful empty file or empty repository.

### Cache immutable artifacts separately from moving names

The backend can cache file bytes by repository, commit/object ID, path, and representation
version. The frontend uses the same semantic identity. A short-lived branch lookup maps
`main` to a commit; it is not the same cache entry as immutable bytes.

Suppose the server caches `main/a.ts` for an hour but invalidates directory listings after
a push. The user can see the new tree alongside old file content. A long TTL is reasonable
only when the key identifies content that truly cannot change, subject to current access
and retention.

For private repositories, every cache hit still passes the current authorization gate. The
browser scopes cached data to the account/access context and clears it on logout or a
confirmed revocation. Late responses from the previous account are discarded using an
account generation, even if the network request could not be cancelled in time.

| Approach | Why it works or fails |
|----------|-----------------------|
| ✅ Commit-bound requests and cache keys | Related views retain one meaning across pushes |
| ❌ Branch-only keys with long TTLs | Different panels can show different generations of code |
| ❌ Revalidate every byte on every click | Avoids some staleness but wastes reusable immutable artifacts |

This choice costs storage for retained old versions and requires an explicit refresh
experience. It benefits reviewers because a permalink and a comment can continue to
explain what they saw. Garbage collection must respect that retention contract rather than
deleting referenced history immediately after a force push.

### Bound work on both sides

The backend should inspect object size/type before materializing huge content or computing
an expensive diff. Git workers have byte, time, and concurrency budgets, with large jobs
isolated from interactive reads. Adding a timeout to an HTTP response does not
automatically stop a subprocess already consuming CPU.

The browser initially renders escaped text and schedules bounded syntax highlighting in a
worker. Grammar loading can be lazy. The tokenization job carries a file identity and
request generation, so a late result from another file cannot replace the active view.

For multiline syntax, tokenize with enough preceding lexical context rather than treating
every displayed line as independent source. Large files need explicit fallbacks. A worker
moves work away from input handling, but a huge allocation or unbounded queue can still
exhaust browser memory.

The directory sidebar and large code panels can virtualize visible rows. This reduces DOM
work, not network transfer or total parsing cost. I would separately cap cached bytes,
outstanding fetches, highlighting jobs, and mounted rows.

A simple directory-at-a-time list may be sufficient for the first version. A full
expandable tree adds keyboard semantics and focus coordination. I would choose it when
users need multiple folders open at once, not because every code host must begin with the
most complex navigation widget.

### Preserve navigation and accessibility

URLs encode the repository, revision, and path without ambiguously splitting a branch name
that itself contains slashes. A backend can accept a ref as a separate validated parameter
and return a resolved commit; the browser then builds stable links from the resolved
identity.

Back navigation restores a source-line or path anchor and its offset, not only a raw
scrollTop. If a directory expands above the viewport, stable row identity keeps the
developer's place. Focus moves after the target virtual row mounts, with ordinary links
available as a fallback.

I would test a branch change during navigation, a deleted file, a path with unusual
characters, an unsupported binary, and two file responses arriving out of order. Those
cases verify the contract between routing, API identity, cache keys, and rendered content.

## 🔧 Deep Dive 2: Keep a review attached to the code and the draft — 10 minutes

### A comparison is an immutable reading surface

> “The PR is a changing conversation, but the comparison on the screen should be stable while I review it.”

The PR endpoint returns mutable metadata and a comparison identity. The comparison refers
to base, head, merge base, and diff options. A separate bounded manifest lists changed
files and statistics; detailed hunks load when needed.

If the head changes, the browser shows a new-revision indicator and keeps the existing
comparison. An event should not replace the diff beneath an active selection or erase a
comment draft. Refreshing is an explicit transition that preserves or marks old drafts
appropriately.

The backend records approvals against the exact reviewed head. An approval of A remains
historical after the branch moves to B. Whether unchanged-path reviews can carry forward
is a separate policy; I would initially require approval of the admitted head for a merge.

### Comment coordinates cross the API boundary

A diff renderer contains headers, old lines, new lines, context, and comment panels. Its
row number is not a source-line coordinate. A comment needs a comparison, old/new path,
side, and source range.

| Example | Correct anchor behavior |
|---------|-------------------------|
| Comment on an added line | New-side path and source line at the comparison head |
| Comment on removed code | Old-side path and source line at the comparison base/merge-base view |
| Renamed file | Preserve old and new path identities |
| Force push changes the line | Retain original anchor; show outdated if mapping is uncertain |
| Display switches unified/split | Anchor stays the same despite different row layout |

The API validates that the range exists in that comparison and belongs to the PR. A local
coordinate inside a rendered table is not enough. It also checks that the caller currently
has permission to comment; a valid historical URL does not preserve access after
revocation.

Mapping old comments to a new revision is best-effort display behavior. The original
anchor remains authoritative. Repeated code and renames can make mappings ambiguous, so
the UI should show the original snippet rather than silently attach a comment to the wrong
occurrence.

### Rendering a review remains bounded

I would load a changed-file summary first and request detailed hunks progressively.
Moderate files can render normally; large opened files can use measured virtual rows or
hunk groups. A whole editor framework is not required for a read-only review surface.

Comment panels and wrapped lines introduce variable heights. The scroll anchor uses a
comparison/file/source line and offset, while stable row keys distinguish headers, source
lines, and comment threads. When a thread expands above the viewport, measurement restores
the anchor instead of making the page jump.

The composer and draft model must survive virtual row unmounts. I can pin the active row
or place the composer in a stable adjacent panel. Either approach needs focus coordination
and explicit old/new line labels. Color alone cannot explain whether code was added or
removed.

Virtualization limits native browser find and selection to mounted content. A bounded
paginated reading mode, file search, and permitted copy/download actions are deliberate
alternatives. I would test assistive technology on the actual interaction rather than
assume a library makes it accessible.

### Submission preserves intent

A draft has an account, PR, comparison, anchor, text, and local revision. Submission
snapshots that revision and sends a stable client operation key. The backend atomically
claims the key in the actor/repository/review scope and stores the review, comments,
receipt, and outbox event.

If the same key arrives concurrently, only one caller performs the mutation. A matching
retry returns the original result. The same key with a different payload is a conflict.
Inserting a duplicate key after performing both mutations and ignoring the conflict would
not provide this guarantee.

The browser shows the submitted draft as pending, then reconciles it with the server
comment IDs. If an event arrives before the HTTP response, both are matched by the
operation/server identity so the comment appears once. An older resource revision cannot
overwrite newer accepted state.

If the user types more during submission, success clears only the submitted draft
revision. New text remains. A failed request leaves the original draft intact, with a
choice to retry the same operation or deliberately edit and submit a new one once the
previous outcome is resolved.

| Decision | Benefit | Cost |
|----------|---------|------|
| ✅ Comparison-bound anchors and independent drafts | Preserves review meaning through refresh and virtualization | More explicit data and lifecycle handling |
| ❌ Store current line number and component text only | Easy initial implementation | Comments drift and drafts disappear during remounts |
| ❌ Replace all local state after each refetch | Simplifies cache replacement | Can erase new text or move focus while typing |

I would begin with refetching after mutations and on focus. A server event stream can
later signal changed PR revisions. Events trigger reconciliation; they do not own the
draft. After a disconnect, the active PR is revalidated even if the client cannot replay
every missed event.

## 🔧 Deep Dive 3: Report a merge outcome the system can prove — 8 minutes

### Acceptance is not completion

A merge changes shared history, so I would not optimistically mark the PR merged. The
browser immediately shows a pending action and disables accidental duplicate submission,
while the authoritative PR remains open or explicitly merging until the server confirms
the result.

The request includes the expected head, base, PR version, strategy, and operation key. The
server checks current maintain permission and required policy at acceptance, stores a
durable merge intent, and reserves the PR against incompatible changes. An accepted
operation may complete even if access is later revoked; that acceptance boundary must be
clear.

A worker computes a candidate from the admitted immutable inputs. It makes the candidate
objects durable, then asks the storage authority to conditionally publish the base only if
head and base still match. Two merges can compute concurrently, but only one can publish
against the same expected base.

If a branch moved, the server reports a conflict for this attempt. The browser refreshes
the comparison and asks the user to initiate a new attempt with the new inputs. It does
not silently reuse an old approval against a recomputed candidate.

### The failure nobody sees in the happy path

Consider storage publishing the merge, followed by PostgreSQL becoming unavailable before
the PR row is updated. Code has changed, but metadata still says pending. A SQL rollback
cannot undo the external ref update, and a client timeout cannot tell us which side of
publication the failure occurred on.

The storage service therefore records the operation result with its authoritative
publication command. The SQL intent references that operation ID. A reconciler asks for
the recorded result and completes the SQL state and outbox event without recomputing the
merge.

Looking only at the branch's current tip is insufficient because another push may already
have advanced it. A durable receipt identifies the historical operation even after later
changes. That receipt is part of the storage protocol, not a claim that calling Git and
writing a SQL row are one transaction.

| State | Backend evidence | Browser behavior |
|-------|------------------|------------------|
| Accepted | Durable intent | Show pending operation |
| Computing | Candidate work underway | Keep pending; allow status refresh |
| Conflict/rejected | Recorded failed precondition | Show reason and preserve the comparison |
| Published, reconciling | Durable storage receipt | Keep an explicit pending/reconciling status |
| Complete | SQL result agrees with publication | Show merged commit and refreshed PR metadata |

A lost response is recovered with the same operation identifier. The UI can poll with
bounded backoff or receive a revision notification and fetch the result. It should not
manufacture a new operation key because a request took longer than expected.

### Cost and scope of this design

This requires a storage service with one fenced repository writer and a durable
command/result history. Objects and the publication record must satisfy the acknowledged
durability policy. A failover writer recovers that history before accepting changes, and
stale writers cannot bypass the fence through direct filesystem access.

The additional cost is a pending state, recovery processing, retained candidates/receipts,
and monitoring for operations that do not reconcile. Keeping a database transaction open
through a full clone would add lock time without making Git publication transactional with
SQL.

For ordinary comments, the simpler SQL mutation-plus-receipt transaction is enough. For
stars, a desired-state membership request can be optimistic and reconciled with a server
result. The frontend should choose feedback based on the effect being performed, rather
than applying optimistic completion to every mutation.

| Approach | Trade-off |
|----------|-----------|
| ✅ Pending merge with durable recovery | More states, but a trustworthy outcome after crashes |
| ❌ Optimistic completed merge | Faster-looking feedback that can misreport shared history |
| ❌ Blind retry of Git work after timeout | Simple retry code that may publish a different result |

A practical first implementation can use one storage node and explicitly document its
availability limits. The core interface should still expose expected revisions and
operation recovery. Scaling replicas later is much easier when the product already
distinguishes pending acceptance from confirmed publication.

## 🔎 Search connects another revision boundary — 4 minutes

Search indexing consumes durable ref events containing immutable before/after commits and
repository sequence/generation. Workers index bounded eligible text, remove deleted paths,
and reject late writes that would replace newer content or resurrect deleted repositories.

The query API returns indexed commit identities. The frontend uses those identities in
links, so a result opens the code that actually matched. Index lag is acceptable within a
target such as p95 below 60 seconds under admitted load, but the UI should not imply every
result represents the current branch tip.

Permission is checked at retrieval even if the search index has an access filter. A
repository may have become private since indexing. Paths, snippets, result counts, and any
operation links must not reveal data outside the current permitted scope.

Search snippets are escaped text with match ranges. The browser renders highlighted
segments without interpreting source code as HTML. This is especially important when the
same code can contain markup-like strings and the search engine returns formatted
fragments.

The submitted query and filters live in the URL, with a separate local input draft if
needed. Changing filters resets the cursor and advances a request generation. Late results
for the previous query are ignored, and failures are shown distinctly from an empty
successful search.

A bounded search context can preserve ranking across pages, while current authorization
still runs on every request. If that context expires, the user restarts the search. The
system should not claim an exact frozen result set indefinitely or treat its snapshot as a
permission grant.

For the first version, refresh-on-focus and mutation acknowledgements may be enough to
keep the UI useful. If events are added, they carry resource revisions and trigger
targeted revalidation. A full bidirectional notification system is unnecessary for a
product whose writes already use HTTP.

## 🧪 What I would verify and what the demo implements — 4 minutes

I would verify the system with traces that cross browser and server boundaries, because a
unit test of each helper can miss a broken interaction. The most important assertion is
often which revision or operation the UI displays after a race.

| Scenario | Expected result |
|----------|-----------------|
| Branch moves between tree and file requests | The file still opens at the directory's resolved commit |
| File requests finish in reverse order | The latest requested file remains visible |
| Head moves while a review is drafted | Draft retains its original anchor and is marked against that revision |
| Review response is lost or event arrives first | One accepted review, reconciled by identity |
| User types during comment submission | Only submitted text clears; newer text survives |
| Worker dies after ref publication | Same storage receipt completes the pending SQL result |
| Visibility changes during index lag | Current authorization prevents private snippets from returning |

For performance, use a large directory, a large diff with variable-height comments, and a
long-line file on a slower device. Measure network bytes, parsing/highlighting time,
mounted rows, long tasks, and input delay separately. A fast API is not enough if the
browser then blocks for seconds.

For accessibility, verify keyboard navigation, meaningful source-line labels, active
editor preservation, and focus restoration after panel changes. Virtualization must have a
workable reading and selection fallback. Missing accessible names on icon buttons are
visible defects, not details to assume away.

The local project has real bare Git repositories, SQL collaboration handlers, Redis
sessions/cache, and an Elasticsearch adapter. It also has important gaps: nested
repository screens are hidden by missing outlets, automatic indexing is not wired, and
most private-repository access checks are incomplete. These are documented implementation
limits, not production guarantees.

Its client uses component state and fetch, without shared runtime schemas, a query cache
library, or live updates. The code viewer highlights only its first line, the diff viewer
numbers patch rows, and star updates wait for HTTP success. The merge handler performs Git
work and then updates SQL, without the proposed durable publication receipt.

That mapping matters because the design can guide a concrete improvement sequence: repair
reachable routes and permission checks, establish revision-bound contracts, then implement
receipt-based mutations and merge recovery. Adding more service boxes before those
contracts work would not make the developer journey dependable.

## ⚖️ Trade-offs and closing — 2 minutes

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Browsing | ✅ Resolve and retain commit identity | ❌ Independently fetch moving branches | Keep related panels coherent |
| Review | ✅ Stable comparison anchors and draft revisions | ❌ Current row indexes and disposable component state | Preserve both meaning and text |
| Merge | ✅ Pending operation with durable publication recovery | ❌ Optimistic completion and blind retry | Report what happened to shared history |
| Search | ✅ Indexed revision plus current permission | ❌ Link to current main using stale visibility | Make results reproducible and permitted |

> “The frontend needs identities it can preserve, and the backend needs outcomes it can prove. Commits, comparisons, and operation receipts connect those needs across the entire code review journey.”

I would use any remaining time to walk through one lost-response or force-push scenario on
the diagram. The exact local schema, routes, and remaining gaps are in
[architecture.md](./architecture.md), with setup in [README.md](./README.md).
