# Yard Switch Lists - Architecture

## System Overview

A classification yard takes in inbound trains, sorts their cars into blocks on classification tracks, and builds outbound trains from those blocks. The switch list is the ordered set of moves that does this for a shift. This system produces that list, and it keeps the list true while the yard changes under it: trains run late, cars go on hold, tracks get blocked, crews find something the plan didn't expect, and yardmasters disagree.

The optimization is the smaller part. Finding a good list once is a bounded problem with known tools. The hard product is everything after that first list: replanning without disturbing the crews, letting a person override the plan without being overruled, and treating what crews report as the truth rather than what the plan predicted.

**Signal.** This is a practice extension, not a reported interview question. BNSF publicly describes generating optimized switch lists with AI at its Alliance yard, but this prompt isn't known to have been asked in interviews. The yard here ("Sandhills"), its train symbols, its schedule and every number in it are invented for this project. None of them come from BNSF or any railroad.

**Learning goals.**
- Run a CPU-bound planner as a durable job with a real time limit and a best-so-far answer.
- Keep an independent validator between any plan, human or machine, and the crews.
- Version immutable plans and publish them with optimistic concurrency on the yard's state.
- Replan with stability: freeze what has started, keep what crews were just told, and pay to change the rest.
- Let people override: locks that survive replans, conflicts that surface instead of being dropped, and a line that no override can cross.
- Make crew reports the source of yard state, including reports that sync late and out of order.
- Measure the planner against people, and be honest about what the measurement can't show.

## Requirements

### Functional

1. Maintain the yard model: inbound trains (schedule, actual arrival, consist), cars (length, weight, destination block, hazmat class), tracks (receiving, classification, departure, with capacity in feet), blocks (standing order to a track) and outbound trains (departure, block sequence, length and tonnage limits).
2. Produce a switch list as a durable, time-limited solve against an explicit yard-state version.
3. Check every plan with a validator that shares no code with the planner, and check human edits the same way.
4. Keep versions immutable (draft → published → superseded) with a parent, an author, a reason and the yard-state version each was built on. Show a diff between versions.
5. Replan on a late train, a hold, a blocked track or a crew exception, coalescing bursts. Report consequences, such as a missed departure, in plain words.
6. Let a yardmaster reorder or retarget moves and lock moves or car-to-track assignments, with every override recording who, why, and the before and after.
7. Consume holds from Railcar Health (#19) so a held car never leaves on an outbound train.
8. Take execution reports from crew handhelds, including offline queues that sync later. Yard state follows the reports.
9. Measure on-time departures, moves per car, dwell, capacity violations, override rate and override reasons per shift, and compare the planner with a yardmaster on seeded replays.

### Non-functional (production scale)

| Property | Target | Why |
|----------|--------|-----|
| Availability of the published list | 99.99% | Crews read it all shift. Losing the planner must not lose the list |
| Replan latency | Under 60 s from a fact arriving to a draft | A late train is only useful news while there's time to act |
| Crew report latency | p99 under 500 ms online; any delay offline | Handhelds lose signal in a yard, and reports must still land correctly |
| Hold enforcement | Zero held cars built into a departing train, through any race | It's a safety rule, not a preference |
| Plan correctness | Zero published plans failing the validator | A plan a crew can't execute costs more than a late plan |
| Solve budget | Seconds to low minutes per yard, hard limit | A late plan is worth less than a good-enough one on time |
| Durability | No accepted report or override lost | Reports are the facts, and overrides are the audit trail |

## Capacity Estimation

BNSF's 10-K lists 32,500+ route miles and about 70,700 owned or leased freight cars. Everything else below is my assumption.

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Hump or classification yards | ~25 | A large railroad runs a few dozen; only the busiest matter here |
| Cars through a large yard | ~2,500/day | Roughly 1,250 per 12 h shift |
| Moves on a shift's list | ~1,500 | A few per cut |
| Crew reports | ~6/s peak system-wide | 2 reports per move × 1,500 × 25 yards over a shift, with bursts at shift start |
| Replans | 1 per few minutes per yard | Coalesced triggers |
| Solve CPU | 1-2 cores per busy yard | Each solve runs for its budget |
| Plan storage | ~1 GB/yard/year | 50 versions/shift × 1,500 moves × ~200 B × 730 shifts is about 11 GB raw; most versions share nearly all their moves, so delta-encode |

The numbers say this isn't a throughput problem. One well-indexed PostgreSQL could take the writes for all 25 yards. The pressure is correctness and contention per yard, and CPU in the planner.

### Local Development Scale

One yard, 14 tracks, 8 blocks, 6 inbound and 7 outbound trains per 12-hour shift, about 170 cars and about 70 moves. A full solve runs a few thousand decoder calls per second on a laptop.

## High-Level Architecture

```
  dispatch feed      Railcar Health (#19)       yardmaster browser      crew handhelds
       │              hold events                     │                     │ (offline queue)
       │                  │                           ▼                     ▼
       │                  ▼                    ┌─────────────┐       ┌─────────────┐
       │           ┌────────────┐              │  Board API  │       │  Crew API   │
       │           │ Kafka:     │              └──────┬──────┘       └──────┬──────┘
       │           │ cases      │                     │                     │
       ▼           └─────┬──────┘                     ▼                     ▼
 ┌───────────┐     ┌─────▼──────┐        ┌──────────────────────────────────────────┐
 │ Yard      │────▶│ Hold       │───────▶│      Yard state (PostgreSQL, per yard)   │
 │ events    │     │ consumer   │        │  state_version · cars · tracks · trains  │
 └───────────┘     └────────────┘        │  plan versions · moves · executions      │
                                         │  crew reports · locks · overrides · holds│
                                         │  solve jobs · replan triggers · alerts   │
                                         └───────┬──────────────────────▲───────────┘
                                                 │ triggers              │ one final
                                                 ▼                       │ transaction
                                         ┌───────────────┐        ┌──────┴────────┐
                                         │  Coalescer    │───────▶│ Planner       │
                                         │               │  job   │ workers       │
                                         └───────────────┘        │ search,       │
                                                                  │ then validate │
                                                                  └──────┬────────┘
                                                                         ▼
                                                                  ┌───────────────┐
                                                                  │  Independent  │
                                                                  │  validator    │
                                                                  └───────────────┘
```

Three separations carry the design:

- **Plans and facts are different data.** A plan says what should happen; `cars`, `tracks` and `move_executions` say what did. A plan never writes a car's position.
- **The planner proposes and the validator disposes.** They share types but no logic, so a planner bug can't vouch for itself.
- **Publishing is the only way crews see anything.** Solves, edits and replans all make drafts. The published list is one pointer, moved in one transaction.

## Core Components

### Yard state and its version

`yard_state.state_version` is a counter of surprises. Anything the current plan didn't predict bumps it, in the same transaction that wrote the fact, with a row in `yard_state_log` saying what happened and who said so: a late train, a hold, a blocked track, a crew mismatch, a departure revision, an offline report.

Progress that goes as planned doesn't bump it. This matters more than it looks. If each completed move bumped the version, then with crews working no draft could ever be current by the time someone clicked Publish. Counting surprises rather than changes gives optimistic concurrency that means something: "your plan was built before something it didn't know about happened".

A solve's input is a snapshot read in one `REPEATABLE READ` transaction, so `state_version` really does describe the rows returned. The snapshot is stored on the job, so any solve can be reproduced.

### The planner

A solve searches over a small set of decisions and turns each candidate into a real plan with a decoder.

**Decisions.** Which train each group rides (a group is the cars from one inbound train, or on one class track, for one block), which track each cut prefers, the order the hump crew works cuts, the order the trim crew works trains, and which departure track each train uses.

**Decoder.** A discrete-event list scheduler. At each step the crew whose next move can start soonest gets it, so start times never go backward and the list reads in the order crews are released. Hard constraints are enforced by construction: a car that can't legally go spills to the next train that serves its block, or is left unassigned and paid for. The search therefore never sees an infeasible plan. A train that can't reach its minimum car count is annulled and its cars roll, instead of moving cars for nothing.

**Objective** (lower is better; the weights are illustrative):

| Term | Weight | Why this size |
|------|--------|---------------|
| Annulled train | 500 | A missed departure dominates everything |
| Car with no train this shift | 100 | Far above any dwell cost, so it's never traded for dwell |
| Car-hour of dwell | 1 | The everyday quality measure |
| Move | 3 | Fewer handlings |
| Cut on an alternate track | 8 | Standing orders exist for a reason, but overflow is legal |
| Changed move (stable replan only) | 40 | Stability has a real price |

**Three algorithms, one decoder.** All three are costed identically, which is what makes the gap meaningful.

```
greedy:        earliest-deadline-first. No search, no look-ahead. Also the search's start.
local search:  simulated annealing over the decisions. Keeps the best plan found, so the
               time limit returns that. Yields to the event loop every ~10 ms.
exact:         branch and bound over the same decisions, for small instances. Every leaf is
               a decode. Bounds are admissible because a spill can only cost more.
```

"Exact" means proven best over the decoder's decision space. The decoder only produces list schedules that start each move as early as it can, so this isn't a claim about every conceivable schedule. In production I'd model this in CP-SAT for that wider guarantee, and for a real yard's in-track ordering.

**Measured here** (`POST /comparisons`; seed 42, this machine):

| Instance | Greedy | Local search | Exact |
|----------|--------|--------------|-------|
| 14 small tight instances | Up to 1,000% above optimum | Equal to the proven optimum on all 14 | Proven in 0.1-4 s |
| Full shift | About 2.7× local search's cost | about 2,500-3,000 at 100 ms; about 1,830 from 500 ms on | Times out at 5 s with best so far (about 2,900) and no proof |

Greedy's large percentages come mostly from the 500-point penalty for a train it annuls and local search saves. Treat them as "greedy misses trains", not as a smooth quality gap.

**Time limit with teeth.** The search checks the clock every 8 iterations and yields every 10 ms, in a worker process. A fixed iteration count gives an identical plan, because the clock only truncates the search. That's what makes stepped simulator runs reproducible.

### The independent validator

`backend/src/validator/validate.ts` imports only types. A unit test fails if that folder ever imports planner code or any runtime logic. It re-derives the timeline from the raw list and replays it against the snapshot.

| Rule | Severity | Who can override |
|------|----------|------------------|
| Car hold | safety | Nobody |
| Hazmat buffer and adjacency (simplified) | safety | Nobody |
| Train tonnage | safety | Nobody |
| Track capacity, blocked track, mixed block, cars not there, block sequence, split train, frozen move changed, lock violated | physical | Nobody: it can't be done |
| Standing order | operating | Yardmaster, with a recorded reason |
| Departure time | operating | Yardmaster, with a recorded reason |
| Train length | operating | Yardmaster, with a recorded reason |

An operating override doesn't create an exception list for the validator to remember. It changes the fact both sides read: a recorded departure revision, a track added to the block's standing order for the shift, a raised length limit. There's nothing to go stale, and the on-time metric still counts from the original scheduled departure, so holding a train doesn't hide that it was late.

Facts aren't re-judged. A car already coupled, or a move already in progress, can't be made to un-happen, so those don't fail a plan. Otherwise one bad report would block every plan forever. What they do is show up as alerts and in train readiness.

This validator earned its place during the build. It caught five real bugs: a hazmat buffer defeated by pull order, crews coupling blocks out of sequence, a move key reused after a hold release, two trains sharing a departure track, and a time-travel bug where a failed attempt advanced the yard's clock so a later move saw space that wasn't free yet. See [CLAUDE.md](./CLAUDE.md#iteration--repair-log).

**Hazmat rules are simplified from real rules.** The buffer (at least five non-placarded cars behind the locomotive) and adjacency pairs are reductions of position-in-train requirements (in the US, 49 CFR Part 174), which vary with hazard class, train length and movement. They aren't the regulation, and the code and UI say so.

### Versioned plans

`switch_lists` plus `moves`, with database triggers that refuse any change to moves and any change to a version's content. Only the status moves forward. Move keys are stable across versions (`classify:I23:KCK`, `assemble:O21:GAL#2`), which is what a diff compares. A key that has an execution record is never reused.

Publish takes the `yard_state` row lock and checks, in order:

1. Still a draft.
2. Built on the current state version. Otherwise `409 STALE_STATE`, and a recompute is queued.
3. Still the working version. Otherwise `409 HEAD_MOVED`.
4. No unresolved lock conflicts. Otherwise `409 LOCK_CONFLICT`.
5. Validator passes against the state as it is right now. Otherwise `422`.

Then the old head is superseded and the pointer moves, in one commit. Routine replans publish themselves. A replan that creates a new missed departure, a lock conflict or a validator failure stops for a person, and crews keep working from the old list until then.

### Replanning with stability

```
Trigger (late train, hold, blocked track, crew mismatch, drift, late sync, ...)
   │ bumps state_version and adds a replan_triggers row in the fact's own transaction
   ▼
Coalescer: fires when triggers go quiet for 1.2 s or the oldest has waited 5 s,
           and only if no plan solve is queued or running
   ▼
Solve: read one snapshot, then build the problem:
   frozen:  done or in progress. Facts. Carried verbatim.
   horizon: pending and due within 30 minutes. Crews have been told. Kept unless a new
            fact makes them impossible, and then reported by name.
   locked:  a yardmaster's. Kept whatever the cost, or surfaced as a conflict.
   rest:    start from the old plan's decisions; each change costs 40.
   ▼
Second solve from scratch, ignoring the old plan, to measure what stability is worth
   ▼
Validator → one transaction: version, job, publish if nothing needs a person
```

Measured: on the seeded 3-hour slip, the stable replan disturbs 26 moves where from-scratch disturbs 39, with 9 frozen. "Disturbed" counts changed, added, removed and reordered moves. Reordering uses the longest increasing subsequence, so one insertion doesn't count everything after it. A move that only shifts in time isn't counted. Crews still have its time, but they don't have to relearn it.

### Human override

- **Reorder.** Drag a move. The validator checks the new list, and the drag pins a `sequence` lock, "this move stays ahead of that one", so the next replan can't quietly undo it.
- **Retarget.** Drop a move onto a track lane.
- **Lock a move.** Its track and cars stay as they are.
- **Lock a car to a track.** The decoder splits that car off into its own cut.

Each writes `overrides` with who, why, before and after. Refused attempts and lost concurrency races are recorded too, because an attempt that was refused is often the most interesting row.

Two yardmasters: an edit names the version number it was looking at. Under the row lock, a mismatch returns `409 VERSION_CONFLICT` naming the winner, and the loser's attempt is recorded. No edit is ever merged or lost silently. A solve that finishes after a person moved the plan is discarded and re-queued, because the person's work wins.

When a lock can't be honoured the decoder plans around it, and `verifyLocks` compares the result with every active lock. The draft carries a conflict naming the lock and the reason. The validator independently refuses it. The lock stays active until a person releases it. A hold always beats a lock.

### Holds from other systems

The feed is the envelope from [railcar-health/events.md](../railcar-health/events.md): `CarHoldPlaced`, `CarHoldReleased` and `CarHoldMoved`. Locally a Valkey stream stands in for the Kafka `cases` topic, with a webhook for fixtures and replays.

- `event_id` dedupes redelivery.
- Each hold is a register folded by `stream_version`, so a release delivered before its hold still ends released.
- A car is held if any hold on it is active. Two cases can hold one car.
- A hold for a car not yet seen is kept and applies when it arrives.

The check happens at four points, because a hold can land at any moment:

| When | What happens |
|------|--------------|
| Planning | The car isn't planned onto anything |
| Publish | The validator refuses a plan carrying it |
| Crew start | An online start is refused with a stop message, whatever the plan says |
| Departure | The train waits, and an alert asks for the car to be set out |

A hold after coupling raises an alert and the replan adds a set-out move. An offline report of a start on a held car is a fact about the past, so it's accepted and raises an alert. Refusing it wouldn't uncouple anything.

### Execution feedback

Crew reports are the only source of car position. The client generates the report id, so a retry or a late sync collides on the primary key and returns the original answer. Each car has a `position_as_of` event-time watermark, so a report older than the car's last move is recorded but doesn't move it. Syncing a queue out of order lands every car where in-order delivery would.

| Report | State change | Replan? |
|--------|--------------|---------|
| Start, complete, as planned | Execution record, car position on complete | No, unless more than 25 min late |
| Any report synced from offline | Same, in event-time order | Yes: the planner didn't know |
| Car not where expected | Car position becomes unknown; it leaves the plan until found | Yes |
| Moved different cars | Reported cars move; the move's frozen copy shows what actually happened | Yes |
| Track blocked | Track closes | Yes |

The board's track lanes read from `cars`, so occupancy is what crews reported. A landing over capacity writes a `capacity_events` row. That's the capacity-violation metric, and it comes from reality, not from the plan.

### Yard simulator

A separate process with its own clock and a speed factor, calling the same API with a token and producing holds on the same stream. Every random draw is a function of `(seed, label)`, so crew speed for a move doesn't depend on the order things happened in. Stepped runs wait for the planner to settle between steps and give identical event logs, which the e2e verifies. The seed runs the same engine in-process, so demo data comes from the code the live system runs.

### Measuring the planner against the yardmaster

Metrics come from raw rows on demand, with no second number to disagree with them.

The replay runs the same seeded shift, in memory, under three policies: planner only, planner plus a scripted yardmaster (protects a tight train, follows a habit, hears about one late train on the radio an hour early), and a baseline rule of thumb. Crew speed, late trains, holds and blocked tracks are identical across policies. Only decisions differ.

From the seeded run on the metrics page (seeds 42, 7, 11 and 23; 28 departures per policy; 500 search iterations per solve):

| Policy | On time | Missed | Cars out | Stranded | Moves/car | Dwell | Disturbed | Overrides |
|--------|---------|--------|----------|----------|-----------|-------|-----------|-----------|
| Planner only | 75% | 7 | 585 | 58 | 1.91 | 5.93 h | 322 | 0 |
| Planner + scripted yardmaster | 79% | 6 | 581 | 62 | 1.90 | 6.00 h | 264 | 16 |
| Baseline rule of thumb | 57% | 12 | 500 | 143 | 1.78 | 6.21 h | 256 | 0 |

Note the last-but-one column. The baseline disturbs fewer moves than planner-only, because a fixed rule has little reason to change its mind, while a search keeps finding improvements that pay for their change penalty. Stability measured against a from-scratch search (26 vs 39 above) doesn't mean the planner is the most stable option available. The baseline pays for its stability in missed trains. The change weight is the knob between the two.

**The limits, stated plainly:**

- **The yardmaster is a script.** It encodes my assumptions about what people do. The radio tip in particular is information I gave it. "The human adds value" here is partly an input, not a finding.
- **Selection effects.** People override when a plan already looks wrong, so overridden shifts are harder shifts. Comparing them with untouched shifts flatters the planner.
- **A simulator only rewards what it models.** Crew judgement, weather, power shortages and customer calls aren't here.
- **Sample size.** Four seeds, 28 departures: one train is more than 3 points. The gap between planner and baseline is probably real, but the gap between planner and planner-plus-yardmaster is one train, which is noise until many more seeds agree.

The real test is a shadow run on real shifts first, then randomized assignment of which shifts see the planner's list, measured on departures and dwell from the same reports.

### Variant: inspection and repair scheduling

The same yard, planning maintenance. Cars arrive with risk levels from #19, required work and departure times; a yard has limited crews, bays and parts. I didn't build this, but most of the architecture carries over: durable solves, independent validator, versioned plans, stable replans, crew reports as truth, locks. The entities become `work_item`, `bay`, `crew_shift`, `part_stock` and a versioned `repair_schedule`.

**Two coordinators assign the same bay.** The same optimistic concurrency on the schedule version applies. In addition, a bay slot is a real resource with a unique constraint on `(bay, time slot)`, so even two edits to different versions can't double-book at commit. The loser gets a conflict naming who took it.

**A part the plan assumes is in stock isn't.** Treat stock like car position: the plan's number is a prediction, and the physical count is the fact. A count below what's reserved bumps the state version and replans. Reservations are recorded against the count, so "the plan assumed 4 and we have 2" tells you exactly which work items lost their part. The consequence is reported by name: this car misses its train, or runs with a deferred repair if its risk level allows. A safety-critical repair can never be deferred by the planner.

**Keep the yard working while the planner is down, then reconcile.** This is the published-list property again. The last published schedule stays usable, and crews and coordinators keep recording what they do, locally if they have to, with client-generated ids. When the planner returns, it reads the state those reports produced, and the frozen set is whatever really happened. A coordinator's local decision during the outage (assigning a bay by hand) arrives as a report and an override, so it's locked in the replan instead of being overwritten. The only conflict that needs a person is two local decisions claiming the same bay, and the reconciliation surfaces those side by side rather than picking one.

## Execution Traces

### Successful trace: a train slips three hours

1. Dispatch sends a new ETA for inbound train B4737: 09:20 instead of 06:20. The API writes the ETA, bumps `state_version` to 20, logs `late_train` and adds a trigger, all in one transaction.
2. The coalescer sees one trigger. After 1.2 quiet seconds, with no solve in flight, it inserts a `solve_jobs` row and marks the trigger as consumed.
3. A worker claims the job with `SKIP LOCKED` and a 6-second lease, then reads one `REPEATABLE READ` snapshot at version 20 and stores it on the job.
4. It builds the problem. Nine moves are done or in progress, so they're frozen. Pending moves due in the next 30 minutes are pinned, except those whose cars come in on B4737, which are reported by name. Everything else starts from the old plan's decisions.
5. Local search runs for its budget, heartbeating. Each change costs 40, so it only moves what it must. It finds a plan disturbing 26 moves. A second search from scratch disturbs 39.
6. The validator replays the list against the snapshot and passes it.
7. M-DENBAR can now reach only 12 of its 18 minimum cars by 11:30. The decoder annulled it, and the outcome step reports: "M-DENBAR misses its 11:30Z departure... its cars could be ready about 68 min after departure". Because cars were planned on it, `review_required` is true.
8. In one transaction, fenced by the lease token: insert the version and moves, finish the job, raise a review alert. No publish.
9. The board shows the banner. Crews keep working from the old list. Alice opens the diff and sees what changed and why, and what was left alone.
10. She publishes: row lock, state still 20, still the working version, no conflicts, validator passes against current state. The pointer moves. Crews see v9 on their next poll.

### Failed trace: a hold lands between planning and a crew's start, and the worker dies

1. A worker is partway through a solve at state 30.
2. `CarHoldPlaced` for car I21-05 arrives on the stream. The consumer applies it in one transaction (new `hold_events` row, `car_holds` register at stream version 1, state 31, trigger) and acks after commit. If it had crashed before acking, redelivery would hit the event id and do nothing.
3. The worker is killed with SIGKILL before it finishes. There's no version, because a version only exists at its final commit. The job row stays `running` with a lease that will expire.
4. Dave's handheld still shows the old list, and he taps Start on the pull carrying I21-05. The start path reads `car_holds`, not the plan. The report is refused with "Stop: I21-05 is on hold", the refusal is stored against his client id, and an alert goes up. If his phone retries, he gets the same answer.
5. Six seconds later the lease has expired on the database clock. A new worker reclaims the job (attempt 2), reads a fresh snapshot at state 31, and plans without the car.
6. Had the stalled worker come back and tried to write, its lease token would no longer match and its result would be dropped.
7. Validator passes, and the plan publishes. The hold never reached a train, despite a dead worker and a stale list on a handheld.

## Follow-ups

**A train arrives three hours late. What changes, and what's left alone?** Left alone: everything done or in progress, verbatim; everything in the 30-minute horizon, unless it depended on that train, which is reported; and, because each change costs 40, most of the rest. Changed: the cuts from that train and the pulls that needed them, plus whatever has to move to make room. Cars that can't make their train roll to the next one that serves their block. If a train falls below its minimum it's annulled, and that's a named consequence the yardmaster sees before anything is published. The yardmaster can hold the train instead, which is a recorded override.

**The yardmaster disagrees with the plan. How do overrides work?** They drag or lock. An edit makes a new draft, with a reason. The validator checks it the same way it checks the planner: a safety or physical violation is refused outright, and an operating violation needs an explicit override with a reason, which changes the underlying fact. A drag pins a sequence lock, so the next replan keeps it. If a lock becomes impossible, the draft carries a conflict and can't be published until a person resolves it. A hold always wins. Every step records who, why, before and after. Two yardmasters get a version conflict, never a lost edit.

**How do you measure whether the planner beats the yardmaster?** Per shift, from raw rows: on-time departures, moves per car, dwell, capacity violations, override rate and reasons. Then the same seeded shift under planner only, planner plus overrides, and a baseline. And then I'd say out loud that this doesn't answer the question. The scripted yardmaster is my assumption, overridden shifts are harder shifts, and a simulator only rewards what it models. The real answer takes a shadow run and then randomized assignment across real shifts. Override reasons are the most useful signal in the meantime, because they say where the model is wrong.

## Database Schema

The full schema is `backend/src/db/init.sql`. These are the tables that carry the design.

```sql
CREATE TABLE yard_state (
  yard_id            TEXT PRIMARY KEY,
  shift_id           INT NOT NULL,
  state_version      BIGINT NOT NULL DEFAULT 1,   -- counts surprises, not progress
  sim_now            TIMESTAMPTZ NOT NULL,        -- the yard's clock
  head_version_id    UUID,                        -- what crews see
  working_version_id UUID,                        -- what the next edit or replan builds on
  auto_publish       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE switch_lists (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id               INT NOT NULL,
  version_no             INT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('draft', 'published', 'superseded')),
  parent_id              UUID REFERENCES switch_lists(id),
  author_kind            TEXT NOT NULL CHECK (author_kind IN ('planner', 'person')),
  author_name            TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  based_on_state_version BIGINT NOT NULL,
  solve_id               UUID,
  validation             JSONB NOT NULL,
  conflicts              JSONB NOT NULL DEFAULT '[]',
  consequences           JSONB NOT NULL DEFAULT '[]',
  stability              JSONB,
  review_required        BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (shift_id, version_no)
);
CREATE UNIQUE INDEX switch_lists_one_published ON switch_lists (shift_id) WHERE status = 'published';
CREATE UNIQUE INDEX switch_lists_one_per_solve ON switch_lists (solve_id) WHERE solve_id IS NOT NULL;

CREATE TABLE moves (
  list_id       UUID NOT NULL REFERENCES switch_lists(id),
  seq           INT NOT NULL,
  key           TEXT NOT NULL,                   -- stable across versions
  kind          TEXT NOT NULL,                   -- receive, classify, assemble, setout
  crew          TEXT NOT NULL,                   -- road, hump, trim
  car_ids       TEXT[] NOT NULL,
  from_track_id TEXT,
  to_track_id   TEXT NOT NULL,
  planned_start TIMESTAMPTZ NOT NULL,
  planned_end   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (list_id, seq),
  UNIQUE (list_id, key)
);
-- A trigger refuses UPDATE and DELETE on moves. A change is a new version.

CREATE TABLE cars (
  id             TEXT PRIMARY KEY,
  length_ft      INT NOT NULL,
  tons           INT NOT NULL,
  block_id       TEXT NOT NULL REFERENCES blocks(id),
  hazmat_class   TEXT,
  position       TEXT NOT NULL,                  -- inbound, on_track, unknown, departed
  track_id       TEXT REFERENCES tracks(id),
  coupled_to     TEXT REFERENCES outbound_trains(id),
  coupled_seq    BIGINT,
  position_as_of TIMESTAMPTZ                     -- event-time watermark for late reports
);

CREATE TABLE crew_reports (
  client_report_id TEXT PRIMARY KEY,             -- generated on the handheld
  move_key         TEXT,
  kind             TEXT NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,
  offline          BOOLEAN NOT NULL DEFAULT FALSE,
  outcome          TEXT NOT NULL,
  mismatch         BOOLEAN NOT NULL DEFAULT FALSE,
  response         JSONB NOT NULL                -- a retry gets exactly this back
);

CREATE TABLE solve_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lane             TEXT NOT NULL,                -- plan, analysis
  purpose          TEXT NOT NULL,
  status           TEXT NOT NULL,                -- queued, running, succeeded, failed
  time_limit_ms    INT NOT NULL,
  state_version    BIGINT,
  snapshot         JSONB,                        -- the exact input, for reproducing a solve
  attempts         INT NOT NULL DEFAULT 0,
  lease_token      TEXT,
  lease_expires_at TIMESTAMPTZ,
  result_version_id UUID
);

CREATE TABLE car_holds (
  hold_id        TEXT PRIMARY KEY,
  car_id         TEXT NOT NULL,
  status         TEXT NOT NULL,                  -- active, bad_ordered, released, moved_away
  stream_version BIGINT NOT NULL                 -- last writer by version, not by arrival
);
```

## API Design

```
POST /api/v1/auth/login                     Session cookie
GET  /api/v1/yard/board                     Everything the board shows, in one snapshot
GET  /api/v1/plans                          Versions this shift
GET  /api/v1/plans/:id                      One version with moves (also latest-replan, working, head)
GET  /api/v1/plans/:id/diff                 Kept, changed, reordered, added, removed, with why
POST /api/v1/plans/:id/publish              409 STALE_STATE, HEAD_MOVED or LOCK_CONFLICT; 422 if invalid
POST /api/v1/plans/:id/edits                Names expectedVersionNo; 409 VERSION_CONFLICT
POST /api/v1/plans/:id/preview              What would the validator say? Writes nothing
POST /api/v1/plans/:id/discard              Throw away a draft
POST /api/v1/locks                          Lock a move or a car to a track
POST /api/v1/locks/:id/release              With a reason
POST /api/v1/replan                         Adds a trigger
POST /api/v1/solves                         Queue a solve; returns 202 with an id
GET  /api/v1/solves/:id                     Status, stats, cost curve
POST /api/v1/yard/outbound/:id/revise-departure   Knowingly hold a train
POST /api/v1/yard/tracks/:id/status         Block or reopen a track
GET  /api/v1/crew/moves                     The published list only
POST /api/v1/crew/reports                   Idempotent on clientReportId; 409 if a hold refuses it
POST /api/v1/crew/reports/batch             An offline queue flushing
GET  /api/v1/holds                          Holds and the feed
POST /api/v1/integrations/holds/events      #19 webhook (token)
POST /api/v1/comparisons                    Queue greedy vs local search vs exact
POST /api/v1/replays                        Queue the three-policy replay
GET  /api/v1/metrics/shifts                 Per-shift metrics from raw rows
```

An edit, with both refusals:

```json
POST /api/v1/plans/4f.../edits
{ "expectedVersionNo": 7,
  "ops": [{ "op": "retarget", "moveKey": "classify:I23:KCK", "toTrackId": "C5" }],
  "reason": "East switch on C1 is soft", "reasonCode": "track_condition", "overrideSoft": true }

422 { "error": { "code": "EDIT_REFUSED", "message": "...", "details": { "overridable": false,
      "violations": [{ "code": "CAR_HOLD", "severity": "safety", "message": "..." }] } } }

409 { "error": { "code": "VERSION_CONFLICT", "details": { "expected": 7, "current": 8, "currentAuthor": "alice" } } }
```

## Key Design Decisions

### Decoder plus search, not a mathematical program

A CP-SAT or MILP model would give bounds and handle a real yard's in-track ordering better. I chose a decoder plus annealing here for four reasons. Any-time behaviour is trivial: there's always a complete plan to return. Stability is one more cost term, where a solver needs a warm start and a soft objective. Locks and frozen moves are just decisions the search can't touch. And an explanation can come from the decoder (this car spilled because the train was full). The cost is that I can't say how far a full-shift plan is from optimal, only how far it is on small instances, which is why the comparison exists. In production I'd keep this as the fallback and add a solver as a second candidate, with the validator choosing nothing but refusing anything invalid.

### The state version counts surprises, not changes

The alternative, bumping on every write, makes the check trivially correct and practically useless: with crews working, nothing would ever publish. The cost of counting surprises is that I have to decide what counts. That judgement lives in small thresholds (an arrival within 15 minutes of ETA isn't news; a move 25 minutes late is), and a wrong threshold means a stale plan looks fresh. The validator at publish is the backstop, since it runs on current state whatever the version says.

### One lock per yard, in PostgreSQL

Every state-changing path takes the `yard_state` row lock. That's a bottleneck by design: reports, holds and publishes for one yard serialize, which makes the publish check trivially correct. It's fine because a yard does a few reports per second at most, and yards don't share anything. It's the first thing to look at under load, though, and a report transaction is the one that must stay short.

### Validator rules changed by overriding the fact, not by exception

An exception list has to be stored, matched, carried across versions and eventually expired. Changing the fact (the departure, the standing order) means both planner and validator just read the world as it is. The cost is losing a bit of nuance: an override for "this one cut" becomes "this block may use this track for the rest of the shift". That's closer to what a yardmaster means anyway.

### Publish stops for a person only when a person is needed

Requiring approval for every replan would make the yardmaster a rubber stamp and leave crews on stale lists. Publishing everything would let a missed departure happen without anyone seeing it. The rule: a new missed departure, a lock conflict or a validator failure stops; rolled cars are reported but don't. I'm less sure about that last one. A railroad with strict service commitments might want rolled cars to stop too, so it's a setting.

## Consistency and Idempotency

| Operation | Key | On retry |
|-----------|-----|----------|
| Crew report | `client_report_id` (device-generated) | Returns the stored response; nothing reapplied |
| Hold event | `event_id` | Recorded as duplicate; nothing reapplied |
| Hold state | `stream_version` per hold | Older event is recorded as stale |
| Car position | `position_as_of` event time | Older report doesn't move the car |
| Solve result | Lease token fence; unique `solve_id` | A stalled worker's write is refused; at most one version per solve |
| Trigger to solve | Advisory lock in the coalescer | One solve at a time per yard |
| Edit | `expectedVersionNo` | Second edit on the same version gets 409 |
| Arrival, departure | Status check under the row lock | Second call returns the first outcome |

The ordering guarantee actually needed is per car by event time, per hold by stream version, and per yard for publish. No ordering across yards, and none across cars.

**The six design review questions:**

1. **Source of truth and when a write succeeds.** PostgreSQL. A crew report succeeds when its transaction commits, with the fact, the ledger row and any trigger together. A plan exists when its one final transaction commits.
2. **Client retries after losing the response.** Reports and holds collide on their ids and return the original answer. Edits collide on the version number. Publish is idempotent: publishing a published version returns it.
3. **Worker fails between steps.** A solve has no side effects until one final commit. A worker killed mid-solve leaves a running job with an expiring lease, measured on the database clock. The next worker takes it and starts over. The e2e kills one with SIGKILL and confirms one attempt-2 result and no partial version.
4. **Ordering actually required.** As above: per car, per hold, per yard. Everything else is commutative by construction.
5. **Access through caches, indexes and jobs.** The board has no cache. A crew's list comes from the published version only, so a draft never leaks to a cab. Jobs act as the system, not as a user, and role checks happen at the API that queues them. The simulator's control port has no auth and is proxied through a role check.
6. **What breaks first at scale.** See Scalability Considerations: the `yard_state` lock under report bursts, then planner CPU, then plan storage, with evidence for each.

## Security / Auth

Session cookies in Valkey (`httpOnly`, `sameSite=lax`). Roles: `yardmaster` edits, locks and publishes; `crew` reads the published list and reports; `admin` can do everything. Machine callers use a shared token locally; production uses mTLS and per-device identity for handhelds, since a report moves real cars in the system's eyes. Every override and refused attempt is recorded with its actor. Login attempts are rate limited per IP.

A real deployment needs a per-yard scope on every query, because a yardmaster at one yard shouldn't edit another's plan. Here there's one yard.

## Observability

Prometheus on each process.

| Metric | Why |
|--------|-----|
| `yard_solves_total{algorithm,purpose,terminated_by}` | How often the time limit decides |
| `yard_solve_seconds` | Budget actually used |
| `yard_solve_lease_reclaims_total` | Workers dying |
| `yard_replan_triggers_per_solve` | Whether coalescing is working |
| `yard_publish_total{outcome}` | Stale and conflict rates; a rising stale rate means the planner is too slow for the yard |
| `yard_validator_runs_total{author,result}` | A planner failure here is a bug and should page |
| `yard_crew_reports_total{kind,outcome}` | Refusals and mismatches |
| `yard_hold_events_total{type,outcome}` | Duplicates and staleness in the feed |
| `yard_overrides_total{kind}` | A rising rate means people don't trust the plan |

Logs are structured JSON (pino) with the solve id. `yard_state_log` is the human-readable story of a shift, and each job stores its input snapshot, so a surprising plan can be reproduced exactly.

Alert on a planner plan failing the validator, on no successful solve for 10 minutes with open triggers, and on a hold alert left open.

## Failure Handling

| Failure | What happens |
|---------|--------------|
| Planner down | Crews keep the published list and keep reporting. Triggers queue. When it returns, one coalesced replan reads the state those reports produced |
| Worker killed mid-solve | Lease expires; another worker reclaims; no partial plan can exist |
| Solve exceeds its budget | Time limit returns best so far |
| Solve keeps failing | After 4 attempts the job fails, and an alert says crews are on the last published plan |
| Plan fails the validator | Stored as a draft, not published; critical alert |
| Handheld offline | Reports queue with client ids and event times, and sync out of order safely |
| Hold feed down | Holds are late, but every hold that arrives is rechecked at publish, start and departure. Production also needs a staleness alarm on the feed |
| Bad hold event | Dead-lettered with its error; the group keeps moving |
| Host stall | Leases and retries use the database clock; the simulator's clock is separate and explicit |
| API instance down | Stateless; sessions are in Valkey |

## Scalability Considerations

**First to break: the per-yard row lock during report bursts.** Every report takes it. At shift start with many crews and offline queues flushing, this is where latency appears. Evidence: every write path is designed around it, and `yard_publish_total{outcome="stale_state"}` plus lock wait time would show it first. Fix: stop taking the lock for as-planned reports and take it only for surprises. As-planned reports don't touch what publish checks.

**Second: planner CPU.** Solves are CPU-bound for their whole budget, and a storm across yards queues them. Fix: one solve per yard (already true), workers on dedicated cores, budgets that shrink under load. The per-yard design means this scales by adding workers.

**Third: plan storage.** Every replan copies the whole list. At 50 versions a shift this adds up. Fix: store moves by content hash, since most moves are unchanged between versions, and archive superseded versions after a few weeks.

**Horizontally:** yards share nothing, so partition by `yard_id`. Each yard could be its own database schema or its own small instance, which also limits the blast radius of a bad deploy.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Search | Decoder + annealing | CP-SAT / MILP | Any-time, easy stability and locks; no bound on full shifts |
| Plan check | Independent validator | Trust the planner | Catches planner bugs; same path for human edits |
| Concurrency token | State version counting surprises | Version every write | Plans can publish while crews work |
| Stale publish | Reject and recompute | Rebase automatically | A rebase is a replan anyway; don't hide it |
| Plan storage | Immutable versions with stable move keys | Mutable plan with history | Diff, audit and rollback for free; costs storage |
| Replan cost | Penalize changes; freeze and horizon | Solve from scratch | 26 vs 39 moves disturbed in the seeded case |
| Soft override | Change the underlying fact | Validator exception list | Nothing to expire; loses per-move nuance |
| Offline reports | Client ids, event-time watermark per car | Server-assigned order | Late sync lands correctly |
| Hold rechecks | Plan, publish, start, departure | At planning only | A hold can land at any moment |
| Auto-publish | Routine replans publish; consequences stop | Approve everything | Yardmaster isn't a rubber stamp |
| Coalescing | Quiet window + max wait, single flight | One solve per trigger | A burst is one situation |
| Job queue | PostgreSQL with leases | RabbitMQ | One commit covers job and plan |
| Hold feed | Valkey stream + webhook (Kafka in production) | Direct call to #19 | Same envelope; decoupled |
| Board updates | Polling at 2 s | WebSocket | Freshness is enough; simpler |

## Implementation Notes

This is what actually runs: an Express API (two instances), a planner worker, a simulator process, PostgreSQL, Valkey and a React frontend.

### Production-grade patterns actually implemented

**Durable solve with a fenced result.** At scale, workers die and stall, and a stale result must not overwrite a newer one. `backend/src/worker/jobs.ts` claims with `FOR UPDATE SKIP LOCKED` and a lease on the database clock. `backend/src/worker/run-plan.ts` commits the version, the job status and any publish in one transaction after re-checking the token.

**Independent validator.** `backend/src/validator/validate.ts`, with a test that forbids planner imports.

**Idempotent event consumer.** `backend/src/holds/apply.ts`: dedupe on event id, fold by stream version, tolerate unknown cars and types.

**Event-time fold for reports.** `backend/src/execution/reports.ts`: a report older than the car's watermark can't move it.

```typescript
await client.query(
  `UPDATE cars SET track_id = $2, position = 'on_track', coupled_to = $3, coupled_seq = $4, position_as_of = $5
    WHERE id = $1 AND position <> 'departed' AND (position_as_of IS NULL OR position_as_of <= $5)`,
  [id, toTrackId, coupleTo, coupledSeq, at.toISOString()],
)
```

**Coalesced triggers.** `backend/src/worker/coalescer.ts`.

**Metrics and logs.** `backend/src/shared/metrics.ts` (prom-client), `backend/src/shared/logger.ts` (pino).

**Immutability in the database.** Triggers in `backend/src/db/init.sql` refuse edits to moves and version content. It's the last line of defence if application code gets it wrong.

### What was simplified or substituted

| Production | Here |
|------------|------|
| Kafka `cases` topic from #19 | Valkey stream plus a webhook, same envelope |
| Dispatch and yard systems | Simulator, through the same API |
| Real yard geometry: ladders, leads, in-track order, doubling | A track is a capacity in feet; a pull can arrange cars within a block; one block per class track |
| Hump mechanics, retarder tracks, engine moves | A crew is a queue with per-car durations (illustrative) |
| Real hazmat rules | Simplified buffer and adjacency, labelled as such |
| Multiple crews per job | One hump crew, one trim crew |
| Device identity on handhelds | Session login, and a simulated offline toggle |
| Rip track for bad-ordered cars | A held car stays where it stands, or sets out to its block's track |
| Plan storage by content hash | Every version stores every move |
| Many yards | One yard |

### What was omitted

CDN, multi-region, Kubernetes, per-yard database partitioning, a CP-SAT solver, an ML model for dwell or crew speed, real device management, and notifications beyond the board's alerts. The inspection and repair variant is designed above but not built.
