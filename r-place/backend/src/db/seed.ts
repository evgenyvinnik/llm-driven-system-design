/**
 * Database seeder for development
 * @module db/seed
 */
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://rplace:rplace_dev@localhost:5432/rplace',
})

async function seed(): Promise<void> {
  console.log('Seeding database...')

  try {
    // Create demo users
    const passwordHash = await bcrypt.hash('password123', 10)

    const userResult = await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES
        ($1, 'alice', $4, 'user'),
        ($2, 'bob', $4, 'user'),
        ($3, 'admin', $4, 'admin')
      ON CONFLICT (username) DO NOTHING
      RETURNING id, username, role
    `, [uuidv4(), uuidv4(), uuidv4(), passwordHash])

    if (userResult.rows.length === 0) {
      console.log('Users already exist, skipping seed')
      await pool.end()
      return
    }

    console.log('Created users:', userResult.rows.map(u => `${u.username} (${u.role})`).join(', '))

    const alice = userResult.rows.find(u => u.username === 'alice')
    const bob = userResult.rows.find(u => u.username === 'bob')

    // Create some initial pixel events for a pattern
    // Draw a simple smiley face in the center of a 500x500 canvas
    const centerX = 250
    const centerY = 250

    const pixels = [
      // Yellow background (color 4)
      ...Array.from({ length: 30 }, (_, i) => ({
        x: centerX - 15 + (i % 30),
        y: centerY - 15 + Math.floor(i / 30),
        color: 4,
        userId: alice?.id,
      })),
      // Left eye (color 0 = black)
      { x: centerX - 5, y: centerY - 5, color: 0, userId: alice?.id },
      { x: centerX - 4, y: centerY - 5, color: 0, userId: alice?.id },
      { x: centerX - 5, y: centerY - 4, color: 0, userId: alice?.id },
      { x: centerX - 4, y: centerY - 4, color: 0, userId: alice?.id },
      // Right eye (color 0 = black)
      { x: centerX + 4, y: centerY - 5, color: 0, userId: bob?.id },
      { x: centerX + 5, y: centerY - 5, color: 0, userId: bob?.id },
      { x: centerX + 4, y: centerY - 4, color: 0, userId: bob?.id },
      { x: centerX + 5, y: centerY - 4, color: 0, userId: bob?.id },
      // Smile (color 0 = black)
      { x: centerX - 7, y: centerY + 3, color: 0, userId: alice?.id },
      { x: centerX - 6, y: centerY + 5, color: 0, userId: alice?.id },
      { x: centerX - 5, y: centerY + 6, color: 0, userId: bob?.id },
      { x: centerX - 4, y: centerY + 7, color: 0, userId: alice?.id },
      { x: centerX - 3, y: centerY + 7, color: 0, userId: bob?.id },
      { x: centerX - 2, y: centerY + 7, color: 0, userId: alice?.id },
      { x: centerX - 1, y: centerY + 7, color: 0, userId: bob?.id },
      { x: centerX, y: centerY + 7, color: 0, userId: alice?.id },
      { x: centerX + 1, y: centerY + 7, color: 0, userId: bob?.id },
      { x: centerX + 2, y: centerY + 7, color: 0, userId: alice?.id },
      { x: centerX + 3, y: centerY + 7, color: 0, userId: bob?.id },
      { x: centerX + 4, y: centerY + 7, color: 0, userId: alice?.id },
      { x: centerX + 5, y: centerY + 6, color: 0, userId: bob?.id },
      { x: centerX + 6, y: centerY + 5, color: 0, userId: alice?.id },
      { x: centerX + 7, y: centerY + 3, color: 0, userId: bob?.id },
    ]

    // Insert pixel events
    for (const pixel of pixels) {
      await pool.query(
        `INSERT INTO pixel_events (x, y, color, user_id)
         VALUES ($1, $2, $3, $4)`,
        [pixel.x, pixel.y, pixel.color, pixel.userId]
      )
    }

    console.log(`Created ${pixels.length} pixel events`)
    console.log('')
    console.log('Seed complete!')
    console.log('Test accounts:')
    console.log('  alice / password123')
    console.log('  bob / password123')
    console.log('  admin / password123 (admin role)')
  } catch (error) {
    console.error('Seed failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

seed()
