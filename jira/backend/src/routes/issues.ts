import { Router } from 'express';
import * as issueService from '../services/issueService.js';
import * as workflowService from '../services/workflowService.js';
import * as projectService from '../services/projectService.js';
import { requireAuth } from '../middleware/auth.js';
import { IssueType, Priority } from '../types/index.js';

/**
 * Issue management routes.
 * Handles CRUD operations for issues, transitions, comments, and history.
 */
const router = Router();

/**
 * GET /:idOrKey
 * Returns an issue by numeric ID or issue key (e.g., "PROJ-123").
 */
router.get('/:idOrKey', requireAuth, async (req, res) => {
  try {
    const { idOrKey } = req.params;
    let issue;

    // Check if it's a numeric ID or a key
    if (/^\d+$/.test(idOrKey)) {
      issue = await issueService.getIssueById(parseInt(idOrKey, 10));
    } else {
      issue = await issueService.getIssueByKey(idOrKey);
    }

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    res.json({ issue });
  } catch (error) {
    console.error('Get issue error:', error);
    res.status(500).json({ error: 'Failed to get issue' });
  }
});

/**
 * POST /
 * Creates a new issue in a project.
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      projectId,
      summary,
      description,
      issueType,
      priority,
      assigneeId,
      parentId,
      epicId,
      sprintId,
      storyPoints,
      labels,
      components,
      customFields,
    } = req.body;

    if (!projectId || !summary || !issueType) {
      return res.status(400).json({ error: 'Project ID, summary, and issue type are required' });
    }

    // Validate issue type
    const validTypes: IssueType[] = ['bug', 'story', 'task', 'epic', 'subtask'];
    if (!validTypes.includes(issueType)) {
      return res.status(400).json({ error: 'Invalid issue type' });
    }

    const issue = await issueService.createIssue(
      {
        projectId,
        summary,
        description,
        issueType,
        priority: priority as Priority,
        assigneeId,
        reporterId: req.user!.id,
        parentId,
        epicId,
        sprintId,
        storyPoints,
        labels,
        components,
        customFields,
      },
      req.user!
    );

    // Get full issue with details
    const issueWithDetails = await issueService.getIssueById(issue.id);
    res.status(201).json({ issue: issueWithDetails });
  } catch (error) {
    console.error('Create issue error:', error);
    res.status(500).json({ error: 'Failed to create issue' });
  }
});

/**
 * PATCH /:id
 * Updates an issue's fields.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const issueId = parseInt(req.params.id, 10);
    const {
      summary,
      description,
      issueType,
      priority,
      assigneeId,
      epicId,
      sprintId,
      storyPoints,
      labels,
      components,
      customFields,
    } = req.body;

    const issue = await issueService.updateIssue(
      issueId,
      {
        summary,
        description,
        issueType,
        priority,
        assigneeId,
        epicId,
        sprintId,
        storyPoints,
        labels,
        components,
        customFields,
      },
      req.user!
    );

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    // Get full issue with details
    const issueWithDetails = await issueService.getIssueById(issue.id);
    res.json({ issue: issueWithDetails });
  } catch (error) {
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
    const issueId = parseInt(req.params.id, 10);
    const deleted = await issueService.deleteIssue(issueId);

    if (!deleted) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    res.json({ message: 'Issue deleted' });
  } catch (error) {
    console.error('Delete issue error:', error);
    res.status(500).json({ error: 'Failed to delete issue' });
  }
});

/**
 * GET /:id/transitions
 * Returns available workflow transitions for an issue from its current status.
 */
router.get('/:id/transitions', requireAuth, async (req, res) => {
  try {
    const issueId = parseInt(req.params.id, 10);
    const issue = await issueService.getIssueById(issueId);

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const userRoles = await projectService.getUserRolesInProject(req.user!.id, issue.project_id);
    const transitions = await workflowService.getAvailableTransitions(
      issue,
      req.user!,
      userRoles
    );

    // Get status names for transitions
    const workflow = await workflowService.getWorkflowByProject(issue.project_id);
    const statusMap = new Map(workflow?.statuses.map((s) => [s.id, s]) || []);

    const transitionsWithStatus = transitions.map((t) => ({
      ...t,
      to_status: statusMap.get(t.to_status_id),
    }));

    res.json({ transitions: transitionsWithStatus });
  } catch (error) {
    console.error('Get transitions error:', error);
    res.status(500).json({ error: 'Failed to get transitions' });
  }
});

/**
 * POST /:id/transitions/:transitionId
 * Executes a workflow transition on an issue.
 */
router.post('/:id/transitions/:transitionId', requireAuth, async (req, res) => {
  try {
    const issueId = parseInt(req.params.id, 10);
    const transitionId = parseInt(req.params.transitionId, 10);
    const issue = await issueService.getIssueById(issueId);

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const userRoles = await projectService.getUserRolesInProject(req.user!.id, issue.project_id);
    const result = await workflowService.executeTransition(
      issue,
      transitionId,
      req.user!,
      userRoles,
      req.body
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    // Get updated issue
    const updatedIssue = await issueService.getIssueById(issueId);
    res.json({ issue: updatedIssue });
  } catch (error) {
    console.error('Execute transition error:', error);
    res.status(500).json({ error: 'Failed to execute transition' });
  }
});

/**
 * GET /:id/comments
 * Returns all comments for an issue.
 */
router.get('/:id/comments', requireAuth, async (req, res) => {
  try {
    const issueId = parseInt(req.params.id, 10);
    const comments = await issueService.getIssueComments(issueId);
    res.json({ comments });
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

/**
 * POST /:id/comments
 * Adds a comment to an issue.
 */
router.post('/:id/comments', requireAuth, async (req, res) => {
  try {
    const issueId = parseInt(req.params.id, 10);
    const { body } = req.body;

    if (!body) {
      return res.status(400).json({ error: 'Comment body is required' });
    }

    const comment = await issueService.addComment(issueId, req.user!.id, body);
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
    const commentId = parseInt(req.params.commentId, 10);
    const { body } = req.body;

    if (!body) {
      return res.status(400).json({ error: 'Comment body is required' });
    }

    const comment = await issueService.updateComment(commentId, body, req.user!.id);

    if (!comment) {
      return res.status(404).json({ error: 'Comment not found or not authorized' });
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
    const commentId = parseInt(req.params.commentId, 10);
    const deleted = await issueService.deleteComment(commentId, req.user!.id);

    if (!deleted) {
      return res.status(404).json({ error: 'Comment not found or not authorized' });
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
    const issueId = parseInt(req.params.id, 10);
    const history = await issueService.getIssueHistory(issueId);
    res.json({ history });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

/**
 * GET /project/:projectId
 * Returns paginated issues for a project with optional filters.
 */
router.get('/project/:projectId', requireAuth, async (req, res) => {
  try {
    const { statusId, assigneeId, sprintId, epicId, issueType, limit, offset } = req.query;

    const result = await issueService.getIssuesByProject(req.params.projectId, {
      statusId: statusId ? parseInt(String(statusId), 10) : undefined,
      assigneeId: assigneeId ? String(assigneeId) : undefined,
      sprintId: sprintId !== undefined ? parseInt(String(sprintId), 10) : undefined,
      epicId: epicId ? parseInt(String(epicId), 10) : undefined,
      issueType: issueType as IssueType | undefined,
      limit: limit ? parseInt(String(limit), 10) : undefined,
      offset: offset ? parseInt(String(offset), 10) : undefined,
    });

    res.json(result);
  } catch (error) {
    console.error('Get project issues error:', error);
    res.status(500).json({ error: 'Failed to get issues' });
  }
});

/**
 * GET /project/:projectId/backlog
 * Returns issues not assigned to any sprint.
 */
router.get('/project/:projectId/backlog', requireAuth, async (req, res) => {
  try {
    const issues = await issueService.getBacklogIssues(req.params.projectId);
    res.json({ issues });
  } catch (error) {
    console.error('Get backlog error:', error);
    res.status(500).json({ error: 'Failed to get backlog' });
  }
});

/**
 * GET /sprint/:sprintId
 * Returns all issues assigned to a sprint.
 */
router.get('/sprint/:sprintId', requireAuth, async (req, res) => {
  try {
    const sprintId = parseInt(req.params.sprintId, 10);
    const issues = await issueService.getIssuesBySprint(sprintId);
    res.json({ issues });
  } catch (error) {
    console.error('Get sprint issues error:', error);
    res.status(500).json({ error: 'Failed to get sprint issues' });
  }
});

export default router;
