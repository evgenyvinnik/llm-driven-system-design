import type { Booking } from '@/types';
import { formatCurrency, formatDate, getStatusColor, getStatusLabel } from '@/utils';

/**
 * Props for the BookingsTable component.
 */
interface BookingsTableProps {
  /** List of bookings to display */
  bookings: Booking[];
  /** Whether bookings are currently loading */
  isLoading: boolean;
  /** Maximum number of bookings to display (default: 10) */
  maxRows?: number;
}

/**
 * Displays a table of recent bookings for a hotel.
 * Shows guest information, room details, dates, status, and pricing.
 * Includes loading and empty states.
 *
 * @param props - Component props
 * @returns A card containing the bookings table
 *
 * @example
 * ```tsx
 * <BookingsTable
 *   bookings={bookings}
 *   isLoading={bookingsLoading}
 *   maxRows={10}
 * />
 * ```
 */
export function BookingsTable({ bookings, isLoading, maxRows = 10 }: BookingsTableProps) {
  return (
    <div className="card p-6">
      <h3 className="font-semibold mb-4">Recent Bookings</h3>
      <BookingsTableContent
        bookings={bookings}
        isLoading={isLoading}
        maxRows={maxRows}
      />
    </div>
  );
}

/**
 * Props for the BookingsTableContent component.
 */
interface BookingsTableContentProps {
  bookings: Booking[];
  isLoading: boolean;
  maxRows: number;
}

/**
 * Renders the appropriate content based on loading state and data availability.
 */
function BookingsTableContent({ bookings, isLoading, maxRows }: BookingsTableContentProps) {
  if (isLoading) {
    return <LoadingState />;
  }

  if (bookings.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <BookingsTableHeader />
        <BookingsTableBody bookings={bookings.slice(0, maxRows)} />
      </table>
    </div>
  );
}

/**
 * Loading spinner for the table.
 */
function LoadingState() {
  return (
    <div className="flex justify-center py-8">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
    </div>
  );
}

/**
 * Empty state message when no bookings exist.
 */
function EmptyState() {
  return <p className="text-gray-500 text-center py-8">No bookings yet</p>;
}

/**
 * Table header row with column labels.
 */
function BookingsTableHeader() {
  return (
    <thead>
      <tr className="text-left text-sm text-gray-500 border-b">
        <th className="pb-3 pr-4">Guest</th>
        <th className="pb-3 pr-4">Room</th>
        <th className="pb-3 pr-4">Check-in</th>
        <th className="pb-3 pr-4">Check-out</th>
        <th className="pb-3 pr-4">Status</th>
        <th className="pb-3">Total</th>
      </tr>
    </thead>
  );
}

/**
 * Table body containing booking rows.
 */
function BookingsTableBody({ bookings }: { bookings: Booking[] }) {
  return (
    <tbody>
      {bookings.map((booking) => (
        <BookingRow key={booking.id} booking={booking} />
      ))}
    </tbody>
  );
}

/**
 * Individual booking row in the table.
 */
function BookingRow({ booking }: { booking: Booking }) {
  return (
    <tr className="border-b last:border-0">
      <td className="py-3 pr-4">
        <GuestInfo
          firstName={booking.guestFirstName}
          lastName={booking.guestLastName}
          email={booking.guestEmail}
        />
      </td>
      <td className="py-3 pr-4">{booking.roomTypeName}</td>
      <td className="py-3 pr-4">{formatDate(booking.checkIn)}</td>
      <td className="py-3 pr-4">{formatDate(booking.checkOut)}</td>
      <td className="py-3 pr-4">
        <StatusBadge status={booking.status} />
      </td>
      <td className="py-3 font-medium">{formatCurrency(booking.totalPrice)}</td>
    </tr>
  );
}

/**
 * Guest name and email display.
 */
function GuestInfo({
  firstName,
  lastName,
  email,
}: {
  firstName: string;
  lastName: string;
  email: string;
}) {
  return (
    <div>
      <p className="font-medium">
        {firstName} {lastName}
      </p>
      <p className="text-sm text-gray-500">{email}</p>
    </div>
  );
}

/**
 * Booking status badge with color coding.
 */
function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(status)}`}>
      {getStatusLabel(status)}
    </span>
  );
}
