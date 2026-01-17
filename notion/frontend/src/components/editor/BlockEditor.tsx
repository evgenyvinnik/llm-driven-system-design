/**
 * @fileoverview Main block editor component for page content editing.
 * Renders a list of blocks with keyboard navigation, slash commands,
 * and block CRUD operations.
 */

import { useRef, useCallback, useEffect } from 'react';
import type { Block, Page, BlockType, RichText } from '@/types';
import { useEditorStore } from '@/stores/editor';
import BlockComponent from '@/components/blocks/BlockComponent';
import { Plus, GripVertical } from 'lucide-react';

/**
 * Props for the BlockEditor component.
 */
interface BlockEditorProps {
  /** The ID of the page being edited */
  pageId: string;
  /** All blocks belonging to this page */
  blocks: Block[];
  /** Child pages to display at the bottom */
  childPages: Page[];
}

/**
 * BlockEditor provides the main editing interface for a page.
 * Handles block rendering, keyboard shortcuts, and slash commands.
 *
 * @param props - Component props
 * @returns The rendered block editor
 */
export default function BlockEditor({ pageId, blocks, childPages }: BlockEditorProps) {
  const {
    addBlock,
    updateBlock,
    deleteBlock,
    focusedBlockId,
    setFocusedBlock,
  } = useEditorStore();

  // Get root-level blocks (no parent)
  const rootBlocks = blocks.filter((b) => !b.parent_block_id);

  const handleAddBlock = async (afterBlockId?: string, type: BlockType = 'text') => {
    await addBlock(pageId, type, afterBlockId, null, []);
  };

  const handleUpdateBlock = async (blockId: string, content: RichText[]) => {
    await updateBlock(blockId, { content });
  };

  const handleChangeBlockType = async (blockId: string, newType: BlockType) => {
    await updateBlock(blockId, { type: newType });
  };

  const handleDeleteBlock = async (blockId: string) => {
    await deleteBlock(blockId);
  };

  const handleKeyDown = async (
    e: React.KeyboardEvent,
    block: Block,
    blockIndex: number
  ) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      await handleAddBlock(block.id);
    } else if (e.key === 'Backspace') {
      const content = block.content;
      const isEmpty = !content || content.length === 0 ||
        (content.length === 1 && content[0].text === '');

      if (isEmpty && block.type !== 'text') {
        e.preventDefault();
        await handleChangeBlockType(block.id, 'text');
      } else if (isEmpty && block.type === 'text') {
        e.preventDefault();
        if (blockIndex > 0) {
          await handleDeleteBlock(block.id);
          // Focus previous block
          const prevBlock = rootBlocks[blockIndex - 1];
          if (prevBlock) {
            setFocusedBlock(prevBlock.id);
          }
        }
      }
    } else if (e.key === 'ArrowUp') {
      if (blockIndex > 0) {
        const prevBlock = rootBlocks[blockIndex - 1];
        setFocusedBlock(prevBlock.id);
      }
    } else if (e.key === 'ArrowDown') {
      if (blockIndex < rootBlocks.length - 1) {
        const nextBlock = rootBlocks[blockIndex + 1];
        setFocusedBlock(nextBlock.id);
      }
    }
  };

  // Handle slash commands
  const handleSlashCommand = async (blockId: string, command: string) => {
    const typeMap: Record<string, BlockType> = {
      '/h1': 'heading_1',
      '/h2': 'heading_2',
      '/h3': 'heading_3',
      '/bullet': 'bulleted_list',
      '/number': 'numbered_list',
      '/toggle': 'toggle',
      '/code': 'code',
      '/quote': 'quote',
      '/callout': 'callout',
      '/divider': 'divider',
    };

    const newType = typeMap[command.toLowerCase()];
    if (newType) {
      await handleChangeBlockType(blockId, newType);
      await handleUpdateBlock(blockId, []);
    }
  };

  // Get child blocks for a parent
  const getChildBlocks = (parentId: string) => {
    return blocks.filter((b) => b.parent_block_id === parentId);
  };

  return (
    <div className="pb-32">
      {/* Render blocks */}
      {rootBlocks.length === 0 ? (
        <div
          className="notion-block cursor-text"
          onClick={() => handleAddBlock()}
        >
          <span className="notion-placeholder">
            Click here to start writing, or press '/' for commands...
          </span>
        </div>
      ) : (
        rootBlocks.map((block, index) => (
          <BlockComponent
            key={block.id}
            block={block}
            childBlocks={getChildBlocks(block.id)}
            allBlocks={blocks}
            isFocused={focusedBlockId === block.id}
            onFocus={() => setFocusedBlock(block.id)}
            onUpdate={(content) => handleUpdateBlock(block.id, content)}
            onChangeType={(type) => handleChangeBlockType(block.id, type)}
            onDelete={() => handleDeleteBlock(block.id)}
            onAddBlock={(type) => handleAddBlock(block.id, type)}
            onKeyDown={(e) => handleKeyDown(e, block, index)}
            onSlashCommand={(cmd) => handleSlashCommand(block.id, cmd)}
          />
        ))
      )}

      {/* Add block button */}
      <div className="mt-4">
        <button
          className="flex items-center gap-2 text-notion-text-secondary hover:text-notion-text transition-colors px-2 py-1"
          onClick={() => handleAddBlock(rootBlocks[rootBlocks.length - 1]?.id)}
        >
          <Plus className="w-4 h-4" />
          <span className="text-sm">Add a block</span>
        </button>
      </div>

      {/* Child pages section */}
      {childPages.length > 0 && (
        <div className="mt-8 pt-8 border-t border-notion-border">
          <h3 className="text-sm font-medium text-notion-text-secondary mb-4">
            Sub-pages
          </h3>
          <div className="grid gap-2">
            {childPages.map((page) => (
              <a
                key={page.id}
                href={`/page/${page.id}`}
                className="flex items-center gap-2 p-2 rounded hover:bg-notion-hover transition-colors"
              >
                <span>{page.icon || '📄'}</span>
                <span>{page.title || 'Untitled'}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
