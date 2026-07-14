import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { GroupSummary } from '../types';
import { GroupAvatar } from '../components/GroupAvatar';
import { BalancePill } from '../components/BalancePill';
import { Button } from '../components/Button';
import { CreateGroupModal } from '../components/group/CreateGroupModal';
import { PlusIcon, ChevronRightIcon } from '../components/icons';

function GroupsPage() {
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();

  const load = () => {
    setLoading(true);
    api.getGroups().then(setGroups).finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-extrabold text-split-ink">Groups</h1>
        <Button onClick={() => setShowCreate(true)}>
          <PlusIcon className="w-5 h-5" /> New group
        </Button>
      </div>

      {loading ? (
        <div className="py-16 text-center text-split-ink-soft">Loading groups…</div>
      ) : groups.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-4xl mb-2">👥</p>
          <p className="font-semibold text-split-ink">No groups yet</p>
          <p className="text-sm text-split-ink-soft mb-4">Create a group to start splitting expenses.</p>
          <Button onClick={() => setShowCreate(true)} className="mx-auto">
            <PlusIcon className="w-5 h-5" /> Create your first group
          </Button>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {groups.map((g) => (
            <Link
              key={g.id}
              to="/groups/$groupId"
              params={{ groupId: g.id }}
              className="card p-4 flex items-center gap-3 hover:shadow-md hover:border-split-green/30 transition"
            >
              <GroupAvatar name={g.name} color={g.avatarColor} type={g.groupType} />
              <div className="flex-1 min-w-0">
                <p className="font-bold text-split-ink truncate">{g.name}</p>
                <p className="text-xs text-split-ink-soft">{g.memberCount} members</p>
                <div className="mt-1.5">
                  <BalancePill netCents={g.myBalanceCents} size="sm" labels={{ positive: 'you are owed', negative: 'you owe', zero: 'settled up' }} />
                </div>
              </div>
              <ChevronRightIcon className="w-5 h-5 text-split-ink-soft/50" />
            </Link>
          ))}
        </div>
      )}

      <CreateGroupModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(id) => navigate({ to: '/groups/$groupId', params: { groupId: id } })}
      />
    </div>
  );
}

export const Route = createFileRoute('/groups/')({
  component: GroupsPage,
});
