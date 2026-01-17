/**
 * @fileoverview Search filters dropdown component.
 * Provides filter options for post type, visibility, and date range.
 */

import { useState } from 'react';
import { Filter, X, Calendar, FileType, Eye } from 'lucide-react';
import { useSearchStore } from '../stores/searchStore';
import type { PostType, Visibility } from '../types';

/**
 * Dropdown component for filtering search results.
 * Allows filtering by post type (text, photo, video, link),
 * visibility (public, friends), and date range.
 * @returns Filter button with expandable dropdown panel
 */
export function SearchFilters() {
  const [isOpen, setIsOpen] = useState(false);
  const { filters, setFilters, search } = useSearchStore();

  const postTypes: { value: PostType; label: string }[] = [
    { value: 'text', label: 'Text' },
    { value: 'photo', label: 'Photo' },
    { value: 'video', label: 'Video' },
    { value: 'link', label: 'Link' },
  ];

  const visibilityOptions: { value: Visibility; label: string }[] = [
    { value: 'public', label: 'Public' },
    { value: 'friends', label: 'Friends' },
  ];

  const handlePostTypeChange = (type: PostType) => {
    const currentTypes = filters.post_type || [];
    const newTypes = currentTypes.includes(type)
      ? currentTypes.filter((t) => t !== type)
      : [...currentTypes, type];
    setFilters({ ...filters, post_type: newTypes.length > 0 ? newTypes : undefined });
  };

  const handleVisibilityChange = (visibility: Visibility) => {
    const currentVisibility = filters.visibility || [];
    const newVisibility = currentVisibility.includes(visibility)
      ? currentVisibility.filter((v) => v !== visibility)
      : [...currentVisibility, visibility];
    setFilters({
      ...filters,
      visibility: newVisibility.length > 0 ? newVisibility : undefined,
    });
  };

  const handleDateChange = (field: 'start' | 'end', value: string) => {
    const dateRange = filters.date_range || {};
    if (value) {
      dateRange[field] = value;
    } else {
      delete dateRange[field];
    }
    setFilters({
      ...filters,
      date_range: Object.keys(dateRange).length > 0 ? dateRange : undefined,
    });
  };

  const clearFilters = () => {
    setFilters({});
    search();
  };

  const applyFilters = () => {
    search();
    setIsOpen(false);
  };

  const hasActiveFilters =
    (filters.post_type && filters.post_type.length > 0) ||
    (filters.visibility && filters.visibility.length > 0) ||
    filters.date_range;

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${
          hasActiveFilters
            ? 'border-primary-500 bg-primary-50 text-primary-700'
            : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
        }`}
      >
        <Filter className="w-4 h-4" />
        Filters
        {hasActiveFilters && (
          <span className="bg-primary-500 text-white text-xs px-1.5 py-0.5 rounded-full">
            {(filters.post_type?.length || 0) +
              (filters.visibility?.length || 0) +
              (filters.date_range ? 1 : 0)}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-2 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
          <div className="p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Filters</h3>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>

            {/* Post Type */}
            <div className="mb-4">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                <FileType className="w-4 h-4" />
                Post Type
              </label>
              <div className="flex flex-wrap gap-2">
                {postTypes.map((type) => (
                  <button
                    key={type.value}
                    onClick={() => handlePostTypeChange(type.value)}
                    className={`px-3 py-1 text-sm rounded-full border ${
                      filters.post_type?.includes(type.value)
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {type.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Visibility */}
            <div className="mb-4">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                <Eye className="w-4 h-4" />
                Visibility
              </label>
              <div className="flex flex-wrap gap-2">
                {visibilityOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => handleVisibilityChange(option.value)}
                    className={`px-3 py-1 text-sm rounded-full border ${
                      filters.visibility?.includes(option.value)
                        ? 'border-primary-500 bg-primary-50 text-primary-700'
                        : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Date Range */}
            <div className="mb-4">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                <Calendar className="w-4 h-4" />
                Date Range
              </label>
              <div className="flex gap-2">
                <input
                  type="date"
                  value={filters.date_range?.start || ''}
                  onChange={(e) => handleDateChange('start', e.target.value)}
                  className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <span className="text-gray-400 self-center">to</span>
                <input
                  type="date"
                  value={filters.date_range?.end || ''}
                  onChange={(e) => handleDateChange('end', e.target.value)}
                  className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-4 border-t border-gray-100">
              <button
                onClick={clearFilters}
                className="flex-1 px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Clear All
              </button>
              <button
                onClick={applyFilters}
                className="flex-1 px-4 py-2 text-sm bg-primary-500 text-white rounded-lg hover:bg-primary-600"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
