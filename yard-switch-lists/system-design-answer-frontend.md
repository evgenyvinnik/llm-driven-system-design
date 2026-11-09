# Yard Switch Lists — System Design Answer (Frontend Focus)

*Frontend engineer interview · 45 minutes · Requirements → Screens → State → Board → Drag → Plan versions → Handheld and offline → Traces → Follow-ups*

> "The prompt: a classification yard sorts inbound trains into blocks and builds outbound trains, and a service produces each shift's switch list, the ordered moves, and replans it when trains run late. BNSF publicly describes generating optimized switch lists with AI at its Alliance yard, though as far as I know this isn't a reported interview question, so I'm treating it as practice. I'll assume the planner exists behind an API, and that the trap is the same on the frontend: a pretty optimizer dashboard that ignores replanning, overrides and execution. So the design question is really about trust. A yardmaster has to believe the board, and crews have to believe their phone, while the plan changes under them. Three ideas carry it. Show facts and plans separately, and never let one pretend to be the other. Every plan change has to explain itself, including what it left alone. And the phone must stay correct with no signal, because a yard has dead spots and the crew won't stop working."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~4 min | Two users, two devices, very different failure modes |
| Screens and state | ~8 min | Server state vs local state; polling; one snapshot |
| Board and drag | ~12 min | Lanes, list, pointer drag, keyboard path, the validator's answers |
| Plan versions and diff | ~6 min | What changed, what didn't, why |
| Handheld and offline | ~8 min | Outbox, client ids, refused starts |
| Traces, follow-ups, trade-offs | ~7 min | One success, one failure, the follow-ups |

---

## 🎯 Requirements (~4 min)

### Clarifying questions

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| How many moves on a list? | Rendering strategy | 70 locally, ~1,500 at a large yard |
| How fresh must the board be? | Polling vs push | Seconds, not milliseconds |
| Who edits? | Concurrency UX | Two or three yardmasters may be on at once |
| What device do crews use? | Layout, offline | Phone-width handheld, gloves, patchy signal |
| Does a crew ever see a draft? | Data access | No, only the published list |
| Is drag required? | Accessibility | Yes, and it needs a keyboard alternative |

### Functional requirements

1. Yardmaster board: tracks as lanes with cars and occupancy in feet, the ordered list with drag and locks, plan version and diff, validator and conflict banners, outbound train readiness.
2. Crew handheld: next moves, start, complete, report a problem, all working offline.
3. Plan versions and a diff with reasons.
4. Plan comparison page (heuristic vs local search vs exact), metrics page, holds and events page, simulator control panel.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Board freshness | ~2 s | Polling is enough |
| No lost report | Survives reload, dead zone | Persistent outbox with client ids |
| Honest state | Never show a plan as a fact | Separate read models; labels |
| Keyboard parity | Every drag has a key path | Alt+arrows, L to lock |
| Phone use | Large targets, one column | Handheld is its own route, not a shrunken board |
| Color-blind safe | Identity not color alone | Block names on lanes; H and ! marks; validated palette |
| Page weight | Under ~120 KB gzipped | No grid library or chart library for this |

---

## 🗺️ Screens (~3 min)

```
 /board      Yardmaster: lanes, list, banners, readiness, locks
 /plans      Every version this shift, and every override
 /plans/:id  One version: what changed, what didn't, why, what it costs
 /crew       Handheld: next moves, offline outbox
 /holds      Holds, the event feed with outcomes, alerts
 /compare    Heuristic vs local search vs exact
 /metrics    Per shift, plus the seeded replay, with its limits stated
 /simulator  Clock and scenario controls, so the story can be demoed from a browser
```

Routing is TanStack Router, file-based. Redirects by role live in one effect in the root, not in `<Navigate>` during render, so a signed-out render can't loop. A crew member lands on `/crew` and can't reach anything else.

### The layout of the board

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Sticky nav                                                              │
├─────────────────────────────────────────────────────────────────────────┤
│ Sandhills board · 09:40Z · state v20 · Plan v9 [draft] by planner       │
│                                         Diff  Replan  Discard  Publish  │
├─────────────────────────────────────────────────────────────────────────┤
│ ⚠ M-DENBAR misses its 11:30Z departure: fewer than its minimum ...      │
│ ⚠ Lock conflict: I23-01 is locked to C8, which is blocked  [Release]    │
│ ⚠ Hold placed on I22-20 after it was coupled to M-GALKCK    [Ack]       │
├──────────────────────────────┬──────────────────────────────────────────┤
│ RECEIVING                    │ SWITCH LIST · 70 moves       □ Hide done │
│ R1 1,400/4,200 ft  GAL 5 ... │ ⠿ 12 09:42 Classify KCK: 5 cars R1→C1 🔒 │
│ ▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░  │ ⠿ 13 09:51 Classify GAL: 3 cars R1→C2    │
│ CLASSIFICATION               │ ⠿ 14 09:58 Assemble CHI for M-CHIGAL ... │
│ C1 450/1,800 ft  KCK 7       │ ...                                      │
│ ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░  │                                          │
│ C8 blocked ▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨  ├──────────────────────┬───────────────────┤
│ DEPARTURE                    │ LOCKS                │ INBOUND TRAINS    │
│ D1 800/6,000 ft              │ KCK cut stays · alice│ I23 ETA 09:20 +180│
├──────────────────────────────┤                      │                   │
│ OUTBOUND: train, departs,    │                      │                   │
│ cars/min, slack, status, Hold│                      │                   │
└──────────────────────────────┴──────────────────────┴───────────────────┘
```

> "Banners sit above everything, because the first job of this page is telling you what needs a person. Nothing that needs a decision should be findable only by scrolling. The document scrolls rather than an inner pane, so the browser's own find, and full-page capture, work."

---

## 🧠 State Management (~5 min)

| State | Lives in | Why |
|-------|----------|-----|
| The board (tracks, moves, alerts, versions) | A polling hook; replaced whole | One snapshot, so nothing can disagree |
| Who I am | Zustand auth store | Global, rarely changes |
| Drag position, open dialog, notices | Component state | Local to the interaction |
| Crew outbox | Browser storage, with an in-memory fallback | Must survive a reload |
| Hide-done, crew filter | Component state | Not worth persisting |

**One snapshot, replaced whole.** The board reads one endpoint every two seconds, served by one read-only transaction. Tracks, moves, versions and alerts can't disagree with each other, because they come from one commit. I replace the whole object rather than merging.

> "We chose polling one snapshot over a WebSocket with deltas, because this page's job is correctness rather than latency. A delta stream has to handle gaps, reconnects and ordering, and a missed delta gives a yardmaster a board that's quietly wrong. That's the worst failure this page can have. With polling, a missed response is just a slightly older picture, and the clock on the header shows it. Polling costs a request per viewer every two seconds, and up to two seconds of staleness. I could cache that read for a second by state version if viewers grew, and if I ever need faster, I'd add a push that only says 'refetch now', keeping the same read path."

**Interaction beats polling.** While a drag or dialog is open, a poll can replace `moves` underneath it. The drag holds on to its row index and re-reads the list at drop, and the edit is checked on the server against the version it was looking at. If the plan moved, the answer is a version conflict, not a corrupted list.

**No client-side validation of rules.** It would be a second validator, and the second one would be wrong. The server has a preview endpoint for "what would this do?" The client only does geometry.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Poll one snapshot | Consistent; simple; no gap handling | 2 s stale; a request per viewer |
| ❌ WebSocket deltas | Instant | Gaps and ordering; a quietly wrong board |
| ❌ TanStack Query per widget | Caching, dedupe | Widgets from different moments can disagree |

---

## 🛤️ The Board (~4 min)

### Lanes

Each track is a lane: its id, feet used over capacity, the blocks on it in words, and a bar of cars. Each car segment's width is its length over the track's capacity, so a full track is visibly full and a 89-foot car looks longer than a 50-foot one. Colors come from a validated categorical palette in fixed order, so a block is the same color on every screen and never gets repainted when a filter changes.

```
C1  450 / 1,800 ft                                KCK 7
┌──┬──┬──┬──┬──┬──┬──┬───────────────────────────────┐
│  │  │ !│  │ H│  │  │                               │
└──┴──┴──┴──┴──┴──┴──┴───────────────────────────────┘
```

Identity is never color alone: the block names are printed on the lane, every segment has a title, a held car is marked H with an outline, and a placarded car is marked !. A blocked track gets diagonal hatching and a "blocked" chip, which also survives forced-colors mode.

**Occupancy is what crews reported.** Those lanes come from where cars actually are, not from the plan. When a crew reports a car that isn't where it should be, the car disappears from the lane on the next poll, and the plan catches up seconds later. I say so right under the lanes, because a yardmaster who thinks that's the plan will misread a mismatch as a bug.

### Banners

In order: the notice from your own last action, lock conflicts, missed departures, validator findings, planner activity, stale-plan warnings, alerts. Conflicts have their action on the banner. A rose banner means a person has to act; amber means pay attention; sky is information. Each carries an icon and text, so no one reads color alone.

### Readiness table

Train, departure, cars over minimum, feet, slack in minutes, status chip, and a Hold action. "Misses departure" is a chip in words. A held train shows its revised time and keeps its scheduled time in the tooltip, because on-time still counts from the schedule.

---

## ✋ Drag, and Its Keyboard Twin (~8 min)

### Deep dive 1: Reorder with drag, and the validator's three answers

> "We chose pointer events and a hand-written drag over the HTML5 drag-and-drop API and over a library such as dnd-kit. HTML5 DnD doesn't work on touch, gives almost no control over the preview, and is painful to test. A library would work, but this page needs something unusual: one gesture with two kinds of target, a position in the list to reorder and a track lane to retarget. With `elementFromPoint` on `pointermove`, both come from the same code in about 80 lines, and the insertion geometry is a pure function I can unit test. The cost is that I own that code and its edge cases, such as Escape to cancel and clamping above started moves, and I don't get a library's automatic keyboard sensors. So the keyboard path is something I had to build on purpose."

**The gesture.**

```
pointerdown on grip ──▶ set drag {from, to}; listen on window
pointermove         ──▶ pointer over a lane?  highlight the lane
                        otherwise             compute insertion index from row rects
                                              clamp above started moves; show a line
Escape              ──▶ cancel
pointerup           ──▶ over a lane: open "Send this move to C5"
                        index changed: open "Move this to position 12"
                        otherwise: nothing
```

Listeners go on `window`, so a drag survives leaving the row. A move can't be dragged once started, because the grip is disabled, and nothing can land above started work, because the insertion index clamps to the first editable row.

**The keyboard path.** Each editable row is focusable. Alt+Up and Alt+Down reorder, L locks or unlocks, and small arrow buttons exist for people who'd rather click. All three end in the same dialog and the same call. A screen reader gets "12. KCK: 5 cars R1 to C1. Pending" as the row's label.

**The dialog asks why, then shows what the validator said.** Asking first means the reason is never an afterthought, and a refused attempt is still on record.

| Server answer | Dialog state |
|---------------|--------------|
| 201 Created | Closes. Notice: saved as a draft; Publish appears |
| 422 NEEDS_OVERRIDE | Stays open with the rule. Button becomes "Override and record" |
| 422 EDIT_REFUSED | Stays open with the rule, marked safety or can't-be-done. Confirm is disabled |
| 409 VERSION_CONFLICT | Closes. Banner: "Carol changed the plan first (now v12). Your edit wasn't applied." |

> "That table is the most important thing on this page. A yardmaster has to understand immediately whether the system disagrees, whether they may overrule it, and whether they've been beaten to it. A hold doesn't get a confirm button at all, however insistent they are, and I'd rather the UI make that impossible than warn about it."

**Optimistic update?** No. A drag leaves the row where it was until the server answers, with the dialog in between. An optimistic reorder here would show a plan that may be refused, in a place people act on it.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Pointer events by hand | Touch, two target kinds, testable geometry | I own it; keyboard is separate work |
| ❌ HTML5 drag-and-drop | No code for basics | No touch; poor preview control; hard to test |
| ❌ dnd-kit | Keyboard sensors included | Weight; lane-or-list target is awkward |

**A long list.** At 70 rows, plain DOM is fine. At 1,500 I'd virtualize with `@tanstack/react-virtual`. That complicates the drag, because rows that aren't rendered have no rects to measure, so I'd compute the insertion index from row height and scroll offset rather than from `getBoundingClientRect`. Hide-done helps too, since most of a list is finished by late shift.

### Locks on screen

A lock icon on the row, a Locks panel with who and why, and a Release that asks for a reason. A sequence lock from a drag appears there too, so nobody is surprised that a move won't budge. When a lock can't be honoured, the conflict banner names it and offers Release. Publish stays disabled until it's resolved.

---

## 📋 Plan Versions and the Diff (~6 min)

### Deep dive 2: Making a replan readable

> "We chose to show a replan as a sentence-level diff, grouped by what happened to each move, over showing the new list and letting people compare. A list of 70 rows with 20 differences is unreadable, and people will publish without looking, or stop trusting it. Showing only a total change count fails the other way: it can't answer 'why did my cut move?' The cost is that the server has to work out a reason for every changed move, and some reasons are only 'knock-on'. I'd rather say that plainly than invent a cause."

The page reads top down, in the order a yardmaster asks:

| Section | Answers |
|---------|---------|
| Header | Which version, whose, built on which yard state, on top of which parent |
| Why this exists | "late_train", "hold_placed", or a person's own words |
| Tiles | Left alone, changed, reordered, added, removed, only retimed |
| Stability | "This replan disturbed 26 moves. Solving from scratch would have disturbed 39. 9 moves were frozen." |
| What this costs | "M-DENBAR misses its 11:30Z departure ...", rolled cars, cars with no train |
| Moves | Each changed move, before and after, with a sentence saying why |

**What was left alone is a number on the page.** That's half of what a yardmaster wants to know, and it's the easiest thing to forget, because diffs naturally show differences. Moves left alone are hidden behind a checkbox, not removed.

**Reorders are honest.** The server counts reorders by longest increasing subsequence, so one inserted move doesn't paint every later row as changed. A move that only shifts in time is "retimed", not changed. Otherwise a 3-hour slip would make the whole page light up, which is exactly the panic this design is meant to avoid.

**Stable URLs.** A version's URL never changes meaning, because versions are immutable. `/plans/latest-replan` is a convenience alias for the most recent replan.

### The overrides table

On the plans page: when, who, what, reason category, their words, and the outcome, including "refused" and "overrode STANDING_ORDER". Refused attempts stay visible. Those rows are the most useful thing the system produces, because they show where people and the model disagree.

---

## 📱 The Crew Handheld (~8 min)

### Deep dive 3: Offline, correct, and unable to be fooled

> "We chose a persistent outbox with client-generated ids and event times, over a phone that just needs signal. A yard has dead spots, and a crew in one won't stop working, so an online-only app means reports written down later, or not at all. Then the board is wrong, and every later plan is built on fiction. A simpler offline approach, retrying requests in order, breaks on a lost response: the retry double-applies, or the phone gives up. Client ids make any retry safe, and event times mean the server can put late reports in the right place. The cost is a queue, a local view that can disagree with the server until sync, and in rare cases a report refused long after the crew acted on it."

**The screen.** One column, phone width. Large targets, for gloves. Six moves, not the whole list. Each card has one primary action.

```
┌───────────────────────────────┐
│ Next moves    v9 · 09:40Z  [⚡]│
│ [ All ][ Hump crew ][ Trim ]  │
│ ┌───────────────────────────┐ │
│ │ ⚠ 2 reports waiting  [Sync]│ │
│ └───────────────────────────┘ │
│ ┌───────────────────────────┐ │
│ │ CLASSIFY  09:42Z  pending │ │
│ │ KCK: 5 cars R1 → C1       │ │
│ │ I21-03, I21-07, ...       │ │
│ │ ┌───────────────────────┐ │ │
│ │ │        Start          │ │ │
│ │ └───────────────────────┘ │ │
│ │ ┌───────────────────────┐ │ │
│ │ │   Report a problem    │ │ │
│ │ └───────────────────────┘ │ │
│ └───────────────────────────┘ │
└───────────────────────────────┘
```

**The outbox flow.**

1. A tap creates a report with a client-generated id and an event time from the yard clock.
2. Online: post it. Offline: add it to the outbox and update the card from local status, so it moves on.
3. On reconnect or Sync: post the whole outbox as one batch. Each report stands alone, and the server answers per report.
4. Remove what the server took. Keep what it couldn't take, and show it.

**Why local status comes from the outbox.** While offline, "what have I done?" is derived from the queue itself, not from a second copy, so it can't drift. Once synced, the outbox empties and the server's status takes over.

**Order doesn't matter.** A phone might sync its pull before its classify. The server folds per car by event time, so the car ends up in the right place either way. I don't have to build careful in-order delivery on the client, which is one less thing to get wrong on a flaky network. Resending an entire queue is also safe.

**Storage can fail.** Private mode, a full disk, a blocked site. Every storage access is guarded, and the queue falls back to memory. A reload during that failure loses the queue, which I accept rather than crash.

**A refused start.** Online, the server reads holds at the moment of the tap. A refused start shows a rose stop: "Stop: I21-05 is on hold. Don't move this cut." The card also shows that when its own data knows about the hold. The server check is the one that counts, because the card's data can be seconds old.

**Offline and a hold landed anyway.** The server can't refuse a fact about the past. It accepts the report and alerts the yardmaster, who tells the crew. That's an honest limit of an offline system, and I'd say so rather than pretend.

**Report a problem.** Three choices in words: a car isn't where it should be, the track is blocked, I moved different cars. Picking cars is tapping chips, because typing car ids with gloves doesn't happen. A reason note is optional.

**Who sees what.** The handheld reads the published list only. A banner says "a new plan is waiting for the yardmaster, keep working from this one" when a draft exists, so a crew knows the plan may change without seeing a draft.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Outbox, client ids, event time | Works offline; retries safe; order doesn't matter | Local view can disagree until sync |
| ❌ Online only | Simple | Dead spots mean lost or fabricated reports |
| ❌ Service worker background sync | Sends after the page closes | Patchy browser support; harder to reason about |

---

## 📊 Compare and Metrics Pages (~2 min)

**Compare.** Tiles for instances proven and gaps; a table of small instances with greedy, local search and exact costs; and a chart of plan cost against solve time for a full shift, on a log time axis with a dashed reference line for greedy. One series, one axis, a title that names it, a hover tooltip with a target larger than the marker, and a table beside it as the accessible view.

**Metrics.** A per-shift table from raw rows, then the seeded replay under three policies. The limits are on the page, next to the numbers: the yardmaster is a script, overridden shifts are harder shifts, a simulator only rewards what it models, and there are few seeds.

> "I treat that text as part of the feature. A table saying 'planner plus overrides 79%, planner 75%' with no caveat would be misread as a finding by the first person who screenshots it."

**Simulator panel.** Clock, start and pause, step buttons, speed, exception rate, seed; and buttons for each scenario: make a train late, place a hold, block a track, drop a report. It's a demo tool, but it means the whole story can be shown from a browser.

---

## 📜 Execution Traces (~3 min)

### Successful trace: a yardmaster reads a replan and publishes

1. The board polls. The new snapshot has a working version v9, a draft from the planner, `reviewRequired`, and a `departure_missed` consequence.
2. The header changes to "Plan v9 draft". A rose banner appears with the sentence. An amber banner says crews are still on v8. Publish appears.
3. She clicks Diff. The page loads `/plans/:id/diff`. Tiles say 47 left alone, 9 changed, 12 reordered. The stability line says 26 disturbed against 39 from scratch.
4. She reads why each changed. She goes back and clicks Hold on the train, gives a reason, and the train's row shows its revised time.
5. That bumped the state, so a new draft arrives on the next few polls.
6. She clicks Publish. It returns 200. On its next poll, the handheld shows v10.

### Failed trace: two yardmasters, and a lost connection

1. Alice and Carol both see v7. Each drags a different move and fills in a reason. Both post with `expectedVersionNo: 7`.
2. Alice's lands first: 201, v8. Carol's gets 409 VERSION_CONFLICT naming Alice and v8.
3. Carol's dialog closes. A rose banner: "Alice changed the plan first (now v8). Your edit wasn't applied. Nothing was overwritten." with Load the latest. Her next poll would have shown v8 anyway.
4. She looks at v8 and redoes her drag if it still makes sense.
5. Meanwhile Dave's handheld loses signal mid-shift. He taps Start and Complete on two moves. Cards move on from local status, and the outbox shows 4 waiting.
6. A hold lands on a car in his next move. He's offline, so he can't be told. He starts it. That report sits in the outbox.
7. Signal returns. The batch goes up. The first three apply. The fourth is a fact about the past on a held car, so the server accepts it and alerts the board.
8. Alice sees a critical banner, and radios Dave. The replan already has a set-out in it.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | The server. A report leaves the outbox only after the server answers. A plan isn't real to crews until published |
| Client retries after losing the response? | Same client id, same stored answer. Resending a whole queue is harmless |
| Worker fails between steps? | The board shows "planner working", then a new version or an alert. Crews never notice, since their published list stands |
| Ordering actually required? | None from the client. The server folds per car by event time, so sync order doesn't matter |
| Access through caches, indexes and jobs? | The handheld's endpoint returns the published list only. Role redirects are for convenience; the API enforces |
| What breaks first? | The board's two-second poll at many viewers, then a 1,500-row list without virtualization |

---

## 🧩 Follow-ups I'd Expect (~3 min)

**A train arrives three hours late. What changes, and what's left alone?**

> "On screen: within a few seconds a draft appears, and a banner names any train that now misses its departure. The diff shows moves left alone as a number, then the changes with reasons. Done and in-progress moves are untouched, moves inside the 30-minute frozen horizon are kept unless they depended on that train, and most of the rest stay because changes cost the planner. In the seeded run 26 moves are disturbed, against 39 from scratch. A move that only shifted in time is 'retimed', so the page doesn't light up. Crews stay on the old list until it's published, and they see a note that a new plan is waiting."

**The yardmaster disagrees. How do overrides work?**

> "Drag, or Alt+arrows, or L for a lock. A dialog asks why, then shows the validator's answer: fine, overridable with a recorded reason, or refused with no button. A drag also pins a sequence lock, so the next replan keeps it, and it shows up in the Locks panel. If a lock becomes impossible, a banner says so and Publish stays disabled until they release or change it. Two yardmasters get a banner saying who won, never a silent overwrite. Every step goes into the overrides table, including what was refused."

**How do you measure whether the planner beats the yardmaster?**

> "The metrics page has per-shift numbers from raw rows and a seeded replay under three policies, and the limits are written next to them, because the table alone misleads. Four seeds gave 75%, 79% and 57% on time. The gap to the baseline is probably real, and the rest is mostly noise: 28 departures, a scripted yardmaster with information I gave it, and overridden shifts being harder shifts. The real test is a shadow run and then randomized assignment across real shifts. From a frontend angle, the override-reason chart is what I'd watch, since it says where people and the model disagree."

### The variant: inspection and repair scheduling

Same yard, planning maintenance. **Two coordinators assign one bay:** same version conflict and banner, and a bay timeline view where the loser sees who took the slot. **A part the plan assumes is in stock isn't:** the count is a fact, shown beside the plan's number with the difference highlighted, and the diff names which work items lost their part. **Planner down, then reconciling:** the same outbox pattern for coordinators' local decisions, with a banner saying the planner is down and the last schedule still stands, and a reconcile screen showing two local claims on one bay side by side for a person to settle.

---

## 🚨 Failure Handling (~1 min)

| Failure | What the user sees |
|---------|--------------------|
| API unreachable | A note, last data stays on screen with its clock |
| Planner stuck | "Planner working" with its attempt count; crews unaffected |
| Stale publish | Amber notice: a fresh plan has been queued |
| Lock conflict | Rose banner with Release; Publish disabled |
| Handheld offline | Outbox count; cards keep moving |
| Report rejected on sync | Stays in the outbox, shown, not silently dropped |
| Browser storage refused | Works in memory until a reload |
| Simulator down | A message saying how to start it |

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Updates | Poll one snapshot | WebSocket deltas | Consistent; can't be quietly wrong |
| Rules | Server validator, with preview | Client-side checks | One source of truth |
| Drag | Pointer events | HTML5 DnD or a library | Touch, two target kinds, testable |
| Keyboard | Alt+arrows, L, buttons | Drag only | Required, not optional |
| Edit feedback | Dialog with the validator's answer | Optimistic reorder | Don't show a plan that may be refused |
| Second editor | Banner naming the winner | Auto-merge | Don't guess intent |
| Replan view | Sentence-level diff, left-alone count | New list only | People can read it |
| Offline | Outbox, client ids, event time | Online only | Yards have dead spots |
| Sync order | Don't care; server folds | Careful in-order delivery | Less to get wrong |
| Charts | Hand-rolled SVG | Chart library | Small page, few charts |
| Styling | Tailwind, shared component classes | CSS-in-JS | Matches the repo |

---

## 📝 Wrap-up (~1 min)

> "So the board separates facts from plans and says which is which. Drag and keyboard reach one edit call, and that call has three clear answers, each with its own screen, including one that simply has no confirm button. A replan reads as sentences: what changed, why, what was left alone, what it cost. The phone keeps working with no signal, because each report carries its own id and its own time, so it doesn't matter when or in what order they arrive. And nothing on the crew's screen can be a draft. The optimizer's score is a footnote on this UI. A yardmaster who trusts the board is worth more than a slightly better plan."

### How the local implementation compares

| Production | Here |
|------------|------|
| Managed handhelds, native storage | A browser page, with a simulated offline toggle |
| 1,500-row lists with virtualization | 70 rows of plain DOM |
| Many yards, per-yard scope | One yard |
| Real hazmat rules | Simplified from position-in-train rules (in the US, 49 CFR Part 174), and labelled as simplified. Not the regulation |
| Push hint on change | Polling only |
| Inspection and repair screens | Designed, not built |
