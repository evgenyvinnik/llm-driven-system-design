import { formatAbs, cx } from '../utils';

interface BalancePillProps {
  netCents: number; // + = you are owed (green), - = you owe (orange)
  size?: 'sm' | 'md';
  /** Override the wording; defaults to "owes you" / "you owe". */
  labels?: { positive: string; negative: string; zero: string };
}

/** Colored balance chip: green when owed to you, orange when you owe, grey at zero. */
export function BalancePill({ netCents, size = 'md', labels }: BalancePillProps) {
  const l = labels || { positive: 'owes you', negative: 'you owe', zero: 'settled up' };
  const text = size === 'sm' ? 'text-xs' : 'text-sm';

  if (netCents === 0) {
    return <span className={cx('font-medium text-split-ink-soft', text)}>{l.zero}</span>;
  }

  const owed = netCents > 0;
  return (
    <span className={cx('inline-flex flex-col items-end leading-tight')}>
      <span className={cx('font-medium', text, owed ? 'text-split-green-dark' : 'text-split-owe-dark')}>
        {owed ? l.positive : l.negative}
      </span>
      <span className={cx('font-bold', size === 'sm' ? 'text-sm' : 'text-base', owed ? 'text-split-green-dark' : 'text-split-owe-dark')}>
        {formatAbs(netCents)}
      </span>
    </span>
  );
}
