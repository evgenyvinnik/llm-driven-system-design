/**
 * @fileoverview Shared types and utilities for block renderer components.
 * Provides common interfaces and helper functions used across all block types.
 */

import type { Block, BlockType, RichText } from '@/types';

/**
 * Common props shared by all block renderer components.
 * Each block type receives these props for consistent behavior.
 */
export interface BlockRendererProps {
  /** Reference to the contentEditable element for focus management */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** The text content extracted from the block's RichText array */
  textContent: string;
  /** Placeholder text shown when the block is empty */
  placeholder: string;
  /** Handler called when the content is modified */
  onInput: () => void;
  /** Handler for keyboard events (navigation, shortcuts) */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Handler called when the block gains focus */
  onFocus: () => void;
}

/**
 * Extended props for toggle blocks that support nested children.
 */
export interface ToggleBlockRendererProps extends BlockRendererProps {
  /** The current block data */
  block: Block;
  /** Whether the toggle is currently expanded */
  isExpanded: boolean;
  /** Handler to toggle the expanded state */
  onToggle: () => void;
  /** Direct child blocks of this toggle */
  childBlocks: Block[];
  /** All blocks in the page for recursive child lookup */
  allBlocks: Block[];
}

/**
 * Extended props for code blocks with special key handling.
 * Note: Code blocks use an HTMLElement ref for the <code> element.
 */
export interface CodeBlockRendererProps {
  /** Reference to the code element */
  contentRef: React.RefObject<HTMLElement | null>;
  /** The text content extracted from the block's RichText array */
  textContent: string;
  /** Placeholder text shown when the block is empty */
  placeholder: string;
  /** Handler called when the content is modified */
  onInput: () => void;
  /** Handler for keyboard events (navigation, shortcuts) */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Handler called when the block gains focus */
  onFocus: () => void;
}

/**
 * Returns the placeholder text for a given block type.
 * Used to show contextual hints in empty blocks.
 *
 * @param type - The block type to get placeholder for
 * @returns Placeholder string appropriate for the block type
 */
export function getPlaceholder(type: BlockType): string {
  switch (type) {
    case 'heading_1':
      return 'Heading 1';
    case 'heading_2':
      return 'Heading 2';
    case 'heading_3':
      return 'Heading 3';
    case 'bulleted_list':
    case 'numbered_list':
      return 'List item';
    case 'toggle':
      return 'Toggle';
    case 'code':
      return 'Type code here...';
    case 'quote':
      return 'Quote';
    case 'callout':
      return 'Type something...';
    default:
      return "Type '/' for commands...";
  }
}

/**
 * Extracts plain text content from a RichText array.
 * Concatenates all text segments into a single string.
 *
 * @param content - Array of RichText segments
 * @returns Combined plain text string
 */
export function getTextContent(content: RichText[]): string {
  return content.map((rt) => rt.text).join('');
}
