import { Router } from 'express';
import * as projectService from '../services/projectService.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Get all projects
router.get('/', requireAuth, async (req, res) => {
  try {
    const projects = await projectService.getAllProjects();
    res.json({ projects });
  } catch (error) {
    console.error('Get projects error:', error);
    res.status(500).json({ error: 'Failed to get projects' });
  }
});

// Get project by ID or key
router.get('/:idOrKey', requireAuth, async (req, res) => {
  try {
    const { idOrKey } = req.params;
    let project;

    // Try UUID first, then key
    if (idOrKey.includes('-') && idOrKey.length === 36) {
      project = await projectService.getProjectById(idOrKey);
    } else {
      project = await projectService.getProjectByKey(idOrKey);
    }

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({ project });
  } catch (error) {
    console.error('Get project error:', error);
    res.status(500).json({ error: 'Failed to get project' });
  }
});

// Create project
router.post('/', requireAuth, async (req, res) => {
  try {
    const { key, name, description, workflowId, permissionSchemeId } = req.body;

    if (!key || !name) {
      return res.status(400).json({ error: 'Key and name are required' });
    }

    // Validate key format (uppercase letters, 2-10 chars)
    if (!/^[A-Z]{2,10}$/.test(key.toUpperCase())) {
      return res.status(400).json({ error: 'Key must be 2-10 uppercase letters' });
    }

    const project = await projectService.createProject({
      key,
      name,
      description,
      leadId: req.user!.id,
      workflowId,
      permissionSchemeId,
    });

    res.status(201).json({ project });
  } catch (error: unknown) {
    if ((error as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Project key already exists' });
    }
    console.error('Create project error:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// Update project
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { name, description, lead_id, workflow_id, permission_scheme_id } = req.body;

    const project = await projectService.updateProject(req.params.id, {
      name,
      description,
      lead_id,
      workflow_id,
      permission_scheme_id,
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({ project });
  } catch (error) {
    console.error('Update project error:', error);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

// Delete project
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const deleted = await projectService.deleteProject(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({ message: 'Project deleted' });
  } catch (error) {
    console.error('Delete project error:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// Get project members
router.get('/:id/members', requireAuth, async (req, res) => {
  try {
    const members = await projectService.getProjectMembers(req.params.id);
    res.json({ members });
  } catch (error) {
    console.error('Get members error:', error);
    res.status(500).json({ error: 'Failed to get members' });
  }
});

// Add project member
router.post('/:id/members', requireAuth, async (req, res) => {
  try {
    const { userId, roleId } = req.body;

    if (!userId || !roleId) {
      return res.status(400).json({ error: 'User ID and role ID are required' });
    }

    await projectService.addProjectMember(req.params.id, userId, roleId);
    res.status(201).json({ message: 'Member added' });
  } catch (error) {
    console.error('Add member error:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// Remove project member
router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
  try {
    await projectService.removeProjectMember(req.params.id, req.params.userId);
    res.json({ message: 'Member removed' });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// Get project sprints
router.get('/:id/sprints', requireAuth, async (req, res) => {
  try {
    const sprints = await projectService.getSprintsByProject(req.params.id);
    res.json({ sprints });
  } catch (error) {
    console.error('Get sprints error:', error);
    res.status(500).json({ error: 'Failed to get sprints' });
  }
});

// Create sprint
router.post('/:id/sprints', requireAuth, async (req, res) => {
  try {
    const { name, goal, startDate, endDate } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Sprint name is required' });
    }

    const sprint = await projectService.createSprint({
      projectId: req.params.id,
      name,
      goal,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });

    res.status(201).json({ sprint });
  } catch (error) {
    console.error('Create sprint error:', error);
    res.status(500).json({ error: 'Failed to create sprint' });
  }
});

// Get project boards
router.get('/:id/boards', requireAuth, async (req, res) => {
  try {
    const boards = await projectService.getBoardsByProject(req.params.id);
    res.json({ boards });
  } catch (error) {
    console.error('Get boards error:', error);
    res.status(500).json({ error: 'Failed to get boards' });
  }
});

// Create board
router.post('/:id/boards', requireAuth, async (req, res) => {
  try {
    const { name, type, filterJql, columnConfig } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Board name is required' });
    }

    const board = await projectService.createBoard({
      projectId: req.params.id,
      name,
      type: type || 'kanban',
      filterJql,
      columnConfig,
    });

    res.status(201).json({ board });
  } catch (error) {
    console.error('Create board error:', error);
    res.status(500).json({ error: 'Failed to create board' });
  }
});

// Get project labels
router.get('/:id/labels', requireAuth, async (req, res) => {
  try {
    const labels = await projectService.getLabelsByProject(req.params.id);
    res.json({ labels });
  } catch (error) {
    console.error('Get labels error:', error);
    res.status(500).json({ error: 'Failed to get labels' });
  }
});

// Create label
router.post('/:id/labels', requireAuth, async (req, res) => {
  try {
    const { name, color } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Label name is required' });
    }

    const label = await projectService.createLabel(req.params.id, name, color || '#6B7280');
    res.status(201).json({ label });
  } catch (error) {
    console.error('Create label error:', error);
    res.status(500).json({ error: 'Failed to create label' });
  }
});

// Get project components
router.get('/:id/components', requireAuth, async (req, res) => {
  try {
    const components = await projectService.getComponentsByProject(req.params.id);
    res.json({ components });
  } catch (error) {
    console.error('Get components error:', error);
    res.status(500).json({ error: 'Failed to get components' });
  }
});

// Create component
router.post('/:id/components', requireAuth, async (req, res) => {
  try {
    const { name, description, leadId } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Component name is required' });
    }

    const component = await projectService.createComponent({
      projectId: req.params.id,
      name,
      description,
      leadId,
    });

    res.status(201).json({ component });
  } catch (error) {
    console.error('Create component error:', error);
    res.status(500).json({ error: 'Failed to create component' });
  }
});

// Get project roles
router.get('/roles/all', requireAuth, async (req, res) => {
  try {
    const roles = await projectService.getProjectRoles();
    res.json({ roles });
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({ error: 'Failed to get roles' });
  }
});

export default router;
