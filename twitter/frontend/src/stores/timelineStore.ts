import { create } from 'zustand';
import { Tweet } from '../types';
import { timelineApi, tweetsApi } from '../services/api';

interface TimelineStore {
  tweets: Tweet[];
  isLoading: boolean;
  error: string | null;
  nextCursor: string | null;
  currentFeed: 'home' | 'explore' | 'user' | 'hashtag';

  fetchHomeTimeline: () => Promise<void>;
  fetchExploreTimeline: () => Promise<void>;
  fetchUserTimeline: (username: string) => Promise<void>;
  fetchHashtagTimeline: (hashtag: string) => Promise<void>;
  loadMore: () => Promise<void>;

  addTweet: (tweet: Tweet) => void;
  removeTweet: (tweetId: string) => void;
  updateTweet: (tweetId: string, updates: Partial<Tweet>) => void;

  likeTweet: (tweetId: string) => Promise<void>;
  unlikeTweet: (tweetId: string) => Promise<void>;
  retweet: (tweetId: string) => Promise<void>;
  unretweet: (tweetId: string) => Promise<void>;

  clear: () => void;
}

let lastFetchParams: { type: string; param?: string } = { type: 'home' };

export const useTimelineStore = create<TimelineStore>((set, get) => ({
  tweets: [],
  isLoading: false,
  error: null,
  nextCursor: null,
  currentFeed: 'home',

  fetchHomeTimeline: async () => {
    set({ isLoading: true, error: null, currentFeed: 'home' });
    lastFetchParams = { type: 'home' };
    try {
      const { tweets, nextCursor } = await timelineApi.getHome();
      set({ tweets, nextCursor, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  fetchExploreTimeline: async () => {
    set({ isLoading: true, error: null, currentFeed: 'explore' });
    lastFetchParams = { type: 'explore' };
    try {
      const { tweets, nextCursor } = await timelineApi.getExplore();
      set({ tweets, nextCursor, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  fetchUserTimeline: async (username: string) => {
    set({ isLoading: true, error: null, currentFeed: 'user' });
    lastFetchParams = { type: 'user', param: username };
    try {
      const { tweets, nextCursor } = await timelineApi.getUserTimeline(username);
      set({ tweets, nextCursor, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  fetchHashtagTimeline: async (hashtag: string) => {
    set({ isLoading: true, error: null, currentFeed: 'hashtag' });
    lastFetchParams = { type: 'hashtag', param: hashtag };
    try {
      const { tweets, nextCursor } = await timelineApi.getHashtag(hashtag);
      set({ tweets, nextCursor, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  loadMore: async () => {
    const { nextCursor, isLoading, tweets } = get();
    if (!nextCursor || isLoading) return;

    set({ isLoading: true });
    try {
      let result;
      switch (lastFetchParams.type) {
        case 'home':
          result = await timelineApi.getHome(50, nextCursor);
          break;
        case 'explore':
          result = await timelineApi.getExplore(50, nextCursor);
          break;
        case 'user':
          result = await timelineApi.getUserTimeline(lastFetchParams.param!, 50, nextCursor);
          break;
        case 'hashtag':
          result = await timelineApi.getHashtag(lastFetchParams.param!, 50, nextCursor);
          break;
        default:
          return;
      }
      set({
        tweets: [...tweets, ...result.tweets],
        nextCursor: result.nextCursor,
        isLoading: false,
      });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  addTweet: (tweet: Tweet) => {
    set((state) => ({ tweets: [tweet, ...state.tweets] }));
  },

  removeTweet: (tweetId: string) => {
    set((state) => ({ tweets: state.tweets.filter((t) => t.id !== tweetId) }));
  },

  updateTweet: (tweetId: string, updates: Partial<Tweet>) => {
    set((state) => ({
      tweets: state.tweets.map((t) =>
        t.id === tweetId ? { ...t, ...updates } : t
      ),
    }));
  },

  likeTweet: async (tweetId: string) => {
    const { updateTweet } = get();
    try {
      const { likeCount } = await tweetsApi.like(tweetId);
      updateTweet(tweetId, { isLiked: true, likeCount });
    } catch (error) {
      console.error('Failed to like tweet:', error);
    }
  },

  unlikeTweet: async (tweetId: string) => {
    const { updateTweet } = get();
    try {
      const { likeCount } = await tweetsApi.unlike(tweetId);
      updateTweet(tweetId, { isLiked: false, likeCount });
    } catch (error) {
      console.error('Failed to unlike tweet:', error);
    }
  },

  retweet: async (tweetId: string) => {
    const { updateTweet } = get();
    try {
      const { retweetCount } = await tweetsApi.retweet(tweetId);
      updateTweet(tweetId, { isRetweeted: true, retweetCount });
    } catch (error) {
      console.error('Failed to retweet:', error);
    }
  },

  unretweet: async (tweetId: string) => {
    const { updateTweet } = get();
    try {
      const { retweetCount } = await tweetsApi.unretweet(tweetId);
      updateTweet(tweetId, { isRetweeted: false, retweetCount });
    } catch (error) {
      console.error('Failed to unretweet:', error);
    }
  },

  clear: () => {
    set({ tweets: [], nextCursor: null, error: null });
  },
}));
