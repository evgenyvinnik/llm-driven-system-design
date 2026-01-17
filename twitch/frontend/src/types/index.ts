export interface User {
  id: number;
  username: string;
  email?: string;
  displayName: string;
  avatarUrl: string | null;
  bio?: string;
  role: 'user' | 'admin' | 'moderator';
  channel?: {
    id: number;
    streamKey?: string;
    isLive: boolean;
  };
}

export interface Channel {
  id: number;
  name: string;
  title: string;
  description?: string;
  isLive: boolean;
  viewerCount: number;
  followerCount: number;
  subscriberCount?: number;
  thumbnailUrl: string | null;
  offlineBannerUrl?: string | null;
  createdAt?: string;
  user: {
    id?: number;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    bio?: string;
  };
  category: Category | null;
  isFollowing?: boolean;
  isSubscribed?: boolean;
}

export interface Category {
  id?: number;
  name: string;
  slug: string;
  imageUrl?: string;
  liveChannels?: number;
  viewerCount?: number;
}

export interface Stream {
  id: number;
  title: string;
  startedAt: string;
  endedAt?: string;
  peakViewers: number;
  totalViews: number;
  channelName?: string;
  isLive?: boolean;
  viewerCount?: number;
  category?: Category;
}

export interface VOD {
  id: number;
  title: string;
  startedAt: string;
  endedAt: string;
  duration: number;
  peakViewers: number;
  totalViews: number;
  thumbnailUrl: string | null;
  vodUrl: string | null;
  category: Category | null;
}

export interface Emote {
  id: number;
  code: string;
  imageUrl: string;
  tier: number;
  isGlobal: boolean;
}

export interface Badge {
  type: 'subscriber' | 'mod' | 'admin';
  label?: string;
  tier?: number;
}

export interface ChatMessage {
  id: string;
  type: 'chat' | 'system' | 'error';
  channelId: number;
  userId: number | null;
  username: string;
  message: string;
  badges: Badge[];
  timestamp: number;
}

export interface ChatState {
  connected: boolean;
  authenticated: boolean;
  messages: ChatMessage[];
  viewerCount: number;
}
