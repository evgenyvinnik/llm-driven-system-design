/**
 * @fileoverview Heading block renderer component.
 * Renders heading_1, heading_2, and heading_3 block types with appropriate styling.
 */

import type { BlockType } from '@/types';
import type { BlockRendererProps } from './types';

/**
 * Props for the HeadingBlock component.
 */
interface HeadingBlockProps extends BlockRendererProps {
  /** The specific heading level (heading_1, heading_2, or heading_3) */
  level: 'heading_1' | 'heading_2' | 'heading_3';
}

/**
 * CSS class mapping for each heading level.
 * Maps block types to their corresponding Notion-style CSS classes.
 */
const HEADING_CLASSES: Record<string, string> = {
  heading_1: 'notion-heading-1',
  heading_2: 'notion-heading-2',
  heading_3: 'notion-heading-3',
};

/**
 * HeadingBlock renders a heading with level-appropriate styling.
 * Supports three heading levels (H1, H2, H3) with contentEditable text input.
 *
 * @param props - Component props including heading level and text content
 * @returns A styled contentEditable heading element
 *
 * @example
 * ```tsx
 * <HeadingBlock
 *   level="heading_1"
 *   contentRef={ref}
 *   textContent="My Heading"
 *   placeholder="Heading 1"
 *   onInput={handleInput}
 *   onKeyDown={handleKeyDown}
 *   onFocus={handleFocus}
 * />
 * ```
 */
export function HeadingBlock({
  level,
  contentRef,
  textContent,
  placeholder,
  onInput,
  onKeyDown,
  onFocus,
}: HeadingBlockProps) {
  const className = HEADING_CLASSES[level] || 'notion-heading-1';

  return (
    <div
      ref={contentRef}
      className={`${className} outline-none`}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {textContent}
    </div>
  );
}
