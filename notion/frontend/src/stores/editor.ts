/**
 * @fileoverview Editor state store for block-based content editing.
 * Manages blocks, selection state, and real-time collaboration features.
 * Implements optimistic updates with rollback on failure.
 */

import { create } from 'zustand';
import type { Block, Operation, Presence, RichText, BlockType } from '@/types';
import { blocksApi, pagesApi } from '@/services/api';
import { wsService } from '@/services/websocket';
import { v4 as uuidv4 } from './uuid';

/**
 * Editor state interface.
 * Contains block data, selection state, presence info, and CRUD actions.
 */
interface EditorState {
  blocks: Block[];
  selectedBlockId: string | null;
  focusedBlockId: string | null;
  presence: Presence[];
  isLoading: boolean;
  lastSyncTimestamp: number;

  // Actions
  loadBlocks: (pageId: string) => Promise<void>;
  setBlocks: (blocks: Block[]) => void;
  addBlock: (
    pageId: string,
    type: BlockType,
    afterBlockId?: string,
    parentBlockId?: string | null,
    content?: RichText[]
  ) => Promise<Block>;
  updateBlock: (blockId: string, updates: Partial<Block>) => Promise<void>;
  deleteBlock: (blockId: string) => Promise<void>;
  moveBlock: (blockId: string, parentBlockId?: string | null, afterBlockId?: string) => Promise<void>;
  setSelectedBlock: (blockId: string | null) => void;
  setFocusedBlock: (blockId: string | null) => void;

  // Real-time
  applyRemoteOperation: (operation: Operation) => void;
  setPresence: (presence: Presence[]) => void;
  addPresence: (presence: Presence) => void;
  removePresence: (userId: string) => void;
  updatePresencePosition: (userId: string, cursorPosition?: { block_id: string; offset: number }) => void;
}

/**
 * Generates a random UUID v4 for temporary IDs.
 * Used for optimistic updates before server confirmation.
 *
 * @returns A UUID v4 string
 */
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Editor store for managing block content and real-time collaboration.
 * Implements optimistic updates with rollback, and broadcasts operations
 * via WebSocket for real-time sync with other users.
 */
export const useEditorStore = create<EditorState>((set, get) => ({
  blocks: [],
  selectedBlockId: null,
  focusedBlockId: null,
  presence: [],
  isLoading: false,
  lastSyncTimestamp: 0,

  loadBlocks: async (pageId) => {
    set({ isLoading: true });
    try {
      const { blocks } = await pagesApi.get(pageId);
      set({ blocks, isLoading: false, lastSyncTimestamp: Date.now() });
    } catch (error) {
      console.error('Failed to load blocks:', error);
      set({ isLoading: false });
    }
  },

  setBlocks: (blocks) => {
    set({ blocks });
  },

  addBlock: async (pageId, type, afterBlockId, parentBlockId, content) => {
    const tempId = generateId();

    // Optimistic update
    const tempBlock: Block = {
      id: tempId,
      page_id: pageId,
      parent_block_id: parentBlockId || null,
      type,
      properties: {},
      content: content || [],
      position: 'temp',
      version: 0,
      is_collapsed: false,
      created_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    set((state) => {
      const blocks = [...state.blocks];
      if (afterBlockId) {
        const index = blocks.findIndex((b) => b.id === afterBlockId);
        if (index !== -1) {
          blocks.splice(index + 1, 0, tempBlock);
        } else {
          blocks.push(tempBlock);
        }
      } else {
        blocks.push(tempBlock);
      }
      return { blocks };
    });

    try {
      const { block } = await blocksApi.create({
        page_id: pageId,
        type,
        parent_block_id: parentBlockId,
        content: content || [],
        after_block_id: afterBlockId,
      });

      // Replace temp block with real one
      set((state) => ({
        blocks: state.blocks.map((b) => (b.id === tempId ? block : b)),
        focusedBlockId: block.id,
      }));

      // Send operation to other clients
      wsService.sendOperation({
        id: generateId(),
        page_id: pageId,
        block_id: block.id,
        type: 'insert',
        data: block as unknown as Record<string, unknown>,
      });

      return block;
    } catch (error) {
      // Rollback on error
      set((state) => ({
        blocks: state.blocks.filter((b) => b.id !== tempId),
      }));
      throw error;
    }
  },

  updateBlock: async (blockId, updates) => {
    const currentBlock = get().blocks.find((b) => b.id === blockId);
    if (!currentBlock) return;

    // Optimistic update
    set((state) => ({
      blocks: state.blocks.map((b) =>
        b.id === blockId ? { ...b, ...updates, version: b.version + 1 } : b
      ),
    }));

    try {
      const { block } = await blocksApi.update(blockId, updates);

      // Update with server response
      set((state) => ({
        blocks: state.blocks.map((b) => (b.id === blockId ? block : b)),
      }));

      // Send operation to other clients
      wsService.sendOperation({
        id: generateId(),
        page_id: currentBlock.page_id,
        block_id: blockId,
        type: 'update',
        data: { before: currentBlock, after: block } as unknown as Record<string, unknown>,
      });
    } catch (error) {
      // Rollback on error
      set((state) => ({
        blocks: state.blocks.map((b) => (b.id === blockId ? currentBlock : b)),
      }));
      throw error;
    }
  },

  deleteBlock: async (blockId) => {
    const currentBlock = get().blocks.find((b) => b.id === blockId);
    if (!currentBlock) return;

    // Optimistic update
    set((state) => ({
      blocks: state.blocks.filter((b) => b.id !== blockId && b.parent_block_id !== blockId),
      selectedBlockId: state.selectedBlockId === blockId ? null : state.selectedBlockId,
      focusedBlockId: state.focusedBlockId === blockId ? null : state.focusedBlockId,
    }));

    try {
      await blocksApi.delete(blockId);

      // Send operation to other clients
      wsService.sendOperation({
        id: generateId(),
        page_id: currentBlock.page_id,
        block_id: blockId,
        type: 'delete',
        data: { id: blockId },
      });
    } catch (error) {
      // Rollback on error
      set((state) => ({
        blocks: [...state.blocks, currentBlock],
      }));
      throw error;
    }
  },

  moveBlock: async (blockId, parentBlockId, afterBlockId) => {
    const currentBlock = get().blocks.find((b) => b.id === blockId);
    if (!currentBlock) return;

    // Optimistic update (simplified - just update parent)
    set((state) => ({
      blocks: state.blocks.map((b) =>
        b.id === blockId ? { ...b, parent_block_id: parentBlockId || null } : b
      ),
    }));

    try {
      const { block } = await blocksApi.move(blockId, parentBlockId, afterBlockId);

      set((state) => ({
        blocks: state.blocks.map((b) => (b.id === blockId ? block : b)),
      }));

      // Send operation to other clients
      wsService.sendOperation({
        id: generateId(),
        page_id: currentBlock.page_id,
        block_id: blockId,
        type: 'move',
        data: {
          from: { parent: currentBlock.parent_block_id, position: currentBlock.position },
          to: { parent: parentBlockId || null, position: block.position },
        },
      });
    } catch (error) {
      // Rollback on error
      set((state) => ({
        blocks: state.blocks.map((b) => (b.id === blockId ? currentBlock : b)),
      }));
      throw error;
    }
  },

  setSelectedBlock: (blockId) => {
    set({ selectedBlockId: blockId });
  },

  setFocusedBlock: (blockId) => {
    set({ focusedBlockId: blockId });
    if (blockId) {
      const block = get().blocks.find((b) => b.id === blockId);
      if (block) {
        wsService.updatePresence({ block_id: blockId, offset: 0 });
      }
    }
  },

  applyRemoteOperation: (operation) => {
    set((state) => {
      const blocks = [...state.blocks];

      switch (operation.type) {
        case 'insert': {
          const newBlock = operation.data as unknown as Block;
          if (!blocks.find((b) => b.id === newBlock.id)) {
            blocks.push(newBlock);
            blocks.sort((a, b) => a.position.localeCompare(b.position));
          }
          break;
        }
        case 'update': {
          const data = operation.data as { after: Block };
          const index = blocks.findIndex((b) => b.id === operation.block_id);
          if (index !== -1) {
            blocks[index] = data.after;
          }
          break;
        }
        case 'delete': {
          return {
            blocks: blocks.filter((b) => b.id !== operation.block_id && b.parent_block_id !== operation.block_id),
          };
        }
        case 'move': {
          const data = operation.data as { to: { parent: string | null; position: string } };
          const index = blocks.findIndex((b) => b.id === operation.block_id);
          if (index !== -1) {
            blocks[index] = {
              ...blocks[index],
              parent_block_id: data.to.parent,
              position: data.to.position,
            };
            blocks.sort((a, b) => a.position.localeCompare(b.position));
          }
          break;
        }
      }

      return { blocks, lastSyncTimestamp: operation.timestamp };
    });
  },

  setPresence: (presence) => {
    set({ presence });
  },

  addPresence: (newPresence) => {
    set((state) => ({
      presence: [...state.presence.filter((p) => p.user_id !== newPresence.user_id), newPresence],
    }));
  },

  removePresence: (userId) => {
    set((state) => ({
      presence: state.presence.filter((p) => p.user_id !== userId),
    }));
  },

  updatePresencePosition: (userId, cursorPosition) => {
    set((state) => ({
      presence: state.presence.map((p) =>
        p.user_id === userId ? { ...p, cursor_position: cursorPosition } : p
      ),
    }));
  },
}));
