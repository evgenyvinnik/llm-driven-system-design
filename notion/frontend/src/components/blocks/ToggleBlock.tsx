/**
 * @fileoverview Toggle block renderer component.
 * Renders collapsible toggle blocks with support for nested child blocks.
 */

import { ChevronRight } from 'lucide-react';
import type { Block } from '@/types';
import type { ToggleBlockRendererProps } from './types';

/**
 * Placeholder component for rendering child blocks inside a toggle.
 * This is a simplified renderer that displays child content without full interactivity.
 *
 * @param props - Props containing the child block data
 * @returns A simplified block representation
 */
function ChildBlockRenderer({ block }: { block: Block }) {
  const textContent = block.content.map((rt) => rt.text).join('');
  return (
    <div className="py-1 text-notion-text">
      {textContent || <span className="text-notion-text-secondary">Empty block</span>}
    </div>
  );
}

/**
 * ToggleBlock renders a collapsible toggle with child block support.
 * Features an expand/collapse chevron icon and a nested content area
 * that shows child blocks when expanded.
 *
 * @param props - Component props including expanded state and child blocks
 * @returns A toggle block with chevron icon and collapsible children
 *
 * @example
 * ```tsx
 * <ToggleBlock
 *   block={block}
 *   isExpanded={true}
 *   onToggle={handleToggle}
 *   childBlocks={children}
 *   allBlocks={allBlocks}
 *   contentRef={ref}
 *   textContent="My toggle header"
 *   placeholder="Toggle"
 *   onInput={handleInput}
 *   onKeyDown={handleKeyDown}
 *   onFocus={handleFocus}
 * />
 * ```
 */
export function ToggleBlock({
  block,
  isExpanded,
  onToggle,
  childBlocks,
  allBlocks,
  contentRef,
  textContent,
  placeholder,
  onInput,
  onKeyDown,
  onFocus,
}: ToggleBlockRendererProps) {
  return (
    <div className="notion-toggle">
      <button
        className={`notion-toggle-icon ${isExpanded ? 'expanded' : ''}`}
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? 'Collapse toggle' : 'Expand toggle'}
      >
        <ChevronRight className="w-4 h-4" />
      </button>
      <div className="flex-1">
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
        {isExpanded && childBlocks.length > 0 && (
          <div className="pl-2 mt-1 border-l-2 border-notion-border">
            {childBlocks.map((child) => (
              <ChildBlockRenderer key={child.id} block={child} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
