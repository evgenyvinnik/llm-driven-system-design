# Roadmap: Planned Projects

The next round of projects for this repository, focused on AI products and developer platforms: prompt tooling, LLM chat, token streaming, multi-tenant APIs and reliable asynchronous work. The list started as a survey of publicly reported system design questions and question banks (compiled October 2026), and was then checked against the projects that already exist here. Topics this repository already covers are listed separately with the gaps worth closing.

Each planned project uses the standard layout described in [CLAUDE.md](./CLAUDE.md): `architecture.md`, the three `system-design-answer-*.md` files, a project `CLAUDE.md`, `frontend/`, `backend/` and `docker-compose.yml`. Each entry below is a starting point for that project's `architecture.md`. It gives the scope, core entities, the hard problems worth implementing and the follow-up questions the interview answers must cover.

## Table of Contents

- [About the Sources](#about-the-sources)
- [Summary](#summary)
- [Already Covered by Existing Projects](#already-covered-by-existing-projects)
- [Shared Decisions for the LLM Projects](#shared-decisions-for-the-llm-projects)
- [Design Review Checklist](#design-review-checklist)
- [Tier 1: Product-Facing Core](#tier-1-product-facing-core)
- [Tier 2: Variations and Extensions](#tier-2-variations-and-extensions)
- [Tier 3: Infrastructure Specialties](#tier-3-infrastructure-specialties)
- [Starting a Planned Project](#starting-a-planned-project)

## About the Sources

The **Signal** column says how strong the evidence is that a question appears in real interviews. None of these attributions has been independently verified, and interview formats vary by role and team. Treat them as practice targets, not predictions.

| Label | Meaning |
|-------|---------|
| Candidate report | A public account describes receiving this question. Self-reported, not verified |
| Community attribution | A question bank attributes the question to the company. Team, date and round are unknown |
| Guide-reported | A preparation guide summarizes a candidate's experience. The underlying account was not inspected |
| Practice extension | A recommended exercise. Not known to have been asked |

Sources surveyed: Glassdoor, Aced (formerly Exponent) and Hello Interview.

## Summary

| # | Project | Folder | Tier | Signal | Builds on |
|---|---------|--------|------|--------|-----------|
| 1 | [Prompt Playground](#1-prompt-playground) | `prompt-playground/` | 1 | OpenAI (candidate report); OpenAI, Anthropic (community) | mcplator |
| 2 | [ChatGPT](#2-chatgpt) | `chatgpt/` | 1 | OpenAI (community) | imessage, mcplator |
| 3 | [Settings Service](#3-settings-service) | `settings-service/` | 1 | OpenAI (candidate report) | — |
| 4 | [LLM Chat Analytics](#4-llm-chat-analytics) | `llm-chat-analytics/` | 1 | Anthropic (community) | ad-click-aggregator, dashboarding |
| 5 | [LLM Inference API](#5-llm-inference-api) | `llm-inference-api/` | 1 | Anthropic (candidate reports, including batching and routing variants) | rate-limiter, scalable-api |
| 6 | [Webhook Platform](#6-webhook-platform) | `webhook-platform/` | 1 | OpenAI (community) | payment-system, stripe |
| 7 | [Workspace Permissions](#7-workspace-permissions) | `workspace-permissions/` | 2 | Practice extension | notion, google-docs |
| 8 | [Document Q&A](#8-document-qa) | `document-qa/` | 2 | Practice extension | dropbox, fb-post-search |
| 9 | [Experimentation Platform](#9-experimentation-platform) | `experimentation-platform/` | 2 | Practice extension | — |
| 10 | [LLM Eval Dashboard](#10-llm-eval-dashboard) | `llm-eval-dashboard/` | 2 | Practice extension | prompt-playground, job-scheduler |
| 11 | [CI/CD Platform](#11-cicd-platform) | `ci-cd-platform/` | 2 | OpenAI (community) | job-scheduler, github |
| 12 | [AI Code Review](#12-ai-code-review) | `ai-code-review/` | 2 | Anthropic (guide-reported) | github, ai-code-assistant |
| 13 | [File Cache](#13-file-cache) | `file-cache/` | 3 | Anthropic (candidate report) | distributed-cache |
| 14 | [Model Distribution](#14-model-distribution) | `model-distribution/` | 3 | Anthropic (candidate report) | — |
| 15 | [Online Chess](#15-online-chess) | `online-chess/` | 3 | OpenAI (community) | r-place, online-auction |

- **Tier 1** covers the core product-facing work for AI and full-stack roles. Build these first, in the order listed.
- **Tier 2** covers variations on tier-1 designs. Each reuses a tier-1 data model or an existing project's patterns.
- **Tier 3** covers infrastructure specialties and lower-relevance topics. Build these when a target role calls for them.
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

## Shared Decisions for the LLM Projects

Projects 1, 2, 4, 5, 8, 10 and 12 call a model. Every project in this repository must run locally and stand on its own, so they share these decisions:

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

### 2. ChatGPT

**Folder:** `chatgpt/` · **Signal:** OpenAI (community attribution)

**Problem.** A multi-user assistant with conversation history, streamed responses, cancellation, regeneration and sync across devices.

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

**Follow-ups the answers must handle.**
- The connection drops halfway through a response. Can the client reconnect without creating another generation?
- What distinguishes retrying a request from asking for a new answer?
- A user opens the same conversation on two devices and submits on both at once. What happens?
- Does pressing Stop only stop rendering, or does it also cancel backend work?
- How do very long conversations change fetching and rendering?

**Trap.** Treating the whole system as a React message array plus a single `POST /chat` endpoint.

**Local scope.** Express, PostgreSQL, Valkey streams and pub/sub for fan-out across devices, and a mock model.

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

**Folder:** `llm-chat-analytics/` · **Signal:** Anthropic (community attribution)

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

**Follow-ups the answers must handle.**
- Events arrive late or twice. How do the charts change?
- Why might yesterday's number be different today?
- How do time zones affect daily buckets?
- Can you add up hourly unique-user counts, or average several p95 values, to get the daily result?
- How do you keep analytics from exposing private conversation content?
- What freshness guarantee can the interface honestly display?

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

### 7. Workspace Permissions

**Folder:** `workspace-permissions/` · **Signal:** Practice extension. It is a variation on the playground and chat projects.

**Problem.** Organizations, projects, memberships, roles, invitations, shared resources and share links.

**Core entities.**
- `org` and `project`.
- `membership` links a user to an organization or project with a role. Each role maps to a set of permissions.
- `invitation` holds a token, an expiry and a role.
- `resource` has an owner and belongs to a project.
- `share_link` holds a token, permission, expiry and `revoked_at`.
- Plan entitlements control which features are available. They are separate from permissions.

**Hard problems to implement.**
- **Authorization is enforced in the API and inside queries**, by filtering on the projects a user can access. Hiding buttons in the interface is not enforcement.
- **Revocation and caches.** Cache permission sets with a short TTL and a version that bumps when membership changes. Writes always check authoritatively.
- **Switching organizations in the client.** Scope all cached data by organization and clear it on switch.
- **Removing a member.** Handle their sessions, their open SSE or WebSocket streams, invitations still outstanding and the share links they created.

**Key question.** What cached state must be invalidated when access changes, and which server checks stay authoritative before that invalidation completes?

**Local scope.** Express, PostgreSQL and a Valkey permission cache, with a React admin for members, roles and links.

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

---

## Starting a Planned Project

1. Create the folder with the standard layout from [CLAUDE.md](./CLAUDE.md#project-structure).
2. Write `architecture.md` first. Expand the entry above into the production design, then add the local Implementation Notes. Make sure it answers the [Design Review Checklist](#design-review-checklist).
3. Implement the backend and frontend, add `scripts/screenshot-configs/<project>.json`, and generate smoke tests.
4. Write the three `system-design-answer-*.md` files (no code, 350–550 lines each), making sure they cover the follow-up questions listed above.
5. Move the project's row in [README.md](./README.md) from **Planned Projects** into its category table with `✅ Implemented`, and remove its entry from this roadmap.
