import { Link } from '@tanstack/react-router';
import { Star } from 'lucide-react';
import type { AdminContent } from './types';

/**
 * Props for the ContentTab component.
 */
interface ContentTabProps {
  /** Array of content items to display */
  content: AdminContent[];
  /** Callback fired when featured status is toggled */
  onToggleFeatured: (contentId: string) => void;
}

/**
 * Content management tab for admin dashboard.
 * Displays a table of all content items with title, type, status,
 * view count, featured toggle, and view action.
 *
 * Features:
 * - Sortable columns (visual only, sorting not implemented)
 * - Featured status toggle with star icon
 * - Status badges (green for ready, yellow for processing)
 * - Links to content detail pages
 *
 * @param props - ContentTabProps with content array and toggle handler
 * @returns Table view of all platform content
 */
export function ContentTab({ content, onToggleFeatured }: ContentTabProps) {
  return (
    <div className="bg-apple-gray-800 rounded-2xl overflow-hidden">
      <table className="w-full">
        <ContentTableHeader />
        <tbody className="divide-y divide-white/10">
          {content.map((item) => (
            <ContentTableRow
              key={item.id}
              item={item}
              onToggleFeatured={onToggleFeatured}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Table header component for content management table.
 * Defines column headers: Title, Type, Status, Views, Featured, Actions.
 *
 * @returns Table header row with styled column headers
 */
function ContentTableHeader() {
  return (
    <thead className="bg-apple-gray-700">
      <tr>
        <th className="px-6 py-4 text-left text-sm font-medium text-white/60">
          Title
        </th>
        <th className="px-6 py-4 text-left text-sm font-medium text-white/60">
          Type
        </th>
        <th className="px-6 py-4 text-left text-sm font-medium text-white/60">
          Status
        </th>
        <th className="px-6 py-4 text-left text-sm font-medium text-white/60">
          Views
        </th>
        <th className="px-6 py-4 text-left text-sm font-medium text-white/60">
          Featured
        </th>
        <th className="px-6 py-4 text-left text-sm font-medium text-white/60">
          Actions
        </th>
      </tr>
    </thead>
  );
}

/**
 * Props for the ContentTableRow component.
 */
interface ContentTableRowProps {
  /** Content item data for this row */
  item: AdminContent;
  /** Callback fired when featured status is toggled */
  onToggleFeatured: (contentId: string) => void;
}

/**
 * Individual row in the content management table.
 * Displays content details and provides interaction controls.
 *
 * @param props - ContentTableRowProps with item data and handlers
 * @returns Table row with content details and actions
 */
function ContentTableRow({ item, onToggleFeatured }: ContentTableRowProps) {
  return (
    <tr className="hover:bg-apple-gray-700">
      <td className="px-6 py-4">
        <Link
          to="/content/$contentId"
          params={{ contentId: item.id }}
          className="hover:text-apple-blue"
        >
          {item.title}
        </Link>
      </td>
      <td className="px-6 py-4 capitalize">{item.content_type}</td>
      <td className="px-6 py-4">
        <StatusBadge status={item.status} />
      </td>
      <td className="px-6 py-4">{item.view_count}</td>
      <td className="px-6 py-4">
        <FeaturedToggle
          isFeatured={item.featured}
          onToggle={() => onToggleFeatured(item.id)}
        />
      </td>
      <td className="px-6 py-4">
        <Link
          to="/content/$contentId"
          params={{ contentId: item.id }}
          className="text-apple-blue hover:underline text-sm"
        >
          View
        </Link>
      </td>
    </tr>
  );
}

/**
 * Props for the StatusBadge component.
 */
interface StatusBadgeProps {
  /** Content processing/availability status */
  status: string;
}

/**
 * Colored status badge based on content status.
 * Displays green for 'ready', yellow for other statuses.
 *
 * @param props - StatusBadgeProps with status string
 * @returns Colored badge element
 */
function StatusBadge({ status }: StatusBadgeProps) {
  const isReady = status === 'ready';
  const classes = isReady
    ? 'bg-apple-green/20 text-apple-green'
    : 'bg-yellow-500/20 text-yellow-500';

  return <span className={`px-2 py-1 text-xs rounded ${classes}`}>{status}</span>;
}

/**
 * Props for the FeaturedToggle component.
 */
interface FeaturedToggleProps {
  /** Whether content is currently featured */
  isFeatured: boolean;
  /** Callback fired when toggle is clicked */
  onToggle: () => void;
}

/**
 * Toggle button for content featured status.
 * Displays a star icon that fills when content is featured.
 *
 * @param props - FeaturedToggleProps with state and handler
 * @returns Star button with visual feedback for featured state
 */
function FeaturedToggle({ isFeatured, onToggle }: FeaturedToggleProps) {
  const classes = isFeatured
    ? 'bg-yellow-500/20 text-yellow-500'
    : 'bg-white/10 text-white/40';

  return (
    <button
      onClick={onToggle}
      className={`p-2 rounded-lg transition-colors ${classes}`}
    >
      <Star className={`w-4 h-4 ${isFeatured ? 'fill-current' : ''}`} />
    </button>
  );
}
