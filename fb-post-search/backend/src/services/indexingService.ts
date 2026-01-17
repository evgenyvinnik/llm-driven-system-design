import { esClient, POSTS_INDEX } from '../config/elasticsearch.js';
import { query } from '../config/database.js';
import type { Post, PostDocument, Visibility, PostType } from '../types/index.js';

// Generate visibility fingerprints for a post
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

// Extract hashtags from content
export function extractHashtags(content: string): string[] {
  const regex = /#(\w+)/g;
  const matches = content.match(regex);
  return matches ? matches.map((m) => m.toLowerCase()) : [];
}

// Extract mentions from content
export function extractMentions(content: string): string[] {
  const regex = /@(\w+)/g;
  const matches = content.match(regex);
  return matches ? matches.map((m) => m.toLowerCase()) : [];
}

// Calculate engagement score
export function calculateEngagementScore(
  likeCount: number,
  commentCount: number,
  shareCount: number
): number {
  return likeCount * 1 + commentCount * 2 + shareCount * 3;
}

// Index a single post in Elasticsearch
export async function indexPost(
  post: Post,
  authorName: string
): Promise<void> {
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

  await esClient.index({
    index: POSTS_INDEX,
    id: post.id,
    document: doc,
    refresh: true,
  });
}

// Update post in Elasticsearch
export async function updatePostIndex(postId: string): Promise<void> {
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
    try {
      await esClient.delete({
        index: POSTS_INDEX,
        id: postId,
        refresh: true,
      });
    } catch {
      // Document might not exist
    }
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

  await indexPost(post, postRow.author_name);
}

// Delete post from Elasticsearch
export async function deletePostFromIndex(postId: string): Promise<void> {
  try {
    await esClient.delete({
      index: POSTS_INDEX,
      id: postId,
      refresh: true,
    });
  } catch {
    // Document might not exist
  }
}

// Bulk index posts
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
