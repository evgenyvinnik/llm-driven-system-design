import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { pool } from './db.js'
import { redis } from './cache.js'

const SESSION_TTL = 24 * 60 * 60 // 24 hours in seconds

interface Session {
  userId: string
  email: string
  name: string | null
  createdAt: number
}

interface AdminUser {
  id: string
  email: string
  password_hash: string
  name: string | null
}

// Generate a secure session ID
function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex')
}

// Create a session for a user
export async function createSession(userId: string, email: string, name: string | null): Promise<string> {
  const sessionId = generateSessionId()
  const session: Session = {
    userId,
    email,
    name,
    createdAt: Date.now(),
  }

  await redis.setex(`session:${sessionId}`, SESSION_TTL, JSON.stringify(session))
  return sessionId
}

// Get session by ID
export async function getSession(sessionId: string): Promise<Session | null> {
  const data = await redis.get(`session:${sessionId}`)
  if (!data) return null
  return JSON.parse(data) as Session
}

// Delete a session (logout)
export async function deleteSession(sessionId: string): Promise<void> {
  await redis.del(`session:${sessionId}`)
}

// Validate login credentials and return user
export async function validateLogin(email: string, password: string): Promise<AdminUser | null> {
  const result = await pool.query(
    'SELECT id, email, password_hash, name FROM admin_users WHERE email = $1',
    [email]
  )

  if (result.rows.length === 0) {
    return null
  }

  const user = result.rows[0] as AdminUser
  const isValid = await bcrypt.compare(password, user.password_hash)

  if (!isValid) {
    return null
  }

  return user
}

// Hash a password (for creating users)
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

// Create an admin user
export async function createAdminUser(email: string, password: string, name?: string): Promise<string> {
  const passwordHash = await hashPassword(password)
  const result = await pool.query(
    'INSERT INTO admin_users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
    [email, passwordHash, name || null]
  )
  return result.rows[0].id
}
