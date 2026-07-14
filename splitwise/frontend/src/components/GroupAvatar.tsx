import { groupColorClasses, cx } from '../utils';

interface GroupAvatarProps {
  name: string;
  color: string;
  type?: string;
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = { sm: 'w-9 h-9 text-base', md: 'w-12 h-12 text-xl', lg: 'w-16 h-16 text-2xl' };
const TYPE_EMOJI: Record<string, string> = { home: '🏠', trip: '✈️', couple: '❤️', other: '👥' };

/** Rounded-square group avatar tinted with the group's color and a type emoji. */
export function GroupAvatar({ name, color, type = 'other', size = 'md' }: GroupAvatarProps) {
  const { bg } = groupColorClasses(color);
  return (
    <div className={cx('rounded-2xl flex items-center justify-center text-white shrink-0', bg, SIZES[size])} title={name}>
      <span>{TYPE_EMOJI[type] || '👥'}</span>
    </div>
  );
}
