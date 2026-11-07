# Coding Exercise: The Quote Service Layer (45 minutes)

A practice brief for the coding half of a freight-rate-inquiry screen. A curated PracHub account of a September 2026 BNSF screen reportedly asked candidates to implement the service-layer logic of a rate inquiry endpoint first, then discussed heavy traffic and slow downstream services. That account is reported, not verified, and this exercise is this repository's own reconstruction of the theme, not a copy of any real question.

You write one class and one function in TypeScript. A vitest suite checks your attempt; a reference solution exists in the codebase, and you shouldn't open it until you've finished.

## Setup

```
cd freight-quote/backend
npm install
npm run practice:reset     # puts the stub in src/practice/attempt/quote-service.ts
npm run practice           # runs the suite against your attempt (19 tests, all failing at first)
npm run practice:watch     # reruns on save
```

Read `src/practice/types.ts` first: it defines every type you need and the two error classes. Edit only `src/practice/attempt/quote-service.ts`. Keep its two exports and their signatures.

## The task

A quote for moving rail freight is the sum of four price components, each from a different slow service: **pricing** (the linehaul, from a public tariff or the customer's contract), **fuel** (the weekly surcharge), **capacity** (a premium when the lane is busy) and **availability** (a premium when cars are scarce at the origin). Implement `QuoteService.submitQuote(request)` and `componentCacheKey(dependency, request)`.

### Rules

**1. Parallel calls under a deadline.**
- Call all four dependencies at once, not one after another.
- `submitQuote` must settle within `options.deadlineMs` of being called, even if a dependency never answers.
- Each dependency has its own budget in `options.budgetsMs`. Its effective budget is the smaller of that and the time left before the overall deadline.
- When a dependency runs out of budget, abort the `AbortSignal` you passed it, and stop waiting for it.
- A dependency that fails quickly is treated like one that timed out, without waiting for the deadline.

**2. Fallback to cached components.**
- Write every live answer to the cache under `componentCacheKey(dependency, request)`.
- When a dependency times out or fails, look its key up in the cache. A hit becomes a line with source `cache` and an `ageMs` of `now() - value.asOf`.
- No hit means a line with source `missing`, a null amount and a null version.
- Lines come back in the order pricing, fuel, capacity, availability.

**3. The quote.**
- `kind` is `firm` only when all four lines are `live`; otherwise `indicative`.
- `totalCents` is the sum of the non-missing amounts, times `quantity`.
- If pricing is `missing` (no live answer and nothing cached), throw `PricingUnavailableError`. There is no price to estimate from.
- `id` comes from `deps.newId()`.

**4. Cache keys that can't leak a contract price.**
- `componentCacheKey` decides what a cached value is shared by.
- Two requests may share a pricing entry only when they would be charged the same price. Customers on the public tariff for the same lane, commodity and equipment should share one entry. A customer's contract price must never be served to a request without that contract.
- `contractId` on the request was resolved by the server from the authenticated customer; null means public tariff pricing.

**5. Idempotent submit.**
- The same `idempotencyKey` with the same request returns the same quote (same `id`) and doesn't call the dependencies again.
- Concurrent duplicates (a second call while the first is still running) share one execution.
- The same key with a different request rejects with `IdempotencyConflictError`.
- Keys are scoped to the customer: two customers may use the same key.
- A submission that failed (rejected) is not remembered: a retry with the same key tries again.

### Out of scope

No HTTP, no real cache, no circuit breakers, no hedging, no persistence. Those are what the rest of this project builds around the same logic, and what the system design discussion after the coding part is about.

## Suggested timeline

| Minutes | Goal |
|---------|------|
| 0-5 | Read `types.ts` and this brief; ask yourself the clarifying questions below |
| 5-20 | Parallel calls with per-dependency budgets and abort; the firm path passes |
| 20-30 | Cache write and fallback; missing lines; pricing unavailable |
| 30-40 | Cache keys; idempotency including concurrent duplicates and failures |
| 40-45 | Run the whole suite, tidy, explain the trade-offs out loud |

Clarifying questions worth asking an interviewer: Is a cached linehaul good enough for a firm quote? (Not here: firm means all live. The full project relaxes this for current-version tariffs.) Should a failed call be retried inside the request? (No: there's no time, and it multiplies load.) What does "the same request" mean for idempotency? (Everything except the key itself.)

## Hint ladder

Take one rung at a time, and only after you've been stuck for a few minutes.

1. Give each dependency its own async function that *always resolves* to a line, never rejects. Then the four can be awaited together, and no single failure can short-circuit or hang the others.
2. A budget is a race between the dependency's promise and a timer. Whoever wins, clear the timer. When the timer wins, abort the controller whose signal you passed in.
3. Compute the overall deadline as an absolute time once, at the start. Each line's budget is `min(its own budget, deadline − now)`, computed when that line starts.
4. The cache write belongs on the live path, the cache read on the failure path. Think about what happens if the cache itself throws: should that fail the quote?
5. For the cache key, list every field that changes the price of each component. Then ask which field distinguishes a contract price from a tariff price, and whether the customer id belongs in the key.
6. For idempotency, store the *promise*, not the result, under a key made of customer and idempotency key. A second caller during the first execution then awaits the same promise.
7. Store a fingerprint of the request next to the promise, so a different request under the same key can be detected.
8. When the stored promise rejects, delete the entry, but only if it is still the same promise you stored.

## Grading notes (for a mock interviewer)

| Area | Strong | Weak |
|------|--------|------|
| Concurrency | Starts all four at once; each branch resolves to a value; one deadline computed up front | Awaits in sequence; uses a bare Promise.all that rejects on the first failure; one global timeout only |
| Cancellation | Aborts the signal on timeout and clears timers on success | Leaves timers running; ignores the signal; lets late results mutate state |
| Fallback | Distinguishes live, cached (with age) and missing; writes live results back | Treats cache and live the same; silently uses zero for a missing linehaul |
| Firm vs indicative | Can say why a cached snapshot can't make a quote firm | Labels everything firm when it has some number |
| Cache key | Keys pricing by contract id or "tariff", explains why customer id is unnecessary and lane-only leaks | Lane-only key; or the customer id in every key with no reason given |
| Idempotency | Stores the in-flight promise; detects conflicting reuse; forgets failures; scopes by customer | Stores only finished results (concurrent duplicates both run); remembers failures forever |
| Testing mindset | Names the race and timing cases before being asked | Only the happy path |
| Discussion | Connects the code to hedging, breakers, async completion and load shedding | Stops at "it passes" |

A good follow-up once the suite passes: "Capacity's p99 is now 8 seconds. What changes?" Strong answers mention hedging the slow tail (with a budget), a breaker to fail fast when it's down, an indicative quote now with the firm one completed asynchronously, and coalescing identical in-flight calls. All four are implemented in `src/shared/fanout.ts` for comparison.

## After you finish

- Compare with `src/practice/reference/quote-service.ts`.
- Then read `src/shared/fanout.ts` and `src/shared/compose.ts`: the production version of the same logic, with versioned caching, breakers, hedging, single-flight and labeled staleness.
- `npm run practice:reset` restores the stub for another attempt.
