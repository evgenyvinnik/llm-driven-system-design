# Console: Growth Metrics Snapshot

**All numbers are fictitious.** They were written for this practice project to be internally consistent, not taken from any real product. Ground your ideas and sizing in them anyway: that is the exercise.

**Period:** the four weeks from Mon Sep 14 to Sun Oct 11, 2026, unless a table says otherwise.
**Terms:** *org* is an organization, the billing unit. *WAO* is a weekly active org: at least one successful API or Workbench request that week. *Build* is the prepaid plan; *Scale* is the invoiced plan.

## 1. How Console makes money

- **Build plan (self-serve).** Orgs buy prepaid credits ($5 minimum). Every API and Workbench request draws down the balance. When the balance reaches $0, all requests from all of the org's keys fail with `400 credit_balance_too_low` until someone adds credits. Auto-reload (buy $X when the balance falls below $Y) is optional and off by default. New orgs get $5 of trial credits that expire after 30 days.
- **Usage tiers.** Rate limits and the monthly spend limit rise with cumulative credit purchases: Tier 1 at $5, Tier 2 at $40 (and 7 days after the first purchase), Tier 3 at $200 (7 days), Tier 4 at $400 (14 days). Tier 1 allows 50 requests per minute per model; Tier 2 allows 1,000.
- **Scale plan (sales-assisted).** Invoiced monthly, custom rate limits. Orgs reach it through the Plans page or a sales contact.

## 2. Top line (weekly averages)

| Metric | Value | vs. prior 4 weeks |
|--------|-------|-------------------|
| Weekly active orgs | 186,400 | +5.0% |
| Paying orgs (purchase or invoice in the trailing 90 days) | 61,400 | +3.2% |
| Weekly revenue | $3.21M | +6.7% |
| — Scale plan (1,150 orgs) | $1.61M (50%) | +8.4% |
| — Build plan (60,250 paying orgs) | $1.60M (50%) | +5.1% |
| New org sign-ups | 14,900 | +2.9% |

## 3. New-org funnel

Orgs that signed up Aug 3–30, followed for 30 days.

| Step | Orgs | % of sign-ups | Step conversion |
|------|------|---------------|-----------------|
| Signed up | 59,600 | 100% | — |
| Ran a Workbench prompt | 42,900 | 72% | 72% |
| Created an API key | 27,400 | 46% | 64% |
| First successful API call with a key | 19,700 | 33% | 72% |
| First credit purchase | 5,660 | 9.5% | 29% |
| Second purchase within 30 days of the first | 2,830 | 4.7% | 50% |

## 4. Weekly volumes

| Week ending | Sign-ups | WAO | New paying orgs | Build revenue | Scale revenue | Credit depletions | Auto-reload turned on |
|-------------|----------|-----|-----------------|---------------|---------------|-------------------|-----------------------|
| Aug 23 | 14,300 | 175,100 | 1,380 | $1.50M | $1.44M | 4,050 | 520 |
| Aug 30 | 14,500 | 176,900 | 1,400 | $1.52M | $1.47M | 4,120 | 540 |
| Sep 6 | 14,400 | 178,200 | 1,390 | $1.53M | $1.50M | 4,180 | 530 |
| Sep 13 | 14,700 | 180,000 | 1,420 | $1.54M | $1.53M | 4,260 | 550 |
| Sep 20 | 14,800 | 183,300 | 1,430 | $1.57M | $1.57M | 4,380 | 560 |
| Sep 27 | 14,900 | 185,600 | 1,440 | $1.59M | $1.60M | 4,450 | 550 |
| Oct 4 | 15,000 | 187,500 | 1,450 | $1.61M | $1.62M | 4,510 | 570 |
| Oct 11 | 14,900 | 189,200 | 1,450 | $1.63M | $1.65M | 4,560 | 560 |

A *credit depletion* is one org's balance crossing from above $0 to $0 or below.

## 5. Build plan segments by tier

Paying Build orgs active in the period.

| Tier | Orgs | Share of Build revenue | Median weekly spend | Auto-reload on | Depleted at least once | Got a 429 in a given week |
|------|------|------------------------|---------------------|----------------|------------------------|---------------------------|
| Tier 1 | 31,800 | 9% | $3 | 4% | 31% | 11% |
| Tier 2 | 17,900 | 24% | $14 | 12% | 22% | 7% |
| Tier 3 | 6,900 | 27% | $48 | 23% | 14% | 5% |
| Tier 4 | 3,650 | 40% | $120 | 38% | 8% | 3% |
| **All Build** | **60,250** | **100%** | **$6** | **10.6%** | **25%** | **8.6%** |

Orgs with auto-reload on have a 0.9% depletion rate (all from declined cards) and 118% 90-day net revenue retention, against 94% for orgs without it. This is observational: orgs that turn on auto-reload were already more committed.

## 6. Credit depletion

- **15,050 Build orgs (25%) hit $0 at least once** in the period, across 17,900 depletion events.
- **Depleted orgs are growing orgs.** Their spend in the two weeks before depleting was 38% higher than the two weeks before that (all Build orgs: +3%). Average weekly spend before depleting: $21.
- **What happens at $0:** requests from every key fail. The median depletion causes 1,240 failed requests before credits are added.
- **Time to top up** (for orgs that do): median 19 hours, p75 52 hours.
- **Lapse:** 18% of depleted orgs haven't purchased again 30 days later, against 6% of non-depleted orgs matched on tier and spend.
- **Orgs that come back spend less:** −11% in the four weeks after a depletion compared with the four weeks before (matched non-depleted orgs: +2%).
- **The only warning today** is an email sent when the balance reaches $0, after requests have started failing. Open rate 41%. There is no in-product warning before $0.
- **Where the balance is visible:** the Dashboard balance card and the Billing page. 17% of Build weekly active users open Billing in a given week.

## 7. Rate limits

- **8.6% of paying Build orgs get at least one 429 in a given week** (about 5,200 orgs a week; 9,100 distinct orgs over the period). 91% of them are on Tier 1 or 2.
- **Most are close to the next tier.** 61% of rate-limited Tier 1–3 orgs are within $50 of the next tier's purchase threshold and already past its waiting period.
- **Advancing is slow.** 54% of rate-limited Tier 1–2 orgs haven't reached the next tier 30 days after their first 429. Among those that do, the median wait is 11 days, and 33% of all rate-limited Tier 1–2 orgs advance within 14 days.
- **Advancing unlocks spend (observational).** Orgs that advance within 14 days of their first 429 spend 46% more over the following four weeks; orgs that don't advance spend 4% more.
- **The path is hidden.** The Usage page shows a 429 count and chart but doesn't say how to raise limits. The Limits page explains tiers but is opened by 3.2% of Build weekly active users. 0.7% of Usage page views continue to Limits.

## 8. Surface click-through rates

Build plan, weekly averages.

| Surface | Element | Weekly views | CTR |
|---------|---------|--------------|-----|
| Dashboard | "Add credits" on the balance card | 412,000 | 0.9% |
| Dashboard | "Create an API key" in Get started | 412,000 | 2.4% |
| Dashboard | "Invite your team" in Get started | 412,000 | 1.1% |
| Workbench | "Get code" | 238,000 sessions | 3.4% |
| Usage | Continue to Limits | 96,000 | 0.7% |
| Billing | Buy credits (submitted) | 71,000 | 21% |
| Billing | Auto-reload saved with it turned on | 71,000 | 1.6% |
| Plans | Contact sales | 18,500 | 0.4% |
| Members | Send invite | 22,000 | 6.0% |

## 9. Support tickets

Build plan, 9,800 tickets in the period.

| Category | Share | Notes |
|----------|-------|-------|
| Model behavior and quality | 19% | |
| "My API calls started failing" (balance at $0) | 17% | Median first response 9 hours; almost all resolved by "add credits" |
| Rate limits, how to raise them | 13% | Most answered with a link to the tiers doc |
| Billing and invoices | 12% | Receipts, VAT, refunds. 0.4% of auto-reload charges lead to a refund request |
| API errors (5xx, timeouts) | 11% | |
| Account and access | 9% | Members, roles, SSO requests |
| Lost or leaked API key | 8% | |
| Other | 11% | |

## 10. Teams

- 71% of paying Build orgs have a single member.
- Orgs with two or more members spend 2.6× more per week (observational).
- 6% of Members page views send an invite.

## 11. Known instrumentation gaps

1. **No source on billing actions.** `credits_purchased` and `auto_reload_updated` don't record which surface prompted them, so a purchase can't be attributed to a banner, page or email.
2. **Depletion isn't an event.** Depletions are reconstructed from a daily billing batch. Nothing is emitted when a balance actually reaches $0.
3. **Tier changes aren't events.** Tiers are computed when read; nothing records when an org moved up.
4. **429s aren't events.** The API gateway counts them, and the counts are joined to orgs once a day.
5. **Exposure is client-side**, once per session. About 5% of sessions block `/api/events` (ad blockers), so client-only metrics undercount.
6. **Client events carry the user.** The org is stamped server-side. That is fine for org-level analysis because 96% of users belong to one org.
7. **Email engagement** (opens, clicks) stays in the email vendor and isn't joined to product events.
