# 📅 Google Calendar - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

---

## 🎯 Problem Statement

Design a calendar application with:
- Month, Week, and Day views
- Event creation, editing, and deletion
- Scheduling conflict detection
- Multiple calendars per user

---

## 1️⃣ Requirements Clarification (5 minutes)

### ✅ Functional Requirements

| # | Requirement | Notes |
|---|-------------|-------|
| 1 | User authentication | Session-based login |
| 2 | Three calendar views | Month grid, Week columns, Day hourly |
| 3 | Event CRUD | Create, read, update, delete |
| 4 | Conflict detection | Warn on overlapping events |
| 5 | Multiple calendars | Toggle visibility per calendar |

### ⚡ Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| **Latency** | View switch < 200ms | Smooth navigation |
| **Consistency** | Strong | No lost events |
| **Availability** | 99.9% reads | Calendar is read-heavy |
| **Responsive** | Desktop + tablet | Wide screen layouts |

### 📊 Scale Estimates

- **Users**: 100K → **5M events** (50 events/user avg)
- **Ratio**: 50:1 read:write
- **Peak**: 10K reads/sec, 200 writes/sec

### 🚫 Out of Scope

- Recurring events (RRULE)
- Calendar sharing
- Email notifications

---

## 2️⃣ High-Level Architecture (10 minutes)

### 🏗️ End-to-End System

```
┌─────────────────────────────────────────────────────────────────┐
│  🌐 BROWSER                                                      │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  🎨 UI LAYER                                               │  │
│  │  MonthView │ WeekView │ DayView │ EventModal │ Sidebar    │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                     │
│  ┌─────────────────────────┴─────────────────────────────────┐  │
│  │  📦 STATE (Zustand)                                        │  │
│  │  currentDate │ view │ events[] │ calendars[] │ modal      │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                     │
│  ┌─────────────────────────┴─────────────────────────────────┐  │
│  │  🔌 API SERVICE                                            │  │
│  │  fetch wrapper with cookies, error handling                │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
└────────────────────────────┼────────────────────────────────────┘
                             │ REST / JSON
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  🖥️ EXPRESS SERVER                                              │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  🛡️ MIDDLEWARE: cors → session → auth → validation        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐  │
│  │ 🔐 Auth    │ │ 📁 Cals    │ │ 📅 Events  │ │ ⚠️ Conflicts│  │
│  │ login     │ │ list       │ │ query      │ │ check       │  │
│  │ logout    │ │ create     │ │ create     │ │ overlap     │  │
│  │ register  │ │ update     │ │ update     │ │             │  │
│  └────────────┘ └────────────┘ └────────────┘ └─────────────┘  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  🗄️ POSTGRESQL                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │  users   │─▶│ calendars│─▶│  events  │  │ sessions │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

### 🔀 Layer Responsibilities

| Layer | Role | Key Concern |
|-------|------|-------------|
| 🎨 UI Components | Render views, handle input | Performance |
| 📦 State Store | Cache data, manage view state | Consistency |
| 🔌 API Service | HTTP requests with auth | Error handling |
| 🖥️ Express Routes | Business logic, validation | Authorization |
| ⚠️ Conflict Service | Time overlap detection | Query efficiency |
| 🗄️ PostgreSQL | Persistent storage | ACID compliance |

---

## 3️⃣ Data Model (5 minutes)

### 📐 Entity Relationships

```
┌─────────────┐       1:N       ┌─────────────┐       1:N       ┌─────────────┐
│   👤 User   │────────────────▶│ 📁 Calendar │────────────────▶│  📅 Event   │
│             │                 │             │                 │             │
│ • id        │                 │ • id        │                 │ • id        │
│ • email     │                 │ • user_id   │                 │ • calendar_id│
│ • timezone  │                 │ • name      │                 │ • title     │
│             │                 │ • color     │                 │ • start     │
│             │                 │ • is_primary│                 │ • end       │
└─────────────┘                 └─────────────┘                 └─────────────┘
```

### 🗂️ Key Tables

| Table | Purpose | Key Index |
|-------|---------|-----------|
| **users** | Account data, timezone pref | email (unique) |
| **calendars** | Multiple cals per user | user_id (FK) |
| **events** | Core event data | (calendar_id, start, end) |
| **sessions** | Server-side auth | sid + expire |

### 🔗 Shared Contracts (Frontend ↔ Backend)

| Type | Key Fields |
|------|------------|
| **Event** | id, calendar_id, title, start_time, end_time |
| **Calendar** | id, name, color, is_primary |
| **Conflict** | id, title, time range, calendar_name |

---

## 4️⃣ Deep Dive: Data Flow (10 minutes)

### 🔄 Event Creation Flow

```
┌────────────────────────────────────────────────────────────────┐
│                    📝 EVENT CREATION FLOW                       │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1️⃣ USER FILLS FORM                                            │
│     └─▶ Title, start time, end time, calendar                  │
│                                                                 │
│  2️⃣ OPTIMISTIC UPDATE                                          │
│     └─▶ Immediately add to UI with temp ID                     │
│     └─▶ Close modal, show event on grid                        │
│                                                                 │
│  3️⃣ API REQUEST (POST /api/events)                             │
│     └─▶ Validate session                                       │
│     └─▶ Verify calendar ownership                              │
│     └─▶ Check conflicts (separate query)                       │
│     └─▶ INSERT event (even if conflicts exist)                 │
│                                                                 │
│  4️⃣ RESPONSE                                                   │
│     └─▶ { event: {...}, conflicts: [...] }                     │
│     └─▶ Replace temp ID with real ID                           │
│     └─▶ Show conflict toast if any                             │
│                                                                 │
│  5️⃣ ERROR ROLLBACK (if failed)                                 │
│     └─▶ Remove optimistic event                                │
│     └─▶ Show error message                                     │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 🔄 Alternatives: Update Strategy

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Optimistic** ⚡ | Instant feedback | Rollback complexity | ✅ Chosen |
| **Pessimistic** 🐢 | Simple, guaranteed | Feels slow | ❌ |
| **Hybrid** | Best of both | Complex | Future |

> 💡 **Rationale**: Calendar ops have low conflict rate. Optimistic feels snappy, rollbacks are rare.

---

## 5️⃣ Deep Dive: Conflict Detection (5 minutes)

### 📐 Time Overlap Logic

```
Two events OVERLAP when their time ranges intersect:

Case 1: Partial overlap      Case 2: Containment
   B: |───────|                 B:   |───|
   A:     |───────|             A: |───────|

✨ Single condition catches all cases:
   (A.start < B.end) AND (A.end > B.start)
```

### 🔄 Full-Stack Conflict Flow

```
┌────────────────────────────────────────────────────────────────┐
│                    ⚠️ CONFLICT DETECTION                        │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  🎨 FRONTEND (EventModal)                                       │
│  ├─▶ User changes start/end time                               │
│  ├─▶ Debounce 500ms                                            │
│  ├─▶ GET /api/events/conflicts?start=...&end=...               │
│  └─▶ Display warning (NON-BLOCKING)                            │
│                                                                 │
│  🖥️ BACKEND (Conflict Service)                                 │
│  ├─▶ Join events → calendars                                   │
│  ├─▶ Filter by user_id                                         │
│  ├─▶ WHERE start < :end AND end > :start                       │
│  └─▶ Return conflicts with calendar colors                     │
│                                                                 │
│  🎨 UI DISPLAY                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ⚠️ 2 conflicts found:                                    │   │
│  │ • Team Standup (Work) 9:00-9:30                         │   │
│  │ • Design Review (Work) 9:15-10:00                       │   │
│  │                                                          │   │
│  │ [Cancel]  [Save Anyway] ← User CAN still save           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 🔄 Alternatives: Conflict Handling

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Warn only** 💛 | Flexible, real-world | May miss warnings | ✅ Chosen |
| **Block** 🛑 | Prevents overlaps | Too restrictive | ❌ |
| **Confirm modal** 🔔 | Explicit ack | Extra friction | User setting |

---

## 6️⃣ View Rendering (5 minutes)

### 📊 Calendar Layout Strategy

```
┌────────────────────────────────────────────────────────────────┐
│                    📅 WEEK VIEW LAYOUT                          │
├─────────┬─────────┬─────────┬─────────┬─────────┬──────────────┤
│  Time   │  Mon    │  Tue    │  Wed    │  Thu    │  Positioning │
├─────────┼─────────┼─────────┼─────────┼─────────┼──────────────┤
│  8:00   │         │ ░░░░░░░ │         │         │              │
│         │         │░Standup░│         │         │  top = start │
│  9:00   │ ░░░░░░░ │ ░░░░░░░ │         │         │       ÷ 1440 │
│         │░ Design░│         │         │         │       × 100% │
│  10:00  │░ Review░│         │ ░░░░░░░ │         │              │
│         │ ░░░░░░░ │         │░ Sprint░│         │  height =    │
│  11:00  │         │         │░Planning│         │  duration    │
│         │         │         │ ░░░░░░░ │         │  ÷ 1440×100% │
└─────────┴─────────┴─────────┴─────────┴─────────┴──────────────┘

Events: Absolutely positioned within day columns
Container: 100% height = 24 hours (1440 minutes)
```

### 📋 View Comparison

| View | Layout | Best For |
|------|--------|----------|
| 📆 **Month** | 7×6 CSS Grid | Planning, overview |
| 📊 **Week** | 7 columns + time gutter | Weekly scheduling |
| 📋 **Day** | Single column + time gutter | Detailed day view |

### 🔄 Alternatives: Positioning

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Percentage CSS** | Responsive | Fixed height container | ✅ Chosen |
| **Pixel JS** | Precise | Resize observers needed | ❌ |
| **CSS Subgrid** | Native | Browser support | Future |

---

## 7️⃣ Session Management (3 minutes)

### 🔐 Authentication Flow

```
┌────────────────────────────────────────────────────────────────┐
│                    🔐 SESSION AUTH FLOW                         │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  LOGIN                                                          │
│  ┌─────────┐   POST /login    ┌─────────┐   Set-Cookie         │
│  │ Browser │ ───────────────▶ │ Express │ ──────────────────▶  │
│  └─────────┘  {user, pass}    └────┬────┘   sid=xxx; httpOnly  │
│                                    │                            │
│                                    ▼                            │
│                              ┌──────────┐                       │
│                              │ sessions │ ← Store in PostgreSQL │
│                              └──────────┘                       │
│                                                                 │
│  SUBSEQUENT REQUESTS                                            │
│  ┌─────────┐   Cookie: sid    ┌─────────┐                       │
│  │ Browser │ ───────────────▶ │ Express │ → Lookup session     │
│  └─────────┘   GET /events    └─────────┘   → req.userId       │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 🔄 Alternatives: Session Storage

| Approach | Latency | Scalability | Decision |
|----------|---------|-------------|----------|
| **PostgreSQL** 🐘 | ~5ms | Moderate | ✅ Simple |
| **Redis/Valkey** ⚡ | ~1ms | High | Scaling option |
| **JWT** 🎫 | 0ms | Unlimited | ❌ Revocation issues |

---

## 8️⃣ State Management (3 minutes)

### 📦 Frontend Store Structure

```
┌────────────────────────────────────────────────────────────────┐
│                    📦 ZUSTAND STORE                             │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  📍 NAVIGATION                                                  │
│  ├── currentDate     → focused date                            │
│  ├── view            → 'month' | 'week' | 'day'                │
│  └── isLoading       → fetch state                             │
│                                                                 │
│  📊 DATA                                                        │
│  ├── events[]        → fetched for current range               │
│  ├── calendars[]     → user's calendar list                    │
│  └── visibleIds      → toggled calendars                       │
│                                                                 │
│  🪟 MODAL                                                       │
│  ├── isOpen          → show/hide                               │
│  ├── selectedEvent   → for editing                             │
│  └── conflicts[]     → real-time detection                     │
│                                                                 │
│  📐 COMPUTED                                                    │
│  ├── getViewDateRange()  → { start, end } for API             │
│  └── getVisibleEvents()  → filtered by visibility             │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 🔄 Alternatives: State Management

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Zustand** 🐻 | Minimal boilerplate | Extra dep | ✅ Chosen |
| **Context** ⚛️ | Built-in | Re-renders all | ❌ |
| **Redux** 🔴 | Mature ecosystem | Overkill | ❌ |

---

## 9️⃣ Trade-offs Summary

| Decision | Trade-off |
|----------|-----------|
| 🐘 PostgreSQL over NoSQL | Strong consistency ↔ Write scaling |
| 💛 Non-blocking conflicts | Flexibility ↔ Missed warnings |
| ⚡ Optimistic updates | Instant UI ↔ Rollback complexity |
| 🔐 PostgreSQL sessions | Simple ops ↔ Slower than Redis |
| ⏱️ Debounced conflict check | Fewer API calls ↔ 500ms delay |

---

## 🔟 Scalability Path

### Current: Simple Stack

```
Browser → Express (1 node) → PostgreSQL
```

### Future: Scaled Stack

```
                        ┌─────────────────────────┐
                        │   🌐 CDN (static)       │
                        └────────────┬────────────┘
                                     │
Browser ────────▶ Load Balancer ────▶ Express (N nodes)
                                     │
                   ┌─────────────────┼─────────────────┐
                   │                 │                 │
                   ▼                 ▼                 ▼
            ┌──────────┐      ┌──────────┐      ┌──────────┐
            │  Valkey  │      │  Primary │      │ Replicas │
            │ sessions │      │    DB    │      │  (reads) │
            └──────────┘      └──────────┘      └──────────┘
```

### 📈 Scaling Triggers

| Trigger | Action |
|---------|--------|
| > 10K users | Sessions → Valkey |
| > 100K reads/sec | Add read replicas |
| > 1M users | Shard by user_id |
| Global reach | Multi-region |

---

## 🚀 Future Enhancements

1. 🔁 **Recurring events** - RRULE parsing
2. 🖱️ **Drag & drop** - Move/resize events
3. ⚡ **Real-time sync** - WebSocket updates
4. 👥 **Event sharing** - Invites with RSVP
5. 📴 **Offline support** - Service Worker + IndexedDB

---

## ❓ Questions I Would Ask

1. 📊 **Scale target?** → Affects session store, sharding
2. ⚡ **Real-time collab?** → WebSocket vs polling
3. 🛑 **Conflicts block or warn?** → User preference
4. 📱 **Mobile-first?** → Layout priorities
5. 🌍 **Timezone complexity?** → User locations
