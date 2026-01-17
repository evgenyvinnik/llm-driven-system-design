import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { listingsAPI, reviewsAPI } from '../services/api';
import { Listing, Review } from '../types';
import { BookingWidget } from '../components/BookingWidget';
import { formatCurrency, formatRating, getAmenityLabel, getRoomTypeLabel, formatDate } from '../utils/helpers';

export const Route = createFileRoute('/listing/$id')({
  component: ListingDetailPage,
});

function ListingDetailPage() {
  const { id } = Route.useParams();
  const [listing, setListing] = useState<Listing | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewStats, setReviewStats] = useState<{
    total: number;
    avg_rating: number;
    avg_cleanliness: number;
    avg_communication: number;
    avg_location: number;
    avg_value: number;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activePhoto, setActivePhoto] = useState(0);

  useEffect(() => {
    const loadData = async () => {
      try {
        const [listingRes, reviewsRes] = await Promise.all([
          listingsAPI.getById(parseInt(id)),
          reviewsAPI.getForListing(parseInt(id)),
        ]);
        setListing(listingRes.listing);
        setReviews(reviewsRes.reviews);
        setReviewStats(reviewsRes.stats);
      } catch (err) {
        console.error('Failed to load listing:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [id]);

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/2 mb-4" />
          <div className="aspect-[16/9] bg-gray-200 rounded-xl mb-8" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
            <div className="lg:col-span-2 space-y-4">
              <div className="h-4 bg-gray-200 rounded w-3/4" />
              <div className="h-4 bg-gray-200 rounded w-1/2" />
              <div className="h-4 bg-gray-200 rounded w-2/3" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!listing) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
        <h1 className="text-2xl font-bold mb-4">Listing not found</h1>
        <p className="text-gray-500">This listing may have been removed or is no longer available.</p>
      </div>
    );
  }

  const photos = listing.photos || [];
  const primaryPhoto = photos.length > 0 ? photos[activePhoto]?.url : `https://picsum.photos/seed/${listing.id}/800/600`;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Title */}
      <h1 className="text-3xl font-bold mb-2">{listing.title}</h1>
      <div className="flex items-center gap-4 text-sm mb-6">
        {listing.rating && (
          <div className="flex items-center gap-1">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
            <span className="font-medium">{formatRating(listing.rating)}</span>
            <span className="text-gray-500">({listing.review_count} reviews)</span>
          </div>
        )}
        <span className="text-gray-500">
          {[listing.city, listing.state, listing.country].filter(Boolean).join(', ')}
        </span>
      </div>

      {/* Photos */}
      <div className="mb-8">
        <div className="aspect-[16/9] rounded-xl overflow-hidden mb-2">
          <img
            src={primaryPhoto}
            alt={listing.title}
            className="w-full h-full object-cover"
          />
        </div>
        {photos.length > 1 && (
          <div className="flex gap-2 overflow-x-auto">
            {photos.map((photo, index) => (
              <button
                key={photo.id}
                onClick={() => setActivePhoto(index)}
                className={`shrink-0 w-20 h-20 rounded-lg overflow-hidden ${
                  index === activePhoto ? 'ring-2 ring-gray-900' : ''
                }`}
              >
                <img
                  src={photo.url}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
        {/* Main Content */}
        <div className="lg:col-span-2">
          {/* Host Info */}
          <div className="flex items-center justify-between pb-6 border-b border-gray-200">
            <div>
              <h2 className="text-xl font-semibold">
                {getRoomTypeLabel(listing.room_type)} hosted by {listing.host_name}
              </h2>
              <p className="text-gray-500">
                {listing.max_guests} guests · {listing.bedrooms} bedrooms · {listing.beds} beds · {listing.bathrooms} baths
              </p>
            </div>
            <div className="w-14 h-14 rounded-full bg-gray-200 overflow-hidden">
              {listing.host_avatar ? (
                <img src={listing.host_avatar} alt={listing.host_name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400">
                  <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                  </svg>
                </div>
              )}
            </div>
          </div>

          {/* Features */}
          <div className="py-6 border-b border-gray-200 space-y-4">
            {listing.instant_book && (
              <div className="flex gap-4">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <div>
                  <h3 className="font-medium">Instant Book</h3>
                  <p className="text-gray-500 text-sm">Book immediately without waiting for host approval</p>
                </div>
              </div>
            )}
            {listing.host_verified && (
              <div className="flex gap-4">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                <div>
                  <h3 className="font-medium">Verified Host</h3>
                  <p className="text-gray-500 text-sm">{listing.host_name} has verified their identity</p>
                </div>
              </div>
            )}
          </div>

          {/* Description */}
          <div className="py-6 border-b border-gray-200">
            <h2 className="text-xl font-semibold mb-4">About this place</h2>
            <p className="text-gray-700 whitespace-pre-wrap">{listing.description}</p>
          </div>

          {/* Amenities */}
          <div className="py-6 border-b border-gray-200">
            <h2 className="text-xl font-semibold mb-4">What this place offers</h2>
            <div className="grid grid-cols-2 gap-4">
              {listing.amenities.map((amenity) => (
                <div key={amenity} className="flex items-center gap-3">
                  <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span>{getAmenityLabel(amenity)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* House Rules */}
          {listing.house_rules && (
            <div className="py-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold mb-4">House rules</h2>
              <p className="text-gray-700 whitespace-pre-wrap">{listing.house_rules}</p>
            </div>
          )}

          {/* Reviews */}
          <div className="py-6">
            <div className="flex items-center gap-2 mb-6">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              <h2 className="text-xl font-semibold">
                {reviewStats ? `${reviewStats.avg_rating} · ${reviewStats.total} reviews` : 'No reviews yet'}
              </h2>
            </div>

            {reviewStats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                <div>
                  <span className="text-sm text-gray-500">Cleanliness</span>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1 bg-gray-200 rounded-full">
                      <div
                        className="h-full bg-gray-900 rounded-full"
                        style={{ width: `${(reviewStats.avg_cleanliness / 5) * 100}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium">{reviewStats.avg_cleanliness}</span>
                  </div>
                </div>
                <div>
                  <span className="text-sm text-gray-500">Communication</span>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1 bg-gray-200 rounded-full">
                      <div
                        className="h-full bg-gray-900 rounded-full"
                        style={{ width: `${(reviewStats.avg_communication / 5) * 100}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium">{reviewStats.avg_communication}</span>
                  </div>
                </div>
                <div>
                  <span className="text-sm text-gray-500">Location</span>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1 bg-gray-200 rounded-full">
                      <div
                        className="h-full bg-gray-900 rounded-full"
                        style={{ width: `${(reviewStats.avg_location / 5) * 100}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium">{reviewStats.avg_location}</span>
                  </div>
                </div>
                <div>
                  <span className="text-sm text-gray-500">Value</span>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1 bg-gray-200 rounded-full">
                      <div
                        className="h-full bg-gray-900 rounded-full"
                        style={{ width: `${(reviewStats.avg_value / 5) * 100}%` }}
                      />
                    </div>
                    <span className="text-sm font-medium">{reviewStats.avg_value}</span>
                  </div>
                </div>
              </div>
            )}

            {reviews.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {reviews.map((review) => (
                  <div key={review.id} className="border-b border-gray-100 pb-6">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-10 h-10 rounded-full bg-gray-200 overflow-hidden">
                        {review.author_avatar ? (
                          <img src={review.author_avatar} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400">
                            <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <div>
                        <p className="font-medium">{review.author_name}</p>
                        <p className="text-sm text-gray-500">{formatDate(review.created_at)}</p>
                      </div>
                    </div>
                    <p className="text-gray-700">{review.content}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-500">Be the first to leave a review!</p>
            )}
          </div>
        </div>

        {/* Booking Widget */}
        <div className="lg:col-span-1">
          <BookingWidget listing={listing} />
        </div>
      </div>
    </div>
  );
}
