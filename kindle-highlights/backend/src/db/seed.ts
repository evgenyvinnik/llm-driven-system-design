/**
 * Database seeder for development
 *
 * Re-runnable: users are upserted by email, books looked up by ISBN, and every highlight has a
 * deterministic id, so a second run replays the same creates instead of duplicating them.
 * Highlights go through the real write path (sequence numbers + aggregation outbox), so the
 * aggregation worker publishes popular passages from this data on its first cycle.
 *
 * The data is shaped to show the privacy rules (threshold POPULAR_MIN_READERS, default 5):
 *   - Gatsby opening line: 12 public highlights, but reader09 opted out -> 11 readers, published
 *   - Gatsby "just remember...": 7 public readers (alice's copy is private) -> published
 *   - 1984 opening line: 6 public readers -> published
 *   - 1984 "Victory Mansions": 3 public readers -> below the threshold, never shown
 *   - Mockingbird opening line: 3 public readers + 1 friends-only -> never shown
 *   - alice <-> bob follow each other, so bob sees alice's friends-only highlight; charlie
 *     follows alice one-way and sees only her public ones.
 *
 * @module db/seed
 */
import { v5 as uuidv5 } from 'uuid'
import { pool, query } from '../shared/db.js'
import { createHighlight } from '../shared/highlights.js'
import { hashPassword } from '../shared/password.js'
import type { Color, Visibility } from '../shared/validation.js'

/** Namespace for deterministic seed ids (RFC 4122 v5). */
const SEED_NAMESPACE = 'b5a0e1c4-7d2f-4f3e-9a61-0c2d8e4f6a17'

const BOOKS = {
  gatsby: {
    title: 'The Great Gatsby',
    author: 'F. Scott Fitzgerald',
    isbn: '9780743273565',
    content: `In my younger and more vulnerable years my father gave me some advice that I've been turning over in my mind ever since. "Whenever you feel like criticizing anyone," he told me, "just remember that all the people in this world haven't had the advantages that you've had." He didn't say any more, but we've always been unusually communicative in a reserved way, and I understood that he meant a great deal more than that.`,
  },
  nineteen84: {
    title: '1984',
    author: 'George Orwell',
    isbn: '9780451524935',
    content: `It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors of Victory Mansions, though not quickly enough to prevent a swirl of gritty dust from entering along with him.`,
  },
  mockingbird: {
    title: 'To Kill a Mockingbird',
    author: 'Harper Lee',
    isbn: '9780446310789',
    content: `When he was nearly thirteen, my brother Jem got his arm badly broken at the elbow. When it healed, and Jem's fears of never being able to play football were assuaged, he was seldom self-conscious about his injury. His left arm was somewhat shorter than his right; when he stood or walked, the back of his hand was at right angles to his body, his thumb parallel to his thigh.`,
  },
} as const

type BookKey = keyof typeof BOOKS

const PASSAGES: Record<string, { book: BookKey; text: string }> = {
  gatsbyOpening: { book: 'gatsby', text: 'In my younger and more vulnerable years my father gave me some advice' },
  gatsbyAdvice: {
    book: 'gatsby',
    text: "just remember that all the people in this world haven't had the advantages that you've had",
  },
  gatsbyReserved: { book: 'gatsby', text: "we've always been unusually communicative in a reserved way" },
  orwellOpening: { book: 'nineteen84', text: 'It was a bright cold day in April, and the clocks were striking thirteen' },
  orwellMansions: { book: 'nineteen84', text: 'Victory Mansions' },
  mockingbirdOpening: {
    book: 'mockingbird',
    text: 'When he was nearly thirteen, my brother Jem got his arm badly broken at the elbow',
  },
}

const READERS = Array.from({ length: 9 }, (_, i) => `reader${String(i + 1).padStart(2, '0')}`)

const USERS = [
  { username: 'alice', email: 'alice@example.com' },
  { username: 'bob', email: 'bob@example.com' },
  { username: 'charlie', email: 'charlie@example.com' },
  ...READERS.map((username) => ({ username, email: `${username}@example.com` })),
]

/** Readers who opted out of community aggregation. */
const OPTED_OUT = new Set(['reader09'])

interface SeedHighlight {
  user: string
  passage: keyof typeof PASSAGES
  visibility: Visibility
  note?: string
  color?: Color
}

const HIGHLIGHTS: SeedHighlight[] = [
  // Gatsby opening: everyone, publicly (reader09's copy doesn't count: opted out)
  { user: 'alice', passage: 'gatsbyOpening', visibility: 'public', note: 'Great opening line' },
  { user: 'bob', passage: 'gatsbyOpening', visibility: 'public', color: 'blue' },
  { user: 'charlie', passage: 'gatsbyOpening', visibility: 'public' },
  ...READERS.map((user): SeedHighlight => ({ user, passage: 'gatsbyOpening', visibility: 'public' })),
  // Gatsby advice: alice keeps hers private; bob, charlie and five readers share theirs
  { user: 'alice', passage: 'gatsbyAdvice', visibility: 'private', note: 'Important life lesson', color: 'green' },
  { user: 'bob', passage: 'gatsbyAdvice', visibility: 'public' },
  { user: 'charlie', passage: 'gatsbyAdvice', visibility: 'public', color: 'pink' },
  ...READERS.slice(0, 5).map((user): SeedHighlight => ({ user, passage: 'gatsbyAdvice', visibility: 'public' })),
  // A friends-only highlight with a personal note
  { user: 'alice', passage: 'gatsbyReserved', visibility: 'friends', note: 'Reminds me of my dad', color: 'orange' },
  // 1984 opening: six public readers
  { user: 'alice', passage: 'orwellOpening', visibility: 'public', note: 'Iconic first line' },
  { user: 'bob', passage: 'orwellOpening', visibility: 'public' },
  { user: 'charlie', passage: 'orwellOpening', visibility: 'public' },
  ...READERS.slice(0, 3).map((user): SeedHighlight => ({ user, passage: 'orwellOpening', visibility: 'public' })),
  // Below the threshold: present in the data, never in a public aggregate
  { user: 'bob', passage: 'orwellMansions', visibility: 'public', note: 'Ironic name' },
  ...READERS.slice(3, 5).map((user): SeedHighlight => ({ user, passage: 'orwellMansions', visibility: 'public' })),
  { user: 'charlie', passage: 'mockingbirdOpening', visibility: 'friends' },
  ...READERS.slice(5, 8).map((user): SeedHighlight => ({ user, passage: 'mockingbirdOpening', visibility: 'public' })),
]

/** Directed follows; alice and bob follow each other (friends), charlie follows alice only. */
const FOLLOWS: Array<[string, string]> = [
  ['alice', 'bob'],
  ['bob', 'alice'],
  ['charlie', 'alice'],
]

async function seed(): Promise<void> {
  console.log('Seeding database...')

  const userIds = new Map<string, string>()
  for (const user of USERS) {
    const passwordHash = await hashPassword('password123')
    const result = await query<{ id: string }>(
      `INSERT INTO users (email, username, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [user.email, user.username, passwordHash]
    )
    userIds.set(user.username, result.rows[0].id)

    await query(
      `INSERT INTO user_privacy_settings (user_id, highlight_visibility, allow_followers, include_in_aggregation)
       VALUES ($1, 'public', true, $2)
       ON CONFLICT (user_id) DO UPDATE SET include_in_aggregation = EXCLUDED.include_in_aggregation`,
      [result.rows[0].id, !OPTED_OUT.has(user.username)]
    )
  }
  console.log(`Users: ${USERS.length} (all with password "password123")`)

  const bookIds = new Map<BookKey, string>()
  for (const [key, book] of Object.entries(BOOKS) as Array<[BookKey, (typeof BOOKS)[BookKey]]>) {
    const existing = await query<{ id: string }>('SELECT id FROM books WHERE isbn = $1 ORDER BY created_at LIMIT 1', [
      book.isbn,
    ])
    const id =
      existing.rows[0]?.id ??
      (
        await query<{ id: string }>(
          `INSERT INTO books (title, author, isbn, description, total_locations)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [book.title, book.author, book.isbn, book.content, book.content.length]
        )
      ).rows[0].id
    bookIds.set(key, id)
  }
  console.log(`Books: ${bookIds.size}`)

  let created = 0
  let replayed = 0
  for (const h of HIGHLIGHTS) {
    const passage = PASSAGES[h.passage]
    const book = BOOKS[passage.book]
    const start = book.content.indexOf(passage.text)
    if (start < 0) throw new Error(`Seed passage not found in ${book.title}: ${passage.text}`)

    const result = await createHighlight(
      userIds.get(h.user)!,
      {
        id: uuidv5(`${h.user}:${h.passage}`, SEED_NAMESPACE),
        bookId: bookIds.get(passage.book)!,
        locationStart: start,
        locationEnd: start + passage.text.length,
        text: passage.text,
        note: h.note ?? null,
        color: h.color ?? 'yellow',
        visibility: h.visibility,
      },
      { deviceId: 'seed', clientTs: Date.now() }
    )
    if (result.status === 'created') created++
    else replayed++
  }
  console.log(`Highlights: ${created} created, ${replayed} already present`)

  for (const [follower, followee] of FOLLOWS) {
    await query('INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      userIds.get(follower),
      userIds.get(followee),
    ])
  }

  for (const userId of userIds.values()) {
    for (const bookId of bookIds.values()) {
      await query('INSERT INTO user_books (user_id, book_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, bookId])
    }
  }

  console.log('Seed complete. Run the aggregation worker (npm run dev:worker) to publish popular passages.')
  await pool.end()
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
