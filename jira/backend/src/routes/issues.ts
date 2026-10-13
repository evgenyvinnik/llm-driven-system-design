import { Router, Response } from 'express';
import { z } from 'zod';
import * as issueService from '../services/issue/index.js';
import * as workflowService from '../services/workflowService.js';
import * as projectService from '../services/projectService.js';
import { getProjectPermissions } from '../services/permissionService.js';
import { requireAuth } from '../middleware/auth.js';
import { authorizeProject } from '../middleware/authorize.js';
import { parseIfMatch, sendValidationError, setVersionTag } from '../utils/http.js';
import { IssueType } from '../types/index.js';

/**
 * Issue management routes.
 * Handles CRUD operations for issues, transitions, ranking, comments, and history.
 * Every route checks the caller's project permissions (see services/permissionService.ts).
 */
const router = Router();

const issueTypeSchema = z.enum(['bug', 'story', 'task', 'epic', 'subtask']);
const prioritySchema = z.enum(['highest', 'high', 'medium', 'low', 'lowest']);
const idSchema = z.number().int().positive();
const emptyToNull = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? null : value);

const createIssueSchema = z.object({
  projectId: z.string().uuid(),
  summary: z.string().trim().min(1).max(500),
  description: z.preprocess(emptyToNull, z.string().max(50_000).nullable()).optional(),
  issueType: issueTypeSchema,
  priority: prioritySchema.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  parentId: idSchema.nullable().optional(),
  epicId: idSchema.nullable().optional(),
  sprintId: idSchema.nullable().optional(),
  storyPoints: z.number().int().min(0).max(1000).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  components: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  customFields: z.record(z.unknown()).optional(),
});

// Status is deliberately absent: it only changes through workflow transitions.
const updateIssueSchema = createIssueSchema
  .omit({ projectId: true, parentId: true })
  .partial()
  .strict('Unknown field; status changes go through POST /api/issues/:id/transitions/:transitionId');

const rankSchema = z
  .object({ afterId: idSchema.nullable().optional(), beforeId: idSchema.nullable().optional() })
  .refine((body) => body.afterId != null || body.beforeId != null, 'Provide afterId or beforeId');

const commentSchema = z.object({ body: z.string().trim().min(1).max(20_000) });

/** Parses a numeric route parameter; answers 404 for anything that is not an id. */
function routeId(value: string, res: Response): number | null {
  if (!/^\d{1,9}$/.test(value)) {
    res.status(404).json({ error: 'Not found', code: 'not_found' });
    return null;
  }
  return parseInt(value, 10);
}

function sendInputError(res: Response, error: unknown): boolean {
  if (error instanceof issueService.IssueInputError) {
    res.status(422).json({ error: error.message, code: 'invalid_reference', field: error.field });
    return true;
  }
  return false;
}

/** HTTP status for each way a transition can be refused. */
const TRANSITION_STATUS: Record<issueService.TransitionFailureCode, number> = {
  issue_not_found: 404,
  transition_not_found: 404,
  invalid_from_status: 409,
  condition_failed: 403,
  validation_failed: 422,
  conflict: 409,
};

/**
 * GET /:idOrKey
 * Returns an issue by numeric ID or issue key (e.g., "PROJ-123"), with its version as ETag.
 */
router.get('/:idOrKey', requireAuth, async (req, res) => {
  try {
    const { idOrKey } = req.params;
    const issue = /^\d+$/.test(idOrKey)
      ? await issueService.getIssueById(parseInt(idOrKey, 10))
      : await issueService.getIssueByKey(idOrKey.toUpperCase());

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found', code: 'not_found' });
    }
    if (!(await authorizeProject(req, res, issue.project_id, 'view_issue'))) return;

    setVersionTag(res, issue.version);
    res.json({ issue });
  } catch (error) {
    console.error('Get issue error:', error);
    res.status(500).json({ error: 'Failed to get issue' });
  }
});

/**
 * POST /
 * Creates a new issue in a project. Safe to retry with an Idempotency-Key header.
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const parsed = createIssueSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const data = parsed.data;

    if (!(await authorizeProject(req, res, data.projectId, 'create_issue'))) return;
    if (data.assigneeId && !(await authorizeProject(req, res, data.projectId, 'assign_issue'))) return;

    const issue = await issueService.createIssue(
      {
        ...data,
        description: data.description ?? undefined,
        assigneeId: data.assigneeId ?? undefined,
        parentId: data.parentId ?? undefined,
        epicId: data.epicId ?? undefined,
        sprintId: data.sprintId ?? undefined,
        storyPoints: data.storyPoints ?? undefined,
        reporterId: req.user!.id,
      },
      req.user!
    );

    const issueWithDetails = await issueService.getIssueById(issue.id);
    setVersionTag(res, issue.version);
    res.status(201).json({ issue: issueWithDetails });
  } catch (error) {
    if (sendInputError(res, error)) return;
    console.error('Create issue error:', error);
    res.status(500).json({ error: 'Failed to create issue' });
  }
});

/**
 * PATCH /:id
 * Updates an issue's fields. Send the issue's ETag in If-Match: if someone changed the
 * issue since, nothing is written and the response is 412 with the current issue.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const issueId = routeId(req.params.id, res);
    if (issueId === null) return;

    const expectedVersion = parseIfMatch(req.get('If-Match'));
    if (expectedVersion === null) {
      return res.status(400).json({ error: 'If-Match must be a version tag such as "7"', code: 'invalid_request' });
    }

    const parsed = updateIssueSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const projectId = await issueService.getIssueProjectId(issueId);
    if (!(await authorizeProject(req, res, projectId, 'edit_issue'))) return;
    if (parsed.data.assigneeId !== undefined && !(await authorizeProject(req, res, projectId, 'assign_issue'))) {
      return;
    }

    const result = await issueService.updateIssue(issueId, parsed.data, req.user!, expectedVersion);

    if (!result.ok && result.reason === 'not_found') {
      return res.status(404).json({ error: 'Issue not found', code: 'not_found' });
    }
    if (!result.ok) {
      const current = await issueService.getIssueById(issueId);
      setVersionTag(res, current?.version);
      return res.status(412).json({
        error: 'Someone else changed this issue after you loaded it. Nothing was saved.',
        code: 'version_conflict',
        issue: current,
      });
    }

    const issueWithDetails = await issueService.getIssueById(issueId);
    setVersionTag(res, issueWithDetails?.version);
    res.json({ issue: issueWithDetails, changed: result.changed });
  } catch (error) {
    if (sendInputError(res, error)) return;
    console.error('Update issue error:', error);
    res.status(500).json({ error: 'Failed to update issue' });
  }
});

/**
 * DELETE /:id
 * Deletes an issue.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const issueId = routeId(req.params.id, res);
    if (issueId === null) return;

    const projectId = await issueService.getIssueProjectId(issueId);
    if (!(await authorizeProject(req, res, projectId, 'delete_issue'))) return;

    const deleted = await issueService.deleteIssue(issueId, req.user!);
    if (!deleted) {
      return res.status(404).json({ error: 'Issue not found', code: 'not_found' });
    }

    res.json({ message: 'Issue deleted' });
  } catch (error) {
    if ((error as { code?: string }).code === '23503') {
      return res.status(409).json({
        error: 'Other issues reference this one as their epic or parent; move them first',
        code: 'referenced',
      });
    }
    console.error('Delete issue error:', error);
    res.status(500).json({ error: 'Failed to delete issue' });
  }
});

/**
 * GET /:id/transitions
 * Returns the transitions this user may execute from the issue's current status.
 * Empty when the user lacks the transition_issue permission.
 */
router.get('/:id/transitions', requireAuth, async (req, res) => {
  try {
    const issueId = routeId(req.params.id, res);
    if (issueId === null) return;

    const issue = await issueService.getIssueRow(issueId);
    if (!issue) {
      return res.status(404).json({ error: 'Issue not found', code: 'not_found' });
    }
    if (!(await authorizeProject(req, res, issue.project_id, 'view_issue'))) return;

    const permissions = await getProjectPermissions(req.user!, issue.project_id);
    if (!permissions.has('transition_issue')) {
      return res.json({ transitions: [] });
    }

    const userRoles = await projectService.getUserRolesInProject(req.user!.id, issue.project_id);
    const transitions = await workflowService.getAvailableTransitions(issue, req.user!, userRoles);

    const workflow = await workflowService.getWorkflowByProject(issue.project_id);
    const statusMap = new Map(workflow?.statuses.map((s) => [s.id, s]) || []);

    res.json({
      transitions: transitions.map((t) => ({ ...t, to_status: statusMap.get(t.to_status_id) })),
    });
  } catch (error) {
    console.error('Get transitions error:', error);
    res.status(500).json({ error: 'Failed to get transitions' });
  }
});

/**
 * POST /:id/transitions/:transitionId
 * Executes a workflow transition. 403 when a condition blocks the user, 422 when a
 * validator fails (with the field), 409 when the issue is no longer in the transition's
 * starting status or kept changing.
 */
router.post('/:id/transitions/:transitionId', requireAuth, async (req, res) => {
  try {
    const issueId = routeId(req.params.id, res);
    if (issueId === null) return;
    const transitionId = routeId(req.params.transitionId, res);
    if (transitionId === null) return;

    const projectId = await issueService.getIssueProjectId(issueId);
    if (!(await authorizeProject(req, res, projectId, 'transition_issue'))) return;

    const userRoles = await projectService.getUserRolesInProject(req.user!.id, projectId!);
    const result = await issueService.transitionIssue(issueId, transitionId, req.user!, userRoles);

    if (!result.ok) {
      return res.status(TRANSITION_STATUS[result.code]).json({
        error: result.message,
        code: result.code,
        ...(result.field ? { field: result.field } : {}),
      });
    }

    const updatedIssue = await issueService.getIssueById(issueId);
    setVersionTag(res, updatedIssue?.version);
    res.json({ issue: updatedIssue });
  } catch (error) {
    console.error('Execute transition error:', error);
    res.status(500).json({ error: 'Failed to execute transition' });
  }
});

/**
 * PUT /:id/rank
 * Moves an issue in its project's board/backlog order: { afterId } puts it directly
 * below that issue, { beforeId } directly above it.
 */
router.put('/:id/rank', requireAuth, async (req, res) => {
  try {
    const issueId = routeId(req.params.id, res);
    if (issueId === null) return;

    const parsed = rankSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const projectId = await issueService.getIssueProjectId(issueId);
    if (!(await authorizeProject(req, res, projectId, 'edit_issue'))) return;

    const result = await issueService.rankIssue(issueId, parsed.data);
    if (!result.ok) {
      const status = result.code === 'issue_not_found' ? 404 : result.code === 'conflict' ? 409 : 422;
      return res.status(status).json({ error: result.message, code: result.code });
    }

    res.json({ issue: { id: result.issue.id, key: result.issue.key, rank: result.issue.rank }, moved: result.moved });
  } catch (error) {
    console.error('Rank issue error:', error);
    res.status(500).json({ error: 'Failed to rank issue' });
  }
});

/**
 * GET /:id/comments
 * Returns all comments for an issue.
 */
router.get('/:id/comments', requireAuth, async (req, res) => {
  try {
    const issueId = routeId(req.params.id, res);
    if (issueId === null) return;

    const projectId = await issueService.getIssueProjectId(issueId);
    if (!(await authorizeProject(req, res, projectId, 'view_issue'))) return;

    const comments = await issueService.getIssueComments(issueId);
    res.json({ comments });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

/**
 * POST /:id/comments
 * Adds a comment to an issue. Safe to retry with an Idempotency-Key header.
 */
router.post('/:id/comments', requireAuth, async (req, res) => {
  try {
    const issueId = routeId(req.params.id, res);
    if (issueId === null) return;

    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const projectId = await issueService.getIssueProjectId(issueId);
    if (!(await authorizeProject(req, res, projectId, 'add_comment'))) return;

    const comment = await issueService.addComment(issueId, req.user!.id, parsed.data.body);
    res.status(201).json({ comment });
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

/**
 * PATCH /:issueId/comments/:commentId
 * Updates a comment (author only).
 */
router.patch('/:issueId/comments/:commentId', requireAuth, async (req, res) => {
  try {
    const issueId = routeId(req.params.issueId, res);
    if (issueId === null) return;
    const commentId = routeId(req.params.commentId, res);
    if (commentId === null) return;

    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);

    const projectId = await issueService.getIssueProjectId(issueId);
    if (!(await authorizeProject(req, res, projectId, 'add_comment'))) return;

    const comment = await issueService.updateComment(issueId, commentId, parsed.data.body, req.user!.id);
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found or not authorized', code: 'not_found' });
    }

    res.json({ comment });
  } catch (error) {
    console.error('Update comment error:', error);
    res.status(500).json({ error: 'Failed to update comment' });
  }
});

/**
 * DELETE /:issueId/comments/:commentId
 * Deletes a comment (author only).
 */
router.delete('/:issueId/comments/:commentId', requireAuth, async (req, res) => {
  try {
    const issueId = routeId(req.params.issueId, res);
    if (issueId === null) return;
    const commentId = routeId(req.params.commentId, res);
    if (commentId === null) return;

    const projectId = await issueService.getIssueProjectId(issueId);
    if (!(await authorizeProject(req, res, projectId, 'view_issue'))) return;

    const deleted = await issueService.deleteComment(issueId, commentId, req.user!.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Comment not found or not authorized', code: 'not_found' });
    }

    res.json({ message: 'Comment deleted' });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

/**
 * GET /:id/history
 * Returns the change history for an issue.
 */
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    const issueId = routeId(req.params.id, res);
    if (issueId === null) return;

    const projectId = await issueService.getIssueProjectId(issueId);
    if (!(await authorizeProject(req, res, projectId, 'view_issue'))) return;

    const history = await issueService.getIssueHistory(issueId);
    res.json({ history });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

/**
 * GET /project/:projectId
 * Returns paginated issues for a project in rank order, with optional filters.
 */
router.get('/project/:projectId', requireAuth, async (req, res) => {
  try {
    if (!(await authorizeProject(req, res, req.params.projectId, 'view_issue'))) return;

    const { statusId, assigneeId, sprintId, epicId, issueType, limit, offset } = req.query;
    const type = issueTypeSchema.safeParse(issueType);

    const result = await issueService.getIssuesByProject(req.params.projectId, {
      statusId: statusId ? parseInt(String(statusId), 10) || undefined : undefined,
      assigneeId: assigneeId ? String(assigneeId) : undefined,
      sprintId: sprintId !== undefined && /^\d+$/.test(String(sprintId)) ? parseInt(String(sprintId), 10) : undefined,
      epicId: epicId ? parseInt(String(epicId), 10) || undefined : undefined,
      issueType: type.success ? (type.data as IssueType) : undefined,
      limit: limit ? parseInt(String(limit), 10) || undefined : undefined,
      offset: offset ? parseInt(String(offset), 10) || undefined : undefined,
    });

    res.json(result);
  } catch (error) {
    console.error('Get project issues error:', error);
    res.status(500).json({ error: 'Failed to get issues' });
  }
});

/**
 * GET /project/:projectId/backlog
 * Returns issues not assigned to any sprint, in rank order.
 */
router.get('/project/:projectId/backlog', requireAuth, async (req, res) => {
  try {
    if (!(await authorizeProject(req, res, req.params.projectId, 'view_issue'))) return;

    const issues = await issueService.getBacklogIssues(req.params.projectId);
    res.json({ issues });
  } catch (error) {
    console.error('Get backlog error:', error);
    res.status(500).json({ error: 'Failed to get backlog' });
  }
});

/**
 * GET /sprint/:sprintId
 * Returns all issues assigned to a sprint, in rank order.
 */
router.get('/sprint/:sprintId', requireAuth, async (req, res) => {
  try {
    const sprintId = routeId(req.params.sprintId, res);
    if (sprintId === null) return;

    const sprint = await projectService.getSprintById(sprintId);
    if (!(await authorizeProject(req, res, sprint?.project_id, 'view_issue'))) return;

    const issues = await issueService.getIssuesBySprint(sprintId);
    res.json({ issues });
  } catch (error) {
    console.error('Get sprint issues error:', error);
    res.status(500).json({ error: 'Failed to get sprint issues' });
  }
});

export default router;
