/**
 * @fileoverview App analytics tab component for developer dashboard.
 * Displays key metrics including downloads, revenue, ratings, and reviews.
 */

import type { App, Review } from '../../types';
import { StarRating } from '../AppCard';

/**
 * Props for the AppAnalyticsTab component.
 */
interface AppAnalyticsTabProps {
  /** App data with metrics */
  app: App;
  /** Array of reviews for review count */
  reviews: Review[];
}

/**
 * Displays analytics metrics in a grid layout.
 * Shows downloads, estimated revenue, rating, and review count.
 *
 * @param props - Component props
 * @returns Analytics grid with metric cards
 */
export function AppAnalyticsTab({ app, reviews }: AppAnalyticsTabProps) {
  return (
    <div className="grid grid-cols-2 gap-6">
      <DownloadsCard downloadCount={app.downloadCount} />
      <RevenueCard
        downloadCount={app.downloadCount}
        price={app.price}
        isFree={app.isFree}
      />
      <RatingCard
        averageRating={app.averageRating}
        ratingCount={app.ratingCount}
      />
      <ReviewCountCard reviewCount={reviews.length} />
    </div>
  );
}

/**
 * Props for the DownloadsCard component.
 */
interface DownloadsCardProps {
  /** Total download count */
  downloadCount: number;
}

/**
 * Displays total download count metric.
 *
 * @param props - Component props
 * @returns Download count card
 */
function DownloadsCard({ downloadCount }: DownloadsCardProps) {
  return (
    <div className="card p-6">
      <h3 className="text-lg font-bold text-gray-900 mb-4">Downloads</h3>
      <div className="text-4xl font-bold text-primary-600 mb-2">
        {downloadCount.toLocaleString()}
      </div>
      <p className="text-gray-500">Total downloads</p>
    </div>
  );
}

/**
 * Props for the RevenueCard component.
 */
interface RevenueCardProps {
  /** Total download count */
  downloadCount: number;
  /** App price */
  price: number;
  /** Whether the app is free */
  isFree: boolean;
}

/**
 * Displays estimated revenue metric.
 * Calculates based on 70% revenue share for developers.
 *
 * @param props - Component props
 * @returns Revenue card with estimated earnings
 */
function RevenueCard({ downloadCount, price, isFree }: RevenueCardProps) {
  const estimatedRevenue = isFree ? 0 : price * downloadCount * 0.7;

  return (
    <div className="card p-6">
      <h3 className="text-lg font-bold text-gray-900 mb-4">Revenue</h3>
      <div className="text-4xl font-bold text-green-600 mb-2">
        $
        {estimatedRevenue.toLocaleString(undefined, {
          minimumFractionDigits: 2,
        })}
      </div>
      <p className="text-gray-500">Estimated earnings (70% share)</p>
    </div>
  );
}

/**
 * Props for the RatingCard component.
 */
interface RatingCardProps {
  /** Average rating value */
  averageRating: number;
  /** Total number of ratings */
  ratingCount: number;
}

/**
 * Displays average rating with star visualization.
 *
 * @param props - Component props
 * @returns Rating card with stars and count
 */
function RatingCard({ averageRating, ratingCount }: RatingCardProps) {
  return (
    <div className="card p-6">
      <h3 className="text-lg font-bold text-gray-900 mb-4">Rating</h3>
      <div className="flex items-center gap-3">
        <div className="text-4xl font-bold text-yellow-600">
          {averageRating.toFixed(1)}
        </div>
        <StarRating rating={averageRating} size="large" />
      </div>
      <p className="text-gray-500 mt-2">
        {ratingCount.toLocaleString()} ratings
      </p>
    </div>
  );
}

/**
 * Props for the ReviewCountCard component.
 */
interface ReviewCountCardProps {
  /** Number of written reviews */
  reviewCount: number;
}

/**
 * Displays the count of written reviews.
 *
 * @param props - Component props
 * @returns Review count card
 */
function ReviewCountCard({ reviewCount }: ReviewCountCardProps) {
  return (
    <div className="card p-6">
      <h3 className="text-lg font-bold text-gray-900 mb-4">Reviews</h3>
      <div className="text-4xl font-bold text-blue-600 mb-2">{reviewCount}</div>
      <p className="text-gray-500">Written reviews</p>
    </div>
  );
}
