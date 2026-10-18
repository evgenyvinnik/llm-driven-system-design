# Experiments

> **Worked example.** This file is a complete answer to the practice brief in [README.md](./README.md), written for this repository. To practice the exercise yourself, start from the bare starter (see [CLAUDE.md](./CLAUDE.md#practice-mode)) and write your own ideas before reading this.

## 1. Opportunities

Ranked by expected impact on revenue. Sizes are per four-week period, against total revenue of $12.8M per four weeks ([METRICS §2](./METRICS.md#2-top-line-weekly-averages)).

| # | Opportunity | Evidence | Rough size | Decision |
|---|-------------|----------|------------|----------|
| 1 | **Prepaid orgs run out of credits without warning, and their production traffic fails** | 25% of paying Build orgs hit $0 in four weeks. 18% of them lapse (6% for matched orgs) and the rest spend 11% less afterwards. The only warning is an email sent *after* requests fail. 17% of support tickets | ~$330K of revenue at stake per four weeks, ~2.5% of revenue, and it compounds | **Large bet, built** |
| 2 | New orgs stall before their first purchase | 33% of sign-ups make an API call but only 9.5% buy credits. The biggest step loss in the funnel (29%) | Large, but onboarding is out of scope, and the outcome takes 30+ days to read | Next quarter |
| 3 | **Rate-limited orgs don't know how to raise their limits** | 8.6% of paying Build orgs hit 429s weekly. 61% are within $50 of the next tier, and 54% still haven't advanced after 30 days. 0.7% of Usage page views continue to Limits. 13% of tickets | ~0.1% of revenue now, ~0.3% after a year, plus fewer tickets | **Small bet, built** |
| 4 | Heavy Build orgs never hear about the Scale plan | Scale grows faster (+8.4%) than Build (+5.1%). Plans "Contact sales" CTR is 0.4% | Potentially large per org, but sales-assisted and slow to measure | Talk to sales first |
| 5 | Single-member orgs | 71% of paying orgs have one member; multi-member orgs spend 2.6× more | Unclear: big orgs invite people, not the other way round | Needs a causal test before investment |
| 6 | Lost and leaked keys | 8% of tickets | A support cost more than growth | Not a growth bet |

## 2. Large experiment: warn before credits run out, with one-click auto-reload

**Key:** `credit_runway_autoreload` · **Unit:** org · **Split:** 50/50 of eligible orgs

### The idea

Tell Build orgs, on every page of the console, how many days of credit they have left at their recent spend, once that drops to 7 days or less (or the balance is already $0). The banner offers two actions:
- **Turn on auto-reload.** Settings are prefilled from the org's own spend: reload when 3 days of credit are left, add about two weeks of usage.
- **Add credits.** Opens Billing with that amount prefilled.

### The problem

Prepaid credits put the org's production uptime in the hands of whoever remembers to top up. The data says that fails a lot, and it fails for our best customers:

- **It's common.** 15,050 paying Build orgs (25%) ran out in four weeks, across 17,900 depletions ([METRICS §6](./METRICS.md#6-credit-depletion)).
- **It hits growing orgs.** Depleted orgs' spend was up 38% in the two weeks before, against +3% for all Build orgs. Their spend outgrew their top-up habit. That is Northwind Labs exactly: spend nearly tripled in three weeks, and $3.84 is about 2.8 days of usage.
- **It's an outage, not a nag.** Every key fails at $0. A median depletion causes 1,240 failed requests and lasts 19 hours (p75: 52 hours).
- **It loses customers.** 18% of depleted orgs haven't bought again 30 days later, against 6% of matched orgs. The ones that come back spend 11% less, against +2%. A plausible reading is that they moved traffic to a provider that didn't go down.
- **Today's product warns too late.** The only signal is an email at $0. The balance appears on the Dashboard, but nothing says what it means in days. Auto-reload exists and works, but sits on a Billing page that 17% of weekly users open, and only 1.6% of those views turn it on.
- **It costs support.** 17% of tickets are "my API calls stopped working", nearly all answered with "add credits".

**Sizing.** Per four weeks, using METRICS inputs and labeled assumptions:

| Loss | Arithmetic | Per 4 weeks |
|------|-----------|-------------|
| Excess lapse | 12pp × 15,050 orgs = 1,806 orgs × $84 (4 weeks at the $21/week they spent before running out) | ~$152K of run-rate gone |
| Lower spend from orgs that return | 13pp gap × 12,340 returning orgs × $84 | ~$135K |
| Spend lost during the outage | 17,900 depletions × ~1.5 days × $3/day, half of it never made up (assumption) | ~$40K |
| **Total** | | **~$330K, ~2.5% of revenue (5% of Build)** |

What the banner can capture depends on two assumptions I'd check in the control arm first:
- **Reach.** 60% of soon-to-deplete orgs open the console in their last 7 days. They are actively building, and the Dashboard is the landing page.
- **Effect.** 30% of those reached avoid running out, by turning on auto-reload or topping up early.

Together that prevents ~18% of depletions:
- **Now:** ~$30K a month of spend that would otherwise be lost (18% of the spend-dip and outage rows).
- **Over a year:** ~325 lapses avoided every four weeks. Those orgs keep spending, so after a year the retained cohort is worth roughly **$250K per four weeks, about +2% of today's revenue run-rate**. Bracketing the assumptions (40% reach × 20% effect up to 70% × 40%) gives +1% to +3%.

That is large for a single change, and it's the right kind of growth: the customer wants their API to stay up as much as we do.

### Hypothesis

If at-risk orgs see their runway in days and can turn on auto-reload in one click, fewer of them will run out of credits, and more of their spend will stay with us.

| Metric | Expectation | Event source |
|--------|-------------|--------------|
| **Primary: share of exposed orgs that run out within 14 days** | Falls by at least 5pp from the control baseline. I'd guess around 55% → 45%, but the control will tell us | `credit_balance_depleted` |
| Mechanism: auto-reload turned on within 7 days | ~2% → 15% or more | `auto_reload_updated` (enabled and not was_enabled) |
| Revenue: credits bought per exposed org over 28 days | Up. It must at least not fall | `credits_purchased` + `auto_reload_charged` |
| Guardrail: auto-reload turned off within 14 days | Low, under 15% of enablers. High means people felt tricked | `auto_reload_updated` (was_enabled and not enabled) |
| Guardrail: refund requests on auto-reload charges | No higher than the 0.4% baseline + 0.2pp | Support tags (outside the event log) |
| Guardrail: requests rejected per exposed org | Falls | `api_requests_rejected` |

**Why depletion is the primary metric and not auto-reload adoption.** Adoption is the mechanism, but the problem is the outage. An org that tops up early without auto-reload is a success, and an org that turns on auto-reload and then disables it is not. Depletion is also what drives the lapse and spend losses above, and it reads in 14 days instead of 90.

## 3. Small experiment: explain 429s and offer the exact purchase that lifts the limit

**Key:** `rate_limit_upgrade_nudge` · **Unit:** org · **Split:** 50/50 of eligible orgs

### The idea

On the Usage page, which already shows a 429 count and chart, orgs that were rate-limited in the last 7 days and are below a self-serve tier see a callout. It says how many requests were rejected and what share of traffic that was. It names the current and next tier's request limits (Tier 1: 50/min, Tier 2: 1,000/min, 20×), with a progress bar ($25 of $40 purchased). It offers the exact purchase that closes the gap ("Add $15.00 in credits"), prefilled in Billing. If the tier's waiting period isn't over, it says the date the upgrade lands. The copy makes the point that matters for a prepaid product: the credits pay for usage they'd have anyway, so this isn't a fee.

### The problem

- **Demand is being turned away.** 8.6% of paying Build orgs get 429s in a typical week, and 91% of them are on Tier 1 or 2 ([METRICS §7](./METRICS.md#7-rate-limits)). Northwind had 412 rejected requests last week, 3.6% of its traffic, up from 31 the week before.
- **The fix is small and close.** 61% of rate-limited Tier 1–3 orgs are within $50 of the next tier and past its waiting period. For Northwind it's $15.
- **The path is invisible.** The Usage page shows 429s with no explanation. 0.7% of Usage views go on to Limits, and only 3.2% of weekly users ever open Limits. 13% of support tickets ask how to raise limits.
- **It's slow.** 54% of rate-limited Tier 1–2 orgs still haven't advanced 30 days after their first 429; 33% advance within 14 days.

**Sizing.** About 8,000 distinct orgs per four weeks are rate-limited with a purchase left before the next tier. Assume half of them open Usage while investigating (~4,000 exposed per four weeks, ~1,000 a week). A +7pp lift in 14-day advancement means ~280 extra orgs move up a tier per four weeks.

Orgs that advance spend 46% more over the next four weeks, against +4% for orgs that don't. That gap is observational: orgs that were going to grow anyway advance. I credit a third of it to the limit itself, about +14% on ~$100 per four weeks, or $14 per org. That's ~$4K per four weeks now, building to ~$35K per four weeks (~0.3% of revenue) after a year if the effect persists. There's also a support saving, since 1,270 rate-limit tickets a month are the same question.

Real, but modest. Two reasons it's small: many of these orgs would advance anyway (we're mostly pulling the upgrade forward), and they're small spenders.

### Hypothesis

If rate-limited orgs see why they're limited and the exact purchase that fixes it, on the page where they're already looking at the 429s, more of them will move up a tier, sooner.

| Metric | Expectation | Event source |
|--------|-------------|--------------|
| **Primary: share of exposed orgs that move up a tier within 14 days** | 33% → 40% | `usage_tier_upgraded` |
| Secondary: credits bought per exposed org in 14 days | Up | `credits_purchased` + `auto_reload_charged` |
| Mechanism: 429 share of traffic in the 14 days after exposure | Falls in treatment | Usage table (429s aren't events yet; [METRICS gap 4](./METRICS.md#11-known-instrumentation-gaps)) |
| Guardrail: refund requests on credit purchases | Flat | Support tags |

## 4. Readout

### Which two I built, and why

**The runway banner** is the largest opportunity with direct evidence. A quarter of paying prepaid orgs have a self-inflicted outage every month, it predicts churn, and today's warning comes after the damage. The change is cheap, honest (it aligns what the customer wants with what we want) and reads in about three weeks.

**The rate-limit nudge** is the smallest change backed by direct evidence. It reuses data the Usage page already loads, on a page rate-limited users already visit. It also needed the same instrumentation fix as the banner (attributing billing actions to the surface that prompted them), so building both cost little more than building one.

The new-org funnel (opportunity 2) is probably bigger than the nudge, but onboarding is out of scope and its outcome takes a month to read.

### What shipped and what I cut

**`credit_runway_autoreload`**

| Shipped | Cut (and why) |
|---------|---------------|
| Server-side runway: average spend over the last 7 complete days, days left, run-out date, at-risk rule, suggested auto-reload settings ([server/lib/runway.js](./server/lib/runway.js)) | **Email and API-header warnings** at ≤3 days. These reach the ~40% of orgs who won't open the console in time, and are probably the bigger lever, but they need the email system. First thing I'd add |
| An app-wide banner with a warning state and a depleted state. The depleted state can't be dismissed, because requests are failing | **Trend-aware forecast.** A trailing average understates burn for growing orgs, which are exactly the ones running out. Needs a backtest against past depletions |
| A one-click auto-reload modal with suggested amounts, the card on file, and an up-front notice when enabling charges immediately | **Dismissal synced across devices** (it's per browser session) |
| An "Add credits" link to Billing with the amount and `source=runway_banner` prefilled | Scale plan and multi-org handling (Scale orgs are invoiced, so never eligible) |

**`rate_limit_upgrade_nudge`**

| Shipped | Cut (and why) |
|---------|---------------|
| `rateLimit` summary (429s, share of traffic) on `GET /api/limits` | **Showing it at the moment of the 429**: in the API error message or Workbench. The real API isn't in this repo |
| The Usage page callout: exact amount, tier multiple, waiting-period date, progress bar, links to Billing and Limits | **The Limits page.** One surface first, to keep the readout clean |
| A tier-upgrade confirmation toast for purchases that come from the nudge | **A Scale contact-sales path for Tier 4**, which has no self-serve next tier |

**Instrumentation and framework changes** (compared with the starter), and why:

1. **`source` on billing events** ([METRICS gap 1](./METRICS.md#11-known-instrumentation-gaps)). `credits_purchased` and `auto_reload_updated` now record `source` (`billing_page`, `runway_banner`, `rate_limit_nudge`, otherwise `other`). The server validates it against an allow-list rather than trusting the client. `credits_purchased` also records `tier_before`/`tier_after`, and `auto_reload_updated` records `was_enabled` and `balance_cents`, so "turned on" and "edited" can be told apart. I added properties instead of renaming events, so existing dashboards keep working.
2. **New server-side events.**
   - `credit_balance_depleted`: emitted once, when a debit crosses $0 (gap 2).
   - `usage_tier_upgraded`: emitted when a purchase or reload moves the tier (gap 3).
   - `api_requests_rejected`: requests refused at $0.

   They're server-side because conversions shouldn't depend on a browser tab staying open or an ad blocker letting `/api/events` through (gap 5).
3. **The Billing page reads `?amount=` and `?source=`**, so both experiments can deep-link. It clears `source` after one purchase, so later purchases aren't over-attributed.
4. **`POST /api/dev/simulate-usage`** and a Dev toolbar button ("Simulate a day of API traffic"). They fast-forward the org's own traffic an hour at a time, so depletion and auto-reload can be demoed.
5. **A Dashboard fix the experiment surfaced.** The tier card went stale after the banner's auto-reload moved the org to Tier 2; it now refetches when purchases change.
6. **[server/lib/readout.js](./server/lib/readout.js) and `npm run readout`**: the metric definitions below, as code with tests.

Seed data is unchanged.

### How to demo

`npm run dev`, open http://localhost:3000, then **Dev** (bottom right). Northwind Labs hashes into **control** for both experiments, so a fresh load shows today's product. The **Events** tab still shows a `$exposure` for each experiment: that's the control being logged at the moment it *would* have seen the change.

**Large: `credit_runway_autoreload` → `treatment`**
1. Dev → Experiments → set `credit_runway_autoreload` to `treatment`. An amber banner appears on every page: "Your credits will run out in about 2 days".
2. **Turn on auto-reload.** The modal is prefilled with $5 / $20 and says $20 will be added now. Confirm. A toast appears, the balance becomes $23.84 and the banner is gone. In Events: `runway_banner_action` (open_auto_reload), `auto_reload_updated` (source `runway_banner`, was_enabled false), `auto_reload_charged`, and `usage_tier_upgraded` (the $20 took cumulative purchases past $40).
3. **The depleted state:** Dev → Data → Reset data to seed. Then click "Simulate a day of API traffic" three times, or run the Workbench until it fails. The banner turns red and can't be dismissed, the Workbench returns 402, and Events shows `credit_balance_depleted` and `api_requests_rejected`.
4. **"Add credits"** goes to Billing with $20 prefilled. The purchase is recorded with `source: runway_banner`.

**Small: `rate_limit_upgrade_nudge` → `treatment`**
1. Dev → Data → Reset data to seed. Set `rate_limit_upgrade_nudge` to `treatment` and open **Usage**. A blue callout says 412 requests were rate-limited, and Tier 2 allows 20× more for $15.
2. **Add $15.00 in credits.** Billing opens with $15 prefilled. Buy. The toast says "You’re now on Tier 2". Events shows `rate_limit_nudge_action` (add_credits), `credits_purchased` (source `rate_limit_nudge`, tier 1 → 2) and `usage_tier_upgraded`.

Back to control: Dev → Experiments → **Clear overrides**. Everything shown above disappears; nothing else in the app changed.

### How the metrics are computed

Defined in [server/lib/readout.js](./server/lib/readout.js), run over `data/events.ndjson` with `npm run readout`.

- **Population (both experiments).**
  - Orgs with a `$exposure` for the experiment, not every org assigned.
  - Exposure fires only where the org would see the difference: the banner component for at-risk orgs, the callout component for eligible orgs. It fires at the same moment in both arms, so the arms are comparable.
  - An org's arm and start time `t0` come from its first exposure.
  - Overridden exposures (Dev toolbar QA) are excluded, and so is any org seen in both variants.
  - Analysis is intention-to-treat: a treatment org that dismissed the banner still counts as treatment.
- **Window.** For each org, only its events in `(t0, t0 + N days]`, joined on `orgId` because both experiments are org-unit.
- **`credit_runway_autoreload`**
  - *Primary:* `depleted_within_14d` = exposed orgs with ≥1 `credit_balance_depleted` in 14 days ÷ exposed orgs. Orgs first exposed while already at $0 are left out of this one metric; for them, time to recover (t0 → next purchase or reload) is a separate cut.
  - *Secondary:* `auto_reload_turned_on_within_7d` (`auto_reload_updated` with `enabled && !was_enabled`) and `credits_bought_per_org_28d_cents` (sum of `amount_cents` over `credits_purchased` and `auto_reload_charged`, averaged over all exposed orgs, so non-buyers count as $0).
  - *Guardrails:* `auto_reload_turned_off_within_14d` and `requests_rejected_per_org_14d`. Refund requests come from support tags, which aren't in the event log.
- **`rate_limit_upgrade_nudge`**
  - *Primary:* `tier_upgraded_within_14d` (≥1 `usage_tier_upgraded`).
  - *Secondary:* `credits_bought_per_org_14d_cents`.
- **Checks before reading any result.**
  - Sample-ratio mismatch on exposures. Both arms share the eligibility code, so a skew means a bug.
  - Interaction between the two experiments. They're assigned independently (different hash salts), so read each one within the other's arms.
  - Production analysis would add confidence intervals (two-proportion z-test for rates, bootstrap for sums) and CUPED on the prior 28 days' purchases.

### Power and duration (estimates)

| Experiment | Exposed per week (both arms) | Detectable effect | Orgs needed per arm | Duration |
|-----------|------------------------------|-------------------|---------------------|----------|
| Runway | ~3,500 at-risk orgs that open the console | 5pp on a ~55% depletion rate | ~1,550 | 1 week to enroll + 14-day window ≈ **3 weeks** (28-day revenue at ~5 weeks) |
| Nudge | ~1,000 rate-limited orgs on Usage | 7pp on a 33% advancement rate | ~750 | 1.5 weeks to enroll + 14-day window ≈ **4 weeks** |

### Rollout

**`credit_runway_autoreload`**
1. 5% / 5% for two or three days. Check the sample ratio, event volumes, auto-reload charge failures (declined cards turn a reload into a depletion), refund tickets and page errors.
2. Then 50/50 of eligible orgs until the sample and window above are complete.
3. **Ship if:** depletions fall significantly, purchases per org don't fall, under 15% of enablers turn it off within 14 days, and refunds stay within 0.2pp of baseline.
4. Ship to 100% with a **5% holdout for 90 days**. The lapse and retention effect that makes this "large" compounds over months and can't be seen in three weeks.
5. The kill switch is `enabled: false` in [server/experiments.config.js](./server/experiments.config.js): everyone gets the control and exposure logging stops.

**`rate_limit_upgrade_nudge`**
1. 50/50 of eligible orgs for about four weeks, with the same ramp checks.
2. **Ship if:** the tier-upgrade rate rises and refunds are flat. Then extend to the Limits page and the 429 error message.
3. If both ship, the Usage page shows at most one billing callout. The runway banner wins, since it's urgent; the nudge waits until the runway is healthy. A treated org that turns on auto-reload can also move up a tier from the reload alone, as in the demo. That's one more reason to read the nudge within the runway arms.

### With one more week

1. **Reach orgs that don't open the console.**
   - A runway email at ≤3 days, replacing the current email that arrives at $0.
   - An `x-credit-runway-days` response header that developers can alert on.

   Test these as a third arm (banner vs. banner + email), because console visits are optional and outages aren't.
2. **Better forecast.** Backtest trailing-7-day vs. exponentially weighted vs. last-3-days burn rates against historical depletions, and pick the one with the best recall at a 7-day horizon without flooding stable orgs. Northwind's weekly spend grew ~60% in the seed's last week; extrapolating that growth gives about 2.4 days, not the 2.8 the trailing average shows.
3. **Exposure quality.** Dedupe exposures server-side (per org per day) instead of per browser session, and log server-side where the server already knows the state (for example, the 402 response). This removes ad-blocker loss (gap 5).
4. **Make 429s events** (gap 4): hourly per-org counts, so the nudge's mechanism metric comes from the event stream, not a daily join.
5. **Confidence intervals and CUPED in the readout**, plus a small dashboard on top of it.
6. **Design the activation experiment** (opportunity 2). It's the next big lever, and the `source` attribution built here carries over to it.
