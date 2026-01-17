import { Users, Film, Eye, TrendingUp } from 'lucide-react';
import { StatCard } from './StatCard';
import type { AdminStats, AdminContent } from './types';

/**
 * Props for the OverviewTab component.
 */
interface OverviewTabProps {
  /** Platform statistics data */
  stats: AdminStats;
  /** Recent content items for preview list */
  recentContent: AdminContent[];
}

/**
 * Overview tab content for admin dashboard.
 * Displays platform statistics cards, subscription breakdown,
 * and a list of recent content items.
 *
 * Sections:
 * - Stats cards: Total users, content, views, and active subscriptions
 * - Subscription breakdown: Shows count per subscription tier
 * - Recent content: Preview list of latest content with status badges
 *
 * @param props - OverviewTabProps with stats and recentContent
 * @returns Overview tab layout with statistics and content preview
 */
export function OverviewTab({ stats, recentContent }: OverviewTabProps) {
  const totalSubscriptions = Object.values(stats.activeSubscriptions).reduce(
    (a, b) => a + b,
    0
  );

  return (
    <div className="space-y-8">
      {/* Stats cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          icon={<Users className="w-6 h-6" />}
          label="Total Users"
          value={stats.totalUsers}
          color="blue"
        />
        <StatCard
          icon={<Film className="w-6 h-6" />}
          label="Total Content"
          value={stats.totalContent}
          color="purple"
        />
        <StatCard
          icon={<Eye className="w-6 h-6" />}
          label="Total Views"
          value={stats.totalViews}
          color="green"
        />
        <StatCard
          icon={<TrendingUp className="w-6 h-6" />}
          label="Active Subscriptions"
          value={totalSubscriptions}
          color="orange"
        />
      </div>

      {/* Subscription breakdown */}
      <SubscriptionBreakdown subscriptions={stats.activeSubscriptions} />

      {/* Recent content */}
      <RecentContentList content={recentContent} />
    </div>
  );
}

/**
 * Props for the SubscriptionBreakdown component.
 */
interface SubscriptionBreakdownProps {
  /** Subscription counts by tier name */
  subscriptions: Record<string, number>;
}

/**
 * Displays subscription counts broken down by tier.
 * Shows each subscription tier with its current subscriber count.
 *
 * @param props - SubscriptionBreakdownProps with tier-to-count mapping
 * @returns Grid of subscription tier cards
 */
function SubscriptionBreakdown({ subscriptions }: SubscriptionBreakdownProps) {
  return (
    <div className="bg-apple-gray-800 rounded-2xl p-6">
      <h2 className="text-xl font-semibold mb-4">Subscription Breakdown</h2>
      <div className="grid grid-cols-2 gap-4">
        {Object.entries(subscriptions).map(([tier, count]) => (
          <div
            key={tier}
            className="flex items-center justify-between p-4 bg-apple-gray-700 rounded-xl"
          >
            <span className="capitalize">{tier}</span>
            <span className="text-2xl font-bold">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Props for the RecentContentList component.
 */
interface RecentContentListProps {
  /** Content items to display in the list */
  content: AdminContent[];
}

/**
 * Displays a list of recent content items with view counts and status.
 * Shows the 5 most recent content items by default.
 *
 * @param props - RecentContentListProps with content array
 * @returns Stacked list of content items with metadata
 */
function RecentContentList({ content }: RecentContentListProps) {
  return (
    <div className="bg-apple-gray-800 rounded-2xl p-6">
      <h2 className="text-xl font-semibold mb-4">Recent Content</h2>
      <div className="space-y-2">
        {content.slice(0, 5).map((item) => (
          <div
            key={item.id}
            className="flex items-center justify-between p-3 bg-apple-gray-700 rounded-lg"
          >
            <div>
              <span className="font-medium">{item.title}</span>
              <span className="text-sm text-white/60 ml-2 capitalize">
                ({item.content_type})
              </span>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-white/60">
                {item.view_count} views
              </span>
              <StatusBadge status={item.status} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Props for the StatusBadge component.
 */
interface StatusBadgeProps {
  /** Content status (e.g., 'ready', 'processing') */
  status: string;
}

/**
 * Displays a colored status badge based on content status.
 * Green for 'ready' status, yellow for other statuses.
 *
 * @param props - StatusBadgeProps with status string
 * @returns Colored badge element with status text
 */
function StatusBadge({ status }: StatusBadgeProps) {
  const isReady = status === 'ready';
  const classes = isReady
    ? 'bg-apple-green/20 text-apple-green'
    : 'bg-yellow-500/20 text-yellow-500';

  return <span className={`px-2 py-1 text-xs rounded ${classes}`}>{status}</span>;
}
