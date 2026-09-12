# Gmail: frontend system design interview

A proposed 45-minute design for an internal email client. The implementation in this
repository is a smaller teaching demo; the final paragraph explains that boundary.

## 🎯 Scope and user expectations — 5 minutes

> “I would begin with the two things users trust an email client to do: preserve what they write and show the right person's mail. I will design the inbox, conversation reader, compose window, and search. I will spend most of the interview on draft recovery and reconciling mailbox changes.”

The initial product sends between registered accounts. External SMTP delivery,
attachments, scheduling, collaborative editing, and spam classification are outside
this session. To, CC, and BCC are supported, along with labels and per-user read,
star, archive, and trash actions. I would start with plain-text bodies and make rich
HTML a separately reviewed extension.

A thread is a convenient grouping, not an access grant. If Alice sends to Bob and
secretly copies Charlie, Charlie receives that message. A later reply addressed only
to Alice and Bob should not become visible to Charlie merely because it shares a
thread ID. The UI must receive a summary based on the viewer's messages, including the
visible count and latest snippet.

For composing, “Saved” means a specific revision reached durable server storage. It
cannot mean that a debounce timer fired. “Sent” means the service accepted the frozen
message and can report its outcome. Network uncertainty needs its own state so a retry
does not silently create another message.

| User action | Expected behavior |
|-------------|-------------------|
| Type a message | Input stays responsive; saving never replaces newer typing |
| Close and reopen a saved draft | Restore acknowledged content and show any pending local recovery copy |
| Open a conversation | Show authorized messages; mark only the observed portion read |
| Archive or star | Give immediate feedback, then reconcile with the mailbox's authoritative version |
| Search | Distinguish no matches, loading, and temporary unavailability |
| Switch accounts | Clear the previous account's mail and prevent old responses from restoring it |

I would choose responsiveness budgets before library details: normal typing should not
wait for the network, and ordinary mailbox actions should show feedback within a frame
or two. An API target of p99 below 200 ms for an inbox page and 500 ms for search is a
proposal, not a browser performance result. I would measure rendering on a
representative modest device.

## 🏗️ A small frontend architecture — 4 minutes

I would draw the shell, its state boundaries, and the API. The compose workspace
belongs above individual mailbox routes so navigating to a conversation does not
destroy an active draft. On a narrow display it becomes a dedicated screen with the
same editor state.

```
┌─────────────────────────┐       ┌──────────────────────────────┐
│ Mailbox / reader routes │──────▶│ Account-scoped query state   │
└─────────────────────────┘       └──────────────┬───────────────┘
                                                 │
┌─────────────────────────┐       ┌──────────────▼───────────────┐
│ Persistent draft editor │──────▶│ Typed mail API               │
└─────────────────────────┘       └──────────────────────────────┘
```

The shell owns authentication status, navigation, and global notifications. The
mailbox view owns its current filter, page, selection, and scroll anchor. The
conversation view owns expanded message IDs and reply focus. The editor owns authored
text independently of whichever conversation happens to be open.

A typed API layer handles credentials, structured errors, cancellation, and request
IDs. A query cache holds server entities and ordered result IDs. Zustand is a
reasonable choice for transient selection and editor coordination, but I would not put
every server object and keystroke into one globally subscribed store. The important
boundary is ownership, not the brand of state library.

Route parameters identify the mailbox label or thread, and search parameters identify
submitted query/filter state. A page cursor is opaque. I would avoid copying
credentials or message bodies into URLs. The page can restore navigation after reload
without serializing private contents into browser history.

I would initially allow one compose window. Multiple windows require independent draft
identity, focus, save queues, and screen-space rules; that can be added once the
single-editor lifecycle is correct. A floating window should be modeless if users can
continue working in the inbox. It must not claim modal semantics while permitting
focus behind it.

## 🔌 Contracts and state ownership — 4 minutes

> “I want a few explicit response contracts before implementing optimistic UI. Otherwise the browser is forced to guess whether an operation committed, which revision it saved, or which messages contributed to a count.”

| Contract | Fields or behavior the client needs |
|----------|------------------------------------|
| Mailbox page | Ordered thread IDs, viewer-specific summaries, next cursor, mailbox revision |
| Conversation page | Visible messages, next cursor, sequence through which this view is complete |
| Mailbox mutation | Desired state, expected version, operation ID; canonical updated state on success |
| Draft save | Draft ID, local save operation ID, expected server version, saved revision or conflict content |
| Send acceptance | Stable operation ID, frozen content digest, accepted message ID, delivery status |
| Search | Message hits, safe text fragments, next cursor, explicit available/degraded state |

Normalized thread entities let list and detail share the same star/read state. Query
entries retain ordered IDs rather than separate mutable copies of every field. Mailbox
counts belong to a mailbox revision, because the same read action may affect Inbox, a
custom label, and Starred simultaneously.

Request identity includes the account, query, and generation. Cancellation reduces
wasted work, but the response still checks those identities before changing state. A
request may finish after cancellation, so cancellation alone cannot protect an account
switch or a newly submitted search.

The error type preserves status, retry timing, canonical entity state, and operation
identity. A plain error string loses the draft returned with a conflict. The UI treats
authentication loss, validation failure, conflict, rate limiting, and unknown send
outcome differently because they require different actions from the user.

## 🔧 Deep dive 1: preserve drafts through saves, conflicts, and sends — 10 minutes

### Save the revision that actually left the browser

I would track local content revision, last acknowledged revision, server version, and
any in-flight save. Typing updates local state immediately. A short debounce starts a
save, with a maximum waiting interval so continuous typing does not postpone
persistence forever.

Suppose the browser sends local revision 12 using server version 4. While that request
is running, the user types revision 13. The response acknowledges revision 12 and
server version 5. It updates the save metadata, but must not replace the current
editor content or mark revision 13 saved.

Only one save is in flight for that draft in this editor. When it finishes, the newest
dirty revision is queued using the returned server version. This bounds network work
and avoids manufacturing conflicts between the editor's own saves. Other tabs can
still conflict, which is why the server's version condition remains necessary.

A failed network response leaves an uncertain save operation. Retrying the same save
ID lets the server return its original result if it already committed. Generating a
new save ID every time would turn a harmless lost response into a misleading version
conflict. The server needs a declared receipt retention window; the browser cannot
invent exactly-once behavior locally.

### Handle another tab without destroying either version

Tab A and Tab B both load version 4. A saves and advances it to 5. B's update with
expected version 4 receives a conflict. I would retain B's current local text and the
common acknowledged base, then fetch or use the supplied server version to show a
comparison.

A simple first release offers “Keep editing my copy,” “Use the saved version,” and
“Save as a separate draft.” It does not automatically replace B's text and restart
autosave. Automatic field merges can handle unrelated subject/body edits later, but
conflicts in recipients deserve explicit review because a mistaken recipient is harder
to undo than a formatting difference.

A single-user editing lease is an alternative. It can reduce conflicts, but abandoned
tabs, device sleep, and lease expiry need recovery and fencing. A long database
transaction is not required for a lease, and I would not reject all pessimistic
coordination by pretending it necessarily holds a database connection for hours.

| Approach | Benefit | Cost in this client |
|----------|---------|---------------------|
| ✅ Conditional saves with a recovery copy | Detect stale writes while allowing several devices to read drafts | Conflict comparison and uncertain-save recovery |
| ❌ Unconditional last-write-wins | Simple save endpoint | A delayed autosave can overwrite newer authored text |
| ❌ Exclusive editor lease | Fewer simultaneous writers | Lease expiry, takeover, and disconnected-device rules |

> “I choose conditional saves because authored text is valuable and conflicts are recoverable. The cost is a more explicit editor state machine. The server version check protects storage; preserving the user's local copy protects the actual work.”

### Local recovery and closing behavior

For a first release, I would make server-saved drafts the cross-device source of
truth. If crash recovery is a requirement, keep a bounded local recovery copy keyed by
account and draft ID, with a retention policy and a visible indication of what remains
only on this device. Local storage availability and quota errors must be observable to
the editor.

An IndexedDB recovery copy does not automatically provide secure storage on a shared
device. Clear it on explicit sign-out according to the product policy, and never
restore it into another account. If a storage write fails, keep the editor open and
show that the latest text is not protected against closing the tab.

Close and discard are different actions. Closing a saved draft can return to the
inbox; discarding confirms deletion when there is meaningful text. If there are
unsaved changes, the client attempts a save and reports failure rather than assuming
an unload request will finish. Browser unload hooks cannot guarantee durable network
work.

### Freeze send intent

When the user presses Send, commit any valid pending recipient input into a chip or
show a validation error. A typed address must not be silently omitted because the user
forgot Enter. Normalize addresses according to the service's rules and detect
duplicates across To, CC, and BCC without silently changing their roles.

The editor freezes a revision and its recipient envelope. It disables editing that
frozen message, or explicitly moves later edits into a new draft. This avoids a
successful response closing the window and discarding text typed after the request
began.

The server accepts the send with a stable operation ID and atomically marks that draft
revision sent. The browser can then show acceptance while delivery is pending. If the
response is lost, keep the operation in “Checking send status” and query or retry
using the same ID. Do not invite the user to press a fresh Send button that creates
another message.

A late autosave must not revive the sent draft. On success the client cancels queued
saves, and the server rejects saves against a terminal draft state. Both sides matter:
a browser can crash after submission, and another tab may still be editing.

## 🔧 Deep dive 2: a responsive inbox with consistent actions — 9 minutes

### Bound data before optimizing DOM work

I would start with 25 or 50 conversations per page, not preload an entire mailbox.
Each row needs only the visible participants, subject, snippet, date, unread status,
and labels. Message bodies are fetched when opened, with old conversation messages
loaded in bounded pages.

A small page may not need virtualization. If a dense mode or larger retained window
makes rendering expensive, use TanStack Virtual with stable thread IDs, a real
constrained scroll viewport, and measured heights when labels or accessibility text
can wrap. Virtualization bounds mounted elements; pagination and cache eviction bound
downloaded data and memory. Neither replaces the other.

I would keep the current page and perhaps one adjacent page, then evict older query
pages under a budget. Opening a conversation saves a thread ID and visual offset as
the scroll anchor. Returning restores that anchor if it still exists; otherwise it
chooses the nearest surviving row and explains that the mailbox changed.

Live conversation ordering is mutable. A new reply can move a thread above a cursor
already visited. I would deduplicate IDs within the current browsing session and
display a “New mail” refresh affordance instead of shifting the list while the user
selects a row. A refresh creates a new view of the ordering.

A cursor based on date plus unique ID gives a deterministic boundary for a particular
read; it does not freeze the entire mailbox. If the product later requires a perfectly
stable multi-page session, I would add a bounded server snapshot and expiration
behavior. I would not imply that choosing cursors alone solves changing sort keys.

### Reconcile desired state instead of reversing history

For a star action, overlay the desired state on the shared thread entity, send its
expected version and operation ID, then reconcile the returned version. If the user
changes their mind while a request is in flight, coalesce the next desired value or
serialize another operation for that field.

Suppose an older star request fails after a newer unstar request succeeds. Blindly
inverting the star bit would restore the wrong state. The rollback must remove only
the failed operation's overlay and preserve newer intent. Conflicts reload canonical
state and reapply an explicitly still-pending desired action.

Archive removes the thread from the active Inbox query immediately. The server changes
canonical Inbox membership, not just an unrelated archive flag. The response updates
the entity, affected counts, and mailbox revision. Other query views can invalidate or
patch their membership based on that same canonical result.

Undo is another desired-state operation. If archive already committed, undo restores
Inbox membership with appropriate version checking; it does not travel backward in
time and cancel a database commit. If a new delivery changes the thread during the
undo window, reconcile rather than overwriting the newly arrived state.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Optimistic desired state with versioned reconciliation | Immediate feedback without stale rollback overwrites | Pending-operation bookkeeping and conflict handling |
| ❌ Wait for every response before updating | Smaller client state model | Every action feels network-bound |
| ❌ Optimistic toggle plus inverse rollback | Easy happy path | Overlapping actions and refetches can reverse newer intent |

### Reading must not swallow future mail

The conversation response includes a visible-message sequence watermark. After
presenting that content, the browser acknowledges reading through that watermark. If
another message arrives while the request is in flight, its higher sequence remains
unread.

Marking the whole thread read with a late boolean update could erase the unread state
of unseen mail. That is why I would make the contract about what was observed.
Explicit “mark unread” remains a separate action with its own versioned semantics.

A search click should open the matching message, load the necessary visible page, and
expand it. The conversation may also contain newer messages, but jumping to the newest
body would make the search result feel wrong. The browser should never infer hidden
message IDs or counts from a global thread summary.

### Navigation and accessibility are part of performance

Use native links or buttons with names for opening threads and applying actions. If
keyboard row navigation is required, define a roving focus model and ensure the
focused row remains mounted while virtualizing. Do not remove a focused element just
because an overscan calculation changed.

Arrow keys can move among rows; Enter opens the selected conversation. Optional
shortcuts must not fire while typing in recipients, subject, body, or search. After
archive, focus moves to the next appropriate row; after returning from detail, it
returns to the saved thread or a nearby surviving item.

A readable unread indicator uses text and font weight as well as color. Icon controls
expose action names and pressed state. Touch users can reach actions without hover.
These choices are more useful than adding a grid role without implementing its
keyboard behavior.

## 🔧 Deep dive 3: search that is safe and understandable — 7 minutes

I would use an explicit submitted search query. Autocomplete for contacts is a
different interaction and can be debounced independently. Search result state is keyed
by account, normalized query, filters, and page context; changing any of them
invalidates older responses.

A compact dropdown can support quick lookups, but a full result route is better when
users need multiple pages, browser Back, or a linkable query. I would begin with a
full results view while retaining the previous inbox anchor, and add a quick-search
overlay only if product evidence supports it.

The server owns parsing of supported operators. The UI can show chips or hints, but it
should not implement a second incompatible query language. Invalid dates or
unsupported combinations get an explicit explanation. A query that contains only
operators can still be meaningful.

Results identify messages, not only threads. The UI may group hits visually, but must
distinguish the number of matching messages from the number of conversations. Exact
total counts are optional; “more results” is preferable to a misleading total when
filtering or search limits make a count incomplete.

A delayed response cannot reopen a dropdown after the user clears it, replace a newer
search, or show the prior account's hits. Use a response-generation check even when
the fetch was aborted. Loading, empty, error, and stale-but-visible states should not
be represented by one empty array.

### Treat snippets as data

I would request text fragments and highlight ranges, then render the text through
React and wrap approved ranges in emphasis elements. An alternative is rigorously
encoded, sanitized HTML with a tiny allowlist, but that adds another parser and trust
boundary. Mail bodies may contain literal angle brackets; a fallback substring is
still untrusted content.

The same principle applies to the reader. Plain text is the initial contract. Adding
HTML email later requires sanitization and isolation, including controls for remote
images, links, and styling. React's normal text escaping does not protect content
deliberately inserted as raw HTML.

The server must exclude BCC names and addresses from the fields searchable by other
recipients, not merely hide them from displayed headers. Otherwise a query for a
hidden recipient could reveal their participation through the existence of a result.
The frontend cannot repair that by concealing a label.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Safe text fragments plus highlight ranges | Clear rendering contract for arbitrary message content | Range validation and Unicode-aware offsets |
| ❌ Insert search HTML directly | Quick visual highlighting | Untrusted content can become active markup |
| ✅ Explicit search availability state | Distinguishes an outage from no matching mail | Additional states and retry presentation |
| ❌ Empty array for every failure | Fewer response shapes | Users may conclude that mail has disappeared |

If using search snapshots for pagination, expiration restarts the search visibly. A
snapshot does not preserve access after entitlement is removed. The service checks
current access before returning content, and the browser treats a later unavailable
hit as a normal changed-mailbox case rather than trying another private endpoint.

## ⚡ Performance and verification — 4 minutes

I would measure input delay during autosave, row rendering during scroll, heap growth
over a long session, and the time from a mailbox action to a stable result. Subscribe
components to the fields they need and avoid recomputing the whole list for every
keystroke. Splitting editor state from inbox state helps before any memoization work.

Load conversation bodies on demand and keep search pages bounded. Split heavy future
rich-text or HTML-processing code from the initial shell where profiling justifies it.
A library being installed or a route being file-based does not prove that useful code
splitting occurs.

The most important checks exercise reordered events: save response after newer typing,
save conflict from another tab, accepted send with a lost response, stale fetch after
account switch, two rapid star actions, and a read acknowledgment racing with
delivery. A happy-path screenshot cannot establish these properties.

Accessibility checks cover keyboard-only composition, leaving an empty recipient field
with Tab, navigating virtualized rows, focus after archive, and closing a compose
window without losing work. Small-screen checks cover the editor and search results,
not just shrinking the inbox grid.

## ⚖️ Decisions and implementation boundary — 2 minutes

> “My central choice is to make uncertainty visible while protecting the user's intent. Draft revisions protect authored content, mailbox versions protect actions, and request generations protect which account and view a response belongs to. Those mechanisms let the UI feel quick without making false promises.”

The first release remains deliberately bounded: one compose window, plain-text mail,
paged lists, conditional draft saves, and explicit search failure states. More
sophisticated editing and offline behavior can follow after the save/send lifecycle is
reliable.

The local demo already has cookie sessions, a virtualized paged list, contact
debounce, and optimistic list actions. Its draft API is not connected to compose,
label management is unmounted, account/query generations are absent, raw HTML is
injected, and list/detail state can disagree. Those are implementation limitations,
not properties of the proposed interview design. [The architecture
document](./architecture.md) traces the actual source and the production extensions
separately.
