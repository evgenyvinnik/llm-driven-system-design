# MCPlator Backend — System Design Answer

## 45–50 minute interview walkthrough

| Segment | Focus | Time |
|---|---|---:|
| Requirements | Calculator and AI interaction promises | 4 min |
| Architecture | Edge API, policy, model gateway, sharing | 8 min |
| Data model | Requests, streams, saved messages, quotas | 6 min |
| Interfaces | SSE API, errors, share links, internal calls | 8 min |
| Deep dives | Rate limits, streaming, safety, cost, caching | 20 min |
| Trade-offs and close | Scaling and rollout | 4 min |

## Opening — 2 minutes

I am designing the backend for a calculator with an AI copilot. A user describes a calculation in natural language, receives a structured sequence or result explanation, and can share a compact conversation or calculation link.

The backend must protect the model credential, control cost, stream partial output, validate that model output is safe to execute, and make retries understandable. The model is probabilistic; the calculator execution path must be deterministic.

## R — Requirements — 4 minutes

### Clarifying questions

I would ask whether the AI should return arbitrary code or only calculator operations. I will constrain it to a typed operation vocabulary and never execute model-generated JavaScript.

I would ask whether conversations are persistent, whether anonymous users are allowed, and whether users can share prompts. I will support anonymous sessions with quotas, authenticated saved history, and explicit share-link creation.

### Functional requirements

- Accept natural-language calculator requests.
- Stream explanation and structured operation intent.
- Validate and execute allowed operations deterministically.
- Return calculator result, warnings, and a human-readable explanation.
- Support cancellation and retry without duplicating a request.
- Enforce anonymous and authenticated quotas.
- Encode and decode compact share links safely.
- Record privacy-safe usage and cost metrics.

### Non-functional requirements

- Time to first token should be low enough to feel interactive.
- The model key must never reach the browser.
- A partial stream must end with an explicit completion or error event.
- Rate limits must work across multiple edge instances.
- A malformed model response must fail closed rather than execute.
- The service should degrade to a friendly error when the model provider is unavailable.

### Out of scope

I will not design the model training pipeline, provider internals, a general code execution sandbox, or a full analytics warehouse. I will define model gateway and calculator boundaries.

## A — Architecture — 8 minutes

### High-level diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Browser / Calculator UI                                                     │
│ prompt draft · stream parser · operation preview · deterministic executor  │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ HTTPS / SSE
┌──────────────────────────────▼─────────────────────────────────────────────┐
│ Edge API                                                                     │
│ auth/session · request validation · quota · idempotency · stream adapter    │
├───────────────────────┬───────────────────────┬────────────────────────────┤
│ Conversation service  │ Calculator validator  │ Share-link service          │
│ request state · audit │ allowlist · limits    │ encode · decode · expiry   │
├───────────────────────┴───────────────────────┴────────────────────────────┤
│ Model Gateway                                                                │
│ provider routing · prompt policy · timeout · cost budget · redaction        │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ provider stream
                    ┌──────────▼──────────┐
                    │ LLM provider         │
                    │ token stream         │
                    └─────────────────────┘
```

### Request flow

The edge endpoint validates message length, session, request ID, and quota before opening a provider stream. The model gateway adds a constrained system policy and requests structured operations plus explanation.

Provider chunks pass through a stream adapter. The adapter emits safe text deltas, but it does not declare the calculation complete until a final structured payload passes schema validation. The calculator executes only the validated operation sequence.

### State ownership

The browser owns prompt draft and local display state. The backend owns request status, quota accounting, provider correlation, saved conversations, and share-link records. The model owns no durable state.

### Edge deployment

The endpoint can run on an edge runtime for low user-to-API latency, but provider latency and region may dominate. The design must not assume that edge execution solves the whole latency budget.

## D — Data Model — 6 minutes

| Entity | Important fields | Authority |
|---|---|---|
| `Session` | session ID, user/anonymous identity, expiry | auth service |
| `AIRequest` | request ID, session, status, provider, token usage | conversation service |
| `Message` | request, role, redacted content, sequence | conversation store |
| `OperationPlan` | request, typed operations, validation status | calculator service |
| `ShareLink` | token hash, payload reference, expiry, access count | share service |
| `QuotaBucket` | identity, window, tokens, cost units | rate-limit store |
| `UsageEvent` | request, latency, tokens, model, outcome | analytics sink |

### Request state machine

An AI request moves from accepted to streaming, completed, cancelled, failed, or provider-unknown. Provider timeout is not treated as successful completion. A retry uses a new request ID unless the original request can be safely resumed.

### Operation model

Operations come from a finite allowlist: numeric input, arithmetic operator, percentage, unit conversion where supported, and display formatting. Each operation has bounded arguments and a deterministic result. Unknown operations are rejected.

### Share links

Share links contain an opaque token, not an unencrypted private transcript in a URL. The server stores or signs a bounded payload, applies expiry, and can revoke access. Shared content is explicitly user-selected and redacted.

## I — Interfaces — 8 minutes

### Public API

```
POST /api/v1/ai/requests              → open a streamed AI request
POST /api/v1/ai/requests/:id/cancel   → cancel provider work
GET  /api/v1/ai/requests/:id          → status or completed result
POST /api/v1/shares                   → create share link
GET  /api/v1/shares/:token            → read public shared calculation
GET  /api/v1/me/usage                → quota summary
```

The request endpoint returns an SSE stream with typed events: accepted, text delta, operation candidate, warning, complete, error, and heartbeat. Every event includes request ID and sequence.

### SSE semantics

The stream uses no-cache headers, heartbeat events, and an explicit terminal event. A client disconnect does not guarantee provider cancellation; the backend attempts cancellation and records whether it succeeded.

If the client reconnects, it can query request status. The server may replay buffered terminal state but does not promise replay of every token delta.

### Internal interfaces

| Boundary | Input | Output | Guarantee |
|---|---|---|---|
| Edge policy | identity, request | allow/deny | quota and validation |
| Model gateway | prompt, budget | provider stream | credential isolation |
| Stream adapter | provider events | typed SSE events | ordered framing |
| Validator | candidate plan | accepted/rejected plan | fail closed |
| Calculator | validated plan | deterministic result | bounded execution |
| Usage sink | request metrics | aggregated event | no raw secret logging |

### Error contract

Errors distinguish invalid input, quota exceeded, provider unavailable, provider timeout, malformed model output, cancelled request, and share-link expiration. A retryable provider error is not the same as a rejected operation plan.

## O — Optimizations and Deep Dives — 20 minutes

### Deep dive 1: Rate limiting and cost control

I use a distributed token bucket keyed by anonymous identity, authenticated user, and optionally IP reputation. A request consumes both request quota and an estimated cost budget. The limit state lives in a shared low-latency store with atomic updates.

Per-instance memory is insufficient because users can rotate edge instances. A purely fixed window is simpler but permits bursts at boundaries. Token buckets provide smoother control at the cost of atomic state and clock handling.

The API returns remaining quota and reset information without exposing internal policy details. A provider timeout still consumes some cost if tokens were generated; usage accounting records actual provider usage where available.

### Deep dive 2: SSE versus WebSocket

SSE fits a request-initiated, server-to-client token stream and works with standard HTTP infrastructure. WebSockets enable bidirectional cancellation and multiplexing but add connection lifecycle complexity that is unnecessary for one short request per prompt.

The chosen SSE design still supports cancellation through a separate HTTP command and request ID. The trade-off is that cancellation is not guaranteed to arrive before the provider completes. The request state therefore records cancellation requested and final provider outcome separately.

### Deep dive 3: Structured output and safe execution

The model may explain an answer in natural language, but calculator execution accepts only a schema-validated operation plan. The validator checks operation names, argument bounds, maximum steps, numeric range, and policy.

The alternative is asking the model to return JavaScript and executing it in a sandbox. That expands the security surface, makes resource limits harder, and is unnecessary for a calculator vocabulary. A constrained plan is less expressive but dramatically easier to audit.

### Deep dive 4: Prompt injection and data boundaries

User text is untrusted input. The gateway separates system policy from user content, strips unsupported control metadata, bounds message size, and does not let user text override operation or privacy policy.

If saved conversation context is included, each message has an explicit role and length budget. Secrets, internal prompts, provider keys, and other users’ data never enter the prompt. The model response is treated as untrusted until validated.

### Deep dive 5: Idempotency and retries

The browser generates a request ID before opening the stream. The backend stores accepted request metadata and returns existing terminal state for duplicate creation attempts. It does not automatically replay provider work when the original provider call may still be running.

The alternative is to retry every network error with a new provider request. That can double cost and produce two answers. Status lookup and bounded resume are safer than blind replay.

### Deep dive 6: Share-link encoding

Share links should be short but not leak private text. A server-side token reference provides revocation and smaller URLs. A signed compressed payload can reduce storage but makes revocation and key rotation more complex.

I would start with an opaque token hash and an expiry, store a redacted calculation payload, and add compression only when URL length is a demonstrated problem.

### Deep dive 7: Failure matrix

| Failure | Backend behavior | Client behavior |
|---|---|---|
| Quota exceeded | reject before provider call | show reset time |
| Provider timeout | terminal retryable error | retry with new intent |
| Client disconnects | attempt cancellation | query status if needed |
| Malformed plan | fail closed | show explanation fallback |
| Shared store down | conservative deny/degrade | temporary unavailable |
| Share expired | deny payload | explain expiration |
| Edge timeout | persist request state if possible | status lookup |

## Capacity, rollout, and review checkpoints

### Capacity assumptions

I would test short prompts, long prompts near the limit, simultaneous anonymous users, slow provider streams, client disconnects, and quota-store contention. The capacity budget is provider concurrency and cost as much as HTTP requests.

### What I would measure

- Time to first token and completion latency.
- Provider token usage and cost per request.
- Stream disconnect and cancellation rates.
- Quota-store latency and denial rate.
- Malformed plan rejection rate.
- Calculator execution duration.
- Share-link access and expiry errors.

### Rollout sequence

1. Ship deterministic calculator operations without the model.
2. Add one model gateway with strict output validation.
3. Add SSE framing, heartbeat, and terminal events.
4. Add distributed quotas and request status lookup.
5. Add saved history and redacted share links.
6. Add provider routing and edge deployment after failure behavior is tested.

### Alternative architecture review

WebSockets can multiplex prompts and cancellation but add connection management that a short request stream does not need. SSE plus an HTTP cancel command is simpler and works with standard proxies.

Executing model-generated code would support more expressions but creates a security and resource sandbox problem. A bounded operation vocabulary is less expressive and substantially safer.

Per-instance quotas are cheap but inconsistent behind load balancing. A shared token bucket costs a network round trip and atomic state, but it protects provider spend globally.

### Backend interview checkpoints

I trace a prompt through quota, validation, model gateway, SSE event framing, operation validation, and deterministic calculation.

I explain why a client disconnect does not prove provider cancellation and why a malformed model plan fails closed.

I close by returning to cost control, credential isolation, and recoverable request state.

## Scalability and operations

The first bottleneck is provider cost and concurrency. The second is stream connection and buffering. The third is shared quota-store load. Limit prompt size, cap concurrent requests, route models by complexity, and avoid buffering unbounded provider output.

Edge instances scale horizontally, while saved history and share data live in durable storage. Usage events go to an asynchronous analytics pipeline. Provider outage can degrade to a deterministic calculator-only mode if the product supports it.

## Security and observability

The provider key exists only in the model gateway environment. Authentication, quota identity, input validation, and share authorization are server-side. Logs redact prompts, provider responses, tokens, and share payloads by default.

Metrics include time to first token, completion latency, provider error rate, cancellation rate, validation rejection rate, tokens per request, quota denials, stream disconnects, and share access. Correlation IDs connect browser request, edge request, gateway call, and terminal state.

## Provider gateway details

The model gateway owns provider credentials, model selection, timeout budgets, and redaction. The edge layer should not contain provider-specific prompt logic because that makes policy changes harder to audit.

Provider requests include a bounded conversation context, a calculator policy, an output schema instruction, and a cost budget. The gateway records provider request ID and model version without persisting sensitive prompt content by default.

If a provider supports structured output, the gateway uses it. If it returns only text, the validator extracts the allowed plan and rejects ambiguous output. A partial explanation can be displayed, but execution waits for a valid terminal plan.

## Stream lifecycle details

The server emits accepted before provider work begins, then ordered deltas with sequence numbers. Heartbeats keep intermediaries from closing an idle stream. Completion includes result, operation plan status, usage, and request ID.

If the browser disconnects, the server cancels provider work when possible and records cancellation requested. If cancellation races with completion, the terminal request state decides whether a result is available.

If a stream is interrupted after completion, status lookup returns the result. If it is interrupted during generation, the client may retry as a new intent; the server does not pretend token replay is guaranteed.

## Privacy and abuse controls

Anonymous identities use a privacy-preserving bucket key and receive lower quotas. Authenticated users can receive higher limits, but account-level abuse controls still apply. IP is one signal, not the sole identity, because shared networks and proxies make it imperfect.

Prompts and responses are not ordinary logs. Diagnostics use request ID, model, latency, token count, and error class. If content review is required, retention and access are explicit product decisions.

The share service redacts provider instructions, hidden metadata, and private conversation turns. A share token is hashed at rest and can expire or be revoked.

## Operational recovery

When the quota store is unavailable, the service fails closed for expensive model calls rather than allowing unlimited spend. When the provider is unavailable, the deterministic calculator remains available if the product can interpret direct numeric input.

When the analytics sink is unavailable, usage events buffer or drop according to privacy-safe policy; they never block a completed user response. When the session store is unavailable, anonymous requests may follow a stricter policy but authenticated requests do not bypass authorization.

## Interview walkthrough: one prompt

The browser creates request ID and sends a bounded message. The edge policy checks identity and quota. The gateway sends a constrained prompt to the provider and turns chunks into typed SSE events.

The client displays explanation deltas but waits for a validated operation plan. The calculator executes only the allowlisted plan. A provider timeout becomes a terminal retryable state. A disconnect leads to status lookup or a new explicit request.

This scenario demonstrates why streaming, safety, billing, and deterministic calculation are separate concerns.

## Capacity and staged rollout

The first release can support a modest anonymous audience with strict quotas and a small authenticated history. The system should be tested against a burst after a product launch, not only a smooth average request rate.

The provider concurrency limit is the main capacity control. A queue can smooth work, but queuing interactive prompts too long damages the product promise. I would reject or downgrade requests when the provider budget is exhausted rather than create an unbounded backlog.

The edge layer scales statelessly. The quota store and request-status store need predictable low latency and atomic updates. Saved conversations and shares use durable storage; token deltas do not need durable retention.

The model gateway can route simple arithmetic to a smaller model or deterministic parser and reserve an expensive model for ambiguous natural language. This improves cost and availability while keeping one typed operation contract.

### Security review

The provider key is server-only. The browser receives request IDs and stream data, never credentials or hidden prompt policy. Input is length-bounded and treated as untrusted text.

The operation validator is a second security boundary. Even if the provider is compromised or prompt-injected, unsupported operations, excessive steps, non-finite values, and out-of-range arguments are rejected.

Share tokens are opaque, hashed at rest, expiring, and scoped to redacted content. Rate limits apply to share creation and access to prevent token probing.

### Testing review

I would test quota races across edge instances, provider timeout, client disconnect, malformed structured output, duplicate request IDs, share expiry, and calculator overflow.

I would test that a final SSE event is emitted exactly once from the API perspective and that a status lookup can recover a completed result after the browser loses the stream.

### Interview walkthrough checkpoints

I start with the deterministic calculator so the model is an optional interpretation layer rather than the source of arithmetic truth.

I then trace a prompt through quota, gateway, SSE, validation, execution, and terminal status.

I pause on the distinction between partial explanation and executable operation plan.

I close by explaining why provider cost, prompt privacy, and cancellation are backend contracts, not frontend implementation details.

### Final handoff

- The provider is expensive and untrusted.
- The calculator is deterministic and bounded.
- The stream is recoverable through request status.
- Quotas protect both availability and cost.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Stream | SSE | WebSocket | one-way request stream and simpler infrastructure |
| Execution | typed operation plan | arbitrary code | smaller security surface |
| Quota | distributed token bucket | per-instance counter | consistent global limits |
| Retry | status lookup | blind provider retry | prevents duplicate cost |
| Share | opaque stored token | signed payload only | revocation and privacy |
| State | backend request record | provider-only state | recoverable terminal outcome |

## Closing — 3 minutes

The model is an untrusted, expensive dependency. The backend protects it with quotas, prompt and output boundaries, a typed calculator validator, stream lifecycle state, and privacy-safe observability. SSE gives users fast partial feedback without making the calculator itself probabilistic.

I would build the deterministic calculator and one provider gateway first, then add saved history, share links, model routing, and edge deployment after quotas and failure semantics are proven.
