import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../db/index.js';
import { setSession, deleteSession } from '../services/redis.js';
import { authenticate } from '../middleware/auth.js';
import { Account, Profile } from '../types/index.js';
import { SERVER_CONFIG } from '../config.js';

const router = Router();

interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  subscription_tier: string;
  country: string;
  created_at: Date;
  updated_at: Date;
}

interface ProfileRow {
  id: string;
  account_id: string;
  name: string;
  avatar_url: string | null;
  is_kids: boolean;
  maturity_level: number;
  language: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * POST /api/auth/login
 * Login with email and password
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' });
      return;
    }

    const account = await queryOne<AccountRow>(
      'SELECT * FROM accounts WHERE email = $1',
      [email.toLowerCase()]
    );

    if (!account) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // For demo purposes, accept any password for the demo account
    const isDemo = account.email === 'demo@netflix.local';
    const isValidPassword = isDemo || await bcrypt.compare(password, account.password_hash);

    if (!isValidPassword) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Create session token
    const token = uuidv4();
    await setSession(token, {
      accountId: account.id,
      deviceInfo: {
        userAgent: req.get('user-agent'),
        ip: req.ip,
      },
      createdAt: new Date().toISOString(),
    });

    // Set cookie
    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SERVER_CONFIG.sessionMaxAge,
    });

    res.json({
      success: true,
      account: {
        id: account.id,
        email: account.email,
        subscriptionTier: account.subscription_tier,
        country: account.country,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/register
 * Register a new account
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' });
      return;
    }

    // Check if email exists
    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM accounts WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existing) {
      res.status(400).json({ error: 'Email already registered' });
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create account
    const accountResult = await queryOne<AccountRow>(
      `INSERT INTO accounts (email, password_hash)
       VALUES ($1, $2)
       RETURNING *`,
      [email.toLowerCase(), passwordHash]
    );

    if (!accountResult) {
      res.status(500).json({ error: 'Failed to create account' });
      return;
    }

    // Create default profile
    await query(
      `INSERT INTO profiles (account_id, name, avatar_url)
       VALUES ($1, $2, '/avatars/avatar1.png')`,
      [accountResult.id, name || 'Profile 1']
    );

    // Create session
    const token = uuidv4();
    await setSession(token, {
      accountId: accountResult.id,
      deviceInfo: {
        userAgent: req.get('user-agent'),
        ip: req.ip,
      },
      createdAt: new Date().toISOString(),
    });

    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SERVER_CONFIG.sessionMaxAge,
    });

    res.status(201).json({
      success: true,
      account: {
        id: accountResult.id,
        email: accountResult.email,
        subscriptionTier: accountResult.subscription_tier,
        country: accountResult.country,
      },
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/logout
 * Logout current session
 */
router.post('/logout', async (req: Request, res: Response) => {
  const token = req.cookies?.session_token;

  if (token) {
    await deleteSession(token);
  }

  res.clearCookie('session_token');
  res.json({ success: true });
});

/**
 * GET /api/auth/me
 * Get current session info
 */
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const account = await queryOne<AccountRow>(
      'SELECT id, email, subscription_tier, country FROM accounts WHERE id = $1',
      [req.accountId]
    );

    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    let currentProfile = null;
    if (req.profileId) {
      currentProfile = await queryOne<ProfileRow>(
        'SELECT * FROM profiles WHERE id = $1',
        [req.profileId]
      );
    }

    res.json({
      account: {
        id: account.id,
        email: account.email,
        subscriptionTier: account.subscription_tier,
        country: account.country,
      },
      currentProfile: currentProfile
        ? {
            id: currentProfile.id,
            name: currentProfile.name,
            avatarUrl: currentProfile.avatar_url,
            isKids: currentProfile.is_kids,
            maturityLevel: currentProfile.maturity_level,
            language: currentProfile.language,
          }
        : null,
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
