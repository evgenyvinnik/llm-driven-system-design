# MCPlator - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design MCPlator, a retro calculator with an LLM-powered AI co-pilot that translates natural language into calculator operations. The backend challenge focuses on low-latency LLM integration, SSE streaming, edge computing, and rate limiting at the API layer.

## Requirements Clarification

### Functional Requirements
- **AI Chat Endpoint**: Process natural language and return structured key sequences
- **Streaming Responses**: Real-time token delivery via SSE
- **Rate Limiting**: Protect API costs with per-client quotas
- **URL Sharing**: Encode/decode LMCIFY compressed messages

### Non-Functional Requirements
- **Latency**: < 500ms first token latency
- **Availability**: 99.9% uptime for API
- **Cost Efficiency**: Rate limiting to control Claude API spend
- **Security**: API key protection, input sanitization

### Scale Estimates
- **Daily Requests**: 10K-50K API calls
- **Message Size**: Average 50 characters per request
- **Response Size**: Average 200 tokens per response

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (Browser)                         │
└───────────────────────────────┬──────────────────────────────────┘
                                │ POST /api/chat (SSE Stream)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EDGE LAYER (Vercel Edge Functions)            │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ Rate Limiter │→ │ Input Valid. │→ │ Anthropic Proxy      │   │
│  │ (per-IP)     │  │ Sanitization │  │ (Stream Transform)   │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EXTERNAL (Anthropic Claude API)               │
│                       Claude Haiku 4.5                           │
│                    ~200ms first token latency                    │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dives

### 1. Edge Function Architecture

**Why Edge Runtime?**

Vercel Edge Functions run on Cloudflare's global network, reducing latency:

```
User (Tokyo) → Edge Function (Tokyo) → Claude API (US)
Total: ~250ms first token

vs.

User (Tokyo) → Node.js Function (US) → Claude API (US)
Total: ~400ms first token
```

**Edge Function Implementation:**

```typescript
// api/chat.ts
export const config = { runtime: 'edge' };

export default async function handler(req: Request) {
  // 1. Rate limiting check
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  const rateLimitResult = await checkRateLimit(ip);

  if (!rateLimitResult.allowed) {
    return new Response(
      JSON.stringify({
        error: 'Rate limited',
        retryAfter: rateLimitResult.resetIn
      }),
      { status: 429 }
    );
  }

  // 2. Parse and validate input
  const { message, requestId } = await req.json();

  if (!message || message.length > 500) {
    return new Response(
      JSON.stringify({ error: 'Invalid message' }),
      { status: 400 }
    );
  }

  // 3. Check idempotency (prevent duplicate processing)
  const cached = await kv.get(`request:${requestId}`);
  if (cached) {
    return new Response(cached, {
      headers: { 'Content-Type': 'text/event-stream' }
    });
  }

  // 4. Stream from Claude
  const stream = await anthropic.messages.stream({
    model: 'claude-3-haiku-20240307',
    max_tokens: 150,
    messages: [{ role: 'user', content: message }],
    system: CALCULATOR_SYSTEM_PROMPT
  });

  // 5. Return SSE stream
  return new Response(stream.toReadableStream(), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}
```

**Edge Runtime Constraints:**

| Capability | Available | Alternative |
|------------|-----------|-------------|
| Streaming | Yes | N/A |
| Node.js APIs | No | Web APIs only |
| Timeout | 30s (hobby) | Pro tier: 5min |
| Cold start | ~50ms | Node.js: ~300ms |
| File system | No | External storage |

### 2. Rate Limiting Strategy

**Token Bucket Implementation with Vercel KV:**

```typescript
interface RateLimitConfig {
  tokensPerMinute: number;
  tokensPerDay: number;
  refillRatePerSecond: number;
}

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  anonymous: {
    tokensPerMinute: 10,
    tokensPerDay: 100,
    refillRatePerSecond: 0.17  // 10 per minute
  }
};

async function checkRateLimit(ip: string): Promise<{
  allowed: boolean;
  remaining: number;
  resetIn: number;
}> {
  const hashedIp = await hashIP(ip);  // Privacy
  const key = `ratelimit:${hashedIp}`;

  const now = Date.now();
  const bucket = await kv.get<TokenBucket>(key) || {
    tokens: RATE_LIMITS.anonymous.tokensPerMinute,
    lastRefill: now,
    dailyCount: 0,
    dayStart: now
  };

  // Check daily limit
  if (now - bucket.dayStart > 86400000) {
    bucket.dailyCount = 0;
    bucket.dayStart = now;
  }

  if (bucket.dailyCount >= RATE_LIMITS.anonymous.tokensPerDay) {
    return {
      allowed: false,
      remaining: 0,
      resetIn: 86400000 - (now - bucket.dayStart)
    };
  }

  // Refill tokens based on elapsed time
  const elapsed = (now - bucket.lastRefill) / 1000;
  const refill = elapsed * RATE_LIMITS.anonymous.refillRatePerSecond;
  bucket.tokens = Math.min(
    RATE_LIMITS.anonymous.tokensPerMinute,
    bucket.tokens + refill
  );
  bucket.lastRefill = now;

  // Check and consume token
  if (bucket.tokens < 1) {
    return {
      allowed: false,
      remaining: Math.floor(bucket.tokens),
      resetIn: Math.ceil((1 - bucket.tokens) / RATE_LIMITS.anonymous.refillRatePerSecond * 1000)
    };
  }

  bucket.tokens -= 1;
  bucket.dailyCount += 1;

  await kv.set(key, bucket, { ex: 86400 });  // 24h expiry

  return {
    allowed: true,
    remaining: Math.floor(bucket.tokens),
    resetIn: 0
  };
}
```

**Rate Limit Headers:**

```typescript
function addRateLimitHeaders(response: Response, result: RateLimitResult): Response {
  response.headers.set('X-RateLimit-Remaining', String(result.remaining));
  response.headers.set('X-RateLimit-Reset', String(result.resetIn));
  return response;
}
```

### 3. SSE Streaming Implementation

**Server-Side Stream Transformation:**

```typescript
function createSSEStream(anthropicStream: AsyncIterable<MessageStreamEvent>) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        let fullResponse = '';

        for await (const event of anthropicStream) {
          if (event.type === 'content_block_delta') {
            const text = event.delta.text;
            fullResponse += text;

            // Format as SSE event
            const sseEvent = `data: ${JSON.stringify({
              type: 'delta',
              text: text
            })}\n\n`;

            controller.enqueue(encoder.encode(sseEvent));
          }
        }

        // Parse final response for key sequences
        const parsed = parseCalculatorResponse(fullResponse);

        // Send completion event with parsed keys
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            type: 'complete',
            keys: parsed.keys,
            explanation: parsed.explanation
          })}\n\n`
        ));

        controller.close();
      } catch (error) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            type: 'error',
            message: 'Stream processing failed'
          })}\n\n`
        ));
        controller.close();
      }
    }
  });
}
```

**Response Parsing:**

```typescript
interface CalculatorResponse {
  keys: string[];
  explanation: string;
}

function parseCalculatorResponse(response: string): CalculatorResponse {
  // Try to extract JSON from response
  const jsonMatch = response.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        keys: Array.isArray(parsed.keys) ? parsed.keys : [],
        explanation: parsed.explanation || ''
      };
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: extract numbers and operators from text
  return {
    keys: extractKeysFromText(response),
    explanation: response
  };
}
```

### 4. Prompt Engineering for Structured Output

**System Prompt Design:**

```typescript
const CALCULATOR_SYSTEM_PROMPT = `You control a Casio calculator. Convert math requests to key sequences.

Available keys: 0-9, +, -, ×, ÷, %, √, =, C, AC, M+, M-, MR, MC, ±, .

Rules:
- Numbers as individual digits: ["1", "2", "3"] not ["123"]
- Always end calculations with "="
- Use "C" for clear current, "AC" for all-clear
- Percentage: "15% of 80" = ["8", "0", "×", "1", "5", "%", "="]
- Square root: "sqrt of 16" = ["1", "6", "√"]

Output ONLY valid JSON:
{
  "keys": ["8", "0", "×", "1", "5", "%", "="],
  "explanation": "80 × 15% = 12"
}`;
```

**Why This Prompt Works:**

| Element | Purpose |
|---------|---------|
| Role assignment | "You control a Casio calculator" - sets context |
| Available actions | Explicit key list prevents hallucination |
| Rules with examples | Shows expected format for edge cases |
| Output constraint | "Output ONLY valid JSON" enforces structure |

### 5. Idempotency and Request Deduplication

**Idempotency Key Handling:**

```typescript
interface ChatRequest {
  message: string;
  requestId: string;      // Client-generated UUID
  timestamp: number;
}

async function handleWithIdempotency(
  req: ChatRequest
): Promise<Response> {
  const cacheKey = `request:${req.requestId}`;

  // Check for cached response
  const cached = await kv.get<string>(cacheKey);
  if (cached) {
    // Return cached response (replay)
    return new Response(cached, {
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotent-Replay': 'true'
      }
    });
  }

  // Process request
  const response = await processChat(req.message);

  // Cache response for 5 minutes
  await kv.set(cacheKey, JSON.stringify(response), { ex: 300 });

  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

**Client-Side Key Generation:**

```typescript
function generateIdempotencyKey(message: string): string {
  const sessionId = getSessionId();
  const timestamp = Date.now();
  const messageHash = simpleHash(message);
  return `${sessionId}-${timestamp}-${messageHash}`;
}
```

### 6. Circuit Breaker for Claude API

**Implementation:**

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

  private readonly config = {
    failureThreshold: 5,
    resetTimeoutMs: 30000,
    halfOpenRequests: 3
  };

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.config.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
      } else {
        throw new CircuitOpenError('Circuit breaker is open');
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

    if (this.failures >= this.config.failureThreshold) {
      this.state = CircuitState.OPEN;
      console.log(`Circuit breaker OPEN after ${this.failures} failures`);
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

const claudeCircuitBreaker = new CircuitBreaker();
```

**Graceful Degradation:**

```typescript
async function getAIResponse(message: string): Promise<AIResponse> {
  try {
    return await claudeCircuitBreaker.execute(
      () => callClaudeAPI(message)
    );
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      return {
        message: 'AI assistant temporarily unavailable. Calculator still works!',
        keys: [],
        explanation: 'Circuit breaker active - try again in 30 seconds'
      };
    }
    throw error;
  }
}
```

### 7. Observability

**Key Metrics:**

| Metric | Type | Description | Alert Threshold |
|--------|------|-------------|-----------------|
| `ai_request_duration_ms` | Histogram | End-to-end latency | p95 > 1000ms |
| `ai_first_token_ms` | Histogram | Time to first token | p95 > 500ms |
| `ai_request_errors` | Counter | Failed requests | > 5 in 5 minutes |
| `rate_limit_hits` | Counter | Rate limited requests | > 100/hour |
| `circuit_breaker_state` | Gauge | 0=closed, 1=half, 2=open | state = 2 |

**Structured Logging:**

```typescript
interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  service: 'edge-function';
  requestId: string;
  event: string;
  metadata: Record<string, unknown>;
}

function log(entry: Omit<LogEntry, 'timestamp'>): void {
  console.log(JSON.stringify({
    ...entry,
    timestamp: new Date().toISOString()
  }));
}

// Usage
log({
  level: 'info',
  service: 'edge-function',
  requestId: req.requestId,
  event: 'ai_request_complete',
  metadata: {
    duration_ms: Date.now() - startTime,
    tokens_used: response.usage?.total_tokens,
    model: 'claude-3-haiku'
  }
});
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Compute | Edge Functions | Node.js | 50ms cold start vs 300ms |
| AI Model | Claude Haiku | GPT-3.5 | Faster, cheaper, better structured output |
| Streaming | SSE | WebSocket | Simpler for one-way, works with serverless |
| Rate limiting | Token bucket (KV) | Sliding window | Smoother bursting |
| Caching | Vercel KV | Redis | Native integration, edge-accessible |
| Idempotency | Request ID + KV | None | Prevents duplicate API charges |

## Future Enhancements

1. **Response Caching**: Cache common calculations (e.g., "15% of 100") to reduce API calls
2. **Multi-Region KV**: Replicate rate limit state across regions for global consistency
3. **Request Batching**: Combine multiple quick requests into single API call
4. **Model Fallback**: Fall back to GPT-3.5 if Claude is unavailable
5. **Usage Analytics**: Track popular queries for optimization opportunities
