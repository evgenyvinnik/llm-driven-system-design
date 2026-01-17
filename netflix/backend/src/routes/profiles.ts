import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';
import { setSession, getSession } from '../services/redis.js';

const router = Router();

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
 * GET /api/profiles
 * Get all profiles for current account
 */
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const profiles = await query<ProfileRow>(
      `SELECT * FROM profiles
       WHERE account_id = $1
       ORDER BY created_at ASC`,
      [req.accountId]
    );

    res.json({
      profiles: profiles.map((p) => ({
        id: p.id,
        name: p.name,
        avatarUrl: p.avatar_url,
        isKids: p.is_kids,
        maturityLevel: p.maturity_level,
        language: p.language,
      })),
    });
  } catch (error) {
    console.error('Get profiles error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/profiles
 * Create a new profile
 */
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const { name, avatarUrl, isKids, maturityLevel, language } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Profile name required' });
      return;
    }

    // Check profile limit (max 5)
    const countResult = await queryOne<{ count: string }>(
      'SELECT COUNT(*) FROM profiles WHERE account_id = $1',
      [req.accountId]
    );

    if (countResult && parseInt(countResult.count) >= 5) {
      res.status(400).json({ error: 'Maximum 5 profiles allowed' });
      return;
    }

    const profile = await queryOne<ProfileRow>(
      `INSERT INTO profiles (account_id, name, avatar_url, is_kids, maturity_level, language)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        req.accountId,
        name,
        avatarUrl || '/avatars/avatar1.png',
        isKids || false,
        isKids ? 1 : (maturityLevel || 4),
        language || 'en',
      ]
    );

    if (!profile) {
      res.status(500).json({ error: 'Failed to create profile' });
      return;
    }

    res.status(201).json({
      profile: {
        id: profile.id,
        name: profile.name,
        avatarUrl: profile.avatar_url,
        isKids: profile.is_kids,
        maturityLevel: profile.maturity_level,
        language: profile.language,
      },
    });
  } catch (error) {
    console.error('Create profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/profiles/:id
 * Update a profile
 */
router.put('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, avatarUrl, isKids, maturityLevel, language } = req.body;

    // Verify profile belongs to account
    const existing = await queryOne<ProfileRow>(
      'SELECT * FROM profiles WHERE id = $1 AND account_id = $2',
      [id, req.accountId]
    );

    if (!existing) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    const profile = await queryOne<ProfileRow>(
      `UPDATE profiles
       SET name = COALESCE($1, name),
           avatar_url = COALESCE($2, avatar_url),
           is_kids = COALESCE($3, is_kids),
           maturity_level = COALESCE($4, maturity_level),
           language = COALESCE($5, language),
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [name, avatarUrl, isKids, maturityLevel, language, id]
    );

    if (!profile) {
      res.status(500).json({ error: 'Failed to update profile' });
      return;
    }

    res.json({
      profile: {
        id: profile.id,
        name: profile.name,
        avatarUrl: profile.avatar_url,
        isKids: profile.is_kids,
        maturityLevel: profile.maturity_level,
        language: profile.language,
      },
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/profiles/:id
 * Delete a profile
 */
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Verify profile belongs to account
    const existing = await queryOne<ProfileRow>(
      'SELECT * FROM profiles WHERE id = $1 AND account_id = $2',
      [id, req.accountId]
    );

    if (!existing) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    // Check it's not the last profile
    const countResult = await queryOne<{ count: string }>(
      'SELECT COUNT(*) FROM profiles WHERE account_id = $1',
      [req.accountId]
    );

    if (countResult && parseInt(countResult.count) <= 1) {
      res.status(400).json({ error: 'Cannot delete last profile' });
      return;
    }

    await query('DELETE FROM profiles WHERE id = $1', [id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/profiles/:id/select
 * Select a profile for the current session
 */
router.post('/:id/select', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Verify profile belongs to account
    const profile = await queryOne<ProfileRow>(
      'SELECT * FROM profiles WHERE id = $1 AND account_id = $2',
      [id, req.accountId]
    );

    if (!profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    // Update session with profile
    const token = req.cookies?.session_token;
    if (token) {
      const session = await getSession(token);
      if (session) {
        await setSession(token, {
          ...session,
          profileId: id,
        });
      }
    }

    res.json({
      profile: {
        id: profile.id,
        name: profile.name,
        avatarUrl: profile.avatar_url,
        isKids: profile.is_kids,
        maturityLevel: profile.maturity_level,
        language: profile.language,
      },
    });
  } catch (error) {
    console.error('Select profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
