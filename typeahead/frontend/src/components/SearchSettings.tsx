import { useSearchStore } from '../stores/search-store';

export function SearchSettings() {
  const { fuzzyEnabled, maxSuggestions, toggleFuzzy, setMaxSuggestions } =
    useSearchStore();

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-semibold text-gray-800 mb-4">Search Settings</h3>

      <div className="space-y-4">
        {/* Fuzzy matching toggle */}
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-gray-700">
              Fuzzy Matching
            </label>
            <p className="text-xs text-gray-500">
              Find results with typos or misspellings
            </p>
          </div>
          <button
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
          <label className="text-sm font-medium text-gray-700 block mb-2">
            Max Suggestions: {maxSuggestions}
          </label>
          <input
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
