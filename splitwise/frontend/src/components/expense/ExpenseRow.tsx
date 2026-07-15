import type { ExpenseListItem } from '../../types';
import { formatCurrency, formatAbs, formatDate, categoryEmoji, cx } from '../../utils';
import { TrashIcon } from '../icons';

interface ExpenseRowProps {
  expense: ExpenseListItem;
  currentUserId: string;
  onDelete: (id: string) => void;
}

const SPLIT_LABEL: Record<string, string> = {
  equal: 'split equally',
  exact: 'split by exact amounts',
  percentage: 'split by percentage',
  shares: 'split by shares',
};

/** One expense in the group ledger: category, payer, amount, and your net for it. */
export function ExpenseRow({ expense, currentUserId, onDelete }: ExpenseRowProps) {
  const iPaid = expense.paidBy === currentUserId;
  const net = expense.myNetCents;

  return (
    <div className="group flex items-center gap-3 px-4 py-3 hover:bg-split-bg transition">
      <div className="w-10 h-10 rounded-xl bg-split-bg flex items-center justify-center text-lg shrink-0">
        {categoryEmoji(expense.category)}
      </div>

      <div className="flex-1 min-w-0">
        <p className="font-semibold text-split-ink truncate">{expense.description}</p>
        <p className="text-xs text-split-ink-soft truncate">
          {iPaid ? 'You' : expense.payerName || expense.payerUsername} paid {formatCurrency(expense.amountCents)}
          <span className="hidden sm:inline"> · {SPLIT_LABEL[expense.splitType]}</span>
          {' · '}{formatDate(expense.createdAt)}
        </p>
      </div>

      <div className="text-right shrink-0">
        {net === 0 ? (
          <span className="text-xs text-split-ink-soft">not involved</span>
        ) : (
          <>
            <p className={cx('text-xs font-medium', net > 0 ? 'text-split-green-dark' : 'text-split-owe-dark')}>
              {net > 0 ? 'you lent' : 'you borrowed'}
            </p>
            <p className={cx('text-sm font-bold tabular-nums', net > 0 ? 'text-split-green-dark' : 'text-split-owe-dark')}>
              {formatAbs(net)}
            </p>
          </>
        )}
      </div>

      <button
        onClick={() => onDelete(expense.id)}
        className="text-split-ink-soft/40 hover:text-split-owe-dark p-1 rounded-lg opacity-0 group-hover:opacity-100 transition"
        title="Delete expense"
      >
        <TrashIcon className="w-4 h-4" />
      </button>
    </div>
  );
}
