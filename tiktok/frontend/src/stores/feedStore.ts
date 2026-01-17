import { create } from 'zustand';
import { Video } from '@/types';
import { feedApi, videosApi } from '@/services/api';

type FeedType = 'fyp' | 'following' | 'trending';

interface FeedState {
  videos: Video[];
  currentIndex: number;
  isLoading: boolean;
  hasMore: boolean;
  feedType: FeedType;
  setFeedType: (type: FeedType) => void;
  loadMore: () => Promise<void>;
  reset: () => void;
  setCurrentIndex: (index: number) => void;
  likeVideo: (videoId: number) => Promise<void>;
  unlikeVideo: (videoId: number) => Promise<void>;
  recordView: (videoId: number, watchDurationMs: number, completionRate: number) => Promise<void>;
}

export const useFeedStore = create<FeedState>((set, get) => ({
  videos: [],
  currentIndex: 0,
  isLoading: false,
  hasMore: true,
  feedType: 'fyp',

  setFeedType: (type: FeedType) => {
    set({ feedType: type, videos: [], currentIndex: 0, hasMore: true });
    get().loadMore();
  },

  loadMore: async () => {
    const { isLoading, hasMore, videos, feedType } = get();
    if (isLoading || !hasMore) return;

    set({ isLoading: true });

    try {
      let response;
      const offset = videos.length;

      switch (feedType) {
        case 'following':
          response = await feedApi.getFollowing(10, offset);
          break;
        case 'trending':
          response = await feedApi.getTrending(10, offset);
          break;
        default:
          response = await feedApi.getFyp(10, offset);
      }

      const { videos: newVideos, hasMore: more } = response as { videos: Video[]; hasMore: boolean };

      set({
        videos: [...videos, ...newVideos],
        hasMore: more,
        isLoading: false,
      });
    } catch (error) {
      console.error('Failed to load feed:', error);
      set({ isLoading: false });
    }
  },

  reset: () => {
    set({ videos: [], currentIndex: 0, hasMore: true });
    get().loadMore();
  },

  setCurrentIndex: (index: number) => {
    set({ currentIndex: index });

    // Load more when near the end
    const { videos, hasMore, isLoading } = get();
    if (index >= videos.length - 3 && hasMore && !isLoading) {
      get().loadMore();
    }
  },

  likeVideo: async (videoId: number) => {
    try {
      await videosApi.like(videoId);
      set((state) => ({
        videos: state.videos.map((v) =>
          v.id === videoId ? { ...v, isLiked: true, likeCount: v.likeCount + 1 } : v
        ),
      }));
    } catch (error) {
      console.error('Failed to like video:', error);
    }
  },

  unlikeVideo: async (videoId: number) => {
    try {
      await videosApi.unlike(videoId);
      set((state) => ({
        videos: state.videos.map((v) =>
          v.id === videoId ? { ...v, isLiked: false, likeCount: Math.max(0, v.likeCount - 1) } : v
        ),
      }));
    } catch (error) {
      console.error('Failed to unlike video:', error);
    }
  },

  recordView: async (videoId: number, watchDurationMs: number, completionRate: number) => {
    try {
      await videosApi.recordView(videoId, watchDurationMs, completionRate);
    } catch (error) {
      console.error('Failed to record view:', error);
    }
  },
}));
