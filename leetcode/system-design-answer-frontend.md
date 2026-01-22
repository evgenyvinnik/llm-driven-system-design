# LeetCode (Online Judge) - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design the frontend architecture for an online coding practice platform that allows users to:
- Browse and filter coding problems by difficulty and tags
- Write and edit code in a syntax-highlighted editor
- Submit code and view real-time execution results
- Track progress across problems
- Participate in timed contests

## Requirements Clarification

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

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            React Application                                 │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        React Router DOM                                 │  │
│  │    /                    ──▶ Problem List                               │  │
│  │    /problems/:slug      ──▶ Problem Detail + Editor                    │  │
│  │    /submissions         ──▶ Submission History                         │  │
│  │    /progress            ──▶ User Dashboard                             │  │
│  │    /contests/:id        ──▶ Contest View                               │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────┐  ┌───────────────────────────────────────────────────┐   │
│  │   Sidebar     │  │              Main Content Area                     │   │
│  │  ┌─────────┐  │  │  ┌─────────────────────────────────────────────┐  │   │
│  │  │ Problem │  │  │  │           Problem Description               │  │   │
│  │  │  List   │  │  │  │  - Title, difficulty badge                  │  │   │
│  │  │         │  │  │  │  - Description markdown                     │  │   │
│  │  │ Filters │  │  │  │  - Examples with I/O                        │  │   │
│  │  │ - Easy  │  │  │  └─────────────────────────────────────────────┘  │   │
│  │  │ - Med   │  │  │  ┌─────────────────────────────────────────────┐  │   │
│  │  │ - Hard  │  │  │  │              Code Editor                    │  │   │
│  │  │         │  │  │  │  - Language selector                        │  │   │
│  │  │ Tags    │  │  │  │  - CodeMirror with syntax highlighting     │  │   │
│  │  │ Status  │  │  │  │  - Run / Submit buttons                     │  │   │
│  │  └─────────┘  │  │  └─────────────────────────────────────────────┘  │   │
│  └───────────────┘  │  ┌─────────────────────────────────────────────┐  │   │
│                     │  │           Test Results Panel                │  │   │
│                     │  │  - Status badges (Pass/Fail/TLE/MLE)       │  │   │
│                     │  │  - Expected vs Actual output                │  │   │
│                     │  │  - Runtime and memory stats                 │  │   │
│                     │  └─────────────────────────────────────────────┘  │   │
│                     └───────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                         Zustand Store                                   │  │
│  │  problems[] │ submissions[] │ currentCode │ language │ user            │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Code Editor Integration

### CodeMirror 6 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      CodeEditor Component                        │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    EditorState                              │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │  │
│  │  │ basicSetup   │  │ langExtension│  │    oneDark       │  │  │
│  │  │ (line nums,  │  │ (python/js/  │  │    theme         │  │  │
│  │  │  folding)    │  │  java/cpp)   │  │                  │  │  │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    EditorView                               │  │
│  │  - updateListener ──▶ onChange callback                    │  │
│  │  - lineWrapping                                             │  │
│  │  - Recreates on language change                             │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

"I chose CodeMirror 6 because it offers the best balance of features, bundle size, and mobile support for a LeetCode-style editor."

### Why CodeMirror 6?

| Factor | CodeMirror 6 | Monaco Editor | Ace Editor |
|--------|--------------|---------------|------------|
| Bundle size | ~150KB | ~2MB | ~500KB |
| Mobile support | Excellent | Poor | Moderate |
| Customization | Excellent | Moderate | Good |
| TypeScript | Built-in | Excellent | Good |
| Performance | Excellent | Good | Good |

---

## Deep Dive: State Management with Zustand

### Store Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Zustand Problem Store                        │
│                                                                  │
│  ┌──────────────────────────────┬──────────────────────────────┐ │
│  │          State               │           Actions            │ │
│  ├──────────────────────────────┼──────────────────────────────┤ │
│  │  problems[]                  │  setFilter()                 │ │
│  │  filters {                   │  setCurrentProblem()         │ │
│  │    difficulty: all/easy/...  │  setLanguage()               │ │
│  │    status: all/solved/...    │  setCode()                   │ │
│  │    search: string            │  submitCode()                │ │
│  │  }                           │                              │ │
│  │  currentProblem              │  ┌────────────────────────┐  │ │
│  │  currentLanguage             │  │  getFilteredProblems() │  │ │
│  │  code: { [slug]: code }      │  │  (computed selector)   │  │ │
│  │  submissions[]               │  └────────────────────────┘  │ │
│  │  activeSubmission            │                              │ │
│  └──────────────────────────────┴──────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              persist() middleware                           │  │
│  │  Saves to localStorage:                                     │  │
│  │  - code (drafts)                                            │  │
│  │  - currentLanguage                                          │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

"I used Zustand with persist middleware because it automatically saves code drafts to localStorage, preventing data loss."

### Why Zustand with Persist?

| Factor | Zustand | Redux | Context |
|--------|---------|-------|---------|
| Boilerplate | Minimal | Heavy | Moderate |
| Persistence | Built-in middleware | External | Manual |
| DevTools | Built-in | Built-in | Manual |
| Bundle size | 1KB | 7KB | 0KB |
| Code draft saving | Easy with persist | Possible | Manual |

---

## Deep Dive: Submission Results UI

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
        ├──────────────────────────────────────────────────────┤
        │                   POLLING LOOP                       │
        ├──────────────────────────────────────────────────────┤
        │                          │                          │
        │  GET /status/{id}        │                          │
        │─────────────────────────▶│                          │
        │  { status: "running",    │                          │
        │    current_test: 3 }     │                          │
        │◀─────────────────────────│                          │
        │                          │                          │
        │  ... poll every 1s ...   │                          │
        │                          │                          │
        │  GET /status/{id}        │                          │
        │─────────────────────────▶│                          │
        │  { status: "accepted",   │                          │
        │    runtime_ms: 42,       │                          │
        │    memory_kb: 1024 }     │                          │
        │◀─────────────────────────│                          │
        │                          │                          │
        │  STOP POLLING            │                          │
        ▼                          ▼                          ▼
```

### Status Badge Configuration

| Status | Color | Icon | Description |
|--------|-------|------|-------------|
| accepted | Green | CheckCircle | All tests passed |
| wrong_answer | Red | XCircle | Output mismatch |
| time_limit_exceeded | Yellow | Clock | Too slow |
| memory_limit_exceeded | Orange | HardDrive | Too much memory |
| runtime_error | Red | AlertTriangle | Crash during execution |
| compile_error | Purple | AlertCircle | Code won't compile |
| pending | Gray | Clock | Waiting in queue |
| running | Blue | Loader | Currently executing |

---

## Deep Dive: Problem List with Virtualization

### Virtualized Table Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ProblemList Component                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                 Sticky Header (always visible)              │  │
│  │  ┌──────────┬───────────────────┬───────────┬────────────┐ │  │
│  │  │  Status  │       Title       │ Difficulty│ Acceptance │ │  │
│  │  └──────────┴───────────────────┴───────────┴────────────┘ │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              useVirtualizer (TanStack Virtual)              │  │
│  │                                                             │  │
│  │  Viewport: [ row 45 ] [ row 46 ] [ row 47 ] [ row 48 ]     │  │
│  │            ───────────────────────────────────────          │  │
│  │                        visible rows                         │  │
│  │                                                             │  │
│  │  Config:                                                    │  │
│  │  - estimateSize: 56px per row                              │  │
│  │  - overscan: 10 (extra rows above/below)                   │  │
│  │  - virtualizer.getTotalSize() for container height         │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    ProblemRow (per item)                    │  │
│  │  - StatusIcon (solved/attempted/unsolved)                  │  │
│  │  - Title (clickable)                                        │  │
│  │  - DifficultyBadge (Easy=green, Medium=yellow, Hard=red)   │  │
│  │  - Acceptance rate                                          │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Resizable Panels

### Split Pane Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ProblemView (react-resizable-panels)             │
│                                                                          │
│  ┌─────────────────────────────┐  │  ┌─────────────────────────────────┐│
│  │                             │  │  │                                 ││
│  │     Problem Description     │  │  │         PanelGroup              ││
│  │                             │  │  │         (vertical)              ││
│  │  ┌───────────────────────┐  │  │  │  ┌───────────────────────────┐ ││
│  │  │  Title + Difficulty   │  │  R  │  │                           │ ││
│  │  └───────────────────────┘  │  E  │  │      Code Editor          │ ││
│  │                             │  S  │  │                           │ ││
│  │  ┌───────────────────────┐  │  I  │  │  ┌─────────────────────┐  │ ││
│  │  │  Description HTML     │  │  Z  │  │  │ Language Selector   │  │ ││
│  │  │  (prose styling)      │  │  E  │  │  │ Run / Submit btns   │  │ ││
│  │  └───────────────────────┘  │  │  │  │  └─────────────────────┘  │ ││
│  │                             │  H  │  │                           │ ││
│  │  ┌───────────────────────┐  │  A  │  └───────────────────────────┘ ││
│  │  │  Examples             │  │  N  │  ─────────────────────────────  ││
│  │  │  Input → Output       │  │  D  │  ┌───────────────────────────┐ ││
│  │  └───────────────────────┘  │  L  │  │      Test Results         │ ││
│  │                             │  E  │  │  - StatusBanner            │ ││
│  │  Panel: 40% default         │  │  │  │  - Runtime/Memory stats    │ ││
│  │          25% minimum        │  │  │  │  - Failed test details     │ ││
│  │                             │  │  │  └───────────────────────────┘ ││
│  └─────────────────────────────┘  │  │  Panel: 60% / 40% split       ││
│                                   │  └─────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Performance Optimizations

### 1. Code Draft Debouncing

```
┌────────────────┐     keystroke      ┌─────────────────┐
│  CodeEditor    │───────────────────▶│  draftRef.curr  │
│  onChange      │                    │  (in-memory)    │
└────────────────┘                    └────────┬────────┘
                                               │
                                      500ms debounce
                                               │
                                               ▼
                                      ┌─────────────────┐
                                      │  setCode()      │
                                      │  (Zustand +     │
                                      │   localStorage) │
                                      └─────────────────┘
```

### 2. Lazy Loading

```
┌────────────────────────────────────────────────────────────┐
│  Route: /problems/:slug                                     │
│                                                             │
│  ┌────────────────┐    ┌─────────────────────────────────┐ │
│  │   Suspense     │───▶│  lazy(() => import(CodeEditor)) │ │
│  │   fallback:    │    │                                 │ │
│  │   EditorSkel   │    │  Only loads when route matches  │ │
│  └────────────────┘    └─────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

### 3. Service Worker Caching

```
┌────────────────┐     fetch /api/problems/two-sum     ┌────────────────┐
│    Browser     │────────────────────────────────────▶│  Service Worker│
└────────────────┘                                     └───────┬────────┘
                                                               │
                 ┌─────────────────────────────────────────────┤
                 │                                             │
                 ▼                                             ▼
        ┌────────────────┐                           ┌────────────────┐
        │  Cache Match?  │──── yes ──────────────────│ Return cached  │
        └───────┬────────┘                           └────────────────┘
                │ no
                ▼
        ┌────────────────┐     ┌─────────────────────────────────────┐
        │  Network fetch │────▶│  cache.put() + return response      │
        └────────────────┘     └─────────────────────────────────────┘
```

---

## Accessibility (a11y)

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl/Cmd + Enter | Submit code |
| Ctrl/Cmd + ' | Run code |
| Tab | Navigate between UI elements |
| Escape | Close modals/panels |

### ARIA Implementation

```
┌─────────────────────────────────────────────────────────────────┐
│                    Accessibility Structure                       │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  <button aria-label="Submit code for evaluation"         │   │
│  │          aria-busy={isSubmitting}                         │   │
│  │          disabled={isSubmitting}>                         │   │
│  │    Submit                                                  │   │
│  │  </button>                                                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  <div role="status"                                       │   │
│  │       aria-live="polite"                                   │   │
│  │       aria-label="Test {current} of {total} running">     │   │
│  │    {status content}                                        │   │
│  │  </div>                                                    │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| CodeMirror 6 | Small bundle, mobile-friendly | Less IDE-like than Monaco |
| Zustand with persist | Auto-save drafts, simple API | Extra dependency |
| Polling vs WebSocket | Simpler, works behind firewalls | 1s latency |
| Virtualized list | Handles 1000+ problems | More complex implementation |
| Resizable panels | Flexible layout | Adds library dependency |

---

## Future Frontend Enhancements

1. **Monaco Editor Option**: For power users who want IDE features
2. **WebSocket Updates**: Real-time submission status without polling
3. **Collaborative Editing**: Pair programming mode
4. **Code Playback**: Step-through execution visualization
5. **Mobile App**: React Native version for on-the-go practice
