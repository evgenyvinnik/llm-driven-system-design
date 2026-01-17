/**
 * @fileoverview Barrel export for block components.
 * Re-exports all block renderer components and shared utilities.
 */

// Main block component
export { default as BlockComponent } from './BlockComponent';

// Individual block type renderers
export { HeadingBlock } from './HeadingBlock';
export { ListBlock } from './ListBlock';
export { ToggleBlock } from './ToggleBlock';
export { CodeBlock } from './CodeBlock';
export { QuoteBlock } from './QuoteBlock';
export { CalloutBlock } from './CalloutBlock';
export { DividerBlock } from './DividerBlock';
export { TextBlock } from './TextBlock';

// Block type menu
export { BlockTypeMenu, BLOCK_TYPE_ICONS } from './BlockTypeMenu';

// Shared types and utilities
export type {
  BlockRendererProps,
  ToggleBlockRendererProps,
  CodeBlockRendererProps,
} from './types';
export { getPlaceholder, getTextContent } from './types';
