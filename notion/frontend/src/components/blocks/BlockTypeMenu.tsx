/**
 * @fileoverview Block type menu component.
 * Renders the dropdown menu for changing block types via slash commands.
 */

import {
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ChevronRightSquare,
  Code,
  Quote,
  AlertCircle,
  Minus,
} from 'lucide-react';
import type { BlockType } from '@/types';

/**
 * Configuration for a menu item in the block type menu.
 */
interface BlockTypeMenuItem {
  /** The block type identifier */
  type: BlockType;
  /** Display label for the menu item */
  label: string;
}

/**
 * Props for the BlockTypeMenu component.
 */
interface BlockTypeMenuProps {
  /** Whether the menu is currently visible */
  isOpen: boolean;
  /** Callback to close the menu */
  onClose: () => void;
  /** Callback when a block type is selected */
  onSelectType: (type: BlockType) => void;
}

/**
 * Icon mapping for each supported block type.
 * Used to display visual indicators in the type selection menu.
 */
export const BLOCK_TYPE_ICONS: Record<BlockType, React.ReactNode> = {
  text: <Type className="w-4 h-4" />,
  heading_1: <Heading1 className="w-4 h-4" />,
  heading_2: <Heading2 className="w-4 h-4" />,
  heading_3: <Heading3 className="w-4 h-4" />,
  bulleted_list: <List className="w-4 h-4" />,
  numbered_list: <ListOrdered className="w-4 h-4" />,
  toggle: <ChevronRightSquare className="w-4 h-4" />,
  code: <Code className="w-4 h-4" />,
  quote: <Quote className="w-4 h-4" />,
  callout: <AlertCircle className="w-4 h-4" />,
  divider: <Minus className="w-4 h-4" />,
  image: <Type className="w-4 h-4" />,
  video: <Type className="w-4 h-4" />,
  embed: <Type className="w-4 h-4" />,
  table: <Type className="w-4 h-4" />,
  database: <Type className="w-4 h-4" />,
};

/**
 * List of block types available in the conversion menu.
 * Subset of all types that users can convert blocks to.
 */
const MENU_ITEMS: BlockTypeMenuItem[] = [
  { type: 'text', label: 'Text' },
  { type: 'heading_1', label: 'Heading 1' },
  { type: 'heading_2', label: 'Heading 2' },
  { type: 'heading_3', label: 'Heading 3' },
  { type: 'bulleted_list', label: 'Bulleted List' },
  { type: 'numbered_list', label: 'Numbered List' },
  { type: 'toggle', label: 'Toggle' },
  { type: 'code', label: 'Code' },
  { type: 'quote', label: 'Quote' },
  { type: 'callout', label: 'Callout' },
  { type: 'divider', label: 'Divider' },
];

/**
 * BlockTypeMenu renders a dropdown menu for selecting block types.
 * Displayed when the user clicks the grip handle or uses slash commands.
 * Includes an overlay to close the menu when clicking outside.
 *
 * @param props - Component props including open state and callbacks
 * @returns A positioned dropdown menu or null if closed
 *
 * @example
 * ```tsx
 * <BlockTypeMenu
 *   isOpen={showMenu}
 *   onClose={() => setShowMenu(false)}
 *   onSelectType={(type) => handleTypeChange(type)}
 * />
 * ```
 */
export function BlockTypeMenu({
  isOpen,
  onClose,
  onSelectType,
}: BlockTypeMenuProps) {
  if (!isOpen) {
    return null;
  }

  /**
   * Handles selection of a block type from the menu.
   * Calls the selection callback and closes the menu.
   *
   * @param type - The selected block type
   */
  const handleSelect = (type: BlockType) => {
    onSelectType(type);
    onClose();
  };

  return (
    <>
      {/* Overlay to capture clicks outside the menu */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Menu dropdown */}
      <div
        className="absolute left-0 top-full z-50 bg-white border border-notion-border rounded-md shadow-lg py-1 min-w-48"
        role="menu"
        aria-label="Block type menu"
      >
        <div className="px-3 py-1 text-xs font-medium text-notion-text-secondary">
          Turn into
        </div>
        {MENU_ITEMS.map(({ type, label }) => (
          <button
            key={type}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-notion-hover text-sm"
            onClick={() => handleSelect(type)}
            role="menuitem"
          >
            {BLOCK_TYPE_ICONS[type]}
            {label}
          </button>
        ))}
      </div>
    </>
  );
}
