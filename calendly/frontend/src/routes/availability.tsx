import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { availabilityApi } from '../services/api';
import type { AvailabilityRule } from '../types';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { getDayName, formatTime12Hour } from '../utils/time';

export const Route = createFileRoute('/availability')({
  beforeLoad: async () => {
    const { isAuthenticated, checkAuth, isLoading } = useAuthStore.getState();
    if (!isAuthenticated && !isLoading) {
      await checkAuth();
      if (!useAuthStore.getState().isAuthenticated) {
        throw redirect({ to: '/login' });
      }
    }
  },
  component: AvailabilityPage,
});

interface DaySchedule {
  enabled: boolean;
  startTime: string;
  endTime: string;
}

function AvailabilityPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [schedule, setSchedule] = useState<DaySchedule[]>(
    Array(7).fill({ enabled: false, startTime: '09:00', endTime: '17:00' })
  );

  useEffect(() => {
    loadAvailability();
  }, []);

  const loadAvailability = async () => {
    try {
      const response = await availabilityApi.getRules();
      if (response.success && response.data) {
        const newSchedule = Array(7).fill(null).map(() => ({
          enabled: false,
          startTime: '09:00',
          endTime: '17:00',
        }));

        response.data.forEach((rule: AvailabilityRule) => {
          newSchedule[rule.day_of_week] = {
            enabled: true,
            startTime: rule.start_time.slice(0, 5),
            endTime: rule.end_time.slice(0, 5),
          };
        });

        setSchedule(newSchedule);
      }
    } catch (error) {
      console.error('Failed to load availability:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const rules = schedule
        .map((day, index) => ({
          day_of_week: index,
          start_time: day.startTime,
          end_time: day.endTime,
        }))
        .filter((_, index) => schedule[index].enabled);

      const response = await availabilityApi.setRules(rules);
      if (response.success) {
        alert('Availability saved successfully!');
      } else {
        alert('Failed to save availability');
      }
    } catch (error) {
      console.error('Failed to save availability:', error);
      alert('Failed to save availability');
    } finally {
      setIsSaving(false);
    }
  };

  const updateDay = (dayIndex: number, updates: Partial<DaySchedule>) => {
    const newSchedule = [...schedule];
    newSchedule[dayIndex] = { ...newSchedule[dayIndex], ...updates };
    setSchedule(newSchedule);
  };

  const timeOptions: string[] = [];
  for (let hour = 0; hour < 24; hour++) {
    for (let minute = 0; minute < 60; minute += 30) {
      const time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
      timeOptions.push(time);
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Availability</h1>
        <p className="text-gray-600 mt-1">
          Set your weekly working hours when people can book meetings with you.
        </p>
      </div>

      <div className="card">
        <div className="space-y-4">
          {schedule.map((day, index) => (
            <div
              key={index}
              className={`flex items-center gap-4 p-4 rounded-lg ${
                day.enabled ? 'bg-gray-50' : 'bg-white'
              }`}
            >
              <div className="w-32">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={day.enabled}
                    onChange={(e) => updateDay(index, { enabled: e.target.checked })}
                    className="w-5 h-5 text-primary-600 rounded focus:ring-primary-500"
                  />
                  <span className={`font-medium ${day.enabled ? 'text-gray-900' : 'text-gray-400'}`}>
                    {getDayName(index)}
                  </span>
                </label>
              </div>

              {day.enabled ? (
                <div className="flex items-center gap-2 flex-1">
                  <select
                    value={day.startTime}
                    onChange={(e) => updateDay(index, { startTime: e.target.value })}
                    className="input py-2 w-32"
                  >
                    {timeOptions.map((time) => (
                      <option key={time} value={time}>
                        {formatTime12Hour(time)}
                      </option>
                    ))}
                  </select>
                  <span className="text-gray-500">to</span>
                  <select
                    value={day.endTime}
                    onChange={(e) => updateDay(index, { endTime: e.target.value })}
                    className="input py-2 w-32"
                  >
                    {timeOptions.map((time) => (
                      <option key={time} value={time}>
                        {formatTime12Hour(time)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <span className="text-gray-400 italic">Unavailable</span>
              )}
            </div>
          ))}
        </div>

        <div className="mt-6 pt-6 border-t border-gray-200 flex justify-end">
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="btn btn-primary"
          >
            {isSaving ? 'Saving...' : 'Save Availability'}
          </button>
        </div>
      </div>

      <div className="mt-8 card bg-blue-50 border border-blue-100">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Tips</h3>
        <ul className="text-sm text-gray-600 space-y-1">
          <li>- All times are in your local timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone})</li>
          <li>- Buffer times between meetings are set per event type</li>
          <li>- Invitees will see available slots in their own timezone</li>
        </ul>
      </div>
    </div>
  );
}
