/**
 * MarketplaceModal component - Plugin marketplace browser and installer.
 * Provides a searchable, filterable interface for discovering and managing plugins.
 *
 * Features:
 * - Category-based filtering
 * - Search with debounced queries
 * - Plugin detail view with version history
 * - Install/uninstall actions
 *
 * @module components/MarketplaceModal
 */
import React, { useState, useEffect } from 'react';
import { pluginsApi, type Plugin, type PluginDetails } from '../services/api';
import { useAuthStore } from '../stores/auth';

/**
 * Props for the MarketplaceModal component.
 */
interface MarketplaceModalProps {
  /** Whether the modal is currently open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
}

/**
 * Main marketplace modal component.
 * Displays a browsable list of available plugins with search and filtering.
 * Allows viewing plugin details and installing/uninstalling plugins.
 *
 * @param props - MarketplaceModalProps with modal state and close handler
 * @returns Modal dialog or null when closed
 */
export function MarketplaceModal({ isOpen, onClose }: MarketplaceModalProps): React.ReactElement | null {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [selectedPlugin, setSelectedPlugin] = useState<PluginDetails | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<{ category: string; count: number }[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { installedPlugins, installPlugin, uninstallPlugin } = useAuthStore();

  // Load categories on mount
  useEffect(() => {
    if (isOpen) {
      pluginsApi.getCategories().then((result) => {
        if (result.data?.categories) {
          setCategories(result.data.categories);
        }
      });
    }
  }, [isOpen]);

  // Load plugins when search/category changes
  useEffect(() => {
    if (!isOpen) return;

    setIsLoading(true);
    setError(null);

    const timer = setTimeout(() => {
      pluginsApi
        .list({ search: searchQuery, category: category || undefined })
        .then((result) => {
          if (result.error) {
            setError(result.error);
          } else if (result.data?.plugins) {
            setPlugins(result.data.plugins);
          }
        })
        .finally(() => setIsLoading(false));
    }, 300);

    return () => clearTimeout(timer);
  }, [isOpen, searchQuery, category]);

  const handleSelectPlugin = async (pluginId: string) => {
    setIsLoading(true);
    const result = await pluginsApi.getDetails(pluginId);
    if (result.data?.plugin) {
      setSelectedPlugin(result.data.plugin);
    }
    setIsLoading(false);
  };

  const handleInstall = async (pluginId: string) => {
    setIsLoading(true);
    const result = await installPlugin(pluginId);
    if (result.error) {
      setError(result.error);
    }
    setIsLoading(false);
  };

  const handleUninstall = async (pluginId: string) => {
    setIsLoading(true);
    const result = await uninstallPlugin(pluginId);
    if (result.error) {
      setError(result.error);
    }
    setIsLoading(false);
  };

  const isInstalled = (pluginId: string) => {
    return installedPlugins.some((p) => p.plugin_id === pluginId);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-800 dark:text-white">
            {selectedPlugin ? selectedPlugin.name : 'Plugin Marketplace'}
          </h2>
          <button
            onClick={() => {
              if (selectedPlugin) {
                setSelectedPlugin(null);
              } else {
                onClose();
              }
            }}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {selectedPlugin ? (
              <span className="flex items-center gap-1">
                <ChevronLeftIcon />
                Back
              </span>
            ) : (
              <CloseIcon />
            )}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden flex">
          {selectedPlugin ? (
            <PluginDetailView
              plugin={selectedPlugin}
              isInstalled={isInstalled(selectedPlugin.id)}
              onInstall={() => handleInstall(selectedPlugin.id)}
              onUninstall={() => handleUninstall(selectedPlugin.id)}
              isLoading={isLoading}
            />
          ) : (
            <>
              {/* Sidebar */}
              <div className="w-48 border-r border-gray-200 dark:border-gray-700 p-4 overflow-y-auto">
                <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-3">
                  Categories
                </h3>
                <ul className="space-y-1">
                  <li>
                    <button
                      onClick={() => setCategory('')}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm ${
                        category === ''
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                      }`}
                    >
                      All Plugins
                    </button>
                  </li>
                  {categories.map((cat) => (
                    <li key={cat.category}>
                      <button
                        onClick={() => setCategory(cat.category)}
                        className={`w-full text-left px-3 py-2 rounded-md text-sm flex justify-between ${
                          category === cat.category
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                        }`}
                      >
                        <span className="capitalize">{cat.category}</span>
                        <span className="text-gray-400">{cat.count}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Main content */}
              <div className="flex-1 p-4 overflow-y-auto">
                {/* Search */}
                <div className="mb-4">
                  <input
                    type="text"
                    placeholder="Search plugins..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                {/* Error */}
                {error && (
                  <div className="mb-4 p-3 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded-lg">
                    {error}
                  </div>
                )}

                {/* Loading */}
                {isLoading && (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    Loading...
                  </div>
                )}

                {/* Plugin list */}
                {!isLoading && plugins.length === 0 && (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                    No plugins found
                  </div>
                )}

                <div className="grid gap-4">
                  {plugins.map((plugin) => (
                    <PluginCard
                      key={plugin.id}
                      plugin={plugin}
                      isInstalled={isInstalled(plugin.id)}
                      onClick={() => handleSelectPlugin(plugin.id)}
                      onInstall={(e) => {
                        e.stopPropagation();
                        handleInstall(plugin.id);
                      }}
                      onUninstall={(e) => {
                        e.stopPropagation();
                        handleUninstall(plugin.id);
                      }}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Props for the PluginCard component.
 */
interface PluginCardProps {
  /** Plugin data to display */
  plugin: Plugin;
  /** Whether this plugin is currently installed */
  isInstalled: boolean;
  /** Click handler to view plugin details */
  onClick: () => void;
  /** Install button click handler */
  onInstall: (e: React.MouseEvent) => void;
  /** Uninstall button click handler */
  onUninstall: (e: React.MouseEvent) => void;
}

/**
 * Card component displaying a plugin in the marketplace list.
 * Shows plugin name, description, author, install count, and rating.
 * Includes install/uninstall button based on current state.
 *
 * @param props - PluginCardProps with plugin data and handlers
 * @returns Plugin card element
 */
function PluginCard({
  plugin,
  isInstalled,
  onClick,
  onInstall,
  onUninstall,
}: PluginCardProps): React.ReactElement {
  return (
    <div
      onClick={onClick}
      className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-blue-300 dark:hover:border-blue-600 cursor-pointer transition-colors"
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-800 dark:text-white">{plugin.name}</h3>
            <span className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded capitalize">
              {plugin.category}
            </span>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{plugin.description}</p>
          <div className="flex items-center gap-4 mt-2 text-xs text-gray-500 dark:text-gray-500">
            <span>by {plugin.author_name}</span>
            <span>{plugin.install_count} installs</span>
            {plugin.avg_rating > 0 && (
              <span className="flex items-center gap-1">
                <StarIcon />
                {plugin.avg_rating.toFixed(1)}
              </span>
            )}
          </div>
        </div>
        <div>
          {isInstalled ? (
            <button
              onClick={onUninstall}
              className="px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              Uninstall
            </button>
          ) : (
            <button
              onClick={onInstall}
              className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
            >
              Install
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Props for the PluginDetailView component.
 */
interface PluginDetailViewProps {
  /** Detailed plugin information */
  plugin: PluginDetails;
  /** Whether this plugin is currently installed */
  isInstalled: boolean;
  /** Install handler */
  onInstall: () => void;
  /** Uninstall handler */
  onUninstall: () => void;
  /** Whether an action is in progress */
  isLoading: boolean;
}

/**
 * Detailed view of a single plugin.
 * Shows full plugin information including version history,
 * install count, rating, license, and author details.
 *
 * @param props - PluginDetailViewProps with plugin data and handlers
 * @returns Plugin detail view element
 */
function PluginDetailView({
  plugin,
  isInstalled,
  onInstall,
  onUninstall,
  isLoading,
}: PluginDetailViewProps): React.ReactElement {
  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{plugin.name}</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">{plugin.description}</p>
        </div>
        <div className="flex gap-2">
          {isInstalled ? (
            <button
              onClick={onUninstall}
              disabled={isLoading}
              className="px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
            >
              Uninstall
            </button>
          ) : (
            <button
              onClick={onInstall}
              disabled={isLoading}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              Install
            </button>
          )}
        </div>
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
          <div className="text-sm text-gray-500 dark:text-gray-400">Version</div>
          <div className="font-semibold text-gray-800 dark:text-white">{plugin.latest_version}</div>
        </div>
        <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
          <div className="text-sm text-gray-500 dark:text-gray-400">Installs</div>
          <div className="font-semibold text-gray-800 dark:text-white">{plugin.install_count}</div>
        </div>
        <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
          <div className="text-sm text-gray-500 dark:text-gray-400">Rating</div>
          <div className="font-semibold text-gray-800 dark:text-white flex items-center gap-1">
            {plugin.avg_rating > 0 ? (
              <>
                <StarIcon />
                {plugin.avg_rating.toFixed(1)} ({plugin.review_count})
              </>
            ) : (
              'No ratings'
            )}
          </div>
        </div>
        <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
          <div className="text-sm text-gray-500 dark:text-gray-400">License</div>
          <div className="font-semibold text-gray-800 dark:text-white">{plugin.license}</div>
        </div>
      </div>

      {/* Author */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-2">
          Author
        </h3>
        <p className="text-gray-800 dark:text-white">{plugin.author_name}</p>
      </div>

      {/* Versions */}
      {plugin.versions && plugin.versions.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-2">
            Versions
          </h3>
          <div className="space-y-2">
            {plugin.versions.slice(0, 5).map((version) => (
              <div
                key={version.version}
                className="p-3 border border-gray-200 dark:border-gray-700 rounded-lg"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-gray-800 dark:text-white">
                    v{version.version}
                  </span>
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {new Date(version.created_at).toLocaleDateString()}
                  </span>
                </div>
                {version.changelog && (
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    {version.changelog}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Icon Components
// ============================================================================

/**
 * Close (X) icon for modal dismiss button.
 * @returns SVG close icon element
 */
function CloseIcon(): React.ReactElement {
  return (
    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

/**
 * Chevron left icon for back navigation.
 * @returns SVG chevron left icon element
 */
function ChevronLeftIcon(): React.ReactElement {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

/**
 * Star icon for displaying plugin ratings.
 * @returns SVG star icon element with yellow fill
 */
function StarIcon(): React.ReactElement {
  return (
    <svg className="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
    </svg>
  );
}
