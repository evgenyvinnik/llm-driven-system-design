/**
 * Social Service for following, sharing, and social features
 * @module social/app
 */
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import { query, transaction } from '../shared/db.js'
import { authMiddleware, createSession, destroySession } from '../shared/auth.js'
import { createLogger } from '../shared/logger.js'
import { errorHandler, HttpError } from '../shared/errors.js'
import { hashPassword, verifyPassword } from '../shared/password.js'
import { isUuid, parseLimit, parseNonNegative, VISIBILITIES, type Visibility } from '../shared/validation.js'

const logger = createLogger('social-service')

export const app = express()

app.use(cors())
app.use(express.json())

/** Health check endpoint */
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'social' })
})

// ==================== Authentication ====================

/**
 * Register a new user
 * POST /api/auth/register
 */
app.post('/api/auth/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, username, password } = req.body

    if (!email || !username || !password) {
      res.status(400).json({ error: 'Email, username, and password are required' })
      return
    }
    if (typeof password !== 'string' || password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' })
      return
    }

    const passwordHash = await hashPassword(password)

    // The account and its default privacy settings are created together or not at all.
    const userId = await transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO users (email, username, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [email, username, passwordHash]
      )
      await client.query('INSERT INTO user_privacy_settings (user_id) VALUES ($1)', [result.rows[0].id])
      return result.rows[0].id
    })

    const sessionId = await createSession(userId)

    logger.info({ event: 'user_registered', userId, username })

    res.status(201).json({ userId, sessionId })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Email already registered' })
      return
    }
    next(error)
  }
})

/**
 * Login
 * POST /api/auth/login
 */
app.post('/api/auth/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' })
      return
    }

    const result = await query<{ id: string; username: string; password_hash: string }>(
      'SELECT id, username, password_hash FROM users WHERE email = $1',
      [email]
    )

    const user = result.rows[0]
    const verdict = user ? await verifyPassword(String(password), user.password_hash) : { ok: false, needsRehash: false }
    if (!user || !verdict.ok) {
      res.status(401).json({ error: 'Invalid email or password' })
      return
    }

    // Accounts from before the scrypt switch: replace the unsalted digest now that we have the password.
    if (verdict.needsRehash) {
      await query('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [user.id, await hashPassword(String(password))])
      logger.info({ event: 'password_hash_upgraded', userId: user.id })
    }

    const sessionId = await createSession(user.id)

    logger.info({ event: 'user_logged_in', userId: user.id })

    res.json({ userId: user.id, username: user.username, sessionId })
  } catch (error) {
    next(error)
  }
})

/**
 * Get current user
 * GET /api/auth/me
 */
app.get('/api/auth/me', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!

    const result = await query(
      `SELECT id, email, username, avatar_url, bio, created_at
       FROM users WHERE id = $1`,
      [userId]
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    res.json(result.rows[0])
  } catch (error) {
    next(error)
  }
})

/**
 * Logout: revoke the session server-side (deleting the token client-side alone leaves it valid)
 * POST /api/auth/logout
 */
app.post('/api/auth/logout', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await destroySession(req.sessionId!)
    logger.info({ event: 'user_logged_out', userId: req.userId })
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// ==================== Following ====================

/**
 * Follow a user
 * POST /api/users/:userId/follow
 */
app.post('/api/users/:userId/follow', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const followerId = req.userId!
    const followeeId = String(req.params.userId)
    if (!isUuid(followeeId)) throw new HttpError(400, 'userId must be a UUID')

    if (followerId === followeeId) {
      res.status(400).json({ error: 'Cannot follow yourself' })
      return
    }

    // Check if followee allows followers
    const settings = await query<{ allow_followers: boolean }>(
      `SELECT allow_followers FROM user_privacy_settings WHERE user_id = $1`,
      [followeeId]
    )

    if (settings.rows[0] && !settings.rows[0].allow_followers) {
      res.status(403).json({ error: 'User does not accept followers' })
      return
    }

    await query(
      `INSERT INTO follows (follower_id, followee_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [followerId, followeeId]
    )

    logger.info({ event: 'user_followed', followerId, followeeId })

    res.status(201).json({ success: true })
  } catch (error) {
    next(error)
  }
})

/**
 * Unfollow a user
 * DELETE /api/users/:userId/follow
 */
app.delete('/api/users/:userId/follow', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const followerId = req.userId!
    const followeeId = String(req.params.userId)
    if (!isUuid(followeeId)) throw new HttpError(400, 'userId must be a UUID')

    await query(
      `DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`,
      [followerId, followeeId]
    )

    logger.info({ event: 'user_unfollowed', followerId, followeeId })

    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

/**
 * Get users I follow
 * GET /api/following
 */
app.get('/api/following', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!

    const result = await query(
      `SELECT u.id, u.username, u.avatar_url, f.created_at as followed_at
       FROM follows f
       JOIN users u ON u.id = f.followee_id
       WHERE f.follower_id = $1
       ORDER BY f.created_at DESC`,
      [userId]
    )

    res.json(result.rows)
  } catch (error) {
    next(error)
  }
})

/**
 * Get my followers
 * GET /api/followers
 */
app.get('/api/followers', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!

    const result = await query(
      `SELECT u.id, u.username, u.avatar_url, f.created_at as followed_at
       FROM follows f
       JOIN users u ON u.id = f.follower_id
       WHERE f.followee_id = $1
       ORDER BY f.created_at DESC`,
      [userId]
    )

    res.json(result.rows)
  } catch (error) {
    next(error)
  }
})

// ==================== Friends' Highlights ====================

/**
 * Get highlights from people I follow for a specific book
 * GET /api/books/:bookId/friends-highlights
 *
 * Each highlight's own visibility decides: 'public' highlights of people I follow are shown,
 * 'friends' highlights only when the follow is mutual (they follow me back), 'private' never.
 * Following is one-sided and needs no approval, so treating every follower as a friend would
 * let anyone unlock 'friends' highlights by clicking Follow.
 */
app.get('/api/books/:bookId/friends-highlights', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const bookId = String(req.params.bookId)
    if (!isUuid(bookId)) throw new HttpError(400, 'bookId must be a UUID')
    const limit = parseLimit(req.query.limit, 50, 200)

    const result = await query(
      `SELECT
         h.id,
         h.highlighted_text,
         h.note,
         h.location_start,
         h.location_end,
         h.color,
         h.visibility,
         h.created_at,
         u.username,
         u.avatar_url
       FROM highlights h
       JOIN follows f ON f.followee_id = h.user_id AND f.follower_id = $1
       JOIN users u ON u.id = h.user_id
       WHERE h.book_id = $2
         AND h.deleted_at IS NULL
         AND (
           h.visibility = 'public'
           OR (h.visibility = 'friends' AND EXISTS (
                 SELECT 1 FROM follows back
                 WHERE back.follower_id = h.user_id AND back.followee_id = $1))
         )
       ORDER BY h.created_at DESC
       LIMIT $3`,
      [userId, bookId, limit]
    )

    res.json(result.rows)
  } catch (error) {
    next(error)
  }
})

// ==================== Sharing ====================

/**
 * Share a highlight
 * POST /api/highlights/:highlightId/share
 */
app.post('/api/highlights/:highlightId/share', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const highlightId = String(req.params.highlightId)
    const { platform } = req.body
    if (!isUuid(highlightId)) throw new HttpError(400, 'highlightId must be a UUID')

    if (typeof platform !== 'string' || platform === '' || platform.length > 30) {
      res.status(400).json({ error: 'Platform is required' })
      return
    }

    const result = await query(
      `SELECT h.*, b.title as book_title, b.author as book_author
       FROM highlights h
       JOIN books b ON b.id = h.book_id
       WHERE h.id = $1 AND h.user_id = $2 AND h.deleted_at IS NULL`,
      [highlightId, userId]
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Highlight not found' })
      return
    }

    const h = result.rows[0]

    // Log share event
    await query(
      `INSERT INTO highlight_shares (highlight_id, user_id, platform)
       VALUES ($1, $2, $3)`,
      [highlightId, userId, platform]
    )

    // Generate share content
    const shareText = `"${h.highlighted_text}"\n\n— ${h.book_author}, ${h.book_title}`
    const shareUrl = `https://highlights.example.com/h/${highlightId}`

    logger.info({ event: 'highlight_shared', userId, highlightId, platform })

    res.json({ text: shareText, url: shareUrl })
  } catch (error) {
    next(error)
  }
})

// ==================== Privacy Settings ====================

/**
 * Get privacy settings
 * GET /api/settings/privacy
 */
app.get('/api/settings/privacy', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!

    const result = await query(
      `SELECT highlight_visibility, allow_followers, include_in_aggregation
       FROM user_privacy_settings
       WHERE user_id = $1`,
      [userId]
    )

    if (result.rows.length === 0) {
      res.json({
        highlight_visibility: 'private',
        allow_followers: true,
        include_in_aggregation: true,
      })
      return
    }

    res.json(result.rows[0])
  } catch (error) {
    next(error)
  }
})

/**
 * Update privacy settings
 * PATCH /api/settings/privacy
 */
app.patch('/api/settings/privacy', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { highlightVisibility, allowFollowers, includeInAggregation } = req.body ?? {}

    if (highlightVisibility !== undefined && !VISIBILITIES.includes(highlightVisibility as Visibility)) {
      throw new HttpError(400, `highlightVisibility must be one of ${VISIBILITIES.join(', ')}`)
    }
    for (const [name, value] of Object.entries({ allowFollowers, includeInAggregation })) {
      if (value !== undefined && typeof value !== 'boolean') throw new HttpError(400, `${name} must be a boolean`)
    }

    const consentChanged = await transaction(async (client) => {
      const before = await client.query<{ include_in_aggregation: boolean }>(
        'SELECT include_in_aggregation FROM user_privacy_settings WHERE user_id = $1 FOR UPDATE',
        [userId]
      )
      const after = await client.query<{ include_in_aggregation: boolean }>(
        `INSERT INTO user_privacy_settings (user_id, highlight_visibility, allow_followers, include_in_aggregation)
         VALUES ($1, COALESCE($2, 'private'), COALESCE($3, true), COALESCE($4, true))
         ON CONFLICT (user_id) DO UPDATE SET
           highlight_visibility = COALESCE($2, user_privacy_settings.highlight_visibility),
           allow_followers = COALESCE($3, user_privacy_settings.allow_followers),
           include_in_aggregation = COALESCE($4, user_privacy_settings.include_in_aggregation),
           updated_at = NOW()
         RETURNING include_in_aggregation`,
        [userId, highlightVisibility ?? null, allowFollowers ?? null, includeInAggregation ?? null]
      )
      const wasIncluded = before.rows[0]?.include_in_aggregation ?? true
      const changed = wasIncluded !== after.rows[0].include_in_aggregation
      if (changed) {
        // Opting out (or back in) moves this reader's public highlights out of (or into) every
        // book's counts; the worker recounts those books after this commit.
        await client.query(
          `INSERT INTO aggregation_outbox (book_id, reason)
           SELECT DISTINCT book_id, 'consent' FROM highlights
           WHERE user_id = $1 AND visibility = 'public' AND deleted_at IS NULL`,
          [userId]
        )
      }
      return changed
    })

    logger.info({ event: 'privacy_settings_updated', userId, consentChanged })

    res.json({ success: true })
  } catch (error) {
    next(error)
  }
})

// ==================== User Profiles ====================

/**
 * Get user profile
 * GET /api/users/:userId
 */
app.get('/api/users/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = String(req.params.userId)
    if (!isUuid(userId)) throw new HttpError(400, 'userId must be a UUID')

    const result = await query(
      `SELECT u.id, u.username, u.avatar_url, u.bio, u.created_at,
              (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) as followers_count,
              (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count,
              (SELECT COUNT(*) FROM highlights
               WHERE user_id = u.id AND visibility = 'public' AND deleted_at IS NULL) as public_highlights_count
       FROM users u
       WHERE u.id = $1`,
      [userId]
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    res.json(result.rows[0])
  } catch (error) {
    next(error)
  }
})

/**
 * Get user's public highlights
 * GET /api/users/:userId/highlights
 */
app.get('/api/users/:userId/highlights', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = String(req.params.userId)
    if (!isUuid(userId)) throw new HttpError(400, 'userId must be a UUID')
    const limit = parseLimit(req.query.limit, 50, 200)
    const offset = parseNonNegative(req.query.offset, 0)

    // Explicit columns: sync metadata (sequence numbers, per-device edit stamps) stays private.
    const result = await query(
      `SELECT h.id, h.book_id, h.location_start, h.location_end, h.highlighted_text, h.note, h.color,
              h.created_at, b.title as book_title, b.author as book_author
       FROM highlights h
       JOIN books b ON b.id = h.book_id
       WHERE h.user_id = $1 AND h.visibility = 'public' AND h.deleted_at IS NULL
       ORDER BY h.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    )

    res.json(result.rows)
  } catch (error) {
    next(error)
  }
})

/** Error handling middleware */
app.use(errorHandler(logger))
