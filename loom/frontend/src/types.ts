export interface User {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
  role: string;
  avatarUrl?: string;
}

export interface Video {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  durationSeconds: number | null;
  status: 'processing' | 'ready' | 'failed';
  storagePath: string | null;
  thumbnailPath: string | null;
  /** Presigned GET URL for `thumbnailPath`, generated server-side. Null when there is no thumbnail. */
  thumbnailUrl?: string | null;
  fileSizeBytes: number | null;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
  author?: {
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

export interface Comment {
  id: string;
  videoId: string;
  userId: string;
  content: string;
  timestampSeconds: number | null;
  parentId: string | null;
  createdAt: string;
  author: {
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
}

export interface Share {
  id: string;
  token: string;
  hasPassword: boolean;
  expiresAt: string | null;
  allowDownload: boolean;
  createdAt: string;
}

export interface ViewEvent {
  id: string;
  videoId: string;
  viewerId: string | null;
  sessionId: string;
  watchDurationSeconds: number;
  completed: boolean;
  createdAt: string;
}

export interface Folder {
  id: string;
  userId: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

export interface AnalyticsSummary {
  totalViews: number;
  uniqueViewers: number;
  avgWatchDurationSeconds: number;
  completionRate: number;
  viewsByDay: { date: string; views: number }[];
}
