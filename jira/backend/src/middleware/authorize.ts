import { Request, Response } from 'express';
import { getProjectPermissions, Permission } from '../services/permissionService.js';
import { permissionDenialsCounter } from '../config/metrics.js';

/**
 * Checks a project permission for the authenticated user and writes the error response
 * when it is missing. Returns true when the handler may continue.
 *
 * A user who cannot view the project gets 404, not 403, so issue keys and project ids in
 * projects they cannot see are indistinguishable from ones that do not exist.
 * Must run after requireAuth.
 */
export async function authorizeProject(
  req: Request,
  res: Response,
  projectId: string | null | undefined,
  permission: Permission
): Promise<boolean> {
  if (!projectId) {
    res.status(404).json({ error: 'Not found', code: 'not_found' });
    return false;
  }

  const held = await getProjectPermissions(req.user!, projectId);

  if (!held.has('view_issue')) {
    permissionDenialsCounter.inc({ permission: 'view_issue' });
    res.status(404).json({ error: 'Not found', code: 'not_found' });
    return false;
  }

  if (!held.has(permission)) {
    permissionDenialsCounter.inc({ permission });
    res.status(403).json({
      error: `You do not have the '${permission}' permission in this project`,
      code: 'forbidden',
      permission,
    });
    return false;
  }

  return true;
}

/**
 * For actions reserved to system administrators, such as editing a workflow that many
 * projects share. Returns true when the handler may continue.
 */
export function authorizeSystemAdmin(req: Request, res: Response, action: string): boolean {
  if (req.user?.role === 'admin') return true;
  permissionDenialsCounter.inc({ permission: 'system_admin' });
  res.status(403).json({ error: `Only system administrators can ${action}`, code: 'forbidden' });
  return false;
}
