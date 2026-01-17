/**
 * @fileoverview Avatar component for displaying user profile images.
 * Shows image if available, otherwise displays initials on gradient background.
 */

import { getInitials, cn } from '@/utils';

/**
 * Props for the Avatar component.
 */
interface AvatarProps {
  /** URL of the avatar image (null shows initials fallback) */
  src?: string | null;
  /** User's name for alt text and initials generation */
  name: string;
  /** Size variant of the avatar */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Additional CSS classes to apply */
  className?: string;
}

/** Tailwind classes for each size variant */
const sizeClasses = {
  sm: 'w-8 h-8 text-xs',
  md: 'w-10 h-10 text-sm',
  lg: 'w-12 h-12 text-base',
  xl: 'w-16 h-16 text-xl',
};

/**
 * Displays a user avatar with image or initials fallback.
 * Used throughout the app for user representation in feeds, comments, and headers.
 *
 * @param props - Avatar props including src, name, size, and className
 * @returns JSX element rendering the avatar
 */
export function Avatar({ src, name, size = 'md', className }: AvatarProps) {
  const initials = getInitials(name);

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={cn(
          'rounded-full object-cover bg-gray-200',
          sizeClasses[size],
          className
        )}
      />
    );
  }

  return (
    <div
      className={cn(
        'rounded-full bg-gradient-to-br from-facebook-blue to-blue-600 flex items-center justify-center text-white font-semibold',
        sizeClasses[size],
        className
      )}
    >
      {initials}
    </div>
  );
}
