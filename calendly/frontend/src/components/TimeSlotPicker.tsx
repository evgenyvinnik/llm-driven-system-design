import type { TimeSlot } from '../types';
import { formatInTimezone } from '../utils/time';

interface TimeSlotPickerProps {
  slots: TimeSlot[];
  selectedSlot: TimeSlot | null;
  onSelectSlot: (slot: TimeSlot) => void;
  timezone: string;
}

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
