/**
 * @fileoverview Admin user management: /api/admin/users (all routes admin-only).
 *
 * Rules enforced here and in services/users.ts:
 * - The last active admin can't be demoted, disabled, or deleted
 * - Admins can't change their own role / disabled flag or delete themselves
 *   (avoids locking yourself out mid-session; use another admin, or
 *   POST /api/auth/password for your own password)
 * - Role, disabled, and password changes revoke the target's sessions
 *
 * @module routes/users
 */

import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import * as users from '../services/users.js';
import { logger } from '../shared/logger.js';

const router = Router();
router.use(requireAdmin);

/** Never expose password hashes or session versions. */
function toDto(user: users.User) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function handleError(res: Response, error: unknown, action: string): void {
  if (error instanceof users.UserError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  logger.error({ err: error }, `Failed to ${action}`);
  res.status(500).json({ error: `Failed to ${action}` });
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid user id' });
    return null;
  }
  return id;
}

/** GET /api/admin/users */
router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json({ users: (await users.listUsers()).map(toDto) });
  } catch (error) {
    handleError(res, error, 'list users');
  }
});

/** POST /api/admin/users  { username, password, role } */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { username, password, role } = req.body ?? {};
    const user = await users.createUser({ username, password, role });
    logger.info({ by: req.user!.id, userId: user.id, role: user.role }, 'User created');
    res.status(201).json(toDto(user));
  } catch (error) {
    handleError(res, error, 'create user');
  }
});

/** PATCH /api/admin/users/:id  { role?, disabled?, password? } */
router.patch('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const { role, disabled, password } = req.body ?? {};
    if (id === req.user!.id && (role !== undefined || disabled !== undefined)) {
      res.status(400).json({ error: "You can't change your own role or disable yourself" });
      return;
    }
    const user = await users.updateUser(id, { role, disabled, password });
    logger.info(
      { by: req.user!.id, userId: id, role, disabled, passwordReset: password !== undefined },
      'User updated'
    );
    res.json(toDto(user));
  } catch (error) {
    handleError(res, error, 'update user');
  }
});

/** DELETE /api/admin/users/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (id === req.user!.id) {
    res.status(400).json({ error: "You can't delete your own account" });
    return;
  }
  try {
    await users.deleteUser(id);
    logger.info({ by: req.user!.id, userId: id }, 'User deleted');
    res.status(204).end();
  } catch (error) {
    handleError(res, error, 'delete user');
  }
});

export default router;
