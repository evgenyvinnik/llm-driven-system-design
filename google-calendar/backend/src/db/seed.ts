import bcrypt from 'bcryptjs'
import { pool } from '../shared/db.js'

async function seed() {
  try {
    // Create test users
    const passwordHash = await bcrypt.hash('password123', 10)

    const userResult = await pool.query(`
      INSERT INTO users (username, email, password_hash, timezone)
      VALUES
        ('alice', 'alice@example.com', $1, 'America/New_York'),
        ('bob', 'bob@example.com', $1, 'America/Los_Angeles')
      ON CONFLICT (username) DO NOTHING
      RETURNING id, username
    `, [passwordHash])

    if (userResult.rows.length === 0) {
      console.log('Users already exist, skipping seed')
      await pool.end()
      return
    }

    const alice = userResult.rows.find(u => u.username === 'alice')
    const bob = userResult.rows.find(u => u.username === 'bob')

    // Create calendars for Alice
    const calendarResult = await pool.query(`
      INSERT INTO calendars (user_id, name, color, is_primary)
      VALUES
        ($1, 'Personal', '#3B82F6', true),
        ($1, 'Work', '#EF4444', false),
        ($2, 'Personal', '#10B981', true)
      RETURNING id, name, user_id
    `, [alice?.id, bob?.id])

    const alicePersonal = calendarResult.rows.find(c => c.user_id === alice?.id && c.name === 'Personal')
    const aliceWork = calendarResult.rows.find(c => c.user_id === alice?.id && c.name === 'Work')

    // Create sample events for Alice
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    await pool.query(`
      -- start_time/end_time are TIMESTAMPTZ. A bare "date + interval '9 hours'"
      -- is a naive timestamp that Postgres interprets in the SERVER's zone (UTC in
      -- the container), so a 9am standup rendered at 2am for a US-Pacific viewer.
      -- AT TIME ZONE declares the wall-clock time's zone and yields the right instant.
      INSERT INTO events (calendar_id, title, description, location, start_time, end_time, all_day, color)
      VALUES
        -- Today's events
        ($1, 'Team Standup', 'Daily sync meeting', 'Zoom', (\$3::date + interval '9 hours') AT TIME ZONE 'America/Los_Angeles', (\$3::date + interval '9 hours 30 minutes') AT TIME ZONE 'America/Los_Angeles', false, null),
        ($1, 'Lunch with Sarah', null, 'Cafe downtown', (\$3::date + interval '12 hours') AT TIME ZONE 'America/Los_Angeles', (\$3::date + interval '13 hours') AT TIME ZONE 'America/Los_Angeles', false, null),
        ($2, 'Project Review', 'Q1 project review', 'Conference Room A', (\$3::date + interval '14 hours') AT TIME ZONE 'America/Los_Angeles', (\$3::date + interval '15 hours 30 minutes') AT TIME ZONE 'America/Los_Angeles', false, null),

        -- Tomorrow's events
        ($1, 'Morning Yoga', null, 'Gym', (\$3::date + interval '1 day 7 hours') AT TIME ZONE 'America/Los_Angeles', (\$3::date + interval '1 day 8 hours') AT TIME ZONE 'America/Los_Angeles', false, '#8B5CF6'),
        ($2, 'Client Call', 'Demo for new client', 'Phone', (\$3::date + interval '1 day 10 hours') AT TIME ZONE 'America/Los_Angeles', (\$3::date + interval '1 day 11 hours') AT TIME ZONE 'America/Los_Angeles', false, null),

        -- All day event
        ($1, 'Team Offsite', 'Annual team building', 'Lake Resort', (\$3::date + interval '3 days') AT TIME ZONE 'America/Los_Angeles', (\$3::date + interval '4 days') AT TIME ZONE 'America/Los_Angeles', true, '#F59E0B'),

        -- Next week
        ($2, 'Quarterly Planning', 'Planning for Q2', 'Main Office', (\$3::date + interval '7 days 9 hours') AT TIME ZONE 'America/Los_Angeles', (\$3::date + interval '7 days 17 hours') AT TIME ZONE 'America/Los_Angeles', false, null)
    `, [alicePersonal?.id, aliceWork?.id, today])

    console.log('Database seeded successfully')
    console.log('Test accounts:')
    console.log('  alice / password123')
    console.log('  bob / password123')
  } catch (error) {
    console.error('Seed failed:', error)
    process.exit(1)
  } finally {
    await pool.end()
  }
}

seed()
