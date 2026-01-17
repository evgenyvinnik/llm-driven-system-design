/**
 * @fileoverview Feed state store using Zustand.
 * Manages the home feed posts with infinite scroll pagination.
 * Provides optimistic updates for likes to improve perceived performance.
 */

import { create } from 'zustand';
import type { Post } from '@/types';
import { feedApi, postsApi } from '@/services/api';

/**
 * Feed state interface.
 * Contains posts array and pagination state for infinite scroll.
 */
interface FeedState {
  /** Array of posts currently loaded in the feed */
  posts: Post[];
  /** Cursor for pagination (timestamp of last post) */
  cursor: string | null;
  /** Whether more posts are available to load */
  hasMore: boolean;
  /** Whether a fetch operation is in progress */
  isLoading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /**
   * Fetches posts from the API with optional reset.
   * @param reset - If true, clears existing posts and starts fresh
   */
  fetchFeed: (reset?: boolean) => Promise<void>;
  /**
   * Adds a new post to the top of the feed (after creating).
   * @param post - The newly created post
   */
  addPost: (post: Post) => void;
  /**
   * Removes a post from the feed (after deletion).
   * @param postId - ID of the post to remove
   */
  removePost: (postId: string) => void;
  /**
   * Updates a post's properties in the feed.
   * @param postId - ID of the post to update
   * @param updates - Partial post data to merge
   */
  updatePost: (postId: string, updates: Partial<Post>) => void;
  /**
   * Likes a post with optimistic update and rollback on failure.
   * @param postId - ID of the post to like
   */
  likePost: (postId: string) => Promise<void>;
  /**
   * Unlikes a post with optimistic update and rollback on failure.
   * @param postId - ID of the post to unlike
   */
  unlikePost: (postId: string) => Promise<void>;
}

/**
 * Zustand store for feed state.
 * Implements cursor-based pagination and optimistic UI updates.
 */
export const useFeedStore = create<FeedState>((set, get) => ({
  posts: [],
  cursor: null,
  hasMore: true,
  isLoading: false,
  error: null,

  fetchFeed: async (reset = false) => {
    const state = get();
    if (state.isLoading) return;
    if (!reset && !state.hasMore) return;

    set({ isLoading: true, error: null });

    try {
      const cursor = reset ? undefined : state.cursor || undefined;
      const response = await feedApi.getFeed(cursor);

      set((prev) => ({
        posts: reset ? response.posts : [...prev.posts, ...response.posts],
        cursor: response.cursor,
        hasMore: response.has_more,
        isLoading: false,
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch feed',
        isLoading: false,
      });
    }
  },

  addPost: (post: Post) => {
    set((state) => ({
      posts: [post, ...state.posts],
    }));
  },

  removePost: (postId: string) => {
    set((state) => ({
      posts: state.posts.filter((p) => p.id !== postId),
    }));
  },

  updatePost: (postId: string, updates: Partial<Post>) => {
    set((state) => ({
      posts: state.posts.map((p) =>
        p.id === postId ? { ...p, ...updates } : p
      ),
    }));
  },

  likePost: async (postId: string) => {
    const state = get();
    const post = state.posts.find((p) => p.id === postId);
    if (!post || post.is_liked) return;

    // Optimistic update
    set((prev) => ({
      posts: prev.posts.map((p) =>
        p.id === postId
          ? { ...p, is_liked: true, like_count: p.like_count + 1 }
          : p
      ),
    }));

    try {
      await postsApi.likePost(postId);
    } catch {
      // Rollback on error
      set((prev) => ({
        posts: prev.posts.map((p) =>
          p.id === postId
            ? { ...p, is_liked: false, like_count: p.like_count - 1 }
            : p
        ),
      }));
    }
  },

  unlikePost: async (postId: string) => {
    const state = get();
    const post = state.posts.find((p) => p.id === postId);
    if (!post || !post.is_liked) return;

    // Optimistic update
    set((prev) => ({
      posts: prev.posts.map((p) =>
        p.id === postId
          ? { ...p, is_liked: false, like_count: Math.max(0, p.like_count - 1) }
          : p
      ),
    }));

    try {
      await postsApi.unlikePost(postId);
    } catch {
      // Rollback on error
      set((prev) => ({
        posts: prev.posts.map((p) =>
          p.id === postId
            ? { ...p, is_liked: true, like_count: p.like_count + 1 }
            : p
        ),
      }));
    }
  },
}));
