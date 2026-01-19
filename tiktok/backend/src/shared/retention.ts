import { createLogger, auditLog } from './logger.js';

const logger = createLogger('retention');

// Video interface
interface Video {
  id: number;
  creator_id: number;
  video_url: string;
  view_count: number;
  like_count: number;
  share_count: number;
  status: string;
  created_at: string;
  updated_at: string;
  last_accessed_at?: string;
  deletion_reason?: string;
}

// Record with timestamp
interface TimestampedRecord {
  created_at: string;
}

// Retention policy interface
interface RetentionPolicy {
  hotStorage: number;
  archiveAfter: number | null;
  deleteAfter: number | null;
  reason?: string;
}

// Video retention policy result
interface VideoRetentionPolicyResult {
  status: string;
  policy: RetentionPolicy & { preserveIndefinitely?: boolean };
  retainUntil?: string;
  reason?: string;
  storageTier?: string;
}

// Archive result
interface ArchiveResult {
  success: boolean;
  archiveKey: string;
}

/**
 * Data retention configuration for TikTok platform
 *
 * WHY these policies matter:
 * - Viral content needs to stay accessible indefinitely for platform value
 * - User-deleted content must be retained briefly for legal/DMCA compliance
 * - Watch history has diminishing value over time for recommendations
 * - Storage costs grow linearly with content, so archival is critical
 */

export const retentionConfig = {
  // Video content retention
  videos: {
    // Active videos - never auto-delete
    active: {
      hotStorage: Infinity, // Always in hot storage while active
      archiveAfter: null, // Don't archive active videos
      deleteAfter: null, // Never auto-delete active videos
    } as RetentionPolicy,

    // User-deleted videos - keep for legal compliance
    deleted: {
      hotStorage: 0, // Move immediately from hot storage
      archiveAfter: 0, // Archive immediately
      deleteAfter: 30 * 24 * 60 * 60 * 1000, // Delete after 30 days
      reason: 'Legal hold for DMCA claims and user disputes',
    } as RetentionPolicy,

    // Policy-violated videos - longer retention for appeals
    policyViolation: {
      hotStorage: 0,
      archiveAfter: 0,
      deleteAfter: 90 * 24 * 60 * 60 * 1000, // 90 days for appeals
      reason: 'Extended retention for policy violation appeals',
    } as RetentionPolicy,

    // Viral thresholds for preservation
    viralThresholds: {
      viewCount: 1000000, // 1M views
      likeCount: 100000, // 100K likes
      shareCount: 10000, // 10K shares
    },
  },

  // User data retention
  users: {
    // Active accounts
    active: {
      deleteAfter: null, // Never auto-delete
    },

    // Deactivated accounts - GDPR/privacy compliance
    deactivated: {
      anonymizeAfter: 30 * 24 * 60 * 60 * 1000, // 30 days
      deleteAfter: 90 * 24 * 60 * 60 * 1000, // 90 days
    },
  },

  // Engagement data retention
  watchHistory: {
    hotStorage: 90 * 24 * 60 * 60 * 1000, // 90 days in PostgreSQL
    archiveAfter: 90 * 24 * 60 * 60 * 1000, // Archive after 90 days
    deleteAfter: 365 * 24 * 60 * 60 * 1000, // Delete after 1 year
    reason: 'Watch history value decreases over time for recommendations',
  },

  // Session and ephemeral data
  sessions: {
    ttl: 7 * 24 * 60 * 60, // 7 days (Redis TTL in seconds)
  },

  rateLimitCounters: {
    ttl: 60 * 60, // 1 hour max (Redis TTL in seconds)
  },

  idempotencyKeys: {
    ttl: 24 * 60 * 60, // 24 hours (Redis TTL in seconds)
  },

  viewCountBuffer: {
    ttl: 5 * 60, // 5 minutes (Redis TTL in seconds)
  },

  // Analytics and audit data
  analytics: {
    hotStorage: 90 * 24 * 60 * 60 * 1000, // 90 days in hot storage
    archiveAfter: 90 * 24 * 60 * 60 * 1000, // Archive to cold storage
    deleteAfter: 2 * 365 * 24 * 60 * 60 * 1000, // 2 years
  },

  auditLogs: {
    hotStorage: 365 * 24 * 60 * 60 * 1000, // 1 year in hot storage
    archiveAfter: 365 * 24 * 60 * 60 * 1000,
    deleteAfter: 7 * 365 * 24 * 60 * 60 * 1000, // 7 years for compliance
  },

  // User embeddings/preferences
  userEmbeddings: {
    // Continuously updated, never archived
    deleteAfter: null,
    updateDecayFactor: 0.99, // Decay old preferences by 1% each update
  },
};

/**
 * Storage tier configuration
 */
export const storageTiers = {
  hot: {
    name: 'hot',
    description: 'Primary storage (MinIO/S3 Standard)',
    costPerGBMonth: 0.023, // Approximate S3 Standard pricing
    accessLatency: '<100ms',
  },
  warm: {
    name: 'warm',
    description: 'Infrequent access storage (S3 IA)',
    costPerGBMonth: 0.0125,
    accessLatency: '<500ms',
  },
  cold: {
    name: 'cold',
    description: 'Archive storage (S3 Glacier)',
    costPerGBMonth: 0.004,
    accessLatency: '3-5 hours',
  },
  glacier: {
    name: 'glacier',
    description: 'Deep archive (S3 Glacier Deep Archive)',
    costPerGBMonth: 0.00099,
    accessLatency: '12-48 hours',
  },
} as const;

/**
 * Check if a video is viral (should never be archived)
 */
export const isViralVideo = (video: Video): boolean => {
  const thresholds = retentionConfig.videos.viralThresholds;
  return (
    video.view_count >= thresholds.viewCount ||
    video.like_count >= thresholds.likeCount ||
    video.share_count >= thresholds.shareCount
  );
};

/**
 * Get the appropriate storage tier for a video
 */
export const getVideoStorageTier = (video: Video): string => {
  // Viral content always stays hot
  if (isViralVideo(video)) {
    return 'hot';
  }

  const age = Date.now() - new Date(video.created_at).getTime();
  const lastAccessAge = video.last_accessed_at
    ? Date.now() - new Date(video.last_accessed_at).getTime()
    : age;

  // Recently accessed stays hot
  if (lastAccessAge < 7 * 24 * 60 * 60 * 1000) {
    return 'hot';
  }

  // Old and rarely accessed goes to warm
  if (age > 90 * 24 * 60 * 60 * 1000 && lastAccessAge > 30 * 24 * 60 * 60 * 1000) {
    return 'warm';
  }

  return 'hot';
};

/**
 * Determine if watch history should be archived
 */
export const shouldArchiveWatchHistory = (record: TimestampedRecord): boolean => {
  const age = Date.now() - new Date(record.created_at).getTime();
  return age > (retentionConfig.watchHistory.archiveAfter as number);
};

/**
 * Determine if watch history should be deleted
 */
export const shouldDeleteWatchHistory = (record: TimestampedRecord): boolean => {
  const age = Date.now() - new Date(record.created_at).getTime();
  return age > (retentionConfig.watchHistory.deleteAfter as number);
};

/**
 * Archive deleted video to cold storage
 */
export const archiveDeletedVideo = async (
  video: Video,
  _storage: unknown,
  _db: unknown
): Promise<ArchiveResult> => {
  logger.info({ videoId: video.id }, 'Archiving deleted video');

  try {
    // 1. Copy video to archive bucket
    const archiveKey = `deleted/${video.id}/${video.video_url.split('/').pop()}`;
    // Note: In real implementation, would copy to archive bucket

    // 2. Store metadata
    const metadata = {
      ...video,
      archived_at: new Date().toISOString(),
      deletion_reason: video.deletion_reason || 'user_request',
      retain_until: new Date(
        Date.now() + (retentionConfig.videos.deleted.deleteAfter as number)
      ).toISOString(),
    };

    // 3. Log for audit
    auditLog('video_archived', video.creator_id, {
      videoId: video.id,
      reason: video.deletion_reason,
      retainUntil: metadata.retain_until,
    });

    logger.info({ videoId: video.id, archiveKey }, 'Video archived successfully');
    return { success: true, archiveKey };
  } catch (error) {
    logger.error({ videoId: video.id, error: (error as Error).message }, 'Failed to archive video');
    throw error;
  }
};

/**
 * Cleanup job for expired archived videos
 */
export const cleanupExpiredArchives = async (
  _storage: unknown,
  _db: unknown
): Promise<void> => {
  logger.info('Starting expired archive cleanup');

  // In real implementation:
  // 1. Query archive metadata for expired items
  // 2. Delete from cold storage
  // 3. Update database records
  // 4. Log audit trail

  auditLog('archive_cleanup', null, {
    type: 'scheduled_cleanup',
    timestamp: new Date().toISOString(),
  });
};

/**
 * Get retention policy summary for a video
 */
export const getVideoRetentionPolicy = (video: Video): VideoRetentionPolicyResult => {
  if (video.status === 'deleted') {
    return {
      status: 'deleted',
      policy: retentionConfig.videos.deleted,
      retainUntil: new Date(
        new Date(video.updated_at).getTime() +
          (retentionConfig.videos.deleted.deleteAfter as number)
      ).toISOString(),
    };
  }

  if (video.status === 'policy_violation') {
    return {
      status: 'policy_violation',
      policy: retentionConfig.videos.policyViolation,
      retainUntil: new Date(
        new Date(video.updated_at).getTime() +
          (retentionConfig.videos.policyViolation.deleteAfter as number)
      ).toISOString(),
    };
  }

  if (isViralVideo(video)) {
    return {
      status: 'viral',
      policy: { ...retentionConfig.videos.active, preserveIndefinitely: true },
      reason: 'Viral content is preserved indefinitely',
    };
  }

  return {
    status: 'active',
    policy: retentionConfig.videos.active,
    storageTier: getVideoStorageTier(video),
  };
};

export default {
  retentionConfig,
  storageTiers,
  isViralVideo,
  getVideoStorageTier,
  shouldArchiveWatchHistory,
  shouldDeleteWatchHistory,
  archiveDeletedVideo,
  cleanupExpiredArchives,
  getVideoRetentionPolicy,
};
