/**
 * Database seeder for development
 * @module db/seed
 */
import { pool, query } from '../shared/db.js'
import crypto from 'crypto'

async function seed(): Promise<void> {
  console.log('Seeding database...')

  // Create demo users
  const users = [
    { email: 'alice@example.com', username: 'alice', password: 'password123' },
    { email: 'bob@example.com', username: 'bob', password: 'password123' },
    { email: 'charlie@example.com', username: 'charlie', password: 'password123' },
  ]

  const userIds: string[] = []

  for (const user of users) {
    const passwordHash = crypto.createHash('sha256').update(user.password).digest('hex')
    const result = await query<{ id: string }>(
      `INSERT INTO users (email, username, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [user.email, user.username, passwordHash]
    )
    userIds.push(result.rows[0].id)
    console.log(`Created user: ${user.username}`)
  }

  // Create sample books
  const books = [
    {
      title: 'The Great Gatsby',
      author: 'F. Scott Fitzgerald',
      isbn: '9780743273565',
      content: `In my younger and more vulnerable years my father gave me some advice that I've been turning over in my mind ever since. "Whenever you feel like criticizing anyone," he told me, "just remember that all the people in this world haven't had the advantages that you've had." He didn't say any more, but we've always been unusually communicative in a reserved way, and I understood that he meant a great deal more than that.`,
    },
    {
      title: '1984',
      author: 'George Orwell',
      isbn: '9780451524935',
      content: `It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors of Victory Mansions, though not quickly enough to prevent a swirl of gritty dust from entering along with him.`,
    },
    {
      title: 'To Kill a Mockingbird',
      author: 'Harper Lee',
      isbn: '9780446310789',
      content: `When he was nearly thirteen, my brother Jem got his arm badly broken at the elbow. When it healed, and Jem's fears of never being able to play football were assuaged, he was seldom self-conscious about his injury. His left arm was somewhat shorter than his right; when he stood or walked, the back of his hand was at right angles to his body, his thumb parallel to his thigh.`,
    },
  ]

  const bookIds: string[] = []

  for (const book of books) {
    const result = await query<{ id: string }>(
      `INSERT INTO books (title, author, isbn, description, total_locations)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [book.title, book.author, book.isbn, book.content, book.content.length]
    )
    if (result.rows[0]) {
      bookIds.push(result.rows[0].id)
      console.log(`Created book: ${book.title}`)
    }
  }

  // Create sample highlights for each user
  const highlights = [
    { text: "In my younger and more vulnerable years my father gave me some advice", note: 'Great opening line', location: 0 },
    { text: "just remember that all the people in this world haven't had the advantages that you've had", note: 'Important life lesson', location: 150 },
    { text: 'It was a bright cold day in April, and the clocks were striking thirteen', note: 'Iconic first line', location: 0 },
    { text: 'Victory Mansions', note: 'Ironic name', location: 180 },
  ]

  for (const userId of userIds) {
    for (let i = 0; i < bookIds.length && i < 2; i++) {
      const bookId = bookIds[i]
      const highlight = highlights[i]
      if (highlight) {
        await query(
          `INSERT INTO highlights (user_id, book_id, location_start, location_end, highlighted_text, note, visibility)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [userId, bookId, highlight.location, highlight.location + highlight.text.length, highlight.text, highlight.note, 'public']
        )
      }
    }
  }

  // Create privacy settings for users
  for (const userId of userIds) {
    await query(
      `INSERT INTO user_privacy_settings (user_id, highlight_visibility, allow_followers, include_in_aggregation)
       VALUES ($1, 'public', true, true)
       ON CONFLICT DO NOTHING`,
      [userId]
    )
  }

  // Add users to their books
  for (const userId of userIds) {
    for (const bookId of bookIds) {
      await query(
        `INSERT INTO user_books (user_id, book_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, bookId]
      )
    }
  }

  console.log('Seed complete')
  await pool.end()
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
