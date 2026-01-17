import type { Seat } from '../types';

interface SeatMapProps {
  section: string;
  seats: Seat[];
  selectedSeats: Seat[];
  onSeatClick: (seat: Seat) => void;
}

export function SeatMap({ section, seats, selectedSeats, onSeatClick }: SeatMapProps) {
  // Group seats by row
  const rows = seats.reduce(
    (acc, seat) => {
      if (!acc[seat.row]) {
        acc[seat.row] = [];
      }
      acc[seat.row].push(seat);
      return acc;
    },
    {} as Record<string, Seat[]>
  );

  const sortedRows = Object.keys(rows).sort();

  const getSeatColor = (seat: Seat) => {
    const isSelected = selectedSeats.some((s) => s.id === seat.id);

    if (isSelected) {
      return 'bg-ticketmaster-blue text-white';
    }

    if (seat.status === 'sold') {
      return 'bg-gray-300 text-gray-500 cursor-not-allowed';
    }

    if (seat.status === 'held') {
      return 'bg-yellow-300 text-yellow-800 cursor-not-allowed';
    }

    switch (seat.price_tier) {
      case 'vip':
        return 'bg-purple-200 hover:bg-purple-300 text-purple-800';
      case 'premium':
        return 'bg-blue-200 hover:bg-blue-300 text-blue-800';
      case 'standard':
        return 'bg-green-200 hover:bg-green-300 text-green-800';
      case 'economy':
        return 'bg-gray-200 hover:bg-gray-300 text-gray-800';
      default:
        return 'bg-gray-200 hover:bg-gray-300';
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold mb-4">{section}</h3>

      {/* Stage indicator */}
      <div className="bg-gray-800 text-white text-center py-2 rounded-t-lg mb-6">
        STAGE
      </div>

      {/* Seat grid */}
      <div className="space-y-2">
        {sortedRows.map((row) => (
          <div key={row} className="flex items-center space-x-1">
            <span className="w-8 text-sm text-gray-500 font-medium">{row}</span>
            <div className="flex space-x-1 flex-wrap">
              {rows[row]
                .sort((a, b) => parseInt(a.seat_number) - parseInt(b.seat_number))
                .map((seat) => (
                  <button
                    key={seat.id}
                    onClick={() => seat.status === 'available' && onSeatClick(seat)}
                    disabled={seat.status !== 'available'}
                    className={`w-7 h-7 text-xs font-medium rounded transition-colors ${getSeatColor(seat)}`}
                    title={`Row ${seat.row}, Seat ${seat.seat_number} - $${seat.price}`}
                  >
                    {seat.seat_number}
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="mt-6 pt-4 border-t border-gray-200">
        <div className="flex flex-wrap gap-4 text-sm">
          <div className="flex items-center">
            <div className="w-4 h-4 bg-ticketmaster-blue rounded mr-2"></div>
            <span>Selected</span>
          </div>
          <div className="flex items-center">
            <div className="w-4 h-4 bg-purple-200 rounded mr-2"></div>
            <span>VIP</span>
          </div>
          <div className="flex items-center">
            <div className="w-4 h-4 bg-blue-200 rounded mr-2"></div>
            <span>Premium</span>
          </div>
          <div className="flex items-center">
            <div className="w-4 h-4 bg-green-200 rounded mr-2"></div>
            <span>Standard</span>
          </div>
          <div className="flex items-center">
            <div className="w-4 h-4 bg-gray-200 rounded mr-2"></div>
            <span>Economy</span>
          </div>
          <div className="flex items-center">
            <div className="w-4 h-4 bg-gray-300 rounded mr-2"></div>
            <span>Sold</span>
          </div>
          <div className="flex items-center">
            <div className="w-4 h-4 bg-yellow-300 rounded mr-2"></div>
            <span>Held</span>
          </div>
        </div>
      </div>
    </div>
  );
}
