import type { PaymentIntentStatus } from '@/types';
import { getStatusColor } from '@/utils';

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const colorClass = getStatusColor(status);
  const label = formatStatusLabel(status);

  return <span className={colorClass}>{label}</span>;
}

function formatStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    requires_payment_method: 'Requires Payment',
    requires_confirmation: 'Requires Confirmation',
    requires_action: 'Requires Action',
    requires_capture: 'Authorized',
    processing: 'Processing',
    succeeded: 'Succeeded',
    failed: 'Failed',
    canceled: 'Canceled',
    pending: 'Pending',
    delivered: 'Delivered',
    refunded: 'Refunded',
    partially_refunded: 'Partially Refunded',
    active: 'Active',
    inactive: 'Inactive',
    suspended: 'Suspended',
    low: 'Low Risk',
    medium: 'Medium Risk',
    high: 'High Risk',
    critical: 'Critical Risk',
    needs_response: 'Needs Response',
    under_review: 'Under Review',
    won: 'Won',
    lost: 'Lost',
  };

  return labels[status] || status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}
