import type { TimeSlot } from '../types';
import { formatInTimezone } from '../utils/time';

/**
 * Props for the TimeSlotPicker component.
 */
interface TimeSlotPickerProps {
  /** Array of available time slots */
  slots: TimeSlot[];
  /** Currently selected slot, or null if none selected */
  selectedSlot: TimeSlot | null;
  /** Callback when a slot is selected */
  onSelectSlot: (slot: TimeSlot) => void;
  /** Timezone for displaying slot times */
  timezone: string;
}

/**
 * Time slot selection component for booking flow.
 * Displays available time slots as selectable buttons.
 * Shows message if no slots are available for the selected date.
 */
export function TimeSlotPicker({
  slots,
  selectedSlot,
  onSelectSlot,
  timezone,
}: TimeSlotPickerProps) {
  if (slots.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        No available times for this date
      </div>
    );
  }

  return (
    <div className="space-y-2 max-h-80 overflow-y-auto">
      {slots.map((slot) => {
        const isSelected = selectedSlot?.start === slot.start;
        const timeStr = formatInTimezone(slot.start, timezone, 'h:mm a');

        return (
          <button
            key={slot.start}
            onClick={() => onSelectSlot(slot)}
            className={`
              w-full py-3 px-4 text-center rounded-lg border-2 font-medium transition-colors
              ${
                isSelected
                  ? 'border-primary-600 bg-primary-50 text-primary-700'
                  : 'border-gray-200 hover:border-primary-300 text-gray-700'
              }
            `}
          >
            {timeStr}
          </button>
        );
      })}
    </div>
  );
}
