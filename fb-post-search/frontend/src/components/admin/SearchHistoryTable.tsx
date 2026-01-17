/**
 * @fileoverview Search history table component for the admin dashboard.
 * Displays recent search queries made by users.
 */

import type { SearchHistoryEntry } from '../../types';

/**
 * Props for the SearchHistoryTable component.
 */
interface SearchHistoryTableProps {
  /** Array of search history entries to display */
  history: SearchHistoryEntry[];
}

/**
 * Renders a table of search history entries.
 * Shows user, query text, result count, and timestamp.
 *
 * @param props - SearchHistoryTable props
 * @returns Table displaying search history
 */
export function SearchHistoryTable({ history }: SearchHistoryTableProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              User
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Query
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Results
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Time
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {history.map((entry) => (
            <SearchHistoryRow key={entry.id} entry={entry} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Props for the SearchHistoryRow sub-component.
 */
interface SearchHistoryRowProps {
  /** Search history entry to display */
  entry: SearchHistoryEntry;
}

/**
 * Renders a single search history row.
 *
 * @param props - SearchHistoryRow props
 * @returns Table row with search history details
 */
function SearchHistoryRow({ entry }: SearchHistoryRowProps) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-4 text-sm text-gray-900">
        @{entry.username}
      </td>
      <td className="px-6 py-4 text-sm font-medium text-gray-900">
        {entry.query}
      </td>
      <td className="px-6 py-4 text-sm text-gray-600">
        {entry.results_count}
      </td>
      <td className="px-6 py-4 text-sm text-gray-500">
        {new Date(entry.created_at).toLocaleString()}
      </td>
    </tr>
  );
}
