# Google Calendar - System Design Answer

*45-minute system design interview format*

---

## 📋 Introduction

"Today I'll design a calendar application that allows users to view their schedule in Month, Week, and Day views, create and manage events, and receive conflict warnings. The key challenges are efficient time-range queries, responsive event positioning across views, and providing a smooth navigation experience between dates."

---

## 🎯 Requirements

### Functional Requirements
1. User authentication with session management
2. Three calendar views: Month, Week, and Day
3. Event CRUD operations with full form support
4. Conflict detection when creating or editing events
5. Multiple calendars per user with visibility toggles
6. Date navigation (today, previous, next)

### Non-Functional Requirements
1. Low latency for view rendering (< 200ms)
2. Consistent event data across all views
3. Responsive design for desktop and mobile
4. Session persistence across browser sessions

### Out of Scope
- Recurring events (RRULE parsing)
- Event sharing and invitations
- Real-time sync across devices
- Calendar sharing with other users
- Drag-and-drop event moving

---

## 🏗️ High-Level Design

```
+------------------------------------------------------------------+
|                        BROWSER                                    |
|                                                                   |
|  +-------------------------------------------------------------+  |
|  |                   TANSTACK ROUTER                           |  |
|  |   /login    -->  Login Page                                 |  |
|  |   /         -->  Calendar Page (Month/Week/Day)             |  |
|  +-------------------------------------------------------------+  |
|                             |                                     |
|  +-------------------------------------------------------------+  |
|  |                    VIEW LAYER                               |  |
|  |  +-------------+  +-------------+  +-------------+          |  |
|  |  | MonthView   |  | WeekView    |  | DayView     |          |  |
|  |  | (7x6 grid)  |  | (time grid) |  | (hourly)    |          |  |
|  |  +-------------+  +-------------+  +-------------+          |  |
|  |           |              |              |                   |  |
|  |  +------------------------------------------------------+   |  |
|  |  |              ZUSTAND CALENDAR STORE                  |   |  |
|  |  | currentDate | view | events[] | calendars[] | modal  |   |  |
|  |  +------------------------------------------------------+   |  |
|  +-------------------------------------------------------------+  |
|                             |                                     |
+------------------------------------------------------------------+
                              | REST API
                              v
+------------------------------------------------------------------+
|                     API SERVER (Express)                          |
|                                                                   |
|  +-------------------------------------------------------------+  |
|  |                      ROUTES                                 |  |
|  |  /api/auth/*   |  /api/calendars/*  |  /api/events/*       |  |
|  +-------------------------------------------------------------+  |
|                             |                                     |
|  +-------------------------------------------------------------+  |
|  |               CONFLICT SERVICE                              |  |
|  |  checkConflicts(userId, start, end, excludeEventId?)        |  |
|  +-------------------------------------------------------------+  |
|                             |                                     |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
|                       POSTGRESQL                                  |
|  +----------+  +-----------+  +----------+  +----------+         |
|  |  users   |  | calendars |  |  events  |  | sessions |         |
|  +----------+  +-----------+  +----------+  +----------+         |
+------------------------------------------------------------------+
```

---

## 🔍 Deep Dive: Event Positioning in Time Grid

"The most challenging frontend problem is positioning events correctly in Week and Day views."

### Interaction Flow

```
EVENT DATA                    POSITION CALCULATION              RENDERED
    |                               |                              |
    | start: 9:00 AM                |                              |
    | end: 10:30 AM                 |                              |
    +------------------------------>|                              |
    |                               | startMinutes = 540           |
    |                               | endMinutes = 630             |
    |                               | duration = 90 min            |
    |                               |                              |
    |                               | top = 540/1440 = 37.5%       |
    |                               | height = 90/1440 = 6.25%     |
    |                               +----------------------------->|
    |                               |                     +------+ |
    |                               |                     |Event | |
    |                               |                     |Card  | |
    |                               |                     +------+ |
```

### Trade-off 1: Percentage-Based vs Pixel-Based Positioning

| Approach | Responsiveness | Implementation | DOM Dependency |
|----------|----------------|----------------|----------------|
| ✅ **Percentage-based** | Fully responsive | Pure math | None |
| ❌ Pixel-based | Fixed height | Simpler | Requires measurements |
| ❌ Grid rows per hour | Limited precision | CSS-only | None |

**"I'm choosing percentage-based positioning because it requires no DOM measurements and works regardless of container height. The calculation is simple: divide minutes since midnight by 1440 (total minutes per day). This gives us a responsive layout that adapts to any screen size without JavaScript recalculation."**

### Trade-off 2: State Management Library

| Approach | Bundle Size | Boilerplate | DevTools | Persistence |
|----------|-------------|-------------|----------|-------------|
| ✅ **Zustand** | ~2KB | Minimal | Good | Built-in |
| ❌ Redux | ~12KB | High | Excellent | Via middleware |
| ❌ React Context | 0KB | Medium | Limited | Manual |

**"I'm choosing Zustand because our calendar state is interconnected but not overly complex. We need current date, view type, events, calendars, and modal state. Zustand's persist middleware lets us save view preferences to localStorage. Redux would be overkill for this scope."**

---

## 🔍 Deep Dive: Conflict Detection

"When users create or edit events, we check for scheduling conflicts and warn them."

### Conflict Query Flow

```
USER CREATES EVENT              BACKEND                    DATABASE
    |                              |                          |
    | POST /api/events             |                          |
    | {start: 2pm, end: 3pm}       |                          |
    +----------------------------->|                          |
    |                              |                          |
    |                              | Query overlapping events |
    |                              +------------------------->|
    |                              |                          |
    |                              |  SELECT where            |
    |                              |  start < newEnd AND      |
    |                              |  end > newStart          |
    |                              |<-------------------------+
    |                              |                          |
    | { event: {...},              |                          |
    |   conflicts: [{...}, {...}]} |                          |
    |<-----------------------------+                          |
    |                              |                          |
    | Show warning to user         |                          |
    | (don't block creation)       |                          |
```

### Trade-off 3: Blocking vs Non-Blocking Conflicts

| Approach | User Experience | Flexibility | Complexity |
|----------|-----------------|-------------|------------|
| ✅ **Non-blocking (warn)** | Informative | High | Low |
| ❌ Blocking (prevent) | Restrictive | Low | Low |
| ❌ Smart suggestions | Helpful | Medium | High |

**"I'm choosing non-blocking conflict detection because real-world calendars allow overlapping events. A user might intentionally schedule two meetings at the same time to see which one gets confirmed. We inform them of conflicts but let them decide. The API returns both the created event and any conflicting events."**

### Trade-off 4: Overlap Query Strategy

| Approach | Query Complexity | Index Usage | All Cases Covered |
|----------|------------------|-------------|-------------------|
| ✅ **Single range condition** | Simple | Optimal | Yes |
| ❌ Four separate conditions | Verbose | Optimal | Yes |
| ❌ GiST range type | Complex setup | Best | Yes |

**"I'm using a single SQL condition: `start < newEnd AND end > newStart`. This elegantly catches all four overlap scenarios: partial overlap at start, partial at end, complete containment, and being completely contained. The composite index on (calendar_id, start_time, end_time) makes this query efficient."**

---

## 🔍 Deep Dive: View Date Range Optimization

"Each view fetches only the events it needs to display."

### Date Range Calculation

```
MONTH VIEW (October 2024):
+----+----+----+----+----+----+----+
|Sun |Mon |Tue |Wed |Thu |Fri |Sat |
+----+----+----+----+----+----+----+
| 29 | 30 |  1 |  2 |  3 |  4 |  5 |  <-- Includes Sept 29-30
| ...                              |
| 27 | 28 | 29 | 30 | 31 |  1 |  2 |  <-- Includes Nov 1-2
+----+----+----+----+----+----+----+

Fetch range: Sept 29 - Nov 2 (includes visible padding days)

WEEK VIEW:
+----+----+----+----+----+----+----+
|Sun |Mon |Tue |Wed |Thu |Fri |Sat |
| 6  | 7  | 8  | 9  | 10 | 11 | 12 |
+----+----+----+----+----+----+----+

Fetch range: Oct 6 00:00 - Oct 12 23:59

DAY VIEW:
Fetch range: Oct 8 00:00 - Oct 8 23:59
```

### Trade-off 5: Fetch Strategy

| Approach | Network Calls | Data Transferred | Cache Efficiency |
|----------|---------------|------------------|------------------|
| ✅ **View-based range** | Per navigation | Optimal | Good |
| ❌ Fetch all user events | Once | Excessive | N/A |
| ❌ Paginated infinite scroll | Many | Minimal per call | Complex |

**"I'm fetching events based on the visible date range because calendar views have bounded scope. Month view needs about 42 days, week view needs 7, day view needs 1. Fetching all events would transfer unnecessary data and complicate filtering. The store's getViewDateRange() calculates the exact range needed."**

---

## 🔍 Deep Dive: Session Management

### Trade-off 6: Session Storage Backend

| Approach | Latency | Setup Complexity | Transaction Support |
|----------|---------|------------------|---------------------|
| ✅ **PostgreSQL (connect-pg-simple)** | ~5ms | Low | Yes |
| ❌ Redis/Valkey | ~1ms | Additional service | No |
| ❌ In-memory | Instant | None | No |

**"I'm choosing PostgreSQL for session storage using connect-pg-simple. While Redis is faster, the latency difference is negligible for our scale. Using PostgreSQL means one less service to manage and sessions are transactional with user data. The sessions table is auto-cleaned by connect-pg-simple. Valkey is available in docker-compose if we need caching later."**

### Trade-off 7: Authentication Mechanism

| Approach | Simplicity | Security | Scalability |
|----------|------------|----------|-------------|
| ✅ **Session cookies** | High | Good (httpOnly) | Stateful |
| ❌ JWT tokens | Medium | Good | Stateless |
| ❌ OAuth providers | Low | Excellent | Depends on provider |

**"I'm choosing session-based auth because this is a learning project focused on calendar logic, not auth complexity. express-session with httpOnly cookies provides adequate security. JWT would add token refresh logic that distracts from the core calendar features. OAuth would require external service integration."**

---

## 📊 Data Flow

### Complete Event Creation Flow

```
USER                          FRONTEND                    BACKEND
  |                              |                           |
  | Click on time slot           |                           |
  +----------------------------->|                           |
  |                              | Open EventModal           |
  |                              | with pre-filled time      |
  |                              |                           |
  | Fill form and submit         |                           |
  +----------------------------->|                           |
  |                              | POST /api/events          |
  |                              +-------------------------->|
  |                              |                           |
  |                              |     Check conflicts       |
  |                              |     Insert event          |
  |                              |     Return with conflicts |
  |                              |<--------------------------+
  |                              |                           |
  |                              | Update events[]           |
  |                              | Close modal               |
  |                              |                           |
  |   Show conflict warning      |                           |
  |   if conflicts returned      |                           |
  |<-----------------------------+                           |
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/login | Login with username/password |
| POST | /api/auth/logout | End session |
| GET | /api/auth/me | Get current user |
| GET | /api/calendars | List user's calendars |
| POST | /api/calendars | Create new calendar |
| GET | /api/events?start=&end= | Get events in date range |
| POST | /api/events | Create event (returns conflicts) |
| PUT | /api/events/:id | Update event (returns conflicts) |
| DELETE | /api/events/:id | Delete event |

---

## ⚖️ Trade-offs Summary

| Decision | Chosen Approach | Alternative | Why This Choice |
|----------|-----------------|-------------|-----------------|
| Event positioning | Percentage of day | Fixed pixels | Responsive without DOM measurements |
| State management | Zustand | Redux | Simpler API, smaller bundle, built-in persistence |
| Conflict handling | Non-blocking warning | Blocking validation | Users may intentionally double-book |
| Overlap detection | Single SQL condition | Multiple conditions | Elegant, covers all cases |
| Fetch strategy | View-based range | Fetch all | Minimizes data transfer |
| Session storage | PostgreSQL | Redis | Fewer services, transactional |
| Authentication | Sessions | JWT | Simpler for this scope |

---

## 🚀 Future Enhancements

1. **Recurring Events**: Add RRULE parsing for daily, weekly, monthly patterns with exception handling

2. **Drag-and-Drop**: Allow moving events between time slots by dragging

3. **Event Resize**: Drag event edges to change start or end time

4. **Timezone Support**: Store in UTC, display in user's timezone preference

5. **Real-time Sync**: WebSocket connection for multi-device updates

6. **Event Sharing**: Invite other users to events with accept/decline workflow

7. **Calendar Sharing**: Share calendars with read-only or edit permissions

---

## 📝 Summary

"In this calendar design, I've focused on the core challenges of time-based data display and manipulation:

1. **Event positioning** uses percentage-based math to place events in Week/Day views without DOM measurements, enabling a responsive layout

2. **Conflict detection** uses a single elegant SQL condition that catches all overlap scenarios, returning warnings without blocking user actions

3. **View-based fetching** minimizes data transfer by calculating the exact date range needed for each view

4. **Session management** uses PostgreSQL for simplicity, keeping infrastructure minimal while maintaining security with httpOnly cookies

5. **State management** with Zustand provides interconnected calendar state with persistence, without Redux complexity

The architecture supports the three standard calendar views with smooth navigation, event management, and conflict awareness while keeping the implementation focused and maintainable."
