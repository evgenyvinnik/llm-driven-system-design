import { createFileRoute, Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores';
import type { GroupDetail, ExpenseListItem, GroupBalances } from '../types';
import { GroupAvatar } from '../components/GroupAvatar';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { BalancePill } from '../components/BalancePill';
import { ExpenseRow } from '../components/expense/ExpenseRow';
import { AddExpenseModal } from '../components/expense/AddExpenseModal';
import { SettleUpModal, type SettlePrefill } from '../components/expense/SettleUpModal';
import { BalancesPanel } from '../components/group/BalancesPanel';
import { PlusIcon } from '../components/icons';

function GroupDetailPage() {
  const { groupId } = Route.useParams();
  const { user } = useAuthStore();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [expenses, setExpenses] = useState<ExpenseListItem[]>([]);
  const [balances, setBalances] = useState<GroupBalances | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [settlePrefill, setSettlePrefill] = useState<SettlePrefill | null>(null);
  const [showSettle, setShowSettle] = useState(false);

  const loadData = useCallback(async () => {
    const [g, e, b] = await Promise.all([
      api.getGroup(groupId),
      api.getGroupExpenses(groupId),
      api.getGroupBalances(groupId),
    ]);
    setGroup(g);
    setExpenses(e);
    setBalances(b);
  }, [groupId]);

  useEffect(() => {
    setLoading(true);
    loadData().finally(() => setLoading(false));
  }, [loadData]);

  const refresh = () => loadData();

  const handleDelete = async (id: string) => {
    await api.deleteExpense(id);
    refresh();
  };

  const openSettle = (prefill: SettlePrefill | null) => {
    setSettlePrefill(prefill);
    setShowSettle(true);
  };

  if (loading || !group || !balances) {
    return <div className="py-16 text-center text-split-ink-soft">Loading group…</div>;
  }

  const myBalance = balances.net.find((n) => n.userId === user?.id)?.netCents ?? 0;

  return (
    <div className="max-w-4xl space-y-5">
      <Link to="/groups" className="text-sm font-medium text-split-ink-soft hover:text-split-ink">← All groups</Link>

      {/* Header */}
      <div className="card p-5">
        <div className="flex items-start gap-4">
          <GroupAvatar name={group.name} color={group.avatarColor} type={group.groupType} size="lg" />
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-extrabold text-split-ink">{group.name}</h1>
            {group.description && <p className="text-sm text-split-ink-soft">{group.description}</p>}
            <div className="flex items-center gap-1.5 mt-2">
              <div className="flex -space-x-2">
                {group.members.slice(0, 6).map((m) => (
                  <Avatar key={m.id} src={m.avatarUrl} name={m.name || m.username} size="sm" className="ring-2 ring-white" />
                ))}
              </div>
              <span className="text-xs text-split-ink-soft ml-1.5">{group.members.length} members</span>
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs text-split-ink-soft mb-0.5">Your balance</p>
            <BalancePill netCents={myBalance} labels={{ positive: 'you are owed', negative: 'you owe', zero: 'settled up' }} />
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <Button onClick={() => setShowAdd(true)} className="flex-1 sm:flex-none">
            <PlusIcon className="w-5 h-5" /> Add expense
          </Button>
          <Button variant="outline" onClick={() => openSettle(null)} className="flex-1 sm:flex-none">
            Settle up
          </Button>
        </div>
      </div>

      <div className="grid lg:grid-cols-5 gap-5 items-start">
        {/* Expenses */}
        <div className="lg:col-span-3">
          <h2 className="text-lg font-bold text-split-ink mb-2">Expenses</h2>
          {expenses.length === 0 ? (
            <div className="card p-8 text-center">
              <p className="text-3xl mb-1">🧾</p>
              <p className="font-medium text-split-ink">No expenses yet</p>
              <p className="text-sm text-split-ink-soft">Add the first one to get started.</p>
            </div>
          ) : (
            <div className="card divide-y divide-split-line overflow-hidden">
              {expenses.map((e) => (
                <ExpenseRow key={e.id} expense={e} currentUserId={user!.id} onDelete={handleDelete} />
              ))}
            </div>
          )}
        </div>

        {/* Balances / simplify */}
        <div className="lg:col-span-2 space-y-2">
          <h2 className="text-lg font-bold text-split-ink mb-2">Settle up</h2>
          <BalancesPanel
            balances={balances}
            members={group.members}
            currentUserId={user!.id}
            onSettle={(prefill) => openSettle(prefill)}
          />
        </div>
      </div>

      <AddExpenseModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        group={group}
        currentUserId={user!.id}
        onCreated={refresh}
      />
      <SettleUpModal
        key={settlePrefill ? `${settlePrefill.from}-${settlePrefill.to}-${settlePrefill.amountCents}` : 'blank'}
        open={showSettle}
        onClose={() => setShowSettle(false)}
        group={group}
        currentUserId={user!.id}
        prefill={settlePrefill}
        onSettled={refresh}
      />
    </div>
  );
}

export const Route = createFileRoute('/groups/$groupId')({
  component: GroupDetailPage,
});
