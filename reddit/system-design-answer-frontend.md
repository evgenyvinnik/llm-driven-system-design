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

```tsx
// components/CommentNode.tsx
interface Comment {
  id: number;
  parentId: number | null;
  path: string;
  depth: number;
  content: string;
  authorName: string;
  score: number;
  upvotes: number;
  downvotes: number;
  createdAt: string;
  children?: Comment[];
}

interface CommentNodeProps {
  comment: Comment;
  onVote: (commentId: number, direction: 1 | -1 | 0) => void;
  onReply: (parentId: number) => void;
  maxDepth?: number;
}

export function CommentNode({
  comment,
  onVote,
  onReply,
  maxDepth = 10
}: CommentNodeProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showReplyBox, setShowReplyBox] = useState(false);

  const indentWidth = Math.min(comment.depth, maxDepth) * 16;
  const isMaxDepth = comment.depth >= maxDepth;

  return (
    <div
      className="comment-node"
      style={{ marginLeft: `${indentWidth}px` }}
      role="article"
      aria-label={`Comment by ${comment.authorName}`}
    >
      {/* Thread line for visual hierarchy */}
      {comment.depth > 0 && (
        <div
          className="thread-line"
          style={{ left: `${indentWidth - 12}px` }}
          onClick={() => setIsCollapsed(!isCollapsed)}
          aria-label={isCollapsed ? 'Expand thread' : 'Collapse thread'}
        />
      )}

      {/* Comment header */}
      <div className="comment-header">
        <button
          className="collapse-toggle"
          onClick={() => setIsCollapsed(!isCollapsed)}
          aria-expanded={!isCollapsed}
        >
          [{isCollapsed ? '+' : '-'}]
        </button>
        <span className="author">{comment.authorName}</span>
        <span className="score">{comment.score} points</span>
        <span className="time">
          <TimeAgo date={comment.createdAt} />
        </span>
      </div>

      {!isCollapsed && (
        <>
          {/* Comment content */}
          <div className="comment-content">
            <Markdown>{comment.content}</Markdown>
          </div>

          {/* Action bar */}
          <div className="comment-actions">
            <VoteButtons
              score={comment.score}
              onUpvote={() => onVote(comment.id, 1)}
              onDownvote={() => onVote(comment.id, -1)}
            />
            <button onClick={() => setShowReplyBox(true)}>Reply</button>
            <button>Share</button>
            <button>Report</button>
          </div>

          {/* Reply composer */}
          {showReplyBox && (
            <CommentComposer
              parentId={comment.id}
              onSubmit={(content) => {
                onReply(comment.id);
                setShowReplyBox(false);
              }}
              onCancel={() => setShowReplyBox(false)}
            />
          )}

          {/* Render children recursively */}
          {comment.children?.map((child) => (
            <CommentNode
              key={child.id}
              comment={child}
              onVote={onVote}
              onReply={onReply}
              maxDepth={maxDepth}
            />
          ))}

          {/* Continue thread link for deep nesting */}
          {isMaxDepth && comment.children && comment.children.length > 0 && (
            <Link
              to={`/comments/${comment.id}`}
              className="continue-thread"
            >
              Continue this thread →
            </Link>
          )}
        </>
      )}
    </div>
  );
}
```

### Building Tree from Flat Data

The backend returns comments sorted by path. We need to build a tree structure:

```typescript
// utils/buildCommentTree.ts
export function buildCommentTree(comments: Comment[]): Comment[] {
  const map = new Map<number, Comment>();
  const roots: Comment[] = [];

  // First pass: create map and initialize children arrays
  for (const comment of comments) {
    map.set(comment.id, { ...comment, children: [] });
  }

  // Second pass: build tree structure
  for (const comment of comments) {
    const node = map.get(comment.id)!;

    if (comment.parentId === null) {
      roots.push(node);
    } else {
      const parent = map.get(comment.parentId);
      if (parent) {
        parent.children!.push(node);
      } else {
        // Orphaned comment (parent deleted), treat as root
        roots.push(node);
      }
    }
  }

  return roots;
}
```

### Virtualization for Large Threads

For posts with thousands of comments, we virtualize the visible portion:

```tsx
// components/VirtualizedCommentTree.tsx
import { useVirtualizer } from '@tanstack/react-virtual';

export function VirtualizedCommentTree({ comments }: { comments: Comment[] }) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Flatten tree for virtualization while preserving order
  const flatComments = useMemo(() =>
    flattenTree(comments), [comments]
  );

  const virtualizer = useVirtualizer({
    count: flatComments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      // Estimate based on content length and depth
      const comment = flatComments[index];
      const baseHeight = 80;
      const contentHeight = Math.ceil(comment.content.length / 80) * 20;
      return baseHeight + contentHeight;
    },
    overscan: 5,
    measureElement: (el) => el.getBoundingClientRect().height
  });

  return (
    <div ref={parentRef} className="comment-container">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative'
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const comment = flatComments[virtualItem.index];
          return (
            <div
              key={comment.id}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`
              }}
            >
              <CommentNode
                comment={comment}
                onVote={handleVote}
                onReply={handleReply}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Flatten tree while maintaining visual order
function flattenTree(
  comments: Comment[],
  result: Comment[] = []
): Comment[] {
  for (const comment of comments) {
    result.push(comment);
    if (comment.children && comment.children.length > 0) {
      flattenTree(comment.children, result);
    }
  }
  return result;
}
```

---

## 4. Deep Dive: Voting System (8 minutes)

### Optimistic Voting with Zustand

```typescript
// store/voteStore.ts
interface VoteState {
  postVotes: Map<number, { direction: 1 | -1 | 0; score: number }>;
  commentVotes: Map<number, { direction: 1 | -1 | 0; score: number }>;
  pendingVotes: Set<string>; // "post:123" or "comment:456"

  vote: (type: 'post' | 'comment', id: number, direction: 1 | -1 | 0) => void;
  getVoteState: (type: 'post' | 'comment', id: number) => {
    direction: 1 | -1 | 0;
    score: number;
  } | undefined;
}

export const useVoteStore = create<VoteState>((set, get) => ({
  postVotes: new Map(),
  commentVotes: new Map(),
  pendingVotes: new Set(),

  vote: async (type, id, newDirection) => {
    const key = `${type}:${id}`;
    const store = type === 'post' ? 'postVotes' : 'commentVotes';
    const currentState = get()[store].get(id);

    // Calculate score change
    const oldDirection = currentState?.direction || 0;
    const oldScore = currentState?.score || 0;
    const scoreDelta = newDirection - oldDirection;
    const newScore = oldScore + scoreDelta;

    // Optimistic update
    set((state) => {
      const votes = new Map(state[store]);
      votes.set(id, { direction: newDirection, score: newScore });
      return {
        [store]: votes,
        pendingVotes: new Set([...state.pendingVotes, key])
      };
    });

    try {
      // Send to server
      await api.post('/vote', {
        type,
        id,
        direction: newDirection
      });

      // Mark as synced
      set((state) => {
        const pending = new Set(state.pendingVotes);
        pending.delete(key);
        return { pendingVotes: pending };
      });
    } catch (error) {
      // Revert on failure
      set((state) => {
        const votes = new Map(state[store]);
        if (currentState) {
          votes.set(id, currentState);
        } else {
          votes.delete(id);
        }
        const pending = new Set(state.pendingVotes);
        pending.delete(key);
        return { [store]: votes, pendingVotes: pending };
      });

      // Show error toast
      toast.error('Failed to save vote. Please try again.');
    }
  },

  getVoteState: (type, id) => {
    const store = type === 'post' ? 'postVotes' : 'commentVotes';
    return get()[store].get(id);
  }
}));
```

### Vote Button Component

```tsx
// components/VoteButtons.tsx
interface VoteButtonsProps {
  type: 'post' | 'comment';
  id: number;
  initialScore: number;
  initialDirection?: 1 | -1 | 0;
}

export function VoteButtons({
  type,
  id,
  initialScore,
  initialDirection = 0
}: VoteButtonsProps) {
  const { vote, getVoteState, pendingVotes } = useVoteStore();

  // Get current state (optimistic or initial)
  const currentState = getVoteState(type, id) || {
    direction: initialDirection,
    score: initialScore
  };

  const isPending = pendingVotes.has(`${type}:${id}`);

  const handleVote = (direction: 1 | -1) => {
    // Toggle off if clicking same direction
    const newDirection = currentState.direction === direction ? 0 : direction;
    vote(type, id, newDirection);
  };

  return (
    <div
      className={`vote-buttons ${isPending ? 'pending' : ''}`}
      role="group"
      aria-label="Vote on this content"
    >
      <button
        className={`upvote ${currentState.direction === 1 ? 'active' : ''}`}
        onClick={() => handleVote(1)}
        disabled={isPending}
        aria-label="Upvote"
        aria-pressed={currentState.direction === 1}
      >
        <UpvoteIcon />
      </button>

      <span
        className={`score ${
          currentState.direction === 1 ? 'positive' :
          currentState.direction === -1 ? 'negative' : ''
        }`}
        aria-live="polite"
      >
        {formatScore(currentState.score)}
      </span>

      <button
        className={`downvote ${currentState.direction === -1 ? 'active' : ''}`}
        onClick={() => handleVote(-1)}
        disabled={isPending}
        aria-label="Downvote"
        aria-pressed={currentState.direction === -1}
      >
        <DownvoteIcon />
      </button>
    </div>
  );
}

function formatScore(score: number): string {
  if (score >= 10000) {
    return `${(score / 1000).toFixed(1)}k`;
  }
  return score.toString();
}
```

### CSS for Vote Animation

```css
/* styles/voting.css */
.vote-buttons {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.vote-buttons button {
  background: none;
  border: none;
  padding: 4px;
  cursor: pointer;
  color: var(--text-muted);
  transition: color 0.15s, transform 0.1s;
}

.vote-buttons button:hover {
  color: var(--text-primary);
}

.vote-buttons button.upvote.active {
  color: var(--upvote-orange);
}

.vote-buttons button.downvote.active {
  color: var(--downvote-blue);
}

.vote-buttons button:active {
  transform: scale(1.2);
}

.vote-buttons.pending {
  opacity: 0.6;
  pointer-events: none;
}

.score {
  font-weight: 600;
  font-size: 12px;
  min-width: 24px;
  text-align: center;
}

.score.positive {
  color: var(--upvote-orange);
}

.score.negative {
  color: var(--downvote-blue);
}

/* Animate score change */
@keyframes scoreChange {
  0% { transform: scale(1); }
  50% { transform: scale(1.2); }
  100% { transform: scale(1); }
}

.score.changing {
  animation: scoreChange 0.2s ease-out;
}
```

---

## 5. Deep Dive: Feed Rendering (8 minutes)

### Infinite Scroll with Virtualization

```tsx
// components/PostFeed.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useInfiniteQuery } from '@tanstack/react-query';

interface PostFeedProps {
  subreddit: string;
  sortBy: 'hot' | 'new' | 'top' | 'controversial';
}

export function PostFeed({ subreddit, sortBy }: PostFeedProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage
  } = useInfiniteQuery({
    queryKey: ['posts', subreddit, sortBy],
    queryFn: async ({ pageParam = 0 }) => {
      const res = await api.get(`/r/${subreddit}/${sortBy}`, {
        params: { page: pageParam, limit: 25 }
      });
      return res.data;
    },
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.length : undefined
  });

  const allPosts = useMemo(() =>
    data?.pages.flatMap(page => page.posts) || [],
    [data]
  );

  const virtualizer = useVirtualizer({
    count: hasNextPage ? allPosts.length + 1 : allPosts.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 150, // Average post card height
    overscan: 3,
    measureElement: (el) => el.getBoundingClientRect().height
  });

  // Load more when approaching end
  useEffect(() => {
    const lastItem = virtualizer.getVirtualItems().at(-1);
    if (!lastItem) return;

    if (
      lastItem.index >= allPosts.length - 1 &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      fetchNextPage();
    }
  }, [virtualizer.getVirtualItems(), hasNextPage, isFetchingNextPage]);

  return (
    <div ref={parentRef} className="post-feed">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative'
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const isLoader = virtualItem.index >= allPosts.length;
          const post = allPosts[virtualItem.index];

          return (
            <div
              key={isLoader ? 'loader' : post.id}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`
              }}
            >
              {isLoader ? (
                <LoadingSpinner />
              ) : (
                <PostCard post={post} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

### Post Card Component

```tsx
// components/PostCard.tsx
interface PostCardProps {
  post: Post;
}

export function PostCard({ post }: PostCardProps) {
  const navigate = useNavigate();

  return (
    <article
      className="post-card"
      onClick={() => navigate(`/r/${post.subredditName}/comments/${post.id}`)}
      role="link"
      tabIndex={0}
    >
      {/* Vote sidebar */}
      <div className="post-votes" onClick={(e) => e.stopPropagation()}>
        <VoteButtons
          type="post"
          id={post.id}
          initialScore={post.score}
        />
      </div>

      {/* Thumbnail */}
      {post.thumbnail && (
        <div className="post-thumbnail">
          <img src={post.thumbnail} alt="" loading="lazy" />
        </div>
      )}

      {/* Content */}
      <div className="post-content">
        <h3 className="post-title">
          {post.title}
          {post.url && (
            <span className="post-domain">
              ({new URL(post.url).hostname})
            </span>
          )}
        </h3>

        <div className="post-meta">
          <Link to={`/r/${post.subredditName}`} onClick={(e) => e.stopPropagation()}>
            r/{post.subredditName}
          </Link>
          <span>•</span>
          <span>Posted by u/{post.authorName}</span>
          <span>•</span>
          <TimeAgo date={post.createdAt} />
        </div>

        {/* Preview for text posts */}
        {post.content && (
          <p className="post-preview">
            {truncate(post.content, 200)}
          </p>
        )}

        <div className="post-stats">
          <span>
            <CommentIcon /> {post.commentCount} comments
          </span>
          <span>
            <ShareIcon /> Share
          </span>
          <span>
            <SaveIcon /> Save
          </span>
        </div>
      </div>
    </article>
  );
}
```

---

## 6. Deep Dive: Sort Controls (4 minutes)

### Sort Tabs Component

```tsx
// components/SortTabs.tsx
const SORT_OPTIONS = [
  { key: 'hot', label: 'Hot', icon: FlameIcon },
  { key: 'new', label: 'New', icon: SparkleIcon },
  { key: 'top', label: 'Top', icon: TrophyIcon },
  { key: 'controversial', label: 'Controversial', icon: SwordIcon }
] as const;

interface SortTabsProps {
  currentSort: string;
  onSortChange: (sort: string) => void;
}

export function SortTabs({ currentSort, onSortChange }: SortTabsProps) {
  return (
    <div className="sort-tabs" role="tablist">
      {SORT_OPTIONS.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          role="tab"
          aria-selected={currentSort === key}
          className={`sort-tab ${currentSort === key ? 'active' : ''}`}
          onClick={() => onSortChange(key)}
        >
          <Icon className="sort-icon" />
          {label}
        </button>
      ))}

      {/* Time filter for top sort */}
      {currentSort === 'top' && (
        <select
          className="time-filter"
          defaultValue="day"
          aria-label="Time period"
        >
          <option value="hour">Past Hour</option>
          <option value="day">Today</option>
          <option value="week">This Week</option>
          <option value="month">This Month</option>
          <option value="year">This Year</option>
          <option value="all">All Time</option>
        </select>
      )}
    </div>
  );
}
```

---

## 7. Zustand Store Architecture

```typescript
// store/index.ts
interface RedditStore {
  // User state
  user: User | null;
  isAuthenticated: boolean;
  login: (credentials: Credentials) => Promise<void>;
  logout: () => void;

  // Subscriptions
  subscriptions: Subreddit[];
  subscribe: (subredditId: number) => Promise<void>;
  unsubscribe: (subredditId: number) => Promise<void>;

  // UI state
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
}

export const useStore = create<RedditStore>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      subscriptions: [],
      sidebarOpen: true,
      theme: 'system',

      login: async (credentials) => {
        const response = await api.post('/auth/login', credentials);
        set({
          user: response.data.user,
          isAuthenticated: true
        });

        // Load subscriptions after login
        const subs = await api.get('/subscriptions');
        set({ subscriptions: subs.data });
      },

      logout: () => {
        api.post('/auth/logout');
        set({
          user: null,
          isAuthenticated: false,
          subscriptions: []
        });
      },

      subscribe: async (subredditId) => {
        await api.post(`/subreddits/${subredditId}/subscribe`);
        const subreddit = await api.get(`/subreddits/${subredditId}`);
        set((state) => ({
          subscriptions: [...state.subscriptions, subreddit.data]
        }));
      },

      unsubscribe: async (subredditId) => {
        await api.delete(`/subreddits/${subredditId}/subscribe`);
        set((state) => ({
          subscriptions: state.subscriptions.filter(s => s.id !== subredditId)
        }));
      },

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setTheme: (theme) => set({ theme })
    }),
    {
      name: 'reddit-store',
      partialize: (state) => ({
        theme: state.theme,
        sidebarOpen: state.sidebarOpen
      })
    }
  )
);
```

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

```tsx
// Keyboard navigation for comments
function useCommentNavigation(comments: Comment[]) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const current = document.activeElement;
      if (!current?.closest('.comment-node')) return;

      switch (e.key) {
        case 'j': // Next sibling
          (current.nextElementSibling as HTMLElement)?.focus();
          break;
        case 'k': // Previous sibling
          (current.previousElementSibling as HTMLElement)?.focus();
          break;
        case 'l': // First child
          current.querySelector('.comment-node')?.focus();
          break;
        case 'h': // Parent
          current.parentElement?.closest('.comment-node')?.focus();
          break;
        case 'Enter': // Toggle collapse
          current.querySelector('.collapse-toggle')?.click();
          break;
        case 'a': // Upvote
          current.querySelector('.upvote')?.click();
          break;
        case 'z': // Downvote
          current.querySelector('.downvote')?.click();
          break;
        case 'r': // Reply
          current.querySelector('[aria-label="Reply"]')?.click();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);
}
```

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
