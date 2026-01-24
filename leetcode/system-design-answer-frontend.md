# LeetCode (Online Judge) - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

---

## 🎯 Problem Statement

Design the frontend architecture for an online coding practice platform that allows users to:
- Browse and filter coding problems by difficulty and tags
- Write and edit code in a syntax-highlighted editor
- Submit code and view real-time execution results
- Track progress across problems
- Participate in timed contests

---

## 📋 Requirements Clarification

### Functional Requirements

1. **Problem Browser**: Filterable, sortable list of coding problems
2. **Code Editor**: Syntax highlighting, multiple language support, auto-complete
3. **Test Runner**: Execute code against sample test cases
4. **Submission Results**: Real-time status updates with test case details
5. **Progress Dashboard**: Visualize solved problems, streaks, rankings

### Non-Functional Requirements

1. **Responsive**: Support desktop, tablet, and mobile layouts
2. **Performance**: Editor responsive at 60fps, instant UI feedback
3. **Accessibility**: Keyboard navigation, screen reader support
4. **Offline Resilience**: Cache problems for offline viewing

### UI/UX Requirements

- Clean, distraction-free coding environment
- Clear visual feedback for submission status
- Intuitive navigation between problems
- Real-time progress updates without page refresh

---

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            React Application                                 │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                        TanStack Router                                  │ │
│  │    /                    ──▶ Problem List                               │ │
│  │    /problems/:slug      ──▶ Problem Detail + Editor                    │ │
│  │    /submissions         ──▶ Submission History                         │ │
│  │    /progress            ──▶ User Dashboard                             │ │
│  │    /contests/:id        ──▶ Contest View                               │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌───────────────┐  ┌───────────────────────────────────────────────────┐  │
│  │   Sidebar     │  │              Main Content Area                     │  │
│  │  ┌─────────┐  │  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │ Problem │  │  │  │           Problem Description               │  │  │
│  │  │  List   │  │  │  │  - Title, difficulty badge                  │  │  │
│  │  │         │  │  │  │  - Description markdown                     │  │  │
│  │  │ Filters │  │  │  │  - Examples with I/O                        │  │  │
│  │  │ - Easy  │  │  │  └─────────────────────────────────────────────┘  │  │
│  │  │ - Med   │  │  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │ - Hard  │  │  │  │              Code Editor                    │  │  │
│  │  │         │  │  │  │  - Language selector                        │  │  │
│  │  │ Tags    │  │  │  │  - CodeMirror with syntax highlighting     │  │  │
│  │  │ Status  │  │  │  │  - Run / Submit buttons                     │  │  │
│  │  └─────────┘  │  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────┘  │  ┌─────────────────────────────────────────────┐  │  │
│                     │  │           Test Results Panel                │  │  │
│                     │  │  - Status badges (Pass/Fail/TLE/MLE)       │  │  │
│                     │  │  - Expected vs Actual output                │  │  │
│                     │  │  - Runtime and memory stats                 │  │  │
│                     │  └─────────────────────────────────────────────┘  │  │
│                     └───────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         Zustand Store                                   │ │
│  │  problems[] │ submissions[] │ currentCode │ language │ user            │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🔧 Deep Dive: Code Editor Architecture

### CodeMirror 6 Component Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                      CodeEditor Component                        │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    EditorState                              │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │ │
│  │  │ basicSetup   │  │ langExtension│  │    oneDark       │  │ │
│  │  │ (line nums,  │  │ (python/js/  │  │    theme         │  │ │
│  │  │  folding)    │  │  java/cpp)   │  │                  │  │ │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    EditorView                               │ │
│  │  - updateListener ──▶ onChange callback                    │ │
│  │  - lineWrapping                                             │ │
│  │  - Recreates on language change                             │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Trade-off 1: CodeMirror 6 vs Monaco Editor

| Approach | Pros | Cons |
|----------|------|------|
| ✅ CodeMirror 6 | 150KB bundle, excellent mobile, highly customizable | Less IDE-like features |
| ❌ Monaco Editor | Full VS Code experience, IntelliSense, multi-cursor | 2MB bundle, poor mobile support |

> "I chose CodeMirror 6 over Monaco for the code editor, and this decision significantly impacts our frontend architecture. Monaco provides the full VS Code editing experience—IntelliSense, go-to-definition, multi-cursor editing—but at 2MB it would triple our bundle size and dominate our initial load time. For a coding practice platform, Monaco's IntelliSense is actually less useful than it sounds: users implement specific function signatures against known inputs, not exploring unfamiliar APIs. CodeMirror 6's 150KB footprint means our editor loads in under 500ms even on 3G connections. The mobile experience is where CodeMirror truly wins—its touch handling, virtual keyboard interaction, and viewport management are production-ready, while Monaco is effectively unusable on mobile. The trade-off is that power users won't get VS Code muscle memory shortcuts, but we can add common keybindings as CodeMirror extensions. For users who practice during commutes or breaks, mobile support is essential—and Monaco doesn't offer it."

---

## 🔧 Deep Dive: State Management

### Zustand Store Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Zustand Problem Store                        │
│                                                                  │
│  ┌──────────────────────────────┬──────────────────────────────┐│
│  │          State               │           Actions            ││
│  ├──────────────────────────────┼──────────────────────────────┤│
│  │  problems[]                  │  setFilter()                 ││
│  │  filters {                   │  setCurrentProblem()         ││
│  │    difficulty: all/easy/...  │  setLanguage()               ││
│  │    status: all/solved/...    │  setCode()                   ││
│  │    search: string            │  submitCode()                ││
│  │  }                           │                              ││
│  │  currentProblem              │  ┌────────────────────────┐  ││
│  │  currentLanguage             │  │  getFilteredProblems() │  ││
│  │  code: { [slug]: code }      │  │  (computed selector)   │  ││
│  │  submissions[]               │  └────────────────────────┘  ││
│  │  activeSubmission            │                              ││
│  └──────────────────────────────┴──────────────────────────────┘│
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              persist() middleware                           │ │
│  │  Saves to localStorage:                                     │ │
│  │  - code drafts (keyed by problem slug)                      │ │
│  │  - currentLanguage preference                               │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Trade-off 2: Zustand vs Redux vs Context

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Zustand | 1KB, minimal boilerplate, built-in persist | Smaller ecosystem |
| ❌ Redux Toolkit | Mature, large ecosystem, devtools | 7KB, more boilerplate |
| ❌ Context API | Zero dependencies, built-in | Re-renders, no persistence |

> "I chose Zustand with the persist middleware over Redux or Context for state management. The key requirement driving this decision is code draft persistence—users must never lose their work if they accidentally close the browser or navigate away. Redux could achieve this with redux-persist, but that's 3 additional packages (redux, @reduxjs/toolkit, redux-persist) totaling 15KB+ and requiring action creators, reducers, and middleware configuration. Zustand's persist middleware is built-in and configures in 5 lines. Context API would require building persistence from scratch. The trade-off is Redux's richer devtools and middleware ecosystem, but for a coding practice app where state is straightforward (problems, code drafts, submissions), Zustand's simplicity wins. The real architectural benefit is that Zustand doesn't require Provider wrapping, so our component tree stays clean and we avoid the 'provider hell' of combining multiple contexts. For computed values like filtered problem lists, Zustand's selector pattern prevents unnecessary re-renders—only components subscribing to filters re-render when filters change."

---

## 🔧 Deep Dive: Submission Results UI

### Real-time Status Polling Flow

```
┌────────────────┐         ┌────────────────┐         ┌────────────────┐
│   Submit Code  │         │   Backend API  │         │   Job Queue    │
└───────┬────────┘         └───────┬────────┘         └───────┬────────┘
        │                          │                          │
        │  POST /submissions       │                          │
        │─────────────────────────▶│                          │
        │                          │   Queue execution job    │
        │                          │─────────────────────────▶│
        │  { submissionId }        │                          │
        │◀─────────────────────────│                          │
        │                          │                          │
        ├──────────────────────────── POLLING LOOP ───────────┤
        │                          │                          │
        │  GET /status/{id}        │                          │
        │─────────────────────────▶│                          │
        │  { status: "running",    │                          │
        │    currentTest: 3 }      │                          │
        │◀─────────────────────────│                          │
        │                          │                          │
        │  ...poll every 1s...     │                          │
        │                          │                          │
        │  { status: "accepted",   │                          │
        │    runtimeMs: 42 }       │                          │
        │◀─────────────────────────│                          │
        │                          │                          │
        │  STOP POLLING            │                          │
        ▼                          ▼                          ▼
```

### Status Badge Configuration

| Status | Color | Icon | User Message |
|--------|-------|------|--------------|
| accepted | Green | CheckCircle | All tests passed |
| wrong_answer | Red | XCircle | Output mismatch on test N |
| time_limit_exceeded | Yellow | Clock | Solution too slow |
| memory_limit_exceeded | Orange | HardDrive | Memory limit exceeded |
| runtime_error | Red | AlertTriangle | Code crashed |
| compile_error | Purple | AlertCircle | Syntax error |
| pending | Gray | Clock | Waiting in queue |
| running | Blue | Loader (animated) | Running test N of M |

### Trade-off 3: Polling vs WebSocket for Status Updates

| Approach | Pros | Cons |
|----------|------|------|
| ✅ HTTP Polling | Stateless, proxy-friendly, simpler error handling | 1s latency, more requests |
| ❌ WebSocket | Real-time updates, fewer requests | Stateful, reconnection logic needed |

> "I chose HTTP polling over WebSocket for submission status updates. For a code execution flow, the ~1 second polling interval is imperceptible—users expect 2-5 seconds for their code to run anyway. Polling simplifies our frontend architecture significantly: we use a simple useEffect with setInterval, handle errors with standard try/catch, and don't need reconnection logic for network interruptions. WebSocket would require connection state management, heartbeats, and graceful reconnection with exponential backoff. The real killer for WebSocket is corporate environments—many companies' proxies block or interfere with WebSocket connections, but HTTP always works. The trade-off is slightly higher server load, but the backend caches status in Valkey making each poll sub-millisecond. If we later need streaming output (showing compilation errors as they happen), we can upgrade specific flows to WebSocket while keeping the simple polling for status. For 10K concurrent contest users polling every second, that's 10K requests/second to a cached endpoint—easily handled."

---

## 🔧 Deep Dive: Problem List with Virtualization

### TanStack Virtual Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ProblemList Component                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                 Sticky Header (always visible)              │ │
│  │  ┌──────────┬───────────────────┬───────────┬────────────┐ │ │
│  │  │  Status  │       Title       │ Difficulty│ Acceptance │ │ │
│  │  └──────────┴───────────────────┴───────────┴────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              useVirtualizer (TanStack Virtual)              │ │
│  │                                                             │ │
│  │  Total items: 3000 problems                                 │ │
│  │  Rendered: ~15 visible + 10 overscan = 25 DOM nodes         │ │
│  │                                                             │ │
│  │  Viewport: [ row 45 ] [ row 46 ] [ row 47 ] [ row 48 ]     │ │
│  │            ───────────────────────────────────────          │ │
│  │                        visible rows                         │ │
│  │                                                             │ │
│  │  Config:                                                    │ │
│  │  - estimateSize: 56px per row                              │ │
│  │  - overscan: 10 (extra rows above/below)                   │ │
│  │  - getScrollElement: parentRef.current                      │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    ProblemRow (per item)                    │ │
│  │  - StatusIcon (solved/attempted/unsolved)                  │ │
│  │  - Title (clickable link)                                  │ │
│  │  - DifficultyBadge (Easy=green, Medium=yellow, Hard=red)   │ │
│  │  - Acceptance rate percentage                              │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

> "I use TanStack Virtual for the problem list because LeetCode has 3000+ problems. Without virtualization, rendering 3000 table rows creates 3000 DOM nodes—causing multi-second initial render, janky scrolling, and high memory usage. Virtualization renders only visible rows plus overscan buffer (~25 DOM nodes total). The trade-off is implementation complexity: we manage scroll position, calculate which items are visible, and position them with CSS transforms. But for a list that users scroll frequently while searching for problems, smooth 60fps scrolling is essential. The estimateSize of 56px allows fast initial render, and since all rows have identical height, we don't need dynamic measurement."

---

## 🔧 Deep Dive: Resizable Panels

### Split Pane Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ProblemView (react-resizable-panels)             │
│                                                                          │
│  ┌─────────────────────────────┐ ║ ┌─────────────────────────────────┐  │
│  │                             │ ║ │                                 │  │
│  │     Problem Description     │ ║ │         PanelGroup              │  │
│  │                             │ ║ │         (vertical)              │  │
│  │  ┌───────────────────────┐  │ ║ │  ┌───────────────────────────┐ │  │
│  │  │  Title + Difficulty   │  │ R │  │                           │ │  │
│  │  └───────────────────────┘  │ E │  │      Code Editor          │ │  │
│  │                             │ S │  │                           │ │  │
│  │  ┌───────────────────────┐  │ I │  │  ┌─────────────────────┐  │ │  │
│  │  │  Description HTML     │  │ Z │  │  │ Language Selector   │  │ │  │
│  │  │  (markdown rendered)  │  │ E │  │  │ Run / Submit btns   │  │ │  │
│  │  └───────────────────────┘  │   │  │  └─────────────────────┘  │ │  │
│  │                             │ H │  │                           │ │  │
│  │  ┌───────────────────────┐  │ A │  └───────────────────────────┘ │  │
│  │  │  Examples             │  │ N │  ════════════════════════════  │  │
│  │  │  Input → Output       │  │ D │  ┌───────────────────────────┐ │  │
│  │  └───────────────────────┘  │ L │  │      Test Results         │ │  │
│  │                             │ E │  │  - Status banner           │ │  │
│  │  Panel: 40% default         │ ║ │  │  - Runtime/Memory stats    │ │  │
│  │          25% minimum        │ ║ │  │  - Failed test details     │ │  │
│  │                             │ ║ │  └───────────────────────────┘ │  │
│  └─────────────────────────────┘ ║ │  Panel: 60% / 40% split       │  │
│                                  ║ └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

> "I use react-resizable-panels for the split layout because users have different preferences for problem description vs code editor space. Some users want a narrow description panel to maximize coding area; others need full width for complex problem descriptions. The nested PanelGroup creates vertical split within the right panel (editor/results). Panel sizes persist to localStorage so users don't re-adjust every session. The trade-off is an additional dependency and DOM complexity, but this is a core UX pattern for IDE-style interfaces."

---

## ⚡ Deep Dive: Core Web Vitals Optimization

### Target Metrics

| Metric | Target | LeetCode Challenge |
|--------|--------|-------------------|
| **LCP** (Largest Contentful Paint) | < 2.5s | Problem description + code editor |
| **INP** (Interaction to Next Paint) | < 200ms | Submit button, test runs |
| **CLS** (Cumulative Layout Shift) | < 0.1 | Resizable panels, async content |

### Trade-off 4: LCP Optimization Strategy

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Skeleton + streaming | Fast perceived load, progressive | Implementation complexity |
| ❌ Full SSR | Best LCP, SEO | Server complexity, hydration cost |
| ❌ Wait for all data | Simple | Slow LCP, poor perceived perf |

> "For LCP optimization, I chose skeleton screens with streaming data over full SSR or waiting for complete data. The LCP element on our problem page is the problem description panel—a large text block that users need to read before coding. With full SSR, we'd need a Node.js server rendering React, adding deployment complexity and hydration overhead. Instead, we render a skeleton instantly (LCP < 500ms), then stream the problem description from cache. The skeleton maintains the exact layout dimensions, preventing CLS when content arrives. For the code editor (150KB), we lazy-load it with a Suspense boundary showing an editor-shaped skeleton. Users perceive instant load because they see the layout immediately, even though the editor hasn't loaded. The trade-off is that we need careful skeleton design matching final layout—any mismatch causes CLS."

### LCP Optimization Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                    LCP Optimization Pipeline                     │
│                                                                  │
│  T=0ms    Browser receives HTML                                  │
│           ┌─────────────────────────────────────────────────────┐│
│           │  Critical CSS inlined in <head>                     ││
│           │  - Layout grid, skeleton styles                     ││
│           │  - Above-the-fold components                        ││
│           └─────────────────────────────────────────────────────┘│
│                                                                  │
│  T=50ms   First Paint (skeleton visible)                         │
│           ┌───────────────────┬─────────────────────────────────┐│
│           │  Problem Skeleton │  Editor Skeleton (lazy loading) ││
│           │  ████████████████ │  ┌─────────────────────────────┐││
│           │  ████████████████ │  │  Loading editor...          │││
│           │  ████████████     │  │  ██████████████████         │││
│           │                   │  └─────────────────────────────┘││
│           └───────────────────┴─────────────────────────────────┘│
│                                                                  │
│  T=200ms  API response (problem data cached in Valkey)           │
│           Problem description rendered ──▶ LCP COMPLETE          │
│                                                                  │
│  T=400ms  CodeMirror chunk loaded (150KB)                        │
│           Editor replaces skeleton (same dimensions ──▶ no CLS)  │
│                                                                  │
│  T=500ms  Fully interactive                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Critical Rendering Path

```
┌─────────────────────────────────────────────────────────────────┐
│                  Resource Loading Priority                       │
│                                                                  │
│  Preload (in <head>):                                            │
│  ├── Critical CSS (inline)                                       │
│  ├── Main JS bundle (< 50KB gzipped)                            │
│  └── Primary font (system-ui fallback)                          │
│                                                                  │
│  Prefetch (after LCP):                                           │
│  ├── CodeMirror chunk (150KB)                                    │
│  ├── Next problem (prediction based on current)                  │
│  └── User's saved code from localStorage                         │
│                                                                  │
│  Lazy (on demand):                                               │
│  ├── Submission history                                          │
│  ├── Progress dashboard                                          │
│  └── Admin features                                              │
└─────────────────────────────────────────────────────────────────┘
```

### INP (Interaction to Next Paint) Optimization

| Interaction | Target | Optimization |
|-------------|--------|--------------|
| Submit button click | < 50ms | Optimistic UI, defer network |
| Language dropdown | < 30ms | Preloaded options, no network |
| Panel resize | 0ms (60fps) | CSS transforms, no layout |
| Problem filter | < 100ms | In-memory filter, virtual list |

```
┌─────────────────────────────────────────────────────────────────┐
│                  Submit Button Optimization                      │
│                                                                  │
│  Click ──▶ Immediate UI feedback (button disabled, spinner)     │
│       ──▶ State update (optimistic: "Submitting...")            │
│       ──▶ Network request (fire and forget)                     │
│       ──▶ Transition to polling state                           │
│                                                                  │
│  Total time to visual feedback: < 16ms (one frame)              │
│  User perceives instant response                                 │
└─────────────────────────────────────────────────────────────────┘
```

> "INP measures the delay between user interaction and visual feedback. For the submit button, we update UI state synchronously before the network request—the button shows a spinner within 16ms (one frame). The actual submission happens asynchronously. For panel resizing, we use CSS transforms instead of changing width/height properties, enabling GPU-accelerated 60fps animation without triggering layout. The filter input uses in-memory filtering over the already-loaded problem list, avoiding any network latency."

### CLS Prevention

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLS Prevention Strategies                     │
│                                                                  │
│  Problem: Async content shifts layout when it loads              │
│                                                                  │
│  Solution 1: Reserved space with skeletons                       │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  .skeleton-problem-description {                              ││
│  │    min-height: 400px;  /* matches typical problem */         ││
│  │    animation: pulse;                                          ││
│  │  }                                                            ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Solution 2: Resizable panels with fixed initial size            │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  PanelGroup: defaultSize={[40, 60]}                          ││
│  │  Panel: minSize={25}  /* prevents collapse */                ││
│  │  Sizes persisted to localStorage                              ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Solution 3: Font loading with size-adjust                       │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  @font-face { size-adjust: 100.5%; } /* match fallback */    ││
│  │  font-display: swap;  /* show text immediately */            ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Code Splitting Strategy

```
┌────────────────────────────────────────────────────────────┐
│  Route-based Code Splitting                                 │
│                                                             │
│  Bundle                    Size      Load Strategy          │
│  ─────────────────────────────────────────────────────────  │
│  main.js                   45KB      Immediate              │
│  problem-list.js           12KB      Immediate (home route) │
│  problem-view.js           25KB      Lazy (on navigate)     │
│  codemirror-core.js        80KB      Lazy (on problem view) │
│  codemirror-python.js      20KB      Lazy (on lang select)  │
│  codemirror-javascript.js  15KB      Lazy (on lang select)  │
│  submission-history.js     18KB      Lazy (rarely visited)  │
│  admin.js                  35KB      Lazy (admin only)      │
│                                                             │
│  Initial load: 57KB (main + problem-list)                   │
│  Problem page: +105KB (view + editor core)                  │
└────────────────────────────────────────────────────────────┘
```

### Service Worker Caching

```
┌────────────────┐     fetch /api/problems/two-sum     ┌────────────────┐
│    Browser     │────────────────────────────────────▶│  Service Worker│
└────────────────┘                                     └───────┬────────┘
                                                               │
                 ┌─────────────────────────────────────────────┤
                 │                                             │
                 ▼                                             ▼
        ┌────────────────┐                           ┌────────────────┐
        │  Cache Match?  │──── yes ─────────────────▶│ Return cached  │
        └───────┬────────┘                           └────────────────┘
                │ no
                ▼
        ┌────────────────┐     ┌─────────────────────────────────────┐
        │  Network fetch │────▶│  cache.put() + return response      │
        └────────────────┘     └─────────────────────────────────────┘

Caching Strategy:
├── App shell (HTML, CSS, JS): CacheFirst, 7 days
├── Problem data: StaleWhileRevalidate, 1 hour
├── Static assets: CacheFirst, 30 days
└── Submissions: NetworkFirst (must be fresh)
```

### Performance Budget

| Resource | Budget | Actual | Status |
|----------|--------|--------|--------|
| Initial JS | < 100KB | 57KB | ✅ |
| Initial CSS | < 20KB | 12KB | ✅ |
| LCP | < 2.5s | 1.2s | ✅ |
| TTI | < 3.5s | 2.1s | ✅ |
| Total problem page | < 300KB | 162KB | ✅ |

---

## ♿ Accessibility

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl/Cmd + Enter | Submit code |
| Ctrl/Cmd + ' | Run against sample tests |
| Tab | Navigate between UI elements |
| Escape | Close modals/panels |
| Ctrl/Cmd + / | Toggle line comment |
| Ctrl/Cmd + S | Save draft (visual feedback only) |

### ARIA Implementation

| Element | ARIA Attributes | Purpose |
|---------|-----------------|---------|
| Submit button | aria-label, aria-busy, disabled | Announce state to screen readers |
| Status updates | role="status", aria-live="polite" | Announce test progress |
| Problem list | role="table", aria-sort | Sortable table semantics |
| Editor | role="textbox", aria-label | Identify as code input |

---

## ⚖️ Trade-offs Summary

| Decision | Choice | Trade-off |
|----------|--------|-----------|
| Editor | ✅ CodeMirror 6 | Less IDE features vs 10x smaller bundle + mobile |
| State | ✅ Zustand + persist | Smaller ecosystem vs simplicity + persistence |
| Status | ✅ HTTP Polling | 1s latency vs stateless simplicity |
| List | ✅ TanStack Virtual | Implementation complexity vs 60fps scrolling |
| Layout | ✅ Resizable panels | Extra dependency vs user-customizable layout |
| LCP | ✅ Skeleton + streaming | Implementation complexity vs fast perceived load |
| INP | ✅ Optimistic UI | State complexity vs instant feedback |

---

## 🔮 Future Frontend Enhancements

1. **Monaco Editor Option**: Feature flag for power users who want IDE features
2. **WebSocket Upgrade**: Real-time submission status for contests
3. **Collaborative Editing**: Pair programming mode with CRDT
4. **Code Playback**: Step-through execution visualization
5. **Mobile App**: React Native version for on-the-go practice

---

## 📝 Closing Summary

> "I've designed a frontend architecture for an online judge optimized for Core Web Vitals. LCP targets < 2.5s through skeleton screens with streaming data and lazy-loaded CodeMirror (57KB initial load vs 200KB+ with Monaco). INP stays under 200ms via optimistic UI updates—the submit button shows feedback within 16ms, before network requests complete. CLS is prevented through reserved skeleton dimensions and persisted panel sizes. The architecture prioritizes perceived performance: users see a functional layout instantly, with the editor loading progressively. CodeMirror 6's 150KB bundle loads lazily while users read the problem description, making the editor ready by the time they need it. This performance-first approach means mobile users on 3G can start coding within 2 seconds."
