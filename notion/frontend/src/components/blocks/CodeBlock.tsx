/**
 * @fileoverview Code block renderer component.
 * Renders code blocks with monospace styling and special key handling for newlines.
 */

import type { CodeBlockRendererProps } from './types';

/**
 * CodeBlock renders a code block with monospace styling.
 * Features special keyboard handling to allow Enter for newlines within the code block,
 * rather than creating new blocks (standard behavior for other block types).
 *
 * @param props - Component props including content ref and text content
 * @returns A styled code block with pre/code elements
 *
 * @example
 * ```tsx
 * <CodeBlock
 *   contentRef={codeRef}
 *   textContent="const x = 1;"
 *   placeholder="Type code here..."
 *   onInput={handleInput}
 *   onKeyDown={handleKeyDown}
 *   onFocus={handleFocus}
 * />
 * ```
 */
export function CodeBlock({
  contentRef,
  textContent,
  placeholder,
  onInput,
  onKeyDown,
  onFocus,
}: CodeBlockRendererProps) {
  /**
   * Handles keyboard events for the code block.
   * Allows Enter key to create newlines instead of new blocks.
   *
   * @param e - The keyboard event
   */
  const handleCodeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      // Allow new lines in code blocks by stopping propagation
      e.stopPropagation();
    } else {
      onKeyDown(e);
    }
  };

  return (
    <pre className="notion-code">
      <code
        ref={contentRef as React.RefObject<HTMLElement>}
        className="outline-none block whitespace-pre-wrap"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={onInput}
        onKeyDown={handleCodeKeyDown}
        onFocus={onFocus}
      >
        {textContent}
      </code>
    </pre>
  );
}
