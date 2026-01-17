/**
 * @fileoverview Elasticsearch Index Lifecycle Management (ILM) configuration.
 * Defines retention policies for hot/warm/cold tiers and automatic index rollover.
 * Supports both development (simplified) and production (full ILM) configurations.
 */

import { esClient, POSTS_INDEX } from '../config/elasticsearch.js';
import { logger } from './logger.js';
import { RETENTION_THRESHOLDS } from './alertThresholds.js';

/**
 * ILM policy name for posts index.
 */
export const POSTS_ILM_POLICY = 'posts-lifecycle-policy';

/**
 * Index template name for posts.
 */
export const POSTS_INDEX_TEMPLATE = 'posts-template';

/**
 * ILM policy definition for production use.
 * Manages index lifecycle through hot, warm, cold, and delete phases.
 */
export const postsIlmPolicy = {
  policy: {
    phases: {
      hot: {
        min_age: '0ms',
        actions: {
          rollover: {
            max_primary_shard_size: '50gb',
            max_age: '30d',
          },
          set_priority: {
            priority: 100,
          },
        },
      },
      warm: {
        min_age: `${RETENTION_THRESHOLDS.ES_HOT_TIER_DAYS}d`,
        actions: {
          shrink: {
            number_of_shards: 1,
          },
          forcemerge: {
            max_num_segments: 1,
          },
          set_priority: {
            priority: 50,
          },
          allocate: {
            require: {
              data: 'warm',
            },
          },
        },
      },
      cold: {
        min_age: `${RETENTION_THRESHOLDS.ES_WARM_TIER_DAYS}d`,
        actions: {
          set_priority: {
            priority: 0,
          },
          freeze: {},
          allocate: {
            require: {
              data: 'cold',
            },
          },
        },
      },
      delete: {
        min_age: `${RETENTION_THRESHOLDS.ES_COLD_TIER_DAYS}d`,
        actions: {
          delete: {},
        },
      },
    },
  },
};

/**
 * Simplified ILM policy for local development.
 * Only uses hot phase with basic rollover; no warm/cold/delete phases.
 */
export const postsIlmPolicyDev = {
  policy: {
    phases: {
      hot: {
        min_age: '0ms',
        actions: {
          rollover: {
            max_primary_shard_size: '1gb',
            max_age: '7d',
          },
        },
      },
      delete: {
        min_age: '30d',
        actions: {
          delete: {},
        },
      },
    },
  },
};

/**
 * Index template for posts with ILM policy attached.
 */
export const postsIndexTemplate = {
  index_patterns: [`${POSTS_INDEX}-*`],
  template: {
    settings: {
      number_of_shards: 1,
      number_of_replicas: 0,
      'index.lifecycle.name': POSTS_ILM_POLICY,
      'index.lifecycle.rollover_alias': POSTS_INDEX,
    },
    mappings: {
      properties: {
        post_id: { type: 'keyword' },
        author_id: { type: 'keyword' },
        author_name: { type: 'text' },
        content: {
          type: 'text',
          analyzer: 'standard',
          fields: {
            keyword: { type: 'keyword', ignore_above: 256 },
          },
        },
        hashtags: { type: 'keyword' },
        mentions: { type: 'keyword' },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
        visibility: { type: 'keyword' },
        visibility_fingerprints: { type: 'keyword' },
        post_type: { type: 'keyword' },
        engagement_score: { type: 'float' },
        like_count: { type: 'integer' },
        comment_count: { type: 'integer' },
        share_count: { type: 'integer' },
        language: { type: 'keyword' },
      },
    },
  },
};

/**
 * Creates or updates the ILM policy for posts.
 * Uses development policy in non-production environments.
 * @param isDevelopment - Whether to use simplified dev policy
 */
export async function setupIlmPolicy(isDevelopment = true): Promise<void> {
  try {
    const policy = isDevelopment ? postsIlmPolicyDev : postsIlmPolicy;

    await esClient.ilm.putLifecycle({
      name: POSTS_ILM_POLICY,
      body: policy,
    });

    logger.info(
      { policy: POSTS_ILM_POLICY, isDevelopment },
      'ILM policy created/updated successfully'
    );
  } catch (error) {
    // ILM might not be available in all ES distributions
    logger.warn(
      { error },
      'Failed to create ILM policy - ILM may not be available'
    );
  }
}

/**
 * Creates or updates the index template for posts.
 */
export async function setupIndexTemplate(): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await esClient.indices.putIndexTemplate({
      name: POSTS_INDEX_TEMPLATE,
      body: postsIndexTemplate as any,
    });

    logger.info(
      { template: POSTS_INDEX_TEMPLATE },
      'Index template created/updated successfully'
    );
  } catch (error) {
    logger.warn({ error }, 'Failed to create index template');
  }
}

/**
 * Gets the current ILM status for the posts index.
 * @returns ILM explain response or null if not available
 */
export async function getIlmStatus(): Promise<Record<string, unknown> | null> {
  try {
    const response = await esClient.ilm.explainLifecycle({
      index: POSTS_INDEX,
    });
    return response.indices as Record<string, unknown>;
  } catch (error) {
    logger.debug({ error }, 'Failed to get ILM status');
    return null;
  }
}

/**
 * Manually triggers index rollover (useful for testing).
 * @param alias - Index alias to rollover
 */
export async function triggerRollover(alias: string = POSTS_INDEX): Promise<boolean> {
  try {
    await esClient.indices.rollover({
      alias,
    });
    logger.info({ alias }, 'Index rollover triggered');
    return true;
  } catch (error) {
    logger.warn({ error, alias }, 'Failed to trigger rollover');
    return false;
  }
}

/**
 * Retention configuration for various data types.
 * Centralizes TTL values for application-level retention management.
 */
export const retentionConfig = {
  /** Elasticsearch index retention settings */
  elasticsearch: {
    /** Days before moving to warm tier */
    hotTierDays: RETENTION_THRESHOLDS.ES_HOT_TIER_DAYS,
    /** Days before moving to cold tier */
    warmTierDays: RETENTION_THRESHOLDS.ES_WARM_TIER_DAYS,
    /** Days before deletion */
    coldTierDays: RETENTION_THRESHOLDS.ES_COLD_TIER_DAYS,
  },
  /** Redis cache TTL settings */
  redis: {
    /** Visibility set cache TTL (seconds) */
    visibilityTtl: RETENTION_THRESHOLDS.VISIBILITY_CACHE_TTL_SECONDS,
    /** Search suggestions cache TTL (seconds) */
    suggestionsTtl: RETENTION_THRESHOLDS.SUGGESTIONS_CACHE_TTL_SECONDS,
    /** Session TTL (seconds) */
    sessionTtl: RETENTION_THRESHOLDS.SESSION_TTL_SECONDS,
  },
  /** PostgreSQL data retention */
  postgres: {
    /** Search history retention (days) */
    searchHistoryDays: RETENTION_THRESHOLDS.SEARCH_HISTORY_DAYS,
  },
};

/**
 * Cleans up expired search history from PostgreSQL.
 * Should be run as a scheduled job (e.g., daily via cron).
 * @returns Number of rows deleted
 */
export async function cleanupSearchHistory(): Promise<number> {
  // Import here to avoid circular dependencies
  const { query } = await import('../config/database.js');

  interface DeleteResult {
    count: string;
  }

  const result = await query<DeleteResult>(
    `WITH deleted AS (
      DELETE FROM search_history
      WHERE created_at < NOW() - INTERVAL '${RETENTION_THRESHOLDS.SEARCH_HISTORY_DAYS} days'
      RETURNING id
    )
    SELECT COUNT(*) as count FROM deleted`
  );

  const deletedCount = parseInt(result[0]?.count || '0', 10);

  logger.info(
    { deletedCount, retentionDays: RETENTION_THRESHOLDS.SEARCH_HISTORY_DAYS },
    `Cleaned up ${deletedCount} expired search history records`
  );

  return deletedCount;
}
