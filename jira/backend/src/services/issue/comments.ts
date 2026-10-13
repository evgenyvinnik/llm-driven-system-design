import { query } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { publishIssueEvent } from '../../config/messageQueue.js';
import { Comment, CommentWithAuthor } from '../../types/index.js';
import { getIssueById } from './queries.js';

/**
 * Retrieves all comments for an issue with author details.
 *
 * @description Fetches all comments associated with an issue, including
 * embedded author information (id, name, email, avatar). Comments are
 * returned in chronological order (oldest first) for natural conversation flow.
 *
 * @param issueId - Numeric ID of the issue
 * @returns Promise resolving to an array of comments with author information
 *
 * @example
 * ```typescript
 * const comments = await getIssueComments(123);
 * comments.forEach(comment => {
 *   console.log(`${comment.author.name}: ${comment.body}`);
 * });
 * ```
 */
export async function getIssueComments(issueId: number): Promise<CommentWithAuthor[]> {
  const { rows } = await query<CommentWithAuthor>(
    `SELECT
      c.*,
      json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'avatar_url', u.avatar_url) as author
    FROM comments c
    JOIN users u ON c.author_id = u.id
    WHERE c.issue_id = $1
    ORDER BY c.created_at ASC`,
    [issueId]
  );

  return rows;
}

/**
 * Adds a comment to an issue.
 *
 * @description Creates a new comment on an issue and performs related updates:
 * 1. Inserts the comment record into the database
 * 2. Updates the issue's updated_at timestamp to reflect activity
 * 3. Publishes a 'commented' event for notifications and webhooks
 *
 * @param issueId - Numeric ID of the issue to comment on
 * @param authorId - UUID of the user creating the comment
 * @param body - Text content of the comment (supports markdown)
 * @returns Promise resolving to the newly created comment
 *
 * @example
 * ```typescript
 * const comment = await addComment(
 *   123,
 *   'user-uuid',
 *   'I think we should prioritize this for the next sprint.'
 * );
 * console.log(`Comment ${comment.id} created at ${comment.created_at}`);
 * ```
 */
export async function addComment(
  issueId: number,
  authorId: string,
  body: string
): Promise<Comment> {
  const log = logger.child({ operation: 'addComment', issueId, authorId });

  const { rows } = await query<Comment>(
    `INSERT INTO comments (issue_id, author_id, body)
     VALUES ($1, $2, $3) RETURNING *`,
    [issueId, authorId, body]
  );

  // Update issue updated_at
  await query('UPDATE issues SET updated_at = NOW() WHERE id = $1', [issueId]);

  // Get issue details for event
  const issue = await getIssueById(issueId);
  if (issue) {
    publishIssueEvent({
      event_type: 'commented',
      issue_id: issueId,
      issue_key: issue.key,
      project_id: issue.project_id,
      project_key: issue.project.key,
      actor_id: authorId,
    }).catch((error) => {
      log.error({ err: error }, 'Failed to publish comment event');
    });
  }

  log.info({ commentId: rows[0].id }, 'Comment added');

  return rows[0];
}

/**
 * Updates an existing comment.
 *
 * @description Modifies the body text of an existing comment. Authorization
 * is enforced at the database level - only the original author can update
 * their comment. The comment's updated_at timestamp is automatically set.
 *
 * @param issueId - Issue the comment must belong to (from the URL)
 * @param commentId - Numeric ID of the comment to update
 * @param body - New text content for the comment
 * @param userId - UUID of the user attempting the update (must match original author)
 * @returns Promise resolving to the updated comment, or null if not found or unauthorized
 *
 * @example
 * ```typescript
 * const updated = await updateComment(123, 456, 'Fixed typo in my previous comment', 'user-uuid');
 * if (updated) {
 *   console.log('Comment updated successfully');
 * } else {
 *   console.log('Comment not found or you are not the author');
 * }
 * ```
 */
export async function updateComment(
  issueId: number,
  commentId: number,
  body: string,
  userId: string
): Promise<Comment | null> {
  const { rows } = await query<Comment>(
    `UPDATE comments SET body = $1, updated_at = NOW()
     WHERE id = $2 AND author_id = $3 AND issue_id = $4
     RETURNING *`,
    [body, commentId, userId, issueId]
  );

  return rows[0] || null;
}

/**
 * Deletes a comment.
 *
 * @description Permanently removes a comment from the database. Authorization
 * is enforced at the database level - only the original author can delete
 * their comment. The delete operation is atomic and cannot be undone.
 *
 * @param issueId - Issue the comment must belong to (from the URL)
 * @param commentId - Numeric ID of the comment to delete
 * @param userId - UUID of the user attempting deletion (must match original author)
 * @returns Promise resolving to true if deleted, false if not found or unauthorized
 *
 * @example
 * ```typescript
 * const deleted = await deleteComment(123, 456, 'user-uuid');
 * if (deleted) {
 *   console.log('Comment deleted successfully');
 * } else {
 *   console.log('Comment not found or you are not the author');
 * }
 * ```
 */
export async function deleteComment(issueId: number, commentId: number, userId: string): Promise<boolean> {
  const { rowCount } = await query(
    'DELETE FROM comments WHERE id = $1 AND author_id = $2 AND issue_id = $3',
    [commentId, userId, issueId]
  );

  return (rowCount ?? 0) > 0;
}
