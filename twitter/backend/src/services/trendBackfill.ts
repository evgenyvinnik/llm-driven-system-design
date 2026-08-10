import redis from '../db/redis.js';
import pool from '../db/pool.js';
import logger from '../shared/logger.js';

/** Minutes of history the trend window covers — matches the read side in routes/trends.ts. */
const BUCKET_WINDOW_MINUTES = 60;

/** TTL applied to each per-minute bucket, matching the write path in routes/tweets.ts. */
const BUCKET_TTL_SECONDS = 3600;

/**
 * Rebuilds the per-minute trend buckets in Redis from `hashtag_activity` in Postgres.
 *
 * Trend counters are incremented only by the tweet-creation route, so they exist
 * exclusively for tweets posted through the API while this process was running.
 * A database populated any other way — the SQL seed, a restore, a backfill — has
 * hashtag rows in Postgres and nothing in Redis, and the trending sidebar reads
 * empty even though the data it summarizes is right there. Redis buckets also
 * carry a one-hour TTL, so trends vanish after an idle hour and never return.
 *
 * Running this at boot makes the trend view self-healing: Postgres is the record
 * of what was posted, and Redis is a derived index that can always be rebuilt
 * from it. It is not a substitute for the incremental counters — it is the floor
 * beneath them.
 *
 * @returns Number of hashtag-minute buckets written
 */
export async function backfillTrendBuckets(): Promise<number> {
  const result = await pool.query<{ hashtag: string; bucket: string; count: string }>(
    `SELECT ha.hashtag,
            FLOOR(EXTRACT(EPOCH FROM t.created_at) / 60)::bigint AS bucket,
            COUNT(*) AS count
     FROM hashtag_activity ha
     JOIN tweets t ON t.id = ha.tweet_id
     WHERE t.created_at > NOW() - ($1 || ' minutes')::interval
       AND t.is_deleted = FALSE
     GROUP BY ha.hashtag, bucket`,
    [BUCKET_WINDOW_MINUTES]
  );

  if (result.rows.length === 0) return 0;

  const pipeline = redis.pipeline();
  for (const row of result.rows) {
    const key = `trend:${row.hashtag}:${row.bucket}`;
    // SET rather than INCRBY: a restart must not double-count buckets it already
    // wrote on a previous boot.
    pipeline.set(key, row.count, 'EX', BUCKET_TTL_SECONDS);
  }
  await pipeline.exec();

  return result.rows.length;
}

/**
 * Runs the trend backfill without allowing a failure to affect startup.
 * Trends are a sidebar; the API must come up regardless.
 */
export async function backfillTrendBucketsSafely(): Promise<void> {
  try {
    const written = await backfillTrendBuckets();
    logger.info({ buckets: written }, 'Trend buckets backfilled from hashtag_activity');
  } catch (error) {
    logger.warn(
      { error: (error as Error).message },
      'Trend backfill failed; trending will populate from live tweets only'
    );
  }
}
