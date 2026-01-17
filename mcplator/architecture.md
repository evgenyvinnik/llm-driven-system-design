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

## Future Optimizations

- [ ] WebSocket for bidirectional chat
- [ ] Voice input support
- [ ] Calculation history
- [ ] Multiple calculator themes
- [ ] Scientific calculator mode
- [ ] Unit conversions
