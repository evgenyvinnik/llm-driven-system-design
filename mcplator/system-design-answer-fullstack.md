# MCPlator - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Problem Statement

Design MCPlator, a retro calculator with an LLM-powered AI co-pilot. The full-stack challenge involves integrating a React frontend with edge functions, coordinating real-time streaming between client and server, and building a cohesive system where natural language translates to synchronized UI actions.

## Requirements Clarification

### Functional Requirements
- **Calculator**: Full Casio-style functionality (memory, percentage, sqrt)
- **AI Chat**: Natural language to calculator operations with streaming
- **Animation**: Key presses animate as AI executes calculations
- **Sharing**: URL-based sharing of calculations (LMCIFY)
- **Persistence**: Remember calculator state and chat history

### Non-Functional Requirements
- **First Token Latency**: < 500ms
- **Animation Performance**: 60 FPS key animations
- **Offline Degradation**: Calculator works without network
- **Cost Efficiency**: Rate limiting for API usage

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (Browser)                         │
├─────────────────────────────────────────────────────────────────┤
│   ┌────────────────────┐      ┌─────────────────────────────┐   │
│   │  Calculator Panel  │◀────▶│      Chat Panel             │   │
│   │  - LCD Display     │ Keys │  - Message History          │   │
│   │  - Keypad Grid     │      │  - Streaming Input          │   │
│   └────────────────────┘      └─────────────────────────────┘   │
│            │                              │                      │
│            ▼                              ▼                      │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │              Zustand State Store + IndexedDB              │  │
│   └──────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬──────────────────────────────────┘
                                │ SSE Stream
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EDGE (Vercel Edge Functions)                  │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│   │ Rate Limiter │→ │ Input Valid. │→ │ Claude API Proxy     │  │
│   └──────────────┘  └──────────────┘  └──────────────────────┘  │
└───────────────────────────────┬──────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EXTERNAL (Anthropic Claude API)               │
│                       Claude Haiku 4.5                           │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dives

### 1. Shared TypeScript Types

**API Contract Overview:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                         API TYPE CONTRACTS                                 │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ChatRequest:                                                              │
│  ├── message: string                                                       │
│  ├── requestId: string (idempotency key)                                   │
│  └── context?: { currentDisplay, memory }                                  │
│                                                                            │
│  ChatResponse:                                                             │
│  ├── keys: string[]                                                        │
│  └── explanation: string                                                   │
│                                                                            │
│  SSEEvent (union type):                                                    │
│  ├── { type: 'delta', text: string }                                       │
│  ├── { type: 'complete', keys: string[], explanation: string }             │
│  └── { type: 'error', message: string, code: string }                      │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

**Calculator Key Types:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                       CALCULATOR KEY TYPES                                 │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  DigitKey:     '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'  │
│  OperatorKey:  '+' | '-' | '×' | '÷'                                       │
│  FunctionKey:  '%' | '√' | '±' | '.' | '=' | 'C' | 'AC'                   │
│  MemoryKey:    'M+' | 'M-' | 'MR' | 'MC'                                   │
│                                                                            │
│  CalculatorKey = DigitKey | OperatorKey | FunctionKey | MemoryKey         │
│                                                                            │
│  isValidKey(key: string): key is CalculatorKey                             │
│  └── Validates against known key set                                       │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

**State Types:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          STATE TYPES                                       │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  CalculatorState:                                                          │
│  ├── display: string                                                       │
│  ├── accumulator: number                                                   │
│  ├── pendingOperation: OperatorKey | null                                  │
│  ├── memory: number                                                        │
│  └── state: 'READY' | 'ENTERING' | 'PENDING_OP' | 'RESULT' | 'ERROR'      │
│                                                                            │
│  ChatMessage:                                                              │
│  ├── id: string                                                            │
│  ├── role: 'user' | 'assistant'                                            │
│  ├── content: string                                                       │
│  ├── keys?: CalculatorKey[]                                                │
│  ├── timestamp: Date                                                       │
│  └── status: 'sending' | 'streaming' | 'complete' | 'error'               │
│                                                                            │
│  QuotaState:                                                               │
│  ├── date: string (YYYY-MM-DD)                                             │
│  ├── remaining: number                                                     │
│  └── limit: number                                                         │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2. End-to-End Request Flow

**Client-Side Streaming Flow:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    CLIENT SSE STREAMING                                    │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  streamChatResponse(message, context):                                     │
│                                                                            │
│  1. Generate idempotency key from message hash                             │
│                                                                            │
│  2. POST /api/chat with:                                                   │
│     ├── Content-Type: application/json                                     │
│     ├── Idempotency-Key: {requestId}                                       │
│     └── Body: { message, requestId, context }                              │
│                                                                            │
│  3. If !response.ok:                                                       │
│     └── yield { type: 'error', message, code }                             │
│                                                                            │
│  4. Stream parsing loop:                                                   │
│     ┌─────────────────────────────────────────┐                           │
│     │  reader.read() ──▶ decoder.decode()     │                           │
│     │        │                                │                           │
│     │        ▼                                │                           │
│     │  buffer += chunk                        │                           │
│     │        │                                │                           │
│     │        ▼                                │                           │
│     │  split('\n\n') ──▶ parse 'data:' lines │                           │
│     │        │                                │                           │
│     │        ▼                                │                           │
│     │  yield SSEEvent for each complete event │                           │
│     │        │                                │                           │
│     │        └── keep incomplete in buffer    │                           │
│     └─────────────────────────────────────────┘                           │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

**Edge Function Handler Flow:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    EDGE FUNCTION PIPELINE                                  │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Request ──▶ Step 1: Rate Limiting                                        │
│              ├── Extract IP from x-forwarded-for                           │
│              ├── Check rate limit quota                                    │
│              └── If exceeded: 429 + Retry-After header                     │
│                      │                                                     │
│                      ▼                                                     │
│              Step 2: Input Validation                                      │
│              ├── Parse JSON body as ChatRequest                            │
│              ├── Validate message exists and < 500 chars                   │
│              └── If invalid: 400 + error message                           │
│                      │                                                     │
│                      ▼                                                     │
│              Step 3: Idempotency Check                                     │
│              ├── GET kv:`request:{idempotencyKey}`                         │
│              └── If cached: return cached response                         │
│                      │                                                     │
│                      ▼                                                     │
│              Step 4: Build Context-Aware Prompt                            │
│              ├── Add calculator context (display, memory)                  │
│              └── Append to user message                                    │
│                      │                                                     │
│                      ▼                                                     │
│              Step 5: Stream from Claude                                    │
│              ├── anthropic.messages.stream()                               │
│              ├── model: claude-3-haiku-20240307                            │
│              └── max_tokens: 150                                           │
│                      │                                                     │
│                      ▼                                                     │
│              Step 6: Transform to SSE                                      │
│              ├── Content-Type: text/event-stream                           │
│              ├── Cache-Control: no-cache                                   │
│              └── X-RateLimit-Remaining header                              │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

**SSE Stream Transformation:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    SSE STREAM CREATION                                     │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  createSSEStream(anthropicStream) → ReadableStream:                        │
│                                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  For each event in anthropicStream:                                  │  │
│  │                                                                      │  │
│  │  If content_block_delta:                                             │  │
│  │  ├── fullResponse += delta.text                                      │  │
│  │  └── enqueue: data: {"type":"delta","text":"..."}\n\n               │  │
│  │                                                                      │  │
│  │  On stream complete:                                                 │  │
│  │  ├── parseCalculatorResponse(fullResponse)                           │  │
│  │  └── enqueue: data: {"type":"complete","keys":[...],...}\n\n        │  │
│  │                                                                      │  │
│  │  On error:                                                           │  │
│  │  └── enqueue: data: {"type":"error","message":"...","code":"..."}\n\n│  │
│  │                                                                      │  │
│  │  Finally: controller.close()                                         │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3. Calculator State Synchronization

**AI-Driven Calculator Hook:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    useAICalculator HOOK                                    │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  State:                                                                    │
│  ├── isProcessing: boolean                                                 │
│  └── Uses: calculatorStore, animationStore, chatStore                     │
│                                                                            │
│  sendCalculation(input):                                                   │
│                                                                            │
│  1. Guard: if isProcessing, return early                                   │
│                                                                            │
│  2. Add user message to chat (status: complete)                            │
│                                                                            │
│  3. Add AI placeholder message (status: streaming)                         │
│                                                                            │
│  4. Stream response loop:                                                  │
│     ┌────────────────────────────────────────────────────────────────┐    │
│     │  For await (event of streamChatResponse):                       │    │
│     │                                                                 │    │
│     │  ├── 'delta': Update message content progressively              │    │
│     │  │                                                              │    │
│     │  ├── 'complete':                                                │    │
│     │  │   ├── Update message with final content + keys               │    │
│     │  │   └── await animateKeys(event.keys)                          │    │
│     │  │                                                              │    │
│     │  └── 'error': Update message status to error                    │    │
│     └────────────────────────────────────────────────────────────────┘    │
│                                                                            │
│  5. Finally: setIsProcessing(false)                                        │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

**Coordinated Animation Store:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    ANIMATION STORE                                         │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  State:                                                                    │
│  ├── activeKey: CalculatorKey | null                                       │
│  ├── queue: CalculatorKey[]                                                │
│  └── isAnimating: boolean                                                  │
│                                                                            │
│  animateKeySequence(keys):                                                 │
│                                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  For each key in keys:                                               │  │
│  │                                                                      │  │
│  │  1. Visual: set({ activeKey: key }) ──▶ CSS highlight               │  │
│  │                                                                      │  │
│  │  2. Wait: getAnimationDelay(key)                                     │  │
│  │     ├── '=' : 250ms (dramatic pause)                                 │  │
│  │     ├── operators: 180ms                                             │  │
│  │     └── digits: 120ms                                                │  │
│  │                                                                      │  │
│  │  3. Logic: calculatorStore.pressKey(key)                             │  │
│  │                                                                      │  │
│  │  4. Visual: set({ activeKey: null })                                 │  │
│  │                                                                      │  │
│  │  5. Brief pause: 50ms between keys                                   │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  set({ isAnimating: false, queue: [] })                                    │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

### 4. Prompt Engineering with Context

**System Prompt Structure:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    CALCULATOR SYSTEM PROMPT                                │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Role: "You control a Casio calculator. Convert math requests to key      │
│         sequences."                                                        │
│                                                                            │
│  Available Keys:                                                           │
│  ├── Digits: 0-9                                                           │
│  ├── Operators: +, -, ×, ÷                                                 │
│  ├── Functions: %, √, =, C, AC                                             │
│  └── Memory: M+, M-, MR, MC, ±, .                                          │
│                                                                            │
│  Rules:                                                                    │
│  ├── Numbers as individual digits: ["1", "2", "3"] not ["123"]             │
│  ├── Always end calculations with "="                                      │
│  ├── Use "C" for clear current, "AC" for all-clear                         │
│  └── Examples provided for percentage and sqrt                             │
│                                                                            │
│  Output Format:                                                            │
│  └── ONLY valid JSON: { "keys": [...], "explanation": "..." }              │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

**Context Injection:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    CONTEXT-AWARE MESSAGE BUILDING                          │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Input: ChatRequest { message, context }                                   │
│                                                                            │
│  If context provided:                                                      │
│                                                                            │
│  message + "\n\n[Calculator Context]\n"                                    │
│          + "Current display: {currentDisplay}\n"                           │
│          + "Memory register: {memory}\n\n"                                 │
│          + "If the display already shows a number I need,                  │
│             I can use it directly."                                        │
│                                                                            │
│  Benefits:                                                                 │
│  ├── AI can skip redundant key presses                                     │
│  ├── Memory operations aware of current state                              │
│  └── Smarter continuation of previous calculations                         │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5. Error Handling Across Stack

**Unified Error Types:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    ERROR TYPE SYSTEM                                       │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ErrorCode enum:                                                           │
│  ├── RATE_LIMITED   - Too many requests                                    │
│  ├── INVALID_REQUEST - Bad input validation                                │
│  ├── AI_ERROR       - Claude API failure                                   │
│  ├── STREAM_ERROR   - SSE parsing failure                                  │
│  └── NETWORK_ERROR  - Connection issues                                    │
│                                                                            │
│  AppError:                                                                 │
│  ├── code: ErrorCode                                                       │
│  ├── message: string                                                       │
│  ├── retryAfter?: number                                                   │
│  └── recoverable: boolean                                                  │
│                                                                            │
│  Recoverable errors:                                                       │
│  └── RATE_LIMITED, AI_ERROR, NETWORK_ERROR                                 │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

**Error Boundary Pattern:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    CHAT ERROR BOUNDARY                                     │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ChatErrorBoundary (React Component):                                      │
│                                                                            │
│  State: { hasError: boolean, error?: Error }                               │
│                                                                            │
│  getDerivedStateFromError(error):                                          │
│  └── return { hasError: true, error }                                      │
│                                                                            │
│  componentDidCatch(error, info):                                           │
│  └── console.error for debugging                                           │
│                                                                            │
│  Render when hasError:                                                     │
│  ┌─────────────────────────────────────────┐                              │
│  │  "Chat is temporarily unavailable."     │                              │
│  │  "The calculator still works normally." │                              │
│  │  [Try Again] button                     │                              │
│  └─────────────────────────────────────────┘                              │
│                                                                            │
│  Key: Calculator works offline even if chat fails                          │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

### 6. Quota Management (Full Stack)

**Backend Rate Limiting:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    TOKEN BUCKET RATE LIMITING                              │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Limits:                                                                   │
│  ├── tokensPerMinute: 10                                                   │
│  ├── tokensPerDay: 100                                                     │
│  └── refillRate: 0.17 tokens/second                                        │
│                                                                            │
│  QuotaBucket (per IP):                                                     │
│  ├── minuteTokens: number (0-10)                                           │
│  ├── dailyCount: number (0-100)                                            │
│  ├── lastRefill: timestamp                                                 │
│  └── dayStart: timestamp                                                   │
│                                                                            │
│  checkRateLimit(ip) flow:                                                  │
│                                                                            │
│  1. Hash IP for privacy                                                    │
│  2. GET kv:`quota:{hashedIp}`                                              │
│  3. Reset daily count if new day                                           │
│  4. Check daily limit (100/day)                                            │
│  5. Refill minute tokens based on elapsed time                             │
│  6. Check minute limit (10/min burst)                                      │
│  7. Consume 1 token, increment daily count                                 │
│  8. SET kv with 24h TTL                                                    │
│                                                                            │
│  Returns: { allowed, remaining, resetIn }                                  │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

**Frontend Quota Display:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    QUOTA INDICATOR COMPONENT                               │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  Props from chatStore.quota:                                               │
│  ├── remaining: number                                                     │
│  └── limit: number                                                         │
│                                                                            │
│  Display:                                                                  │
│  ┌─────────────────────────────────────────┐                              │
│  │  ████████████░░░░░░░░░  75%             │                              │
│  │  75 / 100 requests today                │                              │
│  └─────────────────────────────────────────┘                              │
│                                                                            │
│  Visual feedback prevents user frustration                                 │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

### 7. LMCIFY Sharing Integration

**URL Encoding/Decoding:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    LMCIFY COMPRESSION                                      │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  encodeMessage(message):                                                   │
│  ├── 1. TextEncoder().encode(message)                                      │
│  ├── 2. pako.gzip(bytes)                                                   │
│  ├── 3. btoa(String.fromCharCode(...compressed))                           │
│  └── 4. URL-safe: replace +/= with -_                                      │
│                                                                            │
│  decodeMessage(encoded):                                                   │
│  ├── 1. Restore base64: -_ → +/                                            │
│  ├── 2. atob() to binary                                                   │
│  ├── 3. Uint8Array.from(binary)                                            │
│  ├── 4. pako.ungzip(bytes)                                                 │
│  └── 5. TextDecoder().decode()                                             │
│                                                                            │
│  Why gzip?                                                                 │
│  └── URL length limit ~2000 chars requires compression                     │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

**Share Flow:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    SHARE BUTTON FLOW                                       │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  handleShare():                                                            │
│                                                                            │
│  1. const encoded = encodeMessage(message)                                 │
│                                                                            │
│  2. const url = `${origin}/?lmcify=${encoded}`                             │
│                                                                            │
│  3. If navigator.share available (mobile):                                 │
│     └── navigator.share({ title, text: message, url })                     │
│                                                                            │
│  4. Else (desktop):                                                        │
│     ├── navigator.clipboard.writeText(url)                                 │
│     ├── setCopied(true)                                                    │
│     └── setTimeout → setCopied(false), 2000ms                              │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

**Auto-Play on Load:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    LMCIFY AUTO-PLAY                                        │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  useEffect on App mount:                                                   │
│                                                                            │
│  1. Parse URL: new URLSearchParams(location.search)                        │
│                                                                            │
│  2. Get lmcify param                                                       │
│                                                                            │
│  3. If present:                                                            │
│     ├── Try decode message                                                 │
│     ├── Clean URL: history.replaceState({}, '', '/')                       │
│     └── setTimeout(500ms) → sendCalculation(message)                       │
│                                                                            │
│  4. On decode error:                                                       │
│     └── console.error('Invalid LMCIFY link')                               │
│                                                                            │
│  Result: Shared link auto-animates the calculation                         │
│                                                                            │
└───────────────────────────────────────────────────────────────────────────┘
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| **API Layer** | Edge Functions | Node.js | Lower latency, simpler deployment |
| **Streaming** | SSE | WebSocket | Sufficient for one-way, works with serverless |
| **State Sync** | Zustand | Context + Reducer | Simpler cross-component coordination |
| **Type Sharing** | Shared types file | OpenAPI/GraphQL | Simpler for small API surface |
| **Persistence** | IndexedDB | Server-side DB | No auth needed, privacy-preserving |
| **Compression** | pako (gzip) | None | Keeps URLs short for sharing |

## Performance Metrics

| Metric | Target | Achieved |
|--------|--------|----------|
| AI First Token | < 500ms | ~250ms |
| Key Animation FPS | 60 | 60 |
| Bundle Size (gzipped) | < 200KB | ~180KB |
| Lighthouse Score | > 90 | 95 |

## Future Enhancements

1. **WebSocket Upgrade**: For bidirectional real-time features (collaborative calculations)
2. **Server-Side History**: Optional account system for cross-device sync
3. **Calculation Caching**: Cache common calculations to reduce API costs
4. **OpenAPI Schema**: Formalize API contract for larger team
5. **Analytics Integration**: Track popular queries for optimization
6. **Multi-Model Support**: Fall back to alternative LLMs if Claude is unavailable

## Summary

"For MCPlator, the full-stack challenge was coordinating three layers:

1. **Edge Functions**: Minimal latency proxy to Claude with rate limiting and idempotency
2. **SSE Streaming**: Progressive response delivery enabling real-time UI updates
3. **Synchronized Animation**: Visual key presses that match AI-determined sequences

The key insight is that LLMs excel at translating ambiguous natural language into deterministic action sequences. By treating the calculator as a state machine and the AI as an intent parser, we create an intuitive interface where users can say 'what's 15% of 80' and watch the calculator animate the exact key presses.

Critical trade-off: SSE over WebSocket for simplicity with serverless. Edge functions have connection limits that make WebSocket impractical, but SSE provides sufficient streaming for our one-way data flow."
