import { Request, Response } from 'express';
import { authService } from '../services/authService.js';

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

export async function logout(req: Request, res: Response): Promise<void> {
  if (req.sessionId) {
    await authService.logout(req.sessionId);
  }

  res.clearCookie('sessionId');
  res.json({ success: true });
}

export async function me(req: Request, res: Response): Promise<void> {
  res.json({ data: req.user });
}

export async function updateProfile(req: Request, res: Response): Promise<void> {
  const { displayName, avatarUrl } = req.body;

  const user = await authService.updateUser(req.user!.id, {
    displayName,
    avatarUrl,
  });

  res.json({ data: user });
}

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
