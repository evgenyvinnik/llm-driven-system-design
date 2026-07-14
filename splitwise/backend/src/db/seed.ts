/**
 * Seed script — populates a realistic demo dataset.
 * Usage: npm run seed   (run AFTER npm run db:migrate)
 *
 * Login with any seeded user, e.g. alice@example.com / password123.
 *
 * The data is designed so the primary demo user (alice) both owes money and is
 * owed money across several groups, so the dashboard shows green (owed to you)
 * and orange (you owe) balances, and "Simplify debts" has something to simplify.
 */
import bcrypt from 'bcryptjs';
import { pool, transaction } from './pool.js';
import { calculateSplits, type SplitType, type ParticipantInput } from '../services/splits.js';
import { formatAmount } from '../shared/logger.js';

interface SeedUser {
  key: string;
  username: string;
  email: string;
  name: string;
}

const USERS: SeedUser[] = [
  { key: 'alice', username: 'alice', email: 'alice@example.com', name: 'Alice Chen' },
  { key: 'bob', username: 'bob', email: 'bob@example.com', name: 'Bob Martinez' },
  { key: 'carol', username: 'carol', email: 'carol@example.com', name: 'Carol Nguyen' },
  { key: 'dave', username: 'dave', email: 'dave@example.com', name: 'Dave Patel' },
  { key: 'emma', username: 'emma', email: 'emma@example.com', name: 'Emma Johnson' },
];

async function seed(): Promise<void> {
  console.log('Clearing existing data...');
  await pool.query(
    `TRUNCATE users, groups, group_members, expenses, expense_splits,
     expense_comments, settlements, activity_log, audit_log RESTART IDENTITY CASCADE`
  );

  console.log('Seeding users...');
  const passwordHash = await bcrypt.hash('password123', 10);
  const userId: Record<string, string> = {};
  for (const u of USERS) {
    const avatar = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(u.name)}`;
    const res = await pool.query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, name, avatar_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [u.username, u.email, passwordHash, u.name, avatar]
    );
    userId[u.key] = res.rows[0].id;
  }

  // Helper: create a group with members. First member is admin.
  // A fixed id keeps demo/screenshot deep-links stable across re-seeds.
  async function createGroup(
    id: string,
    name: string,
    description: string,
    groupType: string,
    avatarColor: string,
    memberKeys: string[]
  ): Promise<string> {
    const gRes = await pool.query<{ id: string }>(
      `INSERT INTO groups (id, name, description, group_type, avatar_color, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [id, name, description, groupType, avatarColor, userId[memberKeys[0]]]
    );
    const gId = gRes.rows[0].id;
    for (let i = 0; i < memberKeys.length; i++) {
      await pool.query(
        `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)`,
        [gId, userId[memberKeys[i]], i === 0 ? 'admin' : 'member']
      );
    }
    await pool.query(
      `INSERT INTO activity_log (group_id, actor_id, type, summary, created_at)
       VALUES ($1, $2, 'group_created', $3, NOW() - INTERVAL '30 days')`,
      [gId, userId[memberKeys[0]], `${USERS.find((u) => u.key === memberKeys[0])!.name} created the group "${name}"`]
    );
    return gId;
  }

  // Helper: create an expense with computed splits + an activity entry.
  async function addExpense(
    groupId: string,
    description: string,
    amountCents: number,
    payerKey: string,
    splitType: SplitType,
    participants: { key: string; amountCents?: number; percentage?: number; shares?: number }[],
    category: string,
    daysAgo: number
  ): Promise<void> {
    const inputs: ParticipantInput[] = participants.map((p) => ({
      userId: userId[p.key],
      amountCents: p.amountCents,
      percentage: p.percentage,
      shares: p.shares,
    }));
    const splits = calculateSplits(amountCents, splitType, inputs);

    await transaction(async (client) => {
      const eRes = await client.query<{ id: string }>(
        `INSERT INTO expenses (group_id, description, amount_cents, category, paid_by, split_type, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $5, NOW() - ($7 || ' days')::INTERVAL) RETURNING id`,
        [groupId, description, amountCents, category, userId[payerKey], splitType, String(daysAgo)]
      );
      const eId = eRes.rows[0].id;
      for (const s of splits) {
        await client.query(
          `INSERT INTO expense_splits (expense_id, user_id, owed_cents, share_units, percentage)
           VALUES ($1, $2, $3, $4, $5)`,
          [eId, s.userId, s.owedCents, s.shareUnits, s.percentage]
        );
      }
      await client.query(
        `INSERT INTO activity_log (group_id, actor_id, type, expense_id, summary, created_at)
         VALUES ($1, $2, 'expense_added', $3, $4, NOW() - ($5 || ' days')::INTERVAL)`,
        [groupId, userId[payerKey], eId, `${USERS.find((u) => u.key === payerKey)!.name} paid ${formatAmount(amountCents)} for "${description}"`, String(daysAgo)]
      );
    });
  }

  async function addSettlement(
    groupId: string,
    fromKey: string,
    toKey: string,
    amountCents: number,
    daysAgo: number
  ): Promise<void> {
    const sRes = await pool.query<{ id: string }>(
      `INSERT INTO settlements (group_id, from_user, to_user, amount_cents, method, created_by, created_at)
       VALUES ($1, $2, $3, $4, 'bank', $2, NOW() - ($5 || ' days')::INTERVAL) RETURNING id`,
      [groupId, userId[fromKey], userId[toKey], amountCents, String(daysAgo)]
    );
    await pool.query(
      `INSERT INTO activity_log (group_id, actor_id, type, settlement_id, summary, created_at)
       VALUES ($1, $2, 'settlement', $3, $4, NOW() - ($5 || ' days')::INTERVAL)`,
      [groupId, userId[fromKey], sRes.rows[0].id,
        `${USERS.find((u) => u.key === fromKey)!.name} paid ${USERS.find((u) => u.key === toKey)!.name} ${formatAmount(amountCents)}`, String(daysAgo)]
    );
  }

  console.log('Seeding groups and expenses...');

  // --- Group 1: Roommates (home) — alice, bob, carol ---
  const roommates = await createGroup('11111111-1111-1111-1111-111111111111', 'Roommates', '2BR apartment on Oak Street', 'home', 'green', ['alice', 'bob', 'carol']);
  await addExpense(roommates, 'March rent', 240000, 'alice', 'equal', [{ key: 'alice' }, { key: 'bob' }, { key: 'carol' }], 'housing', 28);
  await addExpense(roommates, 'Internet & utilities', 9000, 'bob', 'equal', [{ key: 'alice' }, { key: 'bob' }, { key: 'carol' }], 'utilities', 24);
  await addExpense(roommates, 'Costco groceries', 15450, 'carol', 'equal', [{ key: 'alice' }, { key: 'bob' }, { key: 'carol' }], 'groceries', 18);
  await addExpense(roommates, 'Cleaning supplies', 4200, 'alice', 'equal', [{ key: 'alice' }, { key: 'bob' }, { key: 'carol' }], 'household', 12);
  await addSettlement(roommates, 'bob', 'alice', 50000, 10);

  // --- Group 2: Tahoe Trip (trip) — alice, bob, dave, emma ---
  const tahoe = await createGroup('22222222-2222-2222-2222-222222222222', 'Tahoe Trip', 'Ski weekend, President\'s Day', 'trip', 'blue', ['dave', 'alice', 'bob', 'emma']);
  await addExpense(tahoe, 'Cabin (2 nights)', 84000, 'dave', 'equal', [{ key: 'alice' }, { key: 'bob' }, { key: 'dave' }, { key: 'emma' }], 'housing', 20);
  // Shares: Dave drove, took the big room — pays 2 shares; others 1 each.
  await addExpense(tahoe, 'Gas & road snacks', 16000, 'alice', 'shares', [
    { key: 'alice', shares: 1 }, { key: 'bob', shares: 1 }, { key: 'dave', shares: 2 }, { key: 'emma', shares: 1 },
  ], 'transport', 20);
  // Exact: Emma & Bob skied, Alice & Dave snowboarded (rentals differ).
  await addExpense(tahoe, 'Lift tickets & rentals', 52000, 'emma', 'exact', [
    { key: 'alice', amountCents: 14000 }, { key: 'bob', amountCents: 12000 }, { key: 'dave', amountCents: 14000 }, { key: 'emma', amountCents: 12000 },
  ], 'entertainment', 19);
  // Percentage: group dinner, Dave had the steak & wine.
  await addExpense(tahoe, 'Group dinner', 21000, 'bob', 'percentage', [
    { key: 'alice', percentage: 25 }, { key: 'bob', percentage: 25 }, { key: 'dave', percentage: 35 }, { key: 'emma', percentage: 15 },
  ], 'food', 18);

  // --- Group 3: Friday Lunch Crew (other) — alice, carol, emma ---
  const lunch = await createGroup('33333333-3333-3333-3333-333333333333', 'Friday Lunch Crew', 'Weekly team lunch', 'other', 'orange', ['emma', 'alice', 'carol']);
  await addExpense(lunch, 'Thai place', 6600, 'emma', 'equal', [{ key: 'alice' }, { key: 'carol' }, { key: 'emma' }], 'food', 9);
  await addExpense(lunch, 'Ramen', 5400, 'alice', 'equal', [{ key: 'alice' }, { key: 'carol' }, { key: 'emma' }], 'food', 2);

  // A couple of comments for the expense-detail view.
  const someExpense = await pool.query<{ id: string }>(
    `SELECT id FROM expenses WHERE description = 'Group dinner' LIMIT 1`
  );
  if (someExpense.rows[0]) {
    await pool.query(
      `INSERT INTO expense_comments (expense_id, user_id, content, created_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '17 days'), ($1, $4, $5, NOW() - INTERVAL '17 days')`,
      [someExpense.rows[0].id, userId['alice'], 'That wine was worth it 🍷', userId['dave'], 'Agreed, next round on me']
    );
  }

  console.log('\nSeed complete. Demo logins (password: password123):');
  for (const u of USERS) console.log(`  ${u.email}  (${u.name})`);
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
