import { Router } from 'express';
import * as workflowService from '../services/workflowService.js';
import * as projectService from '../services/projectService.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * Workflow management routes.
 * Handles CRUD for workflows, statuses, transitions, sprints, and boards.
 */
const router = Router();

/**
 * GET /
 * Returns all workflow definitions.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const workflows = await workflowService.getAllWorkflows();
    res.json({ workflows });
  } catch (error) {
    console.error('Get workflows error:', error);
    res.status(500).json({ error: 'Failed to get workflows' });
  }
});

/**
 * GET /:id
 * Returns a workflow by ID with all statuses and transitions.
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const workflowId = parseInt(req.params.id, 10);
    const workflow = await workflowService.getWorkflow(workflowId);

    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    res.json({ workflow });
  } catch (error) {
    console.error('Get workflow error:', error);
    res.status(500).json({ error: 'Failed to get workflow' });
  }
});

/**
 * GET /project/:projectId
 * Returns the workflow assigned to a project.
 */
router.get('/project/:projectId', requireAuth, async (req, res) => {
  try {
    const workflow = await workflowService.getWorkflowByProject(req.params.projectId);

    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    res.json({ workflow });
  } catch (error) {
    console.error('Get project workflow error:', error);
    res.status(500).json({ error: 'Failed to get workflow' });
  }
});

/**
 * POST /
 * Creates a new workflow definition.
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Workflow name is required' });
    }

    const workflow = await workflowService.createWorkflow(name, description);
    res.status(201).json({ workflow });
  } catch (error) {
    console.error('Create workflow error:', error);
    res.status(500).json({ error: 'Failed to create workflow' });
  }
});

/**
 * POST /:id/statuses
 * Creates a status in a workflow.
 */
router.post('/:id/statuses', requireAuth, async (req, res) => {
  try {
    const workflowId = parseInt(req.params.id, 10);
    const { name, category, color, position } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'Status name and category are required' });
    }

    const validCategories = ['todo', 'in_progress', 'done'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const status = await workflowService.createStatus(
      workflowId,
      name,
      category,
      color || '#6B7280',
      position || 0
    );

    res.status(201).json({ status });
  } catch (error) {
    console.error('Create status error:', error);
    res.status(500).json({ error: 'Failed to create status' });
  }
});

/**
 * PATCH /statuses/:id
 * Updates a status definition.
 */
router.patch('/statuses/:id', requireAuth, async (req, res) => {
  try {
    const statusId = parseInt(req.params.id, 10);
    const { name, category, color, position } = req.body;

    const status = await workflowService.updateStatus(statusId, {
      name,
      category,
      color,
      position,
    });

    if (!status) {
      return res.status(404).json({ error: 'Status not found' });
    }

    res.json({ status });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

/**
 * POST /:id/transitions
 * Creates a transition between statuses in a workflow.
 */
router.post('/:id/transitions', requireAuth, async (req, res) => {
  try {
    const workflowId = parseInt(req.params.id, 10);
    const { name, fromStatusId, toStatusId, conditions, validators, postFunctions } = req.body;

    if (!name || !toStatusId) {
      return res.status(400).json({ error: 'Transition name and target status are required' });
    }

    const transition = await workflowService.createTransition(
      workflowId,
      name,
      fromStatusId || null,
      toStatusId,
      conditions || [],
      validators || [],
      postFunctions || []
    );

    res.status(201).json({ transition });
  } catch (error) {
    console.error('Create transition error:', error);
    res.status(500).json({ error: 'Failed to create transition' });
  }
});

/**
 * GET /:id/statuses
 * Returns all statuses for a workflow.
 */
router.get('/:id/statuses', requireAuth, async (req, res) => {
  try {
    const workflowId = parseInt(req.params.id, 10);
    const statuses = await workflowService.getStatuses(workflowId);
    res.json({ statuses });
  } catch (error) {
    console.error('Get statuses error:', error);
    res.status(500).json({ error: 'Failed to get statuses' });
  }
});

/**
 * GET /sprints/:id
 * Returns a sprint by ID.
 */
router.get('/sprints/:id', requireAuth, async (req, res) => {
  try {
    const sprintId = parseInt(req.params.id, 10);
    const sprint = await projectService.getSprintById(sprintId);

    if (!sprint) {
      return res.status(404).json({ error: 'Sprint not found' });
    }

    res.json({ sprint });
  } catch (error) {
    console.error('Get sprint error:', error);
    res.status(500).json({ error: 'Failed to get sprint' });
  }
});

/**
 * PATCH /sprints/:id
 * Updates a sprint's details.
 */
router.patch('/sprints/:id', requireAuth, async (req, res) => {
  try {
    const sprintId = parseInt(req.params.id, 10);
    const { name, goal, start_date, end_date, status } = req.body;

    const sprint = await projectService.updateSprint(sprintId, {
      name,
      goal,
      start_date: start_date ? new Date(start_date) : undefined,
      end_date: end_date ? new Date(end_date) : undefined,
      status,
    });

    if (!sprint) {
      return res.status(404).json({ error: 'Sprint not found' });
    }

    res.json({ sprint });
  } catch (error) {
    console.error('Update sprint error:', error);
    res.status(500).json({ error: 'Failed to update sprint' });
  }
});

/**
 * POST /sprints/:id/start
 * Starts a sprint (closes any currently active sprint).
 */
router.post('/sprints/:id/start', requireAuth, async (req, res) => {
  try {
    const sprintId = parseInt(req.params.id, 10);
    const sprint = await projectService.startSprint(sprintId);

    if (!sprint) {
      return res.status(404).json({ error: 'Sprint not found' });
    }

    res.json({ sprint });
  } catch (error) {
    console.error('Start sprint error:', error);
    res.status(500).json({ error: 'Failed to start sprint' });
  }
});

/**
 * POST /sprints/:id/complete
 * Completes a sprint.
 */
router.post('/sprints/:id/complete', requireAuth, async (req, res) => {
  try {
    const sprintId = parseInt(req.params.id, 10);
    const sprint = await projectService.completeSprint(sprintId);

    if (!sprint) {
      return res.status(404).json({ error: 'Sprint not found' });
    }

    res.json({ sprint });
  } catch (error) {
    console.error('Complete sprint error:', error);
    res.status(500).json({ error: 'Failed to complete sprint' });
  }
});

/**
 * GET /boards/:id
 * Returns a board by ID.
 */
router.get('/boards/:id', requireAuth, async (req, res) => {
  try {
    const boardId = parseInt(req.params.id, 10);
    const board = await projectService.getBoardById(boardId);

    if (!board) {
      return res.status(404).json({ error: 'Board not found' });
    }

    res.json({ board });
  } catch (error) {
    console.error('Get board error:', error);
    res.status(500).json({ error: 'Failed to get board' });
  }
});

export default router;
