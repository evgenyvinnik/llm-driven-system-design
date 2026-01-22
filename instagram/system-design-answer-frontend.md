# Instagram - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement

"Today I'll design Instagram, a photo and video sharing social platform. As a frontend engineer, I'll focus on the virtualized infinite-scroll feed for smooth performance, the story viewer with auto-advance and swipe gestures, the post creation flow with image preview, and the brand-authentic visual design including the signature gradient story rings and Instagram's color system."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Photo Feed** - Virtualized infinite scroll with dynamic post heights
2. **Stories** - Horizontal story tray with gradient rings, full-screen viewer with auto-advance
3. **Post Creation** - Image upload with preview, caption input, and progress indication
4. **Profile** - Grid layout of user's posts, follower/following counts
5. **Interactions** - Like with animation, comments, follow/unfollow

### Non-Functional Requirements

- **Performance**: 60fps scroll, < 100ms interaction response
- **Accessibility**: Screen reader support, keyboard navigation, sufficient contrast
- **Responsiveness**: Mobile-first design, adapts to desktop
- **Offline**: Show cached content when offline, queue actions for sync

### Frontend-Specific Clarifications

- "What's the target device?" - Mobile web primary, responsive to desktop
- "How many posts in a typical session?" - Users scroll through 50-200 posts
- "Should we support dark mode?" - Yes, with true black for OLED savings

---

## Step 2: Component Architecture

```
src/
├── components/
│   ├── feed/
│   │   ├── FeedContainer.tsx      # Virtualization wrapper
│   │   ├── PostCard.tsx           # Individual post
│   │   ├── PostActions.tsx        # Like, comment, share, save
│   │   └── LikeButton.tsx         # Animated heart
│   ├── stories/
│   │   ├── StoryTray.tsx          # Horizontal scroll of story rings
│   │   ├── StoryRing.tsx          # Gradient ring + avatar
│   │   ├── StoryViewer.tsx        # Full-screen viewer
│   │   └── StoryProgress.tsx      # Progress bars at top
│   ├── post/
│   │   ├── CreatePost.tsx         # Post creation modal
│   │   ├── ImagePreview.tsx       # Cropped preview
│   │   └── CaptionInput.tsx       # Caption with mentions
│   ├── profile/
│   │   ├── ProfileHeader.tsx      # Avatar, bio, stats
│   │   └── PostGrid.tsx           # 3-column grid
│   ├── common/
│   │   ├── Avatar.tsx             # Reusable avatar component
│   │   ├── Button.tsx             # Brand-styled buttons
│   │   └── Modal.tsx              # Overlay modal
│   └── icons/
│       ├── HeartIcon.tsx
│       ├── CommentIcon.tsx
│       ├── ShareIcon.tsx
│       └── index.ts               # Barrel export
├── routes/
│   ├── __root.tsx                 # Root layout
│   ├── index.tsx                  # Home feed
│   ├── profile.$username.tsx      # Profile page
│   └── messages/
│       ├── index.tsx              # Inbox
│       └── $conversationId.tsx    # Conversation
├── stores/
│   ├── authStore.ts               # Authentication state
│   ├── feedStore.ts               # Feed posts and pagination
│   └── storyStore.ts              # Stories state
└── services/
    └── api.ts                     # API client
```

---

## Step 3: Feed Virtualization (Deep Dive)

### The Challenge

Users scroll through 50-200 posts per session. Without virtualization:
- DOM grows unbounded (800+ nodes for 100 posts)
- Memory usage exceeds 200MB
- Scroll performance degrades over time

### TanStack Virtual Implementation

```tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useCallback } from 'react';
import { useFeedStore } from '../stores/feedStore';
import { PostCard } from '../components/feed/PostCard';

export function FeedContainer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { posts, loadMore, hasMore, isLoading } = useFeedStore();

  const virtualizer = useVirtualizer({
    count: posts.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 600, // Estimated post height
    overscan: 3, // Render 3 extra items above/below
    measureElement: (element) => {
      // Dynamic measurement for accurate positioning
      return element.getBoundingClientRect().height;
    },
  });

  // Infinite scroll trigger
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || isLoading || !hasMore) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    if (distanceFromBottom < 1000) {
      loadMore();
    }
  }, [isLoading, hasMore, loadMore]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="h-screen overflow-y-auto"
      role="feed"
      aria-label="Photo feed"
    >
      {/* Spacer for virtualization offset */}
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
        }}
      >
        {items.map((virtualItem) => {
          const post = posts[virtualItem.index];
          return (
            <div
              key={post.id}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
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

      {isLoading && (
        <div className="flex justify-center py-4">
          <LoadingSpinner />
        </div>
      )}
    </div>
  );
}
```

### PostCard Component

```tsx
import { memo, useState, useCallback } from 'react';
import { HeartIcon, CommentIcon, ShareIcon, BookmarkIcon } from '../icons';
import { api } from '../../services/api';
import type { Post } from '../../types';

interface PostCardProps {
  post: Post;
}

export const PostCard = memo(function PostCard({ post }: PostCardProps) {
  const [isLiked, setIsLiked] = useState(post.isLiked);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const [showHeartAnimation, setShowHeartAnimation] = useState(false);

  // Optimistic like with rollback on failure
  const handleLike = useCallback(async () => {
    const previousLiked = isLiked;
    const previousCount = likeCount;

    // Optimistic update
    setIsLiked(!isLiked);
    setLikeCount(isLiked ? likeCount - 1 : likeCount + 1);

    try {
      if (previousLiked) {
        await api.unlikePost(post.id);
      } else {
        await api.likePost(post.id);
      }
    } catch (error) {
      // Rollback on failure
      setIsLiked(previousLiked);
      setLikeCount(previousCount);
    }
  }, [isLiked, likeCount, post.id]);

  // Double-tap to like
  const handleDoubleClick = useCallback(() => {
    if (!isLiked) {
      handleLike();
      setShowHeartAnimation(true);
      setTimeout(() => setShowHeartAnimation(false), 1000);
    }
  }, [isLiked, handleLike]);

  return (
    <article className="bg-white dark:bg-black border-b border-gray-200 dark:border-gray-800">
      {/* Header */}
      <header className="flex items-center px-4 py-3">
        <Avatar
          src={post.author.avatarUrl}
          alt={post.author.username}
          size="sm"
          hasStory={post.author.hasActiveStory}
        />
        <div className="ml-3 flex-1">
          <span className="font-semibold text-instagram-text dark:text-white">
            {post.author.username}
          </span>
          {post.location && (
            <span className="text-xs text-instagram-text-secondary block">
              {post.location}
            </span>
          )}
        </div>
        <button aria-label="More options" className="p-2">
          <MoreIcon className="w-5 h-5" />
        </button>
      </header>

      {/* Image */}
      <div
        className="relative aspect-square"
        onDoubleClick={handleDoubleClick}
      >
        <img
          src={post.mediumUrl}
          alt={post.caption || 'Photo'}
          className="w-full h-full object-cover"
          loading="lazy"
        />

        {/* Double-tap heart animation */}
        {showHeartAnimation && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <HeartIcon
              className="w-24 h-24 text-white animate-heart-pop"
              filled
            />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center px-4 py-2">
        <button
          onClick={handleLike}
          aria-label={isLiked ? 'Unlike' : 'Like'}
          aria-pressed={isLiked}
          className="p-2 -ml-2"
        >
          <HeartIcon
            className={`w-6 h-6 transition-transform ${
              isLiked
                ? 'text-instagram-red scale-110'
                : 'text-instagram-text dark:text-white'
            }`}
            filled={isLiked}
          />
        </button>
        <button aria-label="Comment" className="p-2">
          <CommentIcon className="w-6 h-6 text-instagram-text dark:text-white" />
        </button>
        <button aria-label="Share" className="p-2">
          <ShareIcon className="w-6 h-6 text-instagram-text dark:text-white" />
        </button>
        <div className="flex-1" />
        <button aria-label="Save" className="p-2 -mr-2">
          <BookmarkIcon className="w-6 h-6 text-instagram-text dark:text-white" />
        </button>
      </div>

      {/* Like count and caption */}
      <div className="px-4 pb-4">
        <div className="font-semibold text-sm text-instagram-text dark:text-white">
          {likeCount.toLocaleString()} likes
        </div>
        {post.caption && (
          <p className="mt-1 text-sm text-instagram-text dark:text-white">
            <span className="font-semibold">{post.author.username}</span>{' '}
            {post.caption}
          </p>
        )}
        <time className="text-xs text-instagram-text-secondary mt-1 block">
          {formatRelativeTime(post.createdAt)}
        </time>
      </div>
    </article>
  );
});
```

### Performance Impact

| Metric | Without Virtualization | With Virtualization |
|--------|------------------------|---------------------|
| DOM nodes (100 posts) | 800+ | ~50 |
| Memory usage | 200MB+ | ~80MB |
| Scroll FPS | Degrades to 30fps | Constant 60fps |
| Time to interactive | 3s+ | <1s |

---

## Step 4: Story Tray and Viewer

### StoryTray Component

```tsx
import { useRef } from 'react';
import { useStoryStore } from '../../stores/storyStore';
import { StoryRing } from './StoryRing';

export function StoryTray() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { storyUsers, openViewer } = useStoryStore();

  return (
    <div
      ref={scrollRef}
      className="flex gap-4 px-4 py-4 overflow-x-auto scrollbar-hide"
      role="list"
      aria-label="Stories"
    >
      {/* Add your story */}
      <button
        className="flex flex-col items-center flex-shrink-0"
        aria-label="Add to your story"
      >
        <div className="relative">
          <Avatar src={currentUser.avatarUrl} size="lg" />
          <div className="absolute bottom-0 right-0 bg-instagram-blue rounded-full p-0.5 border-2 border-white dark:border-black">
            <PlusIcon className="w-3 h-3 text-white" />
          </div>
        </div>
        <span className="text-xs mt-1 text-instagram-text dark:text-white">
          Your story
        </span>
      </button>

      {/* Story rings */}
      {storyUsers.map((user, index) => (
        <StoryRing
          key={user.id}
          user={user}
          hasSeen={user.hasSeen}
          onClick={() => openViewer(index)}
        />
      ))}
    </div>
  );
}
```

### StoryRing with Gradient

```tsx
interface StoryRingProps {
  user: StoryUser;
  hasSeen: boolean;
  onClick: () => void;
}

export function StoryRing({ user, hasSeen, onClick }: StoryRingProps) {
  return (
    <button
      className="flex flex-col items-center flex-shrink-0"
      onClick={onClick}
      aria-label={`View ${user.username}'s story`}
    >
      <div
        className={`p-[3px] rounded-full ${
          hasSeen ? 'bg-gray-300 dark:bg-gray-700' : 'story-ring-gradient'
        }`}
      >
        <div className="p-[2px] bg-white dark:bg-black rounded-full">
          <img
            src={user.avatarUrl}
            alt={user.username}
            className="w-14 h-14 rounded-full object-cover"
          />
        </div>
      </div>
      <span className="text-xs mt-1 text-instagram-text dark:text-white truncate max-w-[64px]">
        {user.username}
      </span>
    </button>
  );
}
```

### Story Ring Gradient CSS

```css
/* The signature Instagram story gradient */
.story-ring-gradient {
  background: conic-gradient(
    from 180deg,
    #833AB4,  /* Purple */
    #FD1D1D,  /* Red */
    #FCB045,  /* Orange/Yellow */
    #833AB4   /* Back to purple for seamless loop */
  );
}

/* Alternative: linear gradient for simpler rendering */
.story-ring-gradient-linear {
  background: linear-gradient(
    45deg,
    #f09433,
    #e6683c,
    #dc2743,
    #cc2366,
    #bc1888
  );
}
```

### StoryViewer with Auto-advance

```tsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { useStoryStore } from '../../stores/storyStore';
import { StoryProgress } from './StoryProgress';

export function StoryViewer() {
  const {
    storyUsers,
    currentUserIndex,
    currentStoryIndex,
    isOpen,
    closeViewer,
    nextStory,
    prevStory,
    nextUser,
    prevUser,
  } = useStoryStore();

  const [isPaused, setIsPaused] = useState(false);
  const progressRef = useRef<number>(0);
  const animationRef = useRef<number | null>(null);

  const currentUser = storyUsers[currentUserIndex];
  const currentStory = currentUser?.stories[currentStoryIndex];
  const storyDuration = 5000; // 5 seconds per story

  // Auto-advance timer
  useEffect(() => {
    if (!isOpen || isPaused || !currentStory) return;

    const startTime = Date.now();
    const initialProgress = progressRef.current;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = initialProgress + (elapsed / storyDuration) * 100;

      if (progress >= 100) {
        progressRef.current = 0;
        // Go to next story or next user
        if (currentStoryIndex < currentUser.stories.length - 1) {
          nextStory();
        } else if (currentUserIndex < storyUsers.length - 1) {
          nextUser();
        } else {
          closeViewer();
        }
        return;
      }

      progressRef.current = progress;
      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isOpen, isPaused, currentStory, currentStoryIndex, currentUserIndex]);

  // Reset progress on story change
  useEffect(() => {
    progressRef.current = 0;
  }, [currentStoryIndex, currentUserIndex]);

  // Touch/click navigation
  const handleTap = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const tapX = clientX - rect.left;
    const tapPercent = tapX / rect.width;

    if (tapPercent < 0.3) {
      // Left third: go back
      if (currentStoryIndex > 0) {
        prevStory();
      } else if (currentUserIndex > 0) {
        prevUser();
      }
    } else {
      // Right two-thirds: go forward
      if (currentStoryIndex < currentUser.stories.length - 1) {
        nextStory();
      } else if (currentUserIndex < storyUsers.length - 1) {
        nextUser();
      } else {
        closeViewer();
      }
    }
    progressRef.current = 0;
  }, [currentStoryIndex, currentUserIndex, currentUser, storyUsers.length]);

  // Pause on hold
  const handlePointerDown = useCallback(() => setIsPaused(true), []);
  const handlePointerUp = useCallback(() => setIsPaused(false), []);

  if (!isOpen || !currentStory) return null;

  return (
    <div
      className="fixed inset-0 bg-black z-50"
      role="dialog"
      aria-modal="true"
      aria-label={`${currentUser.username}'s story`}
    >
      {/* Progress bars */}
      <StoryProgress
        stories={currentUser.stories}
        currentIndex={currentStoryIndex}
        progress={progressRef.current}
        isPaused={isPaused}
      />

      {/* Header */}
      <header className="absolute top-12 left-0 right-0 flex items-center px-4 z-10">
        <img
          src={currentUser.avatarUrl}
          alt={currentUser.username}
          className="w-8 h-8 rounded-full"
        />
        <span className="ml-2 text-white font-semibold">
          {currentUser.username}
        </span>
        <span className="ml-2 text-gray-400 text-sm">
          {formatRelativeTime(currentStory.createdAt)}
        </span>
        <div className="flex-1" />
        <button
          onClick={closeViewer}
          aria-label="Close"
          className="p-2"
        >
          <CloseIcon className="w-6 h-6 text-white" />
        </button>
      </header>

      {/* Story content */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        onClick={handleTap}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <img
          src={currentStory.mediaUrl}
          alt="Story"
          className="max-w-full max-h-full object-contain"
        />
      </div>
    </div>
  );
}
```

### StoryProgress Component

```tsx
interface StoryProgressProps {
  stories: Story[];
  currentIndex: number;
  progress: number;
  isPaused: boolean;
}

export function StoryProgress({
  stories,
  currentIndex,
  progress,
  isPaused,
}: StoryProgressProps) {
  return (
    <div className="absolute top-4 left-2 right-2 flex gap-1 z-10">
      {stories.map((_, index) => (
        <div
          key={index}
          className="flex-1 h-0.5 bg-white/30 rounded-full overflow-hidden"
        >
          <div
            className={`h-full bg-white transition-all ${
              isPaused ? '' : 'duration-100'
            }`}
            style={{
              width:
                index < currentIndex
                  ? '100%'
                  : index === currentIndex
                  ? `${progress}%`
                  : '0%',
            }}
          />
        </div>
      ))}
    </div>
  );
}
```

---

## Step 5: Post Creation Flow

### CreatePost Component

```tsx
import { useState, useCallback, useRef } from 'react';
import { api } from '../../services/api';
import { useFeedStore } from '../../stores/feedStore';

export function CreatePost({ onClose }: { onClose: () => void }) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { addPost } = useFeedStore();

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file');
      return;
    }

    // Validate file size (10MB max)
    if (file.size > 10 * 1024 * 1024) {
      setError('Image must be less than 10MB');
      return;
    }

    setSelectedFile(file);
    setError(null);

    // Generate preview
    const reader = new FileReader();
    reader.onload = (event) => {
      setPreview(event.target?.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!selectedFile) return;

    setIsUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('image', selectedFile);
      formData.append('caption', caption);

      const response = await api.createPost(formData, (progress) => {
        setUploadProgress(progress);
      });

      // Add to feed (optimistically - post is processing)
      addPost({
        id: response.postId,
        status: 'processing',
        caption,
        // Use local preview while processing
        mediumUrl: preview!,
        createdAt: new Date().toISOString(),
      });

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  }, [selectedFile, caption, preview, addPost, onClose]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-900 rounded-lg w-full max-w-lg mx-4">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <button onClick={onClose} className="text-instagram-text dark:text-white">
            Cancel
          </button>
          <h2 className="font-semibold text-instagram-text dark:text-white">
            New Post
          </h2>
          <button
            onClick={handleSubmit}
            disabled={!selectedFile || isUploading}
            className="text-instagram-blue font-semibold disabled:opacity-50"
          >
            {isUploading ? 'Sharing...' : 'Share'}
          </button>
        </header>

        {/* Content */}
        <div className="p-4">
          {!preview ? (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full aspect-square border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg flex flex-col items-center justify-center gap-2 hover:border-instagram-blue transition-colors"
            >
              <ImageIcon className="w-12 h-12 text-gray-400" />
              <span className="text-instagram-text-secondary">
                Click to select a photo
              </span>
            </button>
          ) : (
            <div className="relative aspect-square rounded-lg overflow-hidden">
              <img
                src={preview}
                alt="Preview"
                className="w-full h-full object-cover"
              />
              <button
                onClick={() => {
                  setSelectedFile(null);
                  setPreview(null);
                }}
                className="absolute top-2 right-2 bg-black/50 rounded-full p-1"
                aria-label="Remove image"
              >
                <CloseIcon className="w-5 h-5 text-white" />
              </button>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="hidden"
          />

          {/* Caption */}
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Write a caption..."
            maxLength={2200}
            className="w-full mt-4 p-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-transparent text-instagram-text dark:text-white placeholder-instagram-text-secondary resize-none"
            rows={3}
          />
          <div className="text-right text-xs text-instagram-text-secondary mt-1">
            {caption.length}/2200
          </div>

          {/* Upload progress */}
          {isUploading && (
            <div className="mt-4">
              <div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-instagram-blue transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-center text-sm text-instagram-text-secondary mt-2">
                Uploading... {uploadProgress}%
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="mt-4 text-center text-sm text-instagram-red">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
```

### API Client with Progress Tracking

```typescript
export const api = {
  createPost: async (
    formData: FormData,
    onProgress?: (percent: number) => void
  ): Promise<{ postId: string; status: string }> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress(percent);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(`Upload failed: ${xhr.statusText}`));
        }
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Network error during upload'));
      });

      xhr.open('POST', '/api/v1/posts');
      xhr.withCredentials = true;
      xhr.send(formData);
    });
  },
};
```

---

## Step 6: Brand-Authentic Design System

### Tailwind Configuration

```javascript
// tailwind.config.js
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        instagram: {
          blue: '#0095F6',
          red: '#ED4956',
          purple: '#833AB4',
          orange: '#FCB045',
          background: '#FAFAFA',
          text: '#262626',
          'text-secondary': '#8E8E8E',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
      },
      animation: {
        'heart-pop': 'heartPop 1s ease-in-out',
      },
      keyframes: {
        heartPop: {
          '0%': { transform: 'scale(0)', opacity: '1' },
          '50%': { transform: 'scale(1.2)', opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '0' },
        },
      },
    },
  },
  plugins: [],
};
```

### Global Styles

```css
/* src/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  body {
    @apply bg-instagram-background dark:bg-black;
    @apply text-instagram-text dark:text-white;
  }
}

@layer components {
  /* Story ring gradient */
  .story-ring-gradient {
    background: conic-gradient(
      from 180deg,
      #833AB4,
      #FD1D1D,
      #FCB045,
      #833AB4
    );
  }

  /* Primary button */
  .btn-primary {
    @apply bg-instagram-blue text-white font-semibold py-2 px-4 rounded-lg;
    @apply hover:bg-blue-600 transition-colors;
    @apply disabled:opacity-50 disabled:cursor-not-allowed;
  }

  /* Secondary button */
  .btn-secondary {
    @apply border border-gray-300 dark:border-gray-600;
    @apply text-instagram-text dark:text-white font-semibold py-2 px-4 rounded-lg;
    @apply hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors;
  }

  /* Hide scrollbar but allow scrolling */
  .scrollbar-hide {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
  .scrollbar-hide::-webkit-scrollbar {
    display: none;
  }
}
```

### Avatar Component

```tsx
interface AvatarProps {
  src: string;
  alt: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  hasStory?: boolean;
  storyViewed?: boolean;
}

const sizeClasses = {
  sm: 'w-8 h-8',
  md: 'w-10 h-10',
  lg: 'w-14 h-14',
  xl: 'w-20 h-20',
};

export function Avatar({
  src,
  alt,
  size = 'md',
  hasStory = false,
  storyViewed = false,
}: AvatarProps) {
  const imgElement = (
    <img
      src={src}
      alt={alt}
      className={`${sizeClasses[size]} rounded-full object-cover`}
    />
  );

  if (!hasStory) return imgElement;

  return (
    <div
      className={`p-[2px] rounded-full ${
        storyViewed ? 'bg-gray-300 dark:bg-gray-700' : 'story-ring-gradient'
      }`}
    >
      <div className="p-[1px] bg-white dark:bg-black rounded-full">
        {imgElement}
      </div>
    </div>
  );
}
```

---

## Step 7: State Management with Zustand

### Feed Store

```typescript
import { create } from 'zustand';
import { api } from '../services/api';
import type { Post } from '../types';

interface FeedState {
  posts: Post[];
  cursor: string | null;
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadFeed: () => Promise<void>;
  loadMore: () => Promise<void>;
  addPost: (post: Post) => void;
  updatePost: (id: string, updates: Partial<Post>) => void;
  removePost: (id: string) => void;
}

export const useFeedStore = create<FeedState>((set, get) => ({
  posts: [],
  cursor: null,
  hasMore: true,
  isLoading: false,
  error: null,

  loadFeed: async () => {
    if (get().isLoading) return;

    set({ isLoading: true, error: null });

    try {
      const response = await api.getFeed();
      set({
        posts: response.posts,
        cursor: response.nextCursor,
        hasMore: response.hasMore,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load feed',
        isLoading: false,
      });
    }
  },

  loadMore: async () => {
    const { isLoading, hasMore, cursor, posts } = get();
    if (isLoading || !hasMore) return;

    set({ isLoading: true });

    try {
      const response = await api.getFeed(cursor ?? undefined);
      set({
        posts: [...posts, ...response.posts],
        cursor: response.nextCursor,
        hasMore: response.hasMore,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load more',
        isLoading: false,
      });
    }
  },

  addPost: (post) => {
    set((state) => ({
      posts: [post, ...state.posts],
    }));
  },

  updatePost: (id, updates) => {
    set((state) => ({
      posts: state.posts.map((p) =>
        p.id === id ? { ...p, ...updates } : p
      ),
    }));
  },

  removePost: (id) => {
    set((state) => ({
      posts: state.posts.filter((p) => p.id !== id),
    }));
  },
}));
```

### Story Store

```typescript
import { create } from 'zustand';
import { api } from '../services/api';
import type { StoryUser, Story } from '../types';

interface StoryState {
  storyUsers: StoryUser[];
  isOpen: boolean;
  currentUserIndex: number;
  currentStoryIndex: number;

  // Actions
  loadStories: () => Promise<void>;
  openViewer: (userIndex: number) => void;
  closeViewer: () => void;
  nextStory: () => void;
  prevStory: () => void;
  nextUser: () => void;
  prevUser: () => void;
  markAsSeen: (storyId: string) => void;
}

export const useStoryStore = create<StoryState>((set, get) => ({
  storyUsers: [],
  isOpen: false,
  currentUserIndex: 0,
  currentStoryIndex: 0,

  loadStories: async () => {
    const response = await api.getStoryFeed();
    set({ storyUsers: response.users });
  },

  openViewer: (userIndex) => {
    set({
      isOpen: true,
      currentUserIndex: userIndex,
      currentStoryIndex: 0,
    });
    // Mark first story as seen
    const user = get().storyUsers[userIndex];
    if (user?.stories[0]) {
      get().markAsSeen(user.stories[0].id);
    }
  },

  closeViewer: () => {
    set({ isOpen: false });
  },

  nextStory: () => {
    const { storyUsers, currentUserIndex, currentStoryIndex } = get();
    const user = storyUsers[currentUserIndex];
    if (currentStoryIndex < user.stories.length - 1) {
      const nextIndex = currentStoryIndex + 1;
      set({ currentStoryIndex: nextIndex });
      get().markAsSeen(user.stories[nextIndex].id);
    }
  },

  prevStory: () => {
    const { currentStoryIndex } = get();
    if (currentStoryIndex > 0) {
      set({ currentStoryIndex: currentStoryIndex - 1 });
    }
  },

  nextUser: () => {
    const { storyUsers, currentUserIndex } = get();
    if (currentUserIndex < storyUsers.length - 1) {
      const nextIndex = currentUserIndex + 1;
      set({
        currentUserIndex: nextIndex,
        currentStoryIndex: 0,
      });
      const user = storyUsers[nextIndex];
      if (user?.stories[0]) {
        get().markAsSeen(user.stories[0].id);
      }
    }
  },

  prevUser: () => {
    const { storyUsers, currentUserIndex } = get();
    if (currentUserIndex > 0) {
      const prevIndex = currentUserIndex - 1;
      const user = storyUsers[prevIndex];
      set({
        currentUserIndex: prevIndex,
        currentStoryIndex: user.stories.length - 1,
      });
    }
  },

  markAsSeen: async (storyId) => {
    await api.viewStory(storyId);
    set((state) => ({
      storyUsers: state.storyUsers.map((user) => ({
        ...user,
        hasSeen: user.stories.every((s) =>
          s.id === storyId ? true : s.seen
        ),
        stories: user.stories.map((s) =>
          s.id === storyId ? { ...s, seen: true } : s
        ),
      })),
    }));
  },
}));
```

---

## Step 8: Accessibility Features

### Keyboard Navigation

```tsx
// StoryViewer keyboard controls
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!isOpen) return;

    switch (e.key) {
      case 'ArrowLeft':
        if (currentStoryIndex > 0) {
          prevStory();
        } else if (currentUserIndex > 0) {
          prevUser();
        }
        break;
      case 'ArrowRight':
      case ' ':
        if (currentStoryIndex < currentUser.stories.length - 1) {
          nextStory();
        } else if (currentUserIndex < storyUsers.length - 1) {
          nextUser();
        } else {
          closeViewer();
        }
        break;
      case 'Escape':
        closeViewer();
        break;
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [isOpen, currentStoryIndex, currentUserIndex]);
```

### ARIA Labels and Roles

```tsx
// Feed container
<div
  role="feed"
  aria-label="Photo feed"
  aria-busy={isLoading}
>

// Post card
<article
  aria-label={`Post by ${post.author.username}`}
>

// Like button
<button
  aria-label={isLiked ? 'Unlike' : 'Like'}
  aria-pressed={isLiked}
>

// Story viewer
<div
  role="dialog"
  aria-modal="true"
  aria-label={`${currentUser.username}'s story`}
>
```

### Focus Management

```tsx
// Trap focus in modal
import { useEffect, useRef } from 'react';

function useFocusTrap(isActive: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isActive) return;

    const container = containerRef.current;
    if (!container) return;

    const focusableElements = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    firstElement?.focus();

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement?.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement?.focus();
      }
    };

    container.addEventListener('keydown', handleTab);
    return () => container.removeEventListener('keydown', handleTab);
  }, [isActive]);

  return containerRef;
}
```

---

## Step 9: Dark Mode Support

### Theme Toggle

```tsx
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ThemeState {
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'system',
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
    }),
    { name: 'theme-preference' }
  )
);

function applyTheme(theme: 'light' | 'dark' | 'system') {
  const root = document.documentElement;

  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', prefersDark);
  } else {
    root.classList.toggle('dark', theme === 'dark');
  }
}

// Apply on mount
useEffect(() => {
  const theme = useThemeStore.getState().theme;
  applyTheme(theme);

  // Listen for system preference changes
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const handleChange = () => {
    if (useThemeStore.getState().theme === 'system') {
      applyTheme('system');
    }
  };
  mediaQuery.addEventListener('change', handleChange);
  return () => mediaQuery.removeEventListener('change', handleChange);
}, []);
```

### Dark Mode Styles

```css
/* True black for OLED power savings */
.dark {
  --bg-primary: #000000;
  --bg-secondary: #121212;
  --text-primary: #ffffff;
  --text-secondary: #8e8e8e;
  --border-color: #262626;
}

/* Light mode */
:root {
  --bg-primary: #fafafa;
  --bg-secondary: #ffffff;
  --text-primary: #262626;
  --text-secondary: #8e8e8e;
  --border-color: #dbdbdb;
}
```

---

## Step 10: Performance Optimizations

### Image Lazy Loading

```tsx
function LazyImage({ src, alt, className }: LazyImageProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isInView, setIsInView] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '100px' }
    );

    if (imgRef.current) {
      observer.observe(imgRef.current);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={imgRef} className={`relative ${className}`}>
      {/* Placeholder */}
      {!isLoaded && (
        <div className="absolute inset-0 bg-gray-200 dark:bg-gray-800 animate-pulse" />
      )}

      {/* Actual image */}
      {isInView && (
        <img
          src={src}
          alt={alt}
          className={`transition-opacity duration-300 ${
            isLoaded ? 'opacity-100' : 'opacity-0'
          }`}
          onLoad={() => setIsLoaded(true)}
        />
      )}
    </div>
  );
}
```

### Debounced Scroll Handler

```typescript
function useDebouncedCallback<T extends (...args: unknown[]) => void>(
  callback: T,
  delay: number
): T {
  const timeoutRef = useRef<number | null>(null);

  return useCallback(
    ((...args) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = window.setTimeout(() => {
        callback(...args);
      }, delay);
    }) as T,
    [callback, delay]
  );
}

// Usage
const debouncedLoadMore = useDebouncedCallback(loadMore, 150);
```

---

## Closing Summary

"I've designed Instagram's frontend with focus on:

1. **Virtualized Feed** - TanStack Virtual for 60fps scrolling with 50 DOM nodes instead of 800
2. **Story Experience** - Gradient rings with conic-gradient, auto-advance viewer with tap navigation
3. **Post Creation** - Progressive upload with preview and progress indication
4. **Brand Fidelity** - Instagram's exact color palette, typography, and interaction patterns

The key insight is that virtualization is essential for social feeds - without it, memory and performance degrade over time as users scroll through hundreds of posts. Combined with optimistic updates and proper focus management, this creates a native-feeling web experience."

---

## Potential Follow-up Questions

1. **How would you handle offline support?**
   - Service worker for caching API responses
   - IndexedDB for persistent post storage
   - Background sync for queued actions

2. **How would you implement video playback in feed?**
   - IntersectionObserver to auto-play when visible
   - Pause when scrolled out of view
   - HLS.js for adaptive streaming

3. **How would you optimize for Core Web Vitals?**
   - LCP: Prioritize above-fold images with preload
   - FID: Defer non-critical JavaScript
   - CLS: Reserve space for images with aspect-ratio
