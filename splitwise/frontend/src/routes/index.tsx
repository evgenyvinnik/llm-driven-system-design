import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores';
import type { DashboardSummary, GroupSummary, ActivityItem } from '../types';
import { Avatar } from '../components/Avatar';
import { GroupAvatar } from '../components/GroupAvatar';
import { BalancePill } from '../components/BalancePill';
import { formatAbs, formatCurrency, formatDate, cx } from '../utils';
import { ChevronRightIcon } from '../components/icons';

function StatCard({ label, cents, tone }: { label: string; cents: number; tone: 'owed' | 'owe' | 'net' }) {
  const color =
    tone === 'owed' ? 'text-split-green-dark' :
    tone === 'owe' ? 'text-split-owe-dark' :
    cents >= 0 ? 'text-split-green-dark' : 'text-split-owe-dark';
  return (
    <div className="card p-4">
      <p className="text-xs font-medium text-split-ink-soft uppercase tracking-wide">{label}</p>
      <p className={cx('text-2xl font-extrabold mt-1 tabular-nums', color)}>
        {tone === 'net' && cents < 0 ? '-' : ''}{formatAbs(cents)}
      </p>
    </div>
  );
}

function DashboardPage() {
  const { user } = useAuthStore();
  const [dash, setDash] = useState<DashboardSummary | null>(null);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.getDashboard(), api.getGroups(), api.getActivity()])
      .then(([d, g, a]) => {
        setDash(d);
        setGroups(g);
        setActivity(a.slice(0, 6));
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="py-16 text-center text-split-ink-soft">Loading your dashboard…</div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-extrabold text-split-ink">Hi, {(user?.name || user?.username || '').split(' ')[0]} 👋</h1>
        <p className="text-split-ink-soft">Here's where your money stands.</p>
      </div>

      {/* Headline stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="You are owed" cents={dash?.totalOwedCents || 0} tone="owed" />
        <StatCard label="You owe" cents={dash?.totalOweCents || 0} tone="owe" />
        <StatCard label="Net balance" cents={dash?.netCents || 0} tone="net" />
      </div>

      {/* Groups */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-bold text-split-ink">Your groups</h2>
          <Link to="/groups" className="text-sm font-semibold text-split-green-dark hover:underline">See all</Link>
        </div>
        <div className="card divide-y divide-split-line overflow-hidden">
          {groups.length === 0 && (
            <p className="px-4 py-6 text-center text-split-ink-soft text-sm">No groups yet.</p>
          )}
          {groups.slice(0, 4).map((g) => (
            <Link
              key={g.id}
              to="/groups/$groupId"
              params={{ groupId: g.id }}
              className="flex items-center gap-3 px-4 py-3 hover:bg-split-bg transition"
            >
              <GroupAvatar name={g.name} color={g.avatarColor} type={g.groupType} size="sm" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-split-ink truncate">{g.name}</p>
                <p className="text-xs text-split-ink-soft">{g.memberCount} members</p>
              </div>
              <BalancePill netCents={g.myBalanceCents} size="sm" labels={{ positive: 'you are owed', negative: 'you owe', zero: 'settled up' }} />
              <ChevronRightIcon className="w-5 h-5 text-split-ink-soft/50" />
            </Link>
          ))}
        </div>
      </section>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Friends */}
        <section>
          <h2 className="text-lg font-bold text-split-ink mb-2">Friends</h2>
          <div className="card divide-y divide-split-line overflow-hidden">
            {dash && dash.friends.length === 0 && (
              <p className="px-4 py-6 text-center text-split-ink-soft text-sm">No balances with friends.</p>
            )}
            {dash?.friends.map((f) => (
              <div key={f.userId} className="flex items-center gap-3 px-4 py-3">
                <Avatar src={f.avatarUrl} name={f.name} size="sm" />
                <span className="flex-1 font-medium text-split-ink truncate">{f.name}</span>
                <span className={cx('text-sm font-semibold text-right', f.netCents > 0 ? 'text-split-green-dark' : 'text-split-owe-dark')}>
                  {f.netCents > 0 ? 'owes you ' : 'you owe '}{formatAbs(f.netCents)}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Recent activity */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-bold text-split-ink">Recent activity</h2>
            <Link to="/activity" className="text-sm font-semibold text-split-green-dark hover:underline">See all</Link>
          </div>
          <div className="card divide-y divide-split-line overflow-hidden">
            {activity.length === 0 && (
              <p className="px-4 py-6 text-center text-split-ink-soft text-sm">No activity yet.</p>
            )}
            {activity.map((a) => (
              <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                <Avatar src={a.actorAvatar} name={a.actorName || '?'} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-split-ink leading-snug">{a.summary}</p>
                  <p className="text-xs text-split-ink-soft mt-0.5">
                    {a.groupName} · {formatDate(a.createdAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <p className="text-center text-xs text-split-ink-soft pb-4">
        Total across all groups · {formatCurrency((dash?.totalOwedCents || 0) + (dash?.totalOweCents || 0))} in motion
      </p>
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: DashboardPage,
});
