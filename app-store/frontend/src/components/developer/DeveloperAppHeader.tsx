/**
 * @fileoverview Developer app header component.
 * Displays app icon, name, status badge, ratings, and action buttons.
 */

import type { App } from '../../types';
import { StarRating } from '../AppCard';
import { getStatusColor } from './utils';

/**
 * Props for the DeveloperAppHeader component.
 */
interface DeveloperAppHeaderProps {
  /** App data to display */
  app: App;
  /** Whether the app is currently in edit mode */
  isEditing: boolean;
  /** Callback to toggle edit mode */
  onEditToggle: () => void;
  /** Callback to publish the app */
  onPublish: () => void;
}

/**
 * Displays the header section of the developer app management page.
 * Shows app icon, name, status badge, rating info, and action buttons.
 *
 * @param props - Component props
 * @returns Header component with app info and actions
 */
export function DeveloperAppHeader({
  app,
  isEditing,
  onEditToggle,
  onPublish,
}: DeveloperAppHeaderProps) {
  return (
    <div className="flex items-start gap-6 mb-8">
      {app.iconUrl ? (
        <img
          src={app.iconUrl}
          alt={app.name}
          className="w-24 h-24 app-icon object-cover"
        />
      ) : (
        <div className="w-24 h-24 app-icon bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-white font-bold text-3xl">
          {app.name.charAt(0)}
        </div>
      )}

      <div className="flex-1">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-2xl font-bold text-gray-900">{app.name}</h1>
          <span
            className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(app.status)}`}
          >
            {app.status}
          </span>
        </div>
        <p className="text-gray-500 mb-2">{app.bundleId}</p>
        <div className="flex items-center gap-4">
          <StarRating rating={app.averageRating} showValue />
          <span className="text-gray-400">|</span>
          <span className="text-gray-500">
            {app.downloadCount.toLocaleString()} downloads
          </span>
          <span className="text-gray-400">|</span>
          <span className="text-gray-500">v{app.version || '1.0'}</span>
        </div>
      </div>

      <div className="flex gap-3">
        {app.status === 'draft' && (
          <button onClick={onPublish} className="btn btn-primary">
            Publish
          </button>
        )}
        <button onClick={onEditToggle} className="btn btn-outline">
          {isEditing ? 'Cancel' : 'Edit'}
        </button>
      </div>
    </div>
  );
}
