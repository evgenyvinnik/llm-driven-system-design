import type { Seat, Reservation } from '../types';

interface CheckoutSummaryProps {
  selectedSeats: Seat[];
  reservation: Reservation | null;
  timer: number | null;
  onReserve: () => void;
  onCheckout: () => void;
  onClear: () => void;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export function CheckoutSummary({
  selectedSeats,
  reservation,
  timer,
  onReserve,
  onCheckout,
  onClear,
  isLoading,
  isAuthenticated,
}: CheckoutSummaryProps) {
  const totalPrice = selectedSeats.reduce((sum, seat) => sum + seat.price, 0);

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (selectedSeats.length === 0 && !reservation) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-4">Your Selection</h3>
        <p className="text-gray-500 text-sm">
          Click on available seats to select them
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Your Selection</h3>
        {timer !== null && (
          <div className={`text-sm font-medium ${timer < 60 ? 'text-red-600' : 'text-gray-600'}`}>
            Time left: {formatTimer(timer)}
          </div>
        )}
      </div>

      {/* Selected seats list */}
      <div className="space-y-2 mb-4 max-h-48 overflow-y-auto">
        {(reservation?.seats || selectedSeats).map((seat) => (
          <div
            key={seat.id}
            className="flex items-center justify-between py-2 border-b border-gray-100"
          >
            <div>
              <span className="font-medium">
                {reservation ? `${(seat as Reservation['seats'][0]).section} - ` : ''}
                Row {seat.row}, Seat {seat.seat_number}
              </span>
              <span className="ml-2 text-xs text-gray-500 capitalize">
                ({seat.price_tier})
              </span>
            </div>
            <span className="font-medium">${seat.price.toFixed(2)}</span>
          </div>
        ))}
      </div>

      {/* Total */}
      <div className="border-t border-gray-200 pt-4 mb-4">
        <div className="flex items-center justify-between">
          <span className="font-semibold">Total</span>
          <span className="text-xl font-bold">
            ${(reservation?.total_price || totalPrice).toFixed(2)}
          </span>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Service fees included
        </p>
      </div>

      {/* Actions */}
      <div className="space-y-2">
        {!isAuthenticated ? (
          <p className="text-sm text-center text-gray-500">
            Please sign in to continue
          </p>
        ) : reservation ? (
          <button
            onClick={onCheckout}
            disabled={isLoading}
            className="w-full bg-green-600 hover:bg-green-700 text-white py-3 rounded-lg font-semibold transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Processing...' : 'Complete Purchase'}
          </button>
        ) : (
          <button
            onClick={onReserve}
            disabled={isLoading}
            className="w-full bg-ticketmaster-blue hover:bg-blue-600 text-white py-3 rounded-lg font-semibold transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Reserving...' : 'Reserve Seats'}
          </button>
        )}

        <button
          onClick={onClear}
          className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 rounded-lg text-sm transition-colors"
        >
          Clear Selection
        </button>
      </div>
    </div>
  );
}
