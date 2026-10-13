export interface User {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
  role: string;
  avatarUrl?: string;
}

/** uploading -> processing (playable, being improved) -> ready; or uploading -> failed. */
export type VideoStatus = 'uploading' | 'processing' | 'ready' | 'failed';

export interface Video {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  durationSeconds: number | null;
  status: VideoStatus;
  /** 'owner' for the uploader; 'viewer' for someone who opened a share link. */
  access?: 'owner' | 'viewer';
  /** Object keys and failure details are only sent to the owner. */
  storagePath?: string | null;
  thumbnailPath?: string | null;
  failureReason?: string | null;
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

/** What the public share page receives: the video plus a presigned playback URL. */
export interface SharedVideo extends Video {
  downloadUrl: string | null;
  allowDownload: boolean;
}

/** One playback session's report; repeated with the same viewId as heartbeats. */
export interface ViewReport {
  videoId: string;
  viewId: string;
  /** Stable per browser, so anonymous viewers count once in unique-viewer totals. */
  sessionId: string;
  watchDurationSeconds: number;
  completed: boolean;
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
