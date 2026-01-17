/**
 * @fileoverview Text block renderer component.
 * Renders the default paragraph/text block type.
 */

import type { BlockRendererProps } from './types';

/**
 * TextBlock renders a basic paragraph/text block.
 * This is the default block type used for regular text content.
 * Features a minimum height to ensure consistent block sizing.
 *
 * @param props - Component props including content ref and text content
 * @returns A styled contentEditable text block
 *
 * @example
 * ```tsx
 * <TextBlock
 *   contentRef={ref}
 *   textContent="This is paragraph text"
 *   placeholder="Type '/' for commands..."
 *   onInput={handleInput}
 *   onKeyDown={handleKeyDown}
 *   onFocus={handleFocus}
 * />
 * ```
 */
export function TextBlock({
  contentRef,
  textContent,
  placeholder,
  onInput,
  onKeyDown,
  onFocus,
}: BlockRendererProps) {
  return (
    <div
      ref={contentRef}
      className="outline-none min-h-6"
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
