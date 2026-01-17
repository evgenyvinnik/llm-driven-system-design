import { useState, useMemo } from 'react';
import { AvailabilityBlock } from '../types';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, isWithinInterval, parseISO, addMonths, isBefore, startOfDay } from 'date-fns';

interface CalendarProps {
  availabilityBlocks?: AvailabilityBlock[];
  selectedCheckIn?: Date;
  selectedCheckOut?: Date;
  onSelectDates?: (checkIn: Date | undefined, checkOut: Date | undefined) => void;
  minNights?: number;
  readOnly?: boolean;
}

export function Calendar({
  availabilityBlocks = [],
  selectedCheckIn,
  selectedCheckOut,
  onSelectDates,
  minNights = 1,
  readOnly = false,
}: CalendarProps) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const today = startOfDay(new Date());

  const blockedDates = useMemo(() => {
    const blocked = new Set<string>();
    availabilityBlocks
      .filter((b) => b.status === 'blocked' || b.status === 'booked')
      .forEach((block) => {
        const start = parseISO(block.start_date);
        const end = parseISO(block.end_date);
        eachDayOfInterval({ start, end }).forEach((date) => {
          blocked.add(format(date, 'yyyy-MM-dd'));
        });
      });
    return blocked;
  }, [availabilityBlocks]);

  const isDateBlocked = (date: Date): boolean => {
    return blockedDates.has(format(date, 'yyyy-MM-dd'));
  };

  const isDateDisabled = (date: Date): boolean => {
    return isBefore(date, today) || isDateBlocked(date);
  };

  const isDateInRange = (date: Date): boolean => {
    if (!selectedCheckIn || !selectedCheckOut) return false;
    return isWithinInterval(date, { start: selectedCheckIn, end: selectedCheckOut });
  };

  const handleDateClick = (date: Date) => {
    if (readOnly || isDateDisabled(date)) return;

    if (!selectedCheckIn || (selectedCheckIn && selectedCheckOut)) {
      onSelectDates?.(date, undefined);
    } else {
      if (isBefore(date, selectedCheckIn)) {
        onSelectDates?.(date, undefined);
      } else {
        // Check if any blocked dates are in the range
        const hasBlockedInRange = eachDayOfInterval({ start: selectedCheckIn, end: date }).some(
          (d) => isDateBlocked(d)
        );
        if (!hasBlockedInRange) {
          onSelectDates?.(selectedCheckIn, date);
        } else {
          onSelectDates?.(date, undefined);
        }
      }
    }
  };

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

  const startDay = monthStart.getDay();
  const paddingDays = Array(startDay).fill(null);

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setCurrentMonth((m) => addMonths(m, -1))}
          className="p-2 hover:bg-gray-100 rounded-full"
          disabled={isBefore(addMonths(currentMonth, -1), startOfMonth(today))}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="font-semibold">{format(currentMonth, 'MMMM yyyy')}</span>
        <button
          onClick={() => setCurrentMonth((m) => addMonths(m, 1))}
          className="p-2 hover:bg-gray-100 rounded-full"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-2">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((day) => (
          <div key={day} className="text-center text-xs font-medium text-gray-500 py-2">
            {day}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {paddingDays.map((_, i) => (
          <div key={`pad-${i}`} className="aspect-square" />
        ))}

        {days.map((date) => {
          const isDisabled = isDateDisabled(date);
          const isSelected =
            (selectedCheckIn && isSameDay(date, selectedCheckIn)) ||
            (selectedCheckOut && isSameDay(date, selectedCheckOut));
          const inRange = isDateInRange(date);
          const isCheckIn = selectedCheckIn && isSameDay(date, selectedCheckIn);
          const isCheckOut = selectedCheckOut && isSameDay(date, selectedCheckOut);

          return (
            <button
              key={date.toISOString()}
              onClick={() => handleDateClick(date)}
              disabled={readOnly || isDisabled}
              className={`
                aspect-square flex items-center justify-center text-sm rounded-full
                ${isDisabled ? 'text-gray-300 cursor-not-allowed line-through' : 'hover:border hover:border-gray-900'}
                ${isSelected ? 'bg-gray-900 text-white' : ''}
                ${inRange && !isSelected ? 'bg-gray-100' : ''}
                ${!isDisabled && !isSelected && !inRange ? 'text-gray-900' : ''}
              `}
            >
              {format(date, 'd')}
            </button>
          );
        })}
      </div>

      {minNights > 1 && (
        <p className="text-xs text-gray-500 mt-4 text-center">
          {minNights} night minimum
        </p>
      )}
    </div>
  );
}
