/**
 * @fileoverview Post indexing service for Elasticsearch.
 * Handles indexing, updating, and deleting posts in the search index.
 * Provides utilities for extracting hashtags, mentions, and generating visibility fingerprints.
 * Includes Prometheus metrics for indexing operations and lag tracking.
 */

import { esClient, POSTS_INDEX } from '../config/elasticsearch.js';
import { query } from '../config/database.js';
import {
  postsIndexedTotal,
  recordIndexingLag,
  logIndexing,
  logger,
  executeWithCircuitBreaker,
} from '../shared/index.js';
import type { Post, PostDocument, Visibility, PostType } from '../types/index.js';

/**
 * Generates visibility fingerprints for privacy-aware search filtering.
 * Fingerprints are matched against user visibility sets during search.
 * @param authorId - The post author's user ID
 * @param visibility - The post's visibility setting
 * @returns Array of fingerprint strings (e.g., ['PUBLIC'], ['FRIENDS:userId'])
 */
export function generateVisibilityFingerprints(
  authorId: string,
  visibility: Visibility,
): string[] {
  const fingerprints: string[] = [];

  if (visibility === 'public') {
    fingerprints.push('PUBLIC');
  }

  if (visibility === 'friends' || visibility === 'friends_of_friends') {
    fingerprints.push(`FRIENDS:${authorId}`);
  }

  if (visibility === 'private') {
    fingerprints.push(`PRIVATE:${authorId}`);
  }

  return fingerprints;
}

/**
 * Extracts hashtags from post content using regex.
 * @param content - Post content text
 * @returns Array of lowercase hashtags including the # prefix
 */
export function extractHashtags(content: string): string[] {
  const regex = /#(\w+)/g;
  const matches = content.match(regex);
  return matches ? matches.map((m) => m.toLowerCase()) : [];
}

/**
 * Extracts user mentions from post content using regex.
 * @param content - Post content text
 * @returns Array of lowercase mentions including the @ prefix
 */
export function extractMentions(content: string): string[] {
  const regex = /@(\w+)/g;
  const matches = content.match(regex);
  return matches ? matches.map((m) => m.toLowerCase()) : [];
}

/**
 * Calculates an engagement score for ranking posts.
 * Weights: likes (1x), comments (2x), shares (3x).
 * @param likeCount - Number of likes
 * @param commentCount - Number of comments
 * @param shareCount - Number of shares
 * @returns Weighted engagement score
 */
export function calculateEngagementScore(
  likeCount: number,
  commentCount: number,
  shareCount: number
): number {
  return likeCount * 1 + commentCount * 2 + shareCount * 3;
}

/**
 * Indexes a single post in Elasticsearch.
 * Transforms the Post model into a PostDocument with denormalized data.
 * Records indexing metrics including lag from creation time.
 * @param post - The post to index
 * @param authorName - The author's display name (denormalized for search results)
 * @returns Promise that resolves when indexing is complete
 */
export async function indexPost(
  post: Post,
  authorName: string
): Promise<void> {
  const startTime = Date.now();

  const doc: PostDocument = {
    post_id: post.id,
    author_id: post.author_id,
    author_name: authorName,
    content: post.content,
    hashtags: extractHashtags(post.content),
    mentions: extractMentions(post.content),
    created_at: post.created_at.toISOString(),
    updated_at: post.updated_at.toISOString(),
    visibility: post.visibility,
    visibility_fingerprints: generateVisibilityFingerprints(post.author_id, post.visibility),
    post_type: post.post_type,
    engagement_score: calculateEngagementScore(post.like_count, post.comment_count, post.share_count),
    like_count: post.like_count,
    comment_count: post.comment_count,
    share_count: post.share_count,
    language: 'en', // Simplified - in production would detect language
  };

  await executeWithCircuitBreaker(async () => {
    return esClient.index({
      index: POSTS_INDEX,
      id: post.id,
      document: doc,
      refresh: true,
    });
  });

  const durationMs = Date.now() - startTime;

  // Record metrics
  postsIndexedTotal.inc({ operation: 'create' });
  recordIndexingLag(post.created_at);

  // Log indexing operation
  logIndexing({
    postId: post.id,
    operation: 'create',
    durationMs,
    lagMs: Date.now() - post.created_at.getTime(),
  });
}

/**
 * Updates an existing post in the Elasticsearch index.
 * Fetches fresh data from PostgreSQL and re-indexes.
 * If the post no longer exists, removes it from the index.
 * Records metrics for update operations.
 * @param postId - The ID of the post to update
 * @returns Promise that resolves when update is complete
 */
export async function updatePostIndex(postId: string): Promise<void> {
  const startTime = Date.now();

  interface PostRow {
    id: string;
    author_id: string;
    content: string;
    visibility: Visibility;
    post_type: PostType;
    like_count: number;
    comment_count: number;
    share_count: number;
    created_at: Date;
    updated_at: Date;
    author_name: string;
  }

  const posts = await query<PostRow>(
    `SELECT p.*, u.display_name as author_name
     FROM posts p
     JOIN users u ON p.author_id = u.id
     WHERE p.id = $1`,
    [postId]
  );

  if (posts.length === 0) {
    // Post was deleted, remove from index
    await deletePostFromIndex(postId);
    return;
  }

  const postRow = posts[0];
  const post: Post = {
    id: postRow.id,
    author_id: postRow.author_id,
    content: postRow.content,
    visibility: postRow.visibility,
    post_type: postRow.post_type,
    like_count: postRow.like_count,
    comment_count: postRow.comment_count,
    share_count: postRow.share_count,
    created_at: postRow.created_at,
    updated_at: postRow.updated_at,
  };

  const doc: PostDocument = {
    post_id: post.id,
    author_id: post.author_id,
    author_name: postRow.author_name,
    content: post.content,
    hashtags: extractHashtags(post.content),
    mentions: extractMentions(post.content),
    created_at: post.created_at.toISOString(),
    updated_at: post.updated_at.toISOString(),
    visibility: post.visibility,
    visibility_fingerprints: generateVisibilityFingerprints(post.author_id, post.visibility),
    post_type: post.post_type,
    engagement_score: calculateEngagementScore(post.like_count, post.comment_count, post.share_count),
    like_count: post.like_count,
    comment_count: post.comment_count,
    share_count: post.share_count,
    language: 'en',
  };

  await executeWithCircuitBreaker(async () => {
    return esClient.index({
      index: POSTS_INDEX,
      id: post.id,
      document: doc,
      refresh: true,
    });
  });

  const durationMs = Date.now() - startTime;

  // Record metrics
  postsIndexedTotal.inc({ operation: 'update' });

  // Log indexing operation
  logIndexing({
    postId: post.id,
    operation: 'update',
    durationMs,
  });
}

/**
 * Removes a post from the Elasticsearch index.
 * Silently succeeds if the document doesn't exist.
 * Records metrics for delete operations.
 * @param postId - The ID of the post to delete
 * @returns Promise that resolves when deletion is complete
 */
export async function deletePostFromIndex(postId: string): Promise<void> {
  const startTime = Date.now();

  try {
    await executeWithCircuitBreaker(async () => {
      return esClient.delete({
        index: POSTS_INDEX,
        id: postId,
        refresh: true,
      });
    });

    const durationMs = Date.now() - startTime;

    // Record metrics
    postsIndexedTotal.inc({ operation: 'delete' });

    // Log indexing operation
    logIndexing({
      postId,
      operation: 'delete',
      durationMs,
    });
  } catch (error) {
    // Document might not exist - this is ok
    logger.debug({ postId, error }, 'Post not found in index during delete');
  }
}

/**
 * Bulk indexes multiple posts in Elasticsearch.
 * More efficient than individual indexing for batch operations.
 * Used during seeding and reindexing operations.
 * @param postIds - Array of post IDs to index
 * @returns Promise that resolves when all posts are indexed
 */
export async function bulkIndexPosts(postIds: string[]): Promise<void> {
  interface PostRow {
    id: string;
    author_id: string;
    content: string;
    visibility: Visibility;
    post_type: PostType;
    like_count: number;
    comment_count: number;
    share_count: number;
    created_at: Date;
    updated_at: Date;
    author_name: string;
  }

  const posts = await query<PostRow>(
    `SELECT p.*, u.display_name as author_name
     FROM posts p
     JOIN users u ON p.author_id = u.id
     WHERE p.id = ANY($1)`,
    [postIds]
  );

  if (posts.length === 0) return;

  const operations = posts.flatMap((postRow) => {
    const doc: PostDocument = {
      post_id: postRow.id,
      author_id: postRow.author_id,
      author_name: postRow.author_name,
      content: postRow.content,
      hashtags: extractHashtags(postRow.content),
      mentions: extractMentions(postRow.content),
      created_at: postRow.created_at.toISOString(),
      updated_at: postRow.updated_at.toISOString(),
      visibility: postRow.visibility,
      visibility_fingerprints: generateVisibilityFingerprints(postRow.author_id, postRow.visibility),
      post_type: postRow.post_type,
      engagement_score: calculateEngagementScore(postRow.like_count, postRow.comment_count, postRow.share_count),
      like_count: postRow.like_count,
      comment_count: postRow.comment_count,
      share_count: postRow.share_count,
      language: 'en',
    };

    return [{ index: { _index: POSTS_INDEX, _id: postRow.id } }, doc];
  });

  await esClient.bulk({ refresh: true, operations });
}
