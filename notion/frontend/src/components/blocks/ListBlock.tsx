/**
 * @fileoverview List block renderer component.
 * Renders bulleted_list and numbered_list block types with appropriate markers.
 */

import type { BlockRendererProps } from './types';

/**
 * Props for the ListBlock component.
 */
interface ListBlockProps extends BlockRendererProps {
  /** The list variant: 'bulleted' for bullet points, 'numbered' for ordered list */
  variant: 'bulleted' | 'numbered';
}

/**
 * ListBlock renders a list item with bullet or number marker.
 * Supports both bulleted and numbered list styles with contentEditable text input.
 *
 * @param props - Component props including list variant and text content
 * @returns A styled list item with marker and contentEditable content
 *
 * @example
 * ```tsx
 * <ListBlock
 *   variant="bulleted"
 *   contentRef={ref}
 *   textContent="My list item"
 *   placeholder="List item"
 *   onInput={handleInput}
 *   onKeyDown={handleKeyDown}
 *   onFocus={handleFocus}
 * />
 * ```
 */
export function ListBlock({
  variant,
  contentRef,
  textContent,
  placeholder,
  onInput,
  onKeyDown,
  onFocus,
}: ListBlockProps) {
  const marker = variant === 'bulleted' ? '•' : '1.';
  const markerClassName = variant === 'numbered' ? 'min-w-5' : '';

  return (
    <div className="notion-list-item">
      <span className={`text-notion-text mt-0.5 ${markerClassName}`}>{marker}</span>
      <div
        ref={contentRef}
        className="flex-1 outline-none"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        {textContent}
      </div>
    </div>
  );
}
