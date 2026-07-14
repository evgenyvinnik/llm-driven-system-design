import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { ActivityItem } from '../types';
import { Avatar } from '../components/Avatar';
import { GroupAvatar } from '../components/GroupAvatar';
import { formatDate } from '../utils';

const TYPE_EMOJI: Record<string, string> = {
  expense_added: '🧾',
  expense_deleted: '🗑️',
  settlement: '💸',
  group_created: '✨',
  member_added: '👋',
};

function ActivityPage() {
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getActivity().then(setActivity).finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-2xl space-y-5">
      <h1 className="text-2xl font-extrabold text-split-ink">Activity</h1>

      {loading ? (
        <div className="py-16 text-center text-split-ink-soft">Loading activity…</div>
      ) : activity.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-4xl mb-2">📭</p>
          <p className="font-semibold text-split-ink">No activity yet</p>
          <p className="text-sm text-split-ink-soft">Expenses and payments will show up here.</p>
        </div>
      ) : (
        <div className="card divide-y divide-split-line overflow-hidden">
          {activity.map((a) => (
            <Link
              key={a.id}
              to="/groups/$groupId"
              params={{ groupId: a.groupId || '' }}
              className="flex items-center gap-3 px-4 py-3.5 hover:bg-split-bg transition"
            >
              <div className="relative">
                <Avatar src={a.actorAvatar} name={a.actorName || '?'} size="md" />
                <span className="absolute -bottom-1 -right-1 text-sm">{TYPE_EMOJI[a.type] || '•'}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-split-ink leading-snug">{a.summary}</p>
                <p className="text-xs text-split-ink-soft mt-0.5">{formatDate(a.createdAt)}</p>
              </div>
              {a.groupName && a.avatarColor && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <GroupAvatar name={a.groupName} color={a.avatarColor} size="sm" />
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/activity')({
  component: ActivityPage,
});
