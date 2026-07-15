# Design Splitwise — Frontend Focus

> A 45–60 minute walkthrough emphasizing UI architecture, client state, the split-editor interaction, rendering strategy, and how the client stays correct and responsive. Conversational, with the reasoning behind each call.

## 📋 Framing

Splitwise is an expense-splitting app: groups, expenses split four ways, balances, "simplify debts," settle up. From the front-end seat, the defining challenge isn't fetching data — it's the **add-expense interaction**. Splitting $84.37 three ways, or by percentage, or by weighted shares, while showing the user exactly what each person will owe *and preventing an invalid split from ever being submitted*, is a genuinely hard piece of stateful UI. I'll spend most of my time there.

"The rest of the app is CRUD-over-lists. The split editor is where a great front end earns its keep, so that's my centerpiece."

## 🎯 Requirements (front-end lens)

- A **dashboard**: headline totals (owed / owe / net), groups with per-group balances, friends, activity.
- A **group page**: the expense ledger plus a balances panel that toggles between raw net balances and simplified transfers.
- The **add-expense modal**: amount, payer, category, and a live split editor across four modes.
- A **settle-up flow**, optionally prefilled from a suggested transfer.
- Money always renders exactly; the UI never lets a user submit a split that doesn't sum to the total.
- Feels instant on a phone; works on desktop.

## 🏗️ Front-End Architecture

```
   ┌───────────────────────────────────────────────┐
   │                React SPA (Vite)                 │
   │                                                 │
   │  TanStack Router (file-based)                    │
   │    /  ·  /groups  ·  /groups/$id  ·  /activity   │
   │                                                 │
   │  ┌───────────┐  ┌───────────────┐  ┌──────────┐ │
   │  │ Zustand    │  │ Feature comps  │  │ Base UI  │ │
   │  │ auth store │  │ SplitEditor    │  │ Modal    │ │
   │  │            │  │ BalancesPanel  │  │ Avatar   │ │
   │  └───────────┘  │ AddExpenseModal│  │ Button   │ │
   │                 └───────┬───────┘  └──────────┘ │
   │                         ▼                        │
   │              api.ts (typed fetch client)         │
   └─────────────────────────┼───────────────────────┘
                             ▼  /api/* (Vite proxy → Express)
```

**Stack choices and why:**

| Concern | Choice | Why (and why not the alternative) |
|---------|--------|-----------------------------------|
| Routing | TanStack Router (file-based) | Type-safe params (`$groupId`); routes-as-files keep the map obvious. Plain state-based routing loses deep links to a group. |
| Global state | Zustand (auth only) | Auth/session is the only truly global state. Redux's boilerplate isn't justified; Context would re-render the tree on every change. |
| Server data | Local `useEffect` + typed `api.ts` | The data is page-scoped and refetched after mutations. A full query cache (React Query) is the natural next step but not needed at this size. |
| Styling | Tailwind + a few `@apply` components | Utility classes keep the split editor's dense layout readable; `.card`/`.btn-primary` deduplicate the repeats. |
| Split preview math | Shared with backend | The client re-implements the exact largest-remainder allocation so previews match the server to the penny. |

"The deliberate move: **keep global state tiny.** Only auth is global. Everything else is owned by the page that shows it and refetched after a write. Less state = fewer bugs where two screens disagree."

## 🎛️ Component model

Three layers:
- **Base UI** — `Avatar`, `Button`, `Input`, `Modal`, `BalancePill`, `GroupAvatar`. Dumb, reusable, no data fetching. Icons live in `components/icons/` with a barrel export — SVGs are never inlined into feature components.
- **Feature components** — `SplitEditor`, `AddExpenseModal`, `SettleUpModal`, `BalancesPanel`, `ExpenseRow`, `CreateGroupModal`. These own interaction logic.
- **Route components** — dashboard, groups list, group detail, activity. They fetch, compose features, and refetch after mutations.

`BalancePill` is a small but load-bearing component: it takes a signed cent value and renders green "you are owed $X" for positive, orange "you owe $X" for negative, grey "settled up" for zero. Encoding the sign→color→wording rule in one place means every balance across the app reads consistently.

## 🔧 Deep Dive 1: The split editor (the hard part)

**The problem.** One control has to support four fundamentally different mental models — *split equally*, *exact amounts*, *by percentage*, *by shares* — over a dynamic set of participants, and at every keystroke it must (a) show each selected person the exact cents they'll owe and (b) tell the user whether the split is currently valid.

**State shape.** Rather than four separate forms, I keep one map: `userId → { selected, exact, percent, shares }`. The active split-type tab decides which field is meaningful. Selecting/deselecting a person, or editing any field, patches that map. This makes "switch from Equal to Percentage" free — no data is thrown away, the view just reads a different field.

**The live computation.** A single pure function, `computeOwed(members, totalCents, splitType, state)`, returns both the resolved `owed_cents` per person and a validation message. It runs in a `useMemo` on every change:
- *Equal* — allocate the total across selected members with equal weights.
- *Exact* — read each amount; the message shows "$X left to assign" or "$Y over" until it hits zero.
- *Percentage* — allocate by the entered percents; the message flags "adds up to 96% (need 100%)".
- *Shares* — allocate by integer weights.

The crucial detail: **the client uses the same largest-remainder allocation the server uses.** So when the modal previews "334 / 333 / 333" for $10 three ways, that's byte-for-byte what the backend will store. The preview isn't an approximation — it's the answer.

**Why validate on the client at all, given the server also validates?** Because the *feel* is the product. A green "Splits add up — ready to save ✓" banner that turns into "$0.34 left to assign" as you type is immediate, local, and teaches the user what's wrong. The server validation still runs — never trust the client — but it's the safety net, not the UX. The Save button is disabled until `computeOwed` returns no error, so an invalid split can't even be attempted.

**Why not let the server be the only judge?** Round-tripping every keystroke to validate would be laggy and would make the app useless offline or on a slow phone. Local computation of a bounded, well-defined function is the right tool; the amounts are small integers and the member count is tiny, so it's effectively free.

> "The split editor is a controlled component whose single source of truth is a per-member map, reduced by one pure function into amounts + a validity verdict. That function is shared with the server, so preview equals reality."

## 🔧 Deep Dive 2: Balances view — making an algorithm legible

**The decision:** the group's "Settle up" panel toggles between **Balances** (each member's raw net) and **Simplify debts** (the minimal transfers), over the *same* numbers.

**Why the toggle matters as UI.** Debt simplification is an abstract graph result. Showing it next to the raw balances, on a switch, makes its value *visible*: the user sees "Alice is owed $1,046, Bob owes $305, Carol owes $741" collapse into "Carol → Alice $741, Bob → Alice $305 — 2 payments settles the whole group." The interaction teaches what the algorithm did. Each simplified transfer has an inline **Settle** button that opens the settle-up modal *prefilled* with that exact from/to/amount — turning a suggestion into a one-tap action.

**Data flow.** The group page fetches group, expenses, and balances in parallel. After any expense or settlement write, it refetches all three. Balances come pre-computed and pre-simplified from the server (`GET /groups/:id/balances`) — the client just renders; it doesn't re-run the graph algorithm. That keeps the heavy logic in one place and the client thin.

## 🔧 Deep Dive 3: Optimistic feel vs. correctness for money

**The tension.** Optimistic UI (update the screen before the server confirms) makes apps feel instant, but for *balances* an optimistic error means showing someone the wrong amount of money — a trust-killer.

**My call: optimistic on the cheap, authoritative on the money.** Interactions like selecting a payer or toggling a participant are pure local state — instant, no server needed. But when an expense is saved, I **don't** optimistically patch the group's balances; I close the modal, refetch, and show the server-computed result. Balances are the one thing that must be right, and they're a fast read.

**Idempotency from the client side.** The `api.ts` client attaches a fresh **Idempotency-Key** (UUID) to every add-expense and settle-up request. So if the network drops after the request left but before the response arrived, and the user (or a retry) fires again, the server dedupes and the balance updates once. The client's job is to *generate the key at action time* — which it does — so the guarantee holds end to end.

> "I'll happily be optimistic about UI chrome. I refuse to be optimistic about a dollar figure. Balances are a sub-50ms read — I'd rather refetch the truth than guess and be wrong."

## 🖼️ Rendering & Performance

- **Lists** (expenses, activity, friends) are short per group — plain rendering. If a power-user's group grew to thousands of expenses, I'd drop in `@tanstack/react-virtual` on the ledger; the row component is already isolated for that.
- **The modal** locks body scroll, closes on Escape/backdrop, and slides up from the bottom on mobile — native-feeling on a phone, centered on desktop.
- **Responsive by default:** a desktop side-nav collapses to a mobile bottom-nav; the group page's two-column ledger/balances layout stacks on small screens.
- **Money & dates** format through shared utils (`formatCurrency`, `formatDate`) so nothing renders raw cents or ISO timestamps.

## 📱 Offline & resilience

The app degrades sensibly: reads that fail show empty/error states rather than a white screen (the root guard shows a spinner during auth check, then routes). The natural enhancement is a service worker caching the last dashboard + open group so the app opens instantly and syncs queued expenses (each already carrying an idempotency key, so replay is safe) when back online.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Split state | One per-member map + pure reducer | Four separate forms | Switching modes is free; one validity source |
| Split preview | Client re-computes server math | Trust server only | Instant feedback; preview == reality |
| Balances | Refetch after write (authoritative) | Optimistic patch | Money must be right |
| Global state | Zustand, auth only | Redux everywhere | Minimal shared state = fewer desyncs |
| Server data | useEffect + typed client | React Query | Sufficient at this size; easy to upgrade |
| Simplify math | Rendered from server result | Recompute on client | One home for the algorithm |

## 🔮 Follow-ups I'd expect

- **React Query** to unify caching, background refetch, and mutation invalidation as the app grows.
- **Optimistic *list* updates** (show the new expense row immediately, reconcile on refetch) while keeping balances authoritative.
- **Itemized splits** ("Alice had the appetizer") — the per-member map generalizes to per-item maps.
- **Accessibility pass**: focus-trap the modal, announce the validation banner via `aria-live`, ensure the green/orange balance colors also carry text (they already do: "you owe"/"owes you").
