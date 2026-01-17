export interface User {
  id: number;
  username: string;
  email?: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  followerCount: number;
  followingCount: number;
  videoCount: number;
  likeCount: number;
  createdAt: string;
  isFollowing?: boolean;
  isOwnProfile?: boolean;
}

export interface Video {
  id: number;
  creatorId: number;
  creatorUsername: string;
  creatorDisplayName: string;
  creatorAvatarUrl: string | null;
  videoUrl: string;
  thumbnailUrl: string | null;
  duration: number | null;
  description: string;
  hashtags: string[];
  viewCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  isLiked: boolean;
  isOwnVideo: boolean;
  createdAt: string;
}

export interface Comment {
  id: number;
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  videoId: number;
  parentId: number | null;
  content: string;
  likeCount: number;
  createdAt: string;
  replyCount?: number;
}

export interface FeedResponse {
  videos: Video[];
  hasMore: boolean;
}

export interface CommentsResponse {
  comments: Comment[];
  hasMore: boolean;
}

export interface AuthResponse {
  message: string;
  user: User;
}
