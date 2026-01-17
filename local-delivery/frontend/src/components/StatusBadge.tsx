import type { OrderStatus } from '@/types';

interface StatusBadgeProps {
  status: OrderStatus;
  className?: string;
}

const statusConfig: Record<
  OrderStatus,
  { label: string; className: string }
> = {
  pending: { label: 'Pending', className: 'badge-pending' },
  confirmed: { label: 'Confirmed', className: 'badge-confirmed' },
  preparing: { label: 'Preparing', className: 'badge-preparing' },
  ready_for_pickup: { label: 'Ready', className: 'badge-ready' },
  driver_assigned: { label: 'Driver Assigned', className: 'badge-confirmed' },
  picked_up: { label: 'Picked Up', className: 'badge-picked-up' },
  in_transit: { label: 'In Transit', className: 'badge-in-transit' },
  delivered: { label: 'Delivered', className: 'badge-delivered' },
  cancelled: { label: 'Cancelled', className: 'badge-cancelled' },
};

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  const config = statusConfig[status] || {
    label: status,
    className: 'badge bg-gray-100 text-gray-800',
  };

  return (
    <span className={`${config.className} ${className}`}>
      {config.label}
    </span>
  );
}
