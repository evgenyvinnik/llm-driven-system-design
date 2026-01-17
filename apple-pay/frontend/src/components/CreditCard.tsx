import type { Card } from '../types';

interface CreditCardProps {
  card: Card;
  onClick?: () => void;
  showActions?: boolean;
  onSuspend?: () => void;
  onReactivate?: () => void;
  onRemove?: () => void;
  onSetDefault?: () => void;
}

const networkColors = {
  visa: 'from-blue-800 to-blue-600',
  mastercard: 'from-red-600 to-orange-500',
  amex: 'from-blue-500 to-cyan-400',
};

const networkLogos = {
  visa: 'VISA',
  mastercard: 'MC',
  amex: 'AMEX',
};

export function CreditCard({
  card,
  onClick,
  showActions,
  onSuspend,
  onReactivate,
  onRemove,
  onSetDefault,
}: CreditCardProps) {
  const isSuspended = card.status === 'suspended';

  return (
    <div className="space-y-2">
      <div
        className={`credit-card w-full max-w-sm cursor-pointer ${isSuspended ? 'opacity-60' : ''}`}
        onClick={onClick}
      >
        <div
          className={`credit-card-inner w-full h-full bg-gradient-to-br ${networkColors[card.network]} rounded-2xl p-6 text-white shadow-card relative overflow-hidden`}
        >
          {/* Background pattern */}
          <div className="absolute inset-0 opacity-10">
            <div className="absolute top-0 right-0 w-32 h-32 rounded-full bg-white transform translate-x-16 -translate-y-16" />
            <div className="absolute bottom-0 left-0 w-24 h-24 rounded-full bg-white transform -translate-x-12 translate-y-12" />
          </div>

          {/* Card content */}
          <div className="relative h-full flex flex-col justify-between">
            {/* Top row */}
            <div className="flex justify-between items-start">
              <div className="text-xs uppercase tracking-wider opacity-80">
                {card.card_type}
              </div>
              <div className="text-lg font-bold">{networkLogos[card.network]}</div>
            </div>

            {/* Chip */}
            <div className="w-12 h-9 bg-yellow-300/80 rounded-md flex items-center justify-center mt-4">
              <div className="w-8 h-6 bg-yellow-400/60 rounded-sm" />
            </div>

            {/* Card number */}
            <div className="text-xl tracking-widest font-mono mt-4">
              **** **** **** {card.last4}
            </div>

            {/* Bottom row */}
            <div className="flex justify-between items-end mt-4">
              <div>
                <div className="text-xs opacity-70 uppercase">Card Holder</div>
                <div className="font-medium truncate max-w-40">
                  {card.card_holder_name}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs opacity-70 uppercase">Expires</div>
                <div className="font-medium">
                  {card.expiry_month.toString().padStart(2, '0')}/{card.expiry_year.toString().slice(-2)}
                </div>
              </div>
            </div>

            {/* Status badges */}
            {(card.is_default || isSuspended) && (
              <div className="absolute top-6 right-6 flex gap-2">
                {card.is_default && (
                  <span className="text-xs bg-white/20 px-2 py-1 rounded-full">
                    Default
                  </span>
                )}
                {isSuspended && (
                  <span className="text-xs bg-red-500/80 px-2 py-1 rounded-full">
                    Suspended
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Device info */}
      {card.device_name && (
        <div className="text-sm text-apple-gray-500 text-center">
          On {card.device_name}
        </div>
      )}

      {/* Actions */}
      {showActions && (
        <div className="flex gap-2 justify-center mt-2">
          {isSuspended ? (
            <button
              onClick={onReactivate}
              className="text-sm text-apple-green hover:underline"
            >
              Reactivate
            </button>
          ) : (
            <>
              {!card.is_default && (
                <button
                  onClick={onSetDefault}
                  className="text-sm text-apple-blue hover:underline"
                >
                  Set Default
                </button>
              )}
              <button
                onClick={onSuspend}
                className="text-sm text-apple-orange hover:underline"
              >
                Suspend
              </button>
            </>
          )}
          <button
            onClick={onRemove}
            className="text-sm text-apple-red hover:underline"
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

export function CreditCardSkeleton() {
  return (
    <div className="credit-card w-full max-w-sm">
      <div className="w-full h-full bg-apple-gray-200 rounded-2xl p-6 shimmer">
        <div className="h-4 w-16 bg-apple-gray-300 rounded mb-4" />
        <div className="w-12 h-9 bg-apple-gray-300 rounded-md mt-4" />
        <div className="h-6 w-48 bg-apple-gray-300 rounded mt-4" />
        <div className="flex justify-between mt-4">
          <div className="h-8 w-24 bg-apple-gray-300 rounded" />
          <div className="h-8 w-16 bg-apple-gray-300 rounded" />
        </div>
      </div>
    </div>
  );
}
