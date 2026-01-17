# MCPlator - System Design Interview Answer

## Introduction (2 minutes)

"Today I'll design MCPlator, a retro calculator with an LLM-powered AI co-pilot that understands natural language. This is interesting because it combines:

1. Real-time LLM integration with streaming responses
2. Edge computing for low-latency AI responses
3. State machine design for calculator logic
4. Bidirectional UI synchronization between AI and calculator

Let me clarify the requirements."

---

## Requirements Clarification (3 minutes)

### Functional Requirements

"For the core product:

1. **Calculator**: Full Casio-style functionality (memory, percentage, sqrt, etc.)
2. **AI Assistant**: Natural language to calculator operations ('what's 15% of 80')
3. **Animated Feedback**: Key presses animate as the AI works
4. **Sharing**: URL-based sharing of calculations (LMCIFY)
5. **Persistence**: Remember calculator state and chat history

The AI integration pattern is the most interesting aspect."

### Non-Functional Requirements

"For user experience:

- **First Token Latency**: Under 500ms for AI responses
- **Animation**: 60fps key press animations
- **Offline Degradation**: Calculator works without network; AI gracefully fails
- **Cost**: Rate limiting to control API costs

The latency requirement pushes us toward edge computing and streaming."

---

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (Browser)                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌────────────────┐          ┌─────────────────────────────┐   │
│   │  Calculator    │◀────────▶│       Chat Interface         │   │
│   │  (Retro UI)    │   Keys   │   (Natural Language Input)   │   │
│   └────────┬───────┘          └──────────────┬──────────────┘   │
│            │                                  │                  │
│            ▼                                  ▼                  │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │              Calculator Engine (State Machine)            │  │
│   └──────────────────────────────────────────────────────────┘  │
│                             │                                    │
│                             ▼                                    │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │                IndexedDB (Persistence)                    │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└───────────────────────────────┬──────────────────────────────────┘
                                │ SSE Stream
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Vercel Edge Functions                         │
│                        /api/chat                                 │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Anthropic Claude API                          │
│                   (Claude Haiku 4.5)                             │
└─────────────────────────────────────────────────────────────────┘
```

"Three key layers:
1. **Client**: React app with calculator state machine and chat UI
2. **Edge**: Vercel Edge Functions for low-latency AI proxying
3. **AI**: Claude Haiku for natural language understanding"

---

## Deep Dive: LLM Integration Pattern (10 minutes)

### The Challenge

"Translating natural language to calculator operations:

```
User: 'What's 15% of 80?'
↓
AI understands intent
↓
Output: ['8', '0', '×', '1', '5', '%', '=']
↓
Animate key presses
↓
Display: 12
```

The AI must output structured data (key sequences), not just text."

### Prompt Engineering

"The system prompt is critical:

```
You control a Casio calculator. Convert math requests to key sequences.

Available keys: 0-9, +, -, ×, ÷, %, √, =, C, AC, M+, M-, MR, MC, ±

Rules:
- Numbers as individual digits: ['1', '2', '3'] not ['123']
- Always end with '=' for calculations
- Use 'C' for clear, 'AC' for all-clear

Output ONLY valid JSON:
{
  'keys': ['8', '0', '×', '1', '5', '%', '='],
  'explanation': '80 × 15% = 12'
}
```

Short, structured prompts produce more consistent outputs than verbose instructions."

### Why Claude Haiku?

| Model | First Token | Cost/1M tokens | Quality |
|-------|-------------|----------------|---------|
| GPT-4 | ~800ms | $30 | Excellent |
| Claude Sonnet | ~500ms | $3 | Great |
| Claude Haiku | ~200ms | $0.25 | Good |
| GPT-3.5 | ~400ms | $0.50 | Adequate |

"Haiku gives us the best latency at lowest cost. For simple math parsing, we don't need larger models."

### Streaming with SSE

"We stream responses for perceived performance:

```javascript
// Client
const response = await fetch('/api/chat', { 
  method: 'POST',
  body: JSON.stringify({ message })
})

const reader = response.body.getReader()
const decoder = new TextDecoder()

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  
  const chunk = decoder.decode(value)
  processStreamChunk(chunk)
}
```

User sees the response building character by character, which feels faster than waiting for complete response."

---

## Deep Dive: Edge Functions (5 minutes)

### Why Edge Runtime?

"Vercel Edge Functions run on Cloudflare's edge network:

```
User (Tokyo) → Edge Function (Tokyo) → Claude API (US)
Total: ~250ms first token

vs.

User (Tokyo) → Node.js Function (US) → Claude API (US)
Total: ~400ms first token
```

The edge function handles request validation and streams Claude's response back."

### Implementation

```javascript
// api/chat.ts (Edge Function)
export const config = { runtime: 'edge' }

export default async function handler(req) {
  const { message } = await req.json()
  
  // Rate limiting check
  const ip = req.headers.get('x-forwarded-for')
  if (await isRateLimited(ip)) {
    return new Response('Rate limited', { status: 429 })
  }
  
  // Stream from Claude
  const stream = await anthropic.messages.stream({
    model: 'claude-3-haiku-20240307',
    max_tokens: 150,
    messages: [{ role: 'user', content: message }],
    system: CALCULATOR_SYSTEM_PROMPT
  })
  
  // Return SSE stream
  return new Response(stream.toReadableStream(), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    }
  })
}
```

---

## Deep Dive: Calculator State Machine (5 minutes)

### State Design

"The calculator is a finite state machine:

```
States: [READY, ENTERING, PENDING_OP, RESULT, ERROR]

Transitions:
  READY + digit → ENTERING
  ENTERING + digit → ENTERING (append)
  ENTERING + operator → PENDING_OP
  PENDING_OP + digit → ENTERING
  ENTERING + '=' → RESULT
  ANY + 'C' → READY
```"

### Implementation

```typescript
interface CalculatorState {
  display: string
  accumulator: number
  pendingOp: Operation | null
  memory: number
  state: 'READY' | 'ENTERING' | 'PENDING_OP' | 'RESULT' | 'ERROR'
}

function reduce(state: CalculatorState, action: Key): CalculatorState {
  switch (action.type) {
    case 'DIGIT':
      if (state.state === 'RESULT') {
        return { ...state, display: action.value, state: 'ENTERING' }
      }
      return { ...state, display: state.display + action.value }
    
    case 'OPERATOR':
      const value = parseFloat(state.display)
      return {
        ...state,
        accumulator: state.pendingOp 
          ? calculate(state.accumulator, state.pendingOp, value)
          : value,
        pendingOp: action.value,
        state: 'PENDING_OP'
      }
    
    // ... more cases
  }
}
```

### Why State Machine?

"State machines make complex UI logic:
- Predictable (same input always produces same output)
- Testable (enumerate all states and transitions)
- Debuggable (log state transitions)"

---

## Deep Dive: Key Animation System (3 minutes)

### Animation Queue

"AI returns key sequences that must animate with timing:

```javascript
async function animateKeySequence(keys) {
  for (const key of keys) {
    // Highlight the key
    setActiveKey(key)
    
    // Wait for visual feedback
    await delay(getKeyDelay(key))
    
    // Execute the key press
    dispatch({ type: 'KEY_PRESS', key })
    
    // Clear highlight
    setActiveKey(null)
    await delay(50)
  }
}

function getKeyDelay(key) {
  if (key === '=') return 200  // Dramatic pause before result
  if ('+-×÷'.includes(key)) return 150  // Operators slightly slower
  return 100  // Digits fast
}
```"

### CSS for Button Press Effect

```css
.calculator-key {
  transform: translateY(0);
  transition: transform 0.05s;
}

.calculator-key.active {
  transform: translateY(2px);
  box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);
}
```

---

## Deep Dive: LMCIFY Sharing (3 minutes)

### URL Encoding

"Share calculations via URL:

```
https://mcplator.com/?lmcify=eJxLTc7PLShKLS5JTQYADdUDMw
                              └── Compressed message
```

Encoding flow:
1. Take user message: 'what is 15% of 80'
2. gzip compress (saves ~50% for typical messages)
3. Base64 encode (URL safe)

```javascript
function encodeMessage(message) {
  const compressed = pako.gzip(message)
  return btoa(String.fromCharCode(...compressed))
}
```"

### Auto-Play on Load

"When someone opens a LMCIFY link:
1. Parse and decode the message
2. Show typing animation in chat input
3. Send to AI and animate result

This creates a sharable 'calculation demo'."

---

## Trade-offs and Decisions (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| AI Model | Claude Haiku | GPT-3.5 | Faster, cheaper, better structured output |
| Streaming | SSE | WebSocket | Simpler for one-way streaming |
| Compute | Edge Functions | Node.js | Lower latency |
| State | State Machine | Ad-hoc | Predictable, testable |
| Storage | IndexedDB | localStorage | Structured data, async |

### What I'd Add With More Time

1. **Voice input**: Speak calculations naturally
2. **Calculation history**: Log and replay past calculations
3. **Scientific mode**: Advanced functions (sin, cos, log)
4. **Custom themes**: Different calculator styles

---

## Summary

"To summarize, I've designed MCPlator with:

1. **Edge Functions** for low-latency AI proxy (~200ms first token)
2. **SSE streaming** for real-time response display
3. **Structured prompts** for reliable key sequence output
4. **State machine** for predictable calculator behavior
5. **IndexedDB persistence** for chat history and state

The key insight is that LLMs can control UIs when given structured output constraints. The prompt engineering and edge computing are critical for good UX.

What aspects would you like to explore further?"
