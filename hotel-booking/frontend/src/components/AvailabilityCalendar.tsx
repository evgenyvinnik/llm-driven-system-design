import { useState, useEffect } from 'react';
import { format, addMonths, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isToday, isBefore, parseISO, isSameDay } from 'date-fns';
import type { AvailabilityDay } from '@/types';
import { formatCurrency } from '@/utils';
import { api } from '@/services/api';

interface AvailabilityCalendarProps {
  hotelId: string;
  roomTypeId: string;
  selectedCheckIn?: string;
  selectedCheckOut?: string;
  onDateSelect?: (checkIn: string, checkOut: string) => void;
}

export function AvailabilityCalendar({
  hotelId,
  roomTypeId,
  selectedCheckIn,
  selectedCheckOut,
  onDateSelect,
}: AvailabilityCalendarProps) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [availability, setAvailability] = useState<AvailabilityDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectingCheckIn, setSelectingCheckIn] = useState(true);
  const [tempCheckIn, setTempCheckIn] = useState<string | null>(selectedCheckIn || null);

  useEffect(() => {
    loadAvailability();
  }, [hotelId, roomTypeId, currentMonth]);

  const loadAvailability = async () => {
    setLoading(true);
    try {
      const data = await api.getAvailabilityCalendar(
        hotelId,
        roomTypeId,
        currentMonth.getFullYear(),
        currentMonth.getMonth() + 1
      );
      setAvailability(data);
    } catch (error) {
      console.error('Failed to load availability:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDateClick = (date: Date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    const day = availability.find((d) => d.date === dateStr);

    if (!day || day.available === 0 || isBefore(date, new Date())) {
      return;
    }

    if (selectingCheckIn || !tempCheckIn) {
      setTempCheckIn(dateStr);
      setSelectingCheckIn(false);
    } else {
      const checkIn = tempCheckIn;
      const checkOut = dateStr;

      if (isBefore(parseISO(checkOut), parseISO(checkIn))) {
        setTempCheckIn(dateStr);
        setSelectingCheckIn(false);
      } else {
        if (onDateSelect) {
          onDateSelect(checkIn, checkOut);
        }
        setTempCheckIn(null);
        setSelectingCheckIn(true);
      }
    }
  };

  const isInRange = (date: Date) => {
    if (!tempCheckIn || !selectedCheckOut) return false;
    const d = format(date, 'yyyy-MM-dd');
    return d >= tempCheckIn && d <= selectedCheckOut;
  };

  const isCheckIn = (date: Date) => {
    const d = format(date, 'yyyy-MM-dd');
    return d === (tempCheckIn || selectedCheckIn);
  };

  const isCheckOut = (date: Date) => {
    const d = format(date, 'yyyy-MM-dd');
    return d === selectedCheckOut;
  };

  const getDayData = (date: Date): AvailabilityDay | undefined => {
    const dateStr = format(date, 'yyyy-MM-dd');
    return availability.find((d) => d.date === dateStr);
  };

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

  const startDay = monthStart.getDay();
  const emptyDays = Array(startDay).fill(null);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex justify-between items-center mb-4">
        <button
          onClick={() => setCurrentMonth(addMonths(currentMonth, -1))}
          className="p-2 hover:bg-gray-100 rounded-lg"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h3 className="text-lg font-semibold">{format(currentMonth, 'MMMM yyyy')}</h3>
        <button
          onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
          className="p-2 hover:bg-gray-100 rounded-lg"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <div className="text-sm text-gray-500 mb-2 text-center">
        {selectingCheckIn || !tempCheckIn
          ? 'Select check-in date'
          : 'Select check-out date'}
      </div>

      <div className="grid grid-cols-7 gap-1 mb-2">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
          <div key={day} className="text-center text-xs font-medium text-gray-500 py-2">
            {day}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {emptyDays.map((_, index) => (
          <div key={`empty-${index}`} className="h-16" />
        ))}
        {days.map((date) => {
          const dayData = getDayData(date);
          const isPast = isBefore(date, new Date()) && !isToday(date);
          const isUnavailable = dayData?.available === 0;
          const isSelectable = !isPast && !isUnavailable && isSameMonth(date, currentMonth);

          return (
            <button
              key={date.toISOString()}
              onClick={() => isSelectable && handleDateClick(date)}
              disabled={!isSelectable}
              className={`
                h-16 p-1 rounded-lg text-center flex flex-col items-center justify-center
                ${isToday(date) ? 'border-2 border-primary-500' : ''}
                ${isCheckIn(date) ? 'bg-primary-600 text-white' : ''}
                ${isCheckOut(date) ? 'bg-primary-600 text-white' : ''}
                ${isInRange(date) && !isCheckIn(date) && !isCheckOut(date) ? 'bg-primary-100' : ''}
                ${isPast ? 'text-gray-300 cursor-not-allowed' : ''}
                ${isUnavailable ? 'text-gray-300 bg-gray-50 cursor-not-allowed' : ''}
                ${isSelectable && !isCheckIn(date) && !isCheckOut(date) ? 'hover:bg-gray-100 cursor-pointer' : ''}
              `}
            >
              <span className="text-sm font-medium">{format(date, 'd')}</span>
              {dayData && !loading && (
                <span
                  className={`text-xs ${
                    isCheckIn(date) || isCheckOut(date)
                      ? 'text-white/80'
                      : isUnavailable
                      ? 'text-gray-400'
                      : 'text-green-600'
                  }`}
                >
                  {formatCurrency(dayData.price)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-center space-x-4 text-xs text-gray-500">
        <div className="flex items-center space-x-1">
          <div className="w-4 h-4 bg-primary-600 rounded" />
          <span>Selected</span>
        </div>
        <div className="flex items-center space-x-1">
          <div className="w-4 h-4 bg-gray-50 rounded border" />
          <span>Unavailable</span>
        </div>
      </div>
    </div>
  );
}
