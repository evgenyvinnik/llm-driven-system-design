import clsx from 'clsx';
import type { App } from '../types';

interface AppCardProps {
  app: Partial<App>;
  onClick?: () => void;
  size?: 'small' | 'medium' | 'large';
}

export function AppCard({ app, onClick, size = 'medium' }: AppCardProps) {
  const iconSize = {
    small: 'w-12 h-12',
    medium: 'w-16 h-16',
    large: 'w-20 h-20',
  };

  return (
    <div
      className={clsx(
        'flex items-start gap-3 p-3 rounded-xl hover:bg-gray-50 cursor-pointer transition-colors',
        onClick && 'cursor-pointer'
      )}
      onClick={onClick}
    >
      {app.iconUrl ? (
        <img
          src={app.iconUrl}
          alt={app.name}
          className={clsx(iconSize[size], 'app-icon object-cover')}
        />
      ) : (
        <div
          className={clsx(
            iconSize[size],
            'app-icon bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-white font-bold text-xl'
          )}
        >
          {app.name?.charAt(0)}
        </div>
      )}

      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-gray-900 truncate">{app.name}</h3>
        <p className="text-sm text-gray-500 truncate">
          {app.developer?.name || 'Unknown Developer'}
        </p>

        <div className="flex items-center gap-2 mt-1">
          <StarRating rating={app.averageRating || 0} size="small" />
          <span className="text-xs text-gray-400">
            ({formatNumber(app.ratingCount || 0)})
          </span>
        </div>

        {size !== 'small' && (
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm font-medium text-primary-600">
              {app.isFree ? 'Free' : `$${app.price?.toFixed(2)}`}
            </span>
            {app.downloadCount && app.downloadCount > 0 && (
              <span className="text-xs text-gray-400">
                {formatNumber(app.downloadCount)} downloads
              </span>
            )}
          </div>
        )}
      </div>

      <button
        className="btn btn-primary text-sm py-1.5"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        Get
      </button>
    </div>
  );
}

interface StarRatingProps {
  rating: number;
  size?: 'small' | 'medium' | 'large';
  showValue?: boolean;
}

export function StarRating({ rating, size = 'medium', showValue = false }: StarRatingProps) {
  const starSize = {
    small: 'w-3 h-3',
    medium: 'w-4 h-4',
    large: 'w-5 h-5',
  };

  const fullStars = Math.floor(rating);
  const hasHalf = rating % 1 >= 0.5;
  const emptyStars = 5 - fullStars - (hasHalf ? 1 : 0);

  return (
    <div className="flex items-center gap-0.5">
      {[...Array(fullStars)].map((_, i) => (
        <svg
          key={`full-${i}`}
          className={clsx(starSize[size], 'text-yellow-400 fill-current')}
          viewBox="0 0 20 20"
        >
          <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
        </svg>
      ))}
      {hasHalf && (
        <svg className={clsx(starSize[size], 'text-yellow-400')} viewBox="0 0 20 20">
          <defs>
            <linearGradient id="half">
              <stop offset="50%" stopColor="currentColor" />
              <stop offset="50%" stopColor="#d1d5db" />
            </linearGradient>
          </defs>
          <path
            fill="url(#half)"
            d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z"
          />
        </svg>
      )}
      {[...Array(emptyStars)].map((_, i) => (
        <svg
          key={`empty-${i}`}
          className={clsx(starSize[size], 'text-gray-300 fill-current')}
          viewBox="0 0 20 20"
        >
          <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
        </svg>
      ))}
      {showValue && (
        <span className="ml-1 text-sm font-medium text-gray-700">{rating.toFixed(1)}</span>
      )}
    </div>
  );
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}
