import { create } from 'zustand';
import type { Post } from '@/types';
import { feedApi, postsApi } from '@/services/api';

interface FeedState {
  posts: Post[];
  cursor: string | null;
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  fetchFeed: (reset?: boolean) => Promise<void>;
  addPost: (post: Post) => void;
  removePost: (postId: string) => void;
  updatePost: (postId: string, updates: Partial<Post>) => void;
  likePost: (postId: string) => Promise<void>;
  unlikePost: (postId: string) => Promise<void>;
}

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
