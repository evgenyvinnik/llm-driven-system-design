import React from 'react';
import type { SyncOperation } from '../../types';
import { formatRelativeTime } from '../../utils/helpers';

/**
 * Props for the OperationsTab component.
 */
export interface OperationsTabProps {
  /** List of sync operations to display */
  operations: SyncOperation[];
}

/**
 * Returns the CSS classes for an operation type badge.
 *
 * @param type - The operation type
 * @returns Tailwind CSS classes for styling
 */
const getOperationTypeClasses = (type: string): string => {
  switch (type) {
    case 'create':
      return 'bg-green-100 text-green-700';
    case 'update':
      return 'bg-blue-100 text-blue-700';
    case 'delete':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-yellow-100 text-yellow-700';
  }
};

/**
 * Returns the CSS classes for a status badge.
 *
 * @param status - The operation status
 * @returns Tailwind CSS classes for styling
 */
const getStatusClasses = (status: string): string => {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-700';
    case 'failed':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-yellow-100 text-yellow-700';
  }
};

/**
 * Operations tab content for the admin dashboard.
 *
 * Displays a table of recent sync operations with:
 * - User email
 * - Device name
 * - Operation type (create/update/delete/move)
 * - File name
 * - Status (completed/failed/pending)
 * - Timestamp
 *
 * @param props - Component props
 * @returns Table of sync operations or empty state
 */
export const OperationsTab: React.FC<OperationsTabProps> = ({ operations }) => {
  return (
    <div className="bg-white rounded-lg border">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">User</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Device</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Operation</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">File</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Status</th>
            <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {operations.map((op) => (
            <tr key={op.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-sm">{op.userEmail}</td>
              <td className="px-4 py-3 text-sm">{op.deviceName || '-'}</td>
              <td className="px-4 py-3 text-sm">
                <span className={`px-2 py-1 rounded text-xs ${getOperationTypeClasses(op.operationType)}`}>
                  {op.operationType}
                </span>
              </td>
              <td className="px-4 py-3 text-sm truncate max-w-xs">{op.fileName || '-'}</td>
              <td className="px-4 py-3 text-sm">
                <span className={`px-2 py-1 rounded text-xs ${getStatusClasses(op.status)}`}>
                  {op.status}
                </span>
              </td>
              <td className="px-4 py-3 text-sm text-gray-500">
                {formatRelativeTime(op.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {operations.length === 0 && (
        <div className="text-center py-8 text-gray-500">No recent operations</div>
      )}
    </div>
  );
};
