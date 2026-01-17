/**
 * @fileoverview Overview tab component for the admin dashboard.
 * Displays system statistics including user counts, post metrics, and Elasticsearch stats.
 */

import { Users, FileText, Search, Database } from 'lucide-react';
import { StatCard } from './StatCard';
import type { AdminStats } from '../../types';

/**
 * Props for the OverviewTab component.
 */
interface OverviewTabProps {
  /** Admin statistics data */
  stats: AdminStats;
}

/**
 * Props for the breakdown panel components.
 */
interface BreakdownPanelProps {
  /** Panel title */
  title: string;
  /** Key-value pairs to display */
  data: Record<string, number>;
}

/**
 * Formats bytes to a human-readable string.
 *
 * @param bytes - Number of bytes to format
 * @returns Formatted string (e.g., "1.5 MB")
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Displays a breakdown panel with key-value pairs.
 *
 * @param props - BreakdownPanel props
 * @returns Panel with labeled values
 */
function BreakdownPanel({ title, data }: BreakdownPanelProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 col-span-1 md:col-span-2">
      <h3 className="font-semibold text-gray-900 mb-4">{title}</h3>
      <div className="space-y-2">
        {Object.entries(data).map(([key, value]) => (
          <div key={key} className="flex items-center justify-between">
            <span className="capitalize text-gray-600">{key}</span>
            <span className="font-medium text-gray-900">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Renders the overview tab with system statistics.
 * Shows user count, post metrics, search totals, and Elasticsearch info.
 *
 * @param props - OverviewTab props
 * @returns Grid of stat cards and breakdown panels
 */
export function OverviewTab({ stats }: OverviewTabProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      <StatCard
        icon={Users}
        label="Total Users"
        value={stats.users.total}
        color="blue"
      />
      <StatCard
        icon={FileText}
        label="Total Posts"
        value={stats.posts.total_posts}
        color="green"
      />
      <StatCard
        icon={FileText}
        label="Posts Today"
        value={stats.posts.posts_today}
        color="orange"
      />
      <StatCard
        icon={Search}
        label="Total Searches"
        value={stats.searches.total}
        color="purple"
      />

      {stats.elasticsearch && (
        <>
          <StatCard
            icon={Database}
            label="Indexed Docs"
            value={stats.elasticsearch.docs_count}
            color="teal"
          />
          <StatCard
            icon={Database}
            label="Index Size"
            value={formatBytes(stats.elasticsearch.store_size_bytes)}
            color="indigo"
          />
        </>
      )}

      <BreakdownPanel title="Posts by Visibility" data={stats.posts.by_visibility} />
      <BreakdownPanel title="Posts by Type" data={stats.posts.by_type} />
    </div>
  );
}
