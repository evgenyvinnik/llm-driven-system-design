# Twitter - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
- **Timeline**: Infinite scroll feed of tweets from followed users
- **Tweet Composition**: 280-character limit with media attachments
- **Engagement**: Like, retweet, reply with optimistic updates
- **Profile**: User page with tweets, followers, following
- **Trending**: Real-time popular topics sidebar
- **Search**: Hashtag and user search

### Non-Functional Requirements
- **Performance**: < 100ms perceived timeline load
- **Responsiveness**: Mobile-first, desktop-enhanced
- **Accessibility**: Screen reader support, keyboard navigation
- **Real-time**: Updates without page refresh

### UI/UX Priorities
1. Content-first timeline with minimal chrome
2. Quick compose always accessible
3. Engagement actions visible but not intrusive
4. Trending topics contextually available

---

## 2. Component Architecture (5 minutes)

### Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────────┐
│  App                                                                 │
│  ├── Header                                                         │
│  │   ├── Logo                                                       │
│  │   ├── SearchBar (autocomplete)                                   │
│  │   └── UserMenu (compose, profile, settings)                      │
│  ├── Layout (3-column on desktop)                                   │
│  │   ├── LeftSidebar                                                │
│  │   │   ├── NavLinks (Home, Explore, Notifications, Profile)       │
│  │   │   └── TweetButton                                            │
│  │   ├── MainContent                                                │
│  │   │   └── Routes                                                 │
│  │   │       ├── HomeTimeline                                       │
│  │   │       ├── ExplorePage                                        │
│  │   │       ├── ProfilePage                                        │
│  │   │       └── TweetDetail                                        │
│  │   └── RightSidebar                                               │
│  │       ├── TrendingTopics                                         │
│  │       └── WhoToFollow                                            │
│  └── ComposeModal (global)                                          │
└─────────────────────────────────────────────────────────────────────┘
```

### State Management Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Zustand Stores                                 │
├─────────────────────────────────────────────────────────────────────┤
│  AuthStore           │  TimelineStore        │  UIStore             │
│  - user              │  - tweets[]           │  - composeOpen       │
│  - isAuthenticated   │  - hasMore            │  - activeTab         │
│  - login/logout      │  - fetchTimeline()    │  - theme             │
├─────────────────────────────────────────────────────────────────────┤
│  EngagementStore     │  TrendingStore                               │
│  - likes: Set        │  - trends[]                                  │
│  - retweets: Set     │  - loading                                   │
│  - toggleLike()      │  - fetchTrends()                             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Timeline Component with Virtualization (10 minutes)

### Why Virtualization

Twitter timelines can have thousands of tweets. Without virtualization:
- 200 tweets = 1200+ DOM nodes
- Memory usage 150MB+
- Scroll jank after 50 tweets

With virtualization:
- ~80 DOM nodes regardless of list size
- Memory usage ~60MB
- Smooth scrolling throughout

### Virtualized Timeline Implementation

**Timeline Component Structure:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Timeline Props                                                      │
├─────────────────────────────────────────────────────────────────────┤
│  tweets: Tweet[]                                                     │
│  isLoading: boolean                                                  │
│  onLoadMore: () => void                                              │
│  hasMore: boolean                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Virtualizer Configuration:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  useVirtualizer({                                                    │
│    count: tweets.length,                                             │
│    getScrollElement: () => parentRef.current,                        │
│    estimateSize: () => 150,  // Average tweet height                 │
│    overscan: 5,              // Extra items above/below              │
│    measureElement: (el) => el.getBoundingClientRect().height         │
│  })                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

**Infinite Scroll Trigger:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  useEffect: Watch virtual items                                      │
├─────────────────────────────────────────────────────────────────────┤
│  lastItem = virtualItems[virtualItems.length - 1]                    │
│                                                                      │
│  IF lastItem.index >= tweets.length - 5                              │
│     AND hasMore                                                      │
│     AND NOT isLoading:                                               │
│       onLoadMore()                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

**Virtual Container Structure:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  <div ref={parentRef} class="timeline-scroll-container">            │
│    <div style={{ height: totalSize, position: relative }}>          │
│      {virtualItems.map(item => (                                     │
│        <div                                                          │
│          key={item.key}                                              │
│          data-index={item.index}                                     │
│          ref={measureElement}                                        │
│          style={{                                                    │
│            position: absolute,                                       │
│            transform: translateY(item.start)                         │
│          }}                                                          │
│        >                                                             │
│          <Tweet tweet={tweets[item.index]} />                        │
│        </div>                                                        │
│      ))}                                                             │
│    </div>                                                            │
│    {isLoading && <Spinner />}                                        │
│  </div>                                                              │
└─────────────────────────────────────────────────────────────────────┘
```

### Tweet Component

**Tweet Structure:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Tweet (article, memo for performance)                               │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────┐  ┌──────────────────────────────────────────────────────┐ │
│  │Avatar│  │ Header: DisplayName @username · timestamp             │ │
│  │      │  ├──────────────────────────────────────────────────────┤ │
│  │      │  │ Content: parsed text with #hashtags @mentions URLs   │ │
│  │      │  ├──────────────────────────────────────────────────────┤ │
│  │      │  │ Actions: [Reply] [Retweet] [Like] [Share]            │ │
│  └──────┘  └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**Memoization Strategy:**

```
memo(Tweet, (prev, next) => prev.tweet.id === next.tweet.id)
```

"I memoize Tweet by id only because engagement state comes from a separate store. When likes/retweets change, the component re-renders via the store hook, not props."

### Content Parsing with Hashtag Links

**parseContent() Function:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Input: "Check out #React and @dan_abramov https://react.dev"       │
├─────────────────────────────────────────────────────────────────────┤
│  Regex: /(#\w+)|(@\w+)|(https?:\/\/\S+)/g                           │
├─────────────────────────────────────────────────────────────────────┤
│  Output Parts:                                                       │
│  ├── "Check out "                                                   │
│  ├── <Link to="/hashtag/React">#React</Link>                        │
│  ├── " and "                                                        │
│  ├── <Link to="/profile/dan_abramov">@dan_abramov</Link>            │
│  ├── " "                                                            │
│  └── <a href="https://react.dev">react.dev</a>                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Optimistic Updates for Engagement (8 minutes)

### Engagement Store with Optimistic State

**EngagementStore Structure:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                     EngagementState                                  │
├─────────────────────────────────────────────────────────────────────┤
│  Data                                                                │
│  ├── likes: Set<string>           (tweet IDs user has liked)        │
│  ├── retweets: Set<string>        (tweet IDs user has retweeted)    │
│  ├── pendingLikes: Set<string>    (in-flight like requests)         │
│  └── pendingRetweets: Set<string> (in-flight retweet requests)      │
├─────────────────────────────────────────────────────────────────────┤
│  Actions                                                             │
│  ├── toggleLike(tweetId) ──▶ optimistic like/unlike                 │
│  ├── toggleRetweet(tweetId) ──▶ optimistic retweet/unretweet        │
│  └── initFromServer(likedIds, retweetedIds) ──▶ hydrate from API    │
└─────────────────────────────────────────────────────────────────────┘
```

**toggleLike() Flow:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  toggleLike(tweetId)                                                 │
├─────────────────────────────────────────────────────────────────────┤
│  1. Check pending - if already in-flight, return                     │
│                                                                      │
│  2. Read current state                                               │
│     isCurrentlyLiked = likes.has(tweetId)                            │
│                                                                      │
│  3. Optimistic update                                                │
│     ┌─────────────────────────────────────────────────────────────┐ │
│     │ IF isCurrentlyLiked: likes.delete(tweetId)                   │ │
│     │ ELSE: likes.add(tweetId)                                     │ │
│     │ pendingLikes.add(tweetId)                                    │ │
│     └─────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  4. API call                                                         │
│     try {                                                            │
│       await api.likeTweet(tweetId) or api.unlikeTweet(tweetId)      │
│     } catch {                                                        │
│       // Rollback                                                    │
│       IF isCurrentlyLiked: likes.add(tweetId)                        │
│       ELSE: likes.delete(tweetId)                                    │
│     } finally {                                                      │
│       pendingLikes.delete(tweetId)                                   │
│     }                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

### Action Button with Animation

**ActionButton Props:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  ActionButtonProps                                                   │
├─────────────────────────────────────────────────────────────────────┤
│  icon: React.ReactNode                                               │
│  count?: number                                                      │
│  active?: boolean                                                    │
│  activeColor?: string                                                │
│  onClick?: () => void                                                │
│  label: string                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

**Animation Behavior:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  onClick Handler                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  1. e.stopPropagation() - prevent tweet click navigation             │
│  2. setIsAnimating(true)                                             │
│  3. call onClick()                                                   │
│  4. setTimeout(() => setIsAnimating(false), 300)                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Count Formatting:**

```
formatCount(count):
  >= 1,000,000 ──▶ "1.5M"
  >= 1,000 ──▶ "15.2K"
  else ──▶ "999"
```

### CSS Animations

**Pop Animation (for like/retweet):**

```
@keyframes pop:
  0%   { transform: scale(1) }
  50%  { transform: scale(1.3) }
  100% { transform: scale(1) }

.animate-pop { animation: pop 0.3s ease-out }
```

**Heart Fill Animation:**

```
@keyframes heart-fill:
  0%   { transform: scale(0); opacity: 0 }
  50%  { transform: scale(1.2); opacity: 1 }
  100% { transform: scale(1); opacity: 1 }

.heart-icon.filled {
  animation: heart-fill 0.3s ease-out;
  fill: #F91880;
}
```

**Brand Colors:**

```
┌────────────────────────┬──────────┐
│ --twitter-blue         │ #1DA1F2  │
│ --twitter-dark-blue    │ #1A91DA  │
│ --twitter-black        │ #0F1419  │
│ --twitter-gray         │ #536471  │
│ --twitter-like         │ #F91880  │
│ --twitter-retweet      │ #00BA7C  │
└────────────────────────┴──────────┘
```

---

## 5. Compose Tweet Component (5 minutes)

### Character Counter and Validation

**ComposeTweet State:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  content: string                                                     │
│  remaining = MAX_LENGTH (280) - content.length                       │
│  isOverLimit = remaining < 0                                         │
│  isNearLimit = remaining <= 20 && remaining >= 0                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Auto-resize Textarea:**

```
onChange Handler:
  1. setContent(e.target.value)
  2. textarea.style.height = 'auto'
  3. textarea.style.height = textarea.scrollHeight + 'px'
```

**Submit Flow:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  handleSubmit()                                                      │
├─────────────────────────────────────────────────────────────────────┤
│  IF content.trim() AND NOT isOverLimit:                              │
│    1. createTweetMutation.mutate(content)                            │
│    2. onSuccess: setContent(''), invalidate ['timeline', 'home']    │
└─────────────────────────────────────────────────────────────────────┘
```

**Compose Layout:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  ┌────────┐  ┌────────────────────────────────────────────────────┐ │
│  │ Avatar │  │ <textarea placeholder="What's happening?">        │ │
│  │        │  │                                                    │ │
│  │        │  ├────────────────────────────────────────────────────┤ │
│  │        │  │ [Image] [GIF] [Emoji]     [Counter] [Tweet Button]│ │
│  └────────┘  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**CharacterCounter Component:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  IF remaining > 20: return null (don't show)                         │
│                                                                      │
│  IF remaining < 0:                                                   │
│    Show red text: "-5"                                               │
│  ELSE:                                                               │
│    Show SVG circle with stroke-dasharray                             │
│    Color: yellow if near limit, blue otherwise                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Trending Sidebar (5 minutes)

### Trending Topics Component

**TrendingSidebar Data Fetching:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  useQuery({                                                          │
│    queryKey: ['trends'],                                             │
│    queryFn: () => api.getTrends(),                                   │
│    refetchInterval: 60000,  // Refresh every minute                  │
│    staleTime: 30000,        // Consider fresh for 30s                │
│  })                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

**Trend Item Structure:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  <Link to="/hashtag/$tag">                                           │
│    ├── trend-meta: "Trending" #1                                    │
│    ├── trend-hashtag: #JavaScript                                   │
│    └── trend-count: 15.2K Tweets                                    │
│  </Link>                                                             │
└─────────────────────────────────────────────────────────────────────┘
```

**Sidebar Layout:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Trends for you                                                      │
├─────────────────────────────────────────────────────────────────────┤
│  Trending · #1                                                       │
│  #JavaScript                                                         │
│  125K Tweets                                                         │
├─────────────────────────────────────────────────────────────────────┤
│  Trending · #2                                                       │
│  #TypeScript                                                         │
│  89.5K Tweets                                                        │
├─────────────────────────────────────────────────────────────────────┤
│  ... more trends                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  Show more                                                           │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. Responsive Layout (5 minutes)

### Three-Column Desktop, Single Column Mobile

**Layout Component:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  <div class="layout">                                                │
│    <LeftSidebar />                                                  │
│    <main class="main-content">{children}</main>                     │
│    <RightSidebar />                                                 │
│  </div>                                                              │
└─────────────────────────────────────────────────────────────────────┘
```

**Responsive Breakpoints:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Mobile (< 640px):                                                   │
│  ├── layout: single column                                          │
│  ├── left-sidebar: hidden                                           │
│  └── right-sidebar: hidden                                          │
├─────────────────────────────────────────────────────────────────────┤
│  Tablet (>= 640px):                                                  │
│  ├── grid-template-columns: 88px 1fr                                │
│  ├── left-sidebar: sticky, icon-only nav                            │
│  └── right-sidebar: hidden                                          │
├─────────────────────────────────────────────────────────────────────┤
│  Desktop (>= 1024px):                                                │
│  ├── grid-template-columns: 275px 600px 350px                       │
│  ├── left-sidebar: full nav with labels                             │
│  └── right-sidebar: visible                                         │
├─────────────────────────────────────────────────────────────────────┤
│  Large Desktop (>= 1280px):                                          │
│  ├── grid-template-columns: 275px 600px 1fr                         │
│  └── right-sidebar: max-width 350px                                 │
└─────────────────────────────────────────────────────────────────────┘
```

**Main Content Styling:**

```
.main-content {
  min-height: 100vh;
  border-left: 1px solid var(--twitter-light-gray);
  border-right: 1px solid var(--twitter-light-gray);
}
```

---

## 8. Accessibility Features (4 minutes)

### ARIA Labels and Roles

**Accessible Tweet Structure:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  <article aria-label="Tweet by {displayName}">                       │
│    <div aria-hidden="true">                                         │
│      <img src={avatarUrl} alt="" />  <!-- Decorative -->            │
│    </div>                                                            │
│    <div>                                                             │
│      <header>                                                        │
│        <span>{displayName}</span>                                   │
│        <span aria-label="username {username}">@{username}</span>    │
│        <time dateTime={createdAt} title={fullDate}>                 │
│          {relativeTime}                                              │
│        </time>                                                       │
│      </header>                                                       │
│      <p>{content}</p>                                                │
│      <footer role="group" aria-label="Tweet actions">               │
│        <ActionButton label="Reply, {count} replies" />              │
│        <ActionButton label="Retweet" aria-pressed={isRetweeted} /> │
│        <ActionButton label="Like" aria-pressed={isLiked} />        │
│      </footer>                                                       │
│    </div>                                                            │
│  </article>                                                          │
└─────────────────────────────────────────────────────────────────────┘
```

### Keyboard Navigation

**Timeline Keyboard Shortcuts:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Key          │ Action                                              │
├───────────────┼─────────────────────────────────────────────────────┤
│  ArrowDown, j │ Focus next tweet                                    │
│  ArrowUp, k   │ Focus previous tweet                                │
│  l            │ Like focused tweet                                  │
│  r            │ Reply to focused tweet                              │
└─────────────────────────────────────────────────────────────────────┘
```

**Focus Management:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. Track focusedIndex in state                                      │
│  2. Store refs to all tweet elements                                 │
│  3. On key press: update focusedIndex                                │
│  4. useEffect: tweetRefs[focusedIndex].focus()                      │
│  5. Use tabIndex={focusedIndex === index ? 0 : -1} for roving       │
└─────────────────────────────────────────────────────────────────────┘
```

**Timeline Container:**

```
<div role="feed" aria-label="Timeline" onKeyDown={handleKeyDown} tabIndex={0}>
  {tweets.map((tweet, index) => (
    <Tweet
      ref={el => tweetRefs.current[index] = el}
      tabIndex={index === focusedIndex ? 0 : -1}
    />
  ))}
</div>
```

---

## 9. Summary (3 minutes)

### Key Frontend Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Virtualization | @tanstack/react-virtual | Handle thousands of tweets efficiently |
| State | Zustand + React Query | Simple state + server cache separation |
| Optimistic Updates | Local Set tracking | Instant feedback, rollback on failure |
| Styling | Tailwind + CSS Variables | Rapid development with brand consistency |
| Routing | TanStack Router | File-based, type-safe routing |

### Performance Metrics

| Metric | Target | Implementation |
|--------|--------|----------------|
| Initial Load | < 1.5s | Code splitting, lazy routes |
| Timeline Render | < 100ms | Virtualization, memoization |
| Engagement Action | < 50ms | Optimistic updates |
| Scroll Performance | 60fps | Only ~80 DOM nodes |

### Trade-offs Made

1. **Virtualization complexity** vs. simple list - chose virtualization for scale
2. **Optimistic updates** vs. wait for server - chose optimism for better UX
3. **Character counter** as SVG circle vs. text - chose visual for Twitter feel
4. **Memoized tweets** - chose memoization to prevent unnecessary re-renders

### What Would Be Different at Scale

1. **Server-side rendering**: Initial timeline rendered on server
2. **Service workers**: Offline timeline access, background sync
3. **Media CDN**: Image optimization, lazy loading with blur placeholders
4. **WebSocket**: Real-time timeline updates, live engagement counts
5. **Internationalization**: RTL support, localized timestamps
