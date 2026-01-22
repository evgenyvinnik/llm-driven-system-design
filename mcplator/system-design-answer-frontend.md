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

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         BROWSER                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌────────────────────┐      ┌─────────────────────────────┐   │
│   │  Calculator Panel  │      │      Chat Panel             │   │
│   │  ┌──────────────┐  │      │  ┌───────────────────────┐  │   │
│   │  │ LCD Display  │  │      │  │ Message History       │  │   │
│   │  │ (7-segment)  │  │      │  │ (AI + User bubbles)   │  │   │
│   │  └──────────────┘  │◀────▶│  └───────────────────────┘  │   │
│   │  ┌──────────────┐  │ Keys │  ┌───────────────────────┐  │   │
│   │  │ Keypad Grid  │  │      │  │ Input Field           │  │   │
│   │  │ (4x6 buttons)│  │      │  │ (Natural Language)    │  │   │
│   │  └──────────────┘  │      │  └───────────────────────┘  │   │
│   └────────────────────┘      └─────────────────────────────┘   │
│            │                              │                      │
│            ▼                              ▼                      │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │                   Zustand State Store                     │  │
│   │  - calculatorStore (display, memory, pending op)          │  │
│   │  - chatStore (messages, loading, quota)                   │  │
│   │  - animationStore (activeKey, queue)                      │  │
│   └──────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │                 IndexedDB Persistence                     │  │
│   │  - Chat history                                           │  │
│   │  - Calculator memory                                      │  │
│   │  - Daily quota                                            │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dives

### 1. Component Architecture

**Component Tree:**

```
App
├── Calculator
│   ├── LCDDisplay
│   │   ├── DigitSegment (×12)
│   │   └── MemoryIndicator
│   ├── KeypadGrid
│   │   └── CalculatorKey (×24)
│   └── SolarPanel (decorative)
│
├── ChatPanel
│   ├── MessageHistory
│   │   ├── UserMessage
│   │   └── AIMessage
│   │       └── StreamingText
│   ├── ChatInput
│   └── QuotaIndicator
│
└── ShareModal
    └── LMCIFYLink
```

**Key Component Implementations:**

```tsx
// components/Calculator/CalculatorKey.tsx
interface CalculatorKeyProps {
  keyValue: string;
  label?: string;
  variant: 'number' | 'operator' | 'function' | 'memory';
  isActive: boolean;
  onPress: (key: string) => void;
}

export function CalculatorKey({
  keyValue,
  label,
  variant,
  isActive,
  onPress
}: CalculatorKeyProps) {
  const handleClick = () => {
    onPress(keyValue);
  };

  return (
    <button
      className={clsx(
        styles.key,
        styles[variant],
        isActive && styles.active
      )}
      onClick={handleClick}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
      aria-label={label || keyValue}
      aria-pressed={isActive}
    >
      <span className={styles.keyLabel}>{label || keyValue}</span>
      <span className={styles.keyReflection} />
    </button>
  );
}
```

```tsx
// components/Calculator/LCDDisplay.tsx
interface LCDDisplayProps {
  value: string;
  hasMemory: boolean;
  hasError: boolean;
}

export function LCDDisplay({ value, hasMemory, hasError }: LCDDisplayProps) {
  // Format for 12-digit display with padding
  const displayValue = formatForLCD(value, 12);

  return (
    <div className={styles.lcdContainer}>
      <div className={styles.lcdScreen}>
        {/* Memory indicator */}
        {hasMemory && <span className={styles.memoryIndicator}>M</span>}

        {/* Error indicator */}
        {hasError && <span className={styles.errorIndicator}>E</span>}

        {/* Digit segments */}
        <div className={styles.digits}>
          {displayValue.split('').map((char, index) => (
            <DigitSegment key={index} char={char} />
          ))}
        </div>
      </div>

      {/* LCD reflection effect */}
      <div className={styles.lcdReflection} />
    </div>
  );
}
```

### 2. Calculator State Machine

**State Interface:**

```typescript
// stores/calculatorStore.ts
interface CalculatorState {
  display: string;
  accumulator: number;
  pendingOperation: Operation | null;
  memory: number;
  state: 'READY' | 'ENTERING' | 'PENDING_OP' | 'RESULT' | 'ERROR';
  history: CalculationEntry[];
}

type Operation = '+' | '-' | '×' | '÷';

interface CalculatorActions {
  pressKey: (key: string) => void;
  pressKeys: (keys: string[]) => void;
  clear: () => void;
  allClear: () => void;
}
```

**State Machine Implementation:**

```typescript
// stores/calculatorStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useCalculatorStore = create<CalculatorState & CalculatorActions>()(
  persist(
    (set, get) => ({
      display: '0',
      accumulator: 0,
      pendingOperation: null,
      memory: 0,
      state: 'READY',
      history: [],

      pressKey: (key) => {
        set((state) => reduce(state, key));
      },

      pressKeys: async (keys) => {
        // Used for AI-driven key sequences
        for (const key of keys) {
          get().pressKey(key);
          await delay(100);  // Animation timing
        }
      },

      clear: () => set({ display: '0', state: 'READY' }),

      allClear: () => set({
        display: '0',
        accumulator: 0,
        pendingOperation: null,
        state: 'READY'
      })
    }),
    {
      name: 'calculator-storage',
      partialize: (state) => ({ memory: state.memory })
    }
  )
);

function reduce(state: CalculatorState, key: string): Partial<CalculatorState> {
  // Digit input
  if (/^[0-9]$/.test(key)) {
    if (state.state === 'RESULT' || state.state === 'PENDING_OP') {
      return { display: key, state: 'ENTERING' };
    }
    if (state.display === '0') {
      return { display: key, state: 'ENTERING' };
    }
    if (state.display.length >= 12) return {};  // Max digits
    return { display: state.display + key, state: 'ENTERING' };
  }

  // Decimal point
  if (key === '.') {
    if (state.display.includes('.')) return {};
    return { display: state.display + '.', state: 'ENTERING' };
  }

  // Operators
  if (['+', '-', '×', '÷'].includes(key)) {
    const value = parseFloat(state.display);

    if (state.pendingOperation && state.state === 'ENTERING') {
      const result = calculate(state.accumulator, state.pendingOperation, value);
      return {
        display: formatResult(result),
        accumulator: result,
        pendingOperation: key as Operation,
        state: 'PENDING_OP'
      };
    }

    return {
      accumulator: value,
      pendingOperation: key as Operation,
      state: 'PENDING_OP'
    };
  }

  // Equals
  if (key === '=') {
    if (!state.pendingOperation) return {};

    const value = parseFloat(state.display);
    const result = calculate(state.accumulator, state.pendingOperation, value);

    return {
      display: formatResult(result),
      accumulator: result,
      pendingOperation: null,
      state: 'RESULT',
      history: [...state.history, {
        expression: `${state.accumulator} ${state.pendingOperation} ${value}`,
        result
      }]
    };
  }

  // Percentage
  if (key === '%') {
    const value = parseFloat(state.display);
    const percentage = state.accumulator * (value / 100);
    return {
      display: formatResult(percentage),
      state: 'ENTERING'
    };
  }

  // Square root
  if (key === '√') {
    const value = parseFloat(state.display);
    if (value < 0) {
      return { display: 'Error', state: 'ERROR' };
    }
    return {
      display: formatResult(Math.sqrt(value)),
      state: 'RESULT'
    };
  }

  // Memory operations
  if (key === 'M+') {
    return { memory: state.memory + parseFloat(state.display) };
  }
  if (key === 'M-') {
    return { memory: state.memory - parseFloat(state.display) };
  }
  if (key === 'MR') {
    return { display: formatResult(state.memory), state: 'RESULT' };
  }
  if (key === 'MC') {
    return { memory: 0 };
  }

  // Clear
  if (key === 'C') {
    return { display: '0', state: 'READY' };
  }
  if (key === 'AC') {
    return {
      display: '0',
      accumulator: 0,
      pendingOperation: null,
      state: 'READY'
    };
  }

  return {};
}

function calculate(a: number, op: Operation, b: number): number {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '×': return a * b;
    case '÷': return b === 0 ? NaN : a / b;
  }
}
```

### 3. Key Animation System

**Animation Store:**

```typescript
// stores/animationStore.ts
interface AnimationState {
  activeKey: string | null;
  queue: string[];
  isAnimating: boolean;
}

interface AnimationActions {
  animateKeySequence: (keys: string[]) => Promise<void>;
  setActiveKey: (key: string | null) => void;
}

export const useAnimationStore = create<AnimationState & AnimationActions>(
  (set, get) => ({
    activeKey: null,
    queue: [],
    isAnimating: false,

    setActiveKey: (key) => set({ activeKey: key }),

    animateKeySequence: async (keys) => {
      set({ isAnimating: true, queue: keys });

      const calculator = useCalculatorStore.getState();

      for (const key of keys) {
        // Highlight key
        set({ activeKey: key });

        // Wait for visual feedback
        await delay(getKeyDelay(key));

        // Execute key press
        calculator.pressKey(key);

        // Clear highlight
        set({ activeKey: null });

        // Brief pause between keys
        await delay(50);
      }

      set({ isAnimating: false, queue: [] });
    }
  })
);

function getKeyDelay(key: string): number {
  if (key === '=') return 200;  // Dramatic pause before result
  if ('+-×÷'.includes(key)) return 150;  // Operators slightly slower
  return 100;  // Digits fast
}
```

**CSS for 3D Button Press Effect:**

```css
/* styles/CalculatorKey.module.css */
.key {
  position: relative;
  padding: 12px 16px;
  border: none;
  border-radius: 4px;
  font-family: 'Calculator', monospace;
  font-size: 18px;
  cursor: pointer;

  /* 3D effect */
  transform: translateY(0);
  box-shadow:
    0 4px 0 var(--key-shadow-color),
    0 6px 10px rgba(0, 0, 0, 0.3);

  transition:
    transform 0.05s ease-out,
    box-shadow 0.05s ease-out;
}

.key:active,
.key.active {
  transform: translateY(3px);
  box-shadow:
    0 1px 0 var(--key-shadow-color),
    0 2px 4px rgba(0, 0, 0, 0.2);
}

/* Variant colors */
.number {
  background: linear-gradient(180deg, #4a4a4a 0%, #3a3a3a 100%);
  --key-shadow-color: #2a2a2a;
  color: white;
}

.operator {
  background: linear-gradient(180deg, #ff9500 0%, #e68600 100%);
  --key-shadow-color: #b36b00;
  color: white;
}

.function {
  background: linear-gradient(180deg, #a5a5a5 0%, #8a8a8a 100%);
  --key-shadow-color: #666;
  color: black;
}

/* Key reflection shine */
.keyReflection {
  position: absolute;
  top: 2px;
  left: 10%;
  right: 10%;
  height: 40%;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.3) 0%,
    rgba(255, 255, 255, 0) 100%
  );
  border-radius: 4px 4px 50% 50%;
  pointer-events: none;
}
```

### 4. SSE Streaming UI

**Streaming Text Component:**

```tsx
// components/Chat/StreamingText.tsx
interface StreamingTextProps {
  onComplete: (response: AIResponse) => void;
  message: string;
}

export function StreamingText({ onComplete, message }: StreamingTextProps) {
  const [displayText, setDisplayText] = useState('');
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function streamResponse() {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: controller.signal
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = parseSSEEvents(buffer);
        buffer = events.remaining;

        for (const event of events.parsed) {
          if (event.type === 'delta') {
            setDisplayText((prev) => prev + event.text);
          } else if (event.type === 'complete') {
            setIsComplete(true);
            onComplete({
              keys: event.keys,
              explanation: event.explanation
            });
          }
        }
      }
    }

    streamResponse();

    return () => controller.abort();
  }, [message, onComplete]);

  return (
    <div className={styles.streamingText}>
      {displayText}
      {!isComplete && <span className={styles.cursor}>|</span>}
    </div>
  );
}

function parseSSEEvents(buffer: string) {
  const events = buffer.split('\n\n');
  const remaining = events.pop() || '';

  const parsed = events
    .filter((e) => e.startsWith('data: '))
    .map((e) => JSON.parse(e.slice(6)));

  return { parsed, remaining };
}
```

**Chat Message Component:**

```tsx
// components/Chat/AIMessage.tsx
interface AIMessageProps {
  content: string;
  keys?: string[];
  isStreaming: boolean;
}

export function AIMessage({ content, keys, isStreaming }: AIMessageProps) {
  const animateKeys = useAnimationStore((s) => s.animateKeySequence);
  const [hasAnimated, setHasAnimated] = useState(false);

  useEffect(() => {
    if (!isStreaming && keys?.length && !hasAnimated) {
      setHasAnimated(true);
      animateKeys(keys);
    }
  }, [isStreaming, keys, hasAnimated, animateKeys]);

  return (
    <div className={styles.aiMessage}>
      <div className={styles.avatar}>AI</div>
      <div className={styles.bubble}>
        {isStreaming ? (
          <span className={styles.typing}>{content}</span>
        ) : (
          <span>{content}</span>
        )}
      </div>
    </div>
  );
}
```

### 5. IndexedDB Persistence

**Database Schema:**

```typescript
// lib/db.ts
import { openDB, DBSchema } from 'idb';

interface MCPlatorDB extends DBSchema {
  messages: {
    key: number;
    value: ChatMessage;
    indexes: { 'by-date': Date };
  };
  state: {
    key: string;
    value: {
      calculatorMemory: number;
      dailyQuota: { date: string; remaining: number };
    };
  };
  auditLog: {
    key: number;
    value: AuditEntry;
    indexes: { 'by-timestamp': number };
  };
}

export async function getDB() {
  return openDB<MCPlatorDB>('mcplator', 1, {
    upgrade(db) {
      // Messages store
      const messageStore = db.createObjectStore('messages', {
        keyPath: 'id',
        autoIncrement: true
      });
      messageStore.createIndex('by-date', 'createdAt');

      // State store
      db.createObjectStore('state');

      // Audit log store
      const auditStore = db.createObjectStore('auditLog', {
        keyPath: 'id',
        autoIncrement: true
      });
      auditStore.createIndex('by-timestamp', 'timestamp');
    }
  });
}
```

**Persistence Hook:**

```typescript
// hooks/usePersistence.ts
export function usePersistence() {
  const db = useRef<IDBPDatabase<MCPlatorDB>>();

  useEffect(() => {
    getDB().then((database) => {
      db.current = database;
    });
  }, []);

  const saveMessage = useCallback(async (message: ChatMessage) => {
    if (!db.current) return;
    await db.current.add('messages', message);
  }, []);

  const getMessages = useCallback(async (limit = 50): Promise<ChatMessage[]> => {
    if (!db.current) return [];
    return db.current.getAllFromIndex(
      'messages',
      'by-date',
      undefined,
      limit
    );
  }, []);

  const saveQuota = useCallback(async (quota: DailyQuota) => {
    if (!db.current) return;
    await db.current.put('state', quota, 'dailyQuota');
  }, []);

  const getQuota = useCallback(async (): Promise<DailyQuota | undefined> => {
    if (!db.current) return undefined;
    return db.current.get('state', 'dailyQuota');
  }, []);

  return { saveMessage, getMessages, saveQuota, getQuota };
}
```

### 6. LMCIFY URL Sharing

**Compression and Encoding:**

```typescript
// lib/lmcify.ts
import pako from 'pako';

export function encodeMessage(message: string): string {
  const compressed = pako.gzip(new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...compressed));
}

export function decodeMessage(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const decompressed = pako.ungzip(bytes);
  return new TextDecoder().decode(decompressed);
}

export function createShareURL(message: string): string {
  const encoded = encodeMessage(message);
  return `${window.location.origin}/?lmcify=${encoded}`;
}
```

**Auto-Play on Load:**

```tsx
// hooks/useLMCIFY.ts
export function useLMCIFY() {
  const sendMessage = useChatStore((s) => s.sendMessage);
  const [hasProcessed, setHasProcessed] = useState(false);

  useEffect(() => {
    if (hasProcessed) return;

    const params = new URLSearchParams(window.location.search);
    const lmcify = params.get('lmcify');

    if (lmcify) {
      setHasProcessed(true);

      try {
        const message = decodeMessage(lmcify);
        // Type out the message with animation
        typeMessage(message).then(() => {
          sendMessage(message);
        });
      } catch (error) {
        console.error('Failed to decode LMCIFY:', error);
      }

      // Clean URL
      window.history.replaceState({}, '', '/');
    }
  }, [hasProcessed, sendMessage]);
}

async function typeMessage(message: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#chat-input');
  if (!input) return;

  input.focus();

  for (const char of message) {
    input.value += char;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await delay(50);  // Typing speed
  }
}
```

### 7. Keyboard Navigation and Accessibility

**Keyboard Shortcuts:**

```tsx
// hooks/useKeyboardShortcuts.ts
export function useKeyboardShortcuts() {
  const pressKey = useCalculatorStore((s) => s.pressKey);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't capture if typing in chat input
      if ((e.target as HTMLElement).tagName === 'INPUT') return;

      // Map keyboard to calculator keys
      const keyMap: Record<string, string> = {
        '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
        '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
        '+': '+', '-': '-', '*': '×', '/': '÷',
        'Enter': '=', '=': '=',
        '.': '.', ',': '.',
        'Escape': 'AC', 'Backspace': 'C',
        '%': '%'
      };

      const calcKey = keyMap[e.key];
      if (calcKey) {
        e.preventDefault();
        pressKey(calcKey);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pressKey]);
}
```

**Screen Reader Announcements:**

```tsx
// components/A11y/LiveRegion.tsx
export function LiveRegion() {
  const display = useCalculatorStore((s) => s.display);
  const state = useCalculatorStore((s) => s.state);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (state === 'RESULT') {
      setAnnouncement(`Result: ${display}`);
    } else if (state === 'ERROR') {
      setAnnouncement('Error in calculation');
    }
  }, [display, state]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {announcement}
    </div>
  );
}
```

**Focus Management:**

```tsx
// components/Calculator/KeypadGrid.tsx
export function KeypadGrid() {
  const gridRef = useRef<HTMLDivElement>(null);

  // Arrow key navigation within grid
  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    const cols = 4;
    const buttons = gridRef.current?.querySelectorAll('button');
    if (!buttons) return;

    let nextIndex = index;

    switch (e.key) {
      case 'ArrowUp': nextIndex = index - cols; break;
      case 'ArrowDown': nextIndex = index + cols; break;
      case 'ArrowLeft': nextIndex = index - 1; break;
      case 'ArrowRight': nextIndex = index + 1; break;
      default: return;
    }

    if (nextIndex >= 0 && nextIndex < buttons.length) {
      e.preventDefault();
      (buttons[nextIndex] as HTMLButtonElement).focus();
    }
  };

  return (
    <div ref={gridRef} role="grid" aria-label="Calculator keypad">
      {KEYS.map((key, index) => (
        <CalculatorKey
          key={key.value}
          {...key}
          onKeyDown={(e) => handleKeyDown(e, index)}
        />
      ))}
    </div>
  );
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State Management | Zustand | Redux | Simpler API, less boilerplate |
| Styling | CSS Modules + Tailwind | CSS-in-JS | Better performance, no runtime |
| Persistence | IndexedDB | localStorage | Structured data, larger quota |
| Animations | CSS transitions | Framer Motion | Lighter bundle, sufficient for needs |
| Compression | pako (gzip) | lz-string | Better compression ratio |

## Future Enhancements

1. **Voice Input**: Add speech recognition for hands-free operation
2. **Haptic Feedback**: Vibration on mobile for key presses
3. **Themes**: Switchable calculator skins (scientific, vintage, modern)
4. **History Panel**: Visual history of calculations with replay
5. **PWA**: Offline support with service worker
6. **Scientific Mode**: Advanced functions (sin, cos, log, etc.)
