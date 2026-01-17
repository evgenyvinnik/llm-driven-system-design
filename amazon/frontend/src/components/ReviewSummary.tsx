import type { ReviewSummary } from '../types';

interface RatingBarProps {
  label: string;
  count: number;
  total: number;
}

function RatingBar({ label, count, total }: RatingBarProps) {
  const percentage = total > 0 ? (count / total) * 100 : 0;

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-16 text-blue-600 hover:underline cursor-pointer">{label}</span>
      <div className="flex-1 bg-gray-200 rounded-full h-4">
        <div
          className="bg-amber-400 h-4 rounded-full"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="w-10 text-gray-500">{percentage.toFixed(0)}%</span>
    </div>
  );
}

interface ReviewSummaryCardProps {
  summary: ReviewSummary;
}

export function ReviewSummaryCard({ summary }: ReviewSummaryCardProps) {
  const total = parseInt(String(summary.total_reviews));
  const avgRating = parseFloat(summary.average_rating) || 0;

  return (
    <div className="bg-white p-6 rounded-lg border">
      <h3 className="text-lg font-bold mb-4">Customer Reviews</h3>

      <div className="flex items-center gap-2 mb-4">
        <div className="flex text-amber-400">
          {[1, 2, 3, 4, 5].map((star) => (
            <svg
              key={star}
              className={`w-6 h-6 ${
                star <= Math.round(avgRating) ? 'fill-current' : 'fill-gray-300'
              }`}
              viewBox="0 0 20 20"
            >
              <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
            </svg>
          ))}
        </div>
        <span className="text-lg font-bold">{avgRating.toFixed(1)} out of 5</span>
      </div>

      <p className="text-sm text-gray-500 mb-4">{total} global ratings</p>

      <div className="space-y-2">
        <RatingBar label="5 star" count={summary.five_star} total={total} />
        <RatingBar label="4 star" count={summary.four_star} total={total} />
        <RatingBar label="3 star" count={summary.three_star} total={total} />
        <RatingBar label="2 star" count={summary.two_star} total={total} />
        <RatingBar label="1 star" count={summary.one_star} total={total} />
      </div>
    </div>
  );
}
