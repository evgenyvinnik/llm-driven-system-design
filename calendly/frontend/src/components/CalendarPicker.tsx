import { useState, useEffect } from 'react';
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  isSameMonth,
  isSameDay,
  addMonths,
  subMonths,
  isToday,
  isBefore,
  startOfDay,
} from 'date-fns';

interface CalendarPickerProps {
  selectedDate: Date | null;
  onSelectDate: (date: Date) => void;
  availableDates?: string[];
  minDate?: Date;
}

export function CalendarPicker({
  selectedDate,
  onSelectDate,
  availableDates = [],
  minDate = new Date(),
}: CalendarPickerProps) {
  const [currentMonth, setCurrentMonth] = useState(selectedDate || new Date());

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart);
  const endDate = endOfWeek(monthEnd);

  const availableDateSet = new Set(availableDates);

  const rows = [];
  let days = [];
  let day = startDate;

  while (day <= endDate) {
    for (let i = 0; i < 7; i++) {
      const dayStr = format(day, 'yyyy-MM-dd');
      const isAvailable = availableDateSet.size === 0 || availableDateSet.has(dayStr);
      const isPast = isBefore(day, startOfDay(minDate));
      const isCurrentMonth = isSameMonth(day, monthStart);
      const isSelected = selectedDate && isSameDay(day, selectedDate);
      const isDayToday = isToday(day);

      const dayClone = day;

      days.push(
        <button
          key={dayStr}
          onClick={() => !isPast && isAvailable && onSelectDate(dayClone)}
          disabled={isPast || !isAvailable}
          className={`
            p-2 text-center rounded-lg text-sm font-medium transition-colors
            ${!isCurrentMonth ? 'text-gray-300' : ''}
            ${isPast || !isAvailable ? 'text-gray-300 cursor-not-allowed' : 'hover:bg-primary-50'}
            ${isSelected ? 'bg-primary-600 text-white hover:bg-primary-700' : ''}
            ${isDayToday && !isSelected ? 'border-2 border-primary-500' : ''}
            ${isCurrentMonth && !isPast && isAvailable && !isSelected ? 'text-gray-900' : ''}
          `}
        >
          {format(day, 'd')}
        </button>
      );

      day = addDays(day, 1);
    }
    rows.push(
      <div key={day.toString()} className="grid grid-cols-7 gap-1">
        {days}
      </div>
    );
    days = [];
  }

  return (
    <div className="bg-white rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
          className="p-2 hover:bg-gray-100 rounded-lg"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h3 className="text-lg font-semibold text-gray-900">
          {format(currentMonth, 'MMMM yyyy')}
        </h3>
        <button
          onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
          className="p-2 hover:bg-gray-100 rounded-lg"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-2">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((dayName) => (
          <div key={dayName} className="p-2 text-center text-xs font-medium text-gray-500">
            {dayName}
          </div>
        ))}
      </div>

      <div className="space-y-1">{rows}</div>
    </div>
  );
}
