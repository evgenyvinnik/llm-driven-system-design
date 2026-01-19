import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getSession, setSession, deleteSession, SessionData } from '../services/redis.js';
import { query } from '../services/db.js';
import bcrypt from 'bcryptjs';

// User interface
interface User {
  id: number;
  email: string;
  name: string;
  role: string;
}

// User row from database
interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  name: string;
  role: string;
}

// Extend Express Request to include user and session properties
declare global {
  namespace Express {
    interface Request {
      user?: User;
      sessionId?: string;
      storeId?: number;
    }
  }
}

// Authenticate merchant from session cookie
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = await getSession(sessionId);
  if (!session) {
    return res.status(401).json({ error: 'Session expired' });
  }

  req.user = session.user;
  req.sessionId = sessionId;
  next();
}

// Authenticate and require store ownership
export async function storeOwnerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = await getSession(sessionId);
  if (!session) {
    return res.status(401).json({ error: 'Session expired' });
  }

  const storeId = parseInt(req.params.storeId, 10);

  // Verify ownership
  const result = await query(
    'SELECT id FROM stores WHERE id = $1 AND owner_id = $2',
    [storeId, session.user.id]
  );

  if (result.rows.length === 0) {
    return res.status(403).json({ error: 'Not authorized to access this store' });
  }

  req.user = session.user;
  req.storeId = storeId;
  req.sessionId = sessionId;
  next();
}

// Login handler
export async function login(req: Request, res: Response): Promise<void | Response> {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const result = await query(
    'SELECT id, email, password_hash, name, role FROM users WHERE email = $1',
    [email]
  );

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const user = result.rows[0] as UserRow;
  const validPassword = await bcrypt.compare(password, user.password_hash);

  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Create session
  const sessionId = uuidv4();
  const sessionData: SessionData = {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  };
  await setSession(sessionId, sessionData);

  res.cookie('session', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 86400000, // 24 hours
  });

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  });
}

// Register handler
export async function register(req: Request, res: Response): Promise<void | Response> {
  const { email, password, name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  // Check if email already exists
  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return res.status(400).json({ error: 'Email already registered' });
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 10);

  // Create user
  const result = await query(
    'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, role',
    [email, passwordHash, name || email.split('@')[0]]
  );

  const user = result.rows[0] as User;

  // Create session
  const sessionId = uuidv4();
  const sessionData: SessionData = { user };
  await setSession(sessionId, sessionData);

  res.cookie('session', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 86400000,
  });

  res.status(201).json({ user });
}

// Logout handler
export async function logout(req: Request, res: Response): Promise<void> {
  const sessionId = req.cookies?.session;
  if (sessionId) {
    await deleteSession(sessionId);
  }
  res.clearCookie('session');
  res.json({ success: true });
}

// Get current user
export async function me(req: Request, res: Response): Promise<void | Response> {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = await getSession(sessionId);
  if (!session) {
    return res.status(401).json({ error: 'Session expired' });
  }

  res.json({ user: session.user });
}
