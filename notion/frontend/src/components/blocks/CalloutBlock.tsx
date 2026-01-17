/**
 * @fileoverview Callout block renderer component.
 * Renders callout/info blocks with an emoji icon and highlighted background.
 */

import type { BlockRendererProps } from './types';

/**
 * Props for the CalloutBlock component.
 */
interface CalloutBlockProps extends BlockRendererProps {
  /** The emoji icon to display (defaults to lightbulb if not provided) */
  icon?: string;
}

/**
 * CalloutBlock renders a callout box with emoji icon.
 * Used for highlighting important information, tips, warnings, etc.
 * Features a colored background and an emoji icon prefix.
 *
 * @param props - Component props including optional icon and text content
 * @returns A styled callout block with icon and content
 *
 * @example
 * ```tsx
 * <CalloutBlock
 *   icon="💡"
 *   contentRef={ref}
 *   textContent="This is a helpful tip"
 *   placeholder="Type something..."
 *   onInput={handleInput}
 *   onKeyDown={handleKeyDown}
 *   onFocus={handleFocus}
 * />
 * ```
 */
export function CalloutBlock({
  icon = '💡',
  contentRef,
  textContent,
  placeholder,
  onInput,
  onKeyDown,
  onFocus,
}: CalloutBlockProps) {
  return (
    <div className="notion-callout">
      <span className="text-xl" role="img" aria-label="callout icon">
        {icon}
      </span>
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
