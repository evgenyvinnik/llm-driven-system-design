# File System — System Design Answer (Frontend Focus)

*Frontend engineer interview · 45 minutes · Requirements → Architecture → State → Data flow → Deep dives → Performance*

> "This is the web client for a cloud file store's namespace: browse directories, see how big things are, create, resize and delete files, and, as an admin, manage users' quotas, merge accounts and restore backups. The server enforces every rule that matters: a path is a file or a directory, never both; nobody exceeds their quota; a restore never touches someone else's file. So the client's job isn't to enforce those rules. It's to make them legible: to say exactly why a write was refused, to make destructive actions deliberate, and to stay fast and honest when a directory has 100,000 entries and its size total is a minute old."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Two personas; refusals are normal; totals can lag |
| Architecture | ~6 min | Routes, components and where each piece of state lives |
| State and data flow | ~8 min | URL as the source of the current directory; a listing cache with clear invalidation |
| Write UX | ~6 min | Confirmed writes with precise errors; uploads that reserve first |
| Deep dives | ~14 min | URL and cache design, confirmed versus optimistic writes, huge directories |
| Performance and wrap-up | ~5 min | Budgets, what breaks first, trade-offs |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who uses it? | Two different screens | End users browse and edit their files; admins manage users, quotas, merges and restores |
| How big can a directory get? | Virtualization and pagination | 100K entries in the worst case; most have under 100 |
| Are directory sizes exact? | How totals are labeled | They may lag the server's writes by up to a minute; quota numbers are exact |
| Can writes be refused? | Error UX is a core flow, not an edge case | Yes: name taken, a directory in the way, a file in the way, over quota |
| Uploads in scope? | Progress, cancellation, resume | Yes; contents go to a block service, metadata to this API |
| Must links be shareable? | Routing | Every directory has a URL; back and forward work |
| Offline? | Sync client versus web app | No. The desktop sync client handles offline; the web app is online-only |

### Functional requirements

1. Navigate directories by clicking, by breadcrumb and by URL. Back and forward work.
2. A directory listing shows name, size (a directory's total), file count and owner, with directories first-class.
3. Side panels show the directory's total and the largest files under it.
4. Create a file (or upload one), resize it and delete it, with clear feedback when the server refuses.
5. The users page shows each user's usage against capacity, file count and latest backup.
6. Admins add users, merge one user into another, back up and restore, and see exactly what a restore skipped.

### Non-functional requirements

| Property | Target | Note |
|----------|--------|------|
| Navigate to a cached directory | < 100 ms to content | Cached listing shown at once, revalidated behind it |
| Navigate to an uncached directory | < 400 ms p75 | One request for the first page |
| Scroll a 100K-entry directory | 60 fps | Only visible rows are rendered |
| Write feedback | < 200 ms to a definite outcome | Writes are small and the server answers in under 50 ms |
| Accessibility | WCAG 2.1 AA | Table semantics, keyboard actions, live regions |
| Honesty | Never show a lagging total as exact | Totals labeled "about" when they come from the aggregator |

### Payload estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| One listing entry | ≈ 100 bytes of JSON | Name, kind, size, owner, file count, version |
| Typical directory (< 100 entries) | < 10 KB | One request, no pagination needed |
| 100K-entry directory | ≈ 10 MB | Must be paged; 1,000 entries ≈ 100 KB per page |
| Requests per navigation | 2 | Listing and largest-files, in parallel |
| Users page (admin) | 1 request per 1,000 users | Paged and searchable past a few hundred users |

> "The numbers say the common case is tiny and the worst case is four orders of magnitude bigger. I design for both from the start, because retrofitting virtualization into a table that assumed small data usually means rewriting it."

---

## 🏗️ Architecture (~6 min)

```
┌───────────────────────────────────────────────────────────────────────┐
│ App shell: header (Files · Users · store badge), toasts (aria-live)   │
├───────────────────────────────────┬───────────────────────────────────┤
│ Route "/"  ?path=/home/alice      │ Route "/users"                    │
│ ┌───────────────────────────────┐ │ ┌───────────────────────────────┐ │
│ │ Breadcrumbs                   │ │ │ Restore result banner         │ │
│ ├───────────────────────────────┤ │ ├───────────────────────────────┤ │
│ │ Directory table (virtualized) │ │ │ Users table: quota bars,      │ │
│ │  dir rows → navigate          │ │ │ backup info, back up/restore  │ │
│ │  file rows → resize, delete   │ │ ├───────────────────────────────┤ │
│ ├───────────────────────────────┤ │ │ Add user · Merge users        │ │
│ │ Side: totals · largest · new  │ │ └───────────────────────────────┘ │
│ └───────────────────────────────┘ │                                   │
└───────────────────────────────────┴───────────────────────────────────┘
          │                                       │
          ▼                                       ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Data layer: API client (typed errors) · listing cache by path ·       │
│ users store · upload manager (reservations, progress, cancel)         │
└───────────────────────────────────────────────────────────────────────┘
```

**Routes.** Two: the file browser at `/` with the directory in a search parameter, and the admin users page at `/users`. I put the path in a search parameter rather than a splat route (`/files/home/alice`) because paths can contain characters that collide with routing (`%`, `#`, `?`), and a search parameter is encoded exactly once by the router. Either works; the important thing is that the URL, not component state, says which directory is open.

**Components stay small.** The directory table renders rows; a file row owns its own "resize" and "confirm delete" modes; the side panels each fetch nothing themselves and receive data from the route.

| Component | Responsibility | Talks to |
|-----------|----------------|----------|
| Breadcrumbs | Render the path; each segment links to its directory | Router |
| Directory table | Header, virtualized body, load-more trigger | Listing cache |
| File row | Display; resize and delete modes; pending state | API client, toasts |
| Directory summary | Total bytes and file count, labeled "about" when lagging | Route data |
| Largest files | Top N under the directory, links to their folders | Route data |
| New file form | Name, size with units, owner defaulting to the home directory's user | API client, users store |
| Users table and rows | Quota meters, backup age, back up and restore | API client, users store |
| Upload manager | Reservations, block uploads, progress, cancel | API and block service, outside React |

### The API the client depends on

```
GET    /api/v1/fs/list?path=…&cursor=…    → { path, bytes, fileCount, entries[], nextCursor }
GET    /api/v1/fs/largest?prefix=…&n=8    → { files: [{ path, size }] }
POST   /api/v1/fs/files                   → 201 { remaining }       409 with a code on refusal
PATCH  /api/v1/fs/files?path=…            → { previous }
DELETE /api/v1/fs/files?path=…            → { size }
GET    /api/v1/users                      → { users: [{ id, capacity, used, fileCount, backup }] }
POST   /api/v1/users/:id/merge            → { remaining }
POST   /api/v1/users/:id/restore          → { restored, skipped: [path] }
```

Two details matter to the UI. Errors carry a stable code plus a human message, so the client branches on the code and displays the message. And the restore response lists skipped paths rather than counting them.

---

## 🗂️ State and Data Flow (~8 min)

### Where each piece of state lives

| State | Lives in | Why |
|-------|----------|-----|
| Current directory, sort order | URL search params | Shareable, survives refresh, back button works |
| Directory listings, largest files | Listing cache keyed by path | Server data; revisiting a directory is instant |
| Users and quotas | Global store | Both pages use it: the owner picker on Files, the table on Users |
| Row editing mode, pending confirmation | Component state | Local, short-lived, irrelevant elsewhere |
| Toasts, restore result | Small global stores / page state | Cross-cutting feedback |
| Uploads in flight | Upload manager outside React | Must survive navigation between directories |

### The read path

1. The route reads `path` from the URL and asks the listing cache for it.
2. A cached listing renders immediately; a request revalidates it in the background (stale-while-revalidate). An uncached path shows a skeleton table.
3. The listing and the largest-files query go out in parallel; they're independent.
4. Hovering a directory row prefetches its first page, so the click usually lands on cached data.

### The write path

1. The user submits a create, resize or delete. The row or form shows a pending state.
2. The API answers in tens of milliseconds with success or a typed error code.
3. On success: invalidate the current directory's listing and largest-files entry, every ancestor's listing (their totals changed), and the users store (quota changed). Then refetch the visible ones.
4. On error: keep the user's input, show the server's specific message, and offer the fix where there is one.

> "Invalidating ancestors matters more than it looks. If I create a 50 MB file in `/home/alice/photos` and then click the `home` breadcrumb, the cached listing of `/home` still says alice's folder is the old size. Either I invalidate every ancestor on write, or I label every cached total as possibly stale. I do the first, because it's cheap: depth is small and only visited ancestors are cached."

### Error taxonomy

| Code | What the user sees | Recovery offered |
|------|--------------------|------------------|
| Path exists | "report.pdf already exists here" | Pick another name; open the existing file |
| Path is a directory | "report is a folder" | Open it |
| An ancestor is a file | "notes.txt is a file, so nothing can go inside it" | Edit the path |
| Over capacity | "alice needs 2.0 MB more but has 1023 KB left" | Delete something, pick another owner, or ask an admin |
| Not found | "This file was deleted elsewhere" | Refresh the listing |
| Validation | "Names can't be empty, '.' or '..'" | Inline on the field |

The server's message already contains the specifics, with sizes formatted for people, so the client shows it verbatim and maps only the code to a recovery action.

### Loading, empty and vanished directories

Directories in this system are implicit: one exists only while a file lives below it. That creates a state most file browsers never have.

| State | What the user sees |
|-------|--------------------|
| First load of an uncached directory | Skeleton rows with the real column widths, so nothing jumps when data arrives |
| Revalidating a cached directory | The cached rows, plus a subtle progress line under the header |
| Empty root | "The namespace is empty. Directories appear when a file is added below them." |
| Directory vanished | Deleting the last file in a folder deletes the folder. If that happens elsewhere while you're viewing it, the next listing returns "not a directory". The UI says "this folder no longer exists, because its last file was removed" and offers its nearest existing ancestor |
| Your own last-file delete | The next refresh finds the folder gone, so the client moves to the nearest folder that still exists (the parent may have vanished too) and says why in a toast, instead of showing an error |

> "That last row is a direct consequence of a backend rule. Implicit directories are simpler for the server, but the client has to explain them, or users will think the app lost their folder."

---

## ✍️ Write UX (~6 min)

**Creates and resizes are confirmed, not optimistic.** They fail for reasons the client can't see: another device just took the name, or the quota just ran out. Showing the row and then yanking it back is worse than a 50 ms pending state.

**Deletes are deliberate.** A trash icon turns the row into "Delete? / Cancel" in place, so there's no modal and no browser `confirm()` (which also blocks automated tests). In production I'd go further: delete moves to trash, which the version history already supports, and the toast offers Undo for ten seconds.

**Uploads reserve first.** Before any bytes move, the client asks the API to reserve the file's size against the owner's quota.
- If the reservation fails, the user learns before waiting through a 2 GB upload.
- If it succeeds, the upload manager streams blocks to the block service with progress, pause and cancel, and finally commits the metadata.
- Cancelling releases the reservation; closing the tab lets it expire.

The upload manager lives outside React components, so navigating to another directory doesn't cancel uploads. A small tray shows them.

**Forms do the boring parts well.**
- Sizes take a number and a unit (B, KB, MB, GB, binary), so nobody types 2621440.
- A name can be a relative path (`notes/today.md`), and the client joins it to the current directory and trims leading slashes. The server still validates.
- The owner picker shows each user's remaining space next to their name and defaults to the user whose home directory is open, or to "unowned" in system folders. That default removes the commonest wrong-owner mistake.
- Submitting keeps focus in the form, and a success clears only the name and size, so adding several files in a row is quick.

**Admin actions show consequences before they happen.**
- **Merge** labels the source as "deleted" and the target as "keeps everything", and the form can preview what moves: file count, bytes and the combined capacity.
- **Restore** is a two-step inline confirm that names the user: "Replace alice's files with the backup?"
- After a restore, a banner lists every skipped path and says why: someone else holds it now. A count alone wouldn't tell the admin what to follow up on.

### Successful trace: alice adds a note from her home folder

1. Alice opens `/?path=/home/alice`. The listing is cached from an earlier visit, so it renders at once while a background request revalidates it.
2. In the side form, the owner already says "alice", because she's in her home directory. She types `notes/today.md`, 2 KB, and submits.
3. The button shows a pending state. The API answers 201 with alice's remaining quota after about 40 ms.
4. The client invalidates `/home/alice`, `/home` and `/` in the listing cache, refetches the visible listing and largest files, and reloads the users store so her quota bar is current.
5. The toast says "Created /home/alice/notes/today.md. alice has 39.7 MB left", and the `notes` row's total has grown by 2 KB.

### Failed trace: dmitri's upload doesn't fit

1. Dmitri picks a 2 MB file. The upload manager asks for a reservation before reading the file.
2. The API answers 409 over-capacity: "dmitri needs 2.0 MB more but has 1023 KB left".
3. The form keeps the selection and shows the message, along with links to his largest files, since deleting one is the likeliest fix.
4. No bytes were uploaded, nothing was cached, and nothing needs rolling back.

### Retries after a lost response

If the network drops after a create was sent, the client can't know whether it committed. Retrying blindly would come back "already exists" for the user's own file. So every write carries an idempotency key generated when the user acts, and a retry reuses it. The server replays the original response, and the UI shows success exactly once. The key lives with the pending action, so it survives a re-render but not a deliberate second click, which is a new action.

### Access and the cache

The listing cache is keyed by user as well as path, and it's cleared on sign-out. If an admin removes someone from a shared folder, their next request for that path gets 404. The client then drops every cached listing under that path, so a stale copy can't keep showing a folder they've lost access to. The server never trusts the cache. It re-checks membership on every read.

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: The URL owns the current directory; a cache owns listings

**The decision.** The current path is a URL search parameter. Listings live in a cache keyed by path, shown instantly when present and revalidated in the background. Writes invalidate the directory and its ancestors.

**Why it works.** Navigation is the dominant interaction, and most of it is going back to a directory you just saw: up to the parent, back from a child. With a cache keyed by path, that is instant. With the URL as the source of truth, refresh, deep links, back and forward all work without special code, and two tabs can show two directories without fighting over global state.

**Why the alternative fails.** Keeping the current directory in a global store, and fetching on change, is how many file browsers start. Then the back button doesn't work, a refresh lands on the root, and sharing a link to a folder needs a second mechanism. Fetching without a cache means every "up one level" click shows a spinner for a listing that was on screen two seconds ago.

```
 write to /home/alice/photos/lake.jpg
        │
        ▼
 invalidate:  /home/alice/photos   (entries changed)
              /home/alice          (total and file count changed)
              /home                (total changed)
              /                    (total changed)
 keep:        /home/bob, /shared, … (unaffected)
 refetch:     only the ones currently on screen; the rest refetch on next visit
```

**What I'm giving up.** Cache invalidation. Writes from *this* tab are easy: I know the path, so I invalidate it and its ancestors. Writes from other devices aren't visible until revalidation. For a shared folder with active collaborators, I'd subscribe to the namespace's change feed over SSE and invalidate by path, coalescing bursts so a sync storm of 1,000 changes causes one refetch per visible directory, not 1,000.

### Deep dive 2: Confirmed writes with precise errors, and where optimism still fits

**The decision.** Creates and resizes wait for the server, typically 30-50 ms, with the row or button showing a pending state. Deletes are optimistic only where an undo exists.

**Why it works.** A create has four ways to fail that only the server can judge, and two of them depend on other users' concurrent actions: the name was just taken, or the owner's quota was just used up by another upload. At 50 ms, a pending state is barely visible, and the outcome is always truthful. When a write fails, the form keeps its input and the error names the specific obstacle, including sizes ("needs 2.0 MB more but has 1023 KB left"), so the user's next step is obvious.

**Why the alternative fails.** An optimistic create inserts the row, updates the directory total and the owner's quota bar, and then has to undo all three when the server says no. With quota refusals common (users near their limit try repeatedly), the UI would flicker between states, and the rollback has to restore three caches exactly. Worse, an optimistic success toast that turns into an error trains users to distrust success messages.

**Where optimism fits.** Deletes almost never fail, and with a trash the server can always undo them. So deleting removes the row at once and shows "Deleted · Undo". If the server does refuse (the file was already deleted elsewhere), the row stays gone, which is the truth anyway.

**What I'm giving up.** A few tens of milliseconds of perceived latency on creates and resizes. Uploads hide it behind progress anyway, and the remaining cases are deliberate, low-frequency actions.

### Deep dive 3: A directory with 100,000 entries

**The decision.** Cursor pagination from the server in name order, pages of 1,000, and a virtualized table that renders only visible rows. Sorting by anything other than name is done by the server, not the client.

**Why it works.** The server's index is already in name order, so a name cursor ("entries after `report-0412.pdf`") is a cheap index seek at any depth, where an offset would scan everything before it. The virtualized table renders about 40 rows regardless of how many are loaded, keeping scrolling at 60 fps. Loading the next page is triggered when the user scrolls within a few screens of the end. Jumping to a name ("go to entries starting with 'r'") becomes a fresh cursor rather than scrolling through 70,000 rows.

**Why the alternative fails.** Fetching all 100K entries at once is about 10 MB of JSON and a multi-second parse before anything renders, and then React has to diff 100K rows on every update. Client-side sorting only works once everything is loaded, so either the sort is wrong while pages arrive, or the user waits for all of them. Offset pagination degrades linearly and returns duplicates or gaps when files are added while you scroll.

**What I'm giving up.** Some sorts become server requests: "sort by size" needs an index ordered by size per directory, or for huge directories the aggregator's top-N list plus "load more". Select-all across unloaded pages needs a server-side selection ("all entries matching this filter") rather than a list of ids. And find-in-page (Ctrl-F) can't see unrendered rows, so the table offers its own filter that queries the server.

---

## 👥 The Users Page (~2 min)

- **Sorted by usage share, highest first**, because the admin's usual question is "who is about to hit their limit". A toggle sorts by name.
- **Quota meters change color at 75% and 90%** and always show the numbers, so color is never the only signal.
- **Backup age is relative** ("3 h ago") with the exact time on hover; users with no backup say so plainly.
- **Restore** shows the backup's file count and size in the confirmation, so the admin knows what will come back before confirming.
- **Merge** filters the target list to exclude the source, so a self-merge can't be chosen, though the server rejects it anyway with a 422.
- **Past a few hundred users** the table pages and gains a search box, with the same cursor approach as directories.

## ♿ Accessibility (~2 min)

- The listing is a real `table` with column headers, so screen readers announce "size, 7.5 MB" in context. A virtualized table keeps `aria-rowcount` and `aria-rowindex` so assistive technology knows the full size.
- Row actions are buttons with labels that name the file: "Resize thesis.pdf", "Delete thesis.pdf".
- Quota bars use `role="meter"` with the percentage as the value, and color is never the only signal: the text says "7.0 MB of 8.0 MB · 88%".
- Toasts are in an `aria-live="polite"` region; errors stay longer than successes.
- After a delete, focus moves to the next row rather than falling back to the page top.
- Every action works from the keyboard; the inline confirm takes focus so Enter confirms and Escape cancels.

## 🕰️ Browsing the Past (~2 min)

The server keeps versions, so the client can offer "view this folder as of a date" cheaply. It's the same route with an extra `?at=` parameter. In that mode the listing is read-only, a banner says what time you're viewing, and each file offers "restore this version". Cached listings are keyed by path and time, and past listings never change, so they can be cached indefinitely. The admin's full-account restore is the same view applied to a whole user, which is why its result banner lists exactly what didn't come back.

## 🧪 Testing (~1 min)

- **Unit**: path helpers (joining, breadcrumbs, the home-directory owner), size parsing with units, byte formatting.
- **Component**: a file row's three modes (view, resize, confirm delete), and that an error keeps the user's input.
- **End to end**: navigate by breadcrumb; an over-quota create shows the server's message; restore lists skipped paths. These run against a seeded backend, so the restore scenario is deterministic.
- **Accessibility**: an automated axe check on both routes, plus keyboard-only runs of delete and restore.

---

## 📈 Performance and What Breaks First (~3 min)

| Budget | Target |
|--------|--------|
| JavaScript for first load | < 150 KB gzipped |
| Cached navigation | < 100 ms |
| Rows rendered at once | ≈ 40, regardless of directory size |
| Refetches per change burst | One per visible directory |

**What breaks first, in order:**

1. **Huge directories without virtualization**: the first 10K-entry folder freezes the tab. Virtualize from the start.
2. **Invalidation storms** from a sync client writing thousands of files into a shared folder you're viewing: coalesce change events per path, at most once a second.
3. **Stale totals presented as exact**: label totals that come from the aggregator as "about", and show the age of the last refresh when it's over a minute.
4. **Upload concurrency**: dozens of parallel block uploads saturate the uplink and starve listing requests. Limit concurrent block uploads to a few and give metadata requests priority.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Current directory | URL search param | Global store | Back, refresh and deep links work for free |
| Listings | Cache by path + revalidate | Fetch on every visit | Up-one-level is instant |
| Creates and resizes | Confirmed | Optimistic | Refusals depend on others' concurrent writes |
| Deletes | Optimistic with undo | Confirmed | Rarely fail, and trash can undo |
| Big directories | Cursor pages + virtualization | Load all; offsets | Constant render cost; stable paging |
| Destructive confirm | Inline two-step | Modal / `confirm()` | Keeps context; testable |
| Uploads | Reserve quota first | Check at the end | Fail before moving gigabytes |
| Restore result | List of skipped paths | A count | The admin needs to know which paths to follow up |

---

## 📝 Wrap-up (~1 min)

> "The server owns every rule, so the client's design is about honesty and speed. Honesty means confirmed writes, errors that name the exact obstacle, totals labeled when they can lag, and a restore that says precisely what it couldn't take back. Speed means the URL as the source of the current directory, a listing cache that makes going back instant, and virtualization so a 100K-entry folder costs the same to render as a 10-entry one."

### If I had more time

- Drag-and-drop moves between folders, which needs rename on the server and an optimistic move with a clear revert.
- Multi-select with server-side selections for bulk delete and bulk ownership changes.
- The change-feed subscription for shared folders, with coalesced invalidation.
- A per-folder "what's using my space" view built on the largest-files query.

### How the local implementation compares

The repository's frontend (`frontend/`, React 19, TanStack Router, Zustand, Tailwind) builds the two routes described here. The current directory is a validated `?path=` search parameter. A `useDirectory` hook loads the listing and the largest files in parallel and reloads them after every write, along with the users store. Creates and resizes are confirmed and show the server's message verbatim. Delete and restore use inline two-step confirmations. A folder that vanishes with its last file sends you to the nearest folder that still exists, and opening a path that never existed offers that folder as a link. The owner picker defaults to the user whose home directory you're in, and a banner lists every path a restore skipped. Quota bars use `role="meter"`, and toasts sit in a live region. It doesn't have the cross-navigation listing cache (each visit refetches), virtualization or cursor pagination (the demo's directories are small), uploads, or change-feed subscriptions. Directory totals there are exact, because the local backend updates them synchronously.
