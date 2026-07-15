/**
 * Balance computation + debt simplification
 *
 * Balances are never stored — they are derived from the immutable log of
 * expenses and settlements. This is deliberate: a stored running balance can
 * drift out of sync with the underlying rows after an edit or a bug, and then
 * you can never tell which number is the lie. Deriving on read is always
 * correct; we make it cheap with a short-lived Redis cache that is invalidated
 * on every write to the group.
 *
 * Sign convention (used everywhere): a POSITIVE balance means the user is owed
 * money (a creditor); NEGATIVE means the user owes money (a debtor). Within any
 * group, all net balances sum to exactly zero (money is conserved).
 */

import { pool } from '../db/pool.js';
import {
  getCachedGroupBalance,
  setCachedGroupBalance,
} from '../db/redis.js';
import {
  balanceCacheHits,
  balanceCacheMisses,
  debtSimplifyDuration,
} from '../shared/metrics.js';

export interface MemberNetBalance {
  userId: string;
  name: string | null;
  username: string;
  avatarUrl: string | null;
  netCents: number; // + = owed to them, - = they owe
}

export interface SimplifiedTransfer {
  from: string; // debtor userId
  to: string; // creditor userId
  amountCents: number;
}

export interface GroupBalances {
  net: MemberNetBalance[];
  simplified: SimplifiedTransfer[];
}

/**
 * Debt simplification via greedy min-cash-flow.
 *
 * Given each person's net balance, produce a minimal set of transfers that
 * settles everyone to zero. The greedy strategy: repeatedly take the person who
 * is owed the most (max creditor) and the person who owes the most (max debtor)
 * and settle the smaller of the two amounts between them. Each step zeroes out
 * at least one person, so the result has at most n-1 transfers — versus up to
 * n(n-1)/2 raw pairwise IOUs. This is why "Simplify debts" can turn a tangle of
 * 15 little IOUs among 6 roommates into 5 clean payments.
 *
 * Finding the true global minimum number of transfers is NP-hard (it is a
 * partition problem), but greedy is optimal in the common case and always
 * within a small factor otherwise — the right trade-off for a UI that must feel
 * instant. Integer cents + conservation (Σ net = 0) guarantee termination.
 */
export function simplifyDebts(
  balances: { userId: string; netCents: number }[]
): SimplifiedTransfer[] {
  const end = debtSimplifyDuration.startTimer();

  // Work on copies so we don't mutate the caller's data.
  const creditors = balances
    .filter((b) => b.netCents > 0)
    .map((b) => ({ ...b }));
  const debtors = balances
    .filter((b) => b.netCents < 0)
    .map((b) => ({ userId: b.userId, netCents: -b.netCents })); // store owed as positive

  const transfers: SimplifiedTransfer[] = [];

  // Max-heaps are overkill for group sizes; re-sort each pass (n is tiny).
  while (creditors.length > 0 && debtors.length > 0) {
    creditors.sort((a, b) => b.netCents - a.netCents);
    debtors.sort((a, b) => b.netCents - a.netCents);

    const creditor = creditors[0];
    const debtor = debtors[0];
    const amount = Math.min(creditor.netCents, debtor.netCents);

    transfers.push({ from: debtor.userId, to: creditor.userId, amountCents: amount });

    creditor.netCents -= amount;
    debtor.netCents -= amount;

    if (creditor.netCents === 0) creditors.shift();
    if (debtor.netCents === 0) debtors.shift();
  }

  end();
  return transfers;
}

/**
 * Compute net balances for every member of a group, plus the simplified set of
 * transfers to settle up. Reads the immutable expense/settlement log; caches
 * the result in Redis (invalidated on write).
 */
export async function computeGroupBalances(groupId: string): Promise<GroupBalances> {
  const cached = await getCachedGroupBalance<GroupBalances>(groupId);
  if (cached) {
    balanceCacheHits.inc();
    return cached;
  }
  balanceCacheMisses.inc();

  // All members start at net 0 so someone with no activity still appears.
  const membersRes = await pool.query<{
    user_id: string;
    name: string | null;
    username: string;
    avatar_url: string | null;
  }>(
    `SELECT gm.user_id, u.name, u.username, u.avatar_url
     FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = $1`,
    [groupId]
  );

  const net = new Map<string, number>();
  const meta = new Map<string, { name: string | null; username: string; avatarUrl: string | null }>();
  for (const m of membersRes.rows) {
    net.set(m.user_id, 0);
    meta.set(m.user_id, { name: m.name, username: m.username, avatarUrl: m.avatar_url });
  }

  // Money each member fronted (as payer).
  const paidRes = await pool.query<{ paid_by: string; total: string }>(
    `SELECT paid_by, SUM(amount_cents) AS total
     FROM expenses WHERE group_id = $1 AND deleted_at IS NULL GROUP BY paid_by`,
    [groupId]
  );
  for (const r of paidRes.rows) net.set(r.paid_by, (net.get(r.paid_by) || 0) + Number(r.total));

  // Money each member owes (as split participant).
  const owedRes = await pool.query<{ user_id: string; total: string }>(
    `SELECT s.user_id, SUM(s.owed_cents) AS total
     FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
     WHERE e.group_id = $1 AND e.deleted_at IS NULL GROUP BY s.user_id`,
    [groupId]
  );
  for (const r of owedRes.rows) net.set(r.user_id, (net.get(r.user_id) || 0) - Number(r.total));

  // Settlements: payer (from) moves toward zero (+), receiver (to) moves down (-).
  const settleRes = await pool.query<{ from_user: string; to_user: string; total: string }>(
    `SELECT from_user, to_user, SUM(amount_cents) AS total
     FROM settlements WHERE group_id = $1 GROUP BY from_user, to_user`,
    [groupId]
  );
  for (const r of settleRes.rows) {
    net.set(r.from_user, (net.get(r.from_user) || 0) + Number(r.total));
    net.set(r.to_user, (net.get(r.to_user) || 0) - Number(r.total));
  }

  const netList: MemberNetBalance[] = [...net.entries()].map(([userId, netCents]) => ({
    userId,
    netCents,
    name: meta.get(userId)?.name ?? null,
    username: meta.get(userId)?.username ?? '',
    avatarUrl: meta.get(userId)?.avatarUrl ?? null,
  }));

  const simplified = simplifyDebts(netList.map((n) => ({ userId: n.userId, netCents: n.netCents })));

  const result: GroupBalances = { net: netList, simplified };
  await setCachedGroupBalance(groupId, result);
  return result;
}

/** Per-group net balance for a single user (used to badge the groups list). */
export async function computeMyGroupBalances(userId: string): Promise<Map<string, number>> {
  const net = new Map<string, number>();
  const add = (groupId: string | null, delta: number) => {
    if (!groupId) return;
    net.set(groupId, (net.get(groupId) || 0) + delta);
  };

  const paid = await pool.query<{ group_id: string; total: string }>(
    `SELECT group_id, SUM(amount_cents) AS total
     FROM expenses WHERE paid_by = $1 AND deleted_at IS NULL GROUP BY group_id`,
    [userId]
  );
  for (const r of paid.rows) add(r.group_id, Number(r.total));

  const owed = await pool.query<{ group_id: string; total: string }>(
    `SELECT e.group_id, SUM(s.owed_cents) AS total
     FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
     WHERE s.user_id = $1 AND e.deleted_at IS NULL GROUP BY e.group_id`,
    [userId]
  );
  for (const r of owed.rows) add(r.group_id, -Number(r.total));

  const fromMe = await pool.query<{ group_id: string; total: string }>(
    `SELECT group_id, SUM(amount_cents) AS total FROM settlements WHERE from_user = $1 GROUP BY group_id`,
    [userId]
  );
  for (const r of fromMe.rows) add(r.group_id, Number(r.total));

  const toMe = await pool.query<{ group_id: string; total: string }>(
    `SELECT group_id, SUM(amount_cents) AS total FROM settlements WHERE to_user = $1 GROUP BY group_id`,
    [userId]
  );
  for (const r of toMe.rows) add(r.group_id, -Number(r.total));

  return net;
}

export interface FriendBalance {
  userId: string;
  name: string | null;
  username: string;
  avatarUrl: string | null;
  netCents: number; // + = they owe me, - = I owe them
}

/**
 * Overall pairwise balance between `userId` and everyone they share expenses or
 * settlements with, across all groups. Uses the payer-centric IOU model: for an
 * expense paid by P, each other participant owes P their share. Positive result
 * means the friend owes me.
 */
export async function computeFriendBalances(userId: string): Promise<FriendBalance[]> {
  const net = new Map<string, number>();
  const add = (other: string, delta: number) => net.set(other, (net.get(other) || 0) + delta);

  // Expenses I paid → others owe me their share.
  const theyOwe = await pool.query<{ other: string; total: string }>(
    `SELECT s.user_id AS other, SUM(s.owed_cents) AS total
     FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
     WHERE e.paid_by = $1 AND e.deleted_at IS NULL AND s.user_id <> $1
     GROUP BY s.user_id`,
    [userId]
  );
  for (const r of theyOwe.rows) add(r.other, Number(r.total));

  // Expenses others paid where I participate → I owe them my share.
  const iOwe = await pool.query<{ other: string; total: string }>(
    `SELECT e.paid_by AS other, SUM(s.owed_cents) AS total
     FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
     WHERE s.user_id = $1 AND e.paid_by <> $1 AND e.deleted_at IS NULL
     GROUP BY e.paid_by`,
    [userId]
  );
  for (const r of iOwe.rows) add(r.other, -Number(r.total));

  // Settlements I paid → I reduced what I owe them.
  const paidThem = await pool.query<{ other: string; total: string }>(
    `SELECT to_user AS other, SUM(amount_cents) AS total FROM settlements WHERE from_user = $1 GROUP BY to_user`,
    [userId]
  );
  for (const r of paidThem.rows) add(r.other, Number(r.total));

  // Settlements they paid me → they reduced what they owe me.
  const theyPaid = await pool.query<{ other: string; total: string }>(
    `SELECT from_user AS other, SUM(amount_cents) AS total FROM settlements WHERE to_user = $1 GROUP BY from_user`,
    [userId]
  );
  for (const r of theyPaid.rows) add(r.other, -Number(r.total));

  const others = [...net.keys()].filter((id) => net.get(id) !== 0);
  if (others.length === 0) return [];

  const info = await pool.query<{
    id: string;
    name: string | null;
    username: string;
    avatar_url: string | null;
  }>(
    `SELECT id, name, username, avatar_url FROM users WHERE id = ANY($1::uuid[])`,
    [others]
  );

  return info.rows
    .map((u) => ({
      userId: u.id,
      name: u.name,
      username: u.username,
      avatarUrl: u.avatar_url,
      netCents: net.get(u.id) || 0,
    }))
    .sort((a, b) => Math.abs(b.netCents) - Math.abs(a.netCents));
}
