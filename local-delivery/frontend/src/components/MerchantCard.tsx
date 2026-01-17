import type { Merchant } from '@/types';
import { Link } from '@tanstack/react-router';

interface MerchantCardProps {
  merchant: Merchant;
}

export function MerchantCard({ merchant }: MerchantCardProps) {
  return (
    <Link
      to="/merchants/$merchantId"
      params={{ merchantId: merchant.id }}
      className="card hover:shadow-md transition-shadow"
    >
      <div className="p-4">
        <div className="flex justify-between items-start mb-2">
          <h3 className="font-semibold text-lg text-gray-900">{merchant.name}</h3>
          <div className="flex items-center gap-1 text-sm">
            <span>⭐</span>
            <span>{merchant.rating.toFixed(1)}</span>
          </div>
        </div>

        <p className="text-sm text-gray-600 mb-2">{merchant.category}</p>

        {merchant.description && (
          <p className="text-sm text-gray-500 mb-3 line-clamp-2">
            {merchant.description}
          </p>
        )}

        <div className="flex items-center gap-4 text-sm text-gray-500">
          <span>🕐 {merchant.avg_prep_time_minutes} min</span>
          {merchant.distance !== undefined && (
            <span>📍 {merchant.distance.toFixed(1)} km</span>
          )}
        </div>

        {!merchant.is_open && (
          <div className="mt-2 text-sm text-red-600 font-medium">
            Currently closed
          </div>
        )}
      </div>
    </Link>
  );
}
