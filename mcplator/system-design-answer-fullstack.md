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

**API Contract Definitions:**

```typescript
// types/api.ts
export interface ChatRequest {
  message: string;
  requestId: string;  // Idempotency key
  context?: {
    currentDisplay: string;
    memory: number;
  };
}

export interface ChatResponse {
  keys: string[];
  explanation: string;
}

export type SSEEvent =
  | { type: 'delta'; text: string }
  | { type: 'complete'; keys: string[]; explanation: string }
  | { type: 'error'; message: string; code: string };

// Calculator key types
export type DigitKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
export type OperatorKey = '+' | '-' | '×' | '÷';
export type FunctionKey = '%' | '√' | '±' | '.' | '=' | 'C' | 'AC';
export type MemoryKey = 'M+' | 'M-' | 'MR' | 'MC';
export type CalculatorKey = DigitKey | OperatorKey | FunctionKey | MemoryKey;

// Validate key is valid calculator key
export function isValidKey(key: string): key is CalculatorKey {
  const validKeys = [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    '+', '-', '×', '÷',
    '%', '√', '±', '.', '=', 'C', 'AC',
    'M+', 'M-', 'MR', 'MC'
  ];
  return validKeys.includes(key);
}
```

**State Types:**

```typescript
// types/state.ts
export interface CalculatorState {
  display: string;
  accumulator: number;
  pendingOperation: OperatorKey | null;
  memory: number;
  state: 'READY' | 'ENTERING' | 'PENDING_OP' | 'RESULT' | 'ERROR';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  keys?: CalculatorKey[];
  timestamp: Date;
  status: 'sending' | 'streaming' | 'complete' | 'error';
}

export interface QuotaState {
  date: string;  // YYYY-MM-DD
  remaining: number;
  limit: number;
}
```

### 2. End-to-End Request Flow

**Client-Side Request Initiation:**

```typescript
// services/chatService.ts
import { generateIdempotencyKey } from '../lib/idempotency';
import type { ChatRequest, SSEEvent } from '../types/api';

export async function* streamChatResponse(
  message: string,
  context?: ChatRequest['context']
): AsyncGenerator<SSEEvent> {
  const requestId = generateIdempotencyKey(message);

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': requestId
    },
    body: JSON.stringify({ message, requestId, context })
  });

  if (!response.ok) {
    const error = await response.json();
    yield { type: 'error', message: error.message, code: error.code };
    return;
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events from buffer
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      if (!event.startsWith('data: ')) continue;

      try {
        const data = JSON.parse(event.slice(6)) as SSEEvent;
        yield data;
      } catch (e) {
        console.error('Failed to parse SSE event:', event);
      }
    }
  }
}
```

**Edge Function Handler:**

```typescript
// api/chat.ts
import Anthropic from '@anthropic-ai/sdk';
import { checkRateLimit } from '../lib/rateLimit';
import { CALCULATOR_SYSTEM_PROMPT } from '../lib/prompts';
import type { ChatRequest } from '../types/api';

export const config = { runtime: 'edge' };

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

export default async function handler(req: Request) {
  // 1. Rate limiting
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  const rateLimit = await checkRateLimit(ip);

  if (!rateLimit.allowed) {
    return new Response(
      JSON.stringify({
        code: 'RATE_LIMITED',
        message: 'Too many requests. Try again later.',
        retryAfter: rateLimit.resetIn
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil(rateLimit.resetIn / 1000))
        }
      }
    );
  }

  // 2. Parse and validate request
  const body = await req.json() as ChatRequest;

  if (!body.message || body.message.length > 500) {
    return new Response(
      JSON.stringify({
        code: 'INVALID_REQUEST',
        message: 'Message is required and must be under 500 characters'
      }),
      { status: 400 }
    );
  }

  // 3. Check idempotency (optional caching)
  const idempotencyKey = req.headers.get('Idempotency-Key');
  if (idempotencyKey) {
    const cached = await kv.get(`request:${idempotencyKey}`);
    if (cached) {
      return new Response(cached, {
        headers: {
          'Content-Type': 'text/event-stream',
          'X-Idempotent-Replay': 'true'
        }
      });
    }
  }

  // 4. Build context-aware prompt
  const userMessage = buildUserMessage(body);

  // 5. Stream from Claude
  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-3-haiku-20240307',
      max_tokens: 150,
      system: CALCULATOR_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });

    // 6. Transform to SSE
    const sseStream = createSSEStream(stream);

    return new Response(sseStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-RateLimit-Remaining': String(rateLimit.remaining)
      }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        code: 'AI_ERROR',
        message: 'AI service unavailable'
      }),
      { status: 503 }
    );
  }
}

function buildUserMessage(request: ChatRequest): string {
  let message = request.message;

  if (request.context) {
    message += `\n\nCurrent calculator state:
- Display: ${request.context.currentDisplay}
- Memory: ${request.context.memory}`;
  }

  return message;
}
```

**SSE Stream Transformation:**

```typescript
// lib/sseStream.ts
import type { SSEEvent } from '../types/api';

export function createSSEStream(
  anthropicStream: AsyncIterable<MessageStreamEvent>
): ReadableStream {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      let fullResponse = '';

      try {
        for await (const event of anthropicStream) {
          if (event.type === 'content_block_delta') {
            const text = event.delta.text;
            fullResponse += text;

            const sseEvent: SSEEvent = { type: 'delta', text };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(sseEvent)}\n\n`)
            );
          }
        }

        // Parse complete response
        const parsed = parseCalculatorResponse(fullResponse);

        const completeEvent: SSEEvent = {
          type: 'complete',
          keys: parsed.keys,
          explanation: parsed.explanation
        };

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(completeEvent)}\n\n`)
        );
      } catch (error) {
        const errorEvent: SSEEvent = {
          type: 'error',
          message: 'Stream processing failed',
          code: 'STREAM_ERROR'
        };

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`)
        );
      }

      controller.close();
    }
  });
}
```

### 3. Calculator State Synchronization

**React Hook for AI-Driven Calculations:**

```typescript
// hooks/useAICalculator.ts
import { useCallback, useState } from 'react';
import { useCalculatorStore } from '../stores/calculatorStore';
import { useAnimationStore } from '../stores/animationStore';
import { useChatStore } from '../stores/chatStore';
import { streamChatResponse } from '../services/chatService';
import type { SSEEvent, ChatMessage } from '../types';

export function useAICalculator() {
  const [isProcessing, setIsProcessing] = useState(false);

  const calculatorState = useCalculatorStore((s) => ({
    display: s.display,
    memory: s.memory
  }));

  const animateKeys = useAnimationStore((s) => s.animateKeySequence);

  const { addMessage, updateMessage } = useChatStore();

  const sendCalculation = useCallback(async (input: string) => {
    if (isProcessing) return;
    setIsProcessing(true);

    // Add user message
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      timestamp: new Date(),
      status: 'complete'
    };
    addMessage(userMessage);

    // Add placeholder AI message
    const aiMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      status: 'streaming'
    };
    addMessage(aiMessage);

    try {
      let fullContent = '';

      for await (const event of streamChatResponse(input, {
        currentDisplay: calculatorState.display,
        memory: calculatorState.memory
      })) {
        switch (event.type) {
          case 'delta':
            fullContent += event.text;
            updateMessage(aiMessage.id, {
              content: fullContent
            });
            break;

          case 'complete':
            updateMessage(aiMessage.id, {
              content: fullContent,
              keys: event.keys,
              status: 'complete'
            });

            // Animate key presses
            if (event.keys.length > 0) {
              await animateKeys(event.keys);
            }
            break;

          case 'error':
            updateMessage(aiMessage.id, {
              content: event.message,
              status: 'error'
            });
            break;
        }
      }
    } catch (error) {
      updateMessage(aiMessage.id, {
        content: 'Failed to get AI response',
        status: 'error'
      });
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, calculatorState, addMessage, updateMessage, animateKeys]);

  return { sendCalculation, isProcessing };
}
```

**Coordinated Animation Flow:**

```typescript
// stores/animationStore.ts
import { create } from 'zustand';
import { useCalculatorStore } from './calculatorStore';
import type { CalculatorKey } from '../types';

interface AnimationState {
  activeKey: CalculatorKey | null;
  queue: CalculatorKey[];
  isAnimating: boolean;
}

interface AnimationActions {
  animateKeySequence: (keys: CalculatorKey[]) => Promise<void>;
}

export const useAnimationStore = create<AnimationState & AnimationActions>(
  (set) => ({
    activeKey: null,
    queue: [],
    isAnimating: false,

    animateKeySequence: async (keys) => {
      set({ isAnimating: true, queue: keys });

      const calculator = useCalculatorStore.getState();

      for (const key of keys) {
        // Visual: highlight key
        set({ activeKey: key });

        // Wait based on key type
        await delay(getAnimationDelay(key));

        // Logic: execute key press
        calculator.pressKey(key);

        // Visual: clear highlight
        set({ activeKey: null });

        // Brief pause between keys
        await delay(50);
      }

      set({ isAnimating: false, queue: [] });
    }
  })
);

function getAnimationDelay(key: CalculatorKey): number {
  if (key === '=') return 250;  // Dramatic pause
  if ('+-×÷'.includes(key)) return 180;
  return 120;
}
```

### 4. Prompt Engineering with Context

**System Prompt:**

```typescript
// lib/prompts.ts
export const CALCULATOR_SYSTEM_PROMPT = `You control a Casio calculator. Convert math requests to key sequences.

Available keys: 0-9, +, -, ×, ÷, %, √, =, C, AC, M+, M-, MR, MC, ±, .

Rules:
- Numbers as individual digits: ["1", "2", "3"] not ["123"]
- Always end calculations with "="
- Use "C" for clear current, "AC" for all-clear
- Percentage example: "15% of 80" = ["8", "0", "×", "1", "5", "%", "="]
- Square root example: "sqrt of 16" = ["1", "6", "√"]
- For memory operations:
  - M+ adds display to memory
  - M- subtracts display from memory
  - MR recalls memory to display
  - MC clears memory

If the current display shows a value you need, use it (don't clear unnecessarily).

Output ONLY valid JSON:
{
  "keys": ["8", "0", "×", "1", "5", "%", "="],
  "explanation": "80 × 15% = 12"
}`;
```

**Context-Aware Prompts:**

```typescript
// Edge function builds context-aware message
function buildUserMessage(request: ChatRequest): string {
  let message = request.message;

  // Add calculator context for smarter responses
  if (request.context) {
    message += `\n\n[Calculator Context]
Current display: ${request.context.currentDisplay}
Memory register: ${request.context.memory}

If the display already shows a number I need, I can use it directly.`;
  }

  return message;
}
```

### 5. Error Handling Across Stack

**Frontend Error Boundary:**

```tsx
// components/ErrorBoundary.tsx
interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class ChatErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Chat error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.errorContainer}>
          <p>Chat is temporarily unavailable.</p>
          <p>The calculator still works normally.</p>
          <button onClick={() => this.setState({ hasError: false })}>
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

**Unified Error Types:**

```typescript
// types/errors.ts
export type ErrorCode =
  | 'RATE_LIMITED'
  | 'INVALID_REQUEST'
  | 'AI_ERROR'
  | 'STREAM_ERROR'
  | 'NETWORK_ERROR';

export interface AppError {
  code: ErrorCode;
  message: string;
  retryAfter?: number;
  recoverable: boolean;
}

export function createError(code: ErrorCode, message: string): AppError {
  const recoverable = ['RATE_LIMITED', 'AI_ERROR', 'NETWORK_ERROR'].includes(code);

  return {
    code,
    message,
    recoverable
  };
}
```

**Error Handling Hook:**

```typescript
// hooks/useErrorHandler.ts
export function useErrorHandler() {
  const [error, setError] = useState<AppError | null>(null);

  const handleError = useCallback((err: unknown) => {
    if (err instanceof Response) {
      // HTTP error
      err.json().then((data) => {
        setError({
          code: data.code || 'NETWORK_ERROR',
          message: data.message || 'Request failed',
          retryAfter: data.retryAfter,
          recoverable: true
        });
      });
    } else if (err instanceof Error) {
      setError({
        code: 'NETWORK_ERROR',
        message: err.message,
        recoverable: true
      });
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { error, handleError, clearError };
}
```

### 6. Quota Management (Full Stack)

**Backend Quota Tracking:**

```typescript
// lib/rateLimit.ts (Edge Function)
interface QuotaBucket {
  minuteTokens: number;
  dailyCount: number;
  lastRefill: number;
  dayStart: number;
}

const LIMITS = {
  tokensPerMinute: 10,
  tokensPerDay: 100,
  refillRate: 0.17  // tokens per second
};

export async function checkRateLimit(ip: string): Promise<{
  allowed: boolean;
  remaining: number;
  resetIn: number;
}> {
  const hashedIp = await hashForPrivacy(ip);
  const key = `quota:${hashedIp}`;
  const now = Date.now();

  let bucket = await kv.get<QuotaBucket>(key);

  if (!bucket) {
    bucket = {
      minuteTokens: LIMITS.tokensPerMinute,
      dailyCount: 0,
      lastRefill: now,
      dayStart: now
    };
  }

  // Reset daily count if new day
  if (now - bucket.dayStart > 86400000) {
    bucket.dailyCount = 0;
    bucket.dayStart = now;
  }

  // Check daily limit
  if (bucket.dailyCount >= LIMITS.tokensPerDay) {
    return {
      allowed: false,
      remaining: 0,
      resetIn: 86400000 - (now - bucket.dayStart)
    };
  }

  // Refill minute tokens
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.minuteTokens = Math.min(
    LIMITS.tokensPerMinute,
    bucket.minuteTokens + elapsed * LIMITS.refillRate
  );
  bucket.lastRefill = now;

  // Check minute limit
  if (bucket.minuteTokens < 1) {
    return {
      allowed: false,
      remaining: Math.floor(bucket.minuteTokens),
      resetIn: (1 - bucket.minuteTokens) / LIMITS.refillRate * 1000
    };
  }

  // Consume token
  bucket.minuteTokens -= 1;
  bucket.dailyCount += 1;

  await kv.set(key, bucket, { ex: 86400 });

  return {
    allowed: true,
    remaining: LIMITS.tokensPerDay - bucket.dailyCount,
    resetIn: 0
  };
}
```

**Frontend Quota Display:**

```tsx
// components/Chat/QuotaIndicator.tsx
export function QuotaIndicator() {
  const quota = useChatStore((s) => s.quota);

  if (!quota) return null;

  const percentage = (quota.remaining / quota.limit) * 100;

  return (
    <div className={styles.quotaIndicator}>
      <div className={styles.quotaBar}>
        <div
          className={styles.quotaFill}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className={styles.quotaText}>
        {quota.remaining} / {quota.limit} requests today
      </span>
    </div>
  );
}
```

### 7. LMCIFY Sharing Integration

**Backend URL Generation:**

```typescript
// lib/lmcify.ts (shared)
import pako from 'pako';

export function encodeMessage(message: string): string {
  const compressed = pako.gzip(new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...compressed))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeMessage(encoded: string): string {
  const base64 = encoded
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const decompressed = pako.ungzip(bytes);
  return new TextDecoder().decode(decompressed);
}
```

**Frontend Share Integration:**

```tsx
// components/ShareButton.tsx
export function ShareButton({ message }: { message: string }) {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const encoded = encodeMessage(message);
    const url = `${window.location.origin}/?lmcify=${encoded}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: 'MCPlator Calculation',
          text: message,
          url
        });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (error) {
      console.error('Share failed:', error);
    }
  };

  return (
    <button onClick={handleShare} className={styles.shareButton}>
      {copied ? 'Copied!' : 'Share'}
    </button>
  );
}
```

**Auto-Play Handler:**

```tsx
// App.tsx
function App() {
  const sendCalculation = useAICalculator((s) => s.sendCalculation);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const lmcify = params.get('lmcify');

    if (lmcify) {
      try {
        const message = decodeMessage(lmcify);

        // Clean URL immediately
        window.history.replaceState({}, '', '/');

        // Delay to let UI render, then animate and send
        setTimeout(() => {
          sendCalculation(message);
        }, 500);
      } catch (error) {
        console.error('Invalid LMCIFY link');
      }
    }
  }, [sendCalculation]);

  return (
    <div className={styles.app}>
      <Calculator />
      <ChatPanel />
    </div>
  );
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| API Layer | Edge Functions | Node.js | Lower latency, simpler deployment |
| Streaming | SSE | WebSocket | Sufficient for one-way, works with serverless |
| State Sync | Zustand | Context + Reducer | Simpler cross-component coordination |
| Type Sharing | Shared types file | OpenAPI/GraphQL | Simpler for small API surface |
| Persistence | IndexedDB | Server-side DB | No auth needed, privacy-preserving |
| Compression | pako (gzip) | None | Keeps URLs short for sharing |

## Future Enhancements

1. **WebSocket Upgrade**: For bidirectional real-time features (collaborative calculations)
2. **Server-Side History**: Optional account system for cross-device sync
3. **Calculation Caching**: Cache common calculations to reduce API costs
4. **OpenAPI Schema**: Formalize API contract for larger team
5. **Analytics Integration**: Track popular queries for optimization
6. **Multi-Model Support**: Fall back to alternative LLMs if Claude is unavailable
