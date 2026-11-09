# CI/CD Platform — System Design Answer (Frontend Focus)

*Frontend engineer interview · 45 minutes · Requirements → Information architecture → State → Run page → DAG → Live logs → Dangerous actions → Accessibility → Deep dives → Traces*

> "The backend of a CI/CD system has one job above all: don't lie about what happened. The frontend has the same job, and more ways to fail at it. A person looks at this screen at 2 a.m. to decide whether production is broken. So I'm not designing a dashboard; I'm designing an instrument. Three screens carry most of the weight. The run page has to show a graph of jobs and make the one that needs a human impossible to miss. The log view has to stay fast with a million lines, and survive a dropped connection without losing or repeating a line. And every dangerous button has to tell the truth about what it will do. The hardest moment is when a runner vanishes during a deploy. The platform doesn't know whether production changed, so the UI must say so, not show a green tick or a red cross it can't justify."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~4 min | Honest status, huge logs, dangerous actions |
| Information architecture and routes | ~4 min | Repos → runs → run → job |
| State and data flow | ~5 min | Polling for state, one stream for logs; the server decides |
| Run page and DAG | ~7 min | Attention first; a graph you can read |
| Live logs | ~7 min | Offsets, resume, virtualization |
| Dangerous actions | ~4 min | Confirmation from the server; three decisions |
| Deep dives | ~8 min | Log stream; polling versus push; "unknown" as a design problem |
| Accessibility, traces, scale | ~6 min | Not by color alone; two walkthroughs |

---

## 🎯 Requirements and Scope (~4 min)

### Who uses this, and for what

| User | Moment | What they need in 5 seconds |
|------|--------|----------------------------|
| Maintainer | "Why is my PR red?" | Which job failed, and the log line |
| On-call | "Did the deploy land?" | A clear state, and who has to decide what |
| Reviewer | "Can I approve this deploy?" | What, from which commit, into which environment |
| Read-only teammate | "What's the status?" | The same picture, no buttons that fail |
| Platform operator | "Is the queue healthy?" | Queue depth, per-repository concurrency, fairness |

### Functional

1. Repositories, and runs per repository with status and filters.
2. Run detail: pinned commit and workflow, a DAG of jobs, attempt numbers, artifacts, re-run and cancel controls.
3. Job detail: attempt selector, steps, live logs with visible reconnect and resume, timeline.
4. Environment approvals, and a panel for `needs_attention`.
5. Secrets management where values are never shown, and a release audit.
6. Runners (labels, lease, heartbeat), an ops view, and a fixture panel to demo everything from the browser.

### Non-functional

| Property | Target | What it forces |
|----------|--------|----------------|
| Log latency | Under 2 s from runner to screen | A stream, not a slow poll |
| Log length | A million lines without jank | Virtualization, batched updates |
| Resume | No lost or repeated lines | The server's line number as the cursor |
| Status accuracy | Never contradicts the backend | The server derives status; the client only renders it |
| Permissions | No button that's going to fail | The server says what you can do |
| Accessibility | No state conveyed by color alone | Words and icons on every status |

---

## 🗺️ Information Architecture (~4 min)

```
/login
/repos ──────────▶ /repos/:id           runs, filters
                     ├── /environments  protection rules
                     └── /secrets       metadata, write-only form, audit
                          │
                          ▼
                   /runs/:id            pins · attention · approvals · DAG · jobs · artifacts
                          │
                          ▼
                   /runs/:id/jobs/:jobId  attempts · steps · live logs · timeline
/runners                                leases, heartbeats, kill switch
/ops                                    queue depth, concurrency, burst behaviour
/fixtures                               push, duplicate delivery, fork PR, kill
```

Every run and job has a stable URL, because the most common way into this product is a link in a Slack message or a failed-build email. That has consequences: a deep link must work logged out (redirect to login, then back), and must render without any earlier page having loaded.

I use file-based TanStack Router. Parent routes are `*.index.tsx` so a run page and its job page are siblings rather than nested layouts: a job page wants the whole width for logs, not a run page wrapped around it.

**The app shell** is a sticky sidebar with the document itself scrolling. An inner scroll pane would break full-page capture, browser find and the back button's scroll restoration.

---

## 🧠 State and Data Flow (~5 min)

```
                      ┌──────────────┐
  Session ──────────▶ │   Zustand    │  who am I
                      └──────────────┘
                      ┌──────────────┐  every 1.5-3 s, while the tab is visible
  Run, jobs, repos ──▶│   usePoll    │────────────── GET /runs/:id
                      └──────────────┘
                      ┌──────────────┐  one connection, only on the job page
  Log lines ─────────▶│ useLogStream │── fetch + ReadableStream, Last-Event-ID
                      └──────────────┘
```

**Three kinds of state, deliberately separate:**

| State | Where | Why |
|-------|-------|-----|
| Session | Zustand | Global, rarely changes |
| Server state (run, jobs, runners) | `usePoll`, in the page | The server owns it; a store would be a stale copy |
| Stream state (lines, cursor, connection) | `useLogStream`, in the log component | Unmounts with the view, which closes the connection |
| UI state (selected attempt, note text) | `useState` | Local |

**The server decides, the client renders.** The client never computes a run's status from its jobs, never works out whether a job is non-idempotent before asking, and never hides a button based on its own idea of permissions. `canManage` comes with the run. That rule removes a whole class of bug: a screen that disagrees with the backend.

**No optimistic updates for actions.** Liking a post can be optimistic. "Approve this production deploy" can't. A button goes busy, the request completes, then the next poll shows the truth. `reload()` fires immediately after a success, so the wait is a few hundred milliseconds, and it's honest.

**Polling details that matter:**

- It pauses while the tab is hidden: a laptop left open on a run page shouldn't hit the API all weekend.
- A response from before the route changed is discarded, using a generation counter, so a slow reply can't paint the old run onto the new page.
- A failed poll keeps the last data on screen, with an error note. A blank page during a blip is worse than slightly stale data, as long as it says so.
- A 404 gets its own message: "does not exist, or you do not have access". The API returns 404 for both, so this page can't leak which.

---

## 🖥️ The Run Page (~4 min)

The order on the page is the order of urgency, not the order of the data model:

```
┌────────────────────────────────────────────────────────────────┐
│ acme/web-app / run #10                                         │
│ Release the new checkout flow  [needs attention]   [Re-run…]   │
│ Pinned commit d1bd82c5 · workflow @ 2b0de5f4 · push by alice   │
├────────────────────────────────────────────────────────────────┤
│ ⚠ Outcome unknown: Deploy to production                        │  ← what needs you
│   Step "Deploy" had started when runner-2 stopped responding.  │
│   [It succeeded] [It failed] [Safe to run again]               │
├────────────────────────────────────────────────────────────────┤
│ Job graph:  [Build ✓] ──▶ [Deploy ⚠] ┄┄▶ [Smoke, blocked]      │  ← the shape
├────────────────────────────────────────────────────────────────┤
│ Jobs: name · status · attempt · runner · secrets · duration    │  ← the detail
│ Artifacts · Workflow file                                      │
└────────────────────────────────────────────────────────────────┘
```

**Pins are shown as pins.** "Pinned commit" and "Pinned workflow" are labelled that way, with the delivery id. If a webhook was redelivered, the header says "received 3×, one run". That turns an abstract guarantee into something a person can see.

**The fork notice.** On a fork's run, a banner says the code is unreviewed, receives no secrets and can't enter a protected environment, and that the claim path enforces this while the screen only reports it.

**Secrets per job.** The jobs table shows released secrets in one tone, and withheld ones in another, with the reason on hover and in the attempt view: `NPM_TOKEN withheld: Pull requests from forks never receive secrets`. Someone debugging a fork's failure needs that, not a mysteriously empty variable.

---

## 🕸️ The DAG (~3 min)

Most workflows have 3 to 20 jobs, so I lay it out myself rather than pull in a graph library.

1. **Columns by longest path:** a job sits one column right of its deepest prerequisite, so time flows left to right.
2. **Rows by barycenter:** place a job near the average row of what it needs, which keeps edges short and mostly uncrossed.
3. **Edges** are cubic curves from the right edge of a node to the left edge of the next.

**A node has to work without color:** name, status in words, and the attempt when it's past 1. Skipped and blocked nodes get a dashed border. `needs_attention` gets a thicker border. Each is a focusable link with an accessible name like "Deploy to production: needs_attention, attempt 1", and its reason is in a tooltip.

**A wide matrix** scrolls horizontally inside its panel, never the page. Beyond a few dozen legs I'd collapse them into a group node with a count, because 200 nodes is a poster, not a diagram. That isn't built.

---

## 📜 Live Logs (~7 min)

### The contract

A line's number is its offset, assigned by the server when chunks are assembled, and it's the SSE `id`. So the client's entire resume logic is: remember the highest number you hold, and send it back.

### Reading the stream

```
open ──▶ fetch(stream, Last-Event-ID: cursor)
           │
           ├── event: hello   → record which instance is serving
           ├── event: line    → if n <= cursor, drop it; else cursor = n, buffer it
           ├── event: end     → flush, status = complete, stop
           └── connection drops
                  │
                  ▼
           status = reconnecting, back off 0.5 / 1 / 2 / 4 s, go to open
```

`fetch` with a `ReadableStream`, not `EventSource`. With `EventSource` the browser owns the reconnect: I couldn't show state, set the backoff, or stop on a 404. With `fetch` all of that is mine, and the cookie goes along normally.

Lines already held can't be added twice, because of the `n <= cursor` check. That's the client's half of "exactly the missing lines", and it means the client doesn't have to trust the server on that.

### Rendering

| Problem | Decision |
|---------|----------|
| A million DOM nodes | `@tanstack/react-virtual` with a fixed 20 px row: only what's visible exists |
| A line per millisecond means a render per millisecond | Buffer lines and flush every 150 ms |
| Long lines | No wrapping, horizontal scroll, so row heights stay fixed and virtualization stays cheap |
| Following the tail | "Follow" scrolls to the end on new lines; a checkbox turns it off |
| Log content | Rendered as text, never HTML; a line of `<script>` is just a line |
| Secrets | Masked on the server before they exist as lines, so the client never has a value to leak |

Runner notes and platform notes are styled differently from program output: `[platform] Outcome unknown…` is highlighted, since it's the platform talking, not the job.

Each line shows its number and its step. The number lets people link to and talk about a line; the step shows where it came from without a page of nested groups.

### Making resume visible

```
┌ Logs, attempt 1 [reconnecting] 58 lines · served by api-3010 · 1 reconnect  [Drop connection] ┐
│ Reconnected with Last-Event-ID 58: received 12 lines starting at 59, no gap, no duplicates.   │
│ 58  s2  log line 58 of 120                                                                    │
```

A status chip says live, reconnecting or complete. It shows which instance is serving, and whether the source is PostgreSQL or the archive. A "Drop connection" button aborts the fetch on purpose, so anyone can see the resume work. I wouldn't ship that button to production as is, but a debug affordance like it earns its place in a demo.

### Attempts

Each attempt has its own stream. The selector is a tab list with each attempt's status. The log component is keyed by attempt, so switching unmounts it: the old connection closes, and the new one starts at line 1. By default the page follows the newest attempt, unless the viewer picked an older one.

---

## ⚠️ Dangerous Actions (~4 min)

**Three different confirmations, for three different risks:**

| Action | Risk | UI |
|--------|------|----|
| Re-run a safe job | Low | One click |
| Re-run a non-idempotent job | May repeat a deploy | Dialog listing the steps the server named |
| Resolve `needs_attention` | Records what actually happened | Three explicit choices and a note |

**Confirmation comes from the server.** The re-run button just sends the request. If the server answers `CONFIRM_REQUIRED`, the dialog lists the jobs and steps from that response. The client has no rule of its own, so it can't be wrong about which jobs are unsafe, and a re-run that picks up a new dependent still gets caught.

**The buttons say what they do.** Not "OK / Cancel". The dialog's buttons are "Keep things as they are" and "I understand: run them again". The attention panel's are "It succeeded: continue downstream", "It failed: skip downstream" and "Safe to run again: retry". A person reading only the button should know the consequence.

**Approval shows what's held.** "Deploy to production is waiting to enter production. Its secrets have not been released, and no runner can claim it." A reviewer should understand that nothing has happened yet.

**Secrets are write-only.** The form sends a value and clears the field. The list shows bullets, name, scope, and how often it's been released. There's no reveal button to design, because the API has no field that returns a value.

**Read-only is a first-class view.** Carol sees the same page with no action buttons, and a line saying a maintainer has to decide. If she crafted the request she'd get 403 anyway; the button's absence is courtesy, not security.

---

## 🔧 Deep Dives (~8 min)

### Deep dive 1: The log stream's cursor

**The decision.** The client's cursor is the server-assigned line number, and it's the only thing resume depends on.

**Why it works.** The client stores one integer. On reconnect it sends that integer, to any API instance, and gets everything after it. Because numbers are assigned only by contiguous assembly on the server, a client can never see line 60 before line 59, even when chunks reach the server out of order. And because the number is stable after archival, a stream that reconnects after the log moves to object storage carries on without knowing it moved.

**Why the alternatives fail.** A byte offset breaks when masking changes a line's length, and when multi-byte characters straddle a boundary. A chunk sequence number is a transport detail: chunks vary in size, and a reconnect in the middle of a chunk would resend part of it. A timestamp isn't unique, since many lines land in the same millisecond, so a cursor by time either repeats or skips. Deduplicating by content can't work, since real logs repeat lines constantly.

| Cursor | On reconnect | After masking and archival |
|--------|--------------|----------------------------|
| ✅ Line number | Exactly the missing lines | Same numbers |
| ❌ Byte offset | Mid-line, mid-character | Shifts when text is masked |
| ❌ Chunk sequence | Resends a partial chunk | A transport detail, gone after archival |
| ❌ Timestamp | Duplicates or gaps | Not unique |

**What I'm giving up.** A partial line isn't visible until its newline arrives, because the server masks whole lines. A progress bar that rewrites one line looks frozen until it finishes. I accept that: a line that might contain half a secret must not be shown early.

### Deep dive 2: Polling for state, streaming only logs

**The decision.** Run and job state are polled every 1.5 to 3 s. Logs alone hold a connection, and only on the job page.

**Why it works.** Job state changes every few seconds at most, and a 1.5 s delay on a status chip costs nothing. Polling needs no reconnection logic, no missed-event recovery and no server fan-out, and it always returns the whole truth, so it can't accumulate drift. Logs are different: they arrive many times a second, a person is reading them as they come, and resume matters.

**Why the alternatives fail.** A WebSocket for everything means reconnection, resubscription and replay logic on every screen, and the server has to fan out every state change per viewer. And it still needs a full refresh after a reconnect, which is the poll I've avoided writing. Events on top of state also invite the client to apply diffs, and then it has its own idea of the run, which can drift from the server's. That's exactly the bug class I said I'd remove. Polling logs is also wrong: at 1 s it's laggy for someone watching a build, and offset-based polling at high frequency is more server load than holding a connection.

| Approach | Job state | Logs |
|----------|-----------|------|
| ✅ Poll state, stream logs | Whole truth, simple | Low latency, resumable |
| ❌ WebSocket for everything | Drift, replay logic everywhere | Fine |
| ❌ Poll everything | Fine | Laggy or expensive |

**What I'm giving up.** A poll per open page per person, so a thousand people on a popular run are real load, and a status change can take 1.5 s to appear. At scale I'd add a per-run version, so an unchanged poll is a cheap 304, before considering a push channel. Polling also means the page can't react within a frame to a state change, but nothing here needs that.

### Deep dive 3: Designing "we don't know"

**The decision.** `needs_attention` gets its own color, its own panel at the top of the page, its own DAG node style, and a three-way decision. It isn't a kind of failure.

**Why it works.** The UI is often where a system's honesty is lost. The backend has precise knowledge: this step started, on this runner, and then silence. So the panel says exactly that, names the step and the runner, says "It may have succeeded", and says what happens next: "Nothing downstream moves until you do." The person's next action is written on the screen. A note field records what they checked, so the next person reading the run understands the decision, and the amber state remains visible until someone resolves it.

**Why the alternatives fail.** A red "failed" is the worst: it's familiar, so people act on it without thinking, and a failed deploy means re-run, which causes the double deploy. A yellow warning next to a passing run reads as "fine, but", and gets ignored. A retry button alone offers only the most dangerous option. A modal on page load is dismissed reflexively, then nothing on the page reminds anyone.

| Treatment | What people do | Outcome |
|-----------|----------------|---------|
| ✅ Distinct state, explicit panel, three decisions | Check, then decide | Correct, and recorded |
| ❌ Shown as failed | Click re-run | Possibly two deploys |
| ❌ Warning badge | Ignore it | Downstream assumptions go unchecked |
| ❌ Modal alert | Dismiss it | Forgotten |

**What I'm giving up.** A screen that's visibly louder than anything else, so if the state fires too often it becomes noise. The answer is correct marking in workflows, not a quieter panel. And it's only useful if someone's looking, so the panel isn't enough by itself: this has to page someone, and the repository list carries an "unknown outcome" line too.

---

## ♿ Accessibility (~2 min)

- **Never color alone.** Every status has an icon and a word. The DAG uses dashes and border weight as well as color, and nodes spell out their status.
- **Reserved colors.** Status colors aren't reused for anything else. In the ops chart each repository has a fixed series color, with a legend beside it and a table of the same numbers beneath.
- **Keyboard.** Every DAG node, button and tab is reachable. Dialogs have `aria-modal`. Attempts are a real tab list.
- **Live regions.** The resume note uses `role="status"`. Log lines deliberately don't, since a screen reader announcing every line is useless. The status chip carries what matters.
- **Reduced motion.** The only animation is a spinner on running states.
- **Text as text.** Logs are selectable, copyable and searchable with browser find within the rendered window. Full-log search would be a server endpoint, because the window is virtual. That isn't built.

---

## 📜 Execution Traces (~3 min)

### Successful trace: watching a build

1. A chat link opens `/runs/:id`. The root route checks the session first, then renders.
2. `usePoll` fetches the run: status running, `build` done, two tests running. The DAG lays out three columns.
3. Clicking a test node goes to the job page. `usePoll` starts, and the log component mounts with attempt 1.
4. `useLogStream` fetches with no header. `hello` says api-3010. Lines arrive; the buffer flushes every 150 ms; the virtualizer renders about 25 rows; Follow keeps the end in view.
5. The train goes into a tunnel at line 90. The read throws. The chip says reconnecting, and backoff begins.
6. Out of the tunnel: fetch with `Last-Event-ID: 90`. The load balancer picks api-3011. `hello` says so. Line 91 arrives; the note says "received N lines starting at 91". Nothing repeats.
7. `end` arrives with source `database`. The chip says complete. Later, the log moves to MinIO, and a page refresh reads from line 1 and says "from the MinIO archive".
8. The DAG on the run page shows `package` queued, then running, then success, and the run goes green on the next poll.

### Failed trace: the runner dies during a deploy

1. On-call opens the run: `deploy` waiting. The approval panel says nothing has been released. They approve and the panel goes busy; on the next poll it's gone and the job is running.
2. They open the job. Steps: Prepare passed, Deploy running, with a "non-idempotent" chip. Log lines flow. A lease badge shows "lease held by runner-2, 5.2 s left, token 57".
3. The runner's machine dies. Log lines stop. The stream is healthy, so the chip still says live. That's accurate: the connection is fine and nothing's happened yet. The lease badge counts down.
4. The lease expires. The server closes the stream: a highlighted `[platform] Outcome unknown…` line arrives, then `end`. On the next poll, the page's status chip goes amber, the attention panel appears above everything, and the step reads "outcome unknown".
5. They check the load balancer and type "new version is serving". They click "It succeeded: continue downstream". The button is busy until the response returns. `reload()` runs; the panel disappears, deploy is success, and smoke is queued.
6. The attempt keeps the decision: "Outcome decided by alice: succeeded. 'new version is serving'".
7. A teammate opens it the next morning. The timeline and the note tell them what happened and why.

---

## ✅ Design Review Checklist (~1 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | The server. The UI shows a change only after the response and the next poll; there are no optimistic updates for actions |
| Client retries after losing the response? | Approve and resolve answer "not waiting" on a retry, which the UI treats as "go look at the current state". A re-run retried after success answers `RUN_NOT_FINISHED`. The log stream's retry is the point of the design |
| Worker or server fails between two steps? | A dropped stream resumes from the cursor; a failed poll keeps the last data with an error note; the backend's intent row is why the attention panel has something true to say |
| Which ordering is required? | Log lines by number, which the cursor guarantees. Status doesn't need ordering, because each poll is the whole truth, and a late reply from an old route is discarded |
| Access through caches and async jobs? | Responses are `no-store`. The stream re-checks access every 30 s and can end with `revoked`. A runner's job from another organization appears only as "busy with a job you cannot see" |
| What breaks first, and what evidence? | Memory in the browser, on a very long log: lines are held in an array. Virtualization solves rendering, not memory. On the server, polling at high viewer counts. I haven't measured either at scale; locally a 120-line stream and a seeded page are all I've exercised |

---

## ❓ Follow-ups the Answer Must Handle

**What happens when the same push event arrives twice?**
The server returns the existing run. The UI shows one run, whose header says "received 2×, one run", and the fixture panel's "Send again" button shows the duplicate response.

**How do dependent jobs learn that their prerequisites finished?**
On the server, in the same transaction. The UI never computes this: a blocked node turns queued on the next poll, and a skipped one shows its reason.

**How does a user resume watching logs after a disconnect?**
The client keeps the highest line number it holds and sends it as `Last-Event-ID`. Any instance sends what's after it, and the panel shows the reconnect and what arrived.

**Can an untrusted pull request access deployment secrets?**
No, and it's not the UI's doing: the claim path refuses. The UI reports it, with a banner on the run and a withheld list on each job, so nobody wonders why a variable is empty.

**What happens when a runner disappears after a deployment succeeded?**
The UI says the outcome is unknown, names the step and the runner, holds downstream jobs in view, and asks a person to record what happened, in three explicit choices.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Job state | ✅ Polling | ❌ WebSocket | Whole truth each time, no drift |
| Logs | ✅ SSE with `fetch` | ❌ `EventSource`, polling | Control over reconnect, low latency |
| Cursor | ✅ Line number | ❌ Byte offset, timestamp | Stable through masking and archival |
| Log rendering | ✅ Virtualized, fixed height | ❌ Full DOM, wrapping | A million lines |
| Updates | ✅ Batched at 150 ms | ❌ One render per line | Frame budget |
| Actions | ✅ Wait for the server | ❌ Optimistic | A deploy approval can't be rolled back on screen |
| Status | ✅ Server-derived | ❌ Computed in the client | Can't disagree with the backend |
| Confirmation | ✅ Server names the steps | ❌ Client knows | One rule in one place |
| `needs_attention` | ✅ Its own state and panel | ❌ A kind of failure | A red badge invites the double deploy |
| DAG | ✅ Hand-rolled SVG layers | ❌ Graph library | Small graphs, no dependency, full control of a11y |
| Global state | ✅ Zustand for session only | ❌ A store for everything | Server state doesn't belong in a client store |
| Layout | ✅ Document scrolls, sticky nav | ❌ Inner scroll pane | Browser find, scroll restoration, full-page capture |

---

## 📈 What Breaks First (~1 min)

1. **Browser memory on very long logs.** Virtualization solves rendering. Beyond a few hundred thousand lines, keep a window and fetch older ranges on scroll; the offset API already allows it.
2. **Polling with thousands of viewers on one run.** A per-run version and a 304 first; a shared change feed second.
3. **Huge matrices in the DAG.** Collapse legs into a group node.
4. **Log search.** Browser find only sees the rendered window, so it needs a server-side search over the archive.

---

## 📝 Wrap-up (~1 min)

> "Most of this is about not lying. Status comes from the server. A dropped connection says so and then proves it lost nothing. A button says what it will do. And when the system really doesn't know whether production changed, the screen says that plainly and asks the one person who can find out."

### How the local implementation compares

| Production | Local |
|------------|-------|
| Ephemeral runners behind the API | Local child processes (a substitution, not a security boundary), invisible to the UI |
| Real Git host | A fixture panel that sends real signed webhooks, for a demo from the browser |
| Lease of minutes | 6 s, so the countdown and the attention panel appear quickly |
| Paging on `needs_attention` | The panel, and a line in the repository list |

React 19, Vite, TanStack Router and Virtual, Zustand, Tailwind. Verified against the live stack with screenshots of each state and generated smoke tests.
