import { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Content, ContinueWatching } from '../types';
import { ContentCard } from './ContentCard';

interface ContentRowProps {
  title: string;
  items: (Content | ContinueWatching)[];
  showProgress?: boolean;
}

export function ContentRow({ title, items, showProgress }: ContentRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (direction: 'left' | 'right') => {
    if (scrollRef.current) {
      const scrollAmount = direction === 'left' ? -400 : 400;
      scrollRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  if (items.length === 0) {
    return null;
  }

  return (
    <section className="py-6">
      <div className="flex items-center justify-between mb-4 px-4 lg:px-8">
        <h2 className="text-xl font-semibold">{title}</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => scroll('left')}
            className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            aria-label="Scroll left"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={() => scroll('right')}
            className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            aria-label="Scroll right"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto hide-scrollbar px-4 lg:px-8 pb-4"
      >
        {items.map((item) => (
          <ContentCard
            key={item.id}
            content={item as Content}
            size="medium"
            showProgress={showProgress}
            progressPercent={'progressPercent' in item ? item.progressPercent : undefined}
          />
        ))}
      </div>
    </section>
  );
}
