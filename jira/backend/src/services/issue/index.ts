/**
 * Issue Service - Main Export
 *
 * @description This module serves as the public API for all issue-related operations.
 * It re-exports functionality from focused sub-modules organized by responsibility:
 *
 * - **types**: TypeScript interfaces for issue data structures
 * - **queries**: Read-only operations for fetching issues and history
 * - **create**: Issue creation (key allocation, initial status, rank via trigger)
 * - **update**: Field edits with optimistic concurrency (version / If-Match) and deletion
 * - **transitions**: Workflow transitions (rules, compare-and-swap, post-functions)
 * - **rank**: Board and backlog ordering
 * - **afterCommit**: Search indexing and event publishing after a change commits
 * - **comments**: Comment CRUD operations
 *
 * Import from this file to access all issue service functions in a single import.
 *
 * @module services/issue
 *
 * @example
 * ```typescript
 * import {
 *   createIssue,
 *   getIssueByKey,
 *   updateIssue,
 *   addComment,
 *   type CreateIssueData
 * } from './services/issue/index.js';
 *
 * // Create a new issue
 * const issue = await createIssue(issueData, currentUser);
 *
 * // Fetch by key
 * const fetched = await getIssueByKey('PROJ-123');
 *
 * // Add a comment
 * await addComment(issue.id, currentUser.id, 'Working on this now');
 * ```
 */

// Types
export type { CreateIssueData, UpdateIssueData, HistoryRecord, IssueSearchDetails } from './types.js';
export { IssueInputError } from './types.js';

// Query functions
export {
  getIssueById,
  getIssueByKey,
  getIssueRow,
  getIssueProjectId,
  getIssuesByProject,
  getIssuesBySprint,
  getBacklogIssues,
  getIssueHistory,
} from './queries.js';

// Create functions
export { createIssue } from './create.js';

// Update functions
export { updateIssue, deleteIssue, diffIssue } from './update.js';
export type { UpdateIssueResult, FieldChange } from './update.js';

// Workflow transitions
export { transitionIssue, recordTransitionMetric } from './transitions.js';
export type { TransitionResult, TransitionFailureCode } from './transitions.js';

// Board / backlog order
export { rankIssue } from './rank.js';
export type { RankResult, RankPlacement } from './rank.js';

// Post-commit side effects (search index, events)
export { indexIssueById, afterIssueCommitted } from './afterCommit.js';

// Comment functions
export {
  getIssueComments,
  addComment,
  updateComment,
  deleteComment,
} from './comments.js';
