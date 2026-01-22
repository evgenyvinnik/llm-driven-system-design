# 📅 Google Calendar - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

---

## 🎯 Problem Statement

Design the frontend architecture for a calendar application that allows users to:
- Switch between Month, Week, and Day views seamlessly
- Create, edit, and delete events with real-time feedback
- Visualize scheduling conflicts
- Navigate dates efficiently

---

## 1️⃣ Requirements Clarification (5 minutes)

### ✅ Functional Requirements

| # | Requirement | Description |
|---|-------------|-------------|
| 1 | Three Calendar Views | Month (grid), Week (time columns), Day (single column) |
| 2 | Event Visualization | Display events at correct positions based on time |
| 3 | Event CRUD Modal | Form for creating/editing with conflict warnings |
| 4 | Date Navigation | Previous/Next/Today buttons, mini calendar picker |
| 5 | Multi-Calendar Support | Toggle visibility of different calendars |

### ⚡ Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Responsive | Desktop + Tablet | Mobile as stretch goal |
| Performance | < 100ms view switch | Must feel instant |
| Accessibility | WCAG 2.1 AA | Keyboard nav, screen readers |
| Offline | Show cached events | Queue changes when offline |

### 🎨 UI/UX Requirements

- Consistent design language across views
- Visual feedback for all interactions
- Conflict events highlighted with warning colors
- Drag-and-drop repositioning (stretch goal)

### 🚫 Out of Scope

- Recurring events (RRULE complexity)
- Email/notification integration
- Shared calendar editing

---

## 2️⃣ High-Level Architecture (10 minutes)

### 🏗️ Application Structure

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                          🎨 React Application                                  │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│    ┌─────────────────────────────────────────────────────────────────────┐    │
│    │                    🛤️  TanStack Router                               │    │
│    │    /               → Calendar View (default: Month)                  │    │
│    │    /event/:id      → Event Detail Modal (overlay)                    │    │
│    └─────────────────────────────────────────────────────────────────────┘    │
│                                                                                │
│    ┌──────────────────────┐  ┌────────────────────────────────────────────┐   │
│    │    📋 Sidebar         │  │         📅 Main Calendar Area              │   │
│    │  ┌────────────────┐  │  │  ┌──────────────────────────────────────┐  │   │
│    │  │ Mini Calendar  │  │  │  │     🔀 View Switcher                  │  │   │
│    │  └────────────────┘  │  │  │  [Month] [Week] [Day] | ◀️ Today ▶️   │  │   │
│    │  ┌────────────────┐  │  │  └──────────────────────────────────────┘  │   │
│    │  │ Calendar List  │  │  │  ┌──────────────────────────────────────┐  │   │
│    │  │ ☑️ Work         │  │  │  │                                      │  │   │
│    │  │ ☑️ Personal     │  │  │  │  MonthView / WeekView / DayView      │  │   │
│    │  │ ☐ Holidays     │  │  │  │  (conditional rendering)             │  │   │
│    │  └────────────────┘  │  │  │                                      │  │   │
│    └──────────────────────┘  │  └──────────────────────────────────────┘  │   │
│                                                                                │
│    ┌─────────────────────────────────────────────────────────────────────┐    │
│    │                     📦 Zustand Store                                 │    │
│    │  currentDate | view | events[] | calendars[] | visibleCalendarIds   │    │
│    └─────────────────────────────────────────────────────────────────────┘    │
│                                                                                │
└───────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
             ┌─────────────────────────────────────────────┐
             │           ⚙️ Backend Services                │
             │  • Calendar Service (events CRUD)           │
             │  • Conflict Detection Service               │
             │  • Auth Service (sessions)                  │
             └─────────────────────────────────────────────┘
```

### 🔧 Backend Services Required

| Service | Responsibility |
|---------|----------------|
| 📅 Calendar API | Event CRUD, date range queries, calendar management |
| ⚠️ Conflict Service | Check time overlaps when creating/editing events |
| 🔐 Auth Service | Session management, user authentication |
| 🔄 Sync Service | (Future) Real-time updates via WebSocket |

---

## 3️⃣ Component Architecture (10 minutes)

### 🧩 Component Tree

```
┌───────────────────────────────────────────────────────────────────┐
│                        🏠 App Shell                                │
├───────────────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌────────────────────────────────────────────────┐  │
│  │         │  │             📆 Calendar Header                  │  │
│  │         │  │  ┌──────────────┐  ┌─────────────────────────┐ │  │
│  │ 📋      │  │  │DateNavigator │  │    ViewSwitcher         │ │  │
│  │ Sidebar │  │  │ ◀️ Jan 2025 ▶️│  │  [Month][Week][Day]    │ │  │
│  │         │  │  └──────────────┘  └─────────────────────────┘ │  │
│  │ • Mini  │  ├────────────────────────────────────────────────┤  │
│  │   Cal   │  │                                                │  │
│  │         │  │         📊 CalendarGrid (conditional)           │  │
│  │ • Cal   │  │  ┌──────────────────────────────────────────┐  │  │
│  │   List  │  │  │ MonthView:  7×6 CSS Grid cells           │  │  │
│  │         │  │  │ WeekView:   7 columns + time gutter      │  │  │
│  │         │  │  │ DayView:    1 column + time gutter       │  │  │
│  └─────────┘  │  └──────────────────────────────────────────┘  │  │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │                   📝 EventModal (overlay)                   │   │
│  │   Title, DateTime pickers, Location, ⚠️ ConflictWarning    │   │
│  └────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

### 📦 State Management Design

**Zustand Store Shape:**
- `currentDate` → Currently focused date for navigation
- `view` → 'month' | 'week' | 'day'
- `events[]` → Fetched events for current view range
- `calendars[]` → User's calendars with colors
- `visibleCalendarIds` → Set of toggled-on calendars
- `modalState` → { open, mode, selectedEvent, conflicts }

**Computed Values:**
- `getViewDateRange()` → Returns start/end dates for API queries
- `getVisibleEvents()` → Filters events by visible calendars

### 🔄 Alternatives: State Management

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Zustand** | Minimal boilerplate, selective subscriptions | Extra dependency | ✅ Chosen |
| **React Context** | No dependencies | Re-renders all consumers | ❌ |
| **Redux Toolkit** | Mature ecosystem | Overkill for scope | ❌ |
| **Jotai** | Atomic updates | Learning curve | Future option |

---

## 4️⃣ Deep Dive: Calendar View Rendering (10 minutes)

### 📅 Month View Layout

```
┌───────────────────────────────────────────────────────────────────┐
│  Sun   │   Mon   │   Tue   │   Wed   │   Thu   │   Fri   │  Sat  │
├────────┼─────────┼─────────┼─────────┼─────────┼─────────┼───────┤
│   29   │   30    │    1    │    2    │    3    │    4    │   5   │
│        │         │░░░░░░░░░│         │░░░░░░░░░│         │       │
│        │         │ Meeting │         │ Lunch   │         │       │
├────────┼─────────┼─────────┼─────────┼─────────┼─────────┼───────┤
│    6   │    7    │    8    │    9    │   10    │   11    │  12   │
│░░░░░░░░│         │         │░░░░░░░░░░░░░░░░░░░│         │       │
│Sprint  │         │         │   All-day Event   │         │       │
│        │         │         │ +2 more │         │         │       │
├────────┴─────────┴─────────┴─────────┴─────────┴─────────┴───────┤
│                          ... more weeks ...                       │
└───────────────────────────────────────────────────────────────────┘
```

**Implementation Strategy:**
- 📐 CSS Grid: 7 columns × 6 rows = 42 cells
- 🎨 Event pills: Colored bars with truncated titles
- ➕ Overflow: "+N more" button when > 3 events per day
- 🖱️ Click day: Switch to Day view

### ⏰ Week/Day View Layout

```
        │   Mon 5   │   Tue 6   │   Wed 7   │  ...
────────┼───────────┼───────────┼───────────┼──────
 8:00   │           │░░░░░░░░░░░│           │
        │           │░ Standup ░│           │
 9:00   │░░░░░░░░░░░│░░░░░░░░░░░│           │
        │░ Design  ░│           │           │
10:00   │░ Review  ░│           │░░░░░░░░░░░│
        │░░░░░░░░░░░│           │░ Sprint  ░│
11:00   │           │           │░ Planning░│
        │           │           │░░░░░░░░░░░│
12:00   │───────────│───────────│───────────│
```

**Event Positioning:**
- 📏 Time gutter: Fixed width (~60px)
- 📍 Events: Absolutely positioned within day column
- 📊 Top/height: `(startMinutes / 1440) * 100%`
- 📐 Width: 95% of column (leaves gap for overlaps)

### 🔄 Alternatives: Event Positioning

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Percentage-based** | Responsive, no DOM measurement | Fixed container height | ✅ Chosen |
| **Pixel-based** | Precise control | Needs resize observers | ❌ |
| **CSS Grid subgrid** | Native layout | Limited browser support | Future option |

---

## 5️⃣ Deep Dive: Event Modal & Conflict Detection (5 minutes)

### 📝 Modal Layout

```
┌───────────────────────────────────────────┐
│         ✏️ Create/Edit Event               │
├───────────────────────────────────────────┤
│  Title: [________________________]        │
│                                           │
│  📅 Start: [MM/DD/YYYY] [HH:MM ▼]        │
│  📅 End:   [MM/DD/YYYY] [HH:MM ▼]        │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ ⚠️ Scheduling Conflict              │  │
│  │ • Team Standup (9:00 - 9:30)        │  │
│  │ • 1:1 Meeting (9:15 - 9:45)         │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  📍 Location: [______________________]    │
│  📁 Calendar: [Work ▼]                    │
│                                           │
│         [Cancel]  [💾 Save Event]         │
└───────────────────────────────────────────┘
```

### 🔄 Conflict Detection Flow

1️⃣ User changes start/end time
2️⃣ Debounce 500ms to avoid excessive API calls
3️⃣ Call conflict detection endpoint
4️⃣ Display warning (non-blocking - user can still save)

### 💡 Why Non-Blocking?

- Users may **intentionally** double-book (optional meetings)
- Provides **information** without **friction**
- Alternative: Blocking mode could be a user preference

---

## 6️⃣ Performance Considerations (3 minutes)

### ⚡ Optimizations

| Technique | Purpose |
|-----------|---------|
| **Selective Zustand subscriptions** | Components re-render only when their slice changes |
| **Memoized event filtering** | `useMemo` for visible events calculation |
| **Date range fetching** | API queries only for visible range |
| **AbortController** | Cancel in-flight requests on quick navigation |
| **Virtual scrolling** | Future: Month view with many events |

### 📊 Frontend Cache Layers

```
┌───────────────────────────────────────────────────────────────────┐
│                     🗄️ Frontend Cache Layers                      │
├───────────────────────────────────────────────────────────────────┤
│  📦 Zustand Store                                                  │
│  └─▶ events[] (current view)                                      │
│                                                                    │
│  🔗 API Layer Cache                                                │
│  └─▶ Map<dateRangeKey, events[]>  (cache adjacent weeks/months)   │
│                                                                    │
│  💾 Service Worker (future)                                        │
│  └─▶ IndexedDB for offline access                                 │
└───────────────────────────────────────────────────────────────────┘
```

---

## 7️⃣ Accessibility (2 minutes)

### ♿ Key Considerations

- **Semantic HTML**: `role="grid"` for month view, `role="gridcell"` for days
- **Keyboard Navigation**: Arrow keys for date movement, Enter to select
- **Screen Reader**: "January 21, 3 events. Press Enter to view."
- **Focus Management**: Return focus to trigger after modal closes
- **Color Contrast**: 4.5:1 ratio, don't rely on color alone

### 🔄 Alternatives: Calendar Navigation

| Approach | Accessibility | Complexity | Decision |
|----------|---------------|------------|----------|
| **Roving tabindex** | Excellent | Moderate | ✅ Chosen |
| **All cells focusable** | Good but verbose | Simple | ❌ |
| **aria-activedescendant** | Excellent | Complex | Future option |

---

## 8️⃣ Trade-offs Summary

| Decision | Trade-off |
|----------|-----------|
| 📦 Zustand over Redux | Simpler API vs. smaller ecosystem |
| 📏 Percentage positioning | Responsive vs. requires fixed height |
| 🖥️ Client-side filtering | Instant toggle vs. more memory |
| ⏱️ Debounced conflict check | Fewer API calls vs. slight delay |
| ⚠️ Non-blocking conflicts | Better UX vs. might miss warnings |

---

## 9️⃣ Future Enhancements

1. 🖱️ **Drag & Drop**: React DnD for moving events
2. ↔️ **Event Resize**: Drag edges to change duration
3. 🔁 **Recurring Events**: RRULE parsing for display
4. 📴 **Offline-First**: Service Worker + IndexedDB
5. 🔄 **Real-time Sync**: WebSocket for multi-user
6. 📱 **Mobile Touch**: Swipe gestures for navigation

---

## ❓ Questions I Would Ask

1. Do we need recurring events in this iteration?
2. What's the expected max events per day/week?
3. Is real-time collaboration required?
4. Mobile-first or desktop-first?
5. Should conflicts block creation or just warn?
