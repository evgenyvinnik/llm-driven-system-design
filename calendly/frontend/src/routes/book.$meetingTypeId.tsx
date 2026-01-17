import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { meetingTypesApi, availabilityApi, bookingsApi } from '../../services/api';
import type { MeetingType, TimeSlot } from '../../types';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import { CalendarPicker } from '../../components/CalendarPicker';
import { TimeSlotPicker } from '../../components/TimeSlotPicker';
import { getLocalTimezone, formatDate, formatInTimezone, commonTimezones } from '../../utils/time';
import { format } from 'date-fns';

export const Route = createFileRoute('/book/$meetingTypeId')({
  component: BookingPage,
});

type BookingStep = 'select-time' | 'enter-details' | 'confirmed';

function BookingPage() {
  const { meetingTypeId } = Route.useParams();
  const navigate = useNavigate();

  const [meetingType, setMeetingType] = useState<MeetingType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const [step, setStep] = useState<BookingStep>('select-time');
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [timezone, setTimezone] = useState(getLocalTimezone());

  // Form fields
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [bookingId, setBookingId] = useState<string | null>(null);

  useEffect(() => {
    loadMeetingType();
  }, [meetingTypeId]);

  useEffect(() => {
    if (meetingType) {
      loadAvailableDates();
    }
  }, [meetingType, timezone]);

  useEffect(() => {
    if (selectedDate) {
      loadSlots();
    }
  }, [selectedDate, timezone]);

  const loadMeetingType = async () => {
    try {
      const response = await meetingTypesApi.get(meetingTypeId);
      if (response.success && response.data) {
        setMeetingType(response.data);
      } else {
        setError('Meeting type not found or is no longer active');
      }
    } catch (err) {
      setError('Failed to load meeting type');
    } finally {
      setIsLoading(false);
    }
  };

  const loadAvailableDates = async () => {
    try {
      const response = await availabilityApi.getAvailableDates(meetingTypeId, timezone);
      if (response.success && response.data) {
        setAvailableDates(response.data.available_dates);
      }
    } catch (err) {
      console.error('Failed to load available dates:', err);
    }
  };

  const loadSlots = async () => {
    if (!selectedDate) return;
    setSlotsLoading(true);
    setSlots([]);
    setSelectedSlot(null);

    try {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      const response = await availabilityApi.getSlots(meetingTypeId, dateStr, timezone);
      if (response.success && response.data) {
        setSlots(response.data.slots);
      }
    } catch (err) {
      console.error('Failed to load slots:', err);
    } finally {
      setSlotsLoading(false);
    }
  };

  const handleDateSelect = (date: Date) => {
    setSelectedDate(date);
    setSelectedSlot(null);
  };

  const handleSlotSelect = (slot: TimeSlot) => {
    setSelectedSlot(slot);
  };

  const handleContinue = () => {
    if (selectedSlot) {
      setStep('enter-details');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSlot) return;

    setIsSubmitting(true);
    try {
      const response = await bookingsApi.create({
        meeting_type_id: meetingTypeId,
        start_time: selectedSlot.start,
        invitee_name: name,
        invitee_email: email,
        invitee_timezone: timezone,
        notes: notes || undefined,
      });

      if (response.success && response.data) {
        setBookingId(response.data.id);
        setStep('confirmed');
      } else {
        alert(response.error || 'Failed to create booking. The slot may no longer be available.');
      }
    } catch (err) {
      alert('Failed to create booking. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBack = () => {
    if (step === 'enter-details') {
      setStep('select-time');
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error || !meetingType) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <svg className="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <h1 className="text-2xl font-bold text-gray-900 mb-4">
          {error || 'Meeting type not found'}
        </h1>
        <p className="text-gray-500">
          This booking link may be expired or the event type is no longer available.
        </p>
      </div>
    );
  }

  if (step === 'confirmed') {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-gray-900 mb-4">
          You are scheduled!
        </h1>
        <p className="text-lg text-gray-600 mb-8">
          A confirmation email has been sent to {email}
        </p>

        <div className="card text-left max-w-md mx-auto">
          <h2 className="font-semibold text-gray-900 mb-4">{meetingType.name}</h2>
          <div className="space-y-2 text-gray-600">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <span>{meetingType.user_name}</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span>{selectedSlot && formatInTimezone(selectedSlot.start, timezone, 'EEEE, MMMM d, yyyy')}</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{selectedSlot && formatInTimezone(selectedSlot.start, timezone, 'h:mm a')} ({timezone})</span>
            </div>
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{meetingType.duration_minutes} minutes</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="grid lg:grid-cols-3 gap-8">
        {/* Meeting Type Info */}
        <div className="lg:col-span-1">
          <div className="card sticky top-8">
            <div
              className="w-3 h-full absolute left-0 top-0 rounded-l-lg"
              style={{ backgroundColor: meetingType.color }}
            />
            <div className="pl-4">
              <p className="text-sm text-gray-500 mb-1">{meetingType.user_name}</p>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">{meetingType.name}</h1>
              <div className="flex items-center gap-2 text-gray-600 mb-4">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{meetingType.duration_minutes} min</span>
              </div>
              {meetingType.description && (
                <p className="text-gray-600 text-sm">{meetingType.description}</p>
              )}

              {/* Timezone Selector */}
              <div className="mt-6 pt-6 border-t border-gray-200">
                <label className="label">Timezone</label>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="input text-sm"
                >
                  {commonTimezones.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Booking Flow */}
        <div className="lg:col-span-2">
          {step === 'select-time' && (
            <div className="card">
              <h2 className="text-xl font-semibold text-gray-900 mb-6">Select a Date & Time</h2>

              <div className="grid md:grid-cols-2 gap-6">
                {/* Calendar */}
                <div>
                  <CalendarPicker
                    selectedDate={selectedDate}
                    onSelectDate={handleDateSelect}
                    availableDates={availableDates}
                  />
                </div>

                {/* Time Slots */}
                <div>
                  {selectedDate ? (
                    <>
                      <h3 className="font-medium text-gray-900 mb-4">
                        {formatDate(selectedDate, timezone)}
                      </h3>
                      {slotsLoading ? (
                        <div className="flex justify-center py-8">
                          <LoadingSpinner />
                        </div>
                      ) : (
                        <TimeSlotPicker
                          slots={slots}
                          selectedSlot={selectedSlot}
                          onSelectSlot={handleSlotSelect}
                          timezone={timezone}
                        />
                      )}
                    </>
                  ) : (
                    <div className="text-center py-8 text-gray-500">
                      <svg className="w-12 h-12 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      <p>Select a date to see available times</p>
                    </div>
                  )}
                </div>
              </div>

              {selectedSlot && (
                <div className="mt-6 pt-6 border-t border-gray-200 flex justify-end">
                  <button onClick={handleContinue} className="btn btn-primary">
                    Continue
                  </button>
                </div>
              )}
            </div>
          )}

          {step === 'enter-details' && (
            <div className="card">
              <button
                onClick={handleBack}
                className="flex items-center gap-1 text-gray-600 hover:text-gray-900 mb-4"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back
              </button>

              <h2 className="text-xl font-semibold text-gray-900 mb-2">Enter Details</h2>
              <p className="text-gray-600 mb-6">
                {selectedSlot && formatInTimezone(selectedSlot.start, timezone, 'EEEE, MMMM d \'at\' h:mm a')}
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="name" className="label">Name *</label>
                  <input
                    id="name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="input"
                    required
                    placeholder="Your name"
                  />
                </div>

                <div>
                  <label htmlFor="email" className="label">Email *</label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input"
                    required
                    placeholder="you@example.com"
                  />
                </div>

                <div>
                  <label htmlFor="notes" className="label">Additional Notes</label>
                  <textarea
                    id="notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="input"
                    rows={4}
                    placeholder="Please share anything that will help prepare for our meeting."
                  />
                </div>

                <div className="pt-4">
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full btn btn-primary py-3 text-lg"
                  >
                    {isSubmitting ? 'Scheduling...' : 'Schedule Event'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
