/**
 * Social Service for following, sharing, and social features
 * @module social/app
 */
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import crypto from 'crypto'
import { query } from '../shared/db.js'
import { authMiddleware, createSession } from '../shared/auth.js'
import { createLogger } from '../shared/logger.js'

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

    const passwordHash = crypto.createHash('sha256').update(password).digest('hex')

    const result = await query<{ id: string }>(
      `INSERT INTO users (email, username, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [email, username, passwordHash]
    )

    const userId = result.rows[0].id

    // Create default privacy settings
    await query(
      `INSERT INTO user_privacy_settings (user_id)
       VALUES ($1)`,
      [userId]
    )

    const sessionId = await createSession(userId)

    logger.info({ event: 'user_registered', userId, username })

    res.status(201).json({ userId, sessionId })
  } catch (error: any) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'Email or username already exists' })
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

    const passwordHash = crypto.createHash('sha256').update(password).digest('hex')

    const result = await query<{ id: string; username: string }>(
      `SELECT id, username FROM users
       WHERE email = $1 AND password_hash = $2`,
      [email, passwordHash]
    )

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid email or password' })
      return
    }

    const user = result.rows[0]
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

// ==================== Following ====================

/**
 * Follow a user
 * POST /api/users/:userId/follow
 */
app.post('/api/users/:userId/follow', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const followerId = req.userId!
    const followeeId = req.params.userId

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
    const followeeId = req.params.userId

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
 */
app.get('/api/books/:bookId/friends-highlights', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!
    const { bookId } = req.params
    const { limit = '50' } = req.query as Record<string, string>

    const result = await query(
      `SELECT
         h.id,
         h.highlighted_text,
         h.note,
         h.location_start,
         h.location_end,
         h.color,
         h.created_at,
         u.username,
         u.avatar_url
       FROM highlights h
       JOIN follows f ON f.followee_id = h.user_id
       JOIN users u ON u.id = h.user_id
       JOIN user_privacy_settings ups ON ups.user_id = h.user_id
       WHERE f.follower_id = $1
         AND h.book_id = $2
         AND h.archived = false
         AND (ups.highlight_visibility = 'public' OR ups.highlight_visibility = 'friends')
       ORDER BY h.created_at DESC
       LIMIT $3`,
      [userId, bookId, parseInt(limit)]
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
    const { highlightId } = req.params
    const { platform } = req.body

    if (!platform) {
      res.status(400).json({ error: 'Platform is required' })
      return
    }

    const result = await query(
      `SELECT h.*, b.title as book_title, b.author as book_author
       FROM highlights h
       JOIN books b ON b.id = h.book_id
       WHERE h.id = $1 AND h.user_id = $2`,
      [highlightId, userId]
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Highlight not found' })
      return
    }

    const h = result.rows[0]

    // Log share event
    await query(
      `INSERT INTO highlight_shares (highlight_id, platform)
       VALUES ($1, $2)`,
      [highlightId, platform]
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
    const { highlightVisibility, allowFollowers, includeInAggregation } = req.body

    await query(
      `INSERT INTO user_privacy_settings (user_id, highlight_visibility, allow_followers, include_in_aggregation)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         highlight_visibility = COALESCE($2, user_privacy_settings.highlight_visibility),
         allow_followers = COALESCE($3, user_privacy_settings.allow_followers),
         include_in_aggregation = COALESCE($4, user_privacy_settings.include_in_aggregation)`,
      [userId, highlightVisibility, allowFollowers, includeInAggregation]
    )

    logger.info({ event: 'privacy_settings_updated', userId })

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
    const { userId } = req.params

    const result = await query(
      `SELECT u.id, u.username, u.avatar_url, u.bio, u.created_at,
              (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) as followers_count,
              (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count,
              (SELECT COUNT(*) FROM highlights WHERE user_id = u.id AND visibility = 'public') as public_highlights_count
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
    const { userId } = req.params
    const { limit = '50', offset = '0' } = req.query as Record<string, string>

    const result = await query(
      `SELECT h.*, b.title as book_title, b.author as book_author
       FROM highlights h
       JOIN books b ON b.id = h.book_id
       WHERE h.user_id = $1 AND h.visibility = 'public' AND h.archived = false
       ORDER BY h.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, parseInt(limit), parseInt(offset)]
    )

    res.json(result.rows)
  } catch (error) {
    next(error)
  }
})

/** Error handling middleware */
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ error: err.message, stack: err.stack })
  res.status(500).json({ error: 'Internal server error' })
})
