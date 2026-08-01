/**
 * Paints starting artwork onto the canvas and records the matching history.
 *
 * The canvas is a Redis byte array, not a database table, so `seed.ts` (which
 * only talks to Postgres) can never put anything on it. A freshly seeded stack
 * therefore renders 250,000 white pixels — an r/place with nothing placed on
 * it, which shows none of what the project is actually about.
 *
 * This writes the whole 250 KB key in one `SET` rather than 4,000 individual
 * `SETRANGE` calls: the per-pixel path is what the *app* uses because each
 * placement must be atomic and independent, but a bulk initial paint has no
 * concurrency to protect against and one round trip is far cheaper.
 *
 * The corresponding `pixel_events` rows are inserted too, so the durable
 * history matches the live canvas — that pairing is the whole point of the
 * persistence worker, and a canvas with no history behind it would be a lie.
 *
 * Run with: npm run db:seed:canvas (or via npm run db:seed)
 */
import pg from 'pg';
import Redis from 'ioredis';
import { CANVAS_WIDTH, CANVAS_HEIGHT, CANVAS_SIZE, REDIS_KEYS } from '../config.js';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgresql://rplace:rplace_dev@localhost:5432/rplace',
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

/** Palette indices, matching COLOR_PALETTE in config.ts. */
const WHITE = 0;
const BLACK = 3;
const RED = 5;
const ORANGE = 6;
const YELLOW = 8;
const GREEN = 10;
const CYAN = 11;
const BLUE = 13;
const PURPLE = 15;

/** Sets one pixel in the buffer, ignoring anything out of bounds. */
function px(buf: Buffer, x: number, y: number, color: number): void {
  if (x < 0 || y < 0 || x >= CANVAS_WIDTH || y >= CANVAS_HEIGHT) return;
  buf[y * CANVAS_WIDTH + x] = color;
}

function rect(
  buf: Buffer,
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: number,
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) px(buf, x, y, color);
  }
}

/**
 * A 5x7 bitmap font, enough for the few letters the banner needs. Drawing text
 * pixel by pixel is the point — it's what a community actually does on r/place.
 */
const GLYPHS: Record<string, string[]> = {
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
};

function text(buf: Buffer, str: string, x0: number, y0: number, color: number): void {
  let cx = x0;
  for (const ch of str) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      glyph.forEach((row, dy) => {
        [...row].forEach((cell, dx) => {
          if (cell === '#') px(buf, cx + dx, y0 + dy, color);
        });
      });
    }
    cx += 6;
  }
}

function buildCanvas(): Buffer {
  const buf = Buffer.alloc(CANVAS_SIZE, WHITE);

  // Banner across the top of the visible area.
  text(buf, 'R/PLACE', 12, 10, RED);

  // A colour-bar, the classic "someone claimed this stripe" motif.
  const bars = [RED, ORANGE, YELLOW, GREEN, CYAN, BLUE, PURPLE];
  bars.forEach((c, i) => rect(buf, 12 + i * 14, 26, 12, 10, c));

  // A small heart, drawn from a bitmap so it reads as deliberate pixel art.
  const heart = [
    '.##.##.',
    '#######',
    '#######',
    '.#####.',
    '..###..',
    '...#...',
  ];
  heart.forEach((row, dy) =>
    [...row].forEach((cell, dx) => {
      if (cell === '#') px(buf, 120 + dx * 2, 50 + dy * 2, RED);
      if (cell === '#') px(buf, 121 + dx * 2, 50 + dy * 2, RED);
      if (cell === '#') px(buf, 120 + dx * 2, 51 + dy * 2, RED);
      if (cell === '#') px(buf, 121 + dx * 2, 51 + dy * 2, RED);
    }),
  );

  // A checkerboard block — the kind of territory-marking pattern that shows up
  // when two groups are fighting over the same region.
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      px(buf, 20 + x, 60 + y, (x + y) % 2 === 0 ? BLUE : YELLOW);
    }
  }

  // A framed block of solid colour with a black border.
  rect(buf, 60, 60, 26, 24, GREEN);
  rect(buf, 60, 60, 26, 1, BLACK);
  rect(buf, 60, 83, 26, 1, BLACK);
  rect(buf, 60, 60, 1, 24, BLACK);
  rect(buf, 85, 60, 1, 24, BLACK);

  // Scattered individual pixels, as if placed one at a time by passers-by.
  const scatter = [RED, BLUE, GREEN, YELLOW, PURPLE, ORANGE, CYAN];
  for (let i = 0; i < 400; i++) {
    // Deterministic pseudo-random placement so re-seeding is reproducible.
    const x = (i * 37 + 11) % 200;
    const y = 95 + ((i * 53 + 7) % 60);
    px(buf, x, y, scatter[i % scatter.length]);
  }

  return buf;
}

async function seedCanvas(): Promise<void> {
  const buf = buildCanvas();
  await redis.set(REDIS_KEYS.CANVAS, buf);

  // Record history for the painted pixels so Postgres agrees with Redis.
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE username = 'alice' LIMIT 1",
  );
  if (rows.length === 0) {
    console.warn('No alice user found; skipping pixel_events history.');
    console.log(`Canvas painted (${CANVAS_SIZE} bytes written).`);
    return;
  }
  const userId = rows[0].id;

  const existing = await pool.query('SELECT 1 FROM pixel_events LIMIT 1');
  if ((existing.rowCount ?? 0) > 0) {
    console.log('Canvas painted; pixel_events already present, skipping history.');
    return;
  }

  // Only the non-white pixels are "placements" — white is the untouched canvas.
  const values: string[] = [];
  const params: unknown[] = [];
  let n = 0;
  for (let i = 0; i < buf.length && n < 3000; i++) {
    if (buf[i] === WHITE) continue;
    const x = i % CANVAS_WIDTH;
    const y = Math.floor(i / CANVAS_WIDTH);
    params.push(x, y, buf[i], userId);
    values.push(
      `($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length}, NOW() - ($${params.length + 1} || ' seconds')::interval)`,
    );
    params.push(n * 7);
    n++;
  }

  if (values.length > 0) {
    // Chunked to keep each statement's parameter count well inside Postgres's
    // 65535 limit.
    const CHUNK = 500;
    for (let i = 0; i < values.length; i += CHUNK) {
      const slice = values.slice(i, i + CHUNK);
      const paramsPerRow = 5;
      const sliceParams = params.slice(i * paramsPerRow, (i + slice.length) * paramsPerRow);
      const renumbered = slice.map((_, rowIdx) => {
        const base = rowIdx * paramsPerRow;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, NOW() - ($${base + 5} || ' seconds')::interval)`;
      });
      await pool.query(
        `INSERT INTO pixel_events (x, y, color, user_id, placed_at) VALUES ${renumbered.join(', ')}`,
        sliceParams,
      );
    }
  }

  console.log(`Canvas painted (${CANVAS_SIZE} bytes) with ${n} recorded placements.`);
}

seedCanvas()
  .then(async () => {
    await pool.end();
    redis.disconnect();
  })
  .catch(async (err) => {
    console.error('Canvas seeding failed:', err);
    await pool.end();
    redis.disconnect();
    process.exit(1);
  });
