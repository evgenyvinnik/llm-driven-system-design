import { query, getClient } from '../db/index.js';
import logger from '../shared/logger.js';
import { commentCreatedTotal, commentTreeDepth } from '../shared/metrics.js';

export interface Comment {
  id: number;
  post_id: number;
  author_id: number;
  parent_id: number | null;
  content: string;
  path: string;
  depth: number;
  upvotes: number;
  downvotes: number;
  score: number;
  is_archived: boolean | null;
  archived_at: Date | null;
  created_at: Date;
  author_username?: string;
  userVote?: number;
}

export interface CommentWithReplies extends Comment {
  replies: CommentWithReplies[];
}

export type CommentSortOption = 'best' | 'new' | 'top' | 'controversial';

export const createComment = async (
  postId: number,
  authorId: number,
  content: string,
  parentId: number | null = null
): Promise<Comment> => {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // Determine depth and path
    let depth = 0;
    let parentPath = '';

    if (parentId) {
      const parentResult = await client.query<{ path: string; depth: number }>(
        `SELECT path, depth FROM comments WHERE id = $1`,
        [parentId]
      );
      if (parentResult.rows[0]) {
        parentPath = parentResult.rows[0].path;
        depth = parentResult.rows[0].depth + 1;
      }
    }

    // Insert comment with temporary path
    const result = await client.query<Comment>(
      `INSERT INTO comments (post_id, author_id, parent_id, content, path, depth)
       VALUES ($1, $2, $3, $4, '', $5)
       RETURNING *`,
      [postId, authorId, parentId, content, depth]
    );

    const commentId = result.rows[0].id;

    // Update path with actual ID
    const newPath = parentPath ? `${parentPath}.${commentId}` : `${commentId}`;
    await client.query(
      `UPDATE comments SET path = $1 WHERE id = $2`,
      [newPath, commentId]
    );

    // Update comment count on post
    await client.query(
      `UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1`,
      [postId]
    );

    await client.query('COMMIT');

    // Record metrics
    const depthBucket = depth <= 1 ? 'shallow' : depth <= 5 ? 'medium' : 'deep';
    commentCreatedTotal.inc({ depth_bucket: depthBucket });
    commentTreeDepth.observe(depth);

    logger.info({
      commentId,
      postId,
      authorId,
      depth,
    }, 'Comment created');

    return { ...result.rows[0], path: newPath };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const findCommentById = async (id: number): Promise<Comment | undefined> => {
  const result = await query<Comment>(
    `SELECT c.*, u.username as author_username
     FROM comments c
     LEFT JOIN users u ON c.author_id = u.id
     WHERE c.id = $1`,
    [id]
  );
  return result.rows[0];
};

export const listCommentsByPost = async (postId: number, sort: CommentSortOption = 'best'): Promise<CommentWithReplies[]> => {
  let orderBy: string;
  switch (sort) {
    case 'new':
      orderBy = 'c.created_at DESC';
      break;
    case 'top':
      orderBy = 'c.score DESC, c.created_at DESC';
      break;
    case 'controversial':
      orderBy = `(CASE WHEN c.upvotes = 0 OR c.downvotes = 0 THEN 0
                      ELSE (c.upvotes + c.downvotes) * (LEAST(c.upvotes, c.downvotes)::float / GREATEST(c.upvotes, c.downvotes))
                 END) DESC, c.created_at DESC`;
      break;
    case 'best':
    default:
      // Wilson score lower bound for best sorting
      orderBy = `(
        CASE WHEN c.upvotes + c.downvotes = 0 THEN 0
        ELSE (
          (c.upvotes + 1.9208) / (c.upvotes + c.downvotes) -
          1.96 * SQRT((c.upvotes * c.downvotes) / (c.upvotes + c.downvotes) + 0.9604) /
          (c.upvotes + c.downvotes)
        ) / (1 + 3.8416 / (c.upvotes + c.downvotes))
        END
      ) DESC, c.created_at DESC`;
      break;
  }

  // Fetch all comments for the post, then organize into tree structure
  const result = await query<Comment>(
    `SELECT c.*, u.username as author_username
     FROM comments c
     LEFT JOIN users u ON c.author_id = u.id
     WHERE c.post_id = $1 AND (c.is_archived IS NULL OR c.is_archived = FALSE)
     ORDER BY c.path, ${orderBy}`,
    [postId]
  );

  return buildCommentTree(result.rows);
};

const buildCommentTree = (comments: Comment[]): CommentWithReplies[] => {
  const commentMap = new Map<number, CommentWithReplies>();
  const rootComments: CommentWithReplies[] = [];

  // First pass: create map of all comments
  for (const comment of comments) {
    commentMap.set(comment.id, { ...comment, replies: [] });
  }

  // Second pass: build tree structure
  for (const comment of comments) {
    const commentWithReplies = commentMap.get(comment.id)!;
    if (comment.parent_id && commentMap.has(comment.parent_id)) {
      commentMap.get(comment.parent_id)!.replies.push(commentWithReplies);
    } else {
      rootComments.push(commentWithReplies);
    }
  }

  return rootComments;
};

export const getCommentSubtree = async (commentId: number): Promise<CommentWithReplies[] | null> => {
  const comment = await findCommentById(commentId);
  if (!comment) return null;

  const result = await query<Comment>(
    `SELECT c.*, u.username as author_username
     FROM comments c
     LEFT JOIN users u ON c.author_id = u.id
     WHERE c.path LIKE $1
     ORDER BY c.path`,
    [`${comment.path}%`]
  );

  return buildCommentTree(result.rows);
};

export const updateCommentScore = async (commentId: number, upvotes: number, downvotes: number): Promise<void> => {
  const score = upvotes - downvotes;
  await query(
    `UPDATE comments SET upvotes = $1, downvotes = $2, score = $3 WHERE id = $4`,
    [upvotes, downvotes, score, commentId]
  );
};

export const deleteComment = async (commentId: number): Promise<void> => {
  const comment = await findCommentById(commentId);
  if (!comment) return;

  // Delete comment and update post comment count
  await query(`DELETE FROM comments WHERE id = $1`, [commentId]);
  await query(
    `UPDATE posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1`,
    [comment.post_id]
  );

  logger.info({ commentId, postId: comment.post_id }, 'Comment deleted');
};

/**
 * Archive old comments based on retention policy.
 * Called by archival worker.
 */
export const archiveComments = async (cutoffDate: Date): Promise<number | null> => {
  const result = await query<{ id: number }>(
    `UPDATE comments
     SET is_archived = TRUE, archived_at = NOW()
     WHERE created_at < $1
       AND (is_archived IS NULL OR is_archived = FALSE)
     RETURNING id`,
    [cutoffDate]
  );

  if (result.rowCount && result.rowCount > 0) {
    logger.info({
      count: result.rowCount,
      cutoffDate,
    }, 'Comments archived');
  }

  return result.rowCount;
};
