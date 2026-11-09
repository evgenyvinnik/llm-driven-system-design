# AutoReview: Automatic Approval of Pull Requests with an LLM

| | |
|---|---|
| **Status** | Proposed, seeking sign-off |
| **Authors** | Developer Productivity |
| **Reviewers requested** | Platform Security, Engineering Leadership |
| **Target launch** | Next quarter |

## 1. Summary

AutoReview is a GitHub App that reads every pull request, asks a large language model whether the change is acceptable, and approves the pull request when the model says it is. Engineers keep working the way they do today. The difference is that most changes no longer wait hours for a human to look at them.

We built a prototype over two sprints and evaluated it on real pull requests from our monorepo. It agreed with our human reviewers 94% of the time. This document describes the production design and asks for sign-off to roll it out to all repositories over four weeks.

## 2. Motivation

Code review is the largest single source of waiting in our delivery pipeline.

| Measure (last quarter) | Value |
|------------------------|-------|
| Pull requests per week | ~4,500 |
| Median time to first approval | 9.5 hours |
| Share of PRs under 100 changed lines | 61% |
| Share of reviews with no comments at all | 72% |
| Senior engineer time spent on review | ~6 hours per week |

Almost three quarters of reviews end in a bare approval. Those reviews cost a context switch for the reviewer and most of a working day for the author, and they change nothing. A model can read a diff in about a minute, at any hour, for a few cents.

## 3. Goals and Non-Goals

**Goals**

- Auto-approve at least 70% of pull requests within six months of launch.
- Bring median time to first approval under five minutes.
- Require no change to how engineers open pull requests.
- Keep the system small enough for one team to run.

**Non-goals**

- Replacing human review of large design changes. Those authors can still ask a colleague.
- Generating fixes or suggesting code.
- Building a general review analytics product.

## 4. Architecture

```
                 ┌──────────────┐
                 │    GitHub    │
                 └──┬────────▲──┘
       webhook      │        │  reviews, comments, merges
                    ▼        │
          ┌─────────────┐    │
          │ API Gateway │    │
          └──────┬──────┘    │
                 ▼           │
          ┌─────────────┐    │
          │   Webhook   │    │
          │   Service   │    │
          └──────┬──────┘    │
                 ▼           │
          ┌─────────────┐    │
          │  In-process │    │
          │    queue    │    │
          └──────┬──────┘    │
                 ▼           │
          ┌─────────────┐    │       ┌──────────────┐
          │   Review    │────┴──────▶│ LLM provider │
          │   Worker    │◀───────────│              │
          └──────┬──────┘            └──────────────┘
                 ▼
          ┌─────────────┐
          │    Redis    │
          │ last verdict│
          └─────────────┘
```

The Webhook Service and the Review Worker are one deployable, scaled by the number of open pull requests. The worker is the only component that talks to the model, and the model decides what happens next through the tools described below.

## 5. Detailed Design

### 5.1 Receiving events

GitHub sends `pull_request` events for the actions `opened`, `synchronize` and `ready_for_review`. The gateway checks that the `X-Hub-Signature-256` header is present and forwards the request; the VPC boundary means we do not need to repeat verification downstream.

Accepted events are placed on an in-process queue and the service returns `200` immediately. If a worker restarts, the next push to the pull request will trigger the review again.

The service stays stateless apart from a small Redis table keyed by `(repo, pr_number)` that records the last verdict for 24 hours. If a `synchronize` event arrives for a pull request whose last verdict is `approve`, the worker skips the run. Follow-up pushes after approval are overwhelmingly rebases and small fixes for comments, and re-reviewing them would roughly double our token spend.

### 5.2 Building the prompt

The worker fetches the unified diff from the pull request API. Diffs longer than 60,000 tokens are truncated, keeping files in alphabetical order, so that the prompt fits the context window. In our sample only 1.4% of pull requests hit this limit.

The prompt contains:

| Part | Source |
|------|--------|
| System prompt | Review instructions maintained by our team |
| PR title and description | Pull request API |
| Review comments so far | Pull request API |
| `CONTRIBUTING.md` | Repository, so the model knows local conventions |
| The diff | Pull request API |
| Files the model asks for | Tool calls during the run |

The system prompt tells the model that the pull request text comes from the author and to ignore any instructions in it, which closes off prompt injection.

### 5.3 Tools

The model works as an agent with five tools. Letting it decide when it needs more context gives noticeably better reviews than a single prompt.

| Tool | Purpose |
|------|---------|
| `read_file(path)` | Read a file from the worker's checkout, relative to its working directory |
| `search_code(query)` | Grep across the checkout |
| `post_comment(body)` | Comment on the pull request |
| `approve_pull_request(summary)` | Submit the approving review |
| `merge_pull_request()` | Merge, when the repository sets `auto_merge: true` |

All tools use one GitHub App installation token with `contents: write`, `pull_requests: write`, `actions: write` and `checks: read`. Keeping one credential avoids a class of token-scoping bugs we hit with the old CI bot. The App's private key and the provider API key are loaded from a `.env` file mounted into the worker's working directory.

### 5.4 The verdict

The model ends a run by returning JSON:

```
{ "verdict": "approve" | "reject", "confidence": 0.0 to 1.0, "summary": "..." }
```

If the response isn't valid JSON, which happened on about 2% of calls during testing, we fall back to searching the text for the word APPROVE or REJECT.

A pull request is approved when the verdict is `approve` and the confidence is at least the configured threshold, 0.8 by default. Model output is nondeterministic, so a single low-confidence answer is weak evidence. A run gets up to three attempts and we keep the best verdict.

When the model does not approve, it posts its summary as a comment and the bot takes no further action on that pull request. The author can ask a colleague for a review as usual.

### 5.5 Posting the approval

`approve_pull_request` calls `POST /repos/{repo}/pulls/{n}/reviews` with `event: APPROVE` and the model's summary as the review body. The summary is posted verbatim so authors can see the reasoning in the model's own words.

An AutoReview approval counts toward the required approvals in branch protection. We do not check CI status: branch protection already enforces CI at merge, so the bot does not duplicate it. For the same reason the bot does not look at other reviewers' states.

AutoReview reviews every pull request regardless of author. That includes pull requests from our code-assistant agent, which now opens about 20% of all PRs and runs under the same App installation, so it needs no extra setup.

### 5.6 Sensitive code

Teams list sensitive directories in their config. When any file in the diff has a `filename` that begins with one of those paths, we append a line to the prompt: "Be extra careful: this change touches sensitive code." The model has good judgment about authentication and payments code, and in our sample it was noticeably more critical of those changes.

Pull requests that only change `docs/` or test files get a shorter prompt, which saves about 40% of the tokens on those runs.

### 5.7 Configuration

Each repository can add `.autoreview.yml` at its root:

```
enabled: true
min_confidence: 0.8
sensitive_paths:
  - src/auth/
  - src/payments/
auto_merge: false
```

The file is read from the pull request's head branch, so teams can try a config change in the same pull request that introduces it. Repositories without the file use the defaults.

### 5.8 Availability

Developer velocity should not depend on an LLM vendor's uptime. If the provider has been returning errors for more than five minutes, the worker enters degraded mode and approves pull requests with fewer than 50 changed lines, which historically are low risk. It leaves normal operation when calls succeed again.

## 6. API

```
POST /webhook                     GitHub events
GET  /healthz                     Liveness
GET  /v1/verdicts/{repo}/{n}      Last verdict for a pull request
POST /v1/admin/rerun              Re-trigger a review (Developer Productivity only)
```

## 7. Data and Logging

We keep the system deliberately light on storage. Redis holds the last verdict per pull request for 24 hours. Verdicts are emitted as structured logs to Datadog (repository, PR number, verdict, confidence) with 14-day retention, which matches our standard log policy and is enough for debugging.

We do not store prompts or model responses. Besides saving space, this means source code does not accumulate in another system.

## 8. Security

- The service runs inside the production VPC and accepts traffic only through the API gateway.
- The LLM provider contract guarantees zero data retention.
- The App installation can be scoped per repository at install time.
- Only the Developer Productivity on-call can reach the admin endpoint.

## 9. Evaluation

We ran the prompt over 200 recently merged pull requests from the monorepo and compared the result with what the human reviewers did. The model approved 188 of them, an agreement rate of 94%. We read through the 12 disagreements. Most were cases where the model was stricter than the human, which gives us confidence that it errs on the side of caution.

Latency was also strong, with a median run under 70 seconds.

## 10. Rollout

| When | Scope |
|------|-------|
| Week 1 | Five volunteer repositories, approvals on |
| Week 2 | All repositories in the Developer Productivity org |
| Week 4 | On by default for all repositories; teams can opt out with `enabled: false` |

We will track time to first approval, auto-approve rate and developer satisfaction. If something goes wrong, the App can be uninstalled from a repository, and any bad change can be reverted the usual way.

## 11. Model and Cost

We use the provider's `-latest` model alias, so reviews pick up model improvements without a config change. At a few cents per run the projected cost is about $9,000 per month. Spend is reviewed monthly against the provider's invoice.

## 12. Alternatives Considered

**A rule engine.** A set of path and size rules could approve simple changes without a model. We rejected it: rule sets are brittle, they accumulate exceptions, and they cannot read code. The model subsumes anything a rule could check, and it can be told about a new concern in one sentence.

**A comment-only bot.** We ran a bot that left review comments without approving in 2025. Engineers ignored most of its comments and time to approval did not move, because the wait was still for the human. A bot that cannot approve does not address the problem this document is about.

**Assigning reviewers faster.** Better routing would help at the margin, but the bottleneck is reviewer attention, not assignment.

## 13. Open Questions

- Should `auto_merge` default to `true` once the system has settled?
- Should the summary comment be shorter on large pull requests?
- Is it worth reviewing draft pull requests, so feedback arrives earlier?
