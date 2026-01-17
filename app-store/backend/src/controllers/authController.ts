/**
 * @fileoverview Authentication controller for user management.
 * Handles registration, login, logout, and profile management.
 */

import { Request, Response } from 'express';
import { authService } from '../services/authService.js';

/**
 * Registers a new user account.
 * POST /api/v1/auth/register
 */
export async function register(req: Request, res: Response): Promise<void> {
  const { email, password, username, displayName } = req.body;

  if (!email || !password || !username) {
    res.status(400).json({ error: 'Email, password, and username are required' });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }

  const { user, sessionId } = await authService.register({
    email,
    password,
    username,
    displayName,
  });

  res.cookie('sessionId', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });

  res.status(201).json({
    data: { user, sessionId },
  });
}

/**
 * Authenticates a user and creates a session.
 * POST /api/v1/auth/login
 */
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const { user, sessionId } = await authService.login(email, password);

  res.cookie('sessionId', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  });

  res.json({
    data: { user, sessionId },
  });
}

/**
 * Logs out the current user by invalidating their session.
 * POST /api/v1/auth/logout
 */
export async function logout(req: Request, res: Response): Promise<void> {
  if (req.sessionId) {
    await authService.logout(req.sessionId);
  }

  res.clearCookie('sessionId');
  res.json({ success: true });
}

/**
 * Returns the current authenticated user's profile.
 * GET /api/v1/auth/me
 * Requires authentication.
 */
export async function me(req: Request, res: Response): Promise<void> {
  res.json({ data: req.user });
}

/**
 * Updates the current user's profile.
 * PUT /api/v1/auth/profile
 * Requires authentication.
 */
export async function updateProfile(req: Request, res: Response): Promise<void> {
  const { displayName, avatarUrl } = req.body;

  const user = await authService.updateUser(req.user!.id, {
    displayName,
    avatarUrl,
  });

  res.json({ data: user });
}

/**
 * Changes the current user's password.
 * PUT /api/v1/auth/password
 * Requires authentication.
 */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'Current and new password are required' });
    return;
  }

  if (newPassword.length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }

  await authService.changePassword(req.user!.id, currentPassword, newPassword);
  res.json({ success: true });
}

/**
 * Upgrades a user account to developer status.
 * POST /api/v1/auth/developer
 * Requires authentication.
 */
export async function becomeDeveloper(req: Request, res: Response): Promise<void> {
  const { name, email, website, description } = req.body;

  if (!name || !email) {
    res.status(400).json({ error: 'Name and email are required' });
    return;
  }

  await authService.becomeDeveloper(req.user!.id, {
    name,
    email,
    website,
    description,
  });

  // Refresh user data
  const user = await authService.getUserById(req.user!.id);

  res.json({ data: user });
}
