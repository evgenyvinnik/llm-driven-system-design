import { useRef, useState, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMasonryLayout } from '../hooks/useMasonryLayout';
import PinCard from './PinCard';
import type { Pin } from '../types';

interface MasonryGridProps {
  pins: Pin[];
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoading?: boolean;
  onSavePin?: (pinId: string) => void;
}

const COLUMN_WIDTH_MIN = 236;
const GAP = 16;

/** Renders a virtualized masonry grid layout for Pinterest-style pin display with infinite scroll. */
export default function MasonryGrid({
  pins,
  onLoadMore,
  hasMore,
  isLoading,
  onSavePin,
}: MasonryGridProps) {
  const [containerWidth, setContainerWidth] = useState(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  /**
   * Attach the ResizeObserver via a *callback ref*, not a mount effect.
   *
   * This component early-returns an empty state when there are no pins, so on
   * first render the grid div doesn't exist and `containerRef.current` is null.
   * A `useEffect(..., [])` therefore bailed out and — because its dependency
   * list is empty — never ran again once pins arrived and the div mounted.
   * `containerWidth` stayed 0 forever, which made `columnWidth` 0, so every pin
   * was laid out at left 0 with no width: the masonry grid collapsed into one
   * overlapping stack. A callback ref fires whenever the node actually attaches.
   */
  const setContainerNode = useCallback((node: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;

    if (!node) return;

    setContainerWidth(node.clientWidth);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(node);
    resizeObserverRef.current = observer;
  }, []);

  // Calculate column count based on container width
  const columnCount = Math.max(2, Math.floor((containerWidth + GAP) / (COLUMN_WIDTH_MIN + GAP)));
  const columnWidth = (containerWidth - GAP * (columnCount - 1)) / columnCount;

  // Get masonry layout
  const { items, totalHeight } = useMasonryLayout(pins, columnCount, columnWidth);

  // Create row groups for virtualization
  // Group items into "rows" based on their approximate vertical positions
  const ROW_HEIGHT_ESTIMATE = 300;
  const rowCount = Math.max(1, Math.ceil(totalHeight / ROW_HEIGHT_ESTIMATE));

  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 3,
  });

  // Infinite scroll detection
  const handleScroll = useCallback(() => {
    const scrollElement = parentRef.current;
    if (!scrollElement || !onLoadMore || !hasMore || isLoading) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollElement;
    if (scrollHeight - scrollTop - clientHeight < 500) {
      onLoadMore();
    }
  }, [onLoadMore, hasMore, isLoading]);

  useEffect(() => {
    const scrollElement = parentRef.current;
    if (!scrollElement) return;

    scrollElement.addEventListener('scroll', handleScroll);
    return () => scrollElement.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  if (pins.length === 0 && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <svg className="w-16 h-16 text-gray-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <p className="text-text-secondary text-lg">No pins to display</p>
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className="h-[calc(100vh-72px)] overflow-auto"
      style={{ contain: 'strict' }}
    >
      <div ref={setContainerNode} className="px-4 max-w-screen-2xl mx-auto">
        {/* Masonry container with absolute positioning */}
        <div
          className="relative w-full"
          style={{ height: totalHeight }}
        >
          {items.map((item) => (
            <div
              key={item.pin.id}
              className="absolute"
              style={{
                left: item.column * (columnWidth + GAP),
                top: item.top,
                width: columnWidth,
              }}
            >
              <PinCard pin={item.pin} onSave={onSavePin} />
            </div>
          ))}
        </div>

        {/* Virtual rows (hidden - just for scroll measurement) */}
        <div style={{ height: 0, overflow: 'hidden' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => (
            <div
              key={virtualRow.key}
              style={{ height: virtualRow.size }}
            />
          ))}
        </div>

        {/* Loading indicator */}
        {isLoading && (
          <div className="flex justify-center py-8">
            <div className="w-8 h-8 border-4 border-gray-200 border-t-pinterest-red rounded-full animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}
