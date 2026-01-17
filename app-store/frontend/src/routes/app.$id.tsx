import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useCatalogStore } from '../stores/catalogStore';
import { AppCard, StarRating } from '../components/AppCard';
import { ReviewCard, RatingBar } from '../components/ReviewCard';

export const Route = createFileRoute('/app/$id')({
  component: AppDetailPage,
});

function AppDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const {
    currentApp,
    currentReviews,
    currentRatings,
    fetchApp,
    fetchReviews,
    fetchRatings,
    clearCurrentApp,
    isLoading,
  } = useCatalogStore();

  useEffect(() => {
    fetchApp(id);
    fetchReviews(id);
    fetchRatings(id);

    return () => {
      clearCurrentApp();
    };
  }, [id, fetchApp, fetchReviews, fetchRatings, clearCurrentApp]);

  if (isLoading || !currentApp) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse">
          <div className="flex gap-6 mb-8">
            <div className="w-32 h-32 bg-gray-200 rounded-2xl" />
            <div className="flex-1">
              <div className="h-8 bg-gray-200 rounded w-1/3 mb-2" />
              <div className="h-4 bg-gray-200 rounded w-1/4 mb-4" />
              <div className="h-10 bg-gray-200 rounded w-24" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  const formatSize = (bytes: number | null) => {
    if (!bytes) return 'Unknown';
    if (bytes >= 1000000000) return `${(bytes / 1000000000).toFixed(1)} GB`;
    if (bytes >= 1000000) return `${(bytes / 1000000).toFixed(0)} MB`;
    return `${(bytes / 1000).toFixed(0)} KB`;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* App Header */}
      <section className="flex gap-6 mb-8">
        {currentApp.iconUrl ? (
          <img
            src={currentApp.iconUrl}
            alt={currentApp.name}
            className="w-32 h-32 app-icon object-cover"
          />
        ) : (
          <div className="w-32 h-32 app-icon bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-white font-bold text-4xl">
            {currentApp.name.charAt(0)}
          </div>
        )}

        <div className="flex-1">
          <h1 className="text-3xl font-bold text-gray-900 mb-1">{currentApp.name}</h1>
          <p className="text-lg text-primary-600 mb-2">
            {currentApp.developer?.name || 'Unknown Developer'}
          </p>

          <div className="flex items-center gap-4 mb-4">
            <StarRating rating={currentApp.averageRating} size="large" showValue />
            <span className="text-gray-500">
              ({currentApp.ratingCount.toLocaleString()} ratings)
            </span>
          </div>

          <div className="flex items-center gap-4">
            <button className="btn btn-primary px-8 py-3 text-lg">
              {currentApp.isFree ? 'Get' : `$${currentApp.price.toFixed(2)}`}
            </button>
            <span className="text-sm text-gray-500">{currentApp.ageRating}</span>
          </div>
        </div>
      </section>

      {/* Screenshots */}
      {currentApp.screenshots && currentApp.screenshots.length > 0 && (
        <section className="mb-8">
          <div className="flex gap-4 overflow-x-auto pb-4">
            {currentApp.screenshots.map((screenshot) => (
              <img
                key={screenshot.id}
                src={screenshot.url}
                alt="Screenshot"
                className="h-80 w-auto rounded-xl shadow-md"
              />
            ))}
          </div>
        </section>
      )}

      {/* App Info Grid */}
      <section className="grid grid-cols-4 gap-4 mb-8">
        <div className="card p-4 text-center">
          <p className="text-sm text-gray-500 mb-1">Downloads</p>
          <p className="text-xl font-bold text-gray-900">
            {currentApp.downloadCount.toLocaleString()}
          </p>
        </div>
        <div className="card p-4 text-center">
          <p className="text-sm text-gray-500 mb-1">Size</p>
          <p className="text-xl font-bold text-gray-900">{formatSize(currentApp.sizeBytes)}</p>
        </div>
        <div className="card p-4 text-center">
          <p className="text-sm text-gray-500 mb-1">Version</p>
          <p className="text-xl font-bold text-gray-900">{currentApp.version || '1.0'}</p>
        </div>
        <div className="card p-4 text-center">
          <p className="text-sm text-gray-500 mb-1">Category</p>
          <p className="text-xl font-bold text-gray-900">{currentApp.category?.name || 'Apps'}</p>
        </div>
      </section>

      {/* Description */}
      <section className="card p-6 mb-8">
        <h2 className="text-xl font-bold text-gray-900 mb-4">Description</h2>
        <p className="text-gray-700 whitespace-pre-line">{currentApp.description}</p>

        {currentApp.releaseNotes && (
          <div className="mt-6 pt-6 border-t border-gray-100">
            <h3 className="font-semibold text-gray-900 mb-2">What's New</h3>
            <p className="text-gray-700">{currentApp.releaseNotes}</p>
          </div>
        )}
      </section>

      {/* Ratings & Reviews */}
      <section className="card p-6 mb-8">
        <h2 className="text-xl font-bold text-gray-900 mb-6">Ratings & Reviews</h2>

        <div className="grid md:grid-cols-3 gap-8 mb-6">
          {/* Rating Summary */}
          <div className="text-center">
            <div className="text-6xl font-bold text-gray-900 mb-2">
              {currentRatings?.averageRating.toFixed(1) || '0.0'}
            </div>
            <StarRating rating={currentRatings?.averageRating || 0} size="large" />
            <p className="text-sm text-gray-500 mt-2">
              {currentRatings?.totalRatings.toLocaleString() || 0} ratings
            </p>
          </div>

          {/* Rating Distribution */}
          <div className="col-span-2 space-y-2">
            {[5, 4, 3, 2, 1].map((star) => (
              <RatingBar
                key={star}
                star={star}
                count={currentRatings?.distribution[star] || 0}
                total={currentRatings?.totalRatings || 0}
              />
            ))}
          </div>
        </div>

        {/* Reviews List */}
        <div className="border-t border-gray-100 pt-6">
          {currentReviews.length === 0 ? (
            <p className="text-center text-gray-500 py-8">No reviews yet</p>
          ) : (
            currentReviews.map((review) => (
              <ReviewCard key={review.id} review={review} />
            ))
          )}
        </div>
      </section>

      {/* Similar Apps */}
      {currentApp.similarApps && currentApp.similarApps.length > 0 && (
        <section className="card p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-4">You Might Also Like</h2>
          <div className="grid md:grid-cols-2 gap-2">
            {currentApp.similarApps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                size="small"
                onClick={() => navigate({ to: '/app/$id', params: { id: app.id! } })}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
