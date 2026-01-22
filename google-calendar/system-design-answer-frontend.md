# Google Calendar - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design the frontend architecture for a calendar application that allows users to:
- Switch between Month, Week, and Day views seamlessly
- Create, edit, and delete events with real-time feedback
- Visualize scheduling conflicts
- Navigate dates efficiently

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements
1. **Three Calendar Views**: Month (grid), Week (time columns), Day (single column)
2. **Event Visualization**: Display events at correct positions based on time
3. **Event CRUD Modal**: Form for creating/editing with conflict warnings
4. **Date Navigation**: Previous/Next/Today buttons, mini calendar picker
5. **Multi-Calendar Support**: Toggle visibility of different calendars

### Non-Functional Requirements
1. **Responsive**: Desktop and tablet layouts (mobile as stretch goal)
2. **Performance**: View switches < 100ms, smooth scrolling with 100+ events
3. **Accessibility**: Keyboard navigation, screen reader support (WCAG 2.1 AA)
4. **Offline Resilience**: Show cached events when offline, queue changes

### UI/UX Requirements
- Consistent design language across views
- Visual feedback for all interactions
- Conflict events highlighted with warning colors
- Drag-and-drop event repositioning (stretch goal)

### Out of Scope
- Recurring events (RRULE complexity)
- Email/notification integration
- Shared calendar editing

---

## 2. High-Level Architecture (10 minutes)

### Application Structure

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          React Application                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│    ┌─────────────────────────────────────────────────────────────────┐  │
│    │                        TanStack Router                           │  │
│    │    /               → Calendar View (default: Month)              │  │
│    │    /event/:id      → Event Detail Modal (overlay)                │  │
│    └─────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│    ┌──────────────────────┐  ┌─────────────────────────────────────┐   │
│    │    Sidebar           │  │       Main Calendar Area            │   │
│    │  ┌────────────────┐  │  │  ┌───────────────────────────────┐  │   │
│    │  │ Mini Calendar  │  │  │  │      View Switcher            │  │   │
│    │  └────────────────┘  │  │  │  [Month] [Week] [Day] | ◄►    │  │   │
│    │  ┌────────────────┐  │  │  └───────────────────────────────┘  │   │
│    │  │ Calendar List  │  │  │  ┌───────────────────────────────┐  │   │
│    │  │ ☑ Work         │  │  │  │                               │  │   │
│    │  │ ☑ Personal     │  │  │  │  MonthView / WeekView /       │  │   │
│    │  │ ☐ Holidays     │  │  │  │  DayView (conditional)        │  │   │
│    │  └────────────────┘  │  │  │                               │  │   │
│    └──────────────────────┘  │  └───────────────────────────────┘  │   │
│                                                                          │
│    ┌─────────────────────────────────────────────────────────────────┐  │
│    │                     Zustand Store                                │  │
│    │  currentDate | view | events[] | calendars[] | visibleIds       │  │
│    └─────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
            ┌───────────────────────────────────────────┐
            │           Backend Services                 │
            │  • Calendar Service (events CRUD)         │
            │  • Conflict Detection Service             │
            │  • Auth Service (sessions)                │
            └───────────────────────────────────────────┘
```

### Backend Services Required (High-Level)

| Service | Responsibility |
|---------|----------------|
| **Calendar API** | Event CRUD, date range queries, calendar management |
| **Conflict Service** | Check time overlaps when creating/editing events |
| **Auth Service** | Session management, user authentication |
| **Sync Service** | (Future) Real-time updates via WebSocket |

---

## 3. Component Architecture (10 minutes)

### Key Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        App Shell                                 │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌──────────────────────────────────────────────┐  │
│  │         │  │             Calendar Header                  │  │
│  │         │  │  ┌──────────────┐  ┌───────────────────────┐ │  │
│  │ Sidebar │  │  │ DateNavigator│  │    ViewSwitcher      │ │  │
│  │         │  │  └──────────────┘  └───────────────────────┘ │  │
│  │         │  ├──────────────────────────────────────────────┤  │
│  │ • Mini  │  │                                              │  │
│  │   Cal   │  │         CalendarGrid (conditional)           │  │
│  │         │  │  ┌────────────────────────────────────────┐  │  │
│  │ • Cal   │  │  │ MonthView:  7×6 CSS Grid cells         │  │  │
│  │   List  │  │  │ WeekView:   7 columns + time gutter    │  │  │
│  │         │  │  │ DayView:    1 column + time gutter     │  │  │
│  │         │  │  └────────────────────────────────────────┘  │  │
│  └─────────┘  └──────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   EventModal (overlay)                    │   │
│  │   Title, DateTime pickers, Location, ConflictWarning     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### State Management Design

**Store Shape (Zustand):**
- `currentDate`: Currently focused date for navigation
- `view`: 'month' | 'week' | 'day'
- `events[]`: Fetched events for current view range
- `calendars[]`: User's calendars with colors
- `visibleCalendarIds`: Set of toggled-on calendars
- `modalState`: { open, mode, selectedEvent, conflicts }

**Computed Values:**
- `getViewDateRange()`: Returns start/end dates for current view (used for API queries)
- `getVisibleEvents()`: Filters events by visible calendars

### Alternatives Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Zustand** | Minimal boilerplate, selective subscriptions | Extra dependency | ✓ Chosen |
| **React Context** | No dependencies | Re-renders all consumers | Rejected |
| **Redux Toolkit** | Mature ecosystem | Overkill for this scope | Rejected |
| **Jotai** | Atomic updates | Learning curve | Rejected |

---

## 4. Deep Dive: Calendar View Rendering (10 minutes)

### Month View Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Sun   │   Mon   │   Tue   │   Wed   │   Thu   │   Fri   │  Sat │
├────────┼─────────┼─────────┼─────────┼─────────┼─────────┼──────┤
│   29   │   30    │    1    │    2    │    3    │    4    │   5  │
│        │         │░░░░░░░░░│         │░░░░░░░░░│         │      │
│        │         │ Meeting │         │ Lunch   │         │      │
├────────┼─────────┼─────────┼─────────┼─────────┼─────────┼──────┤
│    6   │    7    │    8    │    9    │   10    │   11    │  12  │
│░░░░░░░░│         │         │░░░░░░░░░░░░░░░░░░░│         │      │
│Sprint  │         │         │   All-day Event   │         │      │
│        │         │         │░░░░░░░░░░░░░░░░░░░│         │      │
│        │         │         │ +2 more │         │         │      │
├────────┴─────────┴─────────┴─────────┴─────────┴─────────┴──────┤
│                          ... more weeks ...                      │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation Strategy:**
- CSS Grid: `grid-template-columns: repeat(7, 1fr)`
- 6 rows × 7 columns = 42 cells (handles month overflow)
- Event pills: Colored bars with truncated titles
- Overflow: "+N more" button when > 3 events per day

### Week/Day View Layout

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
- Time gutter column (fixed width ~60px)
- Events absolutely positioned within day column
- Top/height calculated as percentage: `(startMinutes / 1440) * 100%`
- Width: 95% of column (leaves gap for overlaps)

### Alternatives for Event Positioning

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Percentage-based** | Responsive, no DOM measurement | Requires fixed container height | ✓ Chosen |
| **Pixel-based** | Precise control | Needs resize observers | Rejected |
| **CSS Grid subgrid** | Native layout | Limited browser support | Future option |

---

## 5. Deep Dive: Event Modal & Conflict Detection (5 minutes)

### Modal Flow

```
┌─────────────────────────────────────────┐
│         Create/Edit Event               │
├─────────────────────────────────────────┤
│  Title: [________________________]      │
│                                         │
│  Start: [MM/DD/YYYY] [HH:MM ▼]         │
│  End:   [MM/DD/YYYY] [HH:MM ▼]         │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ ⚠️ Scheduling Conflict            │  │
│  │ • Team Standup (9:00 - 9:30)      │  │
│  └───────────────────────────────────┘  │
│                                         │
│  Location: [______________________]     │
│  Calendar: [Work ▼]                     │
│                                         │
│         [Cancel]  [Save Event]          │
└─────────────────────────────────────────┘
```

**Conflict Detection Flow:**
1. User changes start/end time
2. Debounce 500ms to avoid excessive API calls
3. Call `GET /api/events/conflicts?start=&end=`
4. Display warning (non-blocking - user can still save)

**Why Non-Blocking?**
- Users may intentionally double-book (e.g., optional meetings)
- Provides information without friction
- Alternative: Blocking mode could be a user preference

---

## 6. Performance Considerations (3 minutes)

### Optimizations

| Technique | Purpose |
|-----------|---------|
| **Selective Zustand subscriptions** | Components only re-render when their subscribed slice changes |
| **Memoized event filtering** | `useMemo` for `getVisibleEvents()` - recalculates only when dependencies change |
| **Date range fetching** | API queries only for visible date range, not all events |
| **AbortController** | Cancel in-flight requests when user navigates quickly |
| **Virtual scrolling** | For future: month view with many events could virtualize |

### Caching Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend Cache Layers                        │
├─────────────────────────────────────────────────────────────────┤
│  Zustand Store                                                   │
│  └── events[] (current view)                                    │
│                                                                  │
│  API Layer Cache                                                 │
│  └── Map<dateRangeKey, events[]>  (cache adjacent weeks/months)│
│                                                                  │
│  Service Worker (future)                                         │
│  └── IndexedDB for offline access                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Accessibility (2 minutes)

### Key Considerations

- **Semantic HTML**: `role="grid"` for month view, `role="gridcell"` for day cells
- **Keyboard Navigation**: Arrow keys for date movement, Enter to select/open
- **Screen Reader Announcements**: "January 21, 3 events. Press Enter to view."
- **Focus Management**: Return focus to trigger after modal closes
- **Color Contrast**: 4.5:1 ratio for text, don't rely on color alone for meaning

### Alternatives for Calendar Navigation

| Approach | Accessibility | Complexity |
|----------|---------------|------------|
| **Roving tabindex** | Excellent | Moderate |
| **All cells focusable** | Good but verbose | Simple |
| **aria-activedescendant** | Excellent | Complex |

---

## 8. Trade-offs Summary

| Decision | Trade-off |
|----------|-----------|
| **Zustand over Redux** | Simpler API vs. smaller ecosystem |
| **Percentage positioning** | Responsive vs. requires fixed height container |
| **Client-side event filtering** | Instant toggle vs. more memory usage |
| **Debounced conflict check** | Fewer API calls vs. slight delay |
| **Non-blocking conflicts** | Better UX vs. user might miss warnings |

---

## 9. Future Enhancements

1. **Drag & Drop Events**: React DnD for moving events between time slots
2. **Event Resize**: Drag event edges to change duration
3. **Recurring Events**: RRULE parsing with expansion for display
4. **Offline-First**: Service Worker + IndexedDB for offline editing
5. **Real-time Sync**: WebSocket for multi-user calendars
6. **Mobile Touch**: Swipe gestures for navigation

---

## Questions I Would Ask

1. Do we need to support recurring events in this iteration?
2. What's the expected max number of events per day/week?
3. Is real-time collaboration required (multiple users editing)?
4. Mobile-first or desktop-first?
5. Should conflicts block event creation or just warn?
