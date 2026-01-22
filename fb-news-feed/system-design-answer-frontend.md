# Facebook News Feed - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

---

## Introduction

"Today I'll design a personalized news feed system similar to Facebook's, focusing on the frontend architecture. The core challenges are rendering a performant infinite-scroll feed with variable-height content, managing complex state for posts and engagement, handling real-time updates without disrupting the user experience, and building an intuitive post composer with rich media support."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the frontend-specific requirements:

1. **Feed Display**: Render personalized posts with infinite scroll
2. **Post Composer**: Create posts with text, images, and privacy controls
3. **Engagement UI**: Like, comment, and share with optimistic updates
4. **Real-time Updates**: New posts and engagement appear live
5. **Profile Views**: User profiles with post history and follow/unfollow
6. **Search**: Find users to follow with typeahead suggestions
7. **Responsive Design**: Works on desktop, tablet, and mobile"

### Non-Functional Requirements

"For the frontend:

- **Performance**: First Contentful Paint < 1.5s, feed scrolling at 60fps
- **Interactivity**: Time to Interactive < 3s
- **Bundle Size**: Initial JS bundle < 200KB gzipped
- **Accessibility**: WCAG 2.1 AA compliance
- **Offline Support**: View cached feed when offline"

---

## Step 2: Component Architecture

### High-Level Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              App Shell                                       │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                         Navigation Bar                                   ││
│  │   [Logo] [Search] [Home] [Friends] [Notifications] [Profile]           ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  ┌─────────────┐ ┌────────────────────────────────────┐ ┌─────────────────┐ │
│  │             │ │                                    │ │                 │ │
│  │  Left       │ │         Main Feed Area            │ │    Right        │ │
│  │  Sidebar    │ │                                    │ │    Sidebar      │ │
│  │             │ │  ┌────────────────────────────┐   │ │                 │ │
│  │  - Profile  │ │  │      Post Composer         │   │ │  - Contacts     │ │
│  │  - Friends  │ │  └────────────────────────────┘   │ │  - Suggestions  │ │
│  │  - Groups   │ │                                    │ │  - Trending     │ │
│  │  - Pages    │ │  ┌────────────────────────────┐   │ │                 │ │
│  │             │ │  │         Post Card          │   │ │                 │ │
│  │             │ │  │  - Header (author, time)   │   │ │                 │ │
│  │             │ │  │  - Content (text, media)   │   │ │                 │ │
│  │             │ │  │  - Actions (like, comment) │   │ │                 │ │
│  │             │ │  │  - Comments section        │   │ │                 │ │
│  │             │ │  └────────────────────────────┘   │ │                 │ │
│  │             │ │                                    │ │                 │ │
│  │             │ │  [Virtualized Post List...]       │ │                 │ │
│  │             │ │                                    │ │                 │ │
│  └─────────────┘ └────────────────────────────────────┘ └─────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Component Tree

```
App
├── AppShell
│   ├── NavigationBar
│   │   ├── Logo
│   │   ├── SearchBar (with typeahead)
│   │   ├── NavLinks
│   │   ├── NotificationBell
│   │   └── ProfileMenu
│   │
│   ├── LeftSidebar
│   │   ├── ProfileCard
│   │   ├── FriendsShortcut
│   │   ├── GroupsList
│   │   └── PagesShortcut
│   │
│   ├── MainContent
│   │   ├── PostComposer
│   │   │   ├── ComposerInput
│   │   │   ├── MediaUploader
│   │   │   ├── PrivacySelector
│   │   │   └── SubmitButton
│   │   │
│   │   └── Feed (virtualized)
│   │       └── PostCard (repeated)
│   │           ├── PostHeader
│   │           ├── PostContent
│   │           ├── PostMedia
│   │           ├── EngagementBar
│   │           ├── ActionBar
│   │           └── CommentsSection
│   │               ├── CommentList
│   │               └── CommentInput
│   │
│   └── RightSidebar
│       ├── ContactsList
│       ├── FriendSuggestions
│       └── TrendingTopics
│
├── ProfilePage
│   ├── CoverPhoto
│   ├── ProfileInfo
│   ├── ActionButtons (Follow/Message)
│   ├── ProfileTabs
│   └── PostsGrid
│
└── Modals
    ├── PostDetailModal
    ├── ImageLightbox
    └── ShareModal
```

---

## Step 3: State Management with Zustand

### Store Structure

```typescript
// stores/feedStore.ts
import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

interface Post {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  content: string;
  imageUrl?: string;
  privacy: 'public' | 'friends';
  likeCount: number;
  commentCount: number;
  shareCount: number;
  isLiked: boolean;
  createdAt: string;
}

interface Comment {
  id: string;
  postId: string;
  userId: string;
  userName: string;
  userAvatar: string;
  content: string;
  likeCount: number;
  createdAt: string;
}

interface FeedState {
  // Feed data
  posts: Post[];
  postsById: Record<string, Post>;
  feedCursor: string | null;
  hasMore: boolean;
  isLoading: boolean;

  // Comments
  commentsByPostId: Record<string, Comment[]>;
  expandedComments: Set<string>;

  // Composer state
  composerContent: string;
  composerImage: string | null;
  composerPrivacy: 'public' | 'friends';
  isComposerOpen: boolean;

  // Real-time updates
  newPostsCount: number;
  pendingUpdates: Post[];

  // Actions
  fetchFeed: (cursor?: string) => Promise<void>;
  createPost: (content: string, imageUrl?: string) => Promise<void>;
  likePost: (postId: string) => Promise<void>;
  unlikePost: (postId: string) => Promise<void>;
  addComment: (postId: string, content: string) => Promise<void>;
  loadComments: (postId: string) => Promise<void>;
  toggleCommentsExpanded: (postId: string) => void;

  // Composer actions
  setComposerContent: (content: string) => void;
  setComposerImage: (url: string | null) => void;
  setComposerPrivacy: (privacy: 'public' | 'friends') => void;
  openComposer: () => void;
  closeComposer: () => void;

  // Real-time
  handleNewPost: (post: Post) => void;
  handlePostUpdate: (postId: string, updates: Partial<Post>) => void;
  showPendingUpdates: () => void;
}

export const useFeedStore = create<FeedState>()(
  devtools(
    persist(
      immer((set, get) => ({
        // Initial state
        posts: [],
        postsById: {},
        feedCursor: null,
        hasMore: true,
        isLoading: false,
        commentsByPostId: {},
        expandedComments: new Set(),
        composerContent: '',
        composerImage: null,
        composerPrivacy: 'public',
        isComposerOpen: false,
        newPostsCount: 0,
        pendingUpdates: [],

        fetchFeed: async (cursor) => {
          if (get().isLoading) return;

          set({ isLoading: true });

          try {
            const response = await feedApi.getFeed(cursor);

            set((state) => {
              // Append new posts
              response.posts.forEach(post => {
                if (!state.postsById[post.id]) {
                  state.posts.push(post);
                  state.postsById[post.id] = post;
                }
              });

              state.feedCursor = response.pagination.nextCursor;
              state.hasMore = response.pagination.hasMore;
              state.isLoading = false;
            });
          } catch (error) {
            set({ isLoading: false });
            throw error;
          }
        },

        likePost: async (postId) => {
          // Optimistic update
          set((state) => {
            const post = state.postsById[postId];
            if (post && !post.isLiked) {
              post.isLiked = true;
              post.likeCount += 1;
            }
          });

          try {
            await feedApi.likePost(postId);
          } catch (error) {
            // Revert on failure
            set((state) => {
              const post = state.postsById[postId];
              if (post) {
                post.isLiked = false;
                post.likeCount -= 1;
              }
            });
            throw error;
          }
        },

        handleNewPost: (post) => {
          set((state) => {
            // Don't interrupt scrolling - queue for later
            if (window.scrollY > 200) {
              state.pendingUpdates.unshift(post);
              state.newPostsCount += 1;
            } else {
              // User at top - insert directly
              state.posts.unshift(post);
              state.postsById[post.id] = post;
            }
          });
        },

        showPendingUpdates: () => {
          set((state) => {
            // Insert pending posts at the top
            state.posts.unshift(...state.pendingUpdates);
            state.pendingUpdates.forEach(post => {
              state.postsById[post.id] = post;
            });
            state.pendingUpdates = [];
            state.newPostsCount = 0;
          });

          // Scroll to top
          window.scrollTo({ top: 0, behavior: 'smooth' });
        },

        // ... other actions
      })),
      {
        name: 'feed-storage',
        partialize: (state) => ({
          // Only persist essential data
          composerContent: state.composerContent,
          composerPrivacy: state.composerPrivacy,
        }),
      }
    )
  )
);
```

### User Store

```typescript
// stores/userStore.ts
interface UserState {
  currentUser: User | null;
  isAuthenticated: boolean;
  followedUsers: Set<string>;
  blockedUsers: Set<string>;

  // Actions
  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  followUser: (userId: string) => Promise<void>;
  unfollowUser: (userId: string) => Promise<void>;
}

export const useUserStore = create<UserState>()(
  devtools(
    persist(
      immer((set, get) => ({
        currentUser: null,
        isAuthenticated: false,
        followedUsers: new Set(),
        blockedUsers: new Set(),

        followUser: async (userId) => {
          // Optimistic update
          set((state) => {
            state.followedUsers.add(userId);
          });

          try {
            await userApi.follow(userId);
          } catch (error) {
            set((state) => {
              state.followedUsers.delete(userId);
            });
            throw error;
          }
        },

        // ... other actions
      })),
      {
        name: 'user-storage',
        partialize: (state) => ({
          currentUser: state.currentUser,
          isAuthenticated: state.isAuthenticated,
        }),
      }
    )
  )
);
```

---

## Step 4: Virtualized Feed Implementation

### Feed List with Dynamic Heights

```tsx
// components/feed/Feed.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useCallback, useEffect } from 'react';
import { useFeedStore } from '../../stores/feedStore';
import { PostCard } from './PostCard';
import { NewPostsBanner } from './NewPostsBanner';

export function Feed() {
  const parentRef = useRef<HTMLDivElement>(null);
  const {
    posts,
    hasMore,
    isLoading,
    fetchFeed,
    newPostsCount,
    showPendingUpdates,
  } = useFeedStore();

  // Virtualization setup
  const virtualizer = useVirtualizer({
    count: posts.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 400, // Estimated height for initial layout
    overscan: 3, // Render 3 extra items above/below viewport
    measureElement: (element) => {
      // Measure actual height for accurate positioning
      return element.getBoundingClientRect().height;
    },
  });

  // Infinite scroll
  const handleScroll = useCallback(() => {
    const container = parentRef.current;
    if (!container || isLoading || !hasMore) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const threshold = 500; // Load more when 500px from bottom

    if (scrollHeight - scrollTop - clientHeight < threshold) {
      fetchFeed();
    }
  }, [fetchFeed, isLoading, hasMore]);

  // Attach scroll listener
  useEffect(() => {
    const container = parentRef.current;
    if (!container) return;

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Initial fetch
  useEffect(() => {
    if (posts.length === 0) {
      fetchFeed();
    }
  }, []);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="feed-container">
      {/* New posts notification banner */}
      {newPostsCount > 0 && (
        <NewPostsBanner
          count={newPostsCount}
          onClick={showPendingUpdates}
        />
      )}

      {/* Virtualized scroll container */}
      <div
        ref={parentRef}
        className="feed-scroll-container"
        style={{
          height: 'calc(100vh - 56px)', // Full height minus nav
          overflow: 'auto',
        }}
      >
        {/* Total height container */}
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {/* Rendered items */}
          {virtualItems.map((virtualItem) => {
            const post = posts[virtualItem.index];

            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <PostCard post={post} />
              </div>
            );
          })}
        </div>

        {/* Loading indicator */}
        {isLoading && (
          <div className="flex justify-center py-4">
            <LoadingSpinner />
          </div>
        )}

        {/* End of feed */}
        {!hasMore && posts.length > 0 && (
          <div className="text-center py-8 text-gray-500">
            You're all caught up!
          </div>
        )}
      </div>
    </div>
  );
}
```

### New Posts Banner

```tsx
// components/feed/NewPostsBanner.tsx
interface NewPostsBannerProps {
  count: number;
  onClick: () => void;
}

export function NewPostsBanner({ count, onClick }: NewPostsBannerProps) {
  return (
    <button
      onClick={onClick}
      className="fixed top-16 left-1/2 -translate-x-1/2 z-50
                 bg-blue-500 text-white px-4 py-2 rounded-full
                 shadow-lg hover:bg-blue-600 transition-colors
                 flex items-center gap-2 animate-slide-down"
    >
      <ArrowUpIcon className="w-4 h-4" />
      <span>
        {count} new {count === 1 ? 'post' : 'posts'}
      </span>
    </button>
  );
}
```

---

## Step 5: Post Card Component

### Complete Post Card

```tsx
// components/feed/PostCard.tsx
import { memo, useState, useCallback } from 'react';
import { useFeedStore } from '../../stores/feedStore';
import { formatDistanceToNow } from 'date-fns';

interface PostCardProps {
  post: Post;
}

export const PostCard = memo(function PostCard({ post }: PostCardProps) {
  const { likePost, unlikePost, toggleCommentsExpanded, expandedComments } =
    useFeedStore();
  const [isImageLoaded, setIsImageLoaded] = useState(false);

  const handleLike = useCallback(() => {
    if (post.isLiked) {
      unlikePost(post.id);
    } else {
      likePost(post.id);
    }
  }, [post.id, post.isLiked, likePost, unlikePost]);

  const isCommentsExpanded = expandedComments.has(post.id);

  return (
    <article
      className="bg-white rounded-lg shadow mb-4 overflow-hidden"
      aria-label={`Post by ${post.authorName}`}
    >
      {/* Post Header */}
      <header className="flex items-center p-4">
        <img
          src={post.authorAvatar}
          alt={post.authorName}
          className="w-10 h-10 rounded-full"
          loading="lazy"
        />
        <div className="ml-3 flex-1">
          <a
            href={`/profile/${post.authorId}`}
            className="font-semibold hover:underline"
          >
            {post.authorName}
          </a>
          <div className="flex items-center text-sm text-gray-500">
            <time dateTime={post.createdAt}>
              {formatDistanceToNow(new Date(post.createdAt), { addSuffix: true })}
            </time>
            <span className="mx-1">·</span>
            <PrivacyIcon privacy={post.privacy} />
          </div>
        </div>
        <PostOptionsMenu postId={post.id} authorId={post.authorId} />
      </header>

      {/* Post Content */}
      <div className="px-4 pb-3">
        <p className="text-gray-900 whitespace-pre-wrap">{post.content}</p>
      </div>

      {/* Post Media */}
      {post.imageUrl && (
        <div className="relative bg-gray-100">
          {/* Skeleton while loading */}
          {!isImageLoaded && (
            <div className="aspect-video animate-pulse bg-gray-200" />
          )}
          <img
            src={post.imageUrl}
            alt="Post attachment"
            className={`w-full object-cover transition-opacity ${
              isImageLoaded ? 'opacity-100' : 'opacity-0'
            }`}
            loading="lazy"
            onLoad={() => setIsImageLoaded(true)}
            onClick={() => openLightbox(post.imageUrl)}
          />
        </div>
      )}

      {/* Engagement Counts */}
      <div className="px-4 py-2 flex items-center justify-between text-sm text-gray-500 border-b">
        <button className="flex items-center gap-1 hover:underline">
          {post.likeCount > 0 && (
            <>
              <span className="flex -space-x-1">
                <LikeIcon className="w-4 h-4 text-blue-500" />
              </span>
              <span>{formatCount(post.likeCount)}</span>
            </>
          )}
        </button>
        <div className="flex gap-4">
          {post.commentCount > 0 && (
            <button
              onClick={() => toggleCommentsExpanded(post.id)}
              className="hover:underline"
            >
              {post.commentCount} {post.commentCount === 1 ? 'comment' : 'comments'}
            </button>
          )}
          {post.shareCount > 0 && (
            <span>
              {post.shareCount} {post.shareCount === 1 ? 'share' : 'shares'}
            </span>
          )}
        </div>
      </div>

      {/* Action Bar */}
      <div className="px-2 py-1 flex border-b">
        <ActionButton
          icon={post.isLiked ? LikeFilledIcon : LikeOutlineIcon}
          label="Like"
          onClick={handleLike}
          active={post.isLiked}
          activeColor="text-blue-500"
        />
        <ActionButton
          icon={CommentIcon}
          label="Comment"
          onClick={() => toggleCommentsExpanded(post.id)}
        />
        <ActionButton
          icon={ShareIcon}
          label="Share"
          onClick={() => openShareModal(post.id)}
        />
      </div>

      {/* Comments Section */}
      {isCommentsExpanded && (
        <CommentsSection postId={post.id} />
      )}
    </article>
  );
});

// Action button with animation
function ActionButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  activeColor = '',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  active?: boolean;
  activeColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-2 py-2
                  rounded-md hover:bg-gray-100 transition-colors
                  ${active ? activeColor : 'text-gray-600'}`}
      aria-pressed={active}
    >
      <Icon
        className={`w-5 h-5 transition-transform ${
          active ? 'scale-110' : ''
        }`}
      />
      <span className="text-sm font-medium">{label}</span>
    </button>
  );
}
```

---

## Step 6: Post Composer Component

### Rich Composer with Image Support

```tsx
// components/feed/PostComposer.tsx
import { useRef, useState, useCallback } from 'react';
import { useFeedStore } from '../../stores/feedStore';
import { useUserStore } from '../../stores/userStore';
import TextareaAutosize from 'react-textarea-autosize';

export function PostComposer() {
  const { currentUser } = useUserStore();
  const {
    composerContent,
    composerImage,
    composerPrivacy,
    setComposerContent,
    setComposerImage,
    setComposerPrivacy,
    createPost,
  } = useFeedStore();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(async () => {
    if (!composerContent.trim() && !composerImage) return;

    setIsSubmitting(true);

    try {
      await createPost(composerContent, composerImage || undefined);

      // Clear composer on success
      setComposerContent('');
      setComposerImage(null);
      setIsFocused(false);
    } catch (error) {
      console.error('Failed to create post:', error);
      // Show error toast
    } finally {
      setIsSubmitting(false);
    }
  }, [composerContent, composerImage, createPost, setComposerContent, setComposerImage]);

  const handleImageSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      alert('Image must be less than 10MB');
      return;
    }

    // Create preview URL
    const previewUrl = URL.createObjectURL(file);
    setComposerImage(previewUrl);

    // TODO: Upload to server and get permanent URL
  }, [setComposerImage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Cmd/Ctrl + Enter to submit
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      handleSubmit();
    }
  }, [handleSubmit]);

  const canSubmit = (composerContent.trim() || composerImage) && !isSubmitting;

  return (
    <div
      className={`bg-white rounded-lg shadow mb-4 overflow-hidden transition-all ${
        isFocused ? 'ring-2 ring-blue-500' : ''
      }`}
    >
      <div className="p-4">
        <div className="flex gap-3">
          <img
            src={currentUser?.avatarUrl}
            alt={currentUser?.displayName}
            className="w-10 h-10 rounded-full"
          />

          <div className="flex-1">
            <TextareaAutosize
              value={composerContent}
              onChange={(e) => setComposerContent(e.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => !composerContent && !composerImage && setIsFocused(false)}
              onKeyDown={handleKeyDown}
              placeholder={`What's on your mind, ${currentUser?.displayName?.split(' ')[0]}?`}
              className="w-full resize-none text-lg placeholder-gray-500
                         focus:outline-none min-h-[60px]"
              minRows={isFocused ? 3 : 1}
              maxRows={20}
            />
          </div>
        </div>

        {/* Image Preview */}
        {composerImage && (
          <div className="relative mt-3 ml-13">
            <img
              src={composerImage}
              alt="Post attachment preview"
              className="max-h-96 rounded-lg object-contain"
            />
            <button
              onClick={() => setComposerImage(null)}
              className="absolute top-2 right-2 p-1 bg-black/50 rounded-full
                         text-white hover:bg-black/70 transition-colors"
              aria-label="Remove image"
            >
              <XIcon className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>

      {/* Composer Footer */}
      <div className="px-4 py-3 border-t flex items-center justify-between">
        <div className="flex gap-1">
          {/* Add Image Button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-2 rounded-full hover:bg-gray-100 text-green-600"
            aria-label="Add image"
          >
            <ImageIcon className="w-6 h-6" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageSelect}
            className="hidden"
          />

          {/* Add Video Button (placeholder) */}
          <button
            className="p-2 rounded-full hover:bg-gray-100 text-red-500"
            aria-label="Add video"
          >
            <VideoIcon className="w-6 h-6" />
          </button>

          {/* Tag Friends Button (placeholder) */}
          <button
            className="p-2 rounded-full hover:bg-gray-100 text-blue-500"
            aria-label="Tag friends"
          >
            <TagIcon className="w-6 h-6" />
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* Privacy Selector */}
          <PrivacySelector
            value={composerPrivacy}
            onChange={setComposerPrivacy}
          />

          {/* Submit Button */}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={`px-4 py-2 rounded-md font-semibold transition-all ${
              canSubmit
                ? 'bg-blue-500 text-white hover:bg-blue-600'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {isSubmitting ? (
              <span className="flex items-center gap-2">
                <LoadingSpinner size="small" />
                Posting...
              </span>
            ) : (
              'Post'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// Privacy Selector Component
function PrivacySelector({
  value,
  onChange,
}: {
  value: 'public' | 'friends';
  onChange: (value: 'public' | 'friends') => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const options = [
    { value: 'public', label: 'Public', icon: GlobeIcon },
    { value: 'friends', label: 'Friends', icon: UsersIcon },
  ] as const;

  const selected = options.find((o) => o.value === value)!;

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 px-3 py-1.5 rounded-md
                   bg-gray-100 hover:bg-gray-200 text-sm font-medium"
      >
        <selected.icon className="w-4 h-4" />
        {selected.label}
        <ChevronDownIcon className="w-4 h-4" />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-1 w-48 bg-white rounded-lg shadow-lg border z-50">
          {options.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
              className={`w-full flex items-center gap-2 px-4 py-2 text-left
                         hover:bg-gray-100 first:rounded-t-lg last:rounded-b-lg
                         ${option.value === value ? 'bg-blue-50' : ''}`}
            >
              <option.icon className="w-5 h-5" />
              <span>{option.label}</span>
              {option.value === value && (
                <CheckIcon className="w-4 h-4 ml-auto text-blue-500" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## Step 7: Real-time Updates with WebSocket

### WebSocket Hook

```tsx
// hooks/useRealtimeFeed.ts
import { useEffect, useRef, useCallback } from 'react';
import { useFeedStore } from '../stores/feedStore';

interface WebSocketMessage {
  type: 'new_post' | 'post_update' | 'engagement_update' | 'connection_status';
  payload: unknown;
}

export function useRealtimeFeed() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const reconnectAttempts = useRef(0);

  const { handleNewPost, handlePostUpdate } = useFeedStore();

  const connect = useCallback(() => {
    const ws = new WebSocket(import.meta.env.VITE_WS_URL || 'ws://localhost:3000/ws');
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      reconnectAttempts.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);

        switch (message.type) {
          case 'new_post':
            handleNewPost(message.payload as Post);
            break;

          case 'engagement_update':
            const { postId, likeCount, commentCount } = message.payload as {
              postId: string;
              likeCount: number;
              commentCount: number;
            };
            handlePostUpdate(postId, { likeCount, commentCount });
            break;

          default:
            console.log('Unknown message type:', message.type);
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      scheduleReconnect();
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      ws.close();
    };
  }, [handleNewPost, handlePostUpdate]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectAttempts.current >= 10) {
      console.error('Max reconnection attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
    reconnectAttempts.current += 1;

    reconnectTimeoutRef.current = setTimeout(() => {
      console.log(`Reconnecting (attempt ${reconnectAttempts.current})...`);
      connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

  return {
    isConnected: wsRef.current?.readyState === WebSocket.OPEN,
  };
}
```

### Connection Status Indicator

```tsx
// components/common/ConnectionStatus.tsx
export function ConnectionStatus() {
  const { isConnected } = useRealtimeFeed();

  if (isConnected) return null;

  return (
    <div className="fixed bottom-4 left-4 bg-yellow-100 border border-yellow-300
                    text-yellow-800 px-4 py-2 rounded-lg shadow-lg
                    flex items-center gap-2 z-50 animate-fade-in">
      <WifiOffIcon className="w-5 h-5" />
      <span>Reconnecting...</span>
      <LoadingSpinner size="small" />
    </div>
  );
}
```

---

## Step 8: Comments Section

### Expandable Comments

```tsx
// components/feed/CommentsSection.tsx
import { useEffect, useCallback, useState } from 'react';
import { useFeedStore } from '../../stores/feedStore';

interface CommentsSectionProps {
  postId: string;
}

export function CommentsSection({ postId }: CommentsSectionProps) {
  const { commentsByPostId, loadComments, addComment } = useFeedStore();
  const comments = commentsByPostId[postId] || [];
  const [newComment, setNewComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load comments on expand
  useEffect(() => {
    if (comments.length === 0) {
      loadComments(postId);
    }
  }, [postId, comments.length, loadComments]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim() || isSubmitting) return;

    setIsSubmitting(true);

    try {
      await addComment(postId, newComment);
      setNewComment('');
    } finally {
      setIsSubmitting(false);
    }
  }, [postId, newComment, addComment, isSubmitting]);

  return (
    <div className="p-4 pt-2 space-y-3">
      {/* Comment Input */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <img
          src={currentUser?.avatarUrl}
          alt="Your avatar"
          className="w-8 h-8 rounded-full"
        />
        <div className="flex-1 relative">
          <input
            type="text"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Write a comment..."
            className="w-full bg-gray-100 rounded-full px-4 py-2 pr-10
                       focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isSubmitting}
          />
          <button
            type="submit"
            disabled={!newComment.trim() || isSubmitting}
            className="absolute right-2 top-1/2 -translate-y-1/2
                       text-blue-500 disabled:text-gray-300"
          >
            <SendIcon className="w-5 h-5" />
          </button>
        </div>
      </form>

      {/* Comments List */}
      <div className="space-y-3">
        {comments.map((comment) => (
          <Comment key={comment.id} comment={comment} />
        ))}
      </div>

      {/* Load More */}
      {comments.length >= 10 && (
        <button
          className="text-sm text-gray-500 hover:underline"
          onClick={() => loadComments(postId, comments.length)}
        >
          View more comments
        </button>
      )}
    </div>
  );
}

// Individual Comment Component
function Comment({ comment }: { comment: Comment }) {
  return (
    <div className="flex gap-2">
      <img
        src={comment.userAvatar}
        alt={comment.userName}
        className="w-8 h-8 rounded-full"
      />
      <div className="flex-1">
        <div className="bg-gray-100 rounded-2xl px-3 py-2">
          <a
            href={`/profile/${comment.userId}`}
            className="font-semibold text-sm hover:underline"
          >
            {comment.userName}
          </a>
          <p className="text-sm">{comment.content}</p>
        </div>
        <div className="flex gap-4 text-xs text-gray-500 mt-1 ml-3">
          <button className="hover:underline">Like</button>
          <button className="hover:underline">Reply</button>
          <time>{formatDistanceToNow(new Date(comment.createdAt))}</time>
        </div>
      </div>
    </div>
  );
}
```

---

## Step 9: Search with Typeahead

### Search Component

```tsx
// components/navigation/SearchBar.tsx
import { useState, useCallback, useRef, useEffect } from 'react';
import { useDebounce } from '../../hooks/useDebounce';
import { searchUsers } from '../../api/users';

export function SearchBar() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const debouncedQuery = useDebounce(query, 300);

  // Search when query changes
  useEffect(() => {
    if (debouncedQuery.trim().length < 2) {
      setResults([]);
      return;
    }

    const search = async () => {
      setIsLoading(true);
      try {
        const users = await searchUsers(debouncedQuery);
        setResults(users);
        setIsOpen(true);
      } catch (error) {
        console.error('Search failed:', error);
      } finally {
        setIsLoading(false);
      }
    };

    search();
  }, [debouncedQuery]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, -1));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0 && results[selectedIndex]) {
          navigateToProfile(results[selectedIndex].id);
        }
        break;
      case 'Escape':
        setIsOpen(false);
        inputRef.current?.blur();
        break;
    }
  }, [results, selectedIndex]);

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search Facebook"
          className="w-64 pl-10 pr-4 py-2 bg-gray-100 rounded-full
                     focus:outline-none focus:ring-2 focus:ring-blue-500
                     focus:bg-white transition-colors"
          aria-label="Search"
          aria-expanded={isOpen}
          aria-controls="search-results"
        />
        {isLoading && (
          <LoadingSpinner className="absolute right-3 top-1/2 -translate-y-1/2" size="small" />
        )}
      </div>

      {/* Results Dropdown */}
      {isOpen && results.length > 0 && (
        <div
          id="search-results"
          role="listbox"
          className="absolute top-full left-0 right-0 mt-2 bg-white
                     rounded-lg shadow-lg border max-h-96 overflow-y-auto z-50"
        >
          {results.map((user, index) => (
            <a
              key={user.id}
              href={`/profile/${user.username}`}
              role="option"
              aria-selected={index === selectedIndex}
              className={`flex items-center gap-3 px-4 py-3 hover:bg-gray-50 ${
                index === selectedIndex ? 'bg-gray-100' : ''
              }`}
              onClick={() => setIsOpen(false)}
            >
              <img
                src={user.avatarUrl}
                alt={user.displayName}
                className="w-10 h-10 rounded-full"
              />
              <div>
                <div className="font-semibold">{user.displayName}</div>
                <div className="text-sm text-gray-500">@{user.username}</div>
              </div>
            </a>
          ))}
        </div>
      )}

      {/* No Results */}
      {isOpen && query.length >= 2 && results.length === 0 && !isLoading && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-white
                       rounded-lg shadow-lg border p-4 text-center text-gray-500">
          No users found
        </div>
      )}
    </div>
  );
}
```

---

## Step 10: Responsive Layout

### CSS Layout Structure

```css
/* styles/layout.css */

/* Main Layout */
.app-layout {
  display: grid;
  grid-template-areas:
    "nav nav nav"
    "left main right";
  grid-template-columns: 280px 1fr 280px;
  grid-template-rows: 56px 1fr;
  min-height: 100vh;
  background-color: #f0f2f5;
}

.navigation {
  grid-area: nav;
  position: sticky;
  top: 0;
  z-index: 100;
  background: white;
  border-bottom: 1px solid #ddd;
}

.left-sidebar {
  grid-area: left;
  padding: 16px;
  position: sticky;
  top: 56px;
  height: calc(100vh - 56px);
  overflow-y: auto;
}

.main-content {
  grid-area: main;
  padding: 24px;
  max-width: 680px;
  margin: 0 auto;
}

.right-sidebar {
  grid-area: right;
  padding: 16px;
  position: sticky;
  top: 56px;
  height: calc(100vh - 56px);
  overflow-y: auto;
}

/* Tablet: Hide right sidebar */
@media (max-width: 1100px) {
  .app-layout {
    grid-template-areas:
      "nav nav"
      "left main";
    grid-template-columns: 280px 1fr;
  }

  .right-sidebar {
    display: none;
  }
}

/* Mobile: Hide both sidebars */
@media (max-width: 768px) {
  .app-layout {
    grid-template-areas:
      "nav"
      "main";
    grid-template-columns: 1fr;
  }

  .left-sidebar,
  .right-sidebar {
    display: none;
  }

  .main-content {
    padding: 12px;
  }
}

/* Post Card Responsive */
.post-card {
  @apply bg-white rounded-lg shadow;
}

@media (max-width: 768px) {
  .post-card {
    @apply rounded-none shadow-none border-b;
  }
}
```

### Responsive Images

```tsx
// components/feed/PostMedia.tsx
export function PostMedia({ imageUrl }: { imageUrl: string }) {
  return (
    <picture>
      {/* WebP for modern browsers */}
      <source
        srcSet={`${imageUrl}?w=480&f=webp 480w,
                 ${imageUrl}?w=680&f=webp 680w,
                 ${imageUrl}?w=1360&f=webp 1360w`}
        sizes="(max-width: 768px) 100vw, 680px"
        type="image/webp"
      />
      {/* JPEG fallback */}
      <img
        src={`${imageUrl}?w=680`}
        srcSet={`${imageUrl}?w=480 480w,
                 ${imageUrl}?w=680 680w,
                 ${imageUrl}?w=1360 1360w`}
        sizes="(max-width: 768px) 100vw, 680px"
        alt="Post attachment"
        className="w-full object-cover"
        loading="lazy"
      />
    </picture>
  );
}
```

---

## Step 11: Accessibility Implementation

### Accessible Post Actions

```tsx
// components/feed/ActionBar.tsx
export function ActionBar({ post }: { post: Post }) {
  const { likePost, unlikePost } = useFeedStore();

  return (
    <div
      role="group"
      aria-label="Post actions"
      className="flex border-t border-b"
    >
      <button
        onClick={() => post.isLiked ? unlikePost(post.id) : likePost(post.id)}
        aria-pressed={post.isLiked}
        aria-label={post.isLiked ? 'Unlike this post' : 'Like this post'}
        className={`flex-1 flex items-center justify-center gap-2 py-2
                    hover:bg-gray-100 transition-colors
                    ${post.isLiked ? 'text-blue-500' : 'text-gray-600'}`}
      >
        <ThumbsUpIcon
          aria-hidden="true"
          className={`w-5 h-5 ${post.isLiked ? 'fill-current' : ''}`}
        />
        <span>Like</span>
      </button>

      <button
        aria-label={`Comment on this post. ${post.commentCount} comments`}
        className="flex-1 flex items-center justify-center gap-2 py-2
                   text-gray-600 hover:bg-gray-100 transition-colors"
      >
        <MessageIcon aria-hidden="true" className="w-5 h-5" />
        <span>Comment</span>
      </button>

      <button
        aria-label="Share this post"
        className="flex-1 flex items-center justify-center gap-2 py-2
                   text-gray-600 hover:bg-gray-100 transition-colors"
      >
        <ShareIcon aria-hidden="true" className="w-5 h-5" />
        <span>Share</span>
      </button>
    </div>
  );
}
```

### Skip Navigation Link

```tsx
// components/common/SkipLink.tsx
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4
                 bg-blue-500 text-white px-4 py-2 rounded-md z-50"
    >
      Skip to main content
    </a>
  );
}
```

### Focus Management

```tsx
// hooks/useFocusTrap.ts
import { useEffect, useRef } from 'react';

export function useFocusTrap(isActive: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    const container = containerRef.current;
    const focusableElements = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    // Focus first element when trap activates
    firstElement?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [isActive]);

  return containerRef;
}
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| **State Management** | Zustand with immer | Redux Toolkit | Simpler API, less boilerplate, built-in devtools |
| **Virtualization** | @tanstack/react-virtual | react-window | Better dynamic height support, maintained by Tanner Linsley |
| **Styling** | Tailwind CSS | CSS Modules | Rapid prototyping, consistent design system |
| **Routing** | TanStack Router | React Router | File-based routing, type-safe params |
| **Optimistic Updates** | Custom with rollback | React Query mutations | More control over UI state during updates |
| **WebSocket** | Native WebSocket | Socket.io | Smaller bundle, sufficient for our needs |
| **Form Handling** | Controlled components | React Hook Form | Simpler for small forms, direct state access |

---

## Performance Optimizations

1. **Virtualization**: Only render visible posts (reduces DOM from 1000+ to ~60 nodes)
2. **Memoization**: `memo()` on PostCard prevents re-renders when other posts change
3. **Image lazy loading**: Native `loading="lazy"` defers offscreen images
4. **Debounced search**: 300ms debounce prevents excessive API calls
5. **Code splitting**: Route-based splitting with dynamic imports
6. **Optimistic updates**: Immediate UI feedback before server confirmation

---

## Future Enhancements

1. **Service Worker**: Offline feed viewing and background sync
2. **Skeleton Loading**: Content placeholders during initial load
3. **Intersection Observer**: Replace scroll listener for infinite scroll
4. **React Suspense**: Streaming SSR for faster initial paint
5. **Image Optimization**: Next-gen formats (AVIF) with fallbacks
6. **Animation Library**: Framer Motion for rich micro-interactions
7. **Virtual Keyboard**: Better mobile input handling

---

## Summary

"For the Facebook News Feed frontend:

1. **Virtualized Feed**: @tanstack/react-virtual renders only visible posts, maintaining 60fps scrolling even with hundreds of items
2. **Zustand State**: Centralized store with immer for immutable updates and optimistic UI patterns
3. **Real-time WebSocket**: Live updates queued when scrolling, shown via banner to avoid disruption
4. **Post Composer**: Rich text input with media preview and privacy controls
5. **Responsive Design**: Three-column layout collapses gracefully to single column on mobile
6. **Accessibility**: ARIA labels, keyboard navigation, focus management in modals

The key frontend insight is handling variable-height content in an infinite list - you must measure elements dynamically and update the virtualizer as content loads. Combined with optimistic updates and real-time sync, this creates a responsive, engaging user experience."
