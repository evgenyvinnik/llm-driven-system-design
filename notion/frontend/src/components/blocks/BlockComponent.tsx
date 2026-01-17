import { useRef, useEffect, useState } from 'react';
import type { Block, BlockType, RichText } from '@/types';
import {
  GripVertical,
  Plus,
  ChevronRight,
  ChevronDown,
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
import { useEditorStore } from '@/stores/editor';

interface BlockComponentProps {
  block: Block;
  childBlocks: Block[];
  allBlocks: Block[];
  isFocused: boolean;
  onFocus: () => void;
  onUpdate: (content: RichText[]) => void;
  onChangeType: (type: BlockType) => void;
  onDelete: () => void;
  onAddBlock: (type?: BlockType) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSlashCommand: (command: string) => void;
}

const BLOCK_TYPE_ICONS: Record<BlockType, React.ReactNode> = {
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

  // Focus management
  useEffect(() => {
    if (isFocused && contentRef.current) {
      contentRef.current.focus();

      // Place cursor at end
      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(contentRef.current);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [isFocused]);

  // Get text content from RichText array
  const getTextContent = () => {
    return block.content.map((rt) => rt.text).join('');
  };

  // Handle content changes
  const handleInput = () => {
    if (!contentRef.current) return;

    const text = contentRef.current.innerText;

    // Check for slash commands
    if (text.startsWith('/')) {
      const match = text.match(/^\/(\w+)\s/);
      if (match) {
        onSlashCommand('/' + match[1]);
        return;
      }
    }

    onUpdate([{ text }]);
  };

  // Handle key events
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Check for slash command
    if (e.key === '/' && contentRef.current?.innerText === '') {
      setShowMenu(true);
      return;
    }

    // Forward to parent handler
    onKeyDown(e);
  };

  // Toggle expanded state for toggle blocks
  const handleToggle = async () => {
    const newExpanded = !isExpanded;
    setIsExpanded(newExpanded);
    await updateBlock(block.id, { is_collapsed: !newExpanded });
  };

  // Render block content based on type
  const renderBlockContent = () => {
    const placeholder = getPlaceholder(block.type);
    const textContent = getTextContent();

    switch (block.type) {
      case 'heading_1':
        return (
          <div
            ref={contentRef}
            className="notion-heading-1 outline-none"
            contentEditable
            suppressContentEditableWarning
            data-placeholder={placeholder}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={onFocus}
          >
            {textContent}
          </div>
        );

      case 'heading_2':
        return (
          <div
            ref={contentRef}
            className="notion-heading-2 outline-none"
            contentEditable
            suppressContentEditableWarning
            data-placeholder={placeholder}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={onFocus}
          >
            {textContent}
          </div>
        );

      case 'heading_3':
        return (
          <div
            ref={contentRef}
            className="notion-heading-3 outline-none"
            contentEditable
            suppressContentEditableWarning
            data-placeholder={placeholder}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={onFocus}
          >
            {textContent}
          </div>
        );

      case 'bulleted_list':
        return (
          <div className="notion-list-item">
            <span className="text-notion-text mt-0.5">•</span>
            <div
              ref={contentRef}
              className="flex-1 outline-none"
              contentEditable
              suppressContentEditableWarning
              data-placeholder={placeholder}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onFocus={onFocus}
            >
              {textContent}
            </div>
          </div>
        );

      case 'numbered_list':
        return (
          <div className="notion-list-item">
            <span className="text-notion-text mt-0.5 min-w-5">1.</span>
            <div
              ref={contentRef}
              className="flex-1 outline-none"
              contentEditable
              suppressContentEditableWarning
              data-placeholder={placeholder}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onFocus={onFocus}
            >
              {textContent}
            </div>
          </div>
        );

      case 'toggle':
        return (
          <div className="notion-toggle">
            <button
              className={`notion-toggle-icon ${isExpanded ? 'expanded' : ''}`}
              onClick={handleToggle}
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
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onFocus={onFocus}
              >
                {textContent}
              </div>
              {isExpanded && childBlocks.length > 0 && (
                <div className="pl-2 mt-1 border-l-2 border-notion-border">
                  {childBlocks.map((child) => (
                    <BlockComponent
                      key={child.id}
                      block={child}
                      childBlocks={allBlocks.filter(b => b.parent_block_id === child.id)}
                      allBlocks={allBlocks}
                      isFocused={false}
                      onFocus={() => {}}
                      onUpdate={() => {}}
                      onChangeType={() => {}}
                      onDelete={() => {}}
                      onAddBlock={() => {}}
                      onKeyDown={() => {}}
                      onSlashCommand={() => {}}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        );

      case 'code':
        return (
          <pre className="notion-code">
            <code
              ref={contentRef}
              className="outline-none block whitespace-pre-wrap"
              contentEditable
              suppressContentEditableWarning
              data-placeholder={placeholder}
              onInput={handleInput}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // Allow new lines in code blocks
                  e.stopPropagation();
                } else {
                  handleKeyDown(e);
                }
              }}
              onFocus={onFocus}
            >
              {textContent}
            </code>
          </pre>
        );

      case 'quote':
        return (
          <div className="notion-quote">
            <div
              ref={contentRef}
              className="outline-none"
              contentEditable
              suppressContentEditableWarning
              data-placeholder={placeholder}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onFocus={onFocus}
            >
              {textContent}
            </div>
          </div>
        );

      case 'callout':
        return (
          <div className="notion-callout">
            <span className="text-xl">💡</span>
            <div
              ref={contentRef}
              className="flex-1 outline-none"
              contentEditable
              suppressContentEditableWarning
              data-placeholder={placeholder}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onFocus={onFocus}
            >
              {textContent}
            </div>
          </div>
        );

      case 'divider':
        return <hr className="notion-divider" />;

      default:
        return (
          <div
            ref={contentRef}
            className="outline-none min-h-6"
            contentEditable
            suppressContentEditableWarning
            data-placeholder={placeholder}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={onFocus}
          >
            {textContent}
          </div>
        );
    }
  };

  return (
    <div className={`notion-block group ${isFocused ? 'notion-block-focused' : ''}`}>
      {/* Block handle and menu */}
      <div className="notion-block-handle flex items-center gap-0.5 pr-1">
        <button
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-notion-border"
          onClick={() => onAddBlock()}
        >
          <Plus className="w-4 h-4 text-notion-text-secondary" />
        </button>
        <button
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-notion-border cursor-grab"
          onClick={() => setShowMenu(!showMenu)}
        >
          <GripVertical className="w-4 h-4 text-notion-text-secondary" />
        </button>
      </div>

      {/* Block content */}
      {renderBlockContent()}

      {/* Block type menu */}
      {showMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
          <div className="absolute left-0 top-full z-50 bg-white border border-notion-border rounded-md shadow-lg py-1 min-w-48">
            <div className="px-3 py-1 text-xs font-medium text-notion-text-secondary">
              Turn into
            </div>
            {[
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
            ].map(({ type, label }) => (
              <button
                key={type}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-notion-hover text-sm"
                onClick={() => {
                  onChangeType(type as BlockType);
                  setShowMenu(false);
                }}
              >
                {BLOCK_TYPE_ICONS[type as BlockType]}
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function getPlaceholder(type: BlockType): string {
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
