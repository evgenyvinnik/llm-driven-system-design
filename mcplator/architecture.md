# MCPlator - Architecture Design

## System Overview

A retro-style calculator application enhanced with an AI co-pilot that translates natural language into calculator key-press sequences, demonstrating LLM integration patterns for interactive applications. The calculator engine runs entirely client-side as a finite state machine, while natural language processing is handled by Claude Haiku via a Vercel Edge Function proxy.

**Learning goals:** LLM integration patterns (intent-to-action mapping), Server-Sent Events (SSE) for real-time streaming, edge computing for low-latency API proxying, finite state machine design for UI logic, client-side quota management without user accounts.

## Requirements

### Functional Requirements

- Full calculator functionality (basic math, memory, percentage, square root, sign toggle)
- Natural language input for calculations ("what's 15% of 80")
- Real-time AI responses with animated key presses on the calculator display
- Shareable calculation URLs (LMCIFY -- compressed message encoding in URL)
- Persistent state across sessions (chat history, calculator memory, daily quota)

### Non-Functional Requirements

- **Latency:** AI first-token response < 500ms (p95) for natural language queries
- **Reliability:** Calculator fully functional without AI connectivity; graceful degradation when API is unavailable
- **Cost Efficiency:** Daily request quota per user without requiring authentication; rate limiting at edge function
- **Security:** Anthropic API key server-side only; user input sanitized and length-limited
- **Animation:** Key press animations at 60 FPS with natural timing variation
- **Bundle Size:** < 200 KB gzipped total (excluding lazy-loaded assets)

## High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          CLIENT (Browser)                                  │
│                                                                           │
│  ┌─────────────────┐              ┌──────────────────────────────────┐   │
│  │   Calculator    │              │        Chat Interface             │   │
│  │  ┌───────────┐  │              │  ┌────────────────────────────┐  │   │
│  │  │ LCD       │  │              │  │ Message History            │  │   │
│  │  │ Display   │  │◀────────────▶│  │ (AI + User messages)      │  │   │
│  │  └───────────┘  │  Key Press   │  └────────────────────────────┘  │   │
│  │  ┌───────────┐  │  Animation   │  ┌────────────────────────────┐  │   │
│  │  │ Keypad    │  │  Queue       │  │ Natural Language Input     │  │   │
│  │  │ Grid      │  │              │  └────────────────────────────┘  │   │
│  │  └───────────┘  │              └──────────────────────────────────┘   │
│  └─────────────────┘                                                     │
│           │                                                               │
│           ▼                                                               │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                Calculator Engine (Finite State Machine)            │  │
│  │  States: READY → ENTERING_NUMBER → PENDING_OPERATION →            │  │
│  │          ENTERING_NUMBER → SHOWING_RESULT                         │  │
│  │  Operations: + - x / % sqrt +/- = C AC M+ M- MR MC               │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│           │                                                               │
│           ▼                                                               │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                     Zustand State Store                            │  │
│  │  - Calculator: display, accumulator, pending op, memory           │  │
│  │  - Chat: messages, loading state, streaming tokens                │  │
│  │  - Quota: daily remaining, last reset date                        │  │
│  └──────────────────────────┬─────────────────────────────────────────┘  │
│                              │                                            │
│                              ▼                                            │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                    IndexedDB Persistence                           │  │
│  │  - Chat history    - Calculator memory    - Daily usage quota      │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
└──────────────────────────────┬────────────────────────────────────────────┘
                               │ SSE Stream (POST /api/chat)
                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                     Vercel Edge Functions                                  │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                     /api/chat Endpoint                             │  │
│  │                                                                    │  │
│  │  1. Validate input (length, rate limit)                           │  │
│  │  2. Build prompt with calculator context + system instructions    │  │
│  │  3. Call Claude API with streaming enabled                        │  │
│  │  4. Parse structured JSON response for key sequences              │  │
│  │  5. Stream SSE events back to client                              │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
└──────────────────────────────┬────────────────────────────────────────────┘
                               │ Streaming API Call
                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                     Anthropic API (Claude Haiku 4.5)                      │
│                                                                           │
│  - First-token latency: ~200ms                                           │
│  - Cost: $0.25 / 1M input tokens                                        │
│  - Structured output: { "keys": [...], "explanation": "..." }            │
└───────────────────────────────────────────────────────────────────────────┘
```

### Data Flow: AI-Powered Calculation

```
User: "what's 15% of 80"
         │
         ▼
┌──────────────────────────┐
│  Chat Input Handler      │
│  - Validate input        │
│  - Check quota           │
│  - Generate requestId    │
└──────────┬───────────────┘
           │ POST /api/chat
           ▼
┌──────────────────────────┐
│  Edge Function Proxy     │
│  - Rate limit check      │
│  - Build Claude prompt   │
│  - Stream response       │
└──────────┬───────────────┘
           │ SSE tokens
           ▼
┌──────────────────────────┐
│  Response Parser         │
│  - Buffer incomplete JSON│
│  - Extract key sequence  │
│  - Extract explanation   │
└──────────┬───────────────┘
           │ ["8","0","x","1","5","%","="]
           ▼
┌──────────────────────────┐
│  Key Animation Queue     │
│  - Digit: 100ms delay    │
│  - Operator: 150ms delay │
│  - Equals: 200ms delay   │
│  - requestAnimationFrame │
└──────────┬───────────────┘
           │
           ▼
Calculator display shows: 12
```

## Core Components

### 1. Calculator Engine (Finite State Machine)

The calculator is implemented as a deterministic FSM with five states:

| State | Description | Valid Inputs |
|-------|-------------|-------------|
| READY | Initial state, display shows 0 | Digits, decimal point |
| ENTERING_NUMBER | User is typing a number | Digits, decimal, operators, equals |
| PENDING_OPERATION | Operator pressed, waiting for second operand | Digits, decimal point |
| SHOWING_RESULT | Equals pressed, result displayed | Digits (start new), operators (chain) |
| ERROR | Division by zero or overflow | Clear (C/AC) only |

**State transitions:**
```
READY + digit ──────────────────▶ ENTERING_NUMBER
ENTERING_NUMBER + operator ─────▶ PENDING_OPERATION
PENDING_OPERATION + digit ──────▶ ENTERING_NUMBER
ENTERING_NUMBER + equals ───────▶ SHOWING_RESULT
SHOWING_RESULT + digit ─────────▶ ENTERING_NUMBER (new calculation)
SHOWING_RESULT + operator ──────▶ PENDING_OPERATION (chain)
ANY + clear ────────────────────▶ READY
```

Each key press transitions to exactly one new state. The FSM is deterministic and side-effect-free, making it trivially testable: given a state and a key, the output state is always the same.

### 2. AI Message Processor

Translates the LLM's structured JSON response into calculator key-press actions. The processor receives a response like `{ "keys": ["8", "0", "x", "1", "5", "%", "="], "explanation": "80 times 15 percent" }` and feeds the keys one at a time into the calculator engine via the animation queue.

**Intent-to-action mapping:** The LLM converts ambiguous natural language ("add 2 plus one hundred") into a deterministic sequence of calculator keys (`["2", "+", "1", "0", "0", "="]`). This is the core LLM integration pattern -- using the model for parsing and disambiguation, not for computation.

### 3. SSE Stream Handler

The client reads the response body as a ReadableStream, buffering incomplete chunks and parsing complete SSE events. Tokens may arrive split across chunk boundaries, so the parser maintains a buffer and only processes complete `data: ...\n\n` events.

SSE was chosen over WebSockets because the communication is unidirectional (server to client), SSE has built-in reconnection, and it works natively with serverless/edge functions that cannot maintain persistent connections.

### 4. LMCIFY URL Sharing

Messages are gzip-compressed and base64-encoded into a URL query parameter, enabling shareable calculation links without a server-side URL shortener. The shared URL auto-plays the calculation on page load, animating the key presses.

URL length limit (~2,000 characters) constrains message length. Gzip compression typically achieves 2-3x reduction, supporting messages up to ~1,500 characters uncompressed.

## Key Design Decisions

### 1. Server-Sent Events over WebSockets

**Decision:** Use SSE for AI response streaming.

SSE provides a simple, HTTP-based streaming mechanism that is sufficient for the unidirectional flow from server to client. Unlike WebSockets, SSE works naturally with serverless functions (which cannot maintain persistent connections), has built-in reconnection and event ID tracking, and requires no special server infrastructure. The trade-off is one-direction-only communication, but MCPlator only needs server-to-client streaming -- the client sends requests via standard HTTP POST. Using WebSockets here would add connection management complexity (heartbeats, reconnection logic, state synchronization) with no functional benefit.

### 2. Edge Functions for API Proxy

**Decision:** Vercel Edge Runtime for the `/api/chat` endpoint.

Edge functions run in V8 isolates at the nearest Vercel region to the user, providing ~50ms cold starts (vs ~300ms for Node.js serverless functions). This matters because the edge function is on the critical path between the user's message and Claude's response -- every millisecond of proxy latency adds to perceived AI response time. The trade-off is a restricted runtime (V8 isolate, no Node.js APIs, no filesystem access), but the proxy function is simple enough to not need these capabilities. The 30-second timeout on Vercel's hobby tier is a constraint for very complex prompts, but Claude Haiku typically responds in under 5 seconds.

### 3. Claude Haiku for AI Processing

**Decision:** Use Claude Haiku 4.5 for natural language parsing.

Haiku provides the lowest first-token latency (~200ms) in the Claude model family, which is critical for a calculator UI where responsiveness directly affects the user experience. The model is cost-efficient ($0.25/1M input tokens) for the simple task of parsing math expressions into key sequences. Larger models (Sonnet, Opus) would provide better reasoning for complex math, but the latency and cost trade-off is not justified when the calculator engine handles the actual computation. The LLM's job is parsing, not computing.

### 4. Client-Side Quota Management

**Decision:** Track daily API usage quota in IndexedDB without user accounts.

Without authentication, server-side rate limiting can only use IP addresses, which are unreliable (shared IPs, VPNs). Client-side quota tracking in IndexedDB provides a reasonable first line of defense: the daily counter resets at midnight, and the UI shows remaining requests. This is easily bypassed by clearing browser storage, but combined with server-side IP-based rate limiting at the edge function, it provides adequate protection for a free-tier personal project. The trade-off vs. server-side session tracking: no cross-device quota enforcement, but also no session management complexity.

## API Design

### /api/chat

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/chat` | Send natural language message, receive streamed key sequence |

**Request:** Message string with requestId for idempotency.

**Response:** SSE stream of tokens, parsed into structured JSON containing `keys` (calculator key sequence) and `explanation` (human-readable description).

**Rate limiting:** IP-based at edge function level, plus client-side daily quota tracking.

## Consistency and Idempotency

### Calculator State (Client-Side)

**Consistency model:** Strong, synchronous, single-client. Each key press transitions the FSM to exactly one new state. No concurrent writes are possible (single browser tab, single-threaded JS event loop). Replaying the same key sequence from the same initial state always produces the same result.

### IndexedDB Persistence (Client-Side)

**Consistency model:** Eventual (async writes, single-client). Writes are debounced at 500ms to avoid overwhelming IndexedDB. Each write uses a UUID for idempotency. Last-write-wins with timestamp ordering. State snapshots are complete -- replaying overwrites previous state entirely.

### API Requests (Server-Side)

**Consistency model:** At-most-once delivery with client-side retry.

The client generates an idempotency key (session ID + timestamp + message hash) before the first request attempt. All retries of the same user action carry the same key. The edge function can optionally cache responses by idempotency key in a KV store (5-minute TTL) to prevent duplicate Claude API calls. Failed requests are safe to retry because the idempotency key ensures deduplication.

## Security Considerations

### API Key Protection

The Anthropic API key is stored server-side only, within the Vercel Edge Function's environment variables. The client never sees or transmits the key. All Claude API calls are proxied through the edge function.

### Input Sanitization

- Message length validated (reject > 500 characters)
- Special characters escaped before prompt construction
- Request frequency limited per IP at the edge function

### Quota Management

- Daily request limits tracked both client-side (IndexedDB) and server-side (IP-based rate limiting)
- When quota is exceeded, the UI shows a graceful degradation message; the calculator continues to work without AI
- No user accounts means no per-user server-side quotas -- IP-based limiting is the server-side enforcement mechanism

## Observability

### Key Metrics

| Metric | Type | Alert Threshold |
|--------|------|-----------------|
| `ai_request_latency_ms` | Histogram | p95 > 1000ms |
| `ai_request_total` | Counter | > 100/day (quota) |
| `ai_request_errors` | Counter | > 5 in 5 minutes |
| `key_animation_fps` | Gauge | < 30 FPS |
| `indexeddb_write_latency_ms` | Histogram | p95 > 100ms |
| `quota_remaining` | Gauge | < 10 requests |

### Logging

Structured log entries with `timestamp`, `level`, `component` (calculator/chat/api/storage), and `message`. Client-side logs are kept in memory (last 1,000 entries) and exportable to file for debugging. Server-side logs use Vercel's built-in log retention.

### Tracing

Lightweight request tracing: the client generates a `traceId` (UUID) for each AI request and passes it via `X-Trace-Id` header. The edge function logs this ID alongside the Claude API call, enabling end-to-end correlation of client request, edge function execution, and Claude API response timing.

## Failure Handling

### Retry Strategy

API requests use exponential backoff with jitter: base delay 1s, multiplier 2x, max delay 10s, max 3 retries. Client errors (4xx except 429) are not retried. Server errors (5xx) and rate limits (429) trigger retries with the same idempotency key.

### Circuit Breaker

A client-side circuit breaker prevents cascading failures when the AI service is degraded:

| State | Behavior | Transition |
|-------|----------|------------|
| CLOSED | Normal operation, requests pass through | 5 consecutive failures --> OPEN |
| OPEN | Reject requests immediately, show degradation message | 30s timeout --> HALF_OPEN |
| HALF_OPEN | Allow one test request | Success --> CLOSED, failure --> OPEN |

When the circuit is open, the calculator remains fully functional -- only the AI natural language feature is disabled. The degradation message explains that the AI assistant is temporarily unavailable and suggests trying again in 30 seconds.

### Error Recovery Flow

```
User Action Failed
        │
        ▼
┌──────────────────┐
│  Check Error Type │
└────────┬─────────┘
         │
    ┌────┴────┬──────────────┬────────────────┐
    ▼         ▼              ▼                ▼
 Network   Rate Limit    API Error        Client Error
    │         │              │                │
    ▼         ▼              ▼                ▼
 Retry     Wait &        Circuit           Show Error
 with      Show           Breaker          (no retry)
 Backoff   Countdown      Check
    │         │              │
    ▼         ▼              ├── CLOSED: Retry
 Success?  Timer Done?    ├── HALF_OPEN: Test
    │         │              └── OPEN: Degrade
    ▼         ▼
 Update    Auto-Retry
 UI
```

### Service Continuity

| Failure Scenario | Impact | Mitigation |
|------------------|--------|------------|
| Claude API down | No AI responses | Circuit breaker + graceful degradation (calculator works) |
| Edge function timeout | Request fails | Client-side retry with exponential backoff |
| IndexedDB quota exceeded | Cannot persist state | Prompt user to export and clear old data |
| Browser storage cleared | Data lost | Regular backup reminders + export/import buttons |
| Vercel region outage | Higher latency | Vercel automatic failover to nearest region |

## Scalability Considerations

### Request Volume

Each AI request costs ~$0.0001 (Haiku pricing at ~400 tokens per request). With a daily quota of 100 requests per user, the cost per user is ~$0.01/day. At 1,000 daily active users, the monthly Claude API cost would be ~$300. Scaling beyond this requires either tighter quotas, user accounts with paid tiers, or switching to a cheaper model.

### Edge Function Scaling

Vercel Edge Functions scale automatically per request with no connection pooling or state management needed. Each invocation is stateless -- the function receives a request, calls Claude, and streams the response. This scales horizontally without architectural changes.

### Client-Side Scaling

The calculator and chat UI run entirely in the browser. There is no server-side state to scale. IndexedDB storage is per-browser and does not grow with user count. The only shared resource is the Claude API, which is metered per-request.

### URL Sharing Scaling

LMCIFY URLs encode the message directly in the URL (no server-side storage). This means sharing scales infinitely with no database or URL shortener service. The constraint is URL length (~2,000 characters), which limits message complexity.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| AI streaming | SSE | WebSocket | Unidirectional sufficient; SSE works with serverless, has built-in reconnection |
| API proxy | Vercel Edge Functions | Node.js serverless | ~50ms cold start vs ~300ms; lower latency on critical path |
| AI model | Claude Haiku 4.5 | GPT-3.5, Sonnet | Lowest first-token latency (~200ms), cost-efficient for parsing tasks |
| Persistence | IndexedDB (client) | Server-side DB | No user accounts needed; privacy by default; works offline |
| Quota tracking | Client IndexedDB + server IP rate limit | Server-side per-user quota | No authentication complexity; adequate for free-tier project |
| State machine | Explicit FSM | Ad-hoc conditionals | Predictable, testable, maps directly to calculator behavior |
| URL sharing | Gzip + base64 in URL | Server-side URL shortener | No database, no server cost, infinite scaling |

## Implementation Notes

This project is a **design-only entry** in this repository. The implementation lives in an external repository:

**External Repository:** [github.com/evgenyvinnik/MCPlator](https://github.com/evgenyvinnik/MCPlator)

### What the External Implementation Covers

Based on the architecture document and the project's CLAUDE.md, the external repository implements:

- **Retro calculator UI** with Casio-style CSS 3D button effects (perspective and transform, no images)
- **Calculator engine** as a finite state machine with full arithmetic, memory, percentage, and square root operations
- **Claude Haiku integration** via Vercel Edge Function proxy, streaming responses over SSE
- **Natural language parsing:** LLM translates user messages into calculator key sequences, animated on the UI
- **Key press animation system** with variable timing (100ms digits, 150ms operators, 200ms equals) using `requestAnimationFrame`
- **LMCIFY URL sharing** with gzip + base64 compression for shareable calculation links
- **IndexedDB persistence** for chat history, calculator memory, and daily quota tracking
- **Zustand state management** with CSS Modules + Tailwind hybrid styling
- **Bun** as package manager and development runtime

### What Is Simplified or Substituted

- **No server-side idempotency cache:** The architecture describes KV-based request deduplication at the edge function, but the implementation may use simpler at-most-once semantics
- **No Sentry or external monitoring:** Metrics and logging are console-based for local development
- **No circuit breaker library:** The circuit breaker pattern may be implemented as a simple failure counter rather than a full state machine
- **IP-based rate limiting only:** No sophisticated abuse detection beyond Vercel's built-in rate limiting

### What Is Omitted

- WebSocket-based bidirectional chat
- Voice input support
- Scientific calculator mode
- Unit conversions
- Multi-tab synchronization via BroadcastChannel API
- Server-side audit logging with retention policies
- Formal SLI dashboard beyond console logging
