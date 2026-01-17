import { Users, Store, MessageSquare, TrendingUp } from 'lucide-react';
import type { AdminStats } from '../../types';

/**
 * Props for the OverviewTab component.
 */
interface OverviewTabProps {
  /** Admin statistics data */
  stats: AdminStats;
}

/**
 * OverviewTab displays the admin dashboard overview with key metrics
 * and top cities information.
 *
 * @param props - Component properties
 * @returns Overview tab content
 */
export function OverviewTab({ stats }: OverviewTabProps) {
  return (
    <div>
      {/* Stats Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatsCard
          title="Total Users"
          value={stats.total_users}
          subtitle={`+${stats.new_users_last_7d} this week`}
          subtitleColor="green"
          icon={Users}
          iconColor="blue"
        />

        <StatsCard
          title="Total Businesses"
          value={stats.total_businesses}
          subtitle={`${stats.claimed_businesses} claimed`}
          subtitleColor="gray"
          icon={Store}
          iconColor="red"
        />

        <StatsCard
          title="Total Reviews"
          value={stats.total_reviews}
          subtitle={`+${stats.reviews_last_24h} today`}
          subtitleColor="green"
          icon={MessageSquare}
          iconColor="green"
        />

        <StatsCard
          title="Average Rating"
          value={stats.average_rating}
          icon={TrendingUp}
          iconColor="yellow"
        />
      </div>

      {/* Top Cities Section */}
      <TopCitiesCard cities={stats.top_cities} />
    </div>
  );
}

/**
 * Props for the StatsCard component.
 */
interface StatsCardProps {
  /** Card title */
  title: string;
  /** Main value to display */
  value: number | string;
  /** Optional subtitle text */
  subtitle?: string;
  /** Subtitle color theme */
  subtitleColor?: 'green' | 'gray';
  /** Icon component */
  icon: React.ComponentType<{ className?: string }>;
  /** Icon color theme */
  iconColor: 'blue' | 'red' | 'green' | 'yellow';
}

/**
 * StatsCard displays a single metric with an icon.
 *
 * @param props - Component properties
 * @returns Stats card component
 */
function StatsCard({ title, value, subtitle, subtitleColor, icon: Icon, iconColor }: StatsCardProps) {
  const iconColorClasses = {
    blue: 'text-yelp-blue',
    red: 'text-yelp-red',
    green: 'text-green-500',
    yellow: 'text-yellow-500',
  };

  const subtitleColorClasses = {
    green: 'text-green-600',
    gray: 'text-gray-600',
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-600">{title}</p>
          <p className="text-3xl font-bold text-gray-900">{value}</p>
        </div>
        <Icon className={`w-10 h-10 ${iconColorClasses[iconColor]} opacity-50`} />
      </div>
      {subtitle && (
        <p className={`text-sm mt-2 ${subtitleColorClasses[subtitleColor || 'gray']}`}>
          {subtitle}
        </p>
      )}
    </div>
  );
}

/**
 * Props for TopCitiesCard component.
 */
interface TopCitiesCardProps {
  /** Array of top cities with business counts */
  cities: Array<{ city: string; state: string; count: number }>;
}

/**
 * TopCitiesCard displays a list of cities with the most businesses.
 *
 * @param props - Component properties
 * @returns Top cities card component
 */
function TopCitiesCard({ cities }: TopCitiesCardProps) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold mb-4">Top Cities</h3>
      <div className="space-y-3">
        {cities.map((city, i) => (
          <div key={i} className="flex items-center justify-between">
            <span className="text-gray-700">
              {city.city}, {city.state}
            </span>
            <span className="text-gray-600">{city.count} businesses</span>
          </div>
        ))}
      </div>
    </div>
  );
}
