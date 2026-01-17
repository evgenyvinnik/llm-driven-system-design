/**
 * Event detail page route.
 * Shows full event information, seat map, and purchase workflow.
 * Handles waiting room integration for high-demand events.
 */
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { eventsApi, seatsApi } from '../../services/api';
import { useAuthStore } from '../../stores/auth.store';
import { useTicketStore } from '../../stores/ticket.store';
import { SeatMap } from '../../components/SeatMap';
import { CheckoutSummary } from '../../components/CheckoutSummary';
import { WaitingRoom } from '../../components/WaitingRoom';
import type { Event, SectionAvailability, Seat } from '../../types';

/** Route configuration for event detail page */
export const Route = createFileRoute('/events/$eventId')({
  component: EventDetailPage,
});

/**
 * Event detail page with seat selection and checkout functionality.
 * Manages complex state for seat availability, reservations, and queue status.
 */
function EventDetailPage() {
  const { eventId } = Route.useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthStore();
  const {
    selectedSeats,
    reservation,
    queueStatus,
    isLoading: ticketLoading,
    error: ticketError,
    checkoutTimer,
    selectSeat,
    deselectSeat,
    clearSelection,
    reserveSeats,
    joinQueue,
    checkQueueStatus,
    leaveQueue,
    checkout,
    clearError,
  } = useTicketStore();

  const [event, setEvent] = useState<Event | null>(null);
  const [sections, setSections] = useState<SectionAvailability[]>([]);
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [sectionSeats, setSectionSeats] = useState<Seat[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch event details
  useEffect(() => {
    const fetchEvent = async () => {
      try {
        const response = await eventsApi.getById(eventId);
        setEvent(response.data || null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load event');
      } finally {
        setIsLoading(false);
      }
    };
    fetchEvent();
  }, [eventId]);

  // Fetch seat availability
  useEffect(() => {
    if (!event || event.status !== 'on_sale') return;

    const fetchAvailability = async () => {
      try {
        const response = await seatsApi.getAvailability(eventId);
        setSections(response.data || []);
      } catch (err) {
        console.error('Failed to load availability:', err);
      }
    };

    fetchAvailability();
    // Refresh availability every 10 seconds
    const interval = setInterval(fetchAvailability, 10000);
    return () => clearInterval(interval);
  }, [eventId, event]);

  // Handle waiting room for high-demand events
  useEffect(() => {
    if (!event || !event.waiting_room_enabled || !isAuthenticated) return;
    if (event.status !== 'on_sale') return;

    // Check if already in queue or active
    const checkQueue = async () => {
      await checkQueueStatus(eventId);
    };
    checkQueue();

    // Poll queue status
    const interval = setInterval(checkQueue, 2000);
    return () => clearInterval(interval);
  }, [event, eventId, isAuthenticated, checkQueueStatus]);

  // Load section seats when selected
  useEffect(() => {
    if (!selectedSection) {
      setSectionSeats([]);
      return;
    }

    const fetchSeats = async () => {
      try {
        const response = await seatsApi.getSectionSeats(eventId, selectedSection);
        setSectionSeats(response.data || []);
      } catch (err) {
        console.error('Failed to load section seats:', err);
      }
    };

    fetchSeats();
  }, [eventId, selectedSection]);

  const handleSeatClick = useCallback(
    (seat: Seat) => {
      const isSelected = selectedSeats.some((s) => s.id === seat.id);
      if (isSelected) {
        deselectSeat(seat.id);
      } else {
        selectSeat(seat);
      }
    },
    [selectedSeats, selectSeat, deselectSeat]
  );

  const handleReserve = async () => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    try {
      await reserveSeats(eventId);
    } catch {
      // Error handled by store
    }
  };

  const handleCheckout = async () => {
    try {
      const result = await checkout('card');
      navigate({ to: '/orders/$orderId', params: { orderId: result.orderId } });
    } catch {
      // Error handled by store
    }
  };

  const handleJoinQueue = async () => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }
    await joinQueue(eventId);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-ticketmaster-blue"></div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8 text-center">
        <p className="text-red-600 mb-4">{error || 'Event not found'}</p>
        <Link to="/" className="text-ticketmaster-blue hover:underline">
          Back to events
        </Link>
      </div>
    );
  }

  const eventDate = new Date(event.event_date);
  const onSaleDate = new Date(event.on_sale_date);
  const now = new Date();
  const isOnSale = event.status === 'on_sale';
  const isUpcoming = event.status === 'upcoming' && now < onSaleDate;

  // Show waiting room if needed
  if (
    event.waiting_room_enabled &&
    isAuthenticated &&
    queueStatus?.status === 'waiting' &&
    queueStatus.position > 0
  ) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <WaitingRoom queueStatus={queueStatus} onLeave={() => leaveQueue(eventId)} />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Back link */}
      <Link to="/" className="text-ticketmaster-blue hover:underline mb-4 inline-block">
        &larr; Back to events
      </Link>

      {/* Event header */}
      <div className="bg-white rounded-lg shadow-lg overflow-hidden mb-8">
        <div className="md:flex">
          <div className="md:w-1/3">
            {event.image_url ? (
              <img
                src={event.image_url}
                alt={event.name}
                className="w-full h-64 md:h-full object-cover"
              />
            ) : (
              <div className="w-full h-64 md:h-full bg-gray-200 flex items-center justify-center">
                <svg className="w-16 h-16 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
            )}
          </div>
          <div className="p-6 md:w-2/3">
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-1 bg-gray-100 rounded text-sm capitalize">
                {event.category}
              </span>
              {event.waiting_room_enabled && (
                <span className="px-2 py-1 bg-orange-100 text-orange-800 rounded text-sm">
                  High Demand
                </span>
              )}
            </div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">{event.name}</h1>
            {event.artist && <p className="text-xl text-gray-600 mb-4">{event.artist}</p>}

            <div className="space-y-2 text-gray-600 mb-4">
              <div className="flex items-center">
                <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                {eventDate.toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}{' '}
                at{' '}
                {eventDate.toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </div>
              <div className="flex items-center">
                <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {event.venue.name}, {event.venue.city}
                {event.venue.state && `, ${event.venue.state}`}
              </div>
            </div>

            {event.description && (
              <p className="text-gray-600 mb-4">{event.description}</p>
            )}

            {isUpcoming && (
              <div className="bg-orange-50 text-orange-800 px-4 py-3 rounded-lg">
                <p className="font-medium">Tickets on sale:</p>
                <p>
                  {onSaleDate.toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                  })}{' '}
                  at{' '}
                  {onSaleDate.toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            )}

            {event.status === 'sold_out' && (
              <div className="bg-red-50 text-red-800 px-4 py-3 rounded-lg">
                <p className="font-medium">Sold Out</p>
              </div>
            )}

            {isOnSale && event.waiting_room_enabled && !queueStatus && (
              <button
                onClick={handleJoinQueue}
                className="mt-4 bg-ticketmaster-blue hover:bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold transition-colors"
              >
                Enter Waiting Room
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Seat selection */}
      {isOnSale && (!event.waiting_room_enabled || queueStatus?.status === 'active') && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            {/* Section selection */}
            {!selectedSection ? (
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-xl font-semibold mb-4">Select a Section</h2>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {sections.map((section) => (
                    <button
                      key={section.section}
                      onClick={() => setSelectedSection(section.section)}
                      disabled={section.available === 0}
                      className={`p-4 rounded-lg border-2 transition-colors text-left ${
                        section.available === 0
                          ? 'border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed'
                          : 'border-gray-200 hover:border-ticketmaster-blue'
                      }`}
                    >
                      <div className="font-semibold">{section.section}</div>
                      <div className="text-sm text-gray-600">
                        {section.available} / {section.total} available
                      </div>
                      <div className="text-sm font-medium text-ticketmaster-blue">
                        ${section.min_price.toFixed(0)}
                        {section.min_price !== section.max_price && ` - $${section.max_price.toFixed(0)}`}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                <button
                  onClick={() => {
                    setSelectedSection(null);
                    clearSelection();
                  }}
                  className="text-ticketmaster-blue hover:underline mb-4"
                >
                  &larr; Back to sections
                </button>
                <SeatMap
                  section={selectedSection}
                  seats={sectionSeats}
                  selectedSeats={selectedSeats}
                  onSeatClick={handleSeatClick}
                />
              </div>
            )}
          </div>

          {/* Checkout summary */}
          <div>
            {ticketError && (
              <div className="bg-red-50 text-red-600 px-4 py-2 rounded-lg text-sm mb-4">
                {ticketError}
                <button onClick={clearError} className="ml-2 underline">
                  Dismiss
                </button>
              </div>
            )}
            <CheckoutSummary
              selectedSeats={selectedSeats}
              reservation={reservation}
              timer={checkoutTimer}
              onReserve={handleReserve}
              onCheckout={handleCheckout}
              onClear={clearSelection}
              isLoading={ticketLoading}
              isAuthenticated={isAuthenticated}
            />
          </div>
        </div>
      )}
    </div>
  );
}
