# LLM Eval Dashboard — System Design Answer (Frontend Focus)

*Frontend interview · 45 minutes · Users → Contract → Architecture and state → Run pages → Compare → Datasets → Key question → Deep dives → Traces*

> "An eval dashboard answers one question for a team that ships prompts: is this change actually better? Developers pin a dataset version, a prompt version, a model config and scorer versions, start a run that executes every case several times, and compare runs. The frontend's job is to make a number hard to misread. Every mean travels with its 95% interval and its errored count. A comparison shows what changed before it shows by how much, and 'not significant' is as prominent as 'improvement'. A run that lost cases to a provider outage says 'completed, 5 errored', never a clean average of the survivors. And the browser never computes a verdict: it renders the server's classification, so the claim on screen is the same claim the API, the tests and a future CI gate make."

| Phase | Time | Focus |
|-------|------|-------|
| Users and requirements | ~4 min | Who reads the numbers, what they must never misread |
| The contract the UI depends on | ~3 min | Endpoints, the aggregate object, verdict codes |
| Architecture and state | ~6 min | Routes, state by kind, the run lifecycle on screen |
| Run pages | ~6 min | Progress, aggregate cards, per-case table, actions |
| Compare, datasets, annotation | ~6 min | Verdict, provenance, checklist, versions, 409 |
| The key question | ~3 min | What must hold before "improvement" |
| Deep dives | ~12 min | Comparison view; showing uncertainty; polling vs SSE |
| Traces, checklist, follow-ups, wrap-up | ~5 min | One success, one failure |

---

## 🎯 Users and Requirements (~4 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who reads the results? | Density, vocabulary | Prompt and app engineers, plus reviewers who open a comparison link from a pull request |
| How long is a run? | Progress UX, reload safety | 500 cases × 5 samples = 2,500 tasks typical, 100k at most; minutes to an hour |
| How fresh must progress be? | Push vs poll | A second or two; one task takes seconds |
| Who decides "improvement"? | Where statistics live | The server, in one tested implementation; the UI renders its verdict |
| How large can tables get? | Rendering strategy | Hundreds of cases typical, tens of thousands at the extreme |

### Functional requirements

1. Start a run from pinned versions with a sample count and concurrency limit; a double click or a lost response never starts two runs.
2. Watch progress live: succeeded, errored, cancelled, pending, running, live leases, model calls, tokens and latency.
3. Per scorer version: mean, 95% interval, cases scored, errored count, flaky cases; drill into any case, sample, score and attempt.
4. Cancel, retry only the errored tasks, re-score stored outputs with a new scorer version.
5. Compare two runs paired by case: verdict, every pin side by side, warnings, a requirements checklist, per-case differences.
6. Version datasets, prompts and scorers; show a case-level diff; never let a stale edit overwrite a newer version.
7. Review a human-annotation queue and see judge-versus-human agreement.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Honest aggregates | No mean without its interval, n and errored count | Components take the server's aggregate object, not a bare number |
| Honest comparisons | No improvement claim across mixed pins | The verdict, provenance and checklist come from one server response |
| Progress freshness | ≤ 2 s on the run page | Polling at 1.5 s (detail) and 3 s (cases) |
| Idempotent submit | One run per intent | Idempotency-Key minted once per form |
| Large tables | 500 cases interactive; tens of thousands usable | Client filters now; virtualization and server filtering past a few thousand rows |
| Accessibility | Colour never the only signal; charts have text | Words on chips, numbers next to bars, aria labels |

---

## 📜 The Contract the UI Depends On (~3 min)

```
POST /api/v1/runs                       Idempotency-Key; 201 new, 200 replay, 422 key reused
GET  /api/v1/runs                       status, progress, primary mean ± CI, errored count
GET  /api/v1/runs/:id                   pins, progress, usage, aggregate per scorer version
GET  /api/v1/runs/:id/cases             per case: samples, outputs, scores, labels, stats
GET  /api/v1/runs/:id/case-results/:cr/attempts      attempt history of one sample
POST /api/v1/runs/:id/cancel            idempotent; reports cancelled tasks
POST /api/v1/runs/:id/retry-errored     409 while running; requeues errored only
POST /api/v1/runs/:id/rescore           {scorerVersionId} → 202 {queued, alreadyScored}
GET  /api/v1/compare?a=&b=&scorer=      provenance, statistics, verdict, per-case table
POST /api/v1/datasets/:id/versions      {baseVersion, message, cases}; 409 stale, 422 unchanged
GET  /api/v1/datasets/:id/diff          added / removed / modified (fields) / unchanged
GET  /api/v1/runs/:id/annotations       queue + agreement; PUT …/annotations/:cr labels
GET  /api/v1/system                     mock model and judge counters; PUT arms chaos
```

**The aggregate object.** Every aggregate carries the mean, a Student-t 95% interval, a bootstrap interval, scored cases out of total, errored tasks and errored cases, partial cases, unscored or still-scoring counts, and flaky cases. The UI components accept that object, not a number, so there is no code path that renders a mean on its own.

**Verdict codes** the compare page must render differently:

| Code | When | Card |
|------|------|------|
| improvement / regression | Every requirement holds; paired CI above / below zero | Green / red, wins-losses-ties in the detail |
| not_significant | Paired CI crosses zero | Neutral white, as large as an improvement |
| confounded | Prompt and model config both changed | Amber: "B is better, but the cause is unknown" |
| not_claimable | A run unfinished, > 10% excluded, one sample at t > 0, or nothing changed (A/A) | Amber, lists the unmet requirements |
| indicative_only | Dataset versions differ: unpaired over unchanged shared cases | Amber, "Pairing: impossible" |
| not_comparable | Different datasets, or no scorer version scored fully on both | Red, with a re-score button when that fixes it |
| insufficient_data | Fewer than two cases scored in both | Neutral |

> "Eight codes is more vocabulary than a single delta, but each one tells the reader something different to do: wait, retry errored cases, re-score, re-run on the same dataset version, or change one factor."

---

## 🏗️ Architecture and State (~6 min)

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ Root layout: session check once, redirects in an effect, nav shell           │
 ├─────────────┬─────────────────┬───────────────┬──────────────┬───────────────┤
 │ /runs       │ /runs/:id       │ /compare      │ /datasets/:id│ /annotate/:id │
 │ RunsTable   │ RunHeader       │ ?a=&b=&scorer │ VersionList  │ Agreement     │
 │ /runs/new   │ ProgressPanel   │ VerdictCard   │ VersionDiff  │ QueueItems    │
 │ NewRunForm  │ AggregateCards  │ Provenance    │ JSON editor  │               │
 │             │ SamePinsTable   │ Requirements  │ (+ /prompts, │ /system       │
 │             │ CaseTable       │ CompareCases  │  /scorers)   │ MockCards     │
 ├─────────────┼─────────────────┼───────────────┼──────────────┼───────────────┤
 │ poll 2 s    │ poll 1.5 s,     │ fetch when    │ poll 15 s    │ poll 10 s,    │
 │             │ cases 3 s       │ the URL moves │              │ system 2 s    │
 └──────┬──────┴────────┬────────┴───────┬───────┴──────┬───────┴───────┬───────┘
        └───────────────┴────────────────┼──────────────┴───────────────┘
                    ┌────────────────────▼────────────────────────────┐
                    │ api service: typed calls through one request(), │
                    │ ApiError(status, server code), Idempotency-Key  │
                    └────────────────────┬────────────────────────────┘
                                         ▼ /api/v1, session cookie, workspace-scoped
```

**Routing.** File-based TanStack Router routes. The root layout checks the session once and redirects in an effect when auth state changes, never by rendering a redirect during render. The compare route validates its search params (a, b, scorer), so a pasted link is the comparison.

### State, by kind

| State | Where | Why there |
|-------|-------|-----------|
| Session user and workspace | Small Zustand store | The only global state: shell, nav, route guard |
| Runs list, run detail, cases, dataset, queue, system | A `usePoll` per page | Durable server state; a refetch is the sync |
| Comparison result | Fetched when the URL's a/b/scorer change, and after a re-score | Derived on read server-side; the URL is its key |
| Compare selection (a, b, scorer) | URL search params | Shareable in a PR, back button works; a run's Compare button pre-fills a |
| Selected scorer card, case filter, open row, dialog | Component state | Nobody else needs it |
| New-run fields and the Idempotency-Key | Form state; key minted once at mount | The key names this intent, not each click |
| Dataset, prompt or scorer edit buffer | Editor state, with its base version | Unsaved; the base version is the concurrency token |

> "I didn't reach for TanStack Query. Every screen is a poll of a server snapshot, and a forty-line hook covers it: fetch now, refetch on an interval, skip ticks while the tab is hidden, keep the last good data when a poll fails. All calls go through one service, so moving to a query cache later is mechanical."

### The run lifecycle as the screen shows it

```
            claim                every task terminal
 queued ──────────▶ running ─────────────────────────▶ completed   (failed if nothing succeeded)
   │                   │                                   │
   └──── Cancel ───────┴──▶ cancelled                      │ Retry N errored
                                                           ▼
                                                 running (retry round k+1)
```

Buttons are derived from the polled status: Cancel while queued or running, "Retry N errored" when finished with errors, Re-score when not active, Annotate and Compare always. The UI never sets a status itself. An action's response becomes a note ("Cancelled; 41 queued tasks will not run") followed by an immediate refetch.

---

## 📊 Run Pages: Progress and Honest Aggregates (~6 min)

### Runs list

Each row shows the status as a word chip: "completed, 3 errored" is amber with the count in the text. Next to it is a segmented progress bar (succeeded, errored, cancelled, running) with "done/total" beside it and an aria label. The primary score reads "0.955 ± 0.050 · n = 22 cases · 3 errored excluded". A failed run says "no successful cases (N errored)" instead of a zero. The pins column shows dataset and prompt versions in bold. The list polls every 2 s.

### Run detail, top to bottom

1. **Header.** The name, status chip and a "retry round k" chip. Every pin is shown: dataset vN and prompt vN (linked), then model, temperature, max tokens, seed, samples and limit. Then the actions.
2. **Progress panel.** Eight stats: Succeeded of total; Errored ("excluded, never averaged"); Cancelled; Pending · running with "3/4 leases live"; Model calls ("attempts, incl. retries"); tokens in and out; average queue time; average TTFT and generation time.
3. **Aggregate cards**, one per scorer version. Each shows the mean, "95% CI [lo, hi]" and a CI bar on a fixed [0, 1] axis. Below that: "n = 22 of 23 cases" and "3 errored (1 case) excluded", shown in grey even at zero. It also lists partial cases, "k scoring…" while judge scores are pending, the flaky count, and the bootstrap interval. A violet "re-scored" chip marks versions added after the run. Clicking a card switches the case table to that scorer.
4. **Same pins, different sample counts.** Sibling runs that differ only in samples, with interval half-widths as bars: ×1 ± 0.130, ×5 ± 0.031, ×10 ± 0.020. The note explains that extra samples shrink per-case noise, not the spread between easy and hard cases.
5. **Per-case table.** Filter tabs with counts: all, errored, flaky (samples disagree), failing. The flaky filter sorts by variance. A row shows the case key and tags, an input preview, the reference, and one dot per sample (colour plus a tooltip with status and score). Then the case mean, or "errored ×3" if nothing scored, and the variance with "flaky". Expanding a row shows every sample: its status, number of attempts, tokens, queue, TTFT and generation time, the error code and message, the output, a score for each scorer version with confidence and judge rationale, and any human label. An "attempts" link fetches that sample's history on demand.

> "An aggregate is a claim and the drill-down is its evidence. When a reviewer asks why a case is at 0.4, the answer is two clicks away: five outputs, five scores, and the 429 that was retried in between."

### Actions

- **Cancel** returns the number of queued tasks that will not run. On the system page, active model calls drop to zero within about 20 ms.
- **Retry N errored** appears only on a finished run with errors. It confirms "Re-queued 3 errored tasks; successful ones are untouched", and the header shows the retry round.
- **Re-score** opens a dialog listing only the scorer versions not yet on the run. It says outputs won't be generated again and existing scores are kept. The result reads "Queued 115 score tasks over stored outputs … Model calls for this run stay at N". In the seed, JSON-shape v1 can't parse fenced output and scores the orders run 0.000. v2 strips fences, and the same stored outputs score 0.806.

---

## ⚖️ Compare Page (~3 min)

```
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ Run A (baseline) · Run B (candidate) · Scorer       ← URL ?a=&b=&scorer=     │
 ├──────────────────────────────────────────────────────────────────────────────┤
 │ IMPROVEMENT · LABEL CONTAINS V1                                              │
 │ Improvement: Δ +0.218, 95% CI [+0.064, +0.373]                               │
 │ Mean A 0.755 │ Mean B 0.973 │ Paired Δ +0.218 │ W/L/T 9/2/11 │ Excl. 1 of 23 │
 │ −1 (B worse) ──────────────────│0──────●═══════════─────────── +1 (B better) │
 │ [ Re-score A with v2 (no new generations) ]   ← only on a scorer mismatch    │
 ├────────────────────────────────────────────────┬─────────────────────────────┤
 │ PROVENANCE: every pin, A │ B                   │ BEFORE CALLING IT AN        │
 │ dataset · prompt (CHANGED) · config, model,    │ IMPROVEMENT: six ✓ / ✗      │
 │ temperature, max tokens, seed · samples ·      │ rows, each with its detail  │
 │ scorer (DIFFERS) · warnings with their codes   │                             │
 ├────────────────────────────────────────────────┴─────────────────────────────┤
 │ Per case: key · input · mean A · mean B · Δ, largest regression first        │
 │   ▸ expand: reference, then every sample of A and of B side by side          │
 └──────────────────────────────────────────────────────────────────────────────┘
```

The card's colour follows the code, and the code is also printed in capitals at the top. The diverging CI bar has a drawn zero tick and labelled ends. It turns grey when the interval crosses zero, and green or red otherwise. Provenance rows that must match say "DIFFERS" (rose), factor rows say "CHANGED" (amber), and every warning carries its code (ERRORED_CASES_EXCLUDED, MIXED_DATASET_VERSIONS, MULTIPLE_FACTORS_CHANGED). Per-case deltas are signed as well as coloured.

> "The not-significant case is the one that justifies this layout. Triage v3 against v2 on exact label: the mean falls from 0.973 to 0.891, but the card reads 'Not significant: Δ −0.082, 95% CI [−0.190, +0.026]', 3 wins, 6 losses, 13 ties. The first row of the table is t-008 at −0.800, an easy case the few-shot prompt now gets wrong in four of five samples. That is a lead to investigate, not a regression to announce."

---

## 🗂️ Datasets and Versions (~2 min)

- **Version list**: a head chip, the commit message, case count, runs on that version, author, and a content-hash prefix. Selecting a version shows its cases and a diff against the previous version: "+4 added · −1 removed · ~2 modified · 17 unchanged" for support-triage v1 → v2. Modified cases name the changed fields and show the reference before and after ("t-010 reference technical → account"). A footnote explains that runs on the two versions can't be paired case by case.
- **Editing** opens the whole case list as JSON with a required "what changed and why" message and a "Save as v3" button. Invalid JSON is caught in the browser. The POST carries `baseVersion`. A stale base returns `409 VERSION_CONFLICT`, which is shown with the buffer intact. Identical content returns `422 NO_CHANGES`. Prompts and scorers follow the same pattern.

> "The trap is where the base version comes from. It has to be captured when the editor opens, not read from the polled dataset head at save time. If the page's 15-second refresh fed the new head into an open editor, the edit would be silently rebased onto a colleague's version. That is exactly the lost update the 409 exists to catch."

## 🏷️ Annotation and the Mock Page (~1 min)

- **Annotation queue**: each item has reason chips (judge unsure, samples disagree, random spot check), the output beside the reference, and the judge's verdict, confidence and rationale. Pass and Fail buttons take a note, and a label is an upsert. The agreement panel reports, per judge version, rate, agree/n and Cohen's κ in three columns: all labeled, random spot checks, low confidence or disagreeing. Only the spot-check column estimates how far to trust the judge; items chosen because the judge was unsure are biased toward disagreement by construction.
- **Mock page**: queue counters (active runs, pending tasks, live leases, pending scores). For the model and the judge: calls (total, active, peak), outcomes, and chaos buttons ("+1 rate_limit (2 armed, 0 fired)") that fail exactly the next N calls. This is where you watch re-scoring add zero model calls.

---

## 🔑 The Key Question (~3 min)

**"The prompt, the dataset and the scoring function all changed. What information is required before a comparison can be called an improvement?"**

> "For that pair, nothing can be claimed. Three things moved, so no number isolates any of them. The work is to rebuild the comparison until exactly one thing differs, and the UI's job is to say so plainly and offer the cheapest next step."

| # | Requirement | Why | How the UI gets you there |
|---|-------------|-----|---------------------------|
| 1 | Same scorer version, fully scored | A scorer change changes what "better" means | "Re-score A with vN" button: zero generations. Then validate the new scorer against human labels on the annotation page |
| 2 | Same dataset version | Scores move across versions with no system change | Re-run A's prompt on B's dataset version from the New run form (this costs generations) |
| 3 | Exactly one factor changed | Prompt and config together are confounded | The provenance row shows CHANGED on each factor; two factors give the amber "cause unknown" verdict |
| 4 | Both runs finished; errored cases listed; ≤ 10% excluded | Survivorship can manufacture a gain | "Retry N errored"; above 10% excluded, the checklist row flips to ✗ with "N of M cases excluded" |
| 5 | ≥ 2 samples per case unless temperature 0 | One sample hides per-case noise | The form defaults to 5 with the hint "≥ 2 at temperature > 0"; SAMPLES_TOO_FEW warning |
| 6 | Paired 95% CI on per-case differences excludes zero | A mean can rise while a category regresses | The diverging bar with zero marked, win/loss/tie, the case table sorted by regression |

**What the screen shows for the three-way pair.** The verdict card is red: "Scores not comparable", with SCORER_VERSION_MISMATCH and a "Re-score A with v2 (no new generations)" button. The dataset row says DIFFERS, with MIXED_DATASET_VERSIONS beneath it. The checklist has a ✗ on both "same dataset version" and "same scorer version". After the re-score, the card turns amber at best: "Unpaired, indicative only". It shows a Welch interval over the unchanged shared cases and "Pairing: impossible". That is deliberate. In the seed, the same prompt and config score 0.890 on dataset v1 and 0.973 on v2, while on the 17 unchanged shared cases the difference is exactly zero. A headline would have credited the prompt with eight points the dataset edit produced. The verdict says "improvement" only when all six rows are ✓.

> "Re-scoring doesn't settle the scorer question either. In the seed, the stricter judge rubric flips verdicts and also disagrees with reviewers on padded-but-correct answers. So before I trust a changed scorer, I look at its spot-check agreement, not its queue agreement."

---

## 🔧 Deep Dives (~12 min)

### Deep dive 1: The comparison view — provenance and requirements before the number

**Decision.** The compare page renders one server response that holds the verdict, the paired statistics, every pin side by side, coded warnings and a six-row requirements checklist. Its headline is a verdict sentence, never a bare delta. The browser computes no statistics: the server's provenance classifier and statistics module (unit-tested, and recomputed independently by the e2e to 1e-4) are the only implementation.

**Why it works here.** The question users bring is causal: did my prompt change make it better? A causal claim needs three things: the comparison is controlled (one factor changed), the measurement is the same (same dataset and scorer version), and the difference exceeds the noise (a paired interval clear of zero). Each of those is a row on screen, so the reader sees why a verdict is what it is. A reviewer opening the link from a pull request sees "prompt version CHANGED" and six checks, and needs nothing else. Because the server decides, a CI gate calling the same endpoint can never disagree with the screen. The per-case table sorted by largest regression gets the reviewer to the cases that need reading.

**Why the alternative fails.** A single headline like "B: 0.973 vs A: 0.755 (+29%)" walks straight into all three traps the brief names:
- **Two single runs.** At one sample per case the interval is ± 0.130, so a ten-point move is inside the noise, and the headline can't show that.
- **Survivors averaged.** If B errored on its three hardest cases, its mean rises by failing.
- **Mixed versions.** The dataset edit alone moved 0.890 to 0.973, and fixing the JSON scorer moved 0.000 to 0.806 on identical outputs; a headline would credit both to the prompt.

A percentage of a mean also hides the 2 losses among 9 wins, which could be one category quietly regressing. Computing the delta in the browser makes it worse: a second implementation of pairing and exclusion that drifts from the server's.

**What I give up.** Speed of reading and screen space: a verdict, a provenance table and a checklist take more scrolling than a number. The page refuses to answer some questions people want answered ("just tell me if v3 is better"), which can feel bureaucratic. Eight verdict codes are vocabulary to learn. The comparison is also a point-in-time read, not polled, so after a re-score it reloads once after a moment. If the judge is still scoring, the "fully scored" row stays ✗ until coverage completes. That costs a manual reload, but it means a half-scored run can never produce a verdict.

### Deep dive 2: Showing uncertainty — interval, errored count and flaky cases next to every aggregate

**Decision.** No mean appears without its 95% interval (over per-case means), n of total cases, and the errored count. That holds in the runs list, the aggregate cards and the comparison. Intervals are drawn on fixed axes: [0, 1] for scores and [−1, 1] for differences, with zero marked. Flaky cases (samples disagree) have their own filter and count. The same-pins table shows how the interval narrows with more samples.

**Why it works here.** The case is the unit of analysis. Samples of one case share an input and a reference, so pooling 110 samples as independent would make intervals about √5 too narrow, and the UI would display false confidence. Showing the interval next to the mean puts noise in the same glance as the signal: at ×1 ± 0.130 nobody should read a 0.08 move, and at ×5 ± 0.031 they can. Claims are sample-major (every case's first sample before any second), so even an early, partial aggregate covers all cases rather than the fast easy ones. Its wide interval tells the truth about how early it is. Fixed axes keep visual size honest: a 0.02 difference looks small because it is small.

**Why the alternative fails.** Bare averages fail in three ways:
- **Silently averaging survivors.** A run that hit context overflow on its three hardest cases shows 0.955 and looks better than a run that completed them. Failing gets rewarded.
- **No sense of noise.** Users rerun until they get the number they like, then compare two draws.
- **Autoscaled axes.** Chart libraries zoom to the data range, so 0.955 vs 0.973 fills the chart and reads as a landslide.

Treating errored cases as zero instead is just as wrong in the other direction: it turns provider weather (429s that ran out of retries) into a regression. The honest option is to exclude errored cases from both sides, count them, and show the count.

**What I give up.** Visual calm. Cards are dense, and "0 errored (0 cases) excluded" in grey is clutter on a clean run. I keep it because the absence of the line would be ambiguous. Two intervals (t and bootstrap) can confuse when they differ, as with [+0.064, +0.373] and [+0.082, +0.373], so the bootstrap is de-emphasised. Users also have to learn to read intervals, and some will still screenshot the mean alone. The runs list keeps "± 0.050" in the same cell so a screenshot carries it.

### Deep dive 3: Live progress — polling a snapshot vs pushing events over SSE

**Decision.** Every live screen polls a snapshot through `usePoll`: run detail every 1.5 s, the case table every 3 s, the runs list and system page every 2 s. Ticks are skipped while the tab is hidden, the last good data is kept on error, and every action triggers an immediate refetch. There is no SSE and no WebSocket.

**Why it works here.** The run page shows derived state: counts, live leases, means and intervals computed on read from rows. That is a picture of now, not a stream of events. A task takes seconds, so a 1.5 s poll moves the counters by a handful each tick and looks live. A snapshot is self-healing: a reload, a second tab, a laptop waking from sleep or a colleague opening the link all converge on the next fetch. No resume cursor is needed. It also handles the awkward cases for free. Retry-errored reopens a "completed" run and re-scoring adds pending scores, and neither needs special events, just the next snapshot. Every poll goes through the same workspace-scoped endpoint as the first load. And pages go network-idle, which the screenshot and smoke-test harness depend on.

**Why the alternative fails.** Pushing task events over SSE means the browser must turn events into means and intervals. That puts a second statistics implementation in the client: pairing, exclusion and a seeded bootstrap that must match the server's. When it drifts, the run page and the comparison disagree. A disconnected tab misses events, so it needs Last-Event-ID replay or a snapshot fetch on reconnect. Either way the snapshot path must exist too, and SSE becomes extra machinery on top of it. Event volume doesn't match what anyone can read: at production scale the fleet finishes ~2,000 tasks a second. Pushing a whole snapshot over SSE every second gives the same freshness as polling, with connections held open per tab through the load balancer.

**What I give up.** Up to 1.5 s of staleness: cancel stops model calls in ~20 ms, but the counters show it on the next tick, so the action's own response note gives the immediate feedback. Repeated payloads are the bigger cost. The cases poll re-downloads every output every 3 s, about 5 MB per poll for a typical 2,500-task run at 2 KB per output. That is the first thing to fix at scale: a case summary endpoint without outputs, outputs fetched on drill-down, ETag/304 on unchanged snapshots, and slower polling once a run is terminal (slower, not stopped, because retry and re-score reopen it).

---

## 📜 Execution Traces (~4 min)

### Successful trace: start a run, watch it, compare it

1. **Browser.** Alice opens /runs/new. The page loads datasets, prompts, model configs and scorers in parallel, then each dataset's and prompt's versions, so every select lists a version: "support-triage v2 (23 cases)", "Ticket triage v2: categories + tie rule". The form mints its Idempotency-Key at mount and shows it in the footer.
2. **Browser.** She picks 3 samples, limit 4 and three scorer versions, and clicks Start run. The button disables and reads "Starting…"; the POST carries the key.
3. **API.** It checks that every pin belongs to her workspace and that the template's variables exist in every case: a missing variable is a 422 now, not 69 errored tasks later. In one transaction it inserts the run (queued), 3 run_scorers rows and 69 case_results, sends NOTIFY, and returns 201.
4. **Browser.** It navigates to /runs/:id and starts two polls: detail every 1.5 s, cases every 3 s.
5. **Workers and DB.** Worker-1 locks the run row and claims t-001/0, and the run becomes running. Worker-2 finds the row locked, retries ~10 ms later and claims the next task. Claims stop at 4 live leases, and the panel reads "4/4 leases live".
6. **Mock and worker.** Worker-1 calls the mock with seed 29,000. The first token arrives at 230 ms and the done event at 245 ms. One fenced transaction writes the output and three inline scores. On the next poll, Succeeded ticks up and the aggregate cards appear with wide intervals over a first pass that covers every case once.
7. **Mock.** t-023, a long log, returns `400 context_length_exceeded` for all three samples. That is permanent, so each is errored after one attempt. Errored turns red at 3, the row reads "errored ×3", and the drill-down shows the message.
8. **Worker and DB.** The last task's worker finalizes the run to completed. On the next poll the chip reads "completed, 3 errored", and the Exact label card shows "0.955 ± 0.050 · n = 22 of 23 · 3 errored (1 case) excluded". "Retry 3 errored" is offered, but the error code is context_length_exceeded (the log doesn't fit mock-small), so a retry would fail the same way and she leaves it.
9. **Browser and API.** She opens Compare with the v1 baseline as A, her run as B, and scorer Label contains; that URL is what she pastes into the PR. On the seeded ×5 pair the card reads "Improvement: Δ +0.218, 95% CI [+0.064, +0.373]", with 9/2/11, 1 of 23 excluded, only "prompt version" CHANGED, and six checks. The case table opens on the two losses.

### Failed trace: the response is lost, the provider throttles, a worker dies

1. **Browser.** Alice starts "Triage v3" (23 cases × 5, limit 4). The POST carries the form's key.
2. **API.** It commits the run and 115 tasks in one transaction, and workers start claiming. The 201 never arrives: her Wi-Fi drops.
3. **Browser.** fetch rejects. The api service raises a NETWORK error, "Could not reach the server", which the form shows under the fields while it re-enables the button. The fields and the key are unchanged, because the key lives in the form, not in the click.
4. **Browser and API.** She clicks Start run again. Same key, same body: the API finds (workspace, user, key) with a matching request hash and answers `200` with the existing run (`Idempotent-Replayed: true`). The browser lands on a run that is already making progress, and the runs list has one run, not two. Had she changed the sample count before retrying, the hash would differ and the `422 IDEMPOTENCY_KEY_REUSED` would be shown verbatim. A fresh form mints a new key.
5. **Mock and worker.** Worker-2 gets `429, Retry-After: 1`. It is classified rate_limited, the task returns to pending with `available_at = now() + 1 s`, and Model calls climbs faster than Succeeded. That sample's attempts read "#1 retry_scheduled · rate_limited (429) · retry in 1.0 s · worker-2", then "#2 succeeded · worker-1".
6. **Worker.** Worker-1 is SIGKILLed while holding 6 leases. Its sockets close, so the mock stops those generations. In the DB the rows stay running until the leases expire, 4 s later locally. Nothing has failed yet, so the page shows no error: those six tasks just don't finish for a moment.
7. **Worker and DB.** After expiry, Worker-2's claim matches the six expired leases, increments their attempts and marks attempt 1 lease_expired. Counts resume on the next poll, and the drill-down reads "#1 lease_expired · worker-1", "#2 succeeded · worker-2". The unique (run, case, sample) key and `ON CONFLICT DO NOTHING` on scores mean n never double counts. If worker-1 had only frozen and woken with a result, its fenced write would match zero rows and the attempt would read superseded.
8. **Result.** The run completes. The e2e runs this exact path on a 46-task run: 6 expired leases, 46/46 rows, no duplicate scores, completed 7 s after the kill.

---

## ✅ Design Review Checklist

| # | Question | Answer (frontend view included) |
|---|----------|----------------------------------|
| 1 | Source of truth; when is a write successful? | PostgreSQL. A run exists when its creation transaction (run plus every task) commits; the UI treats it as started only when it holds the returned id. Outputs commit with their inline scores. Aggregates and verdicts are derived on read. The browser holds no truth beyond the unsaved form and edit buffer |
| 2 | Client retries after losing the response? | The Idempotency-Key is minted once per form, so a retry or double click gets the same run (`200`); a changed body gets `422`. Cancel, retry-errored and re-score are idempotent ("already finished", 0 requeued, 0 queued with N already scored). Labels are upserts. A version save retried after a lost response gets `409`: the head is now your own version, which the version list shows |
| 3 | Worker or server fails between steps? | Leases expire and another worker re-claims; fencing discards a stale writer. The UI shows a brief stall, then attempts reading lease_expired or superseded. A missed finalize is caught by the sweeper and the status flips on the next poll. An API crash mid-create rolls back, and the retry uses the same key |
| 4 | Which ordering or consistency is required? | None across tasks. Run status transitions are guarded, one winner. The UI needs consistency per response: the comparison is one request, so its verdict, provenance and table always agree. Detail and cases poll separately, so the table may lag the cards by one tick |
| 5 | Access with caches, indexes, async jobs? | Every endpoint filters by the session's workspace; cross-workspace ids return 404, so a comparison link opened from another workspace shows not found and leaks nothing. Workers never decide access; they act on rows checked at creation. The UI hides nothing for security; the server enforces it. The mock page is local infrastructure |
| 6 | What breaks first at scale, and evidence? | Server: the claim path on the primary, ~5-6 row writes per task, ~12k/s at 2,000 tasks/s. Client: the cases poll (2,500 tasks × 2 KB ≈ 5 MB every 3 s per open tab), then rendering a table of tens of thousands of rows. Fixes: summary payloads, outputs on demand, ETags, virtualization |

---

## 🪤 The Traps the Brief Names

| Trap | What goes wrong | What the UI does |
|------|-----------------|------------------|
| Comparing two single runs | Noise reads as signal (× 1 ± 0.130) | The form defaults to 5 samples; SAMPLES_TOO_FEW; the checklist row; the same-pins table shows the width |
| Silently averaging survivors | Failing hard cases raises the mean | "completed, N errored"; errored cases excluded from both sides and counted; > 10% flips a requirement; Retry N errored |
| Different dataset or scorer versions | Measurement change credited to the prompt | DIFFERS rows; not comparable or indicative only; a re-score button; a dataset diff that explains why |

---

## ❓ Follow-ups the Answer Must Handle

**How does the UI flag a comparison that mixes versions?**
> "Provenance shows every pin for A and B. Dataset and scorer rows must match and say DIFFERS in rose; prompt and config are factors and say CHANGED in amber. Coded warnings explain the consequence, and the verdict can't be 'improvement' while any of them stands."

**A run finishes with five errored cases. What does the user see?**
> "'completed, 5 errored' on the chip, the count on every aggregate, an errored filter on the case table, the error code on each sample, and a 'Retry 5 errored' button that requeues only those tasks into the same run."

**Outputs are nondeterministic. How do you show whether a difference is real?**
> "Samples per case, an interval over per-case means, a paired interval for comparisons, and 'not significant' whenever it crosses zero. The flaky filter shows which cases are noisy."

**The scorer was wrong. How do you fix old numbers without regenerating?**
> "Create a new scorer version, then re-score: the dialog queues score tasks over stored outputs, the model call counter stays put, and the old version's scores remain for audit."

**Two people edit the same dataset.**
> "Each save names its base version; the second gets a 409 with their buffer kept. Versions are immutable, so nothing either person saved is ever lost."

**A run takes an hour and the user closes the tab.**
> "The run is a server record; nothing depends on the tab. Reopening the run page resumes from the next snapshot, and polling paused while the tab was hidden."

**A 10,000-case run: what does the per-case table do?**
> "Today it renders every row and filters in the browser, which is fine at hundreds. Past a few thousand I'd virtualize rows with @tanstack/react-virtual, with measured heights for expanded rows, and move filter, sort and paging to the cases endpoint so the payload shrinks too."

**How do you know the judge can be trusted?**
> "Label a sample on the annotation page and read the spot-check agreement column, not the low-confidence one, which is biased toward disagreement."

---

## ⚡ Performance and Accessibility (~1 min)

- Polls skip while the tab is hidden; actions refetch at once instead of waiting for a tick.
- The cases poll is the heaviest request; it runs at half the detail rate, and outputs on demand is the next step.
- Attempt histories, version diffs and case lists load on demand, not with the page.
- CI bars are `role="img"` with the numbers in their labels ("paired difference +0.218 with interval [+0.064, +0.373]"); progress bars say "N of M tasks finished"; filter tabs are a tablist with `aria-selected`; regions carry labels (Verdict, Provenance, Requirements, Cases).
- Colour is never alone: status chips carry words, verdict codes are printed, deltas are signed, sample dots have a tooltip and the mean beside them.
- Gaps I'd close next: rows expand on click, so the expander should be a real button with `aria-expanded`; checklist icons need visually hidden "met / not met" text; the re-score dialog needs a focus trap.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Comparison headline | ✅ Verdict + provenance + six-row checklist | ❌ "Δ = +X%" | Three traps hide behind a bare delta |
| Where statistics run | ✅ Server, one tested implementation | ❌ Recompute in the browser | Screen, API and CI gate can't disagree |
| Aggregates | ✅ Mean with CI, n, errored, flaky | ❌ Bare averages | Survivors and noise are visible, not hidden |
| Axes | ✅ Fixed [0, 1] and [−1, 1], zero marked | ❌ Autoscaled | Visual size matches the effect size |
| Live progress | ✅ Snapshot polling 1.5-3 s | ❌ SSE task events | Derived state, self-healing, no client stats |
| Compare selection | ✅ URL search params | ❌ Component state | Shareable in a PR, back button works |
| Submit | ✅ Idempotency-Key per form | ❌ Per click / none | Retry after a lost response finds the same run |
| Version edits | ✅ Base version + 409, buffer kept | ❌ Last write wins | Immutable versions; no silent overwrite |
| Server state | ✅ Small `usePoll` hook | ❌ TanStack Query | Every screen is a snapshot; easy to swap later |

---

## 📝 Wrap-up (~1 min)

> "The dashboard is honest because it never shows a number without the context that decides what it means. Means carry intervals and errored counts. Comparisons lead with what changed and a checklist, and 'improvement' appears only when all six requirements hold. Progress is a polled snapshot of server state, so reloads and reopened runs just converge. The key question has a short answer: with the prompt, dataset and scorer all changed, nothing can be claimed until re-scoring, re-running and one-factor changes rebuild a fair comparison, and the UI offers each of those steps."

| Production design | Local build |
|-------------------|-------------|
| Thousands of workspaces, read replicas for results | One PostgreSQL; two API processes, two workers |
| Real providers and a judge model with quotas | Deterministic mock model and judge with chaos switches and per-run call counters |
| Large runs with materialized aggregates | ≤ 230 tasks per run; aggregates computed on read |
| Proof | 16 screenshots, generated smoke tests, an e2e that recomputes a comparison from raw rows |
