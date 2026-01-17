export interface User {
  id: string;
  username: string;
  email?: string;
  displayName: string;
  bio?: string;
  profilePictureUrl?: string;
  followerCount: number;
  followingCount: number;
  postCount: number;
  isPrivate?: boolean;
  isFollowing?: boolean;
  role?: 'user' | 'admin';
  createdAt?: string;
}

export interface Media {
  id: string;
  mediaType: 'image' | 'video';
  mediaUrl: string;
  thumbnailUrl?: string;
  filterApplied?: string;
  width?: number;
  height?: number;
  orderIndex: number;
}

export interface Post {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  profilePictureUrl?: string;
  caption: string;
  location?: string;
  likeCount: number;
  commentCount: number;
  createdAt: string;
  isLiked?: boolean;
  isSaved?: boolean;
  media: Media[];
}

export interface PostThumbnail {
  id: string;
  thumbnail: string;
  likeCount: number;
  commentCount: number;
  mediaCount: number;
  createdAt: string;
}

export interface Comment {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  profilePictureUrl?: string;
  content: string;
  parentCommentId?: string;
  likeCount: number;
  createdAt: string;
}

export interface Story {
  id: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  thumbnailUrl?: string;
  filterApplied?: string;
  viewCount: number;
  hasViewed?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface StoryUser {
  id: string;
  username: string;
  displayName: string;
  profilePictureUrl?: string;
  storyCount: number;
  hasSeen: boolean;
  latestStoryTime: string;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
}

export type Filter =
  | 'none'
  | 'clarendon'
  | 'gingham'
  | 'moon'
  | 'lark'
  | 'reyes'
  | 'juno'
  | 'slumber'
  | 'crema'
  | 'ludwig'
  | 'aden'
  | 'perpetua';

export const FILTERS: Filter[] = [
  'none',
  'clarendon',
  'gingham',
  'moon',
  'lark',
  'reyes',
  'juno',
  'slumber',
  'crema',
  'ludwig',
  'aden',
  'perpetua',
];
