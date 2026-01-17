export interface User {
  id: number;
  username: string;
  email?: string;
  displayName: string;
  bio?: string;
  avatarUrl?: string;
  followerCount: number;
  followingCount: number;
  tweetCount: number;
  isCelebrity?: boolean;
  role?: string;
  createdAt: string;
  isFollowing?: boolean;
}

export interface Tweet {
  id: string;
  content: string;
  mediaUrls: string[];
  hashtags: string[];
  mentions: number[];
  replyTo: string | null;
  retweetOf: string | null;
  quoteOf: string | null;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  createdAt: string;
  author: {
    id: number;
    username: string;
    displayName: string;
    avatarUrl?: string;
  };
  isLiked: boolean;
  isRetweeted: boolean;
  originalTweet?: Tweet;
  quotedTweet?: Tweet;
}

export interface Trend {
  hashtag: string;
  tweetCount: number;
  score?: number;
  velocity?: number | string;
  isRising?: boolean;
}

export interface AuthState {
  user: User | null;
  isLoading: boolean;
  error: string | null;
}

export interface TimelineState {
  tweets: Tweet[];
  isLoading: boolean;
  error: string | null;
  nextCursor: string | null;
}
