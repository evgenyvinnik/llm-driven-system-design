import dotenv from 'dotenv';

dotenv.config();

/**
 * Data retention and lifecycle policies configuration.
 *
 * Why retention policies balance community history vs storage costs:
 * - Posts and comments are community knowledge; permanent archival preserves context
 * - Vote details (who voted when) are less valuable long-term; aggregate scores suffice
 * - Sessions and audit logs have compliance/legal requirements
 * - Hot scores are ephemeral; recomputed frequently, no archival needed
 *
 * Lifecycle stages:
 * - Hot: Active data in PostgreSQL with indexes
 * - Warm: Older data, potentially moved to less expensive storage
 * - Cold: Archived to S3/MinIO as compressed JSON
 */

export const RETENTION_CONFIG = {
  // Posts remain in hot storage for 1 year, then archived
  posts: {
    hotStorageDays: parseInt(process.env.POST_HOT_STORAGE_DAYS, 10) || 365,
    warmStorageDays: parseInt(process.env.POST_WARM_STORAGE_DAYS, 10) || 730,
    archiveEnabled: process.env.POST_ARCHIVE_ENABLED !== 'false',
    // Posts are never truly deleted, only archived
    permanentArchive: true,
  },

  // Comments follow same lifecycle as posts
  comments: {
    hotStorageDays: parseInt(process.env.COMMENT_HOT_STORAGE_DAYS, 10) || 365,
    warmStorageDays: parseInt(process.env.COMMENT_WARM_STORAGE_DAYS, 10) || 730,
    archiveEnabled: process.env.COMMENT_ARCHIVE_ENABLED !== 'false',
    permanentArchive: true,
  },

  // Vote details kept for 90 days, then aggregated and purged
  votes: {
    detailRetentionDays: parseInt(process.env.VOTE_DETAIL_RETENTION_DAYS, 10) || 90,
    // After this, only aggregate counts remain
    archiveDetails: process.env.VOTE_ARCHIVE_DETAILS === 'true',
  },

  // Sessions expire and are cleaned up
  sessions: {
    maxAgeDays: parseInt(process.env.SESSION_MAX_AGE_DAYS, 10) || 30,
    cleanupIntervalHours: 24,
  },

  // Audit logs have longer retention for compliance
  auditLogs: {
    hotStorageDays: parseInt(process.env.AUDIT_HOT_STORAGE_DAYS, 10) || 90,
    warmStorageDays: parseInt(process.env.AUDIT_WARM_STORAGE_DAYS, 10) || 365,
    // 7 years for legal compliance
    archiveRetentionYears: parseInt(process.env.AUDIT_ARCHIVE_YEARS, 10) || 7,
  },

  // Cache TTLs (in seconds)
  cache: {
    hotScores: parseInt(process.env.CACHE_HOT_SCORES_TTL, 10) || 300, // 5 minutes
    voteCount: parseInt(process.env.CACHE_VOTE_COUNT_TTL, 10) || 60, // 1 minute
    userSession: parseInt(process.env.CACHE_USER_SESSION_TTL, 10) || 7 * 24 * 3600, // 7 days
    subredditInfo: parseInt(process.env.CACHE_SUBREDDIT_INFO_TTL, 10) || 3600, // 1 hour
    userKarma: parseInt(process.env.CACHE_USER_KARMA_TTL, 10) || 300, // 5 minutes
  },
};

/**
 * Get archive path for a given data type and date.
 */
export function getArchivePath(dataType, date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `archives/${dataType}/${year}/${month}`;
}

/**
 * Calculate cutoff date for hot storage.
 */
export function getHotStorageCutoff(dataType) {
  const config = RETENTION_CONFIG[dataType];
  if (!config) throw new Error(`Unknown data type: ${dataType}`);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.hotStorageDays);
  return cutoff;
}

/**
 * Calculate cutoff date for warm storage (before archival).
 */
export function getWarmStorageCutoff(dataType) {
  const config = RETENTION_CONFIG[dataType];
  if (!config) throw new Error(`Unknown data type: ${dataType}`);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (config.hotStorageDays + config.warmStorageDays));
  return cutoff;
}

export default RETENTION_CONFIG;
