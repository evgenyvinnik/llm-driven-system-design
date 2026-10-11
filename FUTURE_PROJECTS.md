# Future Projects: OpenAI & Anthropic System Design Questions

This document lists system design questions that candidates report being asked at **OpenAI** and **Anthropic**. It turns the ones this repository does not cover yet into planned projects.

> **How reliable is this?** Neither company publishes a question bank. Everything below comes from candidate reports collected by interview-prep sites (Hello Interview, Aced/Exponent, PracHub, Coditioning, Design Gurus, Linkjob), so treat it as a set of signals, not a syllabus. Several sources note that OpenAI interviewers can pick their own questions and that Anthropic's question bank is small but growing. Research date: **2026-10-11**. Dates in parentheses are when a prep site recorded the report.

## Table of Contents

- [What Each Company Emphasizes](#what-each-company-emphasizes)
- [Planned Projects](#planned-projects)
- [Project Briefs](#project-briefs)
- [Already Covered by Existing Projects](#already-covered-by-existing-projects)
- [Formats That Aren't Build Projects](#formats-that-arent-build-projects)
- [Suggested Build Order](#suggested-build-order)
- [Sources](#sources)

## What Each Company Emphasizes

| | OpenAI | Anthropic |
|---|---|---|
| **Question style** | Product-flavored designs (Playground, ChatGPT, chess), classic distributed systems (Slack, payments, job scheduler), and since 2026 many prompts about GPU job scheduling and remote dev environments | LLM serving infrastructure: batching, routing across a GPU fleet, distributing model weights, and search with an LLM in the query path |
| **Treatment of the model** | Spending prep time on model training or GPU internals is discouraged; the design work is the product and platform around the model | The model is a black box; the design is the queuing, batching, routing, and error handling around it |
| **Common follow-ups** | "10x more users?", "a data center goes down?", MVP scope under a deadline (one report: Slack in two weeks) | Failure modes (partial batch failure, a GPU dying mid-batch, queue loss) and back-of-envelope lower bounds |
| **Format notes** | A 60-minute design round in the phone screen and another on-site. Full-stack loops expect wireframes, then the API, then the data layer | Some rounds mix coding and design (build a client, then scale it). Others are design-doc reviews or performance-modeling exercises |

## Planned Projects

| Project | Reported at | Signal | Core challenge |
|---------|-------------|--------|----------------|
| [LLM Inference Batching](#llm-inference-batching) | Anthropic | Most frequently reported Anthropic question; repeated through Oct 2026 | Map synchronous callers onto GPU batches; handle partial failure |
| [LLM Chat Assistant](#llm-chat-assistant) | OpenAI, Anthropic | "Design ChatGPT" (OpenAI Staff list, Sep 2026); "Design Claude's chat service" (Mar 2024) | Token streaming, conversation context, and free-tier limits on scarce GPUs |
| [LLM API Platform](#llm-api-platform) | OpenAI, Anthropic | OpenAI API / AI gateway / usage billing; 100K RPS token generation | Rate limits on tokens (not just requests), metering, and billing accuracy |
| [Prompt Playground](#prompt-playground) | OpenAI, Anthropic | OpenAI phone screen; Anthropic on-site; collaborative variant (Oct 2026) | Product scoping, prompt versioning, streamed runs |
| [Model Weight Distribution](#model-weight-distribution) | Anthropic | P2P file distribution; 500 GB to 1,000 GPUs (Sep 2026); resumable downloader (Oct 2026) | Bandwidth lower bounds, swarm and tree fan-out |
| [Text-to-Video Generation](#text-to-video-generation) | OpenAI | At least 4 variants reported Sep 2026 | Fair queueing of minute-long GPU jobs, cancellation, traffic bursts |
| [Cloud IDE](#cloud-ide) | OpenAI | At least 4 variants (IDE, multi-tenant IDE, Codespaces, devbox) reported Sep 2026 | Workspace lifecycle, tenant isolation, terminal proxying |
| [Enterprise RAG Search](#enterprise-rag-search) | OpenAI, Anthropic | Senior on-site (OpenAI); 1B-doc search and hybrid search (Anthropic, Sep 2025) | Hybrid retrieval, permission-aware RAG, LLM as the expensive tier |
| [GitHub Actions](#github-actions) | OpenAI | Staff "most commonly asked" list | DAG scheduling on ephemeral runners, log streaming, secrets |
| [Online Chess](#online-chess) | OpenAI | Staff list plus several Sep 2026 reports | Authoritative real-time state, game clocks, Elo matchmaking |
| [Webhook Delivery](#webhook-delivery) | OpenAI | Reported in Hello Interview's OpenAI guide | At-least-once delivery without head-of-line blocking |
| [Fleet Telemetry and Command Dispatch](#fleet-telemetry-and-command-dispatch) | OpenAI, Anthropic | Power-grid / IoT variants (Aug–Sep 2026); telemetry schema drift (Sep 2026) | Late and duplicate events, schema drift, commands to offline devices |

**A shared local constraint:** none of these can assume a GPU. Following the repository's convention of simulating real feeds, each project should use **simulated GPU workers** with configurable per-batch latency and tokens per second. An environment variable can optionally swap in a real model API.

## Project Briefs

### LLM Inference Batching

Proposed folder: `llm-inference-batching/` · **Reported at:** Anthropic

**Reported prompts and follow-ups**
- A single GPU processes up to 100 inputs per batch. Users submit requests synchronously and wait for results. Design intake, batching, GPU execution, and returning each result to the right user.
- Variant: assume each batch takes 100 ms (Oct 2026).
- Follow-ups: what happens on queue failure, compute timeouts, partial batch failure, or too few requests to fill a batch?
- Extension: scale to a fleet of GPUs. How do you know which GPU has capacity, balance load, and fail over when a GPU dies mid-batch?
- Related format: review a short design doc for a batched GPU inference API, find its flaws, and reason about throughput and mixed-model GPUs (Sep 2026).

**What to cover:** the flush policy (wait for a full batch or flush at a deadline, and the latency/utilization trade-off between them); the async-to-sync mapping (request ID → waiting connection); per-request timeouts versus batch timeouts; retrying the surviving requests of a failed batch; admission control when the queue outgrows what clients will wait for; and continuous batching as the production-grade answer.

**Local build sketch:** an Express front end holds HTTP requests open. A batcher (an in-process queue, or Redis Streams for multiple front ends) flushes at 100 items or *T* ms to simulated GPU workers on ports 3001–3003. Results come back over Redis pub/sub keyed by request ID. A dashboard shows batch fill ratio, queue depth, and p50/p99 latency. To test failover, kill a worker mid-batch.

**Overlap:** none. [Job Scheduler](./job-scheduler/) runs asynchronous jobs; this project is synchronous and latency-bound.

### LLM Chat Assistant

Proposed folder: `llm-chat-assistant/` · **Reported at:** OpenAI ("Design ChatGPT"; "Chat assistant inference service: streaming, free-tier limits, GPU scheduling", Sep 2026), Anthropic ("Design Claude's chat service", Mar 2024)

**What to cover:** token streaming over SSE versus WebSocket, including resuming a stream after a dropped connection; storing conversations and assembling context to fit a context window (truncation versus summarization); free-tier quotas and prioritizing paid traffic when GPUs are saturated; "stop generating" cancellation that actually frees GPU capacity; where safety filters sit on the streaming path; and storing conversation history across regions.

**Local build sketch:** a React chat UI with streamed rendering; an Express SSE gateway; PostgreSQL for conversations and messages; Redis for per-tier quotas; and a priority queue in front of a mock model that emits tokens at a fixed rate.

**Overlap:** [WhatsApp](./whatsapp/) and [Slack](./slack/) cover message storage. The new parts are long-lived generation streams and admission control under GPU scarcity.

### LLM API Platform

Proposed folder: `llm-api-platform/` · **Reported at:** OpenAI (design the OpenAI API: key management, auth, per-key rate limits, usage metering, billing; an API gateway for millions of requests to AI models; usage quotas and billing; versioning and deprecating model endpoints; usage billing with holds, captures, and reconciliation), Anthropic (a token-generation service at 100K RPS; an inference routing and scheduling layer across GPU and CPU backends)

**What to cover:** rate limiting on two dimensions, requests/min and tokens/min, when output tokens are only known after generation (reserve an estimate, then reconcile); metering that stays exact under client retries (idempotency keys); a usage-event pipeline feeding invoices; routing by model and version to separate replica pools; and migrating clients off a deprecated model.

**Local build sketch:** a gateway on port 3000 routes to simulated model pools on 3001–3003. Redis holds the token buckets. Usage events go through RabbitMQ or Kafka into aggregates in ClickHouse or PostgreSQL, then into invoices. An admin UI shows API keys, usage, and spend.

**Overlap:** combines [Rate Limiter](./rate-limiter/), [Scalable API](./scalable-api/), and [Stripe](./stripe/) around token economics.

### Prompt Playground

Proposed folder: `prompt-playground/` · **Reported at:** OpenAI (phone screen: "Design the OpenAI Playground", covering prompt testing, simulated conversations, thread management, and API integration, with wireframes, an API layer, and a thread/message schema), Anthropic (on-site: product requirements first, then a backend for real-time execution, streaming, concurrency, and global scale; variant: "Collaborative Prompt Playground" with version history and running selected versions against a model, Oct 2026)

**What to cover:** product scoping and UI first; a data model for prompts, immutable versions, runs, and outputs; side-by-side comparison of models and parameters; multi-user editing without corrupting version history; streamed runs; and per-user cost controls.

**Local build sketch:** a React UI with a prompt editor, parameter panel, and comparison view; Express plus PostgreSQL for prompts, versions, and runs; and SSE streaming from a mock model.

**Overlap:** [Collaborative Editor](./collaborative-editor/) handles real-time co-editing. This is the most frontend-heavy question in the set and a good fit for the `-frontend` answer variant.

### Model Weight Distribution

Proposed folder: `model-weight-distribution/` · **Reported at:** Anthropic (spread a ~10 GB file from one bandwidth-constrained source to thousands of hosts, each with limited upload and download bandwidth; distribute 500 GB of weights to 1,000 GPU workers, starting from the lower bound, Sep 2026; a parallel, resumable model downloader, Oct 2026; model artifact distribution to an inference fleet)

**What to cover:** the back-of-envelope lower bound first. For example, assuming 10 Gbps per host, 500 GB takes about 400 s to reach one host. Serving 1,000 hosts from a single source in turn would take about 4.6 days; a peer-to-peer swarm brings it close to that 400 s floor. Then compare a pipelined tree against a BitTorrent-style swarm, rack- and topology-aware peer selection, per-chunk SHA-256 manifests, straggler and host-failure handling, and resumable range downloads.

**Local build sketch:** MinIO as the origin; *N* Node "host" processes with throttled bandwidth (a token bucket); a tracker service; chunk manifests; and a UI that visualizes swarm progress.

**Overlap:** [Dropbox](./dropbox/) chunks files for sync. This project distributes one large file to many hosts.

### Text-to-Video Generation

Proposed folder: `text-to-video/` · **Reported at:** OpenAI ("Text-to-video GPU job scheduler with one GPU per task and fair queueing"; "Sora-style video generation service with fair queueing and cancellation"; "GPU scheduling, failures, traffic bursts", all Sep 2026; an earlier "AI video generation from text input")

**What to cover:** jobs run for minutes rather than seconds, so this needs an asynchronous job API with progress reporting instead of a held connection. Also cover fair sharing across users and tiers (weighted fair queueing, per-user concurrency caps); cancelling a queued job versus a running one, and freeing the GPU; checkpointing and retry when a GPU fails; burst handling (admission control, queue position and ETA); and storing outputs in object storage behind a CDN.

**Local build sketch:** a job API with a PostgreSQL job table; a weighted fair queueing scheduler; simulated GPU workers that "render" by sleeping and writing a placeholder video to MinIO; and progress pushed over SSE to a React queue view.

**Overlap:** [Job Scheduler](./job-scheduler/) covers generic scheduling and [YouTube](./youtube/) covers video storage and serving. The new parts are GPU scarcity and fairness.

### Cloud IDE

Proposed folder: `cloud-ide/` · **Reported at:** OpenAI ("Cloud IDE that edits and runs code in browser-accessible workspaces"; "Multi-tenant cloud IDE: isolation, workspaces, run/build, failure modes"; "Cloud development environment platform like an online IDE"; "Devbox service for on-demand remote development environments", all Sep 2026)

**What to cover:** the workspace lifecycle (create from a template or snapshot, start, suspend when idle, resume); isolation (containers versus microVMs such as Firecracker, egress policy); persistent volumes on ephemeral compute; routing terminal and language-server traffic over WebSocket to the right workspace; warm pools to cut cold-start time; and cost control through auto-stop.

**Local build sketch:** an Express and PostgreSQL control plane that manages Docker containers through the Docker API; a Monaco editor and an xterm.js terminal through a WebSocket proxy; an idle reaper; and a warm pool.

**Overlap:** [LeetCode](./leetcode/) runs short sandboxed jobs and [AI Code Assistant](./ai-code-assistant/) works in a local environment. The new part is long-lived, stateful, multi-tenant workspaces.

### Enterprise RAG Search

Proposed folder: `enterprise-rag-search/` · **Reported at:** OpenAI (LLM-powered enterprise search, reported as common in senior final on-sites), Anthropic (distributed search over 1B documents at ~1M QPS with an LLM inference component at ~10K RPS; hybrid search combining text retrieval and semantic similarity for top-k over 10M+ documents in under 50 ms; both Sep 2025)

**What to cover:** hybrid retrieval (BM25 plus approximate nearest-neighbor vector search, merged with reciprocal rank fusion); applying access-control filters *before* the LLM sees a document; keeping indexes fresh from source connectors; and treating the LLM as the expensive tier. The 1M QPS versus 10K RPS gap means most queries must never reach the model, so cover caching and when to synthesize an answer at all. Also cover the latency budget at each stage.

**Local build sketch:** connectors ingest sample documents, which are chunked and embedded (a small local model, or simulated embeddings). OpenSearch (BM25 plus kNN) or pgvector stores them. A query API fuses the results, and a mock or real LLM writes cited summaries, with ACL filtering throughout.

**Overlap:** [Google Search](./google-search/) and [FB Post Search](./fb-post-search/) are lexical search. The new parts are vector retrieval, rank fusion, RAG, and ACLs.

### GitHub Actions

Proposed folder: `github-actions/` · **Reported at:** OpenAI (Staff list; "CI/CD system similar to GitHub Actions", framed around reliability and operational trade-offs)

**What to cover:** trigger events (push webhooks) → workflow parsing → a DAG of jobs; scheduling and autoscaling the runner pool; ephemeral runners; streaming live logs; artifact and cache storage; secret isolation; and at-least-once job execution with idempotent status updates.

**Local build sketch:** a webhook receiver; a DAG scheduler backed by PostgreSQL; runners as Docker containers; logs streamed over WebSocket; and artifacts in MinIO.

**Overlap:** [GitHub](./github/) covers repository hosting but not Actions, and [Job Scheduler](./job-scheduler/) covers scheduling without DAGs or runners.

### Online Chess

Proposed folder: `online-chess/` · **Reported at:** OpenAI (Staff list; "Online multiplayer chess service with real-time moves" and "Elo matchmaking, WebSocket moves, game clocks", Sep 2026)

**What to cover:** server-authoritative move validation; game clocks that are fair despite network latency (server timestamps); matchmaking pools by rating that widen over time; reconnection and state recovery; routing each game to one server; fan-out to spectators; and an idempotent rating update when a game ends.

**Local build sketch:** three Node WebSocket servers coordinated through Redis pub/sub; chess.js for validation; PostgreSQL for games and ratings; and a React board.

**Overlap:** [r/place](./r-place/) and [FB Live Comments](./fb-live-comments/) cover real-time fan-out and [Tinder](./tinder/) covers matching. No existing project has turn-based authoritative game state or clocks.

### Webhook Delivery

Proposed folder: `webhook-delivery/` · **Reported at:** OpenAI (Hello Interview's OpenAI guide)

**What to cover:** at-least-once delivery with exponential backoff; per-endpoint queues or concurrency limits so one slow customer can't block everyone else (head-of-line blocking); HMAC signing and replay protection; what ordering guarantee, if any, to promise; dead-letter handling with manual replay; tracking endpoint health and auto-disabling failing endpoints; and fan-out at high volume.

**Local build sketch:** an event producer → RabbitMQ or Kafka → dispatcher workers with per-endpoint concurrency; a PostgreSQL log of delivery attempts; mock receivers that fail or stall at random; and an admin UI for replays.

**Overlap:** [Stripe](./stripe/) sends webhooks as one feature. Here, delivery is the whole system.

### Fleet Telemetry and Command Dispatch

Proposed folder: `fleet-telemetry/` · **Reported at:** OpenAI ("Power grid device monitoring over an unreliable public internet" and its "dedup and late events" variant; "IoT logging platform with late-arriving metrics"; "Command dispatch and telemetry reconciliation for unreliable devices", Aug–Sep 2026), Anthropic ("Telemetry pipeline that handles inconsistent metric names from old clients", Sep 2026)

**What to cover:** devices that buffer data and upload batches after being offline; idempotent ingestion keyed on (device_id, sequence); event time versus processing time, watermarks, and correcting aggregates when late data arrives; schema drift across client versions (a metric-name registry, normalized at ingestion or at query time); and sending commands to intermittently connected devices (desired versus reported state, command TTLs, acknowledgements, reconciliation).

**Local build sketch:** a simulator for thousands of virtual devices that go offline at random; an ingestion API; Kafka; ClickHouse or TimescaleDB; a command service storing a "device shadow" (last known and desired state) in PostgreSQL; and dashboards.

**Overlap:** [Health Data Pipeline](./health-data-pipeline/) covers device batching and deduplication, and [Dashboarding](./dashboarding/) covers metrics. The new parts are the command path and schema drift.

## Already Covered by Existing Projects

These reported questions map onto projects that already exist. Practice them there, with the angle noted.

| Reported prompt | Reported at | Existing project | Angle to practice |
|-----------------|-------------|------------------|-------------------|
| Design Slack / high-scale chat (incl. "two-week MVP") | OpenAI | [Slack](./slack/), [WhatsApp](./whatsapp/) | Explicit MVP scoping under a deadline |
| Job scheduler | OpenAI | [Job Scheduler](./job-scheduler/) | Exactly-once vs at-least-once, priorities |
| Payment system (external provider; holds/captures; reconciliation) | OpenAI | [Payment System](./payment-system/), [Stripe](./stripe/) | Idempotency and reconciliation |
| Coffee-shop card payments with tips and nightly batch settlement | OpenAI | [Payment System](./payment-system/) | Authorize, then capture an adjusted amount; batch settlement |
| Notification system | OpenAI | [Notification System](./notification-system/) | — |
| Video streaming platform at 10x–1000x scale | OpenAI | [Netflix](./netflix/), [YouTube](./youtube/), [Twitch](./twitch/) | Global distribution, growth projections |
| Metrics monitoring system | OpenAI | [Dashboarding](./dashboarding/) | Going deep on one or two components |
| Photo storage with SHA-256 dedup and safe deletion | OpenAI | [Dropbox](./dropbox/), [iCloud](./icloud/) | Reachability-based garbage collection (Dropbox) |
| Digital game store like Steam | OpenAI | [App Store](./app-store/) | Large binary downloads via CDN |
| Real-time recommendation system (single report) | OpenAI | [TikTok](./tiktok/), [FB News Feed](./fb-news-feed/) | — |
| Web crawler (concurrent; robots.txt, dedup, politeness) | Anthropic | [Web Crawler](./web-crawler/) | Thread-safe visited set |
| Key-value store / file cache / LRU made durable with a WAL | Anthropic | [Distributed Cache](./distributed-cache/) | Durability with a write-ahead log |
| Service calling the Uber API, then 100x load without overwhelming Uber | Anthropic | [Rate Limiter](./rate-limiter/), [Scalable API](./scalable-api/) | Client-side throttling, circuit breakers |
| Agentic AI system that adapts to new tasks (MLE roles) | Anthropic | [AI Code Assistant](./ai-code-assistant/) | Agent loop and tool registry |

## Formats That Aren't Build Projects

Some reported rounds are exercises rather than systems to build. They're listed so they aren't a surprise:

- **Performance debugging** (Anthropic, Sep 2025): p95 latency jumps from ~100 ms to ~2,000 ms. Investigate, design monitoring that would catch it, and prioritize fixes.
- **Design-doc review** (Anthropic, Sep 2026): critique a batched GPU inference API design. Practice by writing the [LLM Inference Batching](#llm-inference-batching) `architecture.md`, then reviewing it.
- **Performance modeling** (Anthropic, ML system design, Sep 2026): model a sharded matrix multiply by hand (FLOPs, memory, network, roofline).
- **Distributed algorithms by message passing** (Anthropic, Sep 2026): compute the mode, median, and a sort across 10 nodes using only send and receive, while minimizing traffic.
- **Hybrid coding and design** (Anthropic): build a working client first, then discuss scaling and protecting the downstream service.

## Suggested Build Order

1. **LLM Inference Batching.** Smallest scope and the most-reported Anthropic question. Its batcher and simulated GPU workers can be reused by projects 2, 3, and 6.
2. **LLM API Platform.** Adds keys, token rate limits, and metering on top of the batcher.
3. **LLM Chat Assistant.** Adds streaming and conversation state, served through the API platform.
4. **Prompt Playground.** Frontend-heavy; reuses the streaming path from project 3.
5. **Model Weight Distribution.** Self-contained, and good practice for estimating lower bounds.
6. **Text-to-Video Generation.** Fair queueing for long GPU jobs.
7. **Enterprise RAG Search.**
8. **Cloud IDE.**
9. **Online Chess.**
10. **Webhook Delivery.**
11. **GitHub Actions.**
12. **Fleet Telemetry and Command Dispatch.**

When a project is started, create its folder with the standard layout described in [CLAUDE.md](./CLAUDE.md#project-structure), move its row in [README.md](./README.md) from 📋 Planned into the matching category, and remove its brief here.

## Sources

Candidate-reported, third-party sources. None are official OpenAI or Anthropic material.

**OpenAI**
- [OpenAI L5 Interview Guide — Hello Interview](https://www.hellointerview.com/guides/openai/l5)
- [OpenAI System Design Interview (2026 Guide) — Aced (formerly Exponent)](https://www.aced.io/blog/openai-system-design-interview)
- [OpenAI System Design Questions — PracHub](https://prachub.com/companies/openai/categories/system-design)
- [OpenAI System Design Interview Questions — Design Gurus](https://www.designgurus.io/blog/openai-system-design-interview-questions)
- [OpenAI Full Stack Engineer Interview — Design Gurus](https://www.designgurus.io/blog/openai-full-stack-engineer-interview)
- [OpenAI System Design Interviews — IGotAnOffer](https://igotanoffer.com/en/advice/openai-system-design-interview)
- [How I Passed the OpenAI System Design Interview — Linkjob](https://www.linkjob.ai/interview-questions/openai-system-design-interview-2025-real-questions-tips/)
- [OpenAI Software Engineer Interview Experience (Aug 2025) — Taro](https://www.jointaro.com/interviews/companies/openai/experiences/software-engineer-san-francisco-ca-august-18-2025-no-offer-neutral-e81cada4/)

**Anthropic**
- [Anthropic System Design Interview (2026 Guide) — Aced (formerly Exponent)](https://www.aced.io/blog/anthropic-system-design-interview)
- [Anthropic System Design Interview Questions — Coditioning](https://www.coditioning.com/blog/15/anthropic-system-design-interview-questions)
- [Anthropic Interview Questions — PracHub](https://prachub.com/companies/anthropic)
- [What to Expect in the Anthropic System Design Interview — Design Gurus](https://www.designgurus.io/answers/detail/what-to-expect-in-the-anthropic-system-design-interview)
- [My Anthropic System Design Interview Experience — Linkjob](https://www.linkjob.ai/interview-questions/anthropic-system-design-interview/)
- [Get a Job at Anthropic: Interview Process and Top Questions — Yale SOM CDO](https://cdo.som.yale.edu/blog/2026/05/18/get-a-job-at-anthropic-interview-process-and-top-questions/)
- [Anthropic System Design Interview — Educative](https://www.educative.io/blog/anthropic-system-design-interview)
