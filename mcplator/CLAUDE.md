# MCPlator - Development Notes

## Project Context

This document tracks design decisions and system design concepts explored in MCPlator, a retro calculator with AI integration demonstrating LLM-powered user interfaces.

**External Repository:** [github.com/evgenyvinnik/MCPlator](https://github.com/evgenyvinnik/MCPlator)

## System Design Concepts Explored

### 1. LLM Integration Patterns

MCPlator demonstrates translating natural language to structured actions:

**Pattern: Intent → Action Mapping**
```
User Input: "add 2 plus one hundred"
     ↓
AI Processing (Claude Haiku)
     ↓
Structured Output: { keys: ['2', '+', '1', '0', '0', '='] }
     ↓
UI Execution: Animate key presses
```

**Key Learning:** LLMs excel at parsing ambiguous natural language into deterministic action sequences.

### 2. Server-Sent Events (SSE)

Real-time streaming from server to client:

```javascript
// Server (Edge Function)
return new Response(
  new ReadableStream({
    async start(controller) {
      for await (const chunk of anthropicStream) {
        controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
  }),
  { headers: { 'Content-Type': 'text/event-stream' } }
);

// Client
const reader = response.body.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // Process streaming tokens
}
```

**Key Learning:** SSE provides simple, unidirectional streaming without WebSocket complexity.

### 3. Edge Computing

Vercel Edge Functions for low-latency API:

- **Cold Start:** ~50ms (vs ~300ms for Node.js functions)
- **Latency:** Runs in the nearest region to user
- **Limitations:** V8 isolate, no Node.js APIs

**Key Learning:** Edge functions are ideal for proxying AI APIs with streaming responses.

### 4. State Machine Design

Calculator implemented as a finite state machine:

```
States: [READY, ENTERING_NUMBER, PENDING_OPERATION, SHOWING_RESULT, ERROR]

Transitions:
  READY + digit → ENTERING_NUMBER
  ENTERING_NUMBER + operator → PENDING_OPERATION
  PENDING_OPERATION + digit → ENTERING_NUMBER
  ENTERING_NUMBER + equals → SHOWING_RESULT
  ANY + clear → READY
```

**Key Learning:** FSM pattern makes complex UI logic predictable and testable.

## Design Decisions Log

### 1. Claude Haiku vs GPT-3.5

**Decision:** Claude Haiku 4.5

**Rationale:**
- Faster first-token latency (~200ms vs ~400ms)
- Better at following structured output instructions
- More cost-efficient for simple tasks
- Streaming API is cleaner

### 2. CSS Modules + Tailwind Hybrid

**Decision:** Use both CSS Modules and Tailwind CSS

**Rationale:**
- CSS Modules for complex retro button styles (3D effects)
- Tailwind for layout and utility classes
- Best of both worlds

**Trade-off:** Slight learning curve for when to use each

### 3. IndexedDB vs Server-Side Storage

**Decision:** Client-side IndexedDB only

**Rationale:**
- No user accounts needed
- Privacy (data stays on device)
- Works offline
- Simpler architecture

**Trade-off:** No cross-device sync

### 4. Bun vs Node.js for Development

**Decision:** Bun as package manager and runtime

**Rationale:**
- Faster package installation
- Native TypeScript support
- Compatible with npm packages
- Faster test execution

## Iterations and Learnings

### Iteration 1: Basic Calculator

- Implemented Casio-style UI
- Calculator engine state machine
- Retro CSS styling with 3D buttons

**Learning:** CSS perspective and transforms can create convincing 3D button effects without images.

### Iteration 2: AI Integration

- Added Claude API integration
- Implemented SSE streaming
- Natural language parsing

**Learning:** Prompt engineering is crucial - small changes in system prompts dramatically affect output quality.

### Iteration 3: Animation System

- Key press animations synced with AI output
- Typing animation for shared URLs
- Smooth transitions

**Learning:** requestAnimationFrame queuing is essential for coordinated multi-element animations.

### Iteration 4: LMCIFY Sharing

- URL-based message encoding
- Compression with gzip + base64
- Auto-play on page load

**Learning:** URL length limits (~2000 chars) require compression for longer messages.

## Technical Challenges

### Challenge 1: Streaming Token Parsing

**Problem:** Claude streams tokens that may split across chunk boundaries.

**Solution:** Buffer incomplete JSON and parse when complete:
```javascript
let buffer = '';
function parseSSE(chunk) {
  buffer += chunk;
  const lines = buffer.split('\n\n');
  buffer = lines.pop(); // Keep incomplete line
  return lines.map(parseEvent);
}
```

### Challenge 2: Animation Timing

**Problem:** Key press animations need to feel natural, not robotic.

**Solution:** Variable delays based on key type:
- Digits: 100ms
- Operators: 150ms  
- Equals: 200ms (with result highlight)

### Challenge 3: Quota Management

**Problem:** Prevent API abuse without user accounts.

**Solution:** 
- Daily quota stored in IndexedDB
- Rate limiting at edge function
- Graceful degradation with helpful message

## Prompt Engineering Insights

### System Prompt Evolution

**v1 (Too verbose):**
```
You are a calculator assistant. When the user asks a math question, 
respond with the key presses needed...
```

**v2 (Better):**
```
Calculator assistant. Convert math requests to key sequences.
Output JSON: { "keys": ["1", "+", "2", "="], "result": "3" }
```

**v3 (Production):**
```
You control a Casio calculator. Parse the user's math request.
Rules:
- Numbers: individual digits ["1", "2", "3"]
- Operations: ["+", "-", "×", "÷", "%", "√", "=", "C"]
- Always end with "="
Respond ONLY with JSON: { "keys": [...], "explanation": "..." }
```

**Key Learning:** Shorter, more structured prompts produce more consistent outputs.

## Performance Metrics

| Metric | Target | Achieved |
|--------|--------|----------|
| AI First Token | < 500ms | ~250ms |
| Key Animation FPS | 60 | 60 |
| Bundle Size (gzipped) | < 200KB | ~180KB |
| Lighthouse Score | > 90 | 95 |

## Resources

- [Anthropic Claude API](https://docs.anthropic.com/)
- [Vercel Edge Functions](https://vercel.com/docs/functions/edge-functions)
- [Server-Sent Events MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [CSS 3D Transforms](https://developer.mozilla.org/en-US/docs/Web/CSS/transform-function/perspective)

---

*This document captures design insights from the MCPlator project for system design learning purposes.*
