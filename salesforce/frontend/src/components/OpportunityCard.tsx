import { useDraggable } from '@dnd-kit/core';
import type { Opportunity } from '../types';
import { formatCalendarDate } from '../utils/dates';

interface OpportunityCardProps {
  opportunity: Opportunity;
}

function formatCurrency(cents: number | null): string {
  if (!cents) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

/** Renders a draggable opportunity card showing name, account, amount, and probability for the Kanban board. */
export function OpportunityCard({ opportunity }: OpportunityCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: opportunity.id,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`bg-white rounded-lg border border-salesforce-border p-3 cursor-grab active:cursor-grabbing shadow-sm hover:shadow-md transition-shadow ${
        isDragging ? 'opacity-50' : ''
      }`}
    >
      <h4 className="text-sm font-medium text-salesforce-text truncate mb-1">
        {opportunity.name}
      </h4>
      <p className="text-xs text-salesforce-secondary truncate mb-2">
        {opportunity.account_name || 'No account'}
      </p>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-salesforce-primary">
          {formatCurrency(opportunity.amount_cents)}
        </span>
        <span className="text-xs text-salesforce-secondary">
          {opportunity.probability}%
        </span>
      </div>
      {opportunity.close_date && (
        <p className="text-xs text-salesforce-secondary mt-1">
          Close: {formatCalendarDate(opportunity.close_date)}
        </p>
      )}
    </div>
  );
}
