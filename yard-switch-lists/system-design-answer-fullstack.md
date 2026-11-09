# Yard Switch Lists — System Design Answer (Full-Stack Focus)

*Full-stack engineer interview · 45 minutes · Requirements → Architecture → Plan lifecycle → Board → Handheld → Replanning → Overrides → Execution → Traces → Follow-ups*

> "The prompt: a classification yard receives inbound trains, sorts their cars into blocks on classification tracks, and builds outbound trains. Design the service that produces each shift's switch list, and replans it when trains run late. BNSF publicly describes generating optimized switch lists with AI at its Alliance yard, though as far as I know this isn't a reported interview question, so I'm treating it as practice. The tempting mistake is to spend the round on the optimizer. The product is what happens after the first list: a train slips with crews mid-move, a yardmaster disagrees, a hold lands, a crew reports something the plan didn't expect. For a full-stack answer I care about the seam: what does a yardmaster see when the planner's answer changes, what happens to their edit when someone else got there first, and how does a phone with no signal stay correct. Three ideas run from database to screen. Plans and facts are separate, and crews' reports write the facts. Any plan, machine or human, goes through one validator. And a replan pays for every change, then says plainly what it cost."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~4 min | Hard vs soft constraints; two users with very different devices |
| Architecture | ~6 min | Solve as a durable job; immutable versions; state version |
| Planner | ~3 min | Decoder plus search. Deliberately short |
| The seam: board and handheld | ~8 min | How versions, locks and offline reports reach the UI |
| Deep dives | ~14 min | Replanning you can read; overrides end to end; execution and holds |
| Traces, follow-ups, trade-offs | ~10 min | One success, one failure, the follow-ups, the repair variant |

---

## 🎯 Requirements (~4 min)

### Who uses this

| User | Device | What they need |
|------|--------|----------------|
| Yardmaster | Desktop board | See the yard as crews report it, the ordered list, what changed and why. Drag, lock, publish |
| Crew | Phone-width handheld, patchy signal | The next few moves, big buttons, works offline, can't be fooled by a stale list |
| Railcar Health (#19) | Event stream | Holds that must stick, whenever they land |

### Functional requirements

1. Produce a switch list as a durable, time-limited solve, and check every plan with an independent validator.
2. Version plans immutably, publish with optimistic concurrency, and show a diff.
3. Replan on a late train, a hold, a blocked track or a crew exception, and report consequences in plain words.
4. Let a yardmaster reorder, retarget and lock, by drag or keyboard, with reasons recorded.
5. Consume holds and enforce them at planning, publish, crew start and departure.
6. Take crew reports, including from an offline queue. Yard state follows the reports.
7. Compare the planner with a yardmaster, honestly.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Published list availability | 99.99% | Planner down must not mean no list |
| Replan latency | < 60 s fact to draft | Coalescing and a hard solve budget |
| Board freshness | ~2 s | Polling is enough; no need for a socket |
| Hold enforcement | Zero held cars departing | Rechecks everywhere a hold could slip through |
| Crew report durability | No accepted report lost, retries harmless | Client-generated ids; a persistent outbox |
| Accessibility | Every drag has a keyboard path | Alt+arrows, L to lock |

### Capacity estimate

About 25 yards, about 1,500 moves per list, a few crew reports a second system-wide at peak, a replan every few minutes per yard. One PostgreSQL holds the writes. Yards share nothing, so it partitions cleanly. Fleet context from BNSF's 10-K: about 70,700 owned or leased cars. The rest are my assumptions.

---

## 🏗️ Architecture (~6 min)

```
 ┌─────────────────┐     ┌──────────────────┐     ┌───────────────┐
 │ Yardmaster board│     │  Crew handheld   │     │ Railcar Health│
 │ React, polling  │     │  phone, outbox   │     │ hold events   │
 └────────┬────────┘     └────────┬─────────┘     └───────┬───────┘
          │ REST                  │ REST (batch on sync)  │ Kafka
          ▼                       ▼                       ▼
 ┌────────────────────────────────────────┐     ┌──────────────────┐
 │      API (stateless, sessions in Valkey)│    │  Hold consumer   │
 └────────────────────┬───────────────────┘     └────────┬─────────┘
                      ▼                                  ▼
 ┌────────────────────────────────────────────────────────────────┐
 │  PostgreSQL per yard: state_version, cars, tracks, plan        │
 │  versions, moves, executions, reports, locks, overrides, holds │
 └───────────────┬───────────────────────────────▲────────────────┘
                 │ replan triggers               │ one final commit
                 ▼                               │
          ┌──────────────┐  job   ┌──────────────┴──┐    ┌────────────────┐
          │  Coalescer   │───────▶│ Planner workers │───▶│  Independent   │
          └──────────────┘        └─────────────────┘    │  validator     │
                                                         └────────────────┘
```

**Why the planner is its own process.** A search is CPU-bound for its whole budget. In the API it would stall every request, and in a single-threaded runtime it would stall its own heartbeat too. So it runs in workers and yields every few milliseconds.

**A solve is a durable job.** A row with a status, a time limit and a lease on the database clock. It has no side effects until one transaction at the end, fenced by the lease token. A dead worker leaves a lease to expire and nothing to clean up.

**The state version counts surprises.** A late train, a hold, a mismatch report: each bumps `state_version`. A move completed as planned doesn't. Otherwise, with crews working, no draft could ever be current by the time someone clicked Publish.

### Data model

| Table | Key columns | Notes |
|-------|-------------|-------|
| yard_state | state_version, head_version_id, working_version_id | The serialization point for one yard |
| cars | position, track_id, coupled_to, position_as_of | Actual state. Only reports write it |
| switch_lists | version_no, status, parent_id, author, reason, based_on_state_version, conflicts, consequences, stability | Immutable; only status moves forward |
| moves | list_id, seq, key, car_ids, from/to track, planned times | A trigger refuses edits. Keys are stable across versions |
| move_executions | key, status, started_at, completed_at, move | What really happened, surviving new versions |
| crew_reports | client_report_id (PK), occurred_at, offline, response | Idempotency ledger |
| locks | kind, move_key, before_key, car_id, track_id, active | Input to every solve |
| overrides | actor, reason, reason_code, before, after, violations, refused | Includes refused attempts |
| solve_jobs | status, time_limit_ms, state_version, snapshot, lease_token | Stores its input |
| car_holds, hold_events | stream_version; event_id | Fold plus dedupe |

### API

```
GET  /api/v1/yard/board               Everything the board shows, in one snapshot
GET  /api/v1/plans/:id/diff           Kept, changed, reordered, added, removed, with why
POST /api/v1/plans/:id/publish        409 STALE_STATE, HEAD_MOVED, LOCK_CONFLICT
POST /api/v1/plans/:id/edits          Names expectedVersionNo; 409 VERSION_CONFLICT;
                                      422 NEEDS_OVERRIDE or EDIT_REFUSED
POST /api/v1/locks                    Lock a move, or a car to a track
POST /api/v1/locks/:id/release        With a reason
GET  /api/v1/crew/moves               The published list only
POST /api/v1/crew/reports             Idempotent on clientReportId; 409 if a hold refuses it
POST /api/v1/crew/reports/batch       An offline queue flushing
GET  /api/v1/holds                    Holds and the feed
```

> "The error codes are the contract between the two halves. NEEDS_OVERRIDE opens a dialog with an override button. EDIT_REFUSED opens the same dialog without one. VERSION_CONFLICT closes it and shows who won. If those were all a generic 409 or 422, the frontend would be parsing English."

---

## 🧮 The Planner, Briefly (~3 min)

A candidate is a small set of decisions: which train each group of cars rides, which track each cut prefers, and the order crews work. A decoder turns that into a timed, feasible move list: a discrete-event scheduler where a car that can't legally go spills to the next train or is left unassigned and paid for. The search never sees an infeasible plan, and the time limit always has a complete plan to return.

The objective makes a missed train cost 500, a car with no train 100, a car-hour of dwell 1, a move 3, and on a replan each changed move 40.

| Measured on this build | Greedy | Local search | Exact |
|------------------------|--------|--------------|-------|
| 14 tight small instances | Often far above optimum, because it misses trains | Equal to the proven optimum on all 14 | Proven in 0.1-4 s |
| Full shift (~70 moves) | About 2.7× local search's cost | About 2,500-3,000 at 100 ms; about 1,830 from 500 ms on | Times out; best so far, no proof |

"Exact" means proven best over the decoder's decisions, not over every conceivable schedule. I can't bound a full shift. In production I'd add CP-SAT as a second candidate, keep this as the fallback, and let the validator refuse anything invalid from either.

---

## 🖥️ The Seam: Board and Handheld (~8 min)

### The yardmaster board

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Sandhills board · 09:40Z · state v20 · Plan v9 [draft]    Diff  Publish │
├─────────────────────────────────────────────────────────────────────────┤
│ ⚠ M-DENBAR misses its 11:30Z departure: 12 of 18 cars ...               │
│ ⚠ Lock conflict: I23-01 is locked to C8, which is blocked  [Release]    │
├────────────────────────────────┬────────────────────────────────────────┤
│ Receiving                      │ Switch list · 70 moves                 │
│  R1 ▓▓▓▓░░░░ 1,400/4,200 ft    │ ⠿ 12 09:42 KCK: 5 cars R1 → C1 🔒      │
│ Classification                 │ ⠿ 13 09:51 GAL: 3 cars R1 → C2         │
│  C1 ▓▓▓░░░░░ 450/1,800 KCK 7   │ ⠿ 14 09:58 CHI for M-CHIGAL: ...       │
│  C8 ▨▨▨▨▨▨▨▨ blocked           │                                        │
│ Departure                      ├────────────────────────────────────────┤
│  D1 ▓▓░░░░░░ 800/6,000         │ Locks · Inbound trains                 │
├────────────────────────────────┤                                        │
│ Outbound: train, departs, cars │                                        │
└────────────────────────────────┴────────────────────────────────────────┘
```

**One snapshot, polled.** The board reads one endpoint every two seconds, in one read-only transaction, so tracks, moves and alerts can't disagree with each other. A socket would be more machinery for no benefit at this freshness.

**Lanes show what crews reported.** Occupancy comes from `cars`, never from the plan. Each car is a segment sized by its length and colored by block. A held car is marked H and a placarded car is marked !, and the block name is printed on the lane, so identity is never color alone. A blocked track is hatched and labelled.

**The moves show a working version.** That might be a draft nobody has published yet. The header always says which version this is, whether it's published, who made it and why. A separate banner says "crews are still working from v8" when a draft is showing.

**Drag.** Pointer events rather than HTML5 drag-and-drop, so one code path handles mouse, touch and pen. While dragging, the list shows an insertion line, and hovering a track lane highlights it, for a retarget. On drop, a dialog asks for a reason. Dropping above work that's already started clamps to the first editable position.

> "I chose pointer events over the HTML5 API because the browser's drag model gives you almost no control over the preview, doesn't work on touch, and is painful to test. It costs about 80 lines I own, but the insertion geometry is a pure function I can unit test. The keyboard path isn't optional: Alt+arrows moves a focused row, L locks it, and both reach the same edit call with the same dialog."

**The dialog handles the validator's three answers.**

| Server says | What the yardmaster sees |
|-------------|--------------------------|
| 201 | Draft saved; Publish appears |
| 422 NEEDS_OVERRIDE | The rule that's broken, and "Override and record" |
| 422 EDIT_REFUSED | The rule, marked safety or can't-be-done, with no way to confirm |
| 409 VERSION_CONFLICT | Dialog closes. "Carol changed the plan first (now v12). Your edit wasn't applied." Load the latest |

### The plan diff

Moves changed, added, removed and reordered come first, each with a sentence saying why, from the triggers the solve absorbed: "B4737 slipped 180 min: these cars come in on it", or "Knock-on: resequenced around the moves that had to change". Moves left alone are one checkbox away, and their count is a stat tile, because "what was left alone" is half the answer a yardmaster wants. A stability sentence compares this replan with a from-scratch one.

### The crew handheld

Phone width, one column, big buttons. It shows the next six moves from the published list only, so a draft never reaches a cab. Each card has one primary action: Start, Complete, or a disabled "Not ready yet".

**The outbox.** Every tap creates a report with a client-generated id and an event time from the yard clock. Online, it posts straight away. Offline, it goes into a persistent queue in browser storage, and the card updates locally so the crew can keep working. On reconnect the queue flushes as one batch, and each report stands alone, so one bad report doesn't sink the others.

> "Storage in a browser can fail: private mode, a full disk, a blocked site. So every read and write is guarded and it falls back to memory. The cost is that a reload during that failure loses the queue, which I'd rather accept than crash. On a managed device I'd use a real native store."

**A refused start.** Online, the server reads the holds table and refuses a start on a held car with a message the card shows as a stop: "Stop: I21-05 on hold. Don't move this cut." That's the one thing a stale screen can't get wrong, because the check is on the server at the moment of the tap.

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: Replanning a person can read

> "We chose to penalize changes and freeze work in progress, over re-solving from scratch, because the real cost of a plan change is a crew that was told one thing and now hears another. A from-scratch solve treats a three-hour slip as a new problem and will reshuffle the far side of the shift for a tiny objective gain. On the seeded slip it disturbs 39 moves, against 26 for the stable replan. It fails specifically because nothing in its objective says the old plan had value. The cost is that I give up some optimality on purpose, and I own a weight that needs tuning. In a yard, a plan that keeps changing stops being trusted, and an untrusted optimal plan is worth nothing."

Three tiers of "may not touch": moves done or in progress are facts, carried verbatim. Pending moves due within 30 minutes stay, because crews have been told, unless a new fact makes them impossible, and then they're reported by name. Locked moves stay whatever the cost, or surface as a conflict. Everything else starts from the old plan and pays 40 per change.

**Bursts.** Triggers are rows written with the fact. They fire one solve when they go quiet for about a second, or after five seconds at most, and only if no solve is running. Six triggers made one solve in the e2e. On the board that reads as one banner rather than a flickering list.

**When it stops for a person.** A new missed departure, a lock conflict or a validator failure stops; the plan waits as a draft with a banner, and crews stay on the old list. Routine replans publish themselves. Otherwise the yardmaster is a rubber stamp and crews sit on stale lists.

**What a consequence looks like.** Not a score. A sentence, on the board and the diff: "M-DENBAR misses its 11:30Z departure: fewer than its minimum of 18 cars can be coupled in time; its cars could be ready about 68 min after departure (24 cars were planned on it)". The yardmaster's next action, Hold, is right there on that train's row.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Stable replan, frozen and horizon | Crews keep instructions; changes can be explained | Slightly worse objective; a weight to tune |
| ❌ Solve from scratch | Simple; best objective | Reshuffles everything |
| ❌ Patch only affected cars | Very stable | Misses knock-on fixes |

### Deep dive 2: An override, end to end

> "We chose locks that are inputs to every solve, and a validator that decides what's allowed, over letting a person's edit simply replace the plan. If an edit just wins, the next replan overrules it and the yardmaster stops trusting the board. If the planner can silently drop a lock it can't honour, it's worse: the yardmaster believes something that isn't true. So a lock is respected or it's a visible conflict, with nothing in between. The cost is one more concept for yardmasters, and locks to clean up when a situation passes."

Follow one drag through the stack.

```
drag row ──▶ dialog: why? ──▶ POST edits {expectedVersionNo: 7, ops, reason}
                                   │
                          row lock on yard_state
                                   │
             version still 7? ──no──▶ 409 VERSION_CONFLICT, recorded, banner
                                   │ yes
                 retime the list with the validator's clock
                                   │
                        validator on the new list
                 ┌─────────────────┼──────────────────┐
           safety or physical   operating only      clean
                 │                 │                  │
          422 EDIT_REFUSED   422 NEEDS_OVERRIDE       │
             recorded       (or overrideSoft: change  │
                             the fact, bump state)    │
                                   └────────┬─────────┘
                                            ▼
                new draft + sequence lock + overrides row
```

**Retiming.** Moving a row changes when things happen. The validator already derives a timeline, so an edit re-times with it, and the dragged move loses its not-before time, so dragging it earlier really makes it earlier. The response carries the new times and readiness, so the train table updates without another round trip.

**Soft vs safety.** Standing order, departure time and train length are operating rules. An override changes the fact both planner and validator read: a departure revision, a track added to the standing order for this shift. Holds, hazmat placement and tonnage are never overridable, and the dialog has no button for them.

> "I didn't build an exception list. It would have to be stored, matched, carried across versions and expired, and each of those is a bug. Changing the fact loses some nuance, but it's what a yardmaster means. On-time metrics still count from the original scheduled departure, so a held train still counts as late."

**A lock that can't be honoured.** Carol locks a car to a track that's then blocked. The next solve plans around it, and a check compares the result with every active lock. The draft carries a conflict, the banner shows it with a Release button, publish refuses with LOCK_CONFLICT, and the lock stays active until she acts.

**Two yardmasters.** The edit names the version it was looking at. Fired at once through two API instances, one gets 201 and the other 409 naming who won, and the attempt is on record. The UI doesn't try to merge. It reloads and asks the person to redo it on the new list, because the right merge of two yardmasters' intentions isn't something I should guess.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Reject the second edit, name the winner | No lost updates; simple; honest | The loser redoes their edit |
| ❌ Last write wins | Nobody sees an error | Silently loses a decision |
| ❌ Auto-merge | Fewer conflicts | Two orderings can't always merge safely |

### Deep dive 3: Reports as truth, and holds

> "We chose to make crew reports the only writer of car position, over advancing state from the plan as time passes. Advancing from the plan gives a board that always looks right and is wrong the moment a crew improvises, and then every later plan is built on fiction. Reports are messy: late, twice, out of order. So the cost is idempotency and event-time ordering in the write path, an outbox on the client, and a board that lags by a report. A lag is honest. A confident wrong answer isn't."

**Same id, same answer.** The phone generates the id at the tap. A retry collides on the primary key and gets the stored response, including a refusal.

**Out of order.** Each car has an event-time watermark. A crew humps a cut and pulls it while offline, and the pull syncs first: the car lands on the departure track, then the older report is recorded and doesn't move it. The e2e syncs a queue in scrambled order and finds the same final state as in-order delivery, then syncs it again and finds it changes nothing.

**Mismatches update state, then the plan follows.** Car not where expected: position unknown, and it leaves the plan until found. Moved different cars: the reported cars move, and the frozen move shows what really happened. Track blocked: the track closes. Each one replans. On the board the lane changes on the next poll, because it reads the same rows.

**Holds, wherever they land.** Events arrive in #19's envelope. Deduped by event id and folded by stream version per hold, so a release delivered before its hold still ends released.

| When it lands | What stops it |
|---------------|---------------|
| Before planning | Not planned |
| After planning | Validator refuses at publish |
| After publish | Crew's Start is refused on the server, with a stop on the card |
| After coupling | Alert, a set-out in the next plan, and the train can't depart until it's off |
| Reported offline | Accepted as a fact, with an alert. Refusing it wouldn't uncouple anything |

---

## 📜 Execution Traces (~3 min)

### Successful trace: a train slips three hours

1. Dispatch sends a new ETA. One transaction: ETA, state version, log row, trigger.
2. After a quiet second, the coalescer inserts one solve job.
3. A worker claims it, reads one snapshot, stores it on the job.
4. Nine moves are frozen; the horizon is pinned except what depended on that train; the rest start from the old plan at 40 per change.
5. Local search runs for its budget. It disturbs 26 moves. A from-scratch solve disturbs 39.
6. The validator passes it. One outbound train fell below its minimum, so review is required.
7. One transaction, fenced by the lease: version, moves, job finished, alert. No publish.
8. On its next two-second poll, the board shows the banner and the draft. Crews still see the old list.
9. The yardmaster opens the diff, reads what changed and what didn't, and publishes. Crews see the new version on their next poll.

### Failed trace: a hold during a dead worker

1. A worker is mid-solve. A hold arrives; the consumer commits it and bumps the state.
2. The worker is killed with SIGKILL. No version exists; the job's lease is ticking.
3. A crew on the old list taps Start on the pull carrying that car. The server checks holds and refuses. The card shows a stop. The refusal is stored against the client id, so a retry gets the same answer.
4. The board shows the alert. Crews keep working the rest of the published list.
5. The lease expires on the database clock. A new worker reclaims, attempt 2, reads a fresh snapshot, and plans without the car.
6. The plan passes validation and publishes. The held car never reached a train.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | PostgreSQL. A report succeeds at commit. The client's outbox removes it only after that. A plan exists at its one final commit |
| Client retries after losing the response? | Reports on client id, holds on event id, edits on version number. Each returns the original answer or a clear conflict |
| Worker fails between steps? | No side effects until one commit. The lease expires; another worker starts over. Verified with SIGKILL |
| Ordering actually required? | Per car by event time; per hold by stream version; per yard for publish |
| Access through caches, indexes and jobs? | No board cache. Crews read only the published version. Jobs run as the system; roles are checked where they're queued. The simulator's control port is proxied through a role check |
| What breaks first? | The per-yard row lock during report bursts, then planner CPU, then plan storage |

---

## 🧩 Follow-ups I'd Expect (~3 min)

**A train arrives three hours late. What changes, and what's left alone?**

> "Left alone: everything done or in progress, verbatim; everything in the 30-minute horizon unless it depended on that train, and then I say so by name; and most of the rest, because each change costs 40. Changed: that train's cuts and the pulls that needed them, plus whatever has to move to make room. Cars that can't make their train roll to the next. If a train falls below its minimum it's annulled, and that's a banner naming the train before anything publishes, with Hold right there as a recorded override. Seeded run: 26 moves disturbed, against 39 from scratch."

**The yardmaster disagrees. How do overrides work?**

> "Drag or lock, by mouse or keyboard. The validator checks it the same way it checks the planner. Safety and physical violations are refused, and the dialog has no confirm button. Operating rules can be overridden with a reason, which changes the fact the rule reads. A drag pins a sequence lock so the next replan keeps it. An impossible lock shows as a conflict and blocks publish until resolved. Two yardmasters get a version conflict naming who won. Everything records who, why, before and after."

**How do you measure whether the planner beats the yardmaster?**

> "Per shift from raw rows, and a replay of the same seeded shift under planner only, planner plus a scripted yardmaster, and a baseline. Four seeds here gave 75%, 79% and 57% on time. Beating the baseline is probably real, and I wouldn't lean on the rest. The yardmaster is a script, and its radio tip is information I gave it. People override when a plan already looks wrong, so overridden shifts are harder shifts. A simulator only rewards what it models. And with 28 departures, the 75-to-79 gap is one train. The results page says all this next to the numbers, because a table without that caveat misleads. The real answer is a shadow run, then randomizing which shifts see the planner's list."

### The variant: inspection and repair scheduling

Cars arrive with risk levels from #19, required work and departure times, against limited crews, bays and parts. The architecture carries over.

**Two coordinators assign the same bay.** Version conflict on the schedule, plus a unique constraint on bay and time slot, so a double-booking is impossible at commit. The loser's banner names who took it.

**A part the plan assumes is in stock isn't.** Stock is like car position: the plan's number is a prediction, and the count is the fact. A low count replans, and reservations say which work items lost the part. A safety-critical repair can't be deferred by the planner.

**Planner down, then reconciling.** The last published schedule stays usable, and people keep recording what they do with client ids. When the planner returns, those are facts. A hand assignment during the outage arrives as a report plus an override, so it's locked. Two local decisions on one bay are shown side by side for a person to settle.

---

## 🚨 Failure Handling (~1 min)

| Failure | Server | Screen |
|---------|--------|--------|
| Planner down | Triggers queue; published list stands | "Planner working" never clears; crews unaffected |
| Plan fails validation | Draft only; critical alert | Banner; Publish disabled |
| Stale publish | 409, recompute queued | Banner, then a fresh draft appears |
| Handheld offline | Nothing arrives | Outbox count; cards update locally; sync on return |
| Simulator or API down | 503 or network error | A plain message; last data stays on screen |
| Browser storage refused | Not applicable | In-memory queue; a reload could lose it |

---

## 📈 What Breaks First (~1 min)

1. **The per-yard row lock during report bursts.** It's what makes publish simple. The fix is to stop taking it for as-planned reports, which don't touch what publish checks.
2. **Planner CPU.** One solve per yard, so add workers and shrink budgets under load.
3. **Plan storage.** Store moves by content hash, since most don't change between versions.
4. **The board's poll.** One heavy read per open board every two seconds. At dozens of viewers per yard, cache it for a second by state version.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Plan check | Independent validator | Trust the planner | Found real decoder bugs; one path for people and machines |
| Concurrency token | State version counting surprises | Version every write | Plans can publish while crews work |
| Replan | Stable, frozen, horizon | From scratch | 26 vs 39 moves disturbed |
| Soft override | Change the fact | Exception list | Nothing to expire |
| Second edit | Reject and name the winner | Merge | Don't guess intent |
| Board updates | 2 s poll of one snapshot | WebSocket | Fresh enough; consistent; simpler |
| Drag | Pointer events | HTML5 DnD | Touch, testable, full control |
| Crew offline | Client ids, outbox, event-time watermark | Online only | Yards have dead spots |
| Auto-publish | Only without consequences | Approve everything | Not a rubber stamp |
| Search | Decoder + annealing | Solver first | Any-time; no bound at full scale |

---

## 📝 Wrap-up (~1 min)

> "So the seam is the answer. Plans and facts are separate, so the board shows what crews reported, next to what the plan intends. Versions are immutable with stable keys, so a diff can say what changed, what didn't, and why, in sentences. A validator with no planner code in it answers every edit in one of three ways, and each way has its own screen. A phone with no signal keeps working, because every report carries its own id and its own time. And the optimizer is the part I'd improve last, because a better plan that crews don't trust isn't better."

### How the local implementation compares

| Production | Here |
|------------|------|
| Kafka `cases` topic | Valkey stream plus a webhook, same envelope as `railcar-health/events.md` |
| Dispatch and yard systems | A seeded simulator through the same API |
| Real yard geometry | A track is a capacity in feet; one block per class track |
| Real hazmat rules | Simplified from position-in-train rules (in the US, 49 CFR Part 174), and labelled as simplified. Not the regulation |
| Managed handhelds | A browser page with a simulated offline toggle |
| Many yards | One yard |
| Inspection and repair variant | Designed, not built |
