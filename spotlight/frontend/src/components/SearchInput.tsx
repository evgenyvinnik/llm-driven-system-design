import { useRef, useEffect } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { useSpotlightStore } from '../stores/spotlightStore';

export function SearchInput() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { query, setQuery, isLoading, isOpen } = useSpotlightStore();

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-spotlight-border">
      {isLoading ? (
        <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
      ) : (
        <Search className="w-5 h-5 text-spotlight-text-secondary" />
      )}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Spotlight Search"
        className="flex-1 bg-transparent text-lg text-spotlight-text-primary placeholder:text-spotlight-text-tertiary focus:outline-none"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck="false"
      />
      <div className="text-xs text-spotlight-text-tertiary">
        <kbd className="px-1.5 py-0.5 rounded bg-spotlight-hover border border-spotlight-border font-mono">
          esc
        </kbd>
      </div>
    </div>
  );
}
