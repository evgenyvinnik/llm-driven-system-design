import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { listingsAPI } from '../services/api';
import { Listing } from '../types';
import { ListingCard } from '../components/ListingCard';
import { SearchBar } from '../components/SearchBar';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const [listings, setListings] = useState<Listing[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadListings = async () => {
      try {
        const response = await listingsAPI.getAll({ limit: 12 });
        setListings(response.listings);
      } catch (err) {
        console.error('Failed to load listings:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadListings();
  }, []);

  return (
    <div>
      {/* Hero Section */}
      <div className="relative bg-gradient-to-r from-rose-500 to-pink-500 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
          <h1 className="text-5xl font-bold mb-6">
            Find your next adventure
          </h1>
          <p className="text-xl mb-8 max-w-2xl">
            Discover unique stays and experiences around the world. Book homes, apartments, and more.
          </p>
          <div className="max-w-4xl">
            <SearchBar />
          </div>
        </div>
      </div>

      {/* Featured Listings */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <h2 className="text-2xl font-bold mb-8">Featured places to stay</h2>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="animate-pulse">
                <div className="aspect-[4/3] bg-gray-200 rounded-xl mb-3" />
                <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
                <div className="h-4 bg-gray-200 rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : listings.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {listings.map((listing) => (
              <ListingCard key={listing.id} listing={listing} />
            ))}
          </div>
        ) : (
          <div className="text-center py-12">
            <p className="text-gray-500 mb-4">No listings available yet.</p>
            <Link to="/become-host" className="btn-primary">
              Be the first host
            </Link>
          </div>
        )}

        {listings.length > 0 && (
          <div className="text-center mt-12">
            <Link to="/search" className="btn-secondary">
              Show all listings
            </Link>
          </div>
        )}
      </div>

      {/* Categories */}
      <div className="bg-gray-50 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold mb-8">Browse by property type</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { type: 'house', label: 'Houses', icon: '🏠' },
              { type: 'apartment', label: 'Apartments', icon: '🏢' },
              { type: 'cabin', label: 'Cabins', icon: '🏕️' },
              { type: 'villa', label: 'Villas', icon: '🏛️' },
            ].map(({ type, label, icon }) => (
              <Link
                key={type}
                to="/search"
                search={{ property_type: type }}
                className="bg-white p-6 rounded-xl shadow-sm hover:shadow-md transition-shadow"
              >
                <span className="text-4xl mb-2 block">{icon}</span>
                <span className="font-medium">{label}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Become a Host CTA */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="bg-gradient-to-r from-rose-100 to-pink-100 rounded-2xl p-12 flex flex-col md:flex-row items-center justify-between">
          <div className="mb-6 md:mb-0">
            <h2 className="text-3xl font-bold mb-2">Become a Host</h2>
            <p className="text-gray-700">
              Earn extra income and unlock new opportunities by sharing your space.
            </p>
          </div>
          <Link to="/become-host" className="btn-primary">
            Learn more
          </Link>
        </div>
      </div>
    </div>
  );
}
