import { Router } from 'express';
import * as workflowService from '../services/workflowService.js';
import * as projectService from '../services/projectService.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Get all workflows
router.get('/', requireAuth, async (req, res) => {
  try {
    const workflows = await workflowService.getAllWorkflows();
    res.json({ workflows });
  } catch (error) {
    console.error('Get workflows error:', error);
    res.status(500).json({ error: 'Failed to get workflows' });
  }
});

// Get workflow by ID
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

// Get workflow for project
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

// Create workflow
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

// Create status for workflow
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

// Update status
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

// Create transition for workflow
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

// Get statuses for workflow
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

// Sprints routes
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

// Boards routes
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
