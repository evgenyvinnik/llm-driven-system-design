/**
 * Breadcrumb navigation component for folder hierarchy.
 * Displays clickable path from root to current folder.
 * @module components/Breadcrumbs
 */

import { ChevronRight, Home } from 'lucide-react';

/** Props for the Breadcrumbs component */
interface BreadcrumbsProps {
  /** Array of folder breadcrumbs from root to current folder */
  breadcrumbs: Array<{ id: string; name: string }>;
  /** Callback when a breadcrumb is clicked (null for root) */
  onNavigate: (folderId: string | null) => void;
}

/**
 * Renders the folder navigation breadcrumbs.
 * Clicking a crumb navigates to that folder.
 */
export function Breadcrumbs({ breadcrumbs, onNavigate }: BreadcrumbsProps) {
  return (
    <nav className="flex items-center text-sm px-4 py-3 border-b border-gray-200 bg-gray-50">
      <button
        onClick={() => onNavigate(null)}
        className="flex items-center text-gray-600 hover:text-dropbox-blue transition-colors"
      >
        <Home size={16} className="mr-1" />
        <span>My files</span>
      </button>

      {breadcrumbs.map((crumb, index) => (
        <div key={crumb.id} className="flex items-center">
          <ChevronRight size={16} className="mx-2 text-gray-400" />
          <button
            onClick={() => onNavigate(crumb.id)}
            className={`hover:text-dropbox-blue transition-colors ${
              index === breadcrumbs.length - 1
                ? 'text-gray-900 font-medium'
                : 'text-gray-600'
            }`}
          >
            {crumb.name}
          </button>
        </div>
      ))}
    </nav>
  );
}
