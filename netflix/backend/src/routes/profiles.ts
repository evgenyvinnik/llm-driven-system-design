import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';
import { setSession, getSession, invalidateHomepage } from '../services/redis.js';

/**
 * Profiles router.
 * Manages user profiles within an account (CRUD operations and profile selection).
 * Each account can have up to 5 profiles with independent viewing history.
 */
const router = Router();

/** Database row type for profile queries */
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
 * Returns all profiles for the authenticated account.
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
 * Creates a new profile for the account (max 5 profiles allowed).
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
 * Updates profile settings (name, avatar, maturity level, etc.).
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

    // A lowered maturity level must not keep serving a homepage built for the old one.
    await invalidateHomepage(id);

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
 * Deletes a profile (cannot delete the last remaining profile).
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
 * Selects a profile for the current session.
 * Updates the session in Redis to include the selected profile ID.
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
