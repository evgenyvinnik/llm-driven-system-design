/** Formats a cent amount as a USD currency string (e.g., "$12.50"). */
export function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

/** Absolute value of a cent amount, formatted (drops the sign). */
export function formatAbs(cents: number): string {
  return formatCurrency(Math.abs(cents));
}

/** Formats a date string as a relative time ("5m ago", "3d ago") or short date. */
export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

/** Extracts up to two uppercase initials from a name for avatar fallbacks. */
export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .filter(Boolean)
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/** Joins CSS class names, filtering out falsy values. */
export function cx(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

/** Parses a user-entered dollar string ("12.50") into integer cents (1250). */
export function dollarsToCents(value: string): number {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

/** Tailwind classes for a group's color theme (badge background + text). */
export function groupColorClasses(color: string): { bg: string; text: string; ring: string } {
  switch (color) {
    case 'blue':
      return { bg: 'bg-blue-500', text: 'text-blue-600', ring: 'ring-blue-100' };
    case 'orange':
      return { bg: 'bg-amber-500', text: 'text-amber-600', ring: 'ring-amber-100' };
    case 'purple':
      return { bg: 'bg-violet-500', text: 'text-violet-600', ring: 'ring-violet-100' };
    case 'pink':
      return { bg: 'bg-pink-500', text: 'text-pink-600', ring: 'ring-pink-100' };
    default:
      return { bg: 'bg-split-green', text: 'text-split-green-dark', ring: 'ring-emerald-100' };
  }
}

/**
 * Distribute `total` cents across `weights` proportionally, handing leftover
 * pennies to the largest fractional remainders (largest-remainder method).
 * Mirrors the backend so the modal can preview the exact per-person cents and
 * the sum always equals the total. Returns zeros if weights sum to <= 0.
 */
export function allocateByWeights(total: number, weights: number[]): number[] {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) return weights.map(() => 0);

  const base: number[] = [];
  const remainders: { index: number; frac: number }[] = [];
  let allocated = 0;
  weights.forEach((w, i) => {
    const exact = (total * w) / sumW;
    const floor = Math.floor(exact);
    base[i] = floor;
    allocated += floor;
    remainders.push({ index: i, frac: exact - floor });
  });

  let leftover = total - allocated;
  remainders.sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; i < remainders.length && leftover > 0; i++) {
    base[remainders[i].index] += 1;
    leftover--;
  }
  return base;
}

const CATEGORY_ICONS: Record<string, string> = {
  housing: '🏠',
  utilities: '💡',
  groceries: '🛒',
  household: '🧽',
  transport: '⛽',
  entertainment: '🎟️',
  food: '🍽️',
  general: '🧾',
};

/** Emoji for an expense category (used as a lightweight leading icon). */
export function categoryEmoji(category: string): string {
  return CATEGORY_ICONS[category] || '🧾';
}
