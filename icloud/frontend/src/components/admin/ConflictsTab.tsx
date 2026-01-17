import React from 'react';
import type { Conflict } from '../../types';
import { formatRelativeTime } from '../../utils/helpers';

/**
 * Props for the ConflictsTab component.
 */
export interface ConflictsTabProps {
  /** List of unresolved conflicts */
  conflicts: Conflict[];
}

/**
 * Extended conflict type with optional user email.
 */
interface ConflictWithEmail extends Conflict {
  userEmail?: string;
}

/**
 * Conflicts tab content for the admin dashboard.
 *
 * Displays a table of unresolved file conflicts across all users with:
 * - File name and path
 * - User email
 * - Device name
 * - Version number
 * - Creation timestamp
 *
 * @param props - Component props
 * @returns Table of conflicts or empty state message
 */
export const ConflictsTab: React.FC<ConflictsTabProps> = ({ conflicts }) => {
  if (conflicts.length === 0) {
    return (
      <div className="bg-white rounded-lg border">
        <div className="text-center py-8 text-gray-500">No unresolved conflicts</div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">File</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">User</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Device</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Version</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {conflicts.map((conflict) => {
            const conflictWithEmail = conflict as ConflictWithEmail;
            return (
              <tr key={conflict.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <div className="text-sm font-medium">{conflict.fileName}</div>
                  <div className="text-xs text-gray-500">{conflict.filePath}</div>
                </td>
                <td className="px-4 py-3 text-sm">{conflictWithEmail.userEmail || '-'}</td>
                <td className="px-4 py-3 text-sm">{conflict.deviceName || '-'}</td>
                <td className="px-4 py-3 text-sm">v{conflict.versionNumber}</td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {formatRelativeTime(conflict.createdAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
