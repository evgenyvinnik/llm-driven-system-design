import { useSpotlightStore } from '../stores/spotlightStore';
import { SearchResultItem } from './SearchResultItem';
import { SearchResult } from '../types/search';

export function SearchResults() {
  const { results, query, selectedIndex, isLoading, error } = useSpotlightStore();

  if (query.trim().length === 0) {
    return null;
  }

  if (isLoading && results.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-spotlight-text-tertiary">
        Searching...
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-8 text-center text-red-400">
        {error}
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-spotlight-text-tertiary">
        No results found for "{query}"
      </div>
    );
  }

  // Group results by type
  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, result) => {
    const type = result.type;
    if (!acc[type]) {
      acc[type] = [];
    }
    acc[type].push(result);
    return acc;
  }, {});

  const typeLabels: Record<string, string> = {
    calculation: 'Calculator',
    conversion: 'Conversion',
    apps: 'Applications',
    files: 'Files',
    contacts: 'Contacts',
    web: 'Web',
  };

  let currentIndex = 0;

  return (
    <div className="max-h-96 overflow-y-auto spotlight-scrollbar">
      {Object.entries(grouped).map(([type, items]) => (
        <div key={type}>
          <div className="px-4 py-2 text-xs font-semibold text-spotlight-text-tertiary uppercase tracking-wider bg-black/20">
            {typeLabels[type] || type}
          </div>
          {items.map((result) => {
            const index = currentIndex++;
            return (
              <SearchResultItem
                key={result.id || result.path || result.name}
                result={result}
                index={index}
                isSelected={index === selectedIndex}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
