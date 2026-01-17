import { useEffect, useRef } from 'react';
import { useSpotlightStore } from '../stores/spotlightStore';
import { SearchInput } from './SearchInput';
import { SearchResults } from './SearchResults';
import { Suggestions } from './Suggestions';

export function SpotlightModal() {
  const { isOpen, closeSpotlight } = useSpotlightStore();
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      closeSpotlight();
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50 animate-fade-in"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className="w-full max-w-2xl rounded-xl spotlight-modal bg-spotlight-bg shadow-spotlight animate-slide-up overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Spotlight Search"
      >
        <SearchInput />
        <SearchResults />
        <Suggestions />

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-spotlight-border bg-black/20">
          <div className="flex items-center gap-4 text-xs text-spotlight-text-tertiary">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-spotlight-hover border border-spotlight-border font-mono">tab</kbd>
              <span>or</span>
              <kbd className="px-1 py-0.5 rounded bg-spotlight-hover border border-spotlight-border font-mono">arrows</kbd>
              <span>to navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-spotlight-hover border border-spotlight-border font-mono">return</kbd>
              <span>to select</span>
            </span>
          </div>
          <div className="text-xs text-spotlight-text-tertiary">
            Spotlight Search
          </div>
        </div>
      </div>
    </div>
  );
}
