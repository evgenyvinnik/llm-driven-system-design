import { getInitials, cx } from '../utils';

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZES = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-14 h-14 text-lg',
};

// Deterministic pastel background per name so avatars are stable & distinct.
const BG = ['bg-emerald-100 text-emerald-700', 'bg-sky-100 text-sky-700', 'bg-violet-100 text-violet-700', 'bg-amber-100 text-amber-700', 'bg-rose-100 text-rose-700', 'bg-teal-100 text-teal-700'];

function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return BG[Math.abs(hash) % BG.length];
}

/** User avatar with initials fallback and a deterministic color per name. */
export function Avatar({ src, name, size = 'md', className }: AvatarProps) {
  const initials = getInitials(name || '?');
  // dicebear SVG URLs are decorative; if they fail to load we still see initials underneath.
  return (
    <div
      className={cx(
        'relative rounded-full flex items-center justify-center font-semibold shrink-0',
        SIZES[size],
        colorFor(name),
        className
      )}
      title={name}
    >
      <span>{initials}</span>
      {src && (
        <img
          src={src}
          alt={name}
          className="absolute inset-0 w-full h-full rounded-full object-cover"
          onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
        />
      )}
    </div>
  );
}
