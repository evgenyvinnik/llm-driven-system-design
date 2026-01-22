# MCPlator - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design MCPlator, a retro calculator with an LLM-powered AI co-pilot. The frontend challenge focuses on building an interactive calculator with state machine logic, real-time streaming UI updates, coordinated key animations, and a polished retro aesthetic.

## Requirements Clarification

### Functional Requirements
- **Calculator UI**: Full Casio-style functionality with retro design
- **AI Chat Interface**: Natural language input with streaming responses
- **Key Animations**: Synchronized key presses as AI executes calculations
- **State Persistence**: Remember calculator memory and chat history
- **URL Sharing**: LMCIFY compressed message sharing

### Non-Functional Requirements
- **Animation Performance**: 60 FPS key animations
- **First Contentful Paint**: < 1 second
- **Offline Degradation**: Calculator works without network
- **Accessibility**: Keyboard navigation, screen reader support
- **Bundle Size**: < 200KB gzipped

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                BROWSER                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────┐          ┌────────────────────────────────┐   │
│  │    Calculator Panel     │          │         Chat Panel             │   │
│  │  ┌───────────────────┐  │          │  ┌──────────────────────────┐  │   │
│  │  │    LCD Display    │  │          │  │    Message History       │  │   │
│  │  │   (7-segment)     │  │◀────────▶│  │   (AI + User bubbles)    │  │   │
│  │  └───────────────────┘  │   Keys   │  └──────────────────────────┘  │   │
│  │  ┌───────────────────┐  │          │  ┌──────────────────────────┐  │   │
│  │  │   Keypad Grid     │  │          │  │     Input Field          │  │   │
│  │  │  (4x6 buttons)    │  │          │  │  (Natural Language)      │  │   │
│  │  └───────────────────┘  │          │  └──────────────────────────┘  │   │
│  └─────────────────────────┘          └────────────────────────────────┘   │
│             │                                       │                       │
│             ▼                                       ▼                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        Zustand State Stores                          │   │
│  │  calculatorStore (display, memory, pending op)                       │   │
│  │  chatStore (messages, loading, quota)                                │   │
│  │  animationStore (activeKey, queue)                                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      IndexedDB Persistence                           │   │
│  │  Chat history │ Calculator memory │ Daily quota                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Component Architecture

### Component Tree

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              App                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────┐   ┌────────────────────────────────────┐  │
│  │        Calculator            │   │          ChatPanel                 │  │
│  │  ┌────────────────────────┐  │   │  ┌──────────────────────────────┐  │  │
│  │  │      LCDDisplay        │  │   │  │      MessageHistory          │  │  │
│  │  │  ├── DigitSegment (x12)│  │   │  │  ├── UserMessage             │  │  │
│  │  │  └── MemoryIndicator   │  │   │  │  └── AIMessage               │  │  │
│  │  └────────────────────────┘  │   │  │       └── StreamingText      │  │  │
│  │  ┌────────────────────────┐  │   │  └──────────────────────────────┘  │  │
│  │  │      KeypadGrid        │  │   │  ┌──────────────────────────────┐  │  │
│  │  │  └── CalculatorKey(x24)│  │   │  │       ChatInput              │  │  │
│  │  └────────────────────────┘  │   │  └──────────────────────────────┘  │  │
│  │  ┌────────────────────────┐  │   │  ┌──────────────────────────────┐  │  │
│  │  │  SolarPanel (decor)    │  │   │  │      QuotaIndicator          │  │  │
│  │  └────────────────────────┘  │   │  └──────────────────────────────┘  │  │
│  └──────────────────────────────┘   └────────────────────────────────────┘  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                          ShareModal                                   │   │
│  │                          └── LMCIFYLink                               │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Calculator Key Component

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CalculatorKey Component                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Props:                                                                      │
│  ├── keyValue: string                                                       │
│  ├── label?: string                                                         │
│  ├── variant: 'number' │ 'operator' │ 'function' │ 'memory'                │
│  ├── isActive: boolean                                                      │
│  └── onPress: (key: string) => void                                         │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │   ┌───────────────────────────────────────────┐                     │    │
│  │   │                                           │ ◀── keyReflection   │    │
│  │   │              KEY LABEL                    │     (gradient)      │    │
│  │   │                                           │                     │    │
│  │   └───────────────────────────────────────────┘                     │    │
│  │              │                                                       │    │
│  │              │ 3D effect via transform + box-shadow                  │    │
│  │              ▼                                                       │    │
│  │   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ◀── shadow             │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Visual States:                                                              │
│  ├── Normal: translateY(0), box-shadow: 0 4px 0                             │
│  └── Active/Pressed: translateY(3px), box-shadow: 0 1px 0                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### LCD Display Component

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          LCDDisplay Component                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  LCD Container                                                       │    │
│  │  ┌───────────────────────────────────────────────────────────────┐  │    │
│  │  │ M │ E │                                                       │  │    │
│  │  │───│───│  ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐     │  │    │
│  │  │mem│err│  │ 1 │ │ 2 │ │ 3 │ │ . │ │ 4 │ │ 5 │ │ 6 │ │ 7 │     │  │    │
│  │  └───┴───┘  └───┘ └───┘ └───┘ └───┘ └───┘ └───┘ └───┘ └───┘     │  │    │
│  │             ◀──────── 12 DigitSegment components ────────▶       │  │    │
│  └───────────────────────────────────────────────────────────────────┘  │    │
│  │  LCD Reflection Effect (gradient overlay)                           │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Props:                                                                      │
│  ├── value: string (formatted for 12-digit display with padding)            │
│  ├── hasMemory: boolean (shows "M" indicator)                               │
│  └── hasError: boolean (shows "E" indicator)                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Calculator State Machine

### State Interface

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CalculatorState Interface                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  STATE VALUES                                                                │
│  ├── display: string                                                        │
│  ├── accumulator: number                                                    │
│  ├── pendingOperation: '+' │ '-' │ '×' │ '÷' │ null                        │
│  ├── memory: number                                                         │
│  ├── state: 'READY' │ 'ENTERING' │ 'PENDING_OP' │ 'RESULT' │ 'ERROR'       │
│  └── history: CalculationEntry[]                                            │
│                                                                              │
│  ACTIONS                                                                     │
│  ├── pressKey(key: string): void                                            │
│  ├── pressKeys(keys: string[]): Promise<void>  ◀── For AI-driven sequences │
│  ├── clear(): void                                                          │
│  └── allClear(): void                                                       │
│                                                                              │
│  PERSISTENCE (Zustand persist middleware)                                    │
│  └── Partial state saved: { memory }                                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### State Machine Transitions

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Calculator State Machine                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                           ┌─────────┐                                        │
│                           │  READY  │◀───────── AC / C                       │
│                           └────┬────┘                                        │
│                                │ digit                                       │
│                                ▼                                             │
│                         ┌───────────┐                                        │
│               ┌────────▶│ ENTERING  │◀────────┐                              │
│               │         └─────┬─────┘         │                              │
│               │               │ operator      │ digit                        │
│               │               ▼               │                              │
│               │        ┌─────────────┐        │                              │
│               │        │ PENDING_OP  │────────┘                              │
│               │        └──────┬──────┘                                       │
│               │               │ = (equals)                                   │
│               │               ▼                                              │
│               │          ┌────────┐                                          │
│               └──────────│ RESULT │                                          │
│                 digit    └────────┘                                          │
│                                                                              │
│  ERROR State: Triggered by √(negative) or ÷ 0                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Handling Logic

| Key Type | Current State | Action |
|----------|--------------|--------|
| Digit (0-9) | RESULT / PENDING_OP | Reset display to digit, set ENTERING |
| Digit (0-9) | ENTERING | Append digit (max 12 chars) |
| Decimal (.) | Any | Append if not already present |
| Operator (+,-,×,÷) | ENTERING | Execute pending op, store new op |
| Equals (=) | ENTERING with pending op | Calculate result, set RESULT |
| Percent (%) | Any | Calculate percentage of accumulator |
| Square Root (√) | Any | Calculate sqrt (ERROR if negative) |
| Memory (M+, M-, MR, MC) | Any | Modify or recall memory register |
| Clear (C) | Any | Reset display only |
| All Clear (AC) | Any | Reset all state |

---

## Deep Dive: Key Animation System

### Animation Store

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AnimationState Interface                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  STATE                                                                       │
│  ├── activeKey: string │ null                                               │
│  ├── queue: string[]                                                        │
│  └── isAnimating: boolean                                                   │
│                                                                              │
│  ACTIONS                                                                     │
│  ├── setActiveKey(key: string │ null): void                                 │
│  └── animateKeySequence(keys: string[]): Promise<void>                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Animation Sequence Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      animateKeySequence Flow                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Input: keys = ['2', '+', '1', '0', '0', '=']                               │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ set isAnimating = true, queue = keys                                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ FOR each key in keys:                                                │   │
│  │                                                                      │   │
│  │   ┌────────────────┐   ┌────────────────┐   ┌────────────────┐      │   │
│  │   │ setActiveKey   │──▶│    DELAY       │──▶│  pressKey      │      │   │
│  │   │ (highlight)    │   │  (getKeyDelay) │   │  (execute)     │      │   │
│  │   └────────────────┘   └────────────────┘   └────────────────┘      │   │
│  │                                                      │               │   │
│  │   ┌────────────────┐   ┌────────────────┐           │               │   │
│  │   │ setActiveKey   │──▶│    DELAY       │◀──────────┘               │   │
│  │   │ (null)         │   │    50ms        │                           │   │
│  │   └────────────────┘   └────────────────┘                           │   │
│  │                                                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ set isAnimating = false, queue = []                                  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  getKeyDelay():                                                              │
│  ├── '=' ────────▶ 200ms (dramatic pause before result)                     │
│  ├── '+', '-', '×', '÷' ──▶ 150ms (operators slightly slower)              │
│  └── digits ─────▶ 100ms (fast)                                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3D Button Press CSS Effect

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        3D Button Effect                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  NORMAL STATE                              PRESSED STATE                     │
│  ─────────────                             ─────────────                     │
│  ┌───────────────────┐                     ┌───────────────────┐             │
│  │                   │                     │                   │             │
│  │      BUTTON       │ ◀── translateY(0)   │      BUTTON       │             │
│  │                   │                     │                   │             │
│  └───────────────────┘                     └───────────────────┘             │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ◀── shadow 4px      ▓ ◀── translateY(3px)            │
│  ░░░░░░░░░░░░░░░░░░░░░░░░                       shadow 1px                   │
│                                                                              │
│  Variant Colors:                                                             │
│  ├── number: #4a4a4a gradient, white text                                   │
│  ├── operator: #ff9500 gradient (orange), white text                        │
│  └── function: #a5a5a5 gradient (gray), black text                          │
│                                                                              │
│  Key Reflection:                                                             │
│  └── Pseudo-element with white gradient (0.3 → 0 opacity)                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: SSE Streaming UI

### StreamingText Component Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    StreamingText Component                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Props:                                                                      │
│  ├── message: string (user's natural language query)                        │
│  └── onComplete: (response: AIResponse) => void                             │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ useEffect on mount:                                                   │   │
│  │                                                                       │   │
│  │  ┌────────────┐    ┌──────────────────┐    ┌────────────────────┐    │   │
│  │  │   fetch    │───▶│  ReadableStream  │───▶│  Parse SSE Events  │    │   │
│  │  │ POST /chat │    │    .getReader()  │    │                    │    │   │
│  │  └────────────┘    └──────────────────┘    └─────────┬──────────┘    │   │
│  │                                                      │                │   │
│  │                           ┌──────────────────────────┘                │   │
│  │                           │                                           │   │
│  │                           ▼                                           │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │   │
│  │  │ Event Type          │ Action                                    │ │   │
│  │  ├─────────────────────┼───────────────────────────────────────────┤ │   │
│  │  │ delta               │ setDisplayText(prev + event.text)         │ │   │
│  │  │ complete            │ setIsComplete(true), onComplete(response) │ │   │
│  │  └─────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  Render:                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ {displayText}{!isComplete && <span className="cursor">|</span>}     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  SSE Parsing:                                                                │
│  ├── Split buffer by '\n\n'                                                 │
│  ├── Keep incomplete line as remaining buffer                               │
│  └── Parse lines starting with 'data: ' as JSON                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### AI Message Component

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       AIMessage Component                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ┌────┐                                                              │    │
│  │  │ AI │  ┌──────────────────────────────────────────────────────┐   │    │
│  │  └────┘  │                                                      │   │    │
│  │  avatar  │  "I'll calculate 2 + 100 for you..."                 │   │    │
│  │          │                                                      │   │    │
│  │          │  ◀── typing cursor while streaming                   │   │    │
│  │          └──────────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Behavior:                                                                   │
│  ├── When isStreaming: show content with typing effect                      │
│  └── When complete: trigger animateKeys(keys) once                          │
│                                                                              │
│  useEffect triggers animation:                                               │
│  ├── Condition: !isStreaming && keys?.length && !hasAnimated               │
│  ├── Action: setHasAnimated(true), animateKeys(keys)                        │
│  └── Keys example: ['2', '+', '1', '0', '0', '=']                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: IndexedDB Persistence

### Database Schema

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       MCPlatorDB Schema                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  OBJECT STORES                                                               │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ messages                                                             │    │
│  │ ├── keyPath: 'id' (autoIncrement)                                   │    │
│  │ ├── value: ChatMessage                                               │    │
│  │ └── indexes: { 'by-date': Date }                                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ state                                                                │    │
│  │ ├── keyPath: string                                                  │    │
│  │ └── value: { calculatorMemory, dailyQuota: { date, remaining } }    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ auditLog                                                             │    │
│  │ ├── keyPath: 'id' (autoIncrement)                                   │    │
│  │ ├── value: AuditEntry                                                │    │
│  │ └── indexes: { 'by-timestamp': number }                             │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Persistence Hook

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      usePersistence Hook                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Returns:                                                                    │
│  ├── saveMessage(message: ChatMessage): Promise<void>                       │
│  ├── getMessages(limit = 50): Promise<ChatMessage[]>                        │
│  ├── saveQuota(quota: DailyQuota): Promise<void>                            │
│  └── getQuota(): Promise<DailyQuota │ undefined>                            │
│                                                                              │
│  Implementation:                                                             │
│  ├── Opens DB once on mount via getDB()                                     │
│  ├── Stores reference in useRef                                             │
│  └── All operations use useCallback for stable references                   │
│                                                                              │
│  Database Initialization:                                                    │
│  └── openDB('mcplator', version=1, upgrade callback creates stores)         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: LMCIFY URL Sharing

### Compression and Encoding Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    LMCIFY URL Generation                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Message: "what's 2 plus one hundred?"                                       │
│            │                                                                 │
│            ▼                                                                 │
│  ┌────────────────┐                                                          │
│  │ TextEncoder    │──▶ UTF-8 bytes                                          │
│  │ .encode()      │                                                          │
│  └────────────────┘                                                          │
│            │                                                                 │
│            ▼                                                                 │
│  ┌────────────────┐                                                          │
│  │ pako.gzip()    │──▶ Compressed bytes                                     │
│  └────────────────┘                                                          │
│            │                                                                 │
│            ▼                                                                 │
│  ┌────────────────┐                                                          │
│  │ btoa()         │──▶ Base64 string                                        │
│  └────────────────┘                                                          │
│            │                                                                 │
│            ▼                                                                 │
│  URL: https://mcplator.app/?lmcify=H4sIAAAA...                              │
│                                                                              │
│  Decoding (reverse):                                                         │
│  atob() ──▶ Uint8Array ──▶ pako.ungzip() ──▶ TextDecoder ──▶ message       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Auto-Play on Load (useLMCIFY Hook)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      useLMCIFY Hook Flow                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  On Mount:                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ 1. Check URL params for 'lmcify'                                     │   │
│  │ 2. If found and not processed:                                       │   │
│  │    ├── setHasProcessed(true)                                         │   │
│  │    ├── decodeMessage(lmcify)                                         │   │
│  │    ├── typeMessage(message) ──▶ Animate typing into input            │   │
│  │    ├── sendMessage(message)                                          │   │
│  │    └── window.history.replaceState({}, '', '/') ──▶ Clean URL        │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  typeMessage(message):                                                       │
│  ├── Focus input element                                                    │
│  ├── For each char:                                                         │
│  │   ├── Append to input.value                                              │
│  │   ├── Dispatch 'input' event                                             │
│  │   └── await delay(50ms)                                                  │
│  └── Creates typewriter effect                                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Keyboard Navigation and Accessibility

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| 0-9 | Input digit |
| +, -, *, / | Operators (mapped to ×, ÷) |
| Enter, = | Calculate result |
| . or , | Decimal point |
| Escape | All Clear |
| Backspace | Clear |
| % | Percentage |

**Implementation Notes:**
- Skip handling if target is INPUT (chat field)
- Prevent default on matched keys
- Map keyboard symbols to calculator keys (e.g., * to ×)

### Screen Reader Announcements

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      LiveRegion Component                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  <div role="status" aria-live="polite" aria-atomic="true" class="sr-only"> │
│    {announcement}                                                            │
│  </div>                                                                      │
│                                                                              │
│  Announcements:                                                              │
│  ├── state === 'RESULT' ──▶ "Result: {display}"                             │
│  └── state === 'ERROR' ──▶ "Error in calculation"                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Focus Management (KeypadGrid)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Arrow Key Navigation                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Grid Layout (4 columns):                                                    │
│  ┌─────┬─────┬─────┬─────┐                                                  │
│  │  7  │  8  │  9  │  ÷  │                                                  │
│  ├─────┼─────┼─────┼─────┤                                                  │
│  │  4  │  5  │  6  │  ×  │                                                  │
│  ├─────┼─────┼─────┼─────┤                                                  │
│  │  1  │  2  │  3  │  -  │                                                  │
│  ├─────┼─────┼─────┼─────┤                                                  │
│  │  0  │  .  │  =  │  +  │                                                  │
│  └─────┴─────┴─────┴─────┘                                                  │
│                                                                              │
│  Navigation:                                                                 │
│  ├── ArrowUp ──▶ index - 4 (move up one row)                                │
│  ├── ArrowDown ──▶ index + 4 (move down one row)                            │
│  ├── ArrowLeft ──▶ index - 1                                                │
│  └── ArrowRight ──▶ index + 1                                               │
│                                                                              │
│  Boundary check: 0 <= nextIndex < buttons.length                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State Management | Zustand | Redux | Simpler API, less boilerplate |
| Styling | CSS Modules + Tailwind | CSS-in-JS | Better performance, no runtime |
| Persistence | IndexedDB | localStorage | Structured data, larger quota |
| Animations | CSS transitions | Framer Motion | Lighter bundle, sufficient for needs |
| Compression | pako (gzip) | lz-string | Better compression ratio |

> "We accept the slight learning curve of hybrid CSS Modules + Tailwind because 3D button effects require custom CSS while layout benefits from utility classes."

---

## Future Enhancements

1. **Voice Input**: Add speech recognition for hands-free operation
2. **Haptic Feedback**: Vibration on mobile for key presses
3. **Themes**: Switchable calculator skins (scientific, vintage, modern)
4. **History Panel**: Visual history of calculations with replay
5. **PWA**: Offline support with service worker
6. **Scientific Mode**: Advanced functions (sin, cos, log, etc.)
