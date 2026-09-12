# Design a team wiki — frontend interview

## 🎯 Frame the problem — 3 minutes

> “I would design the experience around three tasks: finding a trustworthy page, editing
> without losing work, and understanding which revision other people can read. The page
> tree and toolbar matter, but the hardest frontend problem is keeping those tasks
> consistent when requests finish late or another author changes the page.”

I would clarify whether we need simultaneous live typing. For this interview, assume
asynchronous collaboration: people save revisions, leave comments, and review changes.
We preserve disconnected drafts, but do not promise automatic offline merging.
Attachments, arbitrary plugins, and live cursor synchronization are outside the first
version.

Spaces provide the main access boundary. Some allow authors to publish directly; others
require approval of a specific revision. A draft can be saved successfully while readers
still see an earlier published revision. That distinction should be visible in both the
data contract and the interface.

This is a proposed production frontend. The repository provides useful components and
API examples, with limitations described at the end. I would not present every proposed
behavior as already implemented.

| Discussion | Time |
|------------|------|
| Scope and user contract | 3 min |
| Layout, architecture, and state | 7 min |
| Deep dive: editing and recovery | 12 min |
| Deep dive: navigation and identity | 8 min |
| Deep dive: search and safe rendering | 8 min |
| History, review, and comments | 4 min |
| Verification and trade-offs | 3 min |
| Total | 45 min |

## 🏗️ Layout, architecture, and state — 7 minutes

I would draw one application shell with a space sidebar and a routed content area. The
content area can show a page, an editor, history, or search results. The reader should
not download the editor bundle simply to open a short document.

```
┌──────────────────────────────────────────────────────┐
│ App shell: account, space, search                    │
├───────────────────┬──────────────────────────────────┤
│ Page navigation   │ Reader / editor / history        │
│ Metadata only     │ Route + revision context         │
└─────────┬─────────┴─────────────────────┬────────────┘
          │                               │
          ▼                               ▼
┌──────────────────────┐     ┌─────────────────────────┐
│ Resource cache       │     │ Editor session          │
│ Server snapshots     │     │ Base + draft + request  │
└─────────┬────────────┘     └────────────┬────────────┘
          │                               │
          └────────────────┬──────────────┘
                           ▼
            ┌────────────────────────────┐
            │ API: pages + search        │
            │ Permissions / receipts     │
            └────────────────────────────┘
```

The boxes describe ownership, not a requirement for a different state library in each
box. React and a small Zustand store are reasonable tools, but one global `currentPage`
object is insufficient for cached server data, an editable draft, and an in-flight save.

| State | Owner | Why it belongs there |
|-------|-------|----------------------|
| Space, page ID, view mode, search query | URL/router | Deep links and browser history reproduce the location |
| Page revisions and navigation metadata | Resource cache keyed by identity | Responses can be reused without replacing unrelated pages |
| Base revision, draft, selection, undo | Editor session | Typing must survive unrelated fetches and UI renders |
| Expanded branches and panel state | Local UI state | Presentation preferences do not change page content |
| Accepted mutation and pending payload | Save coordinator | Resolve retries without confusing them with newer typing |
| Account and capabilities | Session context | Clear protected resources when identity changes |

A page response carries its stable ID, revision, canonical URL, publication information,
and permitted actions. Capability flags determine whether to show Edit or Review, while
the server remains responsible for permission checks. Hiding a button cannot secure the
API.

For an initial product budget, I would aim for a useful reading shell within about two
seconds on the agreed device/network profile, and visible typing updates within a frame
during ordinary edits. I would measure large-page typing latency separately from network
save time. These are proposed targets, not measurements of the demo.

Loading states are resource-specific. A slow comment request must not turn an already
readable page into a full-screen spinner. A failed page fetch should show a retry state
for that page, not the body of a previously opened page under a new title.

Session resolution also has a clear boundary. The shell can load public assets
immediately, but private content waits for the account context. On logout or account
change, cancel obsolete work and clear protected caches and drafts according to the
retention policy.

## 🔧 Deep dive 1: editing without losing work — 12 minutes

### Choose a document model with an explicit edit session

> “I would choose a schema-based editor with its own document and selection state. React
> owns the surrounding application, while the editor owns the active editing surface.
> Replacing its HTML every time React renders risks changing the user's selection and
> undo history.”

The canonical document describes paragraphs, headings, lists, links, and a bounded set
of macros. The server validates that model and produces safe HTML and searchable text.
The browser does not submit three unrelated representations and expect them to remain
consistent forever.

This costs an editor integration and a document schema that must evolve carefully. A
simple content-editable element is attractive for a small demo, but as formatting,
paste, undo, and composition support grow, the application starts rebuilding an editor's
responsibilities piecemeal. I would use a mature editing model once these are real
product requirements.

The choice is not a claim that a library automatically makes content safe. A link's
protocol, a macro's attributes, and pasted content still need validation. Schema
migrations must preserve documents that older clients created, or reject editing with a
clear upgrade path.

### Separate the last accepted snapshot from current typing

Suppose Alice opens revision 12. The editor stores that base and a mutable draft. A save
captures an immutable payload and a mutation ID. Alice can keep typing while the request
is pending, but those later keystrokes are not part of that submitted payload.

When the response confirms revision 13, the application advances the accepted base. It
clears the dirty indicator only if the current draft still matches what was submitted.
If Alice typed another paragraph during the request, the screen says those newer edits
remain unsaved.

| Editor state | Meaning | Useful action |
|--------------|---------|---------------|
| Clean | Draft matches the accepted revision | Continue editing |
| Unsaved | Local changes differ from that revision | Save or preserve a local draft |
| Saving | One identified payload is awaiting a result | Continue typing; avoid duplicate submission |
| Outcome unknown | Request failed after it may have committed | Resolve the same mutation before replacing it |
| Conflict | Another revision superseded the submitted base | Compare and reconcile without discarding text |
| Access lost | Server no longer permits editing | Preserve permitted recovery options; stop writes |

I would serialize saves within an editor session initially. Autosave, if added,
coalesces further typing into the next request after the active save resolves. Launching
overlapping whole-document saves makes ordering harder and usually adds little value for
a wiki.

A manual Save control remains useful even with autosave. It communicates the boundary
between work in the browser and work acknowledged by the server. A separate Publish
action reflects reader visibility; saving a draft should not silently announce
publication.

### Handle the two-editor case explicitly

Alice and Bob both open revision 12. Bob saves first, producing revision 13. Alice's
request still names revision 12 as its base. The server returns a conflict instead of
treating her stale content as a valid replacement for revision 13.

The frontend retains three things: Alice's original base, her draft, and the latest
server revision. It can explain what changed and offer a comparison. For the first
release I would let Alice reconcile deliberately rather than automatically merge
structural changes to rich text.

A text-only merge may look successful while combining incompatible table or macro edits.
If we later offer automatic merging, it should be based on the document model, preserve
user intent where defined, and flag unresolved regions. A green “merged” message is a
correctness claim.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Revision check and explicit conflict | Clear save boundary, protects against stale replacement | Authors sometimes reconcile manually |
| ❌ Last write wins | Simple request flow | A successful save can silently erase another author's work |
| ❌ Live collaborative merge initially | Supports simultaneous typing | Requires merge semantics, reconnect handling, and editor integration |

I would choose explicit conflicts because concurrent live typing is outside our scope.
If user research shows that teams routinely edit together, the product requirement
changes, and the additional co-editing machinery becomes justified.

### Recover from uncertain requests and navigation

A network timeout does not tell the browser whether the database committed. Retrying the
exact mutation ID and payload allows the server to return the original result. Creating
a new ID immediately could turn one user action into two history entries.

While that outcome is unresolved, preserve the newer local draft separately. It must not
be substituted into the old mutation's retry. After learning the accepted revision, the
editor can submit the next draft against the correct base.

Leaving the page needs a policy too. Warn about unsaved edits, offer an explicit
discard, and save a bounded local recovery copy where the workspace policy permits it.
Scope that copy to account, space, and page, and expire it; a shared browser must not
show another account's draft.

Local persistence is a recovery aid, not proof of a server save. If browser storage is
unavailable or full, keep the draft in memory and make the limitation visible. Reopening
an old local draft still requires checking the current server revision before saving.

Composition input deserves a direct test. A background page refresh must not replace the
document while someone is choosing an input-method candidate. Remote changes can be
announced and reconciled at a controlled boundary instead of resetting the active
surface.

## 🔧 Deep dive 2: navigation that keeps its identity — 8 minutes

### Stable IDs, readable URLs, and route ownership

> “I would treat the page ID as identity and the title-derived slug as a readable hint.
> Renaming a page should not break bookmarks, search links, or an editor's save
> response.”

A route resolves the ID and returns the canonical URL. An old slug can redirect or be
corrected without selecting another document. Two pages with the same title remain
distinguishable. This also avoids using a special title such as ‘new’ as an accidental
substitute for a page identifier.

The space layout owns the sidebar and an outlet for its child view. The page layout owns
common page chrome and an outlet where appropriate for editing or history. An end-to-end
route test should load a direct editor URL; a dashboard test cannot prove nested views
render.

After saving a renamed page, navigation uses the response's canonical URL. It should not
reconstruct the address from the previous title. If the user has already navigated
elsewhere, that late response updates the relevant resource cache without dragging them
back.

### Load the tree as navigation metadata

For a small space, fetching a compact tree can be simplest. For a space with tens of
thousands of pages, fetch child metadata as branches expand. Nodes need identity, title,
parent, order, child count, and relevant capabilities—not every page's HTML and revision
body.

Keep normalized nodes separate from the list of currently visible rows. Expansion
changes which rows appear without rewriting document content. Preserve expansion by page
ID when refreshing a branch, and reveal the active page's ancestors when following a
deep link.

Virtualize the visible rows when their count warrants it. Virtualization reduces mounted
elements, but does not reduce a giant network payload or make an expensive tree-building
algorithm free. Measure those costs separately.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Compact metadata with lazy branches for large spaces | Bounded transfer and rendering; supports deep links | Additional loading states and branch invalidation |
| ❌ Full page bodies in the tree response | Convenient single fetch for a tiny seed | Large payloads, repeated sensitive content, slow navigation |

The trade-off is extra coordination between navigation and the page resource. I accept
it because readers open many pages but usually inspect only a small part of a large
hierarchy.

### Keep asynchronous work attached to the right route

Consider quickly opening page A, then page B. If A's request finishes last, it may
populate A's cache but must not become B's current view. Every request and mutation
completion is checked against its captured page and account context.

Abort requests that are no longer useful, but do not rely only on cancellation. A
response may already be in flight, or cancellation may not stop the server action.
Identity checks on completion remain necessary.

Moving a page changes tree metadata and breadcrumbs, not its stable address. The server
validates permission, cycles, and ordering. The client can show a provisional move, but
it retains the old placement until confirmation and restores it on failure.

For the initial interface, a “Move to…” dialog may be easier to make keyboard-accessible
than drag-and-drop. Dragging can be added as another input method. It should invoke the
same validated action, rather than becoming a second set of hierarchy rules.

The tree needs visible focus, expand/collapse keyboard behavior, and meaningful
hierarchy semantics. On smaller screens, the sidebar becomes a dismissible navigation
panel; a permanently fixed wide sidebar would consume the reading area.

## 🔧 Deep dive 3: useful search without unsafe or misleading results — 8 minutes

### Make query state reproducible

The URL stores the query, selected space, and continuation state. Back and forward
navigation restore those inputs and the appropriate results. A submitted-search
interaction is a reasonable first version; type-ahead can be added with debouncing when
it improves the product.

Each response belongs to a query identity. If the user submits “deployment” and then
“incident,” a slow deployment response cannot replace the incident results. Loading can
retain clearly labeled previous results, but should not imply they answer the current
query.

Search has at least three outcomes: matching results, a successful empty result, and an
unavailable or degraded service. A spinner followed by “No results” after an error makes
people distrust their own knowledge of the wiki.

### Be honest about revision and freshness

A save acknowledgement updates the editor's page resource immediately. Search is a
separate derived view and may lag. The user can follow the page's stable link while
indexing catches up; repeatedly resaving is not a sensible way to refresh search.

The server should return safe, authorized result metadata and enough freshness
information to explain a known delay. The frontend does not promise an exact countdown
unless the backend actually provides one. During an indexing incident, a concise
degraded-search message is more useful than a claim that everything is current.

A result identifies the page and represented published revision. When opened, the page
endpoint rechecks current access and publication. If the result became unavailable,
explain that it changed rather than silently opening another page with a matching slug.

### Treat snippets as content, not trusted markup

> “I would ask the search API for escaped text segments with controlled highlight
> markers. Search terms should be emphasized, but neither the indexed document nor the
> highlighter should become an unrestricted HTML source in the browser.”

This is the same content boundary as the reader, expressed through a smaller
representation. Links and macros in full documents use a validated renderer; snippets
are text. Arbitrary HTML insertion is convenient but makes every content-producing path
a potential script injection path.

The server filters current permissions before sending titles, snippets, or sensitive
counts. Hiding a result in React after receiving it is too late. The client also clears
protected results when the account changes, while recognizing it cannot make a user
forget text already displayed.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Safe text segments and current authorization | Predictable display and controlled disclosure | More explicit API contract and server work |
| ❌ Raw highlighted HTML and client filtering | Quick prototype integration | Stored markup can execute; private content already crossed the boundary |

I would accept a slightly less elaborate snippet rather than relax this boundary. Rich
page rendering belongs in the page renderer; search should help a user decide which
authorized page to open.

### Bound cost and preserve usability

Use short result pages or a continuation cursor, not an unbounded list. The server
validates query length and limits; the client prevents accidental repeated submission
but cannot enforce the system's resource budget alone.

If a simpler fallback is available, label its reduced capability. It may use different
matching or ordering, so do not present its first-page length as the exact number of all
matches. An unavailable search service can still leave space navigation and known page
links usable.

## 🕰️ History, review, and discussion — 4 minutes

History initially loads revision metadata, then fetches selected snapshots or a bounded
diff. A long-lived page should not download its complete content history just to open
the version list. Label both compared revisions, authors, and timestamps so the user
understands what is being compared.

For rich text, a line diff of serialized HTML is an implementation tool rather than a
friendly semantic comparison. I would start with readable text/block changes and name
any formatting detail the comparison omits. Large comparisons can have a separate
loading state and limit.

Restore is a new edit based on an old snapshot, not deletion of later history. The
confirmation names the source revision and the current revision being replaced. A
successful response refreshes the page, history, tree title if changed, and publication
indicators; it does not merely close a dialog.

Review is tied to a revision. A banner can say “Revision 18 awaiting review; readers see
revision 16.” If the author saves revision 19, a reviewer looking at 18 must not
unknowingly publish 19. Cancelled decision prompts submit nothing, and pending controls
prevent duplicate clicks without pretending to authorize the action.

Comments have their own request state. A failure to post retains the comment draft; a
late reply response cannot append itself to another page's thread. Begin with roots and
one reply level if that is the intended API contract, and enforce that shape server-side
too.

## 🧪 Verification and trade-offs — 3 minutes

I would prioritize tests that exercise state boundaries: direct page/editor routes,
typing while a save completes, two-tab conflicts, timeout after commit, navigation
during fetch, title changes, access revocation, and composition input. These reveal more
about a wiki's reliability than checking that a toolbar button exists.

Performance checks use a large page, a deeply nested space, and a long history. Measure
typing latency, navigation payload size, and unnecessary body downloads separately.
Accessibility checks cover editor focus, tree navigation, error announcements, and
small-screen navigation.

| Decision | Chosen approach | Cost accepted |
|----------|-----------------|---------------|
| Editor ownership | Structured edit session separate from server cache | Editor integration and schema evolution |
| Concurrent saves | Expected revision and preserved conflict draft | Some manual reconciliation |
| Page identity | Stable ID with readable canonical URL | Resolution and alias handling |
| Navigation | Metadata first, lazy branches when needed | More branch loading states |
| Search display | Safe, authorized snippets with explicit status | Tighter API coordination |
| Publication | Separate saved and published revisions | More than one meaningful version in the UI |

### Relationship to the local project

The local React/Zustand implementation contains a reader, content-editable editor, tree,
history, comments, and review components. Its generated routes nest page/edit views
under parents without child outlets, so the normal browser path does not reach those
components today. Search also builds links using a UUID as a slug.

The current editor sends HTML/text and empty structured JSON, has no autosave or draft
recovery, and can receive stale shared state. Its API lacks expected-version saves and
space authorization. History uses HTML-line diffs, and templates/TOC behavior is
incomplete. These are documented teaching gaps, not guarantees established by the
proposed design. See [architecture.md](./architecture.md#implementation-notes) for the
source evidence.

> “The central frontend contract is that the user can always tell which page they are
> editing, which work is saved, and which revision readers can see. The component and
> state choices follow from keeping those three answers reliable.”
