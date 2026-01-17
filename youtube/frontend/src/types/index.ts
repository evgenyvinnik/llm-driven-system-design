// User types
export interface User {
  id: string;
  username: string;
  email: string;
  channelName: string;
  role: 'user' | 'admin';
  avatarUrl: string | null;
}

// Channel types
export interface Channel {
  id: string;
  username: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  subscriberCount: number;
  videoCount?: number;
  isSubscribed?: boolean;
  createdAt: string;
}

// Video types
export interface Video {
  id: string;
  title: string;
  description: string | null;
  duration: number | null;
  status: 'uploading' | 'processing' | 'ready' | 'failed' | 'blocked';
  visibility: 'public' | 'unlisted' | 'private';
  thumbnailUrl: string | null;
  viewCount: number;
  likeCount: number;
  dislikeCount: number;
  commentCount: number;
  categories: string[];
  tags: string[];
  publishedAt: string | null;
  createdAt: string;
  channel?: {
    id: string;
    name: string;
    username: string;
    avatarUrl: string | null;
    subscriberCount?: number;
  };
  userReaction?: 'like' | 'dislike' | null;
  watchProgress?: {
    position: number;
    percentage: number;
  } | null;
}

// Video with recommendation source
export interface RecommendedVideo extends Video {
  source?: 'subscription' | 'category' | 'trending' | 'popular';
}

// Streaming info
export interface StreamingInfo {
  videoId: string;
  title: string;
  description: string | null;
  duration: number;
  thumbnailUrl: string | null;
  channel: {
    id: string;
    name: string;
    username: string;
    avatarUrl: string | null;
  };
  masterManifestUrl: string;
  resolutions: Resolution[];
  viewCount: number;
  likeCount: number;
  dislikeCount: number;
  publishedAt: string;
}

export interface Resolution {
  resolution: string;
  manifestUrl: string;
  videoUrl: string;
  bitrate: number;
  width: number;
  height: number;
}

// Comment types
export interface Comment {
  id: string;
  text: string;
  likeCount: number;
  isEdited: boolean;
  createdAt: string;
  replyCount?: number;
  user: {
    id: string;
    username: string;
    avatarUrl: string | null;
  };
  parentId: string | null;
}

// Upload types
export interface UploadSession {
  uploadId: string;
  totalChunks: number;
  chunkSize: number;
  rawVideoKey: string;
}

export interface UploadProgress {
  uploadId: string;
  filename: string;
  fileSize: number;
  status: 'active' | 'completed' | 'cancelled';
  uploadedChunks: number;
  totalChunks: number;
  progress: number;
}

export interface TranscodingStatus {
  videoId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress?: number;
  completedResolutions?: string[];
  error?: string;
}

// API Response types
export interface PaginatedResponse<T> {
  videos?: T[];
  comments?: T[];
  subscriptions?: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface SearchResponse extends PaginatedResponse<Video> {
  query: string;
}

// Auth types
export interface AuthResponse {
  user: User;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface RegisterData {
  username: string;
  email: string;
  password: string;
  channelName?: string;
}
