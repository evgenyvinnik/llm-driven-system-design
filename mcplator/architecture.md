# MCPlator - Architecture Design

## System Overview

A retro-style calculator application enhanced with an AI co-pilot that translates natural language into calculator operations, demonstrating LLM integration patterns for interactive applications.

## Requirements

### Functional Requirements

- Full calculator functionality (basic math, memory, percentage, etc.)
- Natural language input for calculations
- Real-time AI responses with animated key presses
- Shareable calculation URLs
- Persistent state across sessions

### Non-Functional Requirements

- **Latency:** First token < 500ms for AI responses
- **Reliability:** Graceful degradation without AI connectivity
- **Cost Efficiency:** Rate limiting for API usage
- **Security:** API key protection, input sanitization

## High-Level Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (Browser)                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌────────────────┐          ┌─────────────────────────────┐   │
│   │  Calculator    │          │       Chat Interface         │   │
│   │  ┌──────────┐  │          │  ┌───────────────────────┐  │   │
│   │  │ LCD      │  │          │  │ Message History       │  │   │
│   │  │ Display  │  │◀────────▶│  │ (AI + User messages)  │  │   │
│   │  └──────────┘  │  Key     │  └───────────────────────┘  │   │
│   │  ┌──────────┐  │  Presses │  ┌───────────────────────┐  │   │
│   │  │ Keypad   │  │          │  │ Input Field           │  │   │
│   │  │ Grid     │  │          │  │ (Natural Language)    │  │   │
│   │  └──────────┘  │          │  └───────────────────────┘  │   │
│   └────────────────┘          └─────────────────────────────┘   │
│           │                              │                       │
│           ▼                              ▼                       │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │              Calculator Engine (State Machine)           │   │
│   │  - Numeric input handling                                │   │
│   │  - Operation execution (+, -, ×, ÷, %, √)               │   │
│   │  - Memory operations (M+, M-, MR, MC)                    │   │
│   │  - State: accumulator, pending operation, memory         │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                  Zustand State Store                     │   │
│   │  - Calculator state (display, memory, history)           │   │
│   │  - Chat state (messages, loading, quota)                 │   │
│   │  - UI state (theme, settings)                            │   │
│   └────────────────────────────┬────────────────────────────┘   │
│                                │                                 │
│                                ▼                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                IndexedDB Persistence                     │   │
│   │  - Chat history                                          │   │
│   │  - Calculator memory                                     │   │
│   │  - Daily usage quota                                     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │ SSE Stream
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SERVER (Vercel Edge Functions)                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    /api/chat Endpoint                    │   │
│   │                                                          │   │
│   │  1. Receive natural language request                     │   │
│   │  2. Build prompt with calculator context                 │   │
│   │  3. Call Claude API with streaming                       │   │
│   │  4. Parse response for key sequences                     │   │
│   │  5. Stream SSE events to client                          │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EXTERNAL (Anthropic API)                      │
├─────────────────────────────────────────────────────────────────┤
│   Claude Haiku 4.5                                               │
│   - Low latency (~200ms first token)                            │
│   - Cost efficient for simple requests                          │
│   - Structured output for key sequences                         │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow: AI-Powered Calculation

```
User: "what's 15% of 80"
         │
         ▼
┌─────────────────────────────┐
│     Chat Input Handler      │
│  - Capture text input       │
│  - Update UI (loading)      │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│      API Request            │
│  POST /api/chat             │
│  { message: "15% of 80" }   │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│    Claude API (Streaming)   │
│  System prompt: "You are    │
│  a calculator assistant..." │
│  User: "15% of 80"          │
└─────────────────────────────┘
         │
         ▼ (SSE Stream)
┌─────────────────────────────┐
│    Response Processing      │
│  Tokens: [8, 0, ×, 1, 5, %] │
│  Message: "80 × 15% = 12"   │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│    Key Animation Queue      │
│  - Animate each key press   │
│  - Update calculator state  │
│  - Show result on display   │
└─────────────────────────────┘
         │
         ▼
Display shows: 12
```

## Core Components

### 1. Calculator Engine

A state machine managing calculator operations:

```typescript
interface CalculatorState {
  display: string;           // Current display value
  accumulator: number;       // Running total
  pendingOperation: Op;      // Waiting operation
  memory: number;            // Memory register
  isNewNumber: boolean;      // Start new number on next input
}

type Operation = '+' | '-' | '×' | '÷' | '%' | '√' | '±' | '=' | 'C' | 'AC' | 'M+' | 'M-' | 'MR' | 'MC';
```

### 2. AI Message Processor

Translates LLM responses into calculator actions:

```typescript
interface AIResponse {
  message: string;           // Human-readable response
  keySequence: string[];     // Calculator keys to press
  explanation?: string;      // Optional explanation
}

// Example transformation:
// "what's 15% of 80" → { keySequence: ['8', '0', '×', '1', '5', '%', '='] }
```

### 3. SSE Stream Handler

Client-side streaming with real-time updates:

```typescript
const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const chunk = decoder.decode(value);
  // Parse SSE events and update UI
  processSSEEvent(chunk);
}
```

### 4. LMCIFY URL Sharing

Compressed message encoding for shareable URLs:

```
https://mcplator.com/?lmcify=eJxLTc7PLShKLS5JTQYADdUDMw
                              └── Base64 + gzip compressed message
```

## Key Design Decisions

### 1. Server-Sent Events over WebSockets

**Decision:** Use SSE for AI response streaming.

**Rationale:**
- Simpler than WebSocket (HTTP-based)
- One-way streaming is sufficient
- Built-in reconnection
- Works with serverless functions

**Trade-offs:**
- One direction only (server → client)
- Limited browser connection pool

### 2. Edge Functions for API Layer

**Decision:** Vercel Edge Runtime for /api/chat endpoint.

**Rationale:**
- Lower latency (runs closer to users)
- Streaming response support
- Cost-effective for simple proxying
- Automatic scaling

**Trade-offs:**
- Limited runtime (no Node.js APIs)
- 30s timeout on Vercel hobby tier

### 3. Claude Haiku for AI

**Decision:** Use Claude Haiku 4.5 model.

**Rationale:**
- Low latency (~200ms first token)
- Cost efficient ($0.25/1M input tokens)
- Sufficient for simple calculations
- Good at structured output

**Trade-offs:**
- Less capable than larger models
- May struggle with complex math

### 4. IndexedDB for Persistence

**Decision:** Store chat history and state in IndexedDB.

**Rationale:**
- Large storage quota
- Structured data support
- Persists across sessions
- No server required

**Schema:**
```typescript
interface PersistedState {
  chatHistory: Message[];
  calculatorMemory: number;
  dailyQuota: {
    date: string;
    remaining: number;
  };
}
```

## Security Considerations

### API Key Protection

- Anthropic API key stored server-side only
- Edge function proxies requests
- Rate limiting per client

### Input Sanitization

- Validate message length
- Escape special characters
- Limit request frequency

### Quota Management

- Daily request limits per IP
- Client-side quota tracking
- Graceful degradation when exceeded

## Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| UI Framework | React 19 | Components |
| Type Safety | TypeScript 5.9 | Compile-time checks |
| Build Tool | Vite 7.3 | Fast builds, HMR |
| State | Zustand | Global state |
| Styling | CSS Modules + Tailwind | Scoped + utility |
| Storage | IndexedDB (idb) | Persistence |
| Backend | Vercel Edge Functions | API proxy |
| AI | Claude Haiku 4.5 | Natural language |
| Streaming | SSE | Real-time updates |

## Performance Optimization

### First Token Latency

1. **Edge Functions:** Deploy close to users
2. **Streaming:** Start rendering before complete
3. **Model Selection:** Haiku optimized for speed

### Animation Smoothness

1. **requestAnimationFrame:** Smooth key animations
2. **CSS Transitions:** Hardware-accelerated
3. **Debounced State:** Batch updates

### Bundle Size

- React lazy loading
- Tree-shaking unused code
- CSS purging

## Consistency and Idempotency

### Write Semantics

MCPlator has three categories of writes, each with different consistency requirements:

#### 1. Calculator State (Client-Side)

**Consistency Model:** Strong (synchronous, single-client)

```typescript
// Calculator operations are atomic within the state machine
function pressKey(key: string): CalculatorState {
  // Each key press transitions to exactly one new state
  // No concurrent writes possible (single browser tab)
  return calculateNewState(currentState, key);
}
```

- **Conflict Resolution:** Not applicable - single writer (one browser tab)
- **Replay Handling:** Key sequence is deterministic; replaying same keys produces same result

#### 2. IndexedDB Persistence (Client-Side)

**Consistency Model:** Eventual (async writes, single-client)

```typescript
interface WriteOperation {
  id: string;           // UUID for idempotency
  timestamp: number;    // For ordering
  data: PersistedState;
}

// Debounced writes to avoid overwhelming IndexedDB
const persistState = debounce(async (state: PersistedState) => {
  const writeId = crypto.randomUUID();
  await db.put('state', {
    id: writeId,
    timestamp: Date.now(),
    data: state
  });
}, 500);
```

- **Idempotency:** Writes use UUID; duplicate writes with same ID are ignored
- **Conflict Resolution:** Last-write-wins based on timestamp
- **Replay Handling:** State snapshots are complete; replaying overwrites previous

#### 3. API Requests (Server-Side)

**Consistency Model:** At-most-once delivery (fire-and-forget with user retry)

```typescript
interface ChatRequest {
  requestId: string;      // Client-generated UUID for idempotency
  message: string;
  timestamp: number;
}

// Edge function deduplication (optional, using KV store)
async function handleChat(req: ChatRequest) {
  const cached = await kv.get(`request:${req.requestId}`);
  if (cached) {
    return cached; // Return cached response for duplicate request
  }

  const response = await callClaude(req.message);
  await kv.set(`request:${req.requestId}`, response, { ex: 300 }); // 5min TTL
  return response;
}
```

- **Idempotency Key:** `requestId` generated by client before sending
- **Conflict Resolution:** First request wins; duplicates return cached response
- **Replay Handling:** Safe to retry failed requests with same `requestId`

### Cross-Tab Consistency (Future Enhancement)

For multi-tab scenarios, use BroadcastChannel API:

```typescript
const channel = new BroadcastChannel('mcplator-sync');

channel.onmessage = (event) => {
  if (event.data.type === 'STATE_UPDATE') {
    // Merge remote state with local state
    mergeState(event.data.state);
  }
};

// Broadcast local changes
function notifyOtherTabs(state: PersistedState) {
  channel.postMessage({ type: 'STATE_UPDATE', state });
}
```

## Observability

### Metrics Collection

For local development, use lightweight in-browser metrics with console export:

#### Key Metrics

| Metric | Type | Description | Alert Threshold |
|--------|------|-------------|-----------------|
| `ai_request_latency_ms` | Histogram | Time from request to first token | p95 > 1000ms |
| `ai_request_total` | Counter | Total AI API calls | > 100/day (quota) |
| `ai_request_errors` | Counter | Failed AI requests | > 5 in 5 minutes |
| `key_animation_fps` | Gauge | Animation frame rate | < 30 FPS |
| `indexeddb_write_latency_ms` | Histogram | Persistence write time | p95 > 100ms |
| `quota_remaining` | Gauge | Daily API quota left | < 10 requests |

#### Implementation

```typescript
// Simple metrics collector for local development
class MetricsCollector {
  private metrics: Map<string, number[]> = new Map();

  recordLatency(name: string, durationMs: number) {
    if (!this.metrics.has(name)) this.metrics.set(name, []);
    this.metrics.get(name)!.push(durationMs);
  }

  incrementCounter(name: string) {
    const current = this.metrics.get(name)?.[0] ?? 0;
    this.metrics.set(name, [current + 1]);
  }

  // Export to console for debugging
  dump() {
    console.table(Object.fromEntries(this.metrics));
  }

  // Calculate percentiles
  getP95(name: string): number {
    const values = this.metrics.get(name) ?? [];
    const sorted = values.sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[idx] ?? 0;
  }
}

export const metrics = new MetricsCollector();
```

### Logging Strategy

Three log levels with structured output:

```typescript
interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  component: 'calculator' | 'chat' | 'api' | 'storage';
  message: string;
  context?: Record<string, unknown>;
}

// Example usage
logger.info('chat', 'AI request started', {
  requestId: 'abc123',
  messageLength: 42
});

logger.error('api', 'Claude API failed', {
  requestId: 'abc123',
  error: 'rate_limited',
  retryAfter: 60
});
```

#### Log Retention

- **Client-side:** Last 1000 log entries in memory, exportable to file
- **Server-side (Edge):** Vercel logs retention (7 days on Pro plan)

### Tracing

Lightweight request tracing for debugging:

```typescript
interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation: string;
  startTime: number;
  endTime?: number;
  tags: Record<string, string>;
}

// Trace an AI request end-to-end
async function tracedChatRequest(message: string) {
  const traceId = crypto.randomUUID();

  const clientSpan = startSpan(traceId, 'client.sendRequest');
  const response = await fetch('/api/chat', {
    headers: { 'X-Trace-Id': traceId }
  });
  endSpan(clientSpan);

  const parseSpan = startSpan(traceId, 'client.parseSSE', clientSpan.spanId);
  await processStream(response);
  endSpan(parseSpan);

  return traceId; // For debugging
}
```

### SLI Dashboard (Console-Based for Local Dev)

```typescript
function printSLIDashboard() {
  console.group('MCPlator SLI Dashboard');
  console.log('AI Request Latency (p95):', metrics.getP95('ai_request_latency_ms'), 'ms');
  console.log('AI Error Rate:', calculateErrorRate(), '%');
  console.log('Animation FPS (current):', metrics.getCurrent('key_animation_fps'));
  console.log('Quota Remaining:', getQuotaRemaining(), 'requests');
  console.log('IndexedDB Health:', checkIndexedDBHealth() ? 'OK' : 'DEGRADED');
  console.groupEnd();
}

// Run every 30 seconds in dev mode
if (import.meta.env.DEV) {
  setInterval(printSLIDashboard, 30000);
}
```

### Audit Logging

Track security-relevant and quota-impacting events:

```typescript
interface AuditEntry {
  timestamp: string;
  event: 'api_request' | 'quota_exceeded' | 'rate_limited' | 'share_created';
  details: {
    requestId?: string;
    quotaRemaining?: number;
    shareUrl?: string;
    ipHash?: string; // Hashed for privacy
  };
}

// Stored in IndexedDB with 30-day retention
async function audit(event: AuditEntry['event'], details: AuditEntry['details']) {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    event,
    details
  };
  await db.add('audit_log', entry);

  // Cleanup old entries
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await db.delete('audit_log', IDBKeyRange.upperBound(cutoff));
}
```

## Failure Handling

### Retry Strategy with Idempotency

#### API Request Retries

```typescript
interface RetryConfig {
  maxRetries: 3;
  baseDelayMs: 1000;
  maxDelayMs: 10000;
  backoffMultiplier: 2;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit & { idempotencyKey: string },
  config: RetryConfig = defaultConfig
): Promise<Response> {
  let lastError: Error;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey
        }
      });

      if (response.ok) return response;

      // Don't retry client errors (4xx) except 429
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new Error(`Client error: ${response.status}`);
      }

      // Retry on 5xx and 429
      lastError = new Error(`Server error: ${response.status}`);
    } catch (e) {
      lastError = e as Error;
    }

    if (attempt < config.maxRetries) {
      const delay = Math.min(
        config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt),
        config.maxDelayMs
      );
      await sleep(delay + Math.random() * 100); // Jitter
    }
  }

  throw lastError!;
}
```

#### Idempotency Key Generation

```typescript
// Generate before user initiates request, not on retry
function generateIdempotencyKey(message: string): string {
  const sessionId = getSessionId(); // From IndexedDB or sessionStorage
  const timestamp = Date.now();
  const messageHash = simpleHash(message);
  return `${sessionId}-${timestamp}-${messageHash}`;
}

// Use the same key for all retries of the same user action
async function sendChatMessage(message: string) {
  const idempotencyKey = generateIdempotencyKey(message);
  return fetchWithRetry('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message }),
    idempotencyKey
  });
}
```

### Circuit Breaker Pattern

Prevent cascading failures when AI service is degraded:

```typescript
enum CircuitState {
  CLOSED = 'closed',      // Normal operation
  OPEN = 'open',          // Failing, reject requests
  HALF_OPEN = 'half_open' // Testing recovery
}

class CircuitBreaker {
  private state = CircuitState.CLOSED;
  private failures = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold = 5;
  private readonly resetTimeoutMs = 30000;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
      } else {
        throw new Error('Circuit breaker is open - AI service unavailable');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = CircuitState.CLOSED;
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      logger.warn('api', 'Circuit breaker opened', { failures: this.failures });
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

export const aiCircuitBreaker = new CircuitBreaker();
```

#### Usage with Graceful Degradation

```typescript
async function getAIResponse(message: string): Promise<AIResponse | null> {
  try {
    return await aiCircuitBreaker.execute(() => callClaudeAPI(message));
  } catch (error) {
    if (aiCircuitBreaker.getState() === CircuitState.OPEN) {
      // Graceful degradation: show fallback message
      return {
        message: "AI assistant is temporarily unavailable. Try again in 30 seconds.",
        keySequence: [],
        explanation: "Circuit breaker active"
      };
    }
    throw error;
  }
}
```

### Disaster Recovery (Local Development Focus)

Since MCPlator is a client-side application with edge functions, DR focuses on data preservation and service continuity.

#### Backup Strategy

```typescript
// Manual export for user data backup
async function exportUserData(): Promise<Blob> {
  const data = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    chatHistory: await db.getAll('messages'),
    calculatorMemory: await db.get('state', 'memory'),
    auditLog: await db.getAll('audit_log')
  };
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

// Import backup
async function importUserData(file: File): Promise<void> {
  const text = await file.text();
  const data = JSON.parse(text);

  // Validate schema version
  if (data.version !== '1.0') {
    throw new Error('Unsupported backup version');
  }

  // Clear existing data
  await db.clear('messages');
  await db.clear('audit_log');

  // Restore
  for (const message of data.chatHistory) {
    await db.add('messages', message);
  }
  await db.put('state', data.calculatorMemory, 'memory');

  logger.info('storage', 'Data restored from backup', {
    messagesRestored: data.chatHistory.length
  });
}
```

#### Service Continuity

| Failure Scenario | Impact | Mitigation |
|------------------|--------|------------|
| Claude API down | No AI responses | Circuit breaker + graceful degradation (calculator still works) |
| Edge function timeout | Request fails | Client-side retry with exponential backoff |
| IndexedDB quota exceeded | Can't persist | Prompt user to export and clear old data |
| Browser storage cleared | Data lost | Regular backup reminders + export button |
| Vercel region outage | Higher latency | Vercel automatic failover to nearest region |

### Backup/Restore Testing Checklist

Run these tests monthly during development:

```markdown
## Backup/Restore Test Checklist

- [ ] Export user data with 100+ chat messages
- [ ] Verify exported JSON is valid and readable
- [ ] Clear IndexedDB completely
- [ ] Import backup file
- [ ] Verify all messages restored correctly
- [ ] Verify calculator memory restored
- [ ] Verify audit log restored
- [ ] Test with corrupted backup file (should fail gracefully)
- [ ] Test with wrong version backup (should show error)
```

### Error Recovery Flows

```
User Action Failed
        │
        ▼
┌─────────────────┐
│ Check Error Type │
└────────┬────────┘
         │
    ┌────┴────┬─────────────┬──────────────┐
    ▼         ▼             ▼              ▼
Network   Rate Limit    API Error      Client Error
    │         │             │              │
    ▼         ▼             ▼              ▼
Retry      Wait &        Circuit        Show Error
with       Show          Breaker        Message
Backoff    Countdown     Check          (no retry)
    │         │             │
    ▼         ▼             ▼
Success?  Timer Done?   State?
    │         │             │
    ▼         ▼             ├─ CLOSED: Retry
Update    Auto-Retry    ├─ HALF_OPEN: Test Request
UI                      └─ OPEN: Graceful Degradation
```

## Future Optimizations

- [ ] WebSocket for bidirectional chat
- [ ] Voice input support
- [ ] Calculation history
- [ ] Multiple calculator themes
- [ ] Scientific calculator mode
- [ ] Unit conversions
