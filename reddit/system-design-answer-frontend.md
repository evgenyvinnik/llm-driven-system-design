# Reddit - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing Reddit, a community-driven content platform where users submit posts, vote on content, and engage in threaded discussions. As a frontend engineer, I'll focus on rendering nested comment trees efficiently, optimistic voting updates, infinite scroll feeds with virtualization, and responsive layouts for community-driven content. Let me clarify the requirements."

---

## 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Feed Display** - Show posts sorted by hot, new, top, controversial
2. **Voting Interface** - Upvote/downvote with instant visual feedback
3. **Comment Threading** - Display nested comments with proper indentation
4. **Subreddit Navigation** - Browse and subscribe to communities
5. **Post Creation** - Text, link, and media post composition
6. **User Profiles** - Display karma, post history, settings

### Non-Functional Requirements

- **Performance** - Feed loads under 100ms, smooth scrolling
- **Accessibility** - Screen reader support, keyboard navigation
- **Responsive** - Desktop, tablet, and mobile layouts
- **Offline Support** - Basic read functionality when disconnected

### Frontend-Specific Considerations

- Optimistic updates for votes (immediate UI feedback)
- Virtualized lists for feeds with thousands of posts
- Recursive component rendering for comment trees
- Collapse/expand state management for threads

---

## 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                      Browser Application                        │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    React + Vite                          │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │  TanStack   │  │  Zustand    │  │  TanStack       │  │   │
│  │  │  Router     │  │  Store      │  │  Virtual        │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌───────────────────────────┼─────────────────────────────┐   │
│  │                   Component Tree                         │   │
│  │                                                          │   │
│  │  ┌──────────────────────────────────────────────────┐   │   │
│  │  │  Layout (Header, Sidebar, Main)                   │   │   │
│  │  │  ├── Feed (PostList, Virtualized)                │   │   │
│  │  │  ├── PostDetail (Post + CommentTree)             │   │   │
│  │  │  ├── CommentTree (Recursive CommentNode)         │   │   │
│  │  │  └── Voting (VoteButton, ScoreDisplay)           │   │   │
│  │  └──────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌───────────────────────────┼─────────────────────────────┐   │
│  │                    API Layer                             │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │  Fetch      │  │  Cache      │  │  Optimistic     │  │   │
│  │  │  Client     │  │  Layer      │  │  Updates        │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   Backend API   │
                    │   /api/...      │
                    └─────────────────┘
```

### Core Components

| Component | Purpose | Key Features |
|-----------|---------|--------------|
| Feed | Display sorted posts | Virtualization, infinite scroll |
| PostCard | Individual post display | Vote buttons, metadata, preview |
| CommentTree | Nested comment rendering | Recursive, collapsible |
| VoteButton | Voting interaction | Optimistic updates, animations |
| CommentComposer | New comment input | Rich text, preview |

---

## 3. Deep Dive: Comment Tree Rendering (10 minutes)

### Recursive Comment Component

**Comment Data Structure:**

| Field | Type | Purpose |
|-------|------|---------|
| id | number | Unique identifier |
| parentId | number or null | Parent comment (null = root) |
| path | string | Materialized path: "1.5.23.102" |
| depth | number | Nesting level |
| content | string | Comment body (Markdown) |
| authorName | string | Author username |
| score | number | Net votes |
| upvotes | number | Total upvotes |
| downvotes | number | Total downvotes |
| createdAt | string | Timestamp |
| children | Comment[] | Nested replies |

**CommentNode Component Responsibilities:**

1. Render comment with proper indentation (depth * 16px)
2. Display thread line for visual hierarchy (clickable to collapse)
3. Show header: collapse toggle, author, score, timestamp
4. Render content with Markdown support
5. Display action bar: vote buttons, reply, share, report
6. Show reply composer when reply button clicked
7. Recursively render children
8. Display "Continue thread" link at max depth (10)

**Thread Line Behavior:**
```
┌─────────────────────────────────────────────────────────┐
│  Parent Comment                                          │
│  │                                                       │
│  ├── Child Comment 1                                    │
│  │   │                                                   │
│  │   └── Grandchild                                     │
│  │                                                       │
│  └── Child Comment 2                                    │
│                                                          │
│  [Click thread line to collapse entire subtree]          │
└─────────────────────────────────────────────────────────┘
```

### Building Tree from Flat Data

The backend returns comments sorted by path. Client builds tree structure:

**Algorithm (Two-Pass):**
1. First pass: Create map of id -> comment, initialize children arrays
2. Second pass: For each comment, add to parent's children or roots array
3. Handle orphaned comments (deleted parent) by treating as root

**Time Complexity:** O(n) where n = comment count

### Virtualization for Large Threads

For posts with thousands of comments, virtualize the visible portion:

**Approach:**
1. Flatten tree to array while preserving visual order (DFS)
2. Use TanStack Virtual with dynamic height estimation
3. Measure actual element height after render
4. Overscan: 5 items for smooth scrolling

**Estimate Size Function:**
- Base height: 80px (header + actions)
- Content height: ceil(content.length / 80) * 20px
- Result: Good approximation, refined on measurement

**Why Flatten for Virtualization:**
- Virtualizer needs linear list, not tree
- Preserve visual order: parent before children
- Maintain depth info for indentation

---

## 4. Deep Dive: Voting System (8 minutes)

### Optimistic Voting with Zustand

**Vote State Structure:**

| Field | Type | Purpose |
|-------|------|---------|
| postVotes | Map<id, {direction, score}> | Post vote states |
| commentVotes | Map<id, {direction, score}> | Comment vote states |
| pendingVotes | Set<string> | IDs currently syncing |

**Vote Action Flow:**
```
┌──────────────────────────────────────────────────────────────┐
│  User clicks vote                                             │
│         │                                                     │
│         ▼                                                     │
│  ┌─────────────────┐                                         │
│  │ Calculate delta │  oldDirection -> newDirection           │
│  │ and new score   │  scoreDelta = newDirection - old        │
│  └────────┬────────┘                                         │
│           ▼                                                   │
│  ┌─────────────────┐                                         │
│  │ Optimistic      │  Update store immediately               │
│  │ update UI       │  Add to pendingVotes                    │
│  └────────┬────────┘                                         │
│           ▼                                                   │
│  ┌─────────────────┐                                         │
│  │ POST /vote      │  Send to server                         │
│  └────────┬────────┘                                         │
│           │                                                   │
│     ┌─────┴─────┐                                            │
│     ▼           ▼                                             │
│  Success     Failure                                          │
│     │           │                                             │
│     ▼           ▼                                             │
│  Remove     ┌─────────────────┐                              │
│  pending    │ Revert to       │                              │
│             │ previous state  │                              │
│             │ Show error toast│                              │
│             └─────────────────┘                              │
└──────────────────────────────────────────────────────────────┘
```

**Toggle Behavior:**
- Click same direction = remove vote (direction: 0)
- Click opposite = switch vote
- Score updates calculated from delta

### Vote Button Component

**Visual States:**

| State | Upvote Style | Downvote Style | Score Style |
|-------|--------------|----------------|-------------|
| No vote | Gray | Gray | Default |
| Upvoted | Orange fill | Gray | Orange |
| Downvoted | Gray | Blue fill | Blue |
| Pending | Opacity 60% | Opacity 60% | Opacity 60% |

**Score Formatting:**
- >= 10,000: Show as "10.0k"
- < 10,000: Show exact number

**Accessibility:**
- role="group" with aria-label
- Each button has aria-label and aria-pressed
- Score has aria-live="polite" for screen reader updates

### Vote Animation CSS

**Button Hover:** Color transition 0.15s
**Button Active:** Scale 1.2
**Score Change:** Keyframe animation
- 0%: scale(1)
- 50%: scale(1.2)
- 100%: scale(1)

---

## 5. Deep Dive: Feed Rendering (8 minutes)

### Infinite Scroll with Virtualization

**Feed Architecture:**
```
┌─────────────────────────────────────────────────────────┐
│  PostFeed Component                                      │
│                                                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │  useInfiniteQuery (TanStack Query)                 │  │
│  │  - Fetch pages of posts                            │  │
│  │  - Track hasNextPage                               │  │
│  │  - Merge pages into allPosts                       │  │
│  └───────────────────────────────────────────────────┘  │
│                          │                               │
│                          ▼                               │
│  ┌───────────────────────────────────────────────────┐  │
│  │  useVirtualizer                                    │  │
│  │  - count: allPosts.length + (hasNext ? 1 : 0)     │  │
│  │  - estimateSize: 150px                             │  │
│  │  - overscan: 3                                     │  │
│  │  - measureElement for dynamic heights              │  │
│  └───────────────────────────────────────────────────┘  │
│                          │                               │
│                          ▼                               │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Render virtual items                              │  │
│  │  - Position: absolute with transform               │  │
│  │  - Last item triggers fetchNextPage                │  │
│  │  - Loading spinner for loader item                 │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Infinite Scroll Trigger:**
- Check if last visible item index >= allPosts.length - 1
- If hasNextPage and not fetching, call fetchNextPage

### Post Card Component

**PostCard Layout:**
```
┌──────────────────────────────────────────────────────────┐
│  ┌────┐  ┌─────────────────────────────────────────────┐ │
│  │ ▲  │  │  Post Title (link domain)                   │ │
│  │ 42 │  ├─────────────────────────────────────────────┤ │
│  │ ▼  │  │  r/subreddit • Posted by u/author • 2h ago  │ │
│  └────┘  ├─────────────────────────────────────────────┤ │
│          │  Preview text (truncated to 200 chars)...   │ │
│          ├─────────────────────────────────────────────┤ │
│          │  💬 42 comments  🔗 Share  ⭐ Save           │ │
│          └─────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**Clickable Regions:**
- Entire card: Navigate to post detail
- Vote buttons: Prevent propagation, handle vote
- Subreddit link: Navigate to subreddit
- Stats buttons: Context-specific actions

**Thumbnail:**
- Lazy loading with loading="lazy"
- Empty alt for decorative images

---

## 6. Deep Dive: Sort Controls (4 minutes)

### Sort Tabs Component

**Sort Options:**

| Key | Label | Icon | Algorithm |
|-----|-------|------|-----------|
| hot | Hot | Flame | Recency + popularity balanced |
| new | New | Sparkle | Pure chronological |
| top | Top | Trophy | Highest score (with time filter) |
| controversial | Controversial | Swords | High engagement, balanced votes |

**Time Filter (for Top sort):**

| Value | Label |
|-------|-------|
| hour | Past Hour |
| day | Today |
| week | This Week |
| month | This Month |
| year | This Year |
| all | All Time |

**Accessibility:**
- role="tablist" on container
- role="tab" on each button
- aria-selected for active state

---

## 7. Zustand Store Architecture

**Store Slices:**

| Slice | State | Purpose |
|-------|-------|---------|
| User | user, isAuthenticated | Auth state |
| Subscriptions | subscriptions[] | Joined subreddits |
| UI | sidebarOpen, theme | Layout preferences |

**Persisted State:**
- theme (light/dark/system)
- sidebarOpen
- Stored in localStorage via persist middleware

**Actions:**

| Action | Effect |
|--------|--------|
| login(credentials) | Set user, fetch subscriptions |
| logout() | Clear user, subscriptions |
| subscribe(subredditId) | Add to subscriptions, POST to API |
| unsubscribe(subredditId) | Remove from subscriptions, DELETE to API |
| toggleSidebar() | Toggle sidebarOpen |
| setTheme(theme) | Update theme preference |

---

## 8. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Comment rendering | Recursive components | Deep trees may hit stack | Iterative with stack |
| Virtualization | TanStack Virtual | Complex state | Render all (memory issues) |
| Voting | Optimistic updates | May show wrong count briefly | Wait for server (slow UX) |
| Tree building | Client-side from flat | Extra processing | Server builds tree (larger payload) |
| Collapse state | Local component state | Lost on navigation | Global store (complexity) |

---

## 9. Accessibility Considerations

### Keyboard Navigation

**Vim-Style Shortcuts:**

| Key | Action |
|-----|--------|
| j | Focus next sibling comment |
| k | Focus previous sibling comment |
| l | Focus first child comment |
| h | Focus parent comment |
| Enter | Toggle collapse |
| a | Upvote |
| z | Downvote |
| r | Open reply box |

**Implementation:**
- Listen for keydown on document
- Check if activeElement is within .comment-node
- Find target element via DOM traversal
- Focus or trigger click on target

**Semantic Structure:**
- Comments use role="article"
- aria-label="Comment by {author}"
- Collapse toggle has aria-expanded
- Thread lines have aria-label for collapse action

---

## 10. Future Enhancements

1. **Rich Text Editor** - WYSIWYG comment composer with markdown preview
2. **Real-time Updates** - WebSocket for live vote counts and new comments
3. **Offline Support** - Service worker for cached feed reading
4. **Image Galleries** - Lightbox for multi-image posts
5. **Mod Tools** - Inline moderation actions with confirmation

---

## Summary

"To summarize, I've designed Reddit's frontend with:

1. **Recursive comment tree rendering** - Components recursively render nested comments with proper indentation, collapse/expand state, and depth limits with 'continue thread' links.

2. **Optimistic voting** - Vote changes reflect immediately in the UI using Zustand, with automatic rollback on server errors.

3. **Virtualized feeds** - TanStack Virtual renders only visible posts and comments, enabling smooth scrolling through thousands of items.

4. **Keyboard navigation** - Full keyboard support for power users to navigate and interact with comments.

The key challenge was balancing tree complexity with performance. By virtualizing the flattened tree and using recursive components for rendering, we get both the natural tree structure and efficient scrolling."
