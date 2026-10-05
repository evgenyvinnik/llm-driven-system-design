import { useId } from 'react';
import { useSearchStore } from '../stores/search-store';

/** Renders search configuration controls for fuzzy matching toggle and max suggestions count. */
export function SearchSettings() {
  const { fuzzyEnabled, maxSuggestions, toggleFuzzy, setMaxSuggestions } =
    useSearchStore();

  // IDs that tie each label/description to its control, so both have accessible names
  const id = useId();
  const fuzzyId = `${id}-fuzzy`;
  const fuzzyDescriptionId = `${id}-fuzzy-description`;
  const maxSuggestionsId = `${id}-max-suggestions`;

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-semibold text-gray-800 mb-4">Search Settings</h3>

      <div className="space-y-4">
        {/* Fuzzy matching toggle */}
        <div className="flex items-center justify-between">
          <div>
            <label htmlFor={fuzzyId} className="text-sm font-medium text-gray-700">
              Fuzzy Matching
            </label>
            <p id={fuzzyDescriptionId} className="text-xs text-gray-500">
              Find results with typos or misspellings
            </p>
          </div>
          <button
            id={fuzzyId}
            type="button"
            role="switch"
            aria-checked={fuzzyEnabled}
            aria-describedby={fuzzyDescriptionId}
            onClick={toggleFuzzy}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              fuzzyEnabled ? 'bg-blue-600' : 'bg-gray-200'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                fuzzyEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Max suggestions */}
        <div>
          <label htmlFor={maxSuggestionsId} className="text-sm font-medium text-gray-700 block mb-2">
            Max Suggestions: {maxSuggestions}
          </label>
          <input
            id={maxSuggestionsId}
            type="range"
            min="3"
            max="10"
            value={maxSuggestions}
            onChange={(e) => setMaxSuggestions(parseInt(e.target.value))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
          />
          <div className="flex justify-between text-xs text-gray-400 mt-1">
            <span>3</span>
            <span>10</span>
          </div>
        </div>
      </div>
    </div>
  );
}
