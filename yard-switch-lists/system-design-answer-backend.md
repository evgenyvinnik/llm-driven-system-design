# Yard Switch Lists — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Architecture → Data model → Planner → Replanning → Overrides → Execution → Traces → Follow-ups → Scale*

> "The prompt: a classification yard receives inbound trains, sorts their cars into blocks on classification tracks, and builds outbound trains. Design the service that produces each shift's switch list, and replans it when trains run late. One note on where this comes from: BNSF publicly describes generating optimized switch lists with AI at its Alliance yard, but as far as I know this isn't a reported interview question, so I'm treating it as practice. The obvious trap is spending the round on the optimizer. Finding a good list once is a bounded problem with known tools. The hard product is what happens after that first list: a train slips and crews are mid-move, a yardmaster disagrees, a car goes on hold after it was planned, and a crew reports something the plan didn't expect. So I'll give the planner about five minutes and spend the rest on those. Three ideas carry the answer. The plan and the yard's actual state are different data, and crews' reports are the source of the second. Any plan, machine or human, goes through a validator that shares no code with the planner. And a replan pays for every change, because a better plan that crews have to relearn isn't better."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~4 min | Hard vs soft constraints; plan vs fact; who overrides what |
| Architecture and data model | ~8 min | Solve as a durable job; immutable versions; state version counting surprises |
| Planner | ~5 min | Decoder plus search; time limit; measured gap. Deliberately short |
| Deep dives | ~16 min | Replanning with stability; overrides and locks; execution feedback and holds |
| Traces and follow-ups | ~7 min | One success, one failure, the three follow-ups, the repair variant |
| Scale and trade-offs | ~5 min | What breaks first, and why I believe it |

---

## 🎯 Requirements (~4 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Does the plan drive crews directly, or advise a yardmaster? | Whether a person is in the loop | A yardmaster owns the plan. Routine replans publish themselves; anything with consequences stops for them |
| How are crews connected? | Offline behaviour | Handhelds, with dead spots. Reports can arrive minutes late and out of order |
| What's a hard constraint here? | What the planner may never do | Track capacity, block standing orders, departure times, train length and tonnage, hazmat placement, car holds |
| May a person break any of those? | The shape of overrides | Some, with a recorded reason. Never a safety rule such as a hold |
| How often does the yard surprise us? | Replan frequency | Every few minutes in a busy shift |
| How long may a solve take? | Time limit | Seconds to a couple of minutes. A late plan is worth less than a good-enough one on time |
| Who owns holds? | Integration | Railcar Health, as events. I consume them, I don't own them |

### Functional requirements

1. Model the yard: inbound trains and consists, cars with length, weight, destination block and hazmat class, tracks with capacity in feet, blocks with standing orders, outbound trains with departure, block sequence and limits.
2. Produce a switch list as a durable, time-limited solve against an explicit yard-state version.
3. Check every plan, including people's edits, with an independent validator.
4. Version plans immutably, publish with optimistic concurrency, and diff versions.
5. Replan on a late train, a hold, a blocked track or a crew exception, with bursts coalesced and consequences reported.
6. Support yardmaster reorder, retarget and lock, with an audit trail.
7. Keep held cars off outbound trains, whenever the hold lands.
8. Take crew execution reports, including offline ones, as the truth about the yard.
9. Measure the planner against the yardmaster, honestly.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Published list availability | 99.99% | Planner down must not mean no list |
| Replan latency | < 60 s from fact to draft | Fast coalescing and a hard solve budget |
| Hold enforcement | Zero held cars departing, through any race | Rechecks at publish, at crew start and at departure |
| Plan correctness | Zero published plans failing validation | A validator independent of the planner |
| Report durability | No accepted report lost; retries harmless | Client-generated ids; commit before ack |
| Stability | Far fewer moves changed than a from-scratch replan | Change penalty; frozen moves |

### Capacity estimate

BNSF's 10-K lists about 70,700 owned or leased freight cars and 32,500+ route miles. Everything else is my assumption.

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Yards in scope | ~25 | The busy ones |
| Cars through a large yard | ~2,500/day | ~1,250 per 12-hour shift |
| Moves per shift's list | ~1,500 | A few per cut |
| Crew reports | ~6/s system-wide at peak | 2 per move, bursty at shift start |
| Replans | One every few minutes per yard | After coalescing |
| Solve CPU | 1-2 cores per busy yard | Runs for its full budget |
| Plan storage | ~11 GB raw per yard per year | 50 versions × 1,500 moves × 200 B × 730 shifts |

> "So one modest PostgreSQL holds the writes. This isn't a throughput problem. The pressure is correctness per yard and CPU in the planner, and yards share nothing, so it partitions cleanly."

---

## 🏗️ High-Level Architecture (~5 min)

```
  dispatch feed     Railcar Health (#19)       yardmaster browser      crew handhelds
       │             hold events                     │                     │ (offline queue)
       │                 │                           ▼                     ▼
       │                 ▼                    ┌─────────────┐       ┌─────────────┐
       │          ┌────────────┐              │  Board API  │       │  Crew API   │
       │          │ Kafka:     │              └──────┬──────┘       └──────┬──────┘
       │          │ cases      │                     │                     │
       ▼          └─────┬──────┘                     ▼                     ▼
 ┌───────────┐    ┌─────▼──────┐        ┌──────────────────────────────────────────┐
 │ Yard      │───▶│ Hold       │───────▶│     PostgreSQL (one partition per yard)  │
 │ events    │    │ consumer   │        │  state_version · cars · tracks · trains  │
 └───────────┘    └────────────┘        │  plan versions · moves · executions      │
                                        │  crew reports · locks · overrides · holds│
                                        │  solve jobs · replan triggers · alerts   │
                                        └───────┬──────────────────────▲───────────┘
                                                │ triggers             │ one final
                                                ▼                      │ transaction
                                        ┌───────────────┐       ┌──────┴────────┐
                                        │  Coalescer    │──────▶│ Planner       │
                                        └───────────────┘  job  │ workers       │
                                                                └──────┬────────┘
                                                                       ▼
                                                                ┌───────────────┐
                                                                │  Independent  │
                                                                │  validator    │
                                                                └───────────────┘
```

> "Three separations carry this. Plans and facts are different data: a plan says what should happen, and cars, tracks and executions say what did. A plan never writes a car's position. The planner proposes and the validator disposes, and they share no logic, so a planner bug can't vouch for itself. And publishing is the only way crews see anything: solves, edits and replans all make drafts, and the published list is one pointer moved in one transaction."

### Why the planner is its own process

A search is CPU-bound for its entire budget. In the API process it would stall every request, and its own lease heartbeat, and a healthy solve would look dead. So it runs in workers, yields to the event loop every few milliseconds, and has a time limit it can't overrun by more than an iteration.

### The solve as a durable job

A solve is a row before anything computes it: status, algorithm, time limit, seed, attempts, lease token, and the yard-state version it read. A worker claims it with skip-locked and a lease measured on the database clock. It has no side effects until one final transaction, fenced by the lease token. That single fact answers most failure questions: a dead worker leaves nothing but a lease to expire, and there's no half-written plan to clean up.

---

## 💾 Data Model (~3 min)

| Table | Key columns | Notes |
|-------|-------------|-------|
| yard_state | yard_id, state_version, sim_now, head_version_id, working_version_id, auto_publish | One row per yard, and the serialization point |
| yard_state_log | version, kind, detail, actor | Why each version bump happened |
| tracks | id, kind, capacity_ft, is_open | Receiving, classification, departure |
| blocks | id, standing_track_id, alternate_track_ids, override_track_ids | A standing order, plus what a yardmaster added |
| inbound_trains | id, scheduled_arrival, eta, actual_arrival, receiving_track_id | ETA is a fact that changes |
| outbound_trains | id, scheduled_departure, revised_departure, block_sequence, max_length_ft, max_tons, min_cars, status | On-time counts from the scheduled time |
| cars | id, length_ft, tons, block_id, hazmat_class, position, track_id, coupled_to, position_as_of | Actual state. Only reports write position |
| switch_lists | id, version_no, status, parent_id, author, reason, based_on_state_version, validation, conflicts, consequences, stability | Immutable; only status moves forward |
| moves | list_id, seq, key, kind, crew, car_ids, from_track, to_track, planned_start, planned_end | A trigger refuses update and delete |
| move_executions | shift_id, key, status, started_at, completed_at, move | What happened, by stable key, across versions |
| crew_reports | client_report_id (PK), move_key, kind, occurred_at, offline, outcome, response | Idempotency ledger |
| locks | id, kind, move_key, before_key, car_id, track_id, active | Input to every solve, apart from any version |
| overrides | kind, actor, reason, reason_code, before, after, violations, refused | Includes refused attempts |
| solve_jobs | id, status, time_limit_ms, state_version, snapshot, attempts, lease_token, lease_expires_at | Stores its input, so a solve can be reproduced |
| replan_triggers | kind, detail, state_version, solve_id | Coalesced by the worker |
| hold_events | event_id (PK), type, stream_id, stream_version, outcome | Dedupe and audit |
| car_holds | hold_id (PK), car_id, status, stream_version | Register, folded by stream version |

### The state version counts surprises

> "This is the decision I'd stop and explain. `state_version` doesn't count changes. It counts things the plan didn't predict: a late train, a hold, a blocked track, a mismatch report, a late sync. A crew completing a move as planned doesn't bump it. If it did, then with crews working, no draft could ever be current by the time someone clicked Publish, and optimistic concurrency would just mean nothing ever publishes. The cost is that I now decide what counts as a surprise, which is a judgement call in a few thresholds: an arrival within 15 minutes of ETA isn't news, a move 25 minutes late is. If a threshold is wrong, a stale plan looks fresh. That's why the validator also runs at publish, on the state as it is right now, whatever the version says."

### Stable move keys

A move has a key that survives versions: classify, inbound train, block; or assemble, outbound train, block. That's what makes a diff possible, and it's how execution status follows a move across plans. A key with an execution record is never reused, so a cancelled move's replacement gets a suffix rather than inheriting its history.

---

## 🔌 API Design (~2 min)

```
GET  /api/v1/yard/board                     Everything the board shows, in one snapshot
GET  /api/v1/plans/:id/diff                 Kept, changed, reordered, added, removed, with why
POST /api/v1/plans/:id/publish              409 STALE_STATE, HEAD_MOVED, LOCK_CONFLICT; 422 invalid
POST /api/v1/plans/:id/edits                Names expectedVersionNo; 409 VERSION_CONFLICT
POST /api/v1/plans/:id/preview              What would the validator say? Writes nothing
POST /api/v1/locks                          Lock a move, or a car to a track
POST /api/v1/locks/:id/release              With a reason
POST /api/v1/solves                         Queue a solve; 202 with an id
POST /api/v1/yard/outbound/:id/revise-departure   Knowingly hold a train
GET  /api/v1/crew/moves                     The published list only
POST /api/v1/crew/reports                   Idempotent on clientReportId; 409 if a hold refuses it
POST /api/v1/crew/reports/batch             An offline queue flushing
POST /api/v1/integrations/holds/events      #19 webhook, for fixtures and replays
GET  /api/v1/metrics/shifts                 From raw rows
POST /api/v1/replays                        Queue the three-policy replay
```

> "Error codes are part of the product here. EDIT_REFUSED, NEEDS_OVERRIDE and VERSION_CONFLICT each lead the yardmaster's screen to a different next step, so they can't all be a generic 409."

---

## 🧮 The Planner, Briefly (~5 min)

> "I'll keep this short on purpose. If the interviewer wants to go deep on algorithms I can, but it's not where the system succeeds or fails."

**Decisions.** Which train each group of cars rides, which track each cut prefers, the order the hump crew works cuts, the order the trim crew works trains, and which departure track each train uses.

**Decoder.** Decisions go in, and a timed, feasible move list comes out, from a discrete-event list scheduler. At each step the crew whose next move can start soonest gets it. A car that can't legally go spills to the next train that serves its block, or is left unassigned and paid for. The search never sees an infeasible plan, and the time limit always has a complete plan to return.

**Objective.** A missed train costs 500, a car with no train 100, a car-hour of dwell 1, a move 3, a cut on an alternate track 8, and on a replan each changed move 40. The ratios matter more than the numbers: dwell can never buy a missed train, and stability has a real price.

**Three algorithms, one decoder.** A greedy earliest-deadline-first heuristic. Simulated annealing that keeps its best plan so far. And branch and bound for small instances, using the same decoder, with admissible bounds because a spill only ever costs more. Using one decoder makes the costs directly comparable.

| Measured on this build | Greedy | Local search | Exact |
|------------------------|--------|--------------|-------|
| 14 tight small instances | Often far above optimum, because it misses trains | Equal to the proven optimum on all 14 | Proven in 0.1-4 s |
| Full shift (~70 moves) | About 2.7× local search's cost | about 2,500-3,000 at 100 ms; about 1,830 from 500 ms on | Times out; best so far, no proof |

> "I'd be careful how I describe that. 'Exact' means proven best over the decoder's decisions, which only reaches list schedules that start each move as early as they can. It's not a claim about every possible schedule. And I can't bound the full shift, only the small instances. In production I'd add CP-SAT as a second candidate for that reason. The decoder stays as the fallback, because it has an answer at any instant, and the validator judges both."

### ✅ Why a decoder plus search, not a solver first

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Decoder + annealing | Any-time; stability is one cost term; locks are decisions it can't touch | No optimality bound at full scale |
| ❌ CP-SAT or MILP first | Bounds; models a real yard's in-track order better | Needs warm starts for stability; harder to explain; no plan until it finds one |

---

## 🔧 Deep Dives (~16 min)

### Deep dive 1: Replanning with stability

> "We chose to penalize changes and freeze work in progress, over re-solving from scratch, because the cost of a plan change isn't computational. It's a crew that was told one thing and now hears another. A from-scratch solve treats a three-hour slip as a new problem, and the search will happily reshuffle tracks and order on the far side of the shift for a tiny objective gain. On the seeded slip, from scratch disturbs 39 moves and the stable replan disturbs 26, and that gap is what crews feel. Re-solving from scratch fails specifically because nothing in the objective says the old plan had value. The cost of stability is that I give up some optimality on purpose: the stable plan can be measurably worse on dwell. I accept that because the change penalty is a number I can tune, and in a yard a plan that keeps changing stops being trusted."

Three tiers of "may not touch":

| Tier | What's in it | Rule |
|------|-------------|------|
| Frozen | Done or in progress | Facts. Carried verbatim, even by a from-scratch solve |
| Horizon | Pending, due within 30 minutes | Crews have been told. Kept unless a new fact makes them impossible, and then reported by name |
| Locked | A yardmaster's | Kept whatever the cost, or surfaced as a conflict |

Everything else starts from the old plan's decisions and pays 40 per change.

**Measuring change honestly.** A plain count would call every move after an insertion "changed", so I use the longest increasing subsequence of old positions: a reorder counts only moves you'd have to pick up and re-insert. A move that only shifts in time isn't counted as disturbed, but it is shown, because crews still need the new time. And every replan also runs from scratch, so the board can show "this replan disturbed 26; from scratch would have disturbed 39". It costs a few extra seconds of CPU per replan, and it's the number that tells you whether stability is earning its keep.

**Coalescing.** Triggers are rows, written in the same transaction as the fact. The coalescer fires when they've gone quiet for about a second or the oldest has waited five seconds, and only if no plan solve is running. A solve starting now reads newer state anyway, so what arrives during a solve waits for the next one. A burst of six triggers made one solve in the e2e.

```
fact + trigger ──▶ quiet 1.2 s? ──▶ one solve ──▶ validator ──▶ needs a person?
 (same commit)     oldest 5 s?                                    │        │
                   none running?                                 yes       no
                                                                  ▼        ▼
                                                               draft +  publish
                                                               banner
```

**When it publishes itself.** A new missed departure, a lock conflict or a validator failure stops for a person. Routine replans publish, because otherwise the yardmaster becomes a rubber stamp and crews sit on stale lists. Rolled cars are reported but don't stop it, and I'm less sure of that one: a railroad with strict service commitments might want them to stop too, so it's a setting.

**Reporting consequences.** The planner would rather annul a train than break a hard rule. That can't vanish into an objective value, so a consequence is a sentence: "M-DENBAR misses its 11:30Z departure: fewer than its minimum of 18 cars can be coupled in time; its cars could be ready about 68 min after departure (24 cars were planned on it)". Each changed move also says why, from the triggers its solve absorbed: "B4737 slipped 180 min: these cars come in on it", or "Knock-on: resequenced around the moves that had to change".

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Stable replan with frozen, horizon, locks | Crews keep their instructions; changes are explained | Slightly worse objective; one more weight to tune |
| ❌ Solve from scratch | Simple; best objective | Reshuffles everything; 39 vs 26 moves here |
| ❌ Patch only the affected cars | Very stable | Misses knock-on fixes; a cut that no longer fits can't move anything else |

### Deep dive 2: Human override

> "We chose locks that are inputs to every solve, and a validator that decides what a person may do, over letting a person's edit simply replace the plan. If an edit just wins, the next replan overrules it and the yardmaster stops trusting the system, or it stays out of the planner's sight and the planner plans around a yard that doesn't exist. If the planner can silently drop a lock it can't honour, it's worse: the yardmaster thinks they've pinned something they haven't. So a lock is respected or it's a visible conflict, and there's nothing in between. What I give up is simplicity: the planner has to take locks as hard inputs, a sequence lock can even deadlock the scheduler and has to fail into a conflict, and yardmasters have one more thing to clean up when a situation passes."

**What a yardmaster can do.**

| Action | Effect |
|--------|--------|
| Reorder (drag) | New draft. A sequence lock pins "this stays ahead of that" so the next replan can't quietly undo it |
| Retarget (drop on a track) | New draft; later pulls move to match |
| Lock a move | Its track and cars stay |
| Lock a car to a track | The decoder splits that car off into its own cut |
| Hold a train | Revises the departure, with a reason |

**The validator decides.** Every edit gets the same check as the planner.

| Severity | Examples | Yardmaster may override? |
|----------|----------|--------------------------|
| Safety | Car hold, hazmat placement, tonnage | Never, whatever they say |
| Physical | Track capacity, blocked track, cars not there, mixed block, block sequence, started move | No: it can't be done |
| Operating | Standing order, departure time, train length | Yes, with a recorded reason |

> "An operating override doesn't create an exception list. It changes the fact both planner and validator read: a recorded departure revision, a track added to this block's standing order for the shift, a raised length limit. An exception list has to be stored, matched, carried across versions and expired, and every one of those is a bug waiting. The cost is some lost nuance: 'this one cut may use this track' becomes 'this block may use it this shift'. That's closer to what a yardmaster means anyway. On-time still counts from the original scheduled departure, so holding a train doesn't launder its lateness."

**An infeasible lock.** Carol locks a car to C10, and then C10 is blocked. The decoder plans around it, and a separate check compares the result with every active lock. The draft carries a conflict naming the lock and the reason. The validator independently refuses it, publish returns LOCK_CONFLICT, and the lock stays active until a person releases it. The car isn't quietly routed elsewhere. A hold always beats a lock, and the conflict says so.

**Two yardmasters.** An edit names the version number it was looking at. Under the yard's row lock, a mismatch returns VERSION_CONFLICT naming who won. The e2e fires two at once through different API instances: one 201, one 409, one new version, and a record of the attempt that lost. A solve that finishes after a person moved the plan is discarded and re-queued, because the person's work wins.

**The audit trail.** Each override records who, why, a reason code, before and after, and which rule it overrode. Refused attempts stay too. Override reasons are the most useful thing the system produces, because they say where the model is wrong.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Locks plus validator | Overrides survive; conflicts are visible; safety is enforced in one place | Locks need cleaning up |
| ❌ Edits simply replace the plan | Simple | Next replan undoes them |
| ❌ Locks dropped when infeasible | Plans always publish | The yardmaster's belief and the plan silently differ |

### Deep dive 3: Execution feedback and holds

> "We chose to make crew reports the only writer of car position, over advancing state from the plan as time passes. Advancing from the plan gives you a board that always looks right and is wrong the moment a crew improvises. Then every later plan is built on fiction, and the first sign is a crew standing at a track with the wrong cars. Reports are messy, though. They arrive late, twice, and out of order, so that's the cost: I need idempotency and event-time ordering in the write path, and a board that lags reality by a report. A lag is honest and fixable. A confident wrong answer isn't."

**Idempotency.** The handheld generates the report id when the crew taps. A retry or a late sync collides on the primary key and gets the stored response back.

**Out of order.** Each car has an event-time watermark. A report older than the car's last move is recorded but doesn't move it. A crew classifies a cut and pulls it, offline, and the pull syncs first: the car lands on the departure track, then the classify report arrives, its handling is counted, and the car stays put. The final state matches in-order delivery. Moves for a car come from one crew in sequence, so this per-car fold is the only ordering required.

**As planned vs mismatch.**

| Report | State change | Replan? |
|--------|--------------|---------|
| Start, complete, as planned | Execution record; position on complete | No, unless over 25 min late |
| Synced from offline | Same, in event-time order | Yes: the planner didn't know |
| Car not where expected | Position unknown; leaves the plan until found | Yes |
| Moved different cars | Reported cars move; the frozen move shows what really happened | Yes |
| Track blocked | Track closes | Yes |

Track occupancy on the board reads from the same rows. A landing over capacity writes a capacity event, which is what the capacity-violation metric counts: reality, not the plan.

**Holds.** Railcar Health publishes `CarHoldPlaced`, `CarHoldReleased` and `CarHoldMoved` in its event envelope. The consumer dedupes on event id and folds each hold by stream version, so a release delivered before its hold still ends released. A car is held if any hold on it is active, and a hold for a car I haven't seen yet is kept for when it arrives.

> "The interesting part is that a hold can land at any moment relative to the plan, so one check isn't enough."

| When it lands | What stops it |
|---------------|---------------|
| Before planning | The car isn't planned |
| After planning, before publish | The validator refuses the plan at publish |
| After publish, before the crew starts | Starting the move reads holds directly, and an online start is refused with a stop message |
| While the crew is moving it | Alert to tell the crew; the move finishes where it's going |
| After coupling | Alert, a set-out move in the next plan, and the train can't depart until it's off |
| After departure | Alert: the next yard has to stop it |
| Reported from an offline handheld | Accepted as a fact, with an alert. Refusing it wouldn't uncouple anything |

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Reports as the only writer of position | Plans built on reality; board is honest | Lags by a report; needs idempotency and event time |
| ❌ Advance state from the plan | Always looks current | Wrong as soon as a crew improvises |
| ❌ Server-assigned report order | Simple | A late sync moves a car backwards |

---

## 📜 Execution Traces (~4 min)

### Successful trace: a train slips three hours

1. Dispatch sends a new ETA. The API writes it, bumps the state version, logs late_train and adds a trigger, in one transaction.
2. The coalescer sees one trigger, waits out the quiet window, confirms no solve is running, and inserts a job.
3. A worker claims it with skip-locked and a lease, reads one repeatable-read snapshot, and stores it on the job.
4. It builds the problem: nine moves frozen, moves in the horizon pinned except those depending on the late train (those are reported by name), everything else starting from the old plan at 40 per change.
5. Local search runs for its budget, heartbeating. The result disturbs 26 moves. A second solve from scratch disturbs 39.
6. The validator replays the list against the snapshot and passes it.
7. One outbound train now falls below its minimum, so the decoder annulled it, and the consequence is written in words. Cars were planned on it, so review is required.
8. In one transaction, fenced by the lease token: version, moves, job finished, alert raised. No publish.
9. Crews keep working from the old list. The yardmaster reads the diff and publishes. Under the row lock: state unchanged, still the working version, no conflicts, validator passes. The pointer moves.

### Failed trace: a hold lands between planning and a start, and the worker dies

1. A worker is partway through a solve at state 30.
2. A hold arrives on the stream. In one transaction: event row, hold register, state 31, trigger. Acked after commit, so redelivery hits the event id and does nothing.
3. The worker is killed with SIGKILL. No version exists, because versions only exist at the final commit. The job stays running, with a lease about to expire.
4. A crew still on the old list taps Start on the pull carrying that car. The start path reads the holds table, not the plan, and refuses with a stop message. The refusal is stored against the client id, so a retry gets the same answer.
5. Six seconds later a new worker reclaims the job, attempt 2, on a fresh snapshot at state 31, and plans without the car.
6. Had the old worker revived and tried to write, its lease token no longer matches, so the write is refused.
7. The new plan passes validation and publishes. The held car never reached a train, despite a dead worker and a stale list on a handheld.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | PostgreSQL. A report is accepted when its transaction commits, with fact, ledger row and trigger together. A plan exists when its final transaction commits |
| Client retries after losing the response? | Reports collide on the client id, holds on the event id, edits on the version number. Each returns the original answer or a clear conflict. Publish of a published version returns it |
| Worker fails between steps? | A solve has no side effects until its one commit. The lease expires on the database clock, and another worker starts over. The e2e kills one with SIGKILL and finds one attempt-2 result and no partial version |
| Ordering actually required? | Per car by event time; per hold by stream version; per yard for publish. Nothing across yards or across cars |
| Access through caches, indexes and jobs? | No cache on the board. Crews read only the published version, so a draft can't leak. Jobs run as the system; role checks happen where they're queued |
| What breaks first? | The per-yard row lock during report bursts, then planner CPU, then plan storage. Evidence below |

---

## 🧩 Follow-ups I'd Expect (~3 min)

**A train arrives three hours late. What does the planner change, and what does it leave alone?**

> "Left alone: everything done or in progress, verbatim; everything in the 30-minute horizon, unless it depended on that train, and then I say so by name; and most of the rest, because each change costs 40. Changed: the cuts from that train and the pulls that needed them, plus whatever has to move to make room. Cars that can't make their train roll to the next one serving their block. If a train falls below its minimum it's annulled, and that's a sentence on the yardmaster's screen before anything publishes, naming the train and how late its cars could be ready. They can hold the train instead, as a recorded override. In the seeded run, 26 moves are disturbed, against 39 from scratch, with 9 frozen."

**The yardmaster disagrees with the plan. How do overrides work?**

> "They drag or lock, and it goes through the same validator as the planner. Safety and physical violations are refused, however insistent they are. Operating rules need an explicit override with a reason, which changes the fact the rule reads. A drag pins a sequence lock, so the next replan keeps it. If a lock becomes impossible, the draft shows a conflict and can't publish until a person resolves it. A hold always wins. Everything records who, why, before and after, refused attempts included. Two yardmasters at once get a version conflict, never a lost edit."

**How do you measure whether the planner beats the yardmaster?**

> "Per shift, from raw rows: on-time departures, moves per car, dwell, capacity violations, override rate and reasons. Then the same seeded shift under planner only, planner plus a scripted yardmaster, and a baseline, with identical crews and disruptions. Across four seeds here the on-time rates were 75%, 79% and 57%. The planner beating the baseline is probably real. The rest I wouldn't lean on, for three reasons. The yardmaster is a script, and the radio tip that helps it is information I gave it, so 'the human adds value' is partly an input. People override when the plan already looks wrong, so overridden shifts are harder shifts. And a simulator only rewards what it models. Twenty-eight departures also means the 75-to-79 gap is one train. The real answer is a shadow run on real shifts, then randomizing which shifts see the planner's list. Override reasons are the most useful signal until then."

### The variant: inspection and repair scheduling

> "Same yard, planning maintenance. Cars arrive with risk levels from #19, required work and departure times, against limited crews, bays and parts. The architecture carries over: durable solves, independent validator, versioned plans, stable replans, reports as truth, locks."

**Two coordinators assign the same bay.** Optimistic concurrency on the schedule version catches most of it. A bay slot is also a real resource, so a unique constraint on bay and time slot makes a double-booking impossible at commit, even across different versions. The loser's conflict names who took it.

**A part the plan assumes is in stock isn't.** Stock is like car position: the plan's number is a prediction, and the physical count is the fact. A count below what's reserved is a surprise. It bumps the version and replans, and reservations say exactly which work items lost the part. The consequence is named: this car misses its train, or runs with a deferred repair if its risk allows. A safety-critical repair can never be deferred by the planner.

**Keeping the yard working while the planner is down, then reconciling.** The last published schedule stays usable, and people keep recording what they do with client-generated ids, locally if they must. When the planner returns, those reports are facts and the frozen set is what really happened. A coordinator's hand assignment during the outage arrives as a report plus an override, so it's locked in the replan rather than overwritten. The only thing needing a person is two local decisions claiming one bay, which reconciliation surfaces side by side rather than picking one.

---

## 🚨 Failure Handling (~1 min)

| Failure | What happens |
|---------|--------------|
| Planner down | Crews keep the published list and keep reporting; triggers queue; one coalesced replan on return |
| Worker killed mid-solve | Lease expires; another reclaims; no partial plan can exist |
| Solve exceeds budget | Returns best so far |
| Solve keeps failing | Fails after 4 attempts; alert says crews are on the last published plan |
| Plan fails validation | Stored as a draft, never published; critical alert. It's a bug |
| Handheld offline | Queues with client ids and event times; syncs safely out of order |
| Hold feed down | Holds are late; rechecks still catch whatever arrives. Needs a staleness alarm |
| Bad hold event | Dead-lettered with its error; the group keeps moving |
| Host stall | Leases and retries use the database clock; the simulator's clock is separate and explicit |

---

## 📈 What Breaks First and How It Scales (~2 min)

1. **The per-yard row lock during report bursts.** Every state-changing path takes it, by design: it's what makes the publish check trivially correct. At shift start, with crews starting together and offline queues flushing, this is where latency appears first. The evidence I'd watch is lock wait time and the stale-publish rate. The fix is to stop taking it for as-planned reports, since they don't touch what publish checks.
2. **Planner CPU.** Solves run for their whole budget, and a storm across yards queues them. One solve per yard is already true, so scale by adding workers, and shrink budgets under load.
3. **Plan storage.** Every replan copies the whole list, and most moves are unchanged between versions. Store moves by content hash and archive after a few weeks.

Yards share nothing, so partition by yard. That also limits the blast radius of a bad deploy to one yard.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Search | Decoder + annealing | Solver first | Any-time; stability and locks are easy; no bound on full shifts |
| Plan check | Independent validator | Trust the planner | It caught real decoder bugs during this build |
| Concurrency token | State version counting surprises | Version every write | Plans can publish while crews work |
| Stale publish | Reject and recompute | Rebase silently | A rebase is a replan anyway; don't hide it |
| Plan storage | Immutable versions | Mutable plan with history | Diff, audit and rollback for free; costs storage |
| Replan | Stable with frozen and horizon | From scratch | 26 vs 39 moves disturbed |
| Soft override | Change the underlying fact | Validator exception list | Nothing to expire |
| Reports | Client ids plus event-time watermark | Server-assigned order | A late sync lands correctly |
| Holds | Recheck at plan, publish, start, departure | Check at planning | A hold can land at any moment |
| Auto-publish | Only when no consequences | Approve everything | The yardmaster isn't a rubber stamp |
| Job queue | PostgreSQL with leases | RabbitMQ | One commit covers job and plan |
| Hold feed | Kafka topic | Direct call to #19 | Same envelope; decoupled |

---

## 📝 Wrap-up (~1 min)

> "So: the plan and the facts are separate, and crews' reports write the facts. A solve is a durable job with a hard time limit and a single commit at the end, so a dead worker costs nothing but time. Every plan, machine or human, goes through a validator that shares no code with the planner, and that validator found real bugs in my decoder while I was building this. Replans freeze what's started, keep what crews were just told, and pay for every other change, and when they cost something, like a missed departure, they stop and say so in a sentence. Yardmasters override with locks that survive replans and conflicts that surface rather than vanish, and nobody overrides a hold. The optimizer is the part I'd improve last. A better plan that crews don't trust isn't better."

### How the local implementation compares

| Production | Here |
|------------|------|
| Kafka `cases` topic | Valkey stream plus a webhook, same envelope as `railcar-health/events.md` |
| Dispatch and yard systems | A seeded simulator through the same API |
| Real yard geometry | A track is a capacity in feet; one block per class track; a pull can arrange cars within a block |
| Real hazmat rules | Simplified from position-in-train rules (in the US, 49 CFR Part 174), and labelled as simplified. Not the regulation |
| Many yards, partitioned | One yard |
| Multiple crews per job | One hump crew, one trim crew |
| CP-SAT candidate | Not built |
| Inspection and repair variant | Designed, not built |

Verified live: the 3-hour slip, stale publish, coalescing, locks surviving replans, an infeasible lock surfacing a conflict, soft and safety overrides, concurrent edits, duplicate and out-of-order holds, a hold blocking a crew's start, a hold after coupling, idempotent and out-of-order offline reports, a worker killed with SIGKILL, two seeded runs agreeing, and metrics recomputed independently from raw rows.
