import { SearchResult } from '../types/search';
import { ResultIcon } from './Icons';
import { useSpotlightStore } from '../stores/spotlightStore';

interface SearchResultItemProps {
  result: SearchResult;
  index: number;
  isSelected: boolean;
}

export function SearchResultItem({ result, index, isSelected }: SearchResultItemProps) {
  const { setSelectedIndex, executeResult } = useSpotlightStore();

  const handleClick = () => {
    executeResult(result);
  };

  const handleMouseEnter = () => {
    setSelectedIndex(index);
  };

  const getSubtitle = (): string => {
    switch (result.type) {
      case 'files':
        return result.path || '';
      case 'apps':
        return result.category || 'Application';
      case 'contacts':
        return result.email || result.phone || result.company || '';
      case 'web':
        return result.url || result.description || '';
      case 'calculation':
      case 'conversion':
        return 'Press Enter to copy';
      default:
        return '';
    }
  };

  const getTypeLabel = (): string => {
    switch (result.type) {
      case 'files':
        return 'File';
      case 'apps':
        return 'App';
      case 'contacts':
        return 'Contact';
      case 'web':
        return 'Web';
      case 'calculation':
        return 'Calculator';
      case 'conversion':
        return 'Convert';
      default:
        return result.type;
    }
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
      <div
        className={`
          flex items-center justify-center w-8 h-8 rounded-lg
          ${result.type === 'calculation' || result.type === 'conversion'
            ? 'bg-blue-500/20 text-blue-400'
            : result.type === 'apps'
            ? 'bg-purple-500/20 text-purple-400'
            : result.type === 'contacts'
            ? 'bg-green-500/20 text-green-400'
            : result.type === 'web'
            ? 'bg-orange-500/20 text-orange-400'
            : 'bg-gray-500/20 text-gray-400'
          }
        `}
      >
        <ResultIcon type={result.type} category={result.category} className="w-4 h-4" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-spotlight-text-primary truncate">
          {result.name}
        </div>
        <div className="text-xs text-spotlight-text-tertiary truncate">
          {getSubtitle()}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-spotlight-text-tertiary uppercase tracking-wide">
          {getTypeLabel()}
        </span>
        {isSelected && (
          <kbd className="px-1.5 py-0.5 text-xs rounded bg-spotlight-hover border border-spotlight-border font-mono text-spotlight-text-tertiary">
            return
          </kbd>
        )}
      </div>
    </div>
  );
}
