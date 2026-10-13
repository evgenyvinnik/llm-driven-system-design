import { Router, Request, Response } from 'express';
import * as projectService from '../services/projectService.js';
import {
  getProjectPermissions,
  getVisibleProjectIds,
  invalidateProjectPermissions,
} from '../services/permissionService.js';
import { requireAuth } from '../middleware/auth.js';
import { authorizeProject } from '../middleware/authorize.js';
import { Project } from '../types/index.js';

/**
 * Project management routes.
 * Handles CRUD operations for projects, members, sprints, boards, labels, and components.
 * Reads need view_issue in the project; configuration needs project_admin; sprint changes
 * need manage_sprints.
 */
const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves a UUID or project key to the project, or null. */
async function findProject(idOrKey: string): Promise<Project | null> {
  return UUID.test(idOrKey)
    ? projectService.getProjectById(idOrKey)
    : projectService.getProjectByKey(idOrKey);
}

/** Resolves :id (UUID or key) and checks a permission; null means a response was sent. */
async function projectFor(
  req: Request,
  res: Response,
  permission: Parameters<typeof authorizeProject>[3]
): Promise<Project | null> {
  const project = await findProject(req.params.id ?? req.params.idOrKey);
  if (!(await authorizeProject(req, res, project?.id, permission))) return null;
  return project;
}

/**
 * GET /
 * Returns the projects whose issues the user may view.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const [projects, visible] = await Promise.all([
      projectService.getAllProjects(),
      getVisibleProjectIds(req.user!),
    ]);
    const allowed = visible === null ? projects : projects.filter((p) => visible.includes(p.id));
    res.json({ projects: allowed });
  } catch (error) {
    console.error('Get projects error:', error);
    res.status(500).json({ error: 'Failed to get projects' });
  }
});

/**
 * GET /roles/all
 * Returns all available project roles.
 */
router.get('/roles/all', requireAuth, async (req, res) => {
  try {
    const roles = await projectService.getProjectRoles();
    res.json({ roles });
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({ error: 'Failed to get roles' });
  }
});

/**
 * GET /:idOrKey
 * Returns a project by UUID or project key.
 */
router.get('/:idOrKey', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'view_issue');
    if (!project) return;
    res.json({ project });
  } catch (error) {
    console.error('Get project error:', error);
    res.status(500).json({ error: 'Failed to get project' });
  }
});

/**
 * GET /:idOrKey/permissions
 * Returns the permissions the current user holds in the project, so the UI can hide
 * actions the server would refuse. The server still checks every request.
 */
router.get('/:idOrKey/permissions', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'view_issue');
    if (!project) return;
    const permissions = await getProjectPermissions(req.user!, project.id);
    res.json({ permissions: [...permissions].sort() });
  } catch (error) {
    console.error('Get permissions error:', error);
    res.status(500).json({ error: 'Failed to get permissions' });
  }
});

/**
 * POST /
 * Creates a new project with the current user as lead (and its Administrator).
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { key, name, description, workflowId, permissionSchemeId } = req.body;

    if (!key || !name) {
      return res.status(400).json({ error: 'Key and name are required' });
    }

    // Validate key format (uppercase letters, 2-10 chars)
    if (!/^[A-Z]{2,10}$/.test(String(key).toUpperCase())) {
      return res.status(400).json({ error: 'Key must be 2-10 uppercase letters' });
    }

    // Choosing a non-default scheme or workflow is instance configuration.
    if ((workflowId || permissionSchemeId) && req.user!.role !== 'admin') {
      return res.status(403).json({
        error: 'Only system administrators can choose a workflow or permission scheme',
        code: 'forbidden',
      });
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

/**
 * PATCH /:id
 * Updates a project's details. Swapping its workflow or permission scheme is reserved to
 * system administrators, since it changes who may do what in every issue.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const existing = await projectFor(req, res, 'project_admin');
    if (!existing) return;

    const { name, description, lead_id, workflow_id, permission_scheme_id } = req.body;
    if ((workflow_id !== undefined || permission_scheme_id !== undefined) && req.user!.role !== 'admin') {
      return res.status(403).json({
        error: 'Only system administrators can change a project\'s workflow or permission scheme',
        code: 'forbidden',
      });
    }

    const project = await projectService.updateProject(existing.id, {
      name,
      description,
      lead_id,
      workflow_id,
      permission_scheme_id,
    });

    if (!project) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    await invalidateProjectPermissions(project.id);
    res.json({ project });
  } catch (error) {
    console.error('Update project error:', error);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

/**
 * DELETE /:id
 * Deletes a project and all its data.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'project_admin');
    if (!project) return;

    const deleted = await projectService.deleteProject(project.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await invalidateProjectPermissions(project.id);
    res.json({ message: 'Project deleted' });
  } catch (error) {
    console.error('Delete project error:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

/**
 * GET /:id/members
 * Returns all members of a project with their roles.
 */
router.get('/:id/members', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'view_issue');
    if (!project) return;
    const members = await projectService.getProjectMembers(project.id);
    res.json({ members });
  } catch (error) {
    console.error('Get members error:', error);
    res.status(500).json({ error: 'Failed to get members' });
  }
});

/**
 * POST /:id/members
 * Adds a user to the project with a specified role (or changes their role).
 * Revokes cached permissions for the project so the change applies on the next request.
 */
router.post('/:id/members', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'project_admin');
    if (!project) return;

    const { userId, roleId } = req.body;
    if (!userId || !roleId) {
      return res.status(400).json({ error: 'User ID and role ID are required' });
    }

    await projectService.addProjectMember(project.id, userId, roleId);
    await invalidateProjectPermissions(project.id);
    res.status(201).json({ message: 'Member added' });
  } catch (error) {
    console.error('Add member error:', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

/**
 * DELETE /:id/members/:userId
 * Removes a user from the project. Their cached access ends immediately.
 */
router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'project_admin');
    if (!project) return;

    await projectService.removeProjectMember(project.id, req.params.userId);
    await invalidateProjectPermissions(project.id);
    res.json({ message: 'Member removed' });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

/**
 * GET /:id/sprints
 * Returns all sprints for a project.
 */
router.get('/:id/sprints', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'view_issue');
    if (!project) return;
    const sprints = await projectService.getSprintsByProject(project.id);
    res.json({ sprints });
  } catch (error) {
    console.error('Get sprints error:', error);
    res.status(500).json({ error: 'Failed to get sprints' });
  }
});

/**
 * POST /:id/sprints
 * Creates a new sprint in the project.
 */
router.post('/:id/sprints', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'manage_sprints');
    if (!project) return;

    const { name, goal, startDate, endDate } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Sprint name is required' });
    }

    const sprint = await projectService.createSprint({
      projectId: project.id,
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

/**
 * GET /:id/boards
 * Returns all boards for a project.
 */
router.get('/:id/boards', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'view_issue');
    if (!project) return;
    const boards = await projectService.getBoardsByProject(project.id);
    res.json({ boards });
  } catch (error) {
    console.error('Get boards error:', error);
    res.status(500).json({ error: 'Failed to get boards' });
  }
});

/**
 * POST /:id/boards
 * Creates a new board (kanban or scrum) for the project.
 */
router.post('/:id/boards', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'project_admin');
    if (!project) return;

    const { name, type, filterJql, columnConfig } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Board name is required' });
    }

    const board = await projectService.createBoard({
      projectId: project.id,
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

/**
 * GET /:id/labels
 * Returns all labels for a project.
 */
router.get('/:id/labels', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'view_issue');
    if (!project) return;
    const labels = await projectService.getLabelsByProject(project.id);
    res.json({ labels });
  } catch (error) {
    console.error('Get labels error:', error);
    res.status(500).json({ error: 'Failed to get labels' });
  }
});

/**
 * POST /:id/labels
 * Creates or updates a label in the project.
 */
router.post('/:id/labels', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'project_admin');
    if (!project) return;

    const { name, color } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Label name is required' });
    }

    const label = await projectService.createLabel(project.id, name, color || '#6B7280');
    res.status(201).json({ label });
  } catch (error) {
    console.error('Create label error:', error);
    res.status(500).json({ error: 'Failed to create label' });
  }
});

/**
 * GET /:id/components
 * Returns all components for a project.
 */
router.get('/:id/components', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'view_issue');
    if (!project) return;
    const components = await projectService.getComponentsByProject(project.id);
    res.json({ components });
  } catch (error) {
    console.error('Get components error:', error);
    res.status(500).json({ error: 'Failed to get components' });
  }
});

/**
 * POST /:id/components
 * Creates a new component in the project.
 */
router.post('/:id/components', requireAuth, async (req, res) => {
  try {
    const project = await projectFor(req, res, 'project_admin');
    if (!project) return;

    const { name, description, leadId } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Component name is required' });
    }

    const component = await projectService.createComponent({
      projectId: project.id,
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

export default router;
