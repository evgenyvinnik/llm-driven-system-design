/**
 * @fileoverview Individual block component for rendering different block types.
 * Acts as the main orchestrator that delegates rendering to specialized block
 * type components while handling common functionality like focus, menus, and handles.
 */

import { useRef, useEffect, useState } from 'react';
import { GripVertical, Plus } from 'lucide-react';
import type { Block, BlockType, RichText } from '@/types';
import { useEditorStore } from '@/stores/editor';

// Import block type components
import { HeadingBlock } from './HeadingBlock';
import { ListBlock } from './ListBlock';
import { ToggleBlock } from './ToggleBlock';
import { CodeBlock } from './CodeBlock';
import { QuoteBlock } from './QuoteBlock';
import { CalloutBlock } from './CalloutBlock';
import { DividerBlock } from './DividerBlock';
import { TextBlock } from './TextBlock';
import { BlockTypeMenu } from './BlockTypeMenu';
import { getPlaceholder, getTextContent } from './types';

/**
 * Props for the BlockComponent.
 */
interface BlockComponentProps {
  /** The block data to render */
  block: Block;
  /** Direct child blocks (for toggle/nesting) */
  childBlocks: Block[];
  /** All blocks in the page (for recursive child lookup) */
  allBlocks: Block[];
  /** Whether this block currently has focus */
  isFocused: boolean;
  /** Called when the block gains focus */
  onFocus: () => void;
  /** Called when block content changes */
  onUpdate: (content: RichText[]) => void;
  /** Called to change the block type */
  onChangeType: (type: BlockType) => void;
  /** Called to delete the block */
  onDelete: () => void;
  /** Called to add a new block after this one */
  onAddBlock: (type?: BlockType) => void;
  /** Keyboard event handler for navigation */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Called when a slash command is detected */
  onSlashCommand: (command: string) => void;
}

/**
 * BlockComponent renders a single block with type-specific styling.
 * Orchestrates block rendering by delegating to specialized components
 * while handling common functionality like focus management, block handles,
 * and the type conversion menu.
 *
 * @param props - Component props
 * @returns The rendered block element with handles and content
 *
 * @example
 * ```tsx
 * <BlockComponent
 *   block={block}
 *   childBlocks={children}
 *   allBlocks={allBlocks}
 *   isFocused={focusedId === block.id}
 *   onFocus={() => setFocusedId(block.id)}
 *   onUpdate={(content) => updateBlock(block.id, { content })}
 *   onChangeType={(type) => updateBlock(block.id, { type })}
 *   onDelete={() => deleteBlock(block.id)}
 *   onAddBlock={(type) => addBlock(type, block.id)}
 *   onKeyDown={handleKeyDown}
 *   onSlashCommand={handleSlashCommand}
 * />
 * ```
 */
export default function BlockComponent({
  block,
  childBlocks,
  allBlocks,
  isFocused,
  onFocus,
  onUpdate,
  onChangeType,
  onDelete,
  onAddBlock,
  onKeyDown,
  onSlashCommand,
}: BlockComponentProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [isExpanded, setIsExpanded] = useState(!block.is_collapsed);
  const { updateBlock } = useEditorStore();

  // Manage focus when this block becomes focused
  useEffect(() => {
    if (isFocused && contentRef.current) {
      contentRef.current.focus();
      placeCursorAtEnd(contentRef.current);
    }
  }, [isFocused]);

  /**
   * Places the cursor at the end of the contentEditable element.
   *
   * @param element - The contentEditable element to focus
   */
  function placeCursorAtEnd(element: HTMLElement) {
    const range = document.createRange();
    const selection = window.getSelection();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  /**
   * Handles input changes in the contentEditable element.
   * Detects slash commands and updates block content.
   */
  const handleInput = () => {
    if (!contentRef.current) return;

    const text = contentRef.current.innerText;

    // Check for slash commands (e.g., "/heading " triggers type conversion)
    if (text.startsWith('/')) {
      const match = text.match(/^\/(\w+)\s/);
      if (match) {
        onSlashCommand('/' + match[1]);
        return;
      }
    }

    onUpdate([{ text }]);
  };

  /**
   * Handles keyboard events for the block.
   * Opens the type menu on slash key when block is empty.
   *
   * @param e - The keyboard event
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Check for slash command when block is empty
    if (e.key === '/' && contentRef.current?.innerText === '') {
      setShowMenu(true);
      return;
    }

    // Forward to parent handler for navigation
    onKeyDown(e);
  };

  /**
   * Toggles the expanded state for toggle blocks.
   * Persists the collapsed state to the backend.
   */
  const handleToggle = async () => {
    const newExpanded = !isExpanded;
    setIsExpanded(newExpanded);
    await updateBlock(block.id, { is_collapsed: !newExpanded });
  };

  /**
   * Handles block type changes from the menu.
   *
   * @param type - The new block type to convert to
   */
  const handleTypeChange = (type: BlockType) => {
    onChangeType(type);
    setShowMenu(false);
  };

  // Get text content and placeholder for the block
  const textContent = getTextContent(block.content);
  const placeholder = getPlaceholder(block.type);

  /**
   * Renders the appropriate block content based on block type.
   * Delegates to specialized block type components.
   *
   * @returns The rendered block content element
   */
  const renderBlockContent = () => {
    // Common props for most block renderers
    const commonProps = {
      contentRef,
      textContent,
      placeholder,
      onInput: handleInput,
      onKeyDown: handleKeyDown,
      onFocus,
    };

    switch (block.type) {
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
        return <HeadingBlock level={block.type} {...commonProps} />;

      case 'bulleted_list':
        return <ListBlock variant="bulleted" {...commonProps} />;

      case 'numbered_list':
        return <ListBlock variant="numbered" {...commonProps} />;

      case 'toggle':
        return (
          <ToggleBlock
            block={block}
            isExpanded={isExpanded}
            onToggle={handleToggle}
            childBlocks={childBlocks}
            allBlocks={allBlocks}
            {...commonProps}
          />
        );

      case 'code':
        return <CodeBlock {...commonProps} />;

      case 'quote':
        return <QuoteBlock {...commonProps} />;

      case 'callout':
        return <CalloutBlock {...commonProps} />;

      case 'divider':
        return <DividerBlock />;

      default:
        return <TextBlock {...commonProps} />;
    }
  };

  return (
    <div className={`notion-block group ${isFocused ? 'notion-block-focused' : ''}`}>
      {/* Block handle with add button and grip */}
      <BlockHandle
        onAdd={() => onAddBlock()}
        onMenuToggle={() => setShowMenu(!showMenu)}
      />

      {/* Block content delegated to type-specific component */}
      {renderBlockContent()}

      {/* Block type conversion menu */}
      <BlockTypeMenu
        isOpen={showMenu}
        onClose={() => setShowMenu(false)}
        onSelectType={handleTypeChange}
      />
    </div>
  );
}

/**
 * Props for the BlockHandle component.
 */
interface BlockHandleProps {
  /** Callback when the add button is clicked */
  onAdd: () => void;
  /** Callback when the grip/menu button is clicked */
  onMenuToggle: () => void;
}

/**
 * BlockHandle renders the left-side handle with add and grip buttons.
 * Provides quick access to adding new blocks and opening the type menu.
 *
 * @param props - Component props with action callbacks
 * @returns The block handle element with buttons
 */
function BlockHandle({ onAdd, onMenuToggle }: BlockHandleProps) {
  return (
    <div className="notion-block-handle flex items-center gap-0.5 pr-1">
      <button
        className="w-5 h-5 flex items-center justify-center rounded hover:bg-notion-border"
        onClick={onAdd}
        aria-label="Add block below"
      >
        <Plus className="w-4 h-4 text-notion-text-secondary" />
      </button>
      <button
        className="w-5 h-5 flex items-center justify-center rounded hover:bg-notion-border cursor-grab"
        onClick={onMenuToggle}
        aria-label="Block options"
      >
        <GripVertical className="w-4 h-4 text-notion-text-secondary" />
      </button>
    </div>
  );
}
