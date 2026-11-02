import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { ApiError, respondError } from '../services/errors.js';
import { isUuid, requireProject } from '../services/projectAccess.js';
import {
  listAuthUsers,
  getAuthUser,
  createAuthUser,
  updateAuthUser,
  deleteAuthUser,
} from '../services/authUserService.js';

const router = Router();

const AUTH_ROLES = ['authenticated', 'anon', 'service_role'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AuthUserBody {
  email?: string;
  password?: string;
  role?: string;
  emailConfirmed?: boolean;
  rawUserMetadata?: Record<string, unknown>;
}

/** Validates a create/update body so bad input is a 400, not a database error. */
function parseAuthUser(body: unknown, partial: boolean): AuthUserBody {
  const { email, password, role, emailConfirmed, rawUserMetadata } = (body ?? {}) as Record<string, unknown>;
  const out: AuthUserBody = {};

  if (email !== undefined || !partial) {
    if (typeof email !== 'string' || !EMAIL_RE.test(email) || email.length > 255) {
      throw new ApiError(400, 'A valid email is required');
    }
    out.email = email.trim().toLowerCase();
  }
  if (password !== undefined && password !== '') {
    if (typeof password !== 'string' || password.length < 6 || password.length > 72) {
      throw new ApiError(400, 'Password must be 6-72 characters');
    }
    out.password = password;
  }
  if (role !== undefined) {
    if (typeof role !== 'string' || !AUTH_ROLES.includes(role)) {
      throw new ApiError(400, `role must be one of ${AUTH_ROLES.join(', ')}`);
    }
    out.role = role;
  }
  if (emailConfirmed !== undefined) {
    if (typeof emailConfirmed !== 'boolean') throw new ApiError(400, 'emailConfirmed must be a boolean');
    out.emailConfirmed = emailConfirmed;
  }
  if (rawUserMetadata !== undefined) {
    if (!rawUserMetadata || typeof rawUserMetadata !== 'object' || Array.isArray(rawUserMetadata)) {
      throw new ApiError(400, 'rawUserMetadata must be an object');
    }
    out.rawUserMetadata = rawUserMetadata as Record<string, unknown>;
  }
  return out;
}

function duplicateEmail(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

// GET /api/projects/:projectId/auth-users
router.get('/:projectId/auth-users', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'view');
    res.json({ users: await listAuthUsers(access.projectId) });
  } catch (err) {
    respondError(res, err, 'Failed to list auth users');
  }
});

// GET /api/projects/:projectId/auth-users/:userId
router.get('/:projectId/auth-users/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'view');
    const user = isUuid(req.params.userId) ? await getAuthUser(req.params.userId, access.projectId) : null;
    if (!user) throw new ApiError(404, 'Auth user not found');
    res.json({ user });
  } catch (err) {
    respondError(res, err, 'Failed to get auth user');
  }
});

// POST /api/projects/:projectId/auth-users
router.post('/:projectId/auth-users', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'edit');
    const input = parseAuthUser(req.body, false);
    const user = await createAuthUser({ ...input, email: input.email!, projectId: access.projectId });
    res.status(201).json({ user });
  } catch (err) {
    if (duplicateEmail(err)) {
      res.status(409).json({ error: 'Email already exists for this project' });
      return;
    }
    respondError(res, err, 'Failed to create auth user');
  }
});

// PUT /api/projects/:projectId/auth-users/:userId
router.put('/:projectId/auth-users/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'edit');
    if (!isUuid(req.params.userId)) throw new ApiError(404, 'Auth user not found');
    const user = await updateAuthUser(req.params.userId, access.projectId, parseAuthUser(req.body, true));
    if (!user) throw new ApiError(404, 'Auth user not found');
    res.json({ user });
  } catch (err) {
    if (duplicateEmail(err)) {
      res.status(409).json({ error: 'Email already exists for this project' });
      return;
    }
    respondError(res, err, 'Failed to update auth user');
  }
});

// DELETE /api/projects/:projectId/auth-users/:userId
router.delete('/:projectId/auth-users/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'edit');
    const deleted = isUuid(req.params.userId) && (await deleteAuthUser(req.params.userId, access.projectId));
    if (!deleted) throw new ApiError(404, 'Auth user not found');
    res.json({ message: 'Auth user deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete auth user');
  }
});

/** Auth users router for managing simulated Supabase auth.users per project. */
export default router;
