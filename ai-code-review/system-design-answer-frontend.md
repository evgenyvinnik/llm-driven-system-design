# AI Code Review — System Design Answer (Frontend Focus)

*Frontend engineer interview · 45 minutes · Critique format: you are handed a design document · Read it → Rank the findings → Console design → Deep dives → Traces → Scale*

> "The document you've given me has no user interface, and that's the first thing I'd flag. It describes a bot that approves pull requests, and its whole human surface is a comment and a Datadog log. When this system refuses something, who sees why? When it's wrong, where do they look? When something needs a person, how does that person know? I'll critique the design first, including the backend findings that shape what the UI has to show, and then design the console that the corrected system needs."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Reading the proposal | ~3 min | Four questions, plus one of my own: who has to act on this, and what do they see? |
| Ranked findings | ~7 min | The blockers, and what each one means for the UI |
| Requirements and screens | ~5 min | Six screens, and the decisions each one supports |
| Architecture and state | ~8 min | Polling, the server as truth, SHA-bound actions |
| Component design | ~7 min | Gate checklist, timeline, diff, queue, evaluation |
| Deep dives | ~10 min | Stale UI, rendering hostile content, resisting automation bias |
| Traces, checklist, scale | ~5 min | One success, one failure |

---

## 🔍 Reading the Proposal (~3 min)

The proposal is a good answer to a real problem: reviews wait 9.5 hours and 72% end in a bare approval. It should keep its webhook-driven shape, the absence of developer workflow change, and its concern about source code piling up in another system.

I read it with four questions from any design review, plus one that a frontend engineer brings.

| Question | What it finds |
|----------|---------------|
| Assume the model is fully compromised: what's the worst it can do? | Authorization, tools, blast radius |
| Which commit does this decision apply to? | SHA binding, and what a stale screen can do |
| Who controls this input? | Injection, and hostile text reaching a page |
| What happens when this fails, and how would we know? | Fail-open paths, audit, measurement |
| **Who has to act on this, and what do they see?** | The missing product |

---

## 🚨 What's Wrong With It (~7 min)

Twenty-six findings in the full review. Seven block launch. Here they are with what each one implies for the interface.

| # | Finding | What breaks | What the UI must do |
|---|---------|-------------|---------------------|
| C1 | Model output directly authorizes | One bad answer is a production change | Show the gate rule by rule, separate from the model |
| C2 | Injection "closed off" by a sentence | A comment tells the bot to approve | Show "the model approved, the gate refused" plainly |
| C3 | Approval keyed by PR number | Approve, push a backdoor, approval stands | Make the SHA visible everywhere, and show invalidation |
| C4 | No `commit_id` on the approval | Push during the run, approval lands on unread code | A human approve button must name a SHA |
| C5 | Policy read from the PR | The PR sets its own terms | Settings live in a console, with history |
| C6 | Agent holds write token and `.env` | "Read ../.env" publishes the private key | Show what the model asked for and what was refused |
| C7 | Every uncertainty resolves to approve | Degraded mode, word-search parsing | Failures must land somewhere a person will see |

Four more shape the frontend directly.

| # | Finding | The document says | Why it matters here |
|---|---------|-------------------|---------------------|
| H4 | No escalation path | "The author can ask a colleague for a review as usual" | There is no queue. The hard 30% is silently abandoned |
| H3 | No audit trail | 14-day logs of PR number and verdict | Incident responders have nothing to open |
| H1 | No real measurement | 94% agreement on 200 merged PRs | A dashboard built on this would look great and mean nothing |
| M4 | Model text posted verbatim | "So authors can see the reasoning in the model's own words" | Attacker-influenced text under a trusted name, with images whose URLs carry data |

> "The reframe: the model is an untrusted reader that produces an opinion, and authority comes from a deterministic gate over facts about one commit. That sentence is also the design brief for the console. Every screen has to keep opinion and authority visibly apart."

---

## 🎯 Requirements (~2 min)

### Functional

| Screen | Primary user | The decision it supports |
|--------|--------------|--------------------------|
| PR queue | Reviewer | What needs attention, and why? |
| PR detail | Reviewer, security | Why did this happen, for which commit? |
| Escalation queue | Reviewer | What do I own, and can I approve it? |
| Audit log | Security, incident response | What exactly happened, and has it been altered? |
| Evaluation dashboard | Repo admin, leadership | Should this repository be allowed to approve? |
| Repo settings | Repo admin | Which mode, which policy, and how do I stop it? |
| Fixture panel | Demo | Show the whole story from a browser |

### Non-functional

| Requirement | Target | Why |
|-------------|--------|-----|
| Staleness | Under 3 s while a page is open | Decisions change in seconds; a push must show up |
| A stale screen must not cause harm | Enforced by the server | A tab open for an hour is normal |
| Rendering hostile content | No script execution, ever | Diffs and model text are attacker-written |
| Meaning without colour | Every status has text or an icon | Accessibility, and security statuses must not be ambiguous |
| Long pages | Full-page reading, sticky nav | Timelines and diffs are long |
| First load | Under 2 s | An internal tool, but reviewers live in it |

---

## 🏗️ Architecture and State (~5 min)

```
┌───────────────────────── Browser ─────────────────────────┐
│  TanStack Router (file routes)                            │
│   /prs  /prs/$owner/$repo/$number  /escalations           │
│   /audit  /evaluation  /settings  /fixtures               │
│                                                           │
│  usePoll per page ──▶ services/api.ts ──▶ fetch           │
│       │ server state lives here, never in a global store  │
│       ▼                                                   │
│  Presentational components   Zustand: session only        │
└─────────────────────────────┬─────────────────────────────┘
                              │ /api/v1, session cookie
                              ▼
                  ┌──────────────────────┐
                  │  API (×2, stateless) │──▶ PostgreSQL
                  │  org-scoped reads    │──▶ Git host (live panel)
                  └──────────────────────┘
```

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Live updates | Polling at 2.5 s | SSE or WebSocket | State changes on a seconds scale, and each poll runs the same scoped query |
| Server state | Per-page polled hook | Global store of PRs | Nothing is shared between pages; a store would add a staleness problem |
| Global state | Zustand, session only | Context or Redux | One small concern |
| Writes | No optimism, reload after | Optimistic updates | Security actions must not appear to succeed before they do |
| Routing | File-based, deep links by repo and number | Internal ids in URLs | `/prs/acme/web-app/23` can be pasted into an incident doc |
| Pending state | Show it, and show why | Spinners | "Waiting for CI" is information |

Polling is a deliberate choice here. SSE does exist in this system, between the worker and the model where tokens stream. A console needs "what's the current state", not a token stream, and polling reconnects trivially after a laptop sleeps. The API returns the full view each time, so there's no event-replay or gap logic.

---

## 🧩 Screen and Component Design (~7 min)

### PR queue

One table, one row per PR: title, repository, author, mode, head SHA, what the model said, the decision, and the reason as a sentence. The reason matters most. "`category_in_scope`: `src/billing/charge.ts` is not a docs or test path" tells a reviewer what to do, and "Escalated" doesn't. A filter for "model overruled" is, in effect, the injection alarm.

### PR detail

```
┌──────────────────────────────────────────────────────────────┐
│ #23 Billing: simplify the charge path   by mallory  c39a9a6  │
├──────────────────────────────────────────────────────────────┤
│ ▌Escalated for c39a9a6                                       │
│ ▌⚠ The model said approve at 0.99, low risk.                 │
│ ▌  The gate refused anyway.                                  │
├────────────────────────────────────┬─────────────────────────┤
│ Policy gate at c39a9a6             │ At the host             │
│  ✓ Bound to the current head       │  ✗ Blocked: 0 approvals │
│  ✓ CI green at this SHA            │                         │
│  ✓ No protected paths              │ Review run              │
│  ✗ Change category in scope        │  tokens, queue, TTFT    │
│                                    │                         │
│ Model opinion (untrusted data)     │ Timeline                │
│  approve · low risk · 0.99         │  run started            │
│                                    │  model output           │
│ Tool requests                      │  gate evaluated         │
│  ✗ read_file(.env) denied, audited │  decision: escalated    │
│                                    │  push: now e4f5a6b      │
│ Diff at c39a9a6                    │  approval dismissed     │
└────────────────────────────────────┴─────────────────────────┘
```

| Component | Responsibility | Note |
|-----------|---------------|------|
| Decision banner | The single sentence that matters | Colour reinforces the text and never replaces it |
| Gate checklist | Ten rules, each with its own reason | A list, because reviewers need the failing rule rather than a score |
| Model panel | Verdict, findings, scanner signal | Titled "untrusted data"; never styled as the decision |
| Tool requests | Allowed and denied calls | A denied `.env` request is the most important thing on the page when it happens |
| Diff viewer | Files at this SHA, rename sources called out | Text nodes only; opaque files get a chip |
| Timeline | The audit log for this PR | Invalidation, push and dismissal get emphasis |
| Host panel | Live state at the host | Separate from ours: "what we decided" and "what's true there" |
| Decision history | One chip per decision and SHA | Old decisions are struck through, and clicking shows that SHA's gate |

### Escalation queue

Cards rather than a table, because each item needs the reason, a note field and actions. The approve button reads "Approve c39a9a6", naming the commit. Claiming comes first, so two people don't duplicate work. An author sees approve disabled, with the reason beside it, and can still reject.

### Audit log

A filterable table with a row that expands to the raw payload, and a tamper check at the top that runs on load, reporting per repository: "1,204 entries, every hash and link verifies", or exactly which entry failed and how.

### Evaluation dashboard

Model only and model + gate side by side, same corpus, same model. The largest number on the page is dangerous false approvals. Each has a confusion matrix, and the cost sits right next to the benefit.

| Shown side by side | Model only | Model + gate |
|--------------------|------------|--------------|
| Dangerous false approvals | **40 / 47** | **0 / 47** |
| Upper bound | 92.8% | 6.2% |
| Safe changes sent to a person | 1 / 30 | 15 / 30 |
| Approved without a person | 90.1% | 18.5% |

### Settings

Mode, kill switch and a promotion checklist where each check shows what's required and what was found, so a refused promotion explains itself. A plain history records promotions, refusals and demotions. Changing the pinned model warns that it drops the repository back to observe.

---

## 🔧 Deep Dives (~10 min)

### Deep dive 1: A stale screen must not be able to approve the wrong commit

**The decision.** The approve button sends the SHA the reviewer saw, and the server refuses if it's no longer the head.

**Why it works.** A reviewer opens an escalation, reads the diff for ten minutes, and clicks approve. Meanwhile the author pushed. The client doesn't try to prevent this, because it can't. The request says "I reviewed `c39a9a6`", and the server, holding the same row lock a push takes, compares that with the item and the head. On a mismatch it returns 409 `STALE_SHA`, and the UI shows the message and refreshes. The label "Approve c39a9a6" also makes the commitment visible at the moment of the click.

**Why the alternative fails.** A client-side check of "is this still the head?" is the same check-to-act race the proposal has, moved into a browser, and polling at 2.5 seconds makes that window enormous. Sending just the escalation id is worse, because then the server approves whatever is current, which recreates the proposal's flaw at the human level: approval of a commit nobody read. Disabling the button when a poll sees a new head is a good courtesy and I do refresh, but it can't be the guarantee.

| Approach | Stale tab can approve the wrong commit? | Cost |
|----------|-----------------------------------------|------|
| ✅ Client sends SHA; server compares under lock | No | 409 handling and an explanation |
| ❌ Client checks head before sending | Yes, in the gap | Looks fine in testing |
| ❌ Send the item id only | Yes, always | None, which is why it's tempting |
| ❌ Live push to disable the button | Yes, in the gap | A connection per tab, and still racy |

**What I'm giving up.** A reviewer sometimes loses work: they read for ten minutes, click, and get told the commit moved. That's the correct outcome, but the message must say what changed and why, and keep their note if possible. Without optimistic updates the UI also feels a little slower, which I accept for a security action.

### Deep dive 2: Rendering hostile content

**The decision.** Diffs, PR text, comments and model output are all attacker-influenced, and they render as React text nodes in a monospace block. Nothing is parsed as Markdown or HTML, and nothing uses a raw-HTML escape hatch.

**Why it works.** React escapes text by default, so a diff line containing a script tag shows the characters. The one hostile-content problem left is visual trust, so the model panel is titled "untrusted data" and the summary is plain text under it. Tool results and raw model output appear inside `pre` blocks with a max height.

The same thinking applies server-side, where the poster composes the PR comment. Before model text goes there, images and links are removed, since a URL can carry stolen data out through an image request. Mentions are broken and HTML is escaped. An approval body contains no model text at all.

**Why the alternative fails.** The proposal posts the summary verbatim "so authors can see the reasoning", which turns the bot into a publisher with a trusted name. A summary could contain an image whose URL exfiltrates data the moment it renders, a phishing link saying "re-authenticate here", or a mention of a whole organization. Rendering Markdown in the console would be nicer to look at, and it would reproduce that same attack surface inside the tool people use to judge the attack. Sanitizing Markdown with a library is possible, but it's a large surface for a formatting nicety.

| Approach | Risk | Cost |
|----------|------|------|
| ✅ Text nodes only, sanitize at the comment boundary | Long lines to scroll | Plainer output |
| ❌ Render model Markdown | Images, links, phishing | Looks polished |
| ❌ Sanitized Markdown | A complex allowlist to keep right | A dependency to keep patched |

**What I'm giving up.** Model findings can't have rich formatting, links to code are constructed by us from validated paths rather than taken from model text, and a long diff is less pleasant than a full syntax-highlighted viewer. An unreadable-but-safe diff is the correct failure.

### Deep dive 3: Designing against automation bias

**The decision.** The UI leads with the facts and the specific rule, shows the model as one labeled input, and refuses to compress this into a single trust score or a green "AI approved" badge.

**Why it works.** The human queue is the system's last line of defense, and it fails quietly: people learn to click approve. So the queue gives a specific reason instead of "needs review", and shows "model overruled" as a warning rather than as reassurance. The diff is on the same page as the verdict. When the model approved and the gate refused, the banner says exactly that, which is the case where a reviewer most needs not to think "well, the AI said it was fine".

The evaluation dashboard follows the same principle. The number at the top is the error we fear, with its bound, and the cost column sits next to it, so nobody can present 0 of 47 without 15 of 30 beside it. A note says the corpus and the gate share an author.

**Why the alternative fails.** A "confidence: 99%" badge is exactly what an injection produces: every successful attack arrives at 0.99. A combined risk score hides which rule failed, so the reviewer can't check it. A dashboard with one headline accuracy number is the proposal's 94%, where always-approve scores 100%.

| Approach | What the reviewer learns | Failure mode |
|----------|--------------------------|--------------|
| ✅ Rule-by-rule facts, labeled opinion | Exactly what to check | Longer page |
| ❌ Single trust score | Nothing they can verify | Rubber-stamping |
| ❌ Prominent model confidence | What an attacker chose | Confident injections look safest |
| ❌ Accuracy headline | Nothing about danger | A green dashboard during an incident |

**What I'm giving up.** Glanceability. The PR page is long and demands reading, and a leadership audience will ask for one number. The answer is a number with a bound and a cost next to it, and I'd track false escalations and queue age so we notice if reading turns into clicking.

---

## 🔌 API Surface (~1 min)

```
GET   /api/v1/prs                            Queue rows, already joined
GET   /api/v1/prs/:owner/:repo/:number       Everything for the detail page
POST  /api/v1/escalations/:id/claim          409 if someone holds it
POST  /api/v1/escalations/:id/decide         Body names the SHA; 409 if stale
GET   /api/v1/audit                          Filters: repo, kind, actor, PR, SHA
POST  /api/v1/audit/verify                   Tamper check
GET   /api/v1/evaluations/:id                Summary and per-case rows
GET   /api/v1/repos/:id                      Settings, promotion preview, history
POST  /api/v1/repos/:id/promote              409 with each failed check
```

The detail endpoint returns one complete view (runs, decisions, escalations, timeline, host state), so the page doesn't orchestrate five requests or render half-loaded states. Errors arrive as a code and a message, and the UI shows the message, because the server's messages are written for people: "This item is for c39a9a6, the head is e4f5a6b".

---

## 📜 Execution Traces (~3 min)

### Successful trace: an approval a reviewer can trust

1. A docs PR opens. Within one poll the queue shows a row with `c39a9a6` and a running review.
2. The next poll shows "Auto-approved" with the reason "Every rule passed and the model approved at low risk".
3. Alice clicks through. Ten green rules, each with its evidence, and "Approved for this commit only. Any push withdraws it."
4. The host panel shows one approval at that SHA, and "Mergeable".
5. The timeline reads top to bottom: queued, started, model output, gate evaluated, decision, re-checked before posting, approval posted.

### Failed trace: the stale tab

1. An auth change escalates. Carol claims it and starts reading `a1b2c3d`. The button says "Approve a1b2c3d".
2. Mallory pushes `e4f5a6b`. The server invalidates the item in the same transaction.
3. Carol's tab polls within seconds: the item moves to "Out of date", and a new one appears for `e4f5a6b`.
4. Suppose she clicked first, in the gap. Her request names `a1b2c3d`, and the server compares it under the row lock with the new head: 409, "This item is for a1b2c3d, the head is e4f5a6b".
5. The UI shows that message and refreshes. Nothing was approved, and her click left an honest record of nothing happening.

---

## ✅ Design Review Checklist (~2 min)

**1. Source of truth, and when is a write successful?** The server is always the source of truth. The client holds no decision state beyond what's on screen. A human decision succeeds when the server's transaction commits, and an approval is live only when the host panel shows it. The UI keeps "decided" and "posted" visibly separate.

**2. A client retries after losing the response?** Claim: the second attempt gets 409, and the next poll shows that you hold it. Decide: a retry gets 409 because the item is decided, and the poll shows the result. Reads poll anyway. There's no client-side retry logic on writes, because each has a clear server answer.

**3. A server fails between steps?** A failed poll keeps the last data on screen with an error note instead of blanking the page. If the worker or poster dies, the page shows the truth, "queued" or "running", and the host panel shows nothing posted. The API instances are stateless, so either one serves the next poll.

**4. Which ordering or consistency is required?** Reads are per-page snapshots from one endpoint, so a page can't show a decision next to a different commit's gate. Between polls it can be seconds behind, which is fine because writes are checked at the server. The one ordering that matters, a review and a push, is enforced at the host.

**5. Access through caches and async jobs?** There's no client cache to leak between users: signing out clears state, and pages refetch. The server scopes every read to the session's org, and a cross-org URL returns 404, which the page shows as not found. Role affects which buttons render, but the server enforces it, so hiding a button is a courtesy.

**6. What breaks first, and what evidence?** Rendering long lists and diffs: the seeded queue page is already about 6,800 px tall with 56 PRs, and a huge diff could hurt. I cap diffs at 12 files in the view and limit queue results, and I'd add virtualization past a few hundred rows. Polling load comes next, at about 24 requests per minute per open tab.

---

## ❓ Follow-ups the Answer Must Handle

**"Why not show a live diff of what changed since the reviewer started reading?"** I'd like to, as a later improvement. When a claim goes stale, showing the diff between the old and new SHA gives the reviewer a head start, without weakening the rule that the decision names one commit.

**"A reviewer closes the tab after claiming. What happens?"** The item stays claimed, which blocks others. Today it can be released by hand. Production needs a claim timeout, with the clock on the server so a sleeping laptop can't hold an item forever.

**"How do you test this UI when the interesting cases are races?"** The fixture panel makes them reachable on demand: hold reviews at the host for three seconds, push while the post is held, and watch the page. The race logic itself is tested at the server, where the guarantee lives.

**"Would you put this inside GitHub instead of a separate console?"** Comments and checks belong there, and that's where most authors will see them. The queue, audit log, evaluation and settings don't fit in a pull request page, and the people using them are often not on that PR.

**"How do you handle a reviewer who disagrees with an automatic approval?"** A "report dangerous false approval" button on the PR page. It's deliberately consequential: it demotes the repository to observe and takes the approval back, and the UI says so before it happens.

---

## 📈 What Breaks First and How It Scales (~1 min)

1. **Long queues.** Add `@tanstack/react-virtual` and server-side pagination past a few hundred rows.
2. **Huge diffs.** Lazy-load per file, and collapse generated files.
3. **Polling cost.** ETags with 304s, pausing when the tab is hidden, and then SSE for the queue only if measurements demand it.
4. **Timeline size.** Group tool requests and paginate.
5. **The human queue.** This is the real limit: assignment, owner routing and queue age on a team view.

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Updates | Polling | SSE or WebSocket | Seconds-scale state; trivial reconnects |
| Writes | Server answers, then reload | Optimistic | Security actions shouldn't appear to succeed early |
| Approve request | Names the SHA | Item id only | A stale tab must not approve the wrong commit |
| Hostile text | Text nodes | Markdown rendering | Images and links are attack surface |
| Gate display | Rule-by-rule list | Trust score | Reviewers need something they can verify |
| Model display | Labeled, secondary | Prominent confidence | Attackers choose that number |
| Evaluation | Benefit beside cost | Accuracy headline | Always-approve scores 100% on agreement |
| Server state | Per-page polled hook | Global store | No cross-page sharing to justify it |

## 🌫️ Residual Risks

| Risk | Why it remains | Containment |
|------|----------------|-------------|
| Reviewers rubber-stamp | The UI can inform but not force reading | Specific reasons; track queue behaviour |
| Polling lag shows a stale state | Up to one interval | The server is the guard, so lag costs nothing |
| A long page hides the failing rule | Density | The banner states it first |
| Leadership asks for a single number | They will | Show the number with its bound and cost |

## 📝 Wrap-up (~1 min)

> "So my verdict on the document is not to ship it as written. Ship the observation-only half now, with the console this design is missing. The frontend's job in this system is to keep opinion and authority apart on every screen, make the commit visible everywhere, and make a refusal explain itself. A stale tab can't approve the wrong commit, because the request names the SHA and the server checks it. A hostile diff can't do anything, because it's text. And the dashboard can't lie by omission, because the cost sits next to the benefit."

### How the local implementation compares

Six screens plus a fixture panel in React 19, TanStack Router and Tailwind, polling every 2.5 seconds, with 17 captured screens and generated smoke tests. It drives a real stack: two API instances, workers, a poster, a mock model and a fixture Git host. The fixture panel can push a commit, flip CI, trigger an injection PR and arm model chaos, so the whole story can be demoed from the browser. The simplifications: no virtualization yet, and diffs are capped rather than lazily loaded.
