/**
 * @fileoverview Quote block renderer component.
 * Renders blockquote-style content with a left border accent.
 */

import type { BlockRendererProps } from './types';

/**
 * QuoteBlock renders a blockquote with left border styling.
 * Follows Notion's quote block design with a distinctive left border accent.
 *
 * @param props - Component props including content ref and text content
 * @returns A styled blockquote element
 *
 * @example
 * ```tsx
 * <QuoteBlock
 *   contentRef={ref}
 *   textContent="This is a quote"
 *   placeholder="Quote"
 *   onInput={handleInput}
 *   onKeyDown={handleKeyDown}
 *   onFocus={handleFocus}
 * />
 * ```
 */
export function QuoteBlock({
  contentRef,
  textContent,
  placeholder,
  onInput,
  onKeyDown,
  onFocus,
}: BlockRendererProps) {
  return (
    <div className="notion-quote">
      <div
        ref={contentRef}
        className="outline-none"
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
