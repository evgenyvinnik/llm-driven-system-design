import React from 'react';
import { StatCard } from '../common';
import type { SystemStats } from '../../types';
import { formatBytes } from '../../utils/helpers';

/**
 * Props for the OverviewTab component.
 */
export interface OverviewTabProps {
  /** System statistics to display */
  stats: SystemStats;
  /** Whether cleanup/purge operations are in progress */
  isCleaningUp: boolean;
  /** Handler for cleanup orphaned chunks action */
  onCleanupChunks: () => void;
  /** Handler for purge deleted files action */
  onPurgeDeleted: () => void;
}

/**
 * Overview tab content for the admin dashboard.
 *
 * Displays system-wide statistics organized into sections:
 * - Users: total, new (24h), storage used/quota
 * - Files: total, folders, size, deleted
 * - Photos: total, favorites, deleted
 * - Devices: total, active (24h/7d)
 * - Sync Operations (24h): completed, failed, conflicts
 * - Storage Optimization: chunks, dedup savings, maintenance actions
 *
 * @param props - Component props
 * @returns Overview statistics grid with maintenance actions
 */
export const OverviewTab: React.FC<OverviewTabProps> = ({
  stats,
  isCleaningUp,
  onCleanupChunks,
  onPurgeDeleted,
}) => {
  return (
    <div className="space-y-6">
      {/* User stats */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Users</h2>
        <div className="grid grid-cols-4 gap-4">
          <StatCard title="Total Users" value={stats.users.total} color="blue" />
          <StatCard title="New (24h)" value={stats.users.new24h} color="green" />
          <StatCard
            title="Storage Used"
            value={formatBytes(stats.users.storageUsed)}
            subtitle={`of ${formatBytes(stats.users.storageQuota)}`}
            color="purple"
          />
          <StatCard
            title="Storage %"
            value={`${Math.round((stats.users.storageUsed / stats.users.storageQuota) * 100)}%`}
            color="yellow"
          />
        </div>
      </section>

      {/* File stats */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Files</h2>
        <div className="grid grid-cols-4 gap-4">
          <StatCard title="Total Files" value={stats.files.total} color="blue" />
          <StatCard title="Folders" value={stats.files.folders} color="blue" />
          <StatCard title="Total Size" value={formatBytes(stats.files.totalSize)} color="purple" />
          <StatCard title="Deleted" value={stats.files.deleted} color="red" />
        </div>
      </section>

      {/* Photo stats */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Photos</h2>
        <div className="grid grid-cols-3 gap-4">
          <StatCard title="Total Photos" value={stats.photos.total} color="blue" />
          <StatCard title="Favorites" value={stats.photos.favorites} color="yellow" />
          <StatCard title="Deleted" value={stats.photos.deleted} color="red" />
        </div>
      </section>

      {/* Device stats */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Devices</h2>
        <div className="grid grid-cols-3 gap-4">
          <StatCard title="Total Devices" value={stats.devices.total} color="blue" />
          <StatCard title="Active (24h)" value={stats.devices.active24h} color="green" />
          <StatCard title="Active (7d)" value={stats.devices.active7d} color="green" />
        </div>
      </section>

      {/* Sync stats */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Sync Operations (24h)</h2>
        <div className="grid grid-cols-4 gap-4">
          <StatCard title="Total" value={stats.sync.operations24h} color="blue" />
          <StatCard title="Completed" value={stats.sync.completed} color="green" />
          <StatCard title="Failed" value={stats.sync.failed} color="red" />
          <StatCard title="Conflicts" value={stats.sync.conflicts} color="yellow" />
        </div>
      </section>

      {/* Chunk stats and maintenance */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Storage Optimization</h2>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <StatCard title="Total Chunks" value={stats.chunks.total} color="blue" />
          <StatCard title="Chunk Storage" value={formatBytes(stats.chunks.storageUsed)} color="purple" />
          <StatCard
            title="Dedup Savings"
            value={formatBytes(stats.chunks.dedupSavings)}
            subtitle="Space saved by deduplication"
            color="green"
          />
        </div>

        <div className="flex gap-4">
          <button
            onClick={onCleanupChunks}
            disabled={isCleaningUp}
            className="px-4 py-2 bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50"
          >
            {isCleaningUp ? 'Cleaning...' : 'Cleanup Orphaned Chunks'}
          </button>
          <button
            onClick={onPurgeDeleted}
            disabled={isCleaningUp}
            className="px-4 py-2 bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-50"
          >
            {isCleaningUp ? 'Purging...' : 'Purge Deleted Files (30+ days)'}
          </button>
        </div>
      </section>
    </div>
  );
};
