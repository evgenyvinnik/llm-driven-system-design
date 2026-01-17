import { Suggestion } from '../types/search';
import { ResultIcon, ReasonIcon } from './Icons';
import { useSpotlightStore } from '../stores/spotlightStore';
import { SearchResult } from '../types/search';

interface SuggestionItemProps {
  suggestion: Suggestion;
  index: number;
  isSelected: boolean;
}

function SuggestionItem({ suggestion, index, isSelected }: SuggestionItemProps) {
  const { setSelectedIndex, executeResult } = useSpotlightStore();

  const handleClick = () => {
    // Convert suggestion to result format for execution
    const result: SearchResult = {
      id: suggestion.bundleId || suggestion.itemId || suggestion.name,
      type: suggestion.type.replace('_suggestion', '') as SearchResult['type'],
      name: suggestion.name,
      score: suggestion.score,
      email: suggestion.email,
      phone: suggestion.phone,
      bundle_id: suggestion.bundleId,
      path: suggestion.path,
    };
    executeResult(result);
  };

  const handleMouseEnter = () => {
    setSelectedIndex(index);
  };

  return (
    <div
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      className={`
        flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors
        ${isSelected ? 'bg-spotlight-selected' : 'hover:bg-spotlight-hover'}
      `}
    >
      <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gray-500/20">
        <ResultIcon type={suggestion.type} className="w-4 h-4 text-gray-400" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-spotlight-text-primary truncate">
          {suggestion.name}
        </div>
        {suggestion.reason && (
          <div className="flex items-center gap-1 text-xs text-spotlight-text-tertiary">
            <ReasonIcon reason={suggestion.reason} className="w-3 h-3" />
            <span>{suggestion.reason}</span>
          </div>
        )}
      </div>

      {isSelected && (
        <kbd className="px-1.5 py-0.5 text-xs rounded bg-spotlight-hover border border-spotlight-border font-mono text-spotlight-text-tertiary">
          return
        </kbd>
      )}
    </div>
  );
}

export function Suggestions() {
  const { suggestions, query, selectedIndex } = useSpotlightStore();

  // Only show suggestions when no query
  if (query.trim().length > 0) {
    return null;
  }

  if (suggestions.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-spotlight-text-tertiary">
        <p className="text-sm">No suggestions available</p>
        <p className="text-xs mt-1 opacity-60">Start typing to search</p>
      </div>
    );
  }

  return (
    <div className="max-h-96 overflow-y-auto spotlight-scrollbar">
      <div className="px-4 py-2 text-xs font-semibold text-spotlight-text-tertiary uppercase tracking-wider bg-black/20">
        Siri Suggestions
      </div>
      {suggestions.map((suggestion, index) => (
        <SuggestionItem
          key={suggestion.bundleId || suggestion.name + index}
          suggestion={suggestion}
          index={index}
          isSelected={index === selectedIndex}
        />
      ))}
    </div>
  );
}
