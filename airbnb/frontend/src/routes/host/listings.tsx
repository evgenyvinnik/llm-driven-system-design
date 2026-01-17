import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { listingsAPI } from '../../services/api';
import { Listing } from '../../types';
import { useAuthStore } from '../../stores/authStore';
import { formatCurrency, formatRating } from '../../utils/helpers';

export const Route = createFileRoute('/host/listings')({
  component: HostListingsPage,
});

function HostListingsPage() {
  const { user, isAuthenticated } = useAuthStore();
  const [listings, setListings] = useState<Listing[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated || !user?.is_host) return;

    const loadListings = async () => {
      try {
        const response = await listingsAPI.getMyListings();
        setListings(response.listings);
      } catch (err) {
        console.error('Failed to load listings:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadListings();
  }, [isAuthenticated, user?.is_host]);

  if (!isAuthenticated) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
        <h1 className="text-2xl font-bold mb-4">Log in to manage listings</h1>
        <Link to="/login" className="btn-primary">
          Log in
        </Link>
      </div>
    );
  }

  if (!user?.is_host) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
        <h1 className="text-2xl font-bold mb-4">Become a host first</h1>
        <Link to="/become-host" className="btn-primary">
          Become a Host
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">Your Listings</h1>
        <Link to="/host/listings/new" className="btn-primary">
          Create new listing
        </Link>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="animate-pulse flex gap-4 p-4 border border-gray-200 rounded-xl">
              <div className="w-32 h-24 bg-gray-200 rounded-lg" />
              <div className="flex-1 space-y-2">
                <div className="h-4 bg-gray-200 rounded w-1/3" />
                <div className="h-4 bg-gray-200 rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : listings.length > 0 ? (
        <div className="space-y-4">
          {listings.map((listing) => (
            <div
              key={listing.id}
              className="flex gap-6 p-4 border border-gray-200 rounded-xl hover:shadow-md transition-shadow"
            >
              <div className="w-32 h-24 rounded-lg overflow-hidden shrink-0">
                <img
                  src={listing.primary_photo || `https://picsum.photos/seed/${listing.id}/200/150`}
                  alt={listing.title}
                  className="w-full h-full object-cover"
                />
              </div>

              <div className="flex-1">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold">{listing.title}</h3>
                    <p className="text-sm text-gray-500">
                      {[listing.city, listing.state, listing.country].filter(Boolean).join(', ')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {listing.rating && (
                      <span className="flex items-center gap-1 text-sm">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                        {formatRating(listing.rating)}
                      </span>
                    )}
                    <span className={`px-2 py-1 rounded text-xs font-medium ${listing.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                      {listing.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-4 mt-3 text-sm">
                  <span>{formatCurrency(listing.price_per_night)}/night</span>
                  <span className="text-gray-400">|</span>
                  <span>{listing.review_count} reviews</span>
                </div>

                <div className="flex gap-3 mt-4">
                  <Link
                    to={`/host/listings/${listing.id}/edit`}
                    className="text-sm text-gray-600 hover:text-gray-900"
                  >
                    Edit
                  </Link>
                  <Link
                    to={`/host/listings/${listing.id}/calendar`}
                    className="text-sm text-gray-600 hover:text-gray-900"
                  >
                    Calendar
                  </Link>
                  <Link
                    to={`/listing/${listing.id}`}
                    className="text-sm text-gray-600 hover:text-gray-900"
                  >
                    View
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 border-2 border-dashed border-gray-300 rounded-xl">
          <p className="text-gray-500 text-lg mb-4">You haven't created any listings yet</p>
          <Link to="/host/listings/new" className="btn-primary">
            Create your first listing
          </Link>
        </div>
      )}
    </div>
  );
}
