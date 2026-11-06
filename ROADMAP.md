# Roadmap: Planned Projects

The next round of projects for this repository, focused on AI products and developer platforms: prompt tooling, LLM chat, token streaming, multi-tenant APIs and reliable asynchronous work. The list started as a survey of publicly reported system design questions and question banks (compiled October 2026), and was then checked against the projects that already exist here. Topics this repository already covers are listed separately with the gaps worth closing. A second survey, in November 2026, added a [rail operations track](#rail-operations-track-bnsf) for BNSF Railway loops: predictive asset health from wayside sensors, locomotive fueling, and the existing system review round.

Each planned project uses the standard layout described in [CLAUDE.md](./CLAUDE.md): `architecture.md`, the three `system-design-answer-*.md` files, a project `CLAUDE.md`, `frontend/`, `backend/` and `docker-compose.yml`. Each entry below is a starting point for that project's `architecture.md`. It gives the scope, core entities, the hard problems worth implementing and the follow-up questions the interview answers must cover.

## Table of Contents

- [About the Sources](#about-the-sources)
- [Summary](#summary)
- [Already Covered by Existing Projects](#already-covered-by-existing-projects)
- [Frontend Round Map](#frontend-round-map)
- [Shared Decisions for the LLM Projects](#shared-decisions-for-the-llm-projects)
- [Design Review Checklist](#design-review-checklist)
- [Tier 1: Product-Facing Core](#tier-1-product-facing-core)
- [Tier 2: Variations and Extensions](#tier-2-variations-and-extensions)
- [Tier 3: Infrastructure Specialties](#tier-3-infrastructure-specialties)
- [Rail Operations Track (BNSF)](#rail-operations-track-bnsf)
- [Starting a Planned Project](#starting-a-planned-project)

## About the Sources

The **Signal** column says how strong the evidence is that a question appears in real interviews. None of these attributions has been independently verified, and interview formats vary by role and team. Treat them as practice targets, not predictions.

| Label | Meaning |
|-------|---------|
| Candidate report | A public account describes receiving this question. Self-reported, not verified |
| Community attribution | A question bank attributes the question to the company. Team, date and round are unknown |
| Guide-reported | A preparation guide summarizes a candidate's experience. The underlying account was not inspected |
| Practice extension | A recommended exercise. Not known to have been asked |

Sources surveyed: Glassdoor, Aced (formerly Exponent) and Hello Interview. Project 16 also draws on Lodely, PracHub and 1point3acres. The [frontend round map](#frontend-round-map) also draws on PracHub, AceOffer and interviewing.io. Projects 19–24 (the [rail operations track](#rail-operations-track-bnsf)) draw on Glassdoor, Dataford, Interview Query, PracHub and Medium reports of BNSF Railway loops, surveyed in November 2026.

## Summary

| # | Project | Folder | Tier | Signal | Builds on |
|---|---------|--------|------|--------|-----------|
| 1 | [Prompt Playground](#1-prompt-playground) ✅ Built | [`prompt-playground/`](./prompt-playground/) | 1 | OpenAI (candidate report); OpenAI, Anthropic (community) | mcplator |
| 2 | [AI Chat Client](#2-ai-chat-client) ✅ Built | [`ai-chat/`](./ai-chat/) | 1 | OpenAI (community); Anthropic (candidate reports of frontend design rounds, including a desktop variant) | prompt-playground, imessage, mcplator |
| 3 | [Settings Service](#3-settings-service) | `settings-service/` | 1 | OpenAI (candidate report) | — |
| 4 | [LLM Chat Analytics](#4-llm-chat-analytics) ✅ Built | [`llm-chat-analytics/`](./llm-chat-analytics/) | 1 | Anthropic (community; guide-reported) | ad-click-aggregator, dashboarding |
| 5 | [LLM Inference API](#5-llm-inference-api) | `llm-inference-api/` | 1 | Anthropic (candidate reports, including batching and routing variants) | rate-limiter, scalable-api |
| 6 | [Webhook Platform](#6-webhook-platform) | `webhook-platform/` | 1 | OpenAI (community) | payment-system, stripe |
| 7 | [Multi-Org Dashboard](#7-multi-org-dashboard) ✅ Built | [`multi-org-dashboard/`](./multi-org-dashboard/) | 2 | Practice extension (frontend practice sheet); Anthropic (candidate report of a prompt-sharing variant) | prompt-playground, slack, notion |
| 8 | [Document Q&A](#8-document-qa) | `document-qa/` | 2 | Practice extension | dropbox, fb-post-search |
| 9 | [Experimentation Platform](#9-experimentation-platform) | `experimentation-platform/` | 2 | Practice extension | — |
| 10 | [LLM Eval Dashboard](#10-llm-eval-dashboard) | `llm-eval-dashboard/` | 2 | Practice extension | prompt-playground, job-scheduler |
| 11 | [CI/CD Platform](#11-cicd-platform) | `ci-cd-platform/` | 2 | OpenAI (community) | job-scheduler, github |
| 12 | [AI Code Review](#12-ai-code-review) | `ai-code-review/` | 2 | Anthropic (guide-reported) | github, ai-code-assistant |
| 13 | [File Cache](#13-file-cache) | `file-cache/` | 3 | Anthropic (candidate report) | distributed-cache |
| 14 | [Model Distribution](#14-model-distribution) | `model-distribution/` | 3 | Anthropic (candidate report) | — |
| 15 | [Online Chess](#15-online-chess) | `online-chess/` | 3 | OpenAI (community) | r-place, online-auction |
| 16 | [File System](#16-file-system) ✅ Built | [`file-system/`](./file-system/) | 3 | Anthropic (community, online assessment; candidate report for the dedup variant) | dropbox |
| 17 | [Console Growth Take-Home](#17-console-growth-take-home) ✅ Built | [`console-growth/`](./console-growth/) | 3 | Anthropic (candidate report: growth engineering take-home) | experimentation-platform |
| 18 | [In-App Assistant](#18-in-app-assistant) ✅ Built | [`in-app-assistant/`](./in-app-assistant/) | 2 | Practice extension (the sidebar variant of #2, built out) | ai-chat (#2), document-qa (#8), prompt-playground |
| 19 | [Railcar Health Monitoring](#19-railcar-health-monitoring) ✅ Built | [`railcar-health/`](./railcar-health/) | Rail | BNSF (candidate report: phone screen) | ad-click-aggregator, notification-system |
| 20 | [Locomotive Fueling](#20-locomotive-fueling) ✅ Built | [`locomotive-fueling/`](./locomotive-fueling/) | Rail | BNSF (candidate report; telemetry variants guide-listed) | uber, job-scheduler |
| 21 | [Storage Remediation](#21-storage-remediation) ✅ Built | [`storage-remediation/`](./storage-remediation/) | Rail | BNSF (guide-reported existing system review round); practice extension for the design | job-scheduler, rate-limiter |
| 22 | [Freight Quote Service](#22-freight-quote-service) ✅ Built | [`freight-quote/`](./freight-quote/) | Rail | BNSF (candidate report) | scalable-api, rate-limiter, distributed-cache |
| 23 | [Railcar Trip Plans and ETAs](#23-railcar-trip-plans-and-etas) | `railcar-trip-plans/` | Rail | Practice extension | local-delivery, notification-system |
| 24 | [Yard Switch Lists](#24-yard-switch-lists) | `yard-switch-lists/` | Rail | Practice extension (BNSF describes the system publicly) | job-scheduler, railcar-health |

- **Tier 1** covers the core product-facing work for AI and full-stack roles. Build these first, in the order listed.
- **Tier 2** covers variations on tier-1 designs. Each reuses a tier-1 data model or an existing project's patterns.
- **Tier 3** covers infrastructure specialties and lower-relevance topics. Build these when a target role calls for them.
- **Rail** covers prompts reported for BNSF Railway loops and the domain around them. See the [rail operations track](#rail-operations-track-bnsf) for the rehearsal order.
- **Builds on** lists existing projects whose patterns can be reused. Read their `architecture.md` before starting.

## Already Covered by Existing Projects

These reported questions already have an implementation here, so they don't need new projects. The gaps are candidate improvements to the existing projects.

| Question (signal) | Existing projects | Already covered | Gap to close |
|-------------------|-------------------|-----------------|--------------|
| Slack or group messaging (OpenAI candidate report; Anthropic candidate report of a chat-app screen) | [slack](./slack/), [discord](./discord/), [microsoft-teams](./microsoft-teams/), [whatsapp](./whatsapp/) | Client message IDs for dedup, PostgreSQL as the source of truth with backfill on reconnect, unread state | Rehearse the 100× and 1,000× scaling follow-ups and hot-channel fan-out |
| Distributed job scheduler (OpenAI community) | [job-scheduler](./job-scheduler/) | Heartbeats, visibility timeouts, cancel and retry, at-least-once execution | Fencing tokens so a slow worker whose lease expired cannot publish a stale result. Jobs whose external side effects are not idempotent |
| Large-scale web crawler (OpenAI candidate report) | [web-crawler](./web-crawler/) | Priority frontier, per-host politeness, robots.txt, URL and content dedup, crawler traps | Recrawl policy: deciding what to revisit first |
| Payment system with external authorization and batch processing (OpenAI community) | [payment-system](./payment-system/), [stripe](./stripe/), [paypal](./paypal/) | Idempotency keys, double-entry ledger, settlement, reconciliation | An explicit "outcome unknown" state for when the processor times out after receiving a request. Retrying only the unresolved items of a partially failed batch |
| Notification system (OpenAI, from a technical program manager report) | [notification-system](./notification-system/), [apns](./apns/) | Preferences, quiet hours, dedup, multi-channel delivery | — |
| Consolidating several notification services into one (BNSF, community attribution) | [notification-system](./notification-system/) | Dedup, retries, preferences | A migration plan: dual-writing, then cutting over each sender, without duplicate or lost messages during the switch |
| A general product app such as banking (Anthropic community attribution) | [paypal](./paypal/), [venmo](./venmo/), [robinhood](./robinhood/) | Idempotent payment submission, optimistic locking on balances, activity feeds, live quotes with stale-data indicators | — |

## Frontend Round Map

Public reports don't say which prompts a frontend-focused design round uses. This map collects the prompts reported for Anthropic design rounds that have a substantial frontend side, plus one widely shared frontend practice sheet. For each it says what to study here now and what is still missing. Signals use the labels in [About the Sources](#about-the-sources).

| Prompt (signal) | Study now | Still missing | Plan |
|-----------------|-----------|---------------|------|
| AI chat client: web, desktop, or an assistant sidebar added to an existing app (Anthropic candidate report for the desktop version; community attribution for chat rounds in general) | [ai-chat](./ai-chat/system-design-answer-frontend.md) ✅ Built: the message tree, stream state keyed by generation, resume and Stop, streamed markdown, offline reading. [in-app-assistant](./in-app-assistant/system-design-answer-frontend.md) ✅ Built: the sidebar variant, with assistant actions the user confirms. Also [prompt-playground](./prompt-playground/system-design-answer-frontend.md) deep dives 1 and 2 | The desktop shell, which the answers cover but nothing builds | — |
| Prompt playground (Anthropic community attribution, the most frequently reported prompt) | [prompt-playground](./prompt-playground/) ✅ Built | A version diff view and a grid that compares several models | Extend prompt-playground |
| Prompt-sharing platform (Anthropic candidate report, mostly backend) | [multi-org-dashboard](./multi-org-dashboard/) ✅ Built: its prompt library shares by role or revocable link, and removal revokes a member's links. prompt-playground: fork into a workspace. [google-docs](./google-docs/) and [collaborative-editor](./collaborative-editor/): concurrent editing | Real-time co-editing of a shared prompt, and closing an open prompt the instant its sharing changes | [#7](#7-multi-org-dashboard) |
| Analytics dashboard for an AI chat product (Anthropic guide-reported) | [llm-chat-analytics](./llm-chat-analytics/system-design-answer-frontend.md) ✅ Built: chat metric definitions, comparison periods, drill-down to raw records, daily buckets in each organization's time zone, cost metrics hidden by role. Also [dashboarding](./dashboarding/system-design-answer-frontend.md) and [ad-click-aggregator](./ad-click-aggregator/system-design-answer-frontend.md): downsampling and honest freshness | — | — |
| Multi-org dashboard with roles and feature flags (practice sheet; no company attribution) | [multi-org-dashboard](./multi-org-dashboard/system-design-answer-frontend.md) ✅ Built. Also [slack](./slack/system-design-answer-frontend.md): switching workspaces; [supabase-dashboard](./supabase-dashboard/): a console over many projects | — | — |
| General product app such as banking (Anthropic community attribution) | [paypal](./paypal/system-design-answer-frontend.md), [venmo](./venmo/system-design-answer-frontend.md), [robinhood](./robinhood/system-design-answer-frontend.md) | — | — |

**Rehearsal order for frontend rounds:** #2 (with #18 for the sidebar variant), then #7, then #4. All of them are built. Each covers a different family of follow-ups: long-lived streaming state in the client, access control in the client, and numbers a user can trust. Each project's `system-design-answer-frontend.md` is the file to rehearse.

## Shared Decisions for the LLM Projects

Projects 1, 2, 4, 5, 8, 10, 12 and 18 call a model. Every project in this repository must run locally and stand on its own, so they share these decisions:

- **Each project ships its own mock model service.** It streams deterministic tokens with a configurable time to first token, tokens per second, failure rate and number of concurrent slots. Failure paths such as a mid-stream disconnect, overload or timeout can then be triggered on demand, which a real provider API cannot do reliably.
- **A real provider adapter is optional.** It is enabled by an environment variable such as an API key, and it is never required for setup, smoke tests or screenshots.
- **Tokens stream over SSE.** The client reads the stream with `fetch` and a `ReadableStream`, so POST bodies and auth headers work. Use WebSockets only where the client also pushes in real time, as in chess.
- **Each run or generation is a durable record with its own state machine:** `queued → running → completed | cancelled | failed`. The server assigns its ID, and a client can reconnect to it. This record is the common thread through playground runs, chat generations, inference requests and eval runs.
- **Usage is recorded on every run.** That means input and output tokens, plus latency split into queue time, time to first token and generation time.

## Design Review Checklist

Every planned project's `architecture.md` and interview answers must answer these six questions:

1. What is the source of truth, and when is a write considered successful?
2. What happens when a client retries after losing the response?
3. What happens when a worker or server fails between two important steps?
4. Which ordering or consistency guarantee is actually required?
5. How is access enforced when caches, indexes or asynchronous jobs are involved?
6. What breaks first at much larger scale, and what evidence supports that prediction?

Each answer should also walk through **one successful and one failed execution trace**. The trace should say step by step what each component does, not just which technologies were chosen.

---

## Tier 1: Product-Facing Core

### 1. Prompt Playground

**Folder:** `prompt-playground/` · **Signal:** OpenAI (candidate report, Full Stack Engineer on the Applied team); OpenAI and Anthropic (community attribution)

**Status:** ✅ Built. See [prompt-playground/](./prompt-playground/) and its [architecture.md](./prompt-playground/architecture.md). The entry below is kept as the original brief.

**Problem.** Developers edit prompts, choose a model and its parameters, run requests, inspect results, and save or share experiments. Assume the model-serving API already exists. The design is the product built around it.

**Core entities.**
- `prompt` is the mutable head: owner, workspace and title.
- `prompt_version` holds immutable text and variables, numbered in sequence per prompt.
- `model_config` holds the model, temperature and max tokens. Saved presets carry a revision.
- `run` pins a `prompt_version_id` and a config snapshot. It records status, output, usage and timings.
- `share` maps a token to a specific version or run, with read-only access.

**Hard problems to implement.**
- **Draft and saved state.** Unsaved edits live in the client and survive a refresh. Running a draft snapshots it into a version, so every run can be reproduced.
- **Concurrent runs.** Each run streams by its own ID. Navigating to another prompt does not cancel a run, and finished runs land in history whatever the user is viewing.
- **Preset edits from two users.** Use optimistic concurrency: the client sends the revision with `If-Match`, and a stale revision returns `409` with the current state. Never let the last write silently win.
- **Cancellation that reaches the model call.** Abort the upstream request, mark the run `cancelled`, and keep the partial output with a flag that it is partial.

**Follow-ups the answers must handle.**
- A developer edits a prompt while its previous version is running. Which text belongs to the result?
- Two people update the same saved preset. How do you avoid silently overwriting either change?
- A run finishes after the user has navigated elsewhere. Where does its result appear?
- How would you add side-by-side comparisons without redesigning the data model?

**Trap.** Spending the interview on inference infrastructure when the requested system is the product around an existing model API.

**Local scope.** A React editor and run panel, an Express API, PostgreSQL, Valkey sessions and a mock model streaming over SSE.

### 2. AI Chat Client

**Folder:** `ai-chat/` · **Signal:** OpenAI (community attribution); Anthropic (candidate reports of frontend design rounds, including a desktop app variant). Formerly listed here as "ChatGPT" (`chatgpt/`).

**Status:** ✅ Built. See [ai-chat/](./ai-chat/), its [architecture.md](./ai-chat/architecture.md) and the [frontend answer](./ai-chat/system-design-answer-frontend.md). The entry below is kept as the brief.

**Problem.** A multi-user AI chat client in the shape of ChatGPT or Claude.ai: conversation history, streamed responses, cancellation, regeneration, edits that branch the conversation, sync across devices and offline reading. The prompt is reported in three forms, and the answers must be able to move between them: a web app, a desktop app, and an assistant sidebar added to an existing product.

**Core entities.**
- `conversation`.
- `message` stores the user or assistant role and a `parent_message_id`. Edits form branches, so messages form a tree.
- `generation` is one attempt at an assistant message. It records status (`accepted → running → completed | cancelled | failed`), model, usage and a checkpoint of partial output.
- Each conversation has a pointer to its current leaf message.

**Hard problems to implement.**
- **A generation outlives the HTTP connection.** A POST creates the generation, keyed by a client-supplied idempotency key, and output streams over SSE. On reconnect the client sends `Last-Event-ID` and reattaches to the same generation instead of starting a new one.
- **Persisting partial output.** Decide between checkpointing partial output and storing only completed messages, and defend the choice. One option: live tokens in a Valkey stream, with PostgreSQL written at checkpoints and on completion.
- **Edit, regenerate and retry are different.** Editing a message creates a new branch. Regenerating creates a new generation for the same user message. Retrying with the same idempotency key returns the existing generation and does not ask for a new answer.
- **Stop cancels backend work** by aborting the upstream request, not just by stopping rendering.
- **Very long conversations.** Paginate older messages, virtualize the list with `@tanstack/react-virtual`, and truncate model context on the server.

**Hard problems in the client.**
- **A stream belongs to its generation, not to the screen.** Live state sits in a store keyed by generation ID. Switching from conversation A to B while A is streaming neither cancels A nor writes A's tokens into B, and a finished generation lands in history whatever is on screen. prompt-playground solved the same problem for runs.
- **Rendering markdown that is still arriving.** Tokens split code fences and tables. Parse incrementally, re-render only the last block, and apply updates at most once per animation frame. Model output is untrusted: sanitize it, never render raw HTML, and decide which links and images from the model may load.
- **Scroll and focus.** Follow the stream only while the reader is at the bottom, and keep their place when they scroll up. Announce a finished response to screen readers instead of reading out every token.
- **Offline reading.** Cache recent conversations in IndexedDB and show them read-only when offline. Nothing that needs the model is queued, and the interface says so.
- **Branch navigation** (‹ 2/3 ›) between the versions that edits and regenerations create.

**Variants the answers must handle.**
- **Desktop.** A main process and sandboxed renderers with context isolation. A local cache that is encrypted, or wiped on sign-out. Several windows open on one conversation. Deep links. An auto-update that arrives while a generation is running.
- **An assistant inside an existing app.** The host app keeps ownership of its data. The assistant proposes actions as structured tool calls, such as archiving twelve emails. The user reviews a preview and confirms, and the host executes the change through its own APIs and permission checks. The assistant never writes host state directly.

**Follow-ups the answers must handle.**
- The connection drops halfway through a response. Can the client reconnect without creating another generation?
- What distinguishes retrying a request from asking for a new answer?
- A user opens the same conversation on two devices and submits on both at once. What happens?
- Does pressing Stop only stop rendering, or does it also cancel backend work?
- How do very long conversations change fetching and rendering?
- The user switches conversations while one is still streaming. What keeps the first conversation's tokens out of the second?
- Markdown arrives half-finished. How is it rendered, and what stops model output from running script?
- In the sidebar variant, the assistant wants to change data in the host app. Who performs the change, and what does the user confirm?

**Trap.** Treating the whole system as a React message array plus a single `POST /chat` endpoint.

**Local scope.** A React client, Express, PostgreSQL, Valkey streams and pub/sub for fan-out across devices, and a mock model with knobs for time to first token, tokens per second, failure rate and mid-stream disconnects. The desktop variant is covered in the answers, not built. The sidebar variant is built as its own project, [In-App Assistant](#18-in-app-assistant).

### 3. Settings Service

**Folder:** `settings-service/` · **Signal:** OpenAI (candidate report: a supplied preferences UI, with the task of designing its APIs and server side)

**Problem.** An application already has a preferences screen. Design the persistence, APIs, validation and sync it needs to work correctly. Keep the project deliberately small. Its value is a precise contract.

**Core entities.**
- `setting_definition` holds the key, type, allowed values, default and scope (user or organization).
- `org_setting` holds a value and an `enforced` flag.
- `user_setting` holds a user, key, value and `updated_at`.
- Each user has a revision counter for change detection.

**Hard problems to implement.**
- **Resolving the effective value.** An enforced organization value beats the user's value, which beats the organization default, which beats the global default. The API returns the effective value, where it came from, and whether it is locked.
- **Per-key PATCH semantics.** A phone and a browser that change different keys must both succeed. Detect conflicting changes to the same key with a revision and `If-Match`.
- **A lost response.** A PATCH sets values instead of toggling them, so it is idempotent by construction. The client re-fetches to learn the outcome.
- **Unknown or obsolete keys.** Reject them with `422` and an error per field, or accept and ignore deprecated keys during a grace window.
- **Sync across tabs and devices.** Use a `BroadcastChannel` between tabs and SSE invalidations from the server, keyed by revision.
- **The storage trade-off.** Compare typed columns, a JSON document and key-value rows, including what happens when a new setting and its default are introduced for existing users.

**Follow-ups the answers must handle.**
- A phone and a browser update different preferences at the same time. Can both changes survive?
- What happens when a client submits a setting that no longer exists?
- How do settings an administrator enforces interact with personal preferences?
- The update succeeds on the server but its response is lost. What does the client do?
- How does another open tab learn that a setting changed?

**Trap.** Overengineering a small system while leaving basic update semantics ambiguous. A clear relational schema and a precise API contract matter more here than distributed architecture.

**Local scope.** Express, PostgreSQL and Valkey pub/sub for change notifications. The "given" settings screen ships alongside an admin screen for organization policy.

### 4. LLM Chat Analytics

**Folder:** `llm-chat-analytics/` · **Signal:** Anthropic (community attribution; guide-reported as a dashboard for an AI chat app)

**Status:** ✅ Built. See [llm-chat-analytics/](./llm-chat-analytics/) and its [architecture.md](./llm-chat-analytics/architecture.md). The entry below is kept as the brief.

**Problem.** Near-real-time dashboards for an AI chat product: active users, conversation activity, response latency, error rates, token usage and adoption of product features.

**Core entities.**
- **Metric definitions come first.** Write down what counts as a conversation, an active user, a successful response and an abandoned generation.
- **Event contract.** Each event carries `event_id`, `org_id`, `user_id`, `event_type`, `event_time`, `received_time`, `schema_version` and a source (client or server). It never carries message content.
- **Rollups** by minute, hour and day, broken down by organization, model and feature.
- **A late-data watermark** per stream.

**Hard problems to implement.**
- **Dedup and late data.** Deduplicate by `event_id` at ingestion. Bucket by event time, not processing time. Late events reopen closed buckets, which is why yesterday's number can change. Show a "complete through" watermark.
- **Metrics that don't add up.** Unique users need mergeable sketches such as HyperLogLog, not summed hourly counts. A daily p95 latency needs histograms or t-digests, not an average of hourly p95 values.
- **Time zones.** Store UTC buckets and compute daily buckets in the organization's time zone.
- **Privacy.** Conversation content never enters the pipeline. Suppress breakdowns for very small cohorts.
- **Frontend.** Filters live in URL state, cache keys derive from the filters, charts cross-filter, and a freshness label tells the truth about lag.
- **Comparison periods and drill-down.** Week over week compares aligned buckets in the same time zone, and a period that is still open is marked partial. Selecting a bar opens the conversations behind it with exactly the same query, showing metadata only.
- **Rapid filter changes.** A request is keyed by its full query, superseded requests are aborted, and a late response for an old key never paints over a newer one.
- **Metrics gated by role.** The API leaves out cost and other sensitive columns for roles that can't see them. Hiding them in the chart is not enough.
- **Exports** of large ranges run as background jobs with progress, not in the browser.

**Follow-ups the answers must handle.**
- Events arrive late or twice. How do the charts change?
- Why might yesterday's number be different today?
- How do time zones affect daily buckets?
- Can you add up hourly unique-user counts, or average several p95 values, to get the daily result?
- How do you keep analytics from exposing private conversation content?
- What freshness guarantee can the interface honestly display?
- The user changes filters several times a second. What reaches the server, and what reaches the screen?
- A new metric needs a backfill. What do the charts show for the period before it existed?

**Trap.** Producing an excellent chart-component architecture without explaining where trustworthy, consistently defined numbers come from.

**Local scope.** A generator that simulates chat traffic, then Kafka or RabbitMQ, ClickHouse materialized views, a query API and a React dashboard. Reuse the ad-click-aggregator patterns.

### 5. LLM Inference API

**Folder:** `llm-inference-api/` · **Signal:** Anthropic (candidate reports covering an API-focused exercise on sampling, batching and request orchestration; a batching round; and a routing round with sticky assignment)

**Problem.** A multi-tenant developer API that exposes a model. It supports request submission, streamed or asynchronous output, cancellation, usage accounting and overload handling. Two reported variants become deep dives: batching requests onto limited compute, and routing requests across model-serving backends. The batching variant uses one accelerator that processes up to 100 inputs at a time; treat that as an exercise assumption, not a real serving limit.

**Core entities.**
- `api_key` belongs to an `org`, which has a tier and request and token limits.
- `request` records the ID, organization, model, estimated tokens, `max_tokens`, mode (sync, stream or async), status and priority class.
- `usage` records input and output tokens, `queue_ms` and `exec_ms`.
- `backend` records the model version, capacity slots, health and draining state.

**Hard problems to implement.**
- **Admission control by cost, not request count.** Estimate input tokens plus `max_tokens` and charge that against each organization's token bucket. Return `429` with `Retry-After` for a tenant over its limit. Use a separate overload response when the whole system is over capacity. Queues have bounded depth.
- **Request ownership.** The edge assigns the request ID, and that ID owns the work. If the client disconnects, a sync request is cancelled. An async request keeps running and its result can be fetched later.
- **Cancellation racing completion.** One atomic state transition decides the outcome, and the caller sees whichever transition won.
- **Batching.** A batch dispatches when it is full, when the oldest request reaches its maximum wait, or when a deadline policy says so. Interactive and bulk work use separate queues. Overload sheds load instead of letting the queue grow without limit.
- **Routing.** First establish why affinity is needed. Prefix-cache reuse is a performance preference, not a correctness requirement. Use consistent hashing with bounded load, and drain backends during rollouts. Once output has started, a request cannot move to another backend.
- **Latency metrics.** Split queue time, time to first token and tokens per second, so queueing delay is never mistaken for slow execution.

**Follow-ups the answers must handle.**
- Two requests have similar payload sizes but very different execution costs. How should admission control treat them?
- The API server times out while the model is still working. Who owns the request?
- How do you correlate queued work with the original caller?
- When cancellation races with completion, what result does the caller observe?
- How do you keep one customer from consuming all available capacity?
- When traffic is low and a batch never fills, how long does a request wait?
- During overload, what stops the queue from growing forever?
- Can a request move to another backend after output has begun? What happens when routing information is stale?
- Does adding a server invalidate existing assignments? What happens during a rolling model-version change?

**Trap.** Treating this as an ordinary CRUD API. At the opposite extreme, diving into GPU internals before establishing the product contract.

**Local scope.** An Express gateway, Valkey for rate limits and queues, PostgreSQL for keys and usage, and three mock model backends on separate ports with fixed batch capacity. An admin console shows queue depth, how full batches are and usage per tenant.

### 6. Webhook Platform

**Folder:** `webhook-platform/` · **Signal:** OpenAI (community attribution)

**Problem.** Customers register callback URLs, and the platform sends them HTTP notifications when events occur. It retries failed deliveries, keeps delivery history and supports manual replay. The payment-system and stripe projects deliver webhooks as one component. This project makes delivery the whole product.

**Core entities.**
- `endpoint` stores the URL, an event-type filter, one or two active secrets for rotation, and a status (active or disabled).
- `event` is immutable: `event_id`, type, payload and creation time.
- `delivery` pairs one event with one endpoint.
- `attempt` records the status code, latency, error class and `next_attempt_at`.

**Hard problems to implement.**
- **At-least-once delivery.** Receivers deduplicate by `event_id`. The platform never claims exactly-once delivery.
- **Isolation per endpoint.** Each endpoint gets its own concurrency limit, so an endpoint that is down for six hours doesn't block other customers. Back off exponentially with jitter, stop retrying after a set horizon, then disable the endpoint and notify the customer.
- **Signatures.** Sign the timestamp and body with HMAC. Two secrets stay valid during rotation, and a replay window rejects old timestamps.
- **SSRF protection.** Resolve DNS when connecting, not only at registration. Block private, link-local and metadata address ranges, and don't follow redirects into them.
- **Transient versus permanent failures.** Retry `5xx`, `429` and timeouts. Stop on `410` or an invalid URL.
- **Replay** creates a new attempt for the same `event_id`, not a new event.
- **Ordering** isn't guaranteed by default. Explain what strict ordering per endpoint would cost in head-of-line blocking, and offer per-key sequence numbers instead.

**Follow-ups the answers must handle.**
- A receiver processes an event but its acknowledgment is lost. What happens next?
- One customer's endpoint is down for six hours. Can it block other customers?
- Do events require ordering? What does that requirement cost?
- What does replay mean: the same event ID, or a new event?
- How should permanent failures differ from transient ones?

**Trap.** Claiming exactly-once delivery because a queue is involved.

**Local scope.** An Express API, PostgreSQL, RabbitMQ delivery workers, a customer console with delivery logs and replay, and a bundled mock receiver. The receiver has toggles to respond slowly, return `500`, drop the acknowledgment or return `410`.

---

## Tier 2: Variations and Extensions

### 7. Multi-Org Dashboard

**Folder:** `multi-org-dashboard/` · **Signal:** Practice extension, from a widely shared frontend practice sheet; Anthropic (candidate report) for the prompt-sharing variant. This entry replaces the earlier Workspace Permissions plan and keeps its scope.

**Status:** ✅ Built. See [multi-org-dashboard/](./multi-org-dashboard/) and its [architecture.md](./multi-org-dashboard/architecture.md). The entry below is kept as the original brief.

**Problem.** The console of a multi-tenant AI product, such as a platform for building support agents. Each organization has modules for agents, a knowledge base, conversation history, analytics, billing and settings. A user can belong to several organizations with a different role in each, and features are switched on per organization and per role. In the prompt-sharing variant the modules become a prompt library, where each prompt is private, shared with named roles or shared by link.

**Core entities.**
- `org` and `project`.
- `membership` links a user to an organization or project with a role. Each role maps to a set of permissions.
- `invitation` holds a token, an expiry and a role.
- `resource` has an owner and belongs to a project.
- `share_link` holds a token, permission, expiry and `revoked_at`.
- `feature_flag` holds a key and rules by organization and role.
- `audit_event` records the actor, action, target and the values before and after.
- `export_job` records the query, status, progress and the resulting file.
- Plan entitlements control which features are available. They are separate from permissions.

**Hard problems to implement.**
- **Authorization is enforced in the API and inside queries**, by filtering on the projects a user can access. Hiding buttons in the interface is not enforcement.
- **Revocation and caches.** Cache permission sets with a short TTL and a version that bumps when membership changes. Writes always check authoritatively.
- **Switching organizations in the client.** The organization ID is part of the URL and of every cache key. Switching aborts requests still in flight for the old organization and drops any response that arrives anyway.
- **Removing a member.** Handle their sessions, their open SSE or WebSocket streams, invitations still outstanding and the share links they created.
- **One permission source for routes, sidebar and buttons.** The server returns one manifest of effective permissions and flags for the current organization. Route guards, the sidebar and action buttons all read it, so they cannot disagree.
- **Access changing mid-session.** A `403`, or a version bump pushed over SSE, refetches the manifest. A view the user can no longer open closes with an explanation, not a blank screen.
- **`401`, `403` and `404`.** An expired session signs in again and returns to the same URL. A forbidden page explains why and offers to switch organization or request access. A resource from another organization answers `404`, so the response doesn't reveal that it exists.
- **History at scale.** Conversation history uses cursor pagination, filters kept in the URL and a virtualized table. A deep link opens the detail pane over the filtered list.
- **Exports** run as background jobs with progress and a notification when they finish.

**Follow-ups the answers must handle.**
- A user switches organizations while a request is in flight. What happens to its response?
- Where are role checks enforced, and why are they in both the client and the server?
- A user opens a deep link to a page their role can't see. What do they get?
- An administrator removes access while the user has the page open. What does the user see, and when?
- How are client caches scoped so that data from two organizations never mixes?
- How do you test combinations of roles and flags without testing every permutation?

**Key question.** What cached state must be invalidated when access changes, and which server checks stay authoritative before that invalidation completes?

**Local scope.** Express, PostgreSQL and a Valkey permission cache. A React console seeded with two organizations, three roles and one feature flag, plus admin screens for members, roles, invitations and links.

### 8. Document Q&A

**Folder:** `document-qa/` · **Signal:** Practice extension

**Problem.** Users upload documents to an assistant. The system extracts, chunks, embeds and indexes them, uses them to answer questions with citations, and supports deletion.

**Core entities.**
- `document` records the tenant, owner, content hash, version and status (`uploaded → processing → ready | failed`).
- The original file is a blob in object storage.
- `chunk` records the document version and offsets.
- Each index entry carries the tenant, document version and access scope.
- `processing_job` records the stage and attempt.

**Hard problems to implement.**
- **Idempotent pipeline stages.** Key each stage by document version and stage name, so a worker that crashes midway can resume or redo safely.
- **Duplicate uploads** are detected by content hash per tenant.
- **Updated documents.** Index the new version before retiring the old version's chunks.
- **Tenant isolation and permission changes.** Filter retrieval by tenant and access scope, then re-check access to the document before returning any chunk. The index is not the authority on access.
- **Deleting a document.** Write a tombstone first so the document disappears immediately. Then purge the blobs, chunks, embeddings and caches, and track when the purge completes.

**Key question.** A document becomes inaccessible while its content remains in an index or cache. How does the design avoid returning it?

**Local scope.** MinIO, PostgreSQL with pgvector, RabbitMQ workers, a mock embedding model that returns deterministic vectors, and a mock model that answers with citations.

### 9. Experimentation Platform

**Folder:** `experimentation-platform/` · **Signal:** Practice extension. It is especially useful for growth roles.

**Problem.** Feature flags and A/B experiments: assigning variants, delivering config, logging exposure, attributing conversions and a kill switch.

**Core entities.**
- An experiment or flag has a key, an assignment unit (user, organization or anonymous ID), variants with weights, a salt, a status and a version.
- Targeting rules.
- An exposure event is logged when the treatment actually renders.
- Conversion events.
- Clients fetch versioned snapshots of the ruleset.

**Hard problems to implement.**
- **Deterministic assignment.** Hash the salt and unit ID into a bucket. The assignment stays stable across devices for signed-in users. Decide what happens when an anonymous user signs in.
- **Evaluation in the SDK.** The SDK evaluates locally from a cached ruleset, and the server pushes updates. If a fetch fails, the SDK uses the last known good ruleset, and otherwise safe defaults. The kill switch reaches clients within seconds.
- **Exposure is not assignment.** Log exposure at render time, and analyze the exposed users rather than everyone assigned.
- **Weight changes mid-experiment.** Changing weights reshuffles users unless bucket ranges stay stable.

**Key question.** A user was assigned a treatment but never actually saw it. Should that count as exposure, and how does the system tell the two cases apart?

**Local scope.** Express, PostgreSQL, Valkey for the ruleset cache and pub/sub, and ClickHouse for exposures and conversions. A small JS SDK, a demo app and an admin results view.

### 10. LLM Eval Dashboard

**Folder:** `llm-eval-dashboard/` · **Signal:** Practice extension. It reuses the prompt playground's data model.

**Problem.** Versioned test datasets, prompt and model configurations, asynchronous evaluation runs, inspection of results and comparisons between runs.

**Core entities.**
- `dataset_version` holds immutable test cases.
- `prompt_version` and `model_config` work as in the playground.
- `scorer_version` can be exact match, regex, model-graded or human.
- `eval_run` pins a dataset version, prompt version, model config and scorer version, along with a sample count per case.
- `case_result` records the attempt, output and score.
- `annotation` stores human labels.

**Hard problems to implement.**
- **Provenance.** A comparison is only meaningful when the dataset, scorer and config versions are pinned. The UI flags comparisons that mix them.
- **Partial failures.** Retry individual cases. A run finishes as "N errored" instead of silently averaging the cases that survived.
- **Nondeterministic outputs.** Take several samples per case and report variance or a confidence interval, not the difference between two single runs.
- **Re-scoring.** Score existing outputs with a new scorer version without generating them again.

**Key question.** The prompt, dataset and scoring function all changed. What information is required before a comparison can be called an improvement?

**Local scope.** Express, PostgreSQL, queue workers, a mock model and React views for comparing runs.

### 11. CI/CD Platform

**Folder:** `ci-cd-platform/` · **Signal:** OpenAI (community attribution). It extends the [job-scheduler](./job-scheduler/) project.

**Problem.** Repository events trigger workflows made of dependent jobs. Users inspect status, live logs and artifacts. The system has to handle bursts of events.

**Core entities.**
- A trigger event records the delivery ID, repository and commit SHA.
- `workflow_run` pins the commit SHA and the SHA of the workflow file.
- `job` is a node in a dependency graph, with a `needs` list, status and attempt.
- `runner` has labels and a lease.
- Log chunks are numbered in sequence.
- Artifacts live in MinIO.
- `secret` is scoped to a repository or environment.

**Hard problems to implement.**
- **Duplicate push events.** Deduplicate by delivery ID. Each run pins an immutable commit and config.
- **Scheduling the dependency graph.** A job becomes ready when every job it needs has succeeded. A failure cancels downstream jobs.
- **Runner leases and heartbeats.** A runner can vanish after a deploy step already succeeded. Steps that are not idempotent are marked and never retried automatically.
- **Running untrusted code.** User code runs in ephemeral sandboxes. Pull requests from forks never receive deployment secrets.
- **Resumable log streaming.** Use SSE with `Last-Event-ID`, mapped to a log offset.
- **Retry semantics.** Re-running one job, only the failed jobs or the whole workflow creates new attempt numbers within the same run.

**Follow-ups the answers must handle.**
- What happens when the same push event arrives twice?
- How do dependent jobs learn that their prerequisites finished?
- How does a user resume watching logs after a disconnect?
- Can an untrusted pull request access deployment secrets?
- What happens when a runner disappears after a deployment succeeded?

**Trap.** Designing only the queue while neglecting execution boundaries, credentials and repeatability.

**Local scope.** Reuse the job-scheduler patterns. In local mode, runners execute steps as sandboxed child processes instead of containers, and the README documents that substitution. Push events come from the [github](./github/) project or from fixtures.

### 12. AI Code Review

**Folder:** `ai-code-review/` · **Signal:** Anthropic (guide-reported: the candidate critiqued an existing design document instead of designing from scratch)

**Problem.** A proposed system fetches a pull request's diff, asks a model to assess it and automatically approves the changes it judges acceptable. Find the consequential omissions, then build the corrected design.

**Different deliverables.** This project practices a different format, a design critique. In addition to the standard files, it ships:
- `proposed-design.md`: the deliberately flawed design document, as a candidate would receive it.
- `design-review.md`: the critique, with findings ranked by severity.

**The critique must catch these issues.**
- An approval must bind to one specific head commit SHA. A new push invalidates it.
- Prompt injection can arrive through the diff, comments or repository files. Model output is untrusted data.
- Model output never authorizes anything. A deterministic policy gate checks the preconditions independently: CI is green, required reviewers have approved, no protected paths are touched and the change is within size limits.
- The agent's tools get least-privilege permissions. An audit log records the inputs, model version and decision.
- Measure dangerous false approvals against labeled history. Run first in an observation-only mode that just comments, then auto-approve a narrow scope.
- There is a path to escalate to a human.

**Local scope.** A webhook receiver, a policy engine, a mock model reviewer and an audit UI. It can consume events from the [github](./github/) project or a set of fixture pull requests.

---

### 18. In-App Assistant

**Folder:** [`in-app-assistant/`](./in-app-assistant/) · **Signal:** Practice extension (the "assistant sidebar added to an existing app" variant of [#2](#2-ai-chat-client), built out from a design discussion of how Gmail, Docs, Maps and Word add LLM chat) · ✅ Built

**Problem.** An established web tool adds an LLM chat that does things in the app from natural language. The model is wired into operations the app already has (search, drafts, a document command API); the new part is the layer that turns a request into calls to those operations and the results back into text and UI. The project builds it for a mail, docs and calendar suite.

**Core entities.**
- `turn`: one user message and everything done to answer it, saved as a state machine (`running → waiting_client | waiting_confirmation → running → completed | failed | cancelled`), with the turn's slice of the model conversation and the in-flight tool batch.
- `turn_step`: the audit trail (model calls, tool calls, policy decisions, notices).
- `pending_action`: a confirmation card; `tool_execution`: the idempotency record of a tool write.
- `chunk`: an indexed passage with its ACL, keyword vector and embedding; `index_event`: the outbox, with priority lanes.

**Hard problems implemented.**
- **A bounded, resilient agent loop**: budgets with a tools-off wrap-up, retries and a fallback model, mid-stream failure, max_tokens on text or tool calls, invented tools and invalid arguments returned as fixable errors, loop detection, context trimming, cancellation.
- **Waiting without blocking**: confirmations and browser-executed tools suspend the turn; any instance resumes it; a sweeper gives every waiting state a defined timeout and takes over turns from crashed instances.
- **Safety in code**: a policy engine on effect, reversibility, settings and taint from untrusted content; drafts-first and tracked suggestions keep actions reversible.
- **Permission-correct grounding**: hybrid search with the ACL filter inside the query, fusion, rerank, a freshness tail for unindexed mail, a re-check against source tables, citations verified against retrieved items.
- **Prompt layout for caching** and a mock model that speaks the Messages API format, so the same code runs against Claude.

**Follow-ups the answers must handle.**
- The assistant wants to change data in the host app. Who performs the change, and what does the user confirm?
- An email tells the assistant to forward invoices to an outside address. What stops it?
- The user confirms ten minutes later, on another server. How does the turn continue?
- The server crashes after a write but before saving progress. Is the write done twice?
- How is the document shown to the model so edits survive concurrent typing?
- Which requests should not use the agent loop at all?

**Local scope.** Express, PostgreSQL with pgvector, Valkey streams for turn events, an outbox-driven indexer, a mock model with failure switches, an eval runner, and a React suite with the assistant panel and an operations dashboard.

## Tier 3: Infrastructure Specialties

### 13. File Cache

**Folder:** `file-cache/` · **Signal:** Anthropic (candidate report; the question doesn't say whether the cache is local or distributed, so clarify that first)

**Problem.** Applications repeatedly read large files from a slow origin. Add a cache, bounded in bytes, that speeds up reads without ever serving incorrect content. The [distributed-cache](./distributed-cache/) project is a key-value cache. This one stores whole files.

**Core entities.**
- The cache key is the path plus the origin's version or ETag, or a content hash.
- Entry metadata records size, state (filling or complete), last access, a reference count and whether the entry is pinned.
- The file on disk is written to a temporary path and atomically renamed when complete.

**Hard problems to implement.**
- **Single-flight fills.** Concurrent misses for the same file share one origin download. Readers either stream from the fill in progress or wait for it.
- **Incomplete downloads** are never visible as complete. Verify the size and hash before the rename.
- **Size-aware eviction.** Choose a policy, such as an admission filter on top of segmented LRU, so one enormous file can't push out thousands of useful small ones.
- **Evicting a file in use.** Reference counts keep a file readable until its last reader finishes. A file is never truncated under a reader.
- **A mutable origin.** Revalidate with an ETag or version. Whether stale data may be served during an origin outage is an explicit policy decision.
- **Authorization** is checked at the cache, not only at the origin.

**Trap.** Answering with an LRU hash map and a linked list when the problem is a whole storage service.

**Local scope.** A Node cache service on local disk, with MinIO as the slow origin through injected latency. The distributed variant runs two or three cache nodes with consistent hashing. A dashboard shows the hit ratio by bytes as well as by requests.

### 14. Model Distribution

**Folder:** `model-distribution/` · **Signal:** Anthropic (candidate report; a community version specifies a 500 GB file, 1,000 servers and a 10 Gbit/s link)

**Problem.** Distribute a huge file to thousands of machines, each with limited bandwidth, while tolerating interrupted transfers, failed hosts and corrupt chunks. Then activate the new version safely.

**Core entities.**
- A signed `manifest` lists the version and every chunk with its hash.
- The system tracks which chunks each host has.
- A transfer records the host, chunk and source peer.
- Each host's activation state moves `downloading → verified → staged → active`.

**Hard problems to implement.**
- **Bandwidth lower bounds come first.** If every host downloads from the origin, 1,000 hosts × 500 GB over 10 Gbit/s takes about 4.6 days. Pushing a single copy through the origin link takes about 400 seconds. With peer-assisted chunk exchange, the total time approaches that single-copy bound plus pipeline depth.
- **Chunks and integrity.** Each chunk's hash is in the manifest, and transfers resume. Choose between spreading the rarest chunks first and fanning out down a tree.
- **Network topology.** Prefer peers in the same rack, and cap distribution bandwidth so it doesn't starve serving traffic.
- **Seeding strategy.** Decide between seeding a few hosts quickly and spreading chunks broadly right away.
- **Arriving is not deploying.** Activation is a separate, gated rollout with health checks. The previous version stays on disk so rollback is fast.

**Trap.** Confusing "the file reached every host" with "the fleet safely deployed a new version."

**Local scope.** A tracker, plus 10 to 20 simulated hosts as processes with bandwidth throttled by a token bucket. A scaled-down file of a few GB. A visualization of how chunks spread.

### 15. Online Chess

**Folder:** `online-chess/` · **Signal:** OpenAI (community attribution)

**Problem.** Real-time games with move validation, clocks, matchmaking, reconnecting clients and spectators.

**Core entities.**
- `game` records the players, status, current position, ply number, clocks and version.
- `move` records the ply number, the move, and client and server timestamps.
- A matchmaking ticket records rating and time control.
- Spectator subscriptions.

**Hard problems to implement.**
- **The server holds the authoritative state.** Every move is validated against the server's position. A move carries the ply number it expects, so a move from a stale client against an old position is rejected.
- **Clocks.** The server measures time between authoritative events, with bounded lag compensation. The server, not the client, detects when a player runs out of time.
- **Simultaneous actions.** A move, a resignation and a timeout can arrive at the same instant. One serialized writer per game decides the order.
- **Reconnecting.** The client fetches a state snapshot, then resumes the event stream from its last ply.
- **Matchmaking** widens the acceptable rating range the longer a player waits.
- **Spectators** watch on a read-only, optionally delayed fan-out channel.

**Local scope.** A WebSocket gateway, a game service that routes each game to a single writer, PostgreSQL, Valkey pub/sub for spectators and `chess.js` for move validation.

### 16. File System

**Folder:** [`file-system/`](./file-system/) · **Signal:** Anthropic (community attribution: a 2026 preparation guide lists a cloud storage or file system simulation among the online assessment's problems, though most reports describe an in-memory database variant of the same format. A separate candidate report describes an onsite coding round on finding duplicate files) · ✅ Built

**Problem.** Build an in-memory file storage system in four levels, each extending the last, then scale the same model into a service. The online assessment is reported as a timed CodeSignal test of about 90 minutes. It has one problem with four levels and hidden tests, and the next level unlocks only after the current one passes. Later levels can't be read in advance, so the skill being tested is choosing a data model that survives requirements you haven't seen yet. If that assessment is coming up, build this before the other tier-3 projects.

**Different deliverables.** The core of this project is a library, not a service. In addition to the standard files, it ships:
- `levels.md`: the practice spec, written for this repository, with the operations and edge cases for each level. It is not a copy of any real assessment.
- `levels-db.md`: a second spec in the same format for the in-memory database variant, also written for this repository. `npm run practice -- start --problem db` runs it.
- `backend/src/fs/` and `backend/src/kv/`: the two worked answers, each with one vitest suite per level, so a practice attempt can be checked one level at a time.
- Practice notes in the project `CLAUDE.md`: the time each level took, and what the data model had to change to fit the next level.

**Practice levels.**
1. **Files.** Add, read, overwrite and delete a file at a path, with a size. Return defined failure values for duplicate and missing paths.
2. **Queries.** List a directory, and return the N largest files under a prefix, sorted by size descending and then by name.
3. **Users and quotas.** Every file has an owner, and every user has a byte capacity. A write that would exceed it fails with no partial effect. Merging two users moves the files and combines the capacities.
4. **History.** Two alternative tracks, to cover both reported variants. *Backup:* back up a user's files and restore them later, skipping paths another user now owns. *Time:* every operation carries a timestamp, files can have a time to live, and reads can ask for the state as of a past time.

**Second variant: an in-memory database.** Most reports describe this one, so it gets its own four levels in the same format:
1. **Records.** Set, read and delete fields within records. A record exists while it holds a field, and an empty value is still a value.
2. **Scans.** List a record's fields, all or by name prefix, and the records with the most fields under a key prefix, each with exact ordering and output-format rules.
3. **Timestamps and expiry.** Every method gains a timestamped twin, values can have a time to live, and every write starts a new lifetime.
4. **History.** Two alternative tracks. *History:* read a field or a record as of a past time. *Backup:* back up the whole store at a timestamp and restore it later, with each field's remaining lifetime restarting at the restore.

**Hard problems to implement.**
- **A data model that survives level 4.** Store each file once, with its owner, size and timestamps, in one map keyed by full path. Update per-user usage in the same operation that changes the file map. Two copies of a fact that must stay in sync are where hidden tests catch you.
- **Path-keyed map or tree of nodes.** A flat map makes lookups O(1) but turns a directory rename into a rewrite of every path under it. A tree of nodes makes rename one pointer change, but every lookup walks the path. Say which one the levels need and what changes if a later level adds move or rename.
- **Validate before mutating.** Merge, restore and quota-checked writes check every precondition before changing anything, so a failure leaves no partial state.
- **Exact output rules.** Tie-breaking (equal sizes sort by name) and output formats are where hidden tests fail most often. Write the edge-case tests before the code.
- **Duplicate files**, the onsite variant. Find groups of identical files in a very large tree without loading whole files into memory. Group by size, then by a hash of the first block, then by a full streaming hash.

**Scaling it into a service.** The interview answers take the same model to production:
- The namespace becomes a metadata service, separate from blob storage. [dropbox](./dropbox/) already covers chunked blobs and sync, so this project covers the metadata tree.
- Quotas are enforced with reserve-then-commit under concurrent uploads.
- Moving a directory between metadata shards needs a cross-shard transaction, or a sharding scheme that keeps each subtree on one shard.
- Snapshots use copy-on-write, so a backup doesn't copy every file.
- The N largest files under a prefix need a maintained index once a scan is too slow.

**Trap.** Writing level 1 so cleverly that it eats the time levels 3 and 4 need, or so narrowly that level 3 forces a rewrite. Pass each level first, then refactor before opening the next one.

**Local scope.** The library and its per-level tests, with a script that resets the library to stubs for a timed practice attempt, for either variant. A thin Express API over the file store, with PostgreSQL for the persistent variant, and a React file browser that shows the tree, each user's quota and their backups.

### 17. Console Growth Take-Home

**Folder:** [`console-growth/`](./console-growth/) · **Signal:** Anthropic (candidate report: a two-hour take-home for a growth engineering role, done in a hosted IDE with an AI coding assistant, whose transcript is reviewed) · ✅ Built

**Problem.** The take-home gives you:
- a small, working slice of a developer console for an LLM API (Workbench, API keys, usage, limits, billing), seeded with one account;
- a product-wide metrics snapshot;
- an experiment framework: deterministic assignment, overrides and exposure logging.

You find the highest-leverage growth opportunities and propose one large and one small experiment, sized by expected impact. Then you ship both as A/B experiments with tests, and write a readout of what you built and how you'd measure and roll it out. The brief grades product sense and engineering about equally, and it requires the ideas and sizing to be the candidate's own.

**Different deliverables.** A take-home, not a system design question, so there are no interview answers. It ships instead:
- `README.md`: the practice brief, written for this repository.
- `METRICS.md`: a fictitious, internally consistent snapshot with several opportunities planted in it, not only the two that were built.
- `EXPERIMENTS.md`: a worked answer.
- The bare starter as its own commit, for timed practice. See the project `CLAUDE.md`.

**What it tests.**
- **Finding and sizing.** Turning funnel, segment and support data into a dollar estimate, with the assumptions labeled.
- **Exposure placement.** Log exposure where the user would meet the difference, under the same condition in both arms, not on page load.
- **Randomization unit.** Org for anything billing-shaped, so teammates see the same thing.
- **Server-side conversions with source attribution.** Fix the snapshot's instrumentation gaps rather than work around them.
- **Choosing the primary metric.** The problem (fewer orgs running out of credits), not the mechanism (auto-reload adoption).
- **Keeping the control unchanged**, and testing that it is.

**Traps.** Building past the time box instead of shipping a scoped slice and writing down the cut. Ideas without sizing. Logging exposure only in the treatment. Pasting AI-generated ideas: the brief forbids it, and the transcript is reviewed.

**Local scope.** An in-memory Express API (port 3001) and a React app on Vite (port 3000), following the brief's stack: plain JS, mocha + supertest, plus vitest for components. A Dev toolbar to force variants, stream events, reset the seed and simulate API traffic. `npm run readout` computes each experiment's metrics from the event log. [Experimentation Platform](#9-experimentation-platform) is the system design counterpart.

---

## Rail Operations Track (BNSF)

A second survey (November 2026) covered system design questions reported for BNSF Railway's software, data and platform engineering loops. In early 2025 BNSF created an in-house technology division, bnsf | tech, to build more of its own software. Its public material emphasizes three areas: predictive asset health from wayside sensors, yard and network optimization, and AI. Candidate reports describe a final loop of about four to five hours, with separate rounds for coding, software design, system design, an **existing system review** (presenting a system you built) and behavioral questions. Design prompts in these reports usually have a railroad setting.

Signals use the labels in [About the Sources](#about-the-sources). The interview reports come from Glassdoor, Dataford, Interview Query, PracHub, Reddit and a Medium write-up. The domain context comes from BNSF's "Eyes on AI" page, its FY2025 10-K, Progressive Railroading, Railway Age, the AAR and Railinc.

**Format notes from the reports.**
- No drawing tool is provided. Bring your own whiteboard link and share your screen.
- Several reports say interviewers give little help during technical rounds, so practice driving a whole design without prompts.
- One report says some design questions matched common question banks, so the classic projects in this repository still apply. The rail-themed prompts are the ones worth rehearsing specifically.

**Rehearsal order for a BNSF loop:**
1. [#19 Railcar Health Monitoring](#19-railcar-health-monitoring)
2. [#20 Locomotive Fueling](#20-locomotive-fueling)
3. [#21 Storage Remediation](#21-storage-remediation): read its `existing-system-review.md` as a template for presenting your own system
4. [#22 Freight Quote Service](#22-freight-quote-service): a generic reliability question in a rail setting

**Public figures worth knowing for estimates.**

| Fact | Value | Source |
|------|-------|--------|
| Network | 32,500+ route miles in 28 states | BNSF FY2025 10-K |
| Fleet owned or leased | ~6,700 locomotives and ~70,700 freight cars | BNSF FY2025 10-K |
| Wayside data | AI processes 35M+ readings a day; 1.5M+ wheels monitored; machine vision handles 2M+ images a day | BNSF "Eyes on AI" |
| Hot bearing detector spacing | Average of 15 miles on key routes, at most 20 with acoustic detection, plus a standard for trend analysis | AAR Class I commitments, March 2023 |
| Industry detector network | ~10,000 wayside detectors and 36M train passes a year feed Railinc's EHMS | Railinc |

Most railcars on a Class I network belong to lessors and shippers, not to the railroad. A prompt about "200,000 railcars" therefore also means alerting the cars' owners.

**Rail terms for engineers from outside the industry.** The interviews don't expect rail experience, but the prompts use these words. Ask about anything else.

| Term | Meaning |
|------|---------|
| Consist | The ordered list of cars and locomotives in a train. It changes at yards, so version it by time |
| Axle, wheelset, bearing | Four axles per car, each with two wheels and two bearings. Wheelsets are replaceable parts, so a car is not its components |
| Wayside detector | A sensor beside the track that measures every passing axle: bearing or wheel temperature, impact load, sound or images |
| Hot bearing / hot box | An overheating bearing, a derailment risk |
| Hot or cold wheel | A brake problem: a stuck brake runs hot, a brake that isn't working runs cold |
| AEI tag | An RFID tag on each car, read at some detector sites |
| Yard / terminal | Where trains are broken up, sorted and rebuilt, and cars are inspected and repaired |
| Set-out / bad order | Leaving a defective car on a siding / tagging a car as defective for repair |
| Dispatcher | Controls train movements over a territory |
| DTL fueling | Direct-to-locomotive: a fuel truck meets the train, instead of the train going to a fixed fuel pad |

### 19. Railcar Health Monitoring

**Folder:** [`railcar-health/`](./railcar-health/) · **Signal:** BNSF (candidate report: a phone screen asked for hot-wheel monitoring of 200,000 railcars, with risk alerts and the yard response. A Reddit account from a senior infrastructure candidate describes a close variant: ingest camera, vibration and temperature data, detect track hazards and alert personnel within seconds over intermittent links. Prep guides list real-time sensor systems as a topic) · ✅ Built

**Problem.** Wayside detectors measure every passing train: bearing and wheel temperatures, wheel impact loads, acoustic bearing signatures and machine vision images. RFID (AEI) readers identify each car. The platform turns those readings into a maintenance decision for each car: stop the train, set the car out, inspect it at the next yard, or schedule it for the shop. It routes each decision to the right people and learns from what inspectors find.

**Hard problems.**
- **Two safety tiers.** The detector's own alarm stops the train over the radio and never depends on the cloud. The platform adds trending, fusion and the workflow on top.
- **Trending before thresholds.** Compare each bearing with its own train, and with the same bearing at earlier detectors. A rising bearing is then caught before any single reading crosses an absolute threshold.
- **Two failure modes.** Hot or cold *wheels* mean brake problems: a stuck brake runs a hot wheel, an inoperative brake runs a cold one. Hot *bearings* mean journal bearing failure. Keep them apart in the data model and in the rules.
- **Identity.** Map axle readings to car, axle and side using AEI reads and consists versioned by time. This includes cars turned around on a wye, which swaps left and right. A railcar is not its components: wheelsets and bearings are replaced, so readings attach to the component installed at that position at the reading's event time.
- **Late, duplicated and out-of-order data** from detector sites that store and forward. An alert computed late is routed to wherever the train is now.
- **Detector health.** Detect a biased or silent detector instead of trusting it.
- **Alert lifecycle.** One alert per bearing per trip, escalated in place. Delivered, acknowledged, inspected and closed are separate transitions, with an owner, an acknowledgment deadline, escalation and handoff between yards. A car hold stops the yard from sending the car out before inspection. Inspection findings become labels, but only flagged cars get inspected, so labels need random audits to correct the bias.

**Follow-ups the answers must handle.**
- The cloud is down for two hours. What happens to a train with a burning bearing?
- How do you catch a bearing that is heating up but hasn't yet crossed the alarm threshold?
- A detector reconnects and uploads a concerning reading from two hours ago, but that wheelset was replaced an hour ago. What happens to the car's status and its open case?
- The AEI read is missing, and the train was rebuilt at the last yard. Which consist do you use?
- The notification was delivered, but nobody acknowledged it, and the train is approaching the next yard. What happens, and who owns the case?
- A detector that reconnects dumps a backlog. How do new critical readings avoid waiting behind it?
- Should the stream be partitioned by train trip or by car, and why?
- Dispatchers ignore most alerts. What do you change?
- Most of the cars aren't yours. Who gets told?
- How do you roll out a new threshold or model safely?

**Trap.** Putting the cloud in the path that stops trains, or treating every reading as live.

### 20. Locomotive Fueling

**Folder:** [`locomotive-fueling/`](./locomotive-fueling/) · **Signal:** BNSF (candidate report: "design a backend system for BNSF locomotives that uses real-time fuel level, GPS location, route information, fuel consumption rate, and fuel prices to recommend where the locomotive should stop for fuel and how much fuel it should purchase"). Two related telemetry prompts are also covered: a candidate report (sensor ingestion from 3,000+ trains) and a prep-guide listing (a location ping receiver for thousands of locomotives) · ✅ Built

**Problem.** Locomotives report position, speed, throttle and fuel level. For each train, recommend where its locomotives should fuel and how much, across fixed fuel pads at terminals and truck fueling at sidings. Prices differ by location and change daily.

**Hard problems.**
- **Noisy fuel sensors.** Fuel sloshes on grades and in curves. Smooth the readings, and flag a drop while stationary (a leak or theft).
- **The optimizer.** The greedy "gas station" rule is optimal for a fixed route with prices only. Dwell time, truck fees and lead times push you to dynamic programming over (stop, fuel level), with a safety reserve at every point.
- **Plan stability.** Re-plan when actual burn drifts from the forecast, with hysteresis so the recommendation doesn't flip-flop. A stop with a truck already ordered is committed.
- **Vendor orders with unknown outcomes.** Order trucks idempotently, handle timeouts, and reconcile against fuel tickets.
- **The low-fuel alarm** comes from telemetry and works even when the planner is down.

**Follow-ups the answers must handle.**
- A train turns out heavier than planned and burns 20% more fuel. What changes, and when?
- The truck vendor times out on an order. Did you just order two trucks?
- How do you keep recommendations from changing every few minutes?
- Telemetry from a region arrives two hours late in one burst. What happens downstream?

**Trap.** Treating the question as greedy shortest-path and ignoring dwell, truck lead times and plan stability. Or spending the whole round on telemetry ingestion, which is the easy part at about a thousand messages a second.

### 21. Storage Remediation

**Folder:** [`storage-remediation/`](./storage-remediation/) · **Signal:** BNSF (guide-reported, plus candidate reports of an existing system review round in which the candidate presents a system they built and defends its architecture, trade-offs, scale, production issues, monitoring and improvements). The design question itself is a practice extension · ✅ Built

**Problem.** Find and fix security misconfigurations across tens of thousands of cloud storage accounts without breaking the applications that use them. Examples: anonymous blob access, shared-key authentication, old TLS versions, open network access, and missing soft delete or diagnostics.

**Different deliverable.** In addition to the standard files, `existing-system-review.md` presents this system the way the review round expects. It has a ten-minute walkthrough script, the three key decisions with their alternatives, an incident and what changed afterwards, and a bank of likely probes. Use it as a template for presenting your own system.

**Hard problems.**
- **Impact analysis before change.** Access logs show who still uses shared keys, SAS or anonymous reads. Classify each account as safe to fix now, needing owner migration first, or an exception.
- **Safe rollout.** Waves, a bake period, rollback on authentication-failure signals, and a kill switch per campaign.
- **Fleet-scale execution.** Per-subscription rate limits that honor `Retry-After`, idempotent applies with etags, crash-safe resume without double-applying a change, and reads that lag writes.
- **Prevention after remediation.** Switch policy from audit to deny once a control is burned down, so new resources can't regress.

**Follow-ups the answers must handle.**
- Why not just flip the setting everywhere on a Friday night?
- The executor crashes halfway through a wave. What happens on restart?
- An application breaks after its account is fixed. How fast do you notice, and what rolls back?
- How do owners get an exception, and what makes it expire?

**Trap.** Presenting remediation as a script that loops over accounts, with no evidence, waves, verification or rollback.

### 22. Freight Quote Service

**Folder:** [`freight-quote/`](./freight-quote/) · ✅ Built · **Signal:** BNSF (candidate report: a high-traffic quote endpoint whose dependent services are slow, and what architecture would improve service quality. A curated PracHub account of a September 2026 screen describes implementing the freight rate inquiry endpoint's service-layer logic first, then discussing heavy traffic and downstream latency, so expect some coding) · **Builds on:** scalable-api, rate-limiter, distributed-cache

**Problem.** Shippers request price quotes for moving freight: origin, destination, commodity, car type and volume. A quote depends on several slow internal services: tariff and contract pricing, network capacity, fuel surcharge and car availability. Traffic is heavy, from customer portals and from API integrations that re-quote often. Design the endpoint so it stays fast and correct while dependencies are slow.

**Core entities.**
- `quote_request`: idempotency key, customer, lane (origin to destination), commodity, equipment type and quantity.
- `quote`: priced lines, `firm` or `indicative`, a validity window, and the versions of the inputs it used (tariff version, fuel surcharge date).
- `price_component`: one per dependency, with its source and freshness.

**Hard problems to implement.**
- **A latency budget per dependency.** Propagate deadlines, set timeouts, and hedge requests to the slowest service.
- **Firm and indicative quotes.** When capacity or car availability is slow, return an indicative quote built from cached components, with explicit staleness. Upgrade it to firm asynchronously, with `202` and a callback or polling.
- **Caching by lane.** Cache tariff and surcharge components by lane and commodity, and invalidate them when a tariff is published. Never share a customer's contract price with another customer through the cache.
- **Circuit breakers and load shedding.** Shed API re-quote traffic before portal traffic, and rate-limit per customer.
- **Request coalescing.** Collapse identical concurrent requests into one (single-flight).
- **Honoring a quote.** A firm quote is a commitment. Store exactly what it was based on, so booking can honor it.

**Follow-ups the answers must handle.**
- The capacity service's p99 jumps to eight seconds. What does a customer see?
- How stale may a cached price be, and who decides?
- A customer integration re-quotes the same lane 50 times a minute. What happens?
- A customer books against a quote whose tariff has since changed. Which price applies?
- A customer disputes last week's quote. Can you reconstruct the inputs and pricing rules it used?

**Trap.** Putting a cache in front of everything without saying which prices may be stale and how a stale price is labeled.

**Local scope.** An Express quote API, mock dependency services with latency and failure knobs, Valkey for cache and rate limits, PostgreSQL for quotes, a customer portal, and an operations page showing per-dependency latency and breaker state.

### 23. Railcar Trip Plans and ETAs

**Folder:** `railcar-trip-plans/` · **Signal:** Practice extension (car visibility and trip plans are central to rail service, but the question is not known to have been asked) · **Builds on:** local-delivery, notification-system, #19

**Problem.** Each loaded car moves through a trip plan: an origin, a sequence of yards and trains, and a destination. AEI readers and yard systems report where cars actually are. Track every car against its plan, detect missed connections early, predict ETAs, and show shippers where their cars are.

**Core entities.**
- `car`.
- `trip_plan`: versioned, with ordered legs, each giving the train, the yard, and planned departure and arrival.
- `car_event`: an AEI read, arrival, departure or placement, with its source and timestamp.
- `eta_prediction`.
- `exception`: a missed connection, a bad-ordered car, or dwell exceeded.

**Hard problems to implement.**
- **Events arrive out of order and duplicated.** A car's state machine must tolerate missing events.
- **Replanning.** When a car misses its connection, create a new trip plan version and notify the customer, with the ETA shift.
- **ETA from dwell, not distance.** Use historical dwell distributions per yard and the train schedules, and show a confidence range.
- **Fan-out.** One delayed train affects thousands of cars and hundreds of customers, so batch the notifications.
- **Access.** A shipper sees only its own cars, including cars moving on other railroads after interchange.

**Follow-ups the answers must handle.**
- A train carrying 100 cars for 40 customers is six hours late. What notifications go out?
- An AEI reader misses a car. How do you know where the car is?
- How accurate is your ETA, and how do you show its uncertainty?

**Trap.** Treating ETA as distance divided by speed. Most of a car's transit time is spent waiting in yards.

**Local scope.** A simulator of trains and yards that emits car events, an Express API, PostgreSQL, Valkey streams, an ETA model built from historical dwell, a shipper portal and an operations exceptions board.

### 24. Yard Switch Lists

**Folder:** `yard-switch-lists/` · **Signal:** Practice extension (BNSF publicly describes generating optimized switch lists with AI at its Alliance yard; not known to have been asked in interviews) · **Builds on:** job-scheduler, #19

**Problem.** A classification yard receives inbound trains, sorts their cars into blocks on classification tracks, and assembles outbound trains. Design the service that produces each shift's switch list (the ordered moves), and replans it when trains run late.

**Core entities.**
- `inbound_train`.
- `car`, with its destination block.
- `track`, with capacity in feet.
- `block`.
- `outbound_train`: schedule, block sequence, and maximum length and tonnage.
- `switch_list`: versioned ordered moves.
- `move`.

**Hard problems to implement.**
- **Optimization under constraints.** Track capacity, block standing orders, departure times and hazardous-materials placement rules. Compare heuristics with a solver, and set a time limit per solve.
- **Replanning.** A late inbound train invalidates part of the plan. Minimize changes to work already in progress.
- **Human override.** The yardmaster edits the list, and the planner respects their locks.
- **Holds from other systems.** A car hold from #19 must keep that car off outbound trains.
- **Execution feedback.** Crews report completed moves from handhelds, and the plan follows what actually happened.

**Follow-ups the answers must handle.**
- A train arrives three hours late. What does the planner change, and what does it leave alone?
- The yardmaster disagrees with the plan. How do overrides work?
- How do you measure whether the planner beats the yardmaster?

**Variant: inspection and repair scheduling.** The same yard, planning maintenance instead of switching. Cars arrive with risk levels (from #19), required work and departure times. Each yard has limited crews, repair bays and parts. The variant raises different follow-ups: two coordinators assigning the same bay at once, a part the plan assumes is in stock that the physical count says isn't, and keeping the yard working while the planner is down, then reconciling actions recorded locally.

**Trap.** Spending the round on the optimization algorithm and ignoring replanning, overrides and execution feedback.

**Local scope.** An Express API with a heuristic planner, PostgreSQL, a yard simulator, a yardmaster board with drag-to-override, and a crew handheld view.

---

## Starting a Planned Project

1. Create the folder with the standard layout from [CLAUDE.md](./CLAUDE.md#project-structure).
2. Write `architecture.md` first. Expand the entry above into the production design, then add the local Implementation Notes. Make sure it answers the [Design Review Checklist](#design-review-checklist).
3. Implement the backend and frontend, add `scripts/screenshot-configs/<project>.json`, and generate smoke tests.
4. Write the three `system-design-answer-*.md` files (no code, 350–550 lines each), making sure they cover the follow-up questions listed above.
5. Move the project's row in [README.md](./README.md) from **Planned Projects** into its category table with `✅ Implemented`, and mark its entry here as built (keep the entry, so numbering and links stay stable).
