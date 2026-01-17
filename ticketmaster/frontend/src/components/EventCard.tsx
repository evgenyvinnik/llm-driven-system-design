import { Link } from '@tanstack/react-router';
import type { Event } from '../types';

interface EventCardProps {
  event: Event;
}

export function EventCard({ event }: EventCardProps) {
  const eventDate = new Date(event.event_date);
  const onSaleDate = new Date(event.on_sale_date);
  const now = new Date();
  const isOnSale = event.status === 'on_sale' || (event.status === 'upcoming' && now >= onSaleDate);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'concert':
        return 'bg-purple-100 text-purple-800';
      case 'sports':
        return 'bg-green-100 text-green-800';
      case 'theater':
        return 'bg-red-100 text-red-800';
      case 'comedy':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusBadge = () => {
    if (event.status === 'sold_out') {
      return <span className="bg-red-500 text-white px-2 py-1 rounded text-xs font-medium">Sold Out</span>;
    }
    if (event.status === 'cancelled') {
      return <span className="bg-gray-500 text-white px-2 py-1 rounded text-xs font-medium">Cancelled</span>;
    }
    if (event.status === 'upcoming' && now < onSaleDate) {
      return (
        <span className="bg-orange-500 text-white px-2 py-1 rounded text-xs font-medium">
          On Sale {formatDate(onSaleDate)}
        </span>
      );
    }
    if (event.available_seats > 0) {
      return <span className="bg-green-500 text-white px-2 py-1 rounded text-xs font-medium">On Sale</span>;
    }
    return null;
  };

  return (
    <Link
      to="/events/$eventId"
      params={{ eventId: event.id }}
      className="block bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition-shadow"
    >
      <div className="relative h-48 bg-gray-200">
        {event.image_url ? (
          <img
            src={event.image_url}
            alt={event.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-16 h-16 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
              />
            </svg>
          </div>
        )}
        <div className="absolute top-2 right-2">{getStatusBadge()}</div>
      </div>

      <div className="p-4">
        <div className="flex items-center space-x-2 mb-2">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${getCategoryColor(event.category)}`}>
            {event.category.charAt(0).toUpperCase() + event.category.slice(1)}
          </span>
          {event.waiting_room_enabled && (
            <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded text-xs font-medium">
              High Demand
            </span>
          )}
        </div>

        <h3 className="font-bold text-lg text-gray-900 mb-1 line-clamp-2">{event.name}</h3>

        {event.artist && (
          <p className="text-gray-600 text-sm mb-2">{event.artist}</p>
        )}

        <div className="text-sm text-gray-500 space-y-1">
          <div className="flex items-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            {formatDate(eventDate)} at {formatTime(eventDate)}
          </div>
          <div className="flex items-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {event.venue.name}, {event.venue.city}
          </div>
        </div>

        {isOnSale && event.available_seats > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <span className="text-sm text-gray-500">
              {event.available_seats.toLocaleString()} seats available
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}
