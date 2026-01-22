# Design Notion (Frontend Focus)

## 45-Minute Frontend Interview Answer

### 1. Requirements Clarification (3 minutes)

**Interviewer:** Design a block-based collaboration tool like Notion.

**Candidate:** I'll focus on the frontend architecture. Let me clarify the requirements:

**User-Facing Requirements:**
- Block-based rich text editor with multiple content types
- Real-time collaborative editing with presence indicators
- Hierarchical page navigation in sidebar
- Database views (table, board, list, calendar, gallery)
- Keyboard shortcuts and slash commands

**Technical Requirements:**
- Optimistic updates with instant feedback
- Virtual scrolling for large documents (10,000+ blocks)
- Offline-first with local persistence
- Responsive design for desktop and mobile
- Accessible to screen readers and keyboard users

**Key Interactions:**
- Typing and formatting text
- Drag-and-drop block reordering
- Slash command menu for block type conversion
- Real-time cursor and selection visibility

---

### 2. Component Architecture (5 minutes)

```
┌──────────────────────────────────────────────────────────────────────┐
│                            App Shell                                  │
├─────────────────────┬────────────────────────────────────────────────┤
│                     │                                                │
│      Sidebar        │              Main Content                      │
│  ┌──────────────┐   │  ┌────────────────────────────────────────┐   │
│  │ WorkspaceNav │   │  │           PageHeader                   │   │
│  ├──────────────┤   │  │  (title, icon, cover, breadcrumbs)     │   │
│  │  PageTree    │   │  ├────────────────────────────────────────┤   │
│  │  (recursive) │   │  │           BlockEditor                  │   │
│  ├──────────────┤   │  │  ┌──────────────────────────────────┐  │   │
│  │ QuickFind    │   │  │  │  VirtualizedBlockList            │  │   │
│  ├──────────────┤   │  │  │  ┌────────────────────────────┐  │  │   │
│  │ Favorites    │   │  │  │  │     BlockComponent         │  │  │   │
│  ├──────────────┤   │  │  │  │  (text/heading/list/...)   │  │  │   │
│  │ RecentPages  │   │  │  │  └────────────────────────────┘  │  │   │
│  └──────────────┘   │  │  │  ┌────────────────────────────┐  │  │   │
│                     │  │  │  │     BlockComponent         │  │  │   │
│                     │  │  │  └────────────────────────────┘  │  │   │
│                     │  │  └──────────────────────────────────┘  │   │
│                     │  ├────────────────────────────────────────┤   │
│                     │  │       PresenceIndicators               │   │
│                     │  └────────────────────────────────────────┘   │
└─────────────────────┴────────────────────────────────────────────────┘

Overlay Components:
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│   SlashCommandMenu │  │  BlockDragOverlay  │  │    ShareModal      │
└────────────────────┘  └────────────────────┘  └────────────────────┘
```

---

### 3. Block Editor Deep Dive (8 minutes)

#### Block Component Architecture

```tsx
// Block type delegation pattern
interface BlockProps {
  block: Block;
  isSelected: boolean;
  onUpdate: (content: RichText[]) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

function BlockComponent({ block, isSelected, onUpdate, onKeyDown }: BlockProps) {
  const blockRef = useRef<HTMLDivElement>(null);

  // Focus management for selection
  useEffect(() => {
    if (isSelected && blockRef.current) {
      blockRef.current.focus();
    }
  }, [isSelected]);

  // Render based on block type
  const renderBlock = () => {
    switch (block.type) {
      case 'text':
        return <TextBlock block={block} onUpdate={onUpdate} onKeyDown={onKeyDown} />;
      case 'heading1':
        return <HeadingBlock block={block} level={1} onUpdate={onUpdate} onKeyDown={onKeyDown} />;
      case 'heading2':
        return <HeadingBlock block={block} level={2} onUpdate={onUpdate} onKeyDown={onKeyDown} />;
      case 'heading3':
        return <HeadingBlock block={block} level={3} onUpdate={onUpdate} onKeyDown={onKeyDown} />;
      case 'bulleted_list':
        return <ListBlock block={block} listType="bulleted" onUpdate={onUpdate} onKeyDown={onKeyDown} />;
      case 'numbered_list':
        return <ListBlock block={block} listType="numbered" onUpdate={onUpdate} onKeyDown={onKeyDown} />;
      case 'toggle':
        return <ToggleBlock block={block} onUpdate={onUpdate} onKeyDown={onKeyDown} />;
      case 'code':
        return <CodeBlock block={block} onUpdate={onUpdate} onKeyDown={onKeyDown} />;
      case 'quote':
        return <QuoteBlock block={block} onUpdate={onUpdate} onKeyDown={onKeyDown} />;
      case 'callout':
        return <CalloutBlock block={block} onUpdate={onUpdate} onKeyDown={onKeyDown} />;
      case 'divider':
        return <DividerBlock />;
      case 'image':
        return <ImageBlock block={block} />;
      case 'database':
        return <DatabaseBlock block={block} />;
      default:
        return <TextBlock block={block} onUpdate={onUpdate} onKeyDown={onKeyDown} />;
    }
  };

  return (
    <div
      ref={blockRef}
      className={cn(
        'group relative py-1 px-2',
        isSelected && 'bg-blue-50 ring-1 ring-blue-200'
      )}
      data-block-id={block.id}
      tabIndex={-1}
    >
      {/* Drag handle */}
      <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-full opacity-0 group-hover:opacity-100 transition-opacity">
        <BlockHandle blockId={block.id} />
      </div>

      {/* Block content */}
      {renderBlock()}

      {/* Child blocks for nested structures */}
      {block.children && block.children.length > 0 && (
        <div className="pl-6 border-l-2 border-gray-200 ml-2 mt-1">
          {block.children.map(child => (
            <BlockComponent
              key={child.id}
              block={child}
              isSelected={false}
              onUpdate={onUpdate}
              onKeyDown={onKeyDown}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

#### Rich Text Editor

```tsx
interface RichText {
  text: string;
  annotations: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    code?: boolean;
    color?: string;
  };
  href?: string;
}

function RichTextEditor({
  content,
  onChange,
  onKeyDown,
  placeholder = "Type '/' for commands..."
}: {
  content: RichText[];
  onChange: (content: RichText[]) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  placeholder?: string;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashMenuPosition, setSlashMenuPosition] = useState({ x: 0, y: 0 });

  // Convert RichText array to HTML for contentEditable
  const contentToHtml = (content: RichText[]): string => {
    return content.map(segment => {
      let html = segment.text;

      if (segment.annotations.bold) html = `<strong>${html}</strong>`;
      if (segment.annotations.italic) html = `<em>${html}</em>`;
      if (segment.annotations.underline) html = `<u>${html}</u>`;
      if (segment.annotations.strikethrough) html = `<s>${html}</s>`;
      if (segment.annotations.code) html = `<code class="bg-gray-100 px-1 rounded">${html}</code>`;
      if (segment.href) html = `<a href="${segment.href}" class="text-blue-600 underline">${html}</a>`;
      if (segment.annotations.color) html = `<span style="color: ${segment.annotations.color}">${html}</span>`;

      return html;
    }).join('');
  };

  // Parse HTML back to RichText array
  const htmlToContent = (html: string): RichText[] => {
    // Simplified parsing - production would use proper DOM parsing
    const div = document.createElement('div');
    div.innerHTML = html;
    return parseNode(div);
  };

  const handleInput = () => {
    if (!editorRef.current) return;
    const html = editorRef.current.innerHTML;
    onChange(htmlToContent(html));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle slash command
    if (e.key === '/' && !showSlashMenu) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        setSlashMenuPosition({ x: rect.left, y: rect.bottom });
        setShowSlashMenu(true);
      }
    }

    // Handle formatting shortcuts
    if (e.metaKey || e.ctrlKey) {
      switch (e.key) {
        case 'b':
          e.preventDefault();
          document.execCommand('bold');
          break;
        case 'i':
          e.preventDefault();
          document.execCommand('italic');
          break;
        case 'u':
          e.preventDefault();
          document.execCommand('underline');
          break;
      }
    }

    // Propagate for block-level handling
    onKeyDown(e);
  };

  return (
    <div className="relative">
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        className="outline-none min-h-[24px] whitespace-pre-wrap"
        dangerouslySetInnerHTML={{ __html: contentToHtml(content) }}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        data-placeholder={placeholder}
      />

      {showSlashMenu && (
        <SlashCommandMenu
          position={slashMenuPosition}
          onSelect={(blockType) => {
            setShowSlashMenu(false);
            // Handle block type conversion
          }}
          onClose={() => setShowSlashMenu(false)}
        />
      )}
    </div>
  );
}
```

#### Slash Command Menu

```tsx
const SLASH_COMMANDS = [
  { type: 'text', label: 'Text', icon: TextIcon, description: 'Just start writing with plain text' },
  { type: 'heading1', label: 'Heading 1', icon: H1Icon, description: 'Big section heading' },
  { type: 'heading2', label: 'Heading 2', icon: H2Icon, description: 'Medium section heading' },
  { type: 'heading3', label: 'Heading 3', icon: H3Icon, description: 'Small section heading' },
  { type: 'bulleted_list', label: 'Bulleted List', icon: ListIcon, description: 'Simple bulleted list' },
  { type: 'numbered_list', label: 'Numbered List', icon: NumberedListIcon, description: 'List with numbers' },
  { type: 'toggle', label: 'Toggle', icon: ToggleIcon, description: 'Collapsible content' },
  { type: 'quote', label: 'Quote', icon: QuoteIcon, description: 'Capture a quote' },
  { type: 'code', label: 'Code', icon: CodeIcon, description: 'Code snippet with syntax highlighting' },
  { type: 'callout', label: 'Callout', icon: CalloutIcon, description: 'Make writing stand out' },
  { type: 'divider', label: 'Divider', icon: DividerIcon, description: 'Visual divider line' },
  { type: 'image', label: 'Image', icon: ImageIcon, description: 'Upload or embed an image' },
  { type: 'database', label: 'Database', icon: DatabaseIcon, description: 'Create a new database' },
];

function SlashCommandMenu({
  position,
  onSelect,
  onClose
}: {
  position: { x: number; y: number };
  onSelect: (type: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredCommands = SLASH_COMMANDS.filter(cmd =>
    cmd.label.toLowerCase().includes(search.toLowerCase()) ||
    cmd.type.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(i => (i + 1) % filteredCommands.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(i => (i - 1 + filteredCommands.length) % filteredCommands.length);
          break;
        case 'Enter':
          e.preventDefault();
          if (filteredCommands[selectedIndex]) {
            onSelect(filteredCommands[selectedIndex].type);
          }
          break;
        case 'Escape':
          onClose();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [filteredCommands, selectedIndex, onSelect, onClose]);

  return (
    <div
      className="fixed z-50 bg-white rounded-lg shadow-xl border border-gray-200 w-72 max-h-80 overflow-y-auto"
      style={{ left: position.x, top: position.y + 4 }}
    >
      <div className="p-2 border-b">
        <input
          type="text"
          className="w-full px-2 py-1 text-sm outline-none"
          placeholder="Filter..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSelectedIndex(0);
          }}
          autoFocus
        />
      </div>

      <div className="p-1">
        {filteredCommands.map((cmd, index) => (
          <button
            key={cmd.type}
            className={cn(
              'w-full flex items-center gap-3 px-2 py-2 rounded text-left',
              index === selectedIndex ? 'bg-gray-100' : 'hover:bg-gray-50'
            )}
            onClick={() => onSelect(cmd.type)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <div className="w-8 h-8 bg-gray-100 rounded flex items-center justify-center">
              <cmd.icon className="w-5 h-5 text-gray-600" />
            </div>
            <div>
              <div className="text-sm font-medium">{cmd.label}</div>
              <div className="text-xs text-gray-500">{cmd.description}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
```

---

### 4. Virtual Scrolling for Large Documents (6 minutes)

```tsx
import { useVirtualizer } from '@tanstack/react-virtual';

function VirtualizedBlockList({ blocks, selectedBlockId }: {
  blocks: Block[];
  selectedBlockId: string | null;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { updateBlock, deleteBlock, addBlock } = useBlockStore();

  // Flatten nested blocks for virtualization
  const flattenedBlocks = useMemo(() => {
    const result: { block: Block; depth: number }[] = [];

    const flatten = (blocks: Block[], depth = 0) => {
      for (const block of blocks) {
        result.push({ block, depth });
        if (block.children && block.type !== 'toggle') {
          flatten(block.children, depth + 1);
        }
      }
    };

    flatten(blocks);
    return result;
  }, [blocks]);

  const virtualizer = useVirtualizer({
    count: flattenedBlocks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const { block } = flattenedBlocks[index];
      // Estimate height based on block type
      switch (block.type) {
        case 'heading1':
          return 48;
        case 'heading2':
          return 40;
        case 'heading3':
          return 36;
        case 'code':
          return Math.max(80, block.content.length * 24);
        case 'image':
          return 300;
        case 'divider':
          return 24;
        default:
          return 32;
      }
    },
    overscan: 5,
    measureElement: (element) => {
      return element.getBoundingClientRect().height;
    }
  });

  const handleBlockKeyDown = (blockId: string, e: React.KeyboardEvent) => {
    const index = flattenedBlocks.findIndex(fb => fb.block.id === blockId);

    switch (e.key) {
      case 'Enter':
        if (!e.shiftKey) {
          e.preventDefault();
          // Create new block after current
          addBlock(blockId, 'after');
        }
        break;

      case 'Backspace':
        if (e.currentTarget.textContent === '') {
          e.preventDefault();
          deleteBlock(blockId);
          // Focus previous block
          if (index > 0) {
            const prevBlock = flattenedBlocks[index - 1];
            focusBlock(prevBlock.block.id);
          }
        }
        break;

      case 'ArrowUp':
        if (index > 0) {
          e.preventDefault();
          const prevBlock = flattenedBlocks[index - 1];
          focusBlock(prevBlock.block.id);
        }
        break;

      case 'ArrowDown':
        if (index < flattenedBlocks.length - 1) {
          e.preventDefault();
          const nextBlock = flattenedBlocks[index + 1];
          focusBlock(nextBlock.block.id);
        }
        break;

      case 'Tab':
        e.preventDefault();
        if (e.shiftKey) {
          // Outdent
          outdentBlock(blockId);
        } else {
          // Indent
          indentBlock(blockId);
        }
        break;
    }
  };

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
      style={{ contain: 'strict' }}
    >
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const { block, depth } = flattenedBlocks[virtualRow.index];

          return (
            <div
              key={block.id}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
                paddingLeft: `${depth * 24}px`
              }}
            >
              <BlockComponent
                block={block}
                isSelected={block.id === selectedBlockId}
                onUpdate={(content) => updateBlock(block.id, { content })}
                onKeyDown={(e) => handleBlockKeyDown(block.id, e)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

---

### 5. Database Views (6 minutes)

#### Table View

```tsx
function TableView({ database, rows, view }: {
  database: Database;
  rows: DatabaseRow[];
  view: DatabaseView;
}) {
  const visibleProperties = view.config.visibleProperties || Object.keys(database.schema.properties);
  const sortedRows = useMemo(() => applySorts(rows, view.config.sorts), [rows, view.config.sorts]);
  const filteredRows = useMemo(() => applyFilters(sortedRows, view.config.filters), [sortedRows, view.config.filters]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        {/* Header */}
        <thead>
          <tr className="border-b">
            {visibleProperties.map(propId => {
              const property = database.schema.properties[propId];
              return (
                <th
                  key={propId}
                  className="px-3 py-2 text-left text-sm font-medium text-gray-600 bg-gray-50"
                  style={{ width: view.config.propertyWidths?.[propId] || 200 }}
                >
                  <div className="flex items-center gap-2">
                    <PropertyIcon type={property.type} />
                    <span>{property.name}</span>
                    <SortIndicator
                      sorts={view.config.sorts}
                      propertyId={propId}
                    />
                  </div>
                </th>
              );
            })}
            <th className="w-10">
              <AddPropertyButton databaseId={database.id} />
            </th>
          </tr>
        </thead>

        {/* Body */}
        <tbody>
          {filteredRows.map(row => (
            <tr key={row.id} className="border-b hover:bg-gray-50">
              {visibleProperties.map(propId => (
                <td key={propId} className="px-3 py-2">
                  <PropertyCell
                    property={database.schema.properties[propId]}
                    value={row.properties[propId]}
                    rowId={row.id}
                  />
                </td>
              ))}
              <td></td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Add row button */}
      <button
        className="w-full py-2 text-sm text-gray-500 hover:bg-gray-50 text-left px-3"
        onClick={() => addDatabaseRow(database.id)}
      >
        + New
      </button>
    </div>
  );
}
```

#### Board View (Kanban)

```tsx
function BoardView({ database, rows, view }: {
  database: Database;
  rows: DatabaseRow[];
  view: DatabaseView;
}) {
  const groupByProperty = view.config.groupBy;
  const property = database.schema.properties[groupByProperty];

  // Group rows by select property value
  const groups = useMemo(() => {
    const grouped: Map<string, DatabaseRow[]> = new Map();

    // Initialize groups from select options
    if (property.type === 'select' && property.options) {
      property.options.forEach(opt => grouped.set(opt.id, []));
    }
    grouped.set('__no_value__', []); // For rows without value

    // Distribute rows
    rows.forEach(row => {
      const value = row.properties[groupByProperty];
      const groupId = value?.id || '__no_value__';
      if (grouped.has(groupId)) {
        grouped.get(groupId)!.push(row);
      } else {
        grouped.get('__no_value__')!.push(row);
      }
    });

    return grouped;
  }, [rows, property, groupByProperty]);

  return (
    <DndContext onDragEnd={handleDragEnd}>
      <div className="flex gap-4 p-4 overflow-x-auto min-h-[500px]">
        {Array.from(groups.entries()).map(([groupId, groupRows]) => {
          const option = property.options?.find(o => o.id === groupId);

          return (
            <BoardColumn
              key={groupId}
              id={groupId}
              title={option?.name || 'No Status'}
              color={option?.color}
              rows={groupRows}
              database={database}
              view={view}
            />
          );
        })}

        {/* Add column button for select properties */}
        {property.type === 'select' && (
          <button
            className="min-w-[280px] h-fit px-4 py-2 text-gray-500 hover:bg-gray-100 rounded-lg border-2 border-dashed"
            onClick={() => addSelectOption(database.id, groupByProperty)}
          >
            + Add Group
          </button>
        )}
      </div>
    </DndContext>
  );
}

function BoardColumn({ id, title, color, rows, database, view }: {
  id: string;
  title: string;
  color?: string;
  rows: DatabaseRow[];
  database: Database;
  view: DatabaseView;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'min-w-[280px] max-w-[280px] flex flex-col rounded-lg',
        isOver && 'bg-blue-50'
      )}
    >
      {/* Column header */}
      <div className="flex items-center gap-2 px-2 py-3">
        {color && (
          <div
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <span className="font-medium text-sm">{title}</span>
        <span className="text-gray-400 text-sm">{rows.length}</span>
      </div>

      {/* Cards */}
      <SortableContext items={rows.map(r => r.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2 px-2 pb-2 min-h-[200px]">
          {rows.map(row => (
            <BoardCard
              key={row.id}
              row={row}
              database={database}
              view={view}
            />
          ))}
        </div>
      </SortableContext>

      {/* Add card button */}
      <button
        className="mx-2 mb-2 py-1 text-sm text-gray-500 hover:bg-gray-100 rounded text-left px-2"
        onClick={() => addDatabaseRow(database.id, { [view.config.groupBy]: { id } })}
      >
        + New
      </button>
    </div>
  );
}
```

#### List View

```tsx
function ListView({ database, rows, view }: {
  database: Database;
  rows: DatabaseRow[];
  view: DatabaseView;
}) {
  const titleProperty = Object.values(database.schema.properties).find(p => p.type === 'title');
  const sortedRows = applySorts(rows, view.config.sorts);
  const filteredRows = applyFilters(sortedRows, view.config.filters);

  return (
    <div className="divide-y">
      {filteredRows.map(row => (
        <div
          key={row.id}
          className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 cursor-pointer"
          onClick={() => openRowDetail(row.id)}
        >
          {/* Checkbox if enabled */}
          {view.config.showCheckbox && (
            <input
              type="checkbox"
              checked={row.properties.done?.value || false}
              onChange={(e) => updateRowProperty(row.id, 'done', e.target.checked)}
              className="w-4 h-4"
            />
          )}

          {/* Title */}
          <div className="flex-1 font-medium">
            {row.properties[titleProperty?.id || '']?.value || 'Untitled'}
          </div>

          {/* Preview properties */}
          <div className="flex items-center gap-3 text-sm text-gray-500">
            {view.config.previewProperties?.map(propId => (
              <PropertyPreview
                key={propId}
                property={database.schema.properties[propId]}
                value={row.properties[propId]}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

---

### 6. State Management with Zustand (5 minutes)

```typescript
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';

interface BlockState {
  blocks: Map<string, Block>;
  selectedBlockId: string | null;
  focusedBlockId: string | null;

  // Actions
  setBlocks: (blocks: Block[]) => void;
  updateBlock: (blockId: string, updates: Partial<Block>) => void;
  deleteBlock: (blockId: string) => void;
  addBlock: (afterBlockId: string, position: 'before' | 'after') => void;
  moveBlock: (blockId: string, targetId: string, position: 'before' | 'after' | 'child') => void;
  selectBlock: (blockId: string | null) => void;
  focusBlock: (blockId: string | null) => void;
}

const useBlockStore = create<BlockState>()(
  immer((set, get) => ({
    blocks: new Map(),
    selectedBlockId: null,
    focusedBlockId: null,

    setBlocks: (blocks) => set(state => {
      state.blocks = new Map(blocks.map(b => [b.id, b]));
    }),

    updateBlock: (blockId, updates) => set(state => {
      const block = state.blocks.get(blockId);
      if (block) {
        Object.assign(block, updates);
        block.updatedAt = new Date();
      }
    }),

    deleteBlock: (blockId) => set(state => {
      state.blocks.delete(blockId);
      if (state.selectedBlockId === blockId) {
        state.selectedBlockId = null;
      }
    }),

    addBlock: (afterBlockId, position) => set(state => {
      const referenceBlock = state.blocks.get(afterBlockId);
      if (!referenceBlock) return;

      const newBlock: Block = {
        id: crypto.randomUUID(),
        type: 'text',
        parentId: referenceBlock.parentId,
        pageId: referenceBlock.pageId,
        position: generatePosition(referenceBlock.position, position),
        properties: {},
        content: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1
      };

      state.blocks.set(newBlock.id, newBlock);
      state.focusedBlockId = newBlock.id;
    }),

    moveBlock: (blockId, targetId, position) => set(state => {
      const block = state.blocks.get(blockId);
      const target = state.blocks.get(targetId);
      if (!block || !target) return;

      if (position === 'child') {
        block.parentId = targetId;
        block.position = 'a'; // First child
      } else {
        block.parentId = target.parentId;
        block.position = generatePosition(target.position, position);
      }
    }),

    selectBlock: (blockId) => set(state => {
      state.selectedBlockId = blockId;
    }),

    focusBlock: (blockId) => set(state => {
      state.focusedBlockId = blockId;
    })
  }))
);

// Presence store for real-time collaboration
interface PresenceState {
  users: Map<string, { name: string; color: string; cursor?: { blockId: string; offset: number } }>;
  setUsers: (users: Array<{ id: string; name: string; color: string }>) => void;
  updateCursor: (userId: string, cursor: { blockId: string; offset: number }) => void;
  removeUser: (userId: string) => void;
}

const usePresenceStore = create<PresenceState>()(
  immer((set) => ({
    users: new Map(),

    setUsers: (users) => set(state => {
      state.users = new Map(users.map(u => [u.id, { name: u.name, color: u.color }]));
    }),

    updateCursor: (userId, cursor) => set(state => {
      const user = state.users.get(userId);
      if (user) {
        user.cursor = cursor;
      }
    }),

    removeUser: (userId) => set(state => {
      state.users.delete(userId);
    })
  }))
);

// Page tree store with persistence
interface PageTreeState {
  pages: Map<string, Page>;
  expandedPages: Set<string>;
  toggleExpanded: (pageId: string) => void;
  setPages: (pages: Page[]) => void;
}

const usePageTreeStore = create<PageTreeState>()(
  persist(
    immer((set) => ({
      pages: new Map(),
      expandedPages: new Set(),

      toggleExpanded: (pageId) => set(state => {
        if (state.expandedPages.has(pageId)) {
          state.expandedPages.delete(pageId);
        } else {
          state.expandedPages.add(pageId);
        }
      }),

      setPages: (pages) => set(state => {
        state.pages = new Map(pages.map(p => [p.id, p]));
      })
    })),
    {
      name: 'notion-page-tree',
      partialize: (state) => ({ expandedPages: Array.from(state.expandedPages) })
    }
  )
);
```

---

### 7. Presence and Cursors (4 minutes)

```tsx
// Cursor overlay showing other users' positions
function PresenceCursors() {
  const users = usePresenceStore(state => state.users);

  return (
    <>
      {Array.from(users.entries()).map(([userId, user]) => {
        if (!user.cursor) return null;

        return (
          <RemoteCursor
            key={userId}
            blockId={user.cursor.blockId}
            offset={user.cursor.offset}
            color={user.color}
            name={user.name}
          />
        );
      })}
    </>
  );
}

function RemoteCursor({ blockId, offset, color, name }: {
  blockId: string;
  offset: number;
  color: string;
  name: string;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const blockElement = document.querySelector(`[data-block-id="${blockId}"]`);
    if (!blockElement) return;

    // Find cursor position within block
    const textNode = blockElement.querySelector('[contenteditable]');
    if (!textNode) return;

    const range = document.createRange();
    const textContent = textNode.firstChild;
    if (textContent && textContent.nodeType === Node.TEXT_NODE) {
      const clampedOffset = Math.min(offset, textContent.textContent?.length || 0);
      range.setStart(textContent, clampedOffset);
      range.setEnd(textContent, clampedOffset);

      const rect = range.getBoundingClientRect();
      setPosition({ x: rect.left, y: rect.top });
    }
  }, [blockId, offset]);

  if (!position) return null;

  return (
    <div
      className="fixed pointer-events-none z-50"
      style={{ left: position.x, top: position.y }}
    >
      {/* Cursor line */}
      <div
        className="w-0.5 h-5 animate-pulse"
        style={{ backgroundColor: color }}
      />

      {/* Name label */}
      <div
        className="absolute top-0 left-1 px-1.5 py-0.5 rounded text-xs text-white whitespace-nowrap"
        style={{ backgroundColor: color }}
      >
        {name}
      </div>
    </div>
  );
}

// Presence avatars in page header
function PresenceAvatars() {
  const users = usePresenceStore(state => state.users);
  const displayedUsers = Array.from(users.values()).slice(0, 5);
  const remainingCount = users.size - 5;

  return (
    <div className="flex items-center -space-x-2">
      {displayedUsers.map((user, index) => (
        <div
          key={index}
          className="w-8 h-8 rounded-full border-2 border-white flex items-center justify-center text-white text-xs font-medium"
          style={{ backgroundColor: user.color }}
          title={user.name}
        >
          {user.name.charAt(0).toUpperCase()}
        </div>
      ))}

      {remainingCount > 0 && (
        <div className="w-8 h-8 rounded-full bg-gray-300 border-2 border-white flex items-center justify-center text-xs font-medium text-gray-600">
          +{remainingCount}
        </div>
      )}
    </div>
  );
}
```

---

### 8. Sidebar Navigation (4 minutes)

```tsx
function Sidebar() {
  const [width, setWidth] = useState(260);
  const pages = usePageTreeStore(state => state.pages);

  // Build tree structure
  const rootPages = useMemo(() => {
    return Array.from(pages.values())
      .filter(p => !p.parentId)
      .sort((a, b) => a.position.localeCompare(b.position));
  }, [pages]);

  return (
    <div
      className="h-full bg-gray-50 flex flex-col border-r relative"
      style={{ width }}
    >
      {/* Workspace header */}
      <div className="p-3 border-b">
        <WorkspaceSwitcher />
      </div>

      {/* Quick actions */}
      <div className="p-2 space-y-1">
        <SidebarItem icon={SearchIcon} label="Quick Find" shortcut="Cmd+K" onClick={openQuickFind} />
        <SidebarItem icon={SettingsIcon} label="Settings" onClick={openSettings} />
      </div>

      {/* Favorites */}
      <div className="px-2 py-2">
        <div className="text-xs font-medium text-gray-500 px-2 mb-1">Favorites</div>
        {/* Favorite pages */}
      </div>

      {/* Page tree */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <div className="text-xs font-medium text-gray-500 px-2 mb-1">Private</div>
        {rootPages.map(page => (
          <PageTreeItem key={page.id} page={page} depth={0} />
        ))}
      </div>

      {/* New page button */}
      <div className="p-2 border-t">
        <button
          className="w-full flex items-center gap-2 px-2 py-1.5 text-gray-600 hover:bg-gray-200 rounded"
          onClick={createNewPage}
        >
          <PlusIcon className="w-4 h-4" />
          <span className="text-sm">New page</span>
        </button>
      </div>

      {/* Resize handle */}
      <div
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-400 transition-colors"
        onMouseDown={startResize}
      />
    </div>
  );
}

function PageTreeItem({ page, depth }: { page: Page; depth: number }) {
  const expandedPages = usePageTreeStore(state => state.expandedPages);
  const toggleExpanded = usePageTreeStore(state => state.toggleExpanded);
  const pages = usePageTreeStore(state => state.pages);

  const isExpanded = expandedPages.has(page.id);
  const childPages = useMemo(() => {
    return Array.from(pages.values())
      .filter(p => p.parentId === page.id)
      .sort((a, b) => a.position.localeCompare(b.position));
  }, [pages, page.id]);

  const hasChildren = childPages.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-200 cursor-pointer group"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {/* Expand/collapse toggle */}
        <button
          className={cn(
            'w-5 h-5 flex items-center justify-center rounded hover:bg-gray-300',
            !hasChildren && 'invisible'
          )}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded(page.id);
          }}
        >
          <ChevronIcon
            className={cn(
              'w-4 h-4 transition-transform',
              isExpanded && 'rotate-90'
            )}
          />
        </button>

        {/* Page icon */}
        <span className="text-lg">{page.icon || '📄'}</span>

        {/* Page title */}
        <span className="flex-1 text-sm truncate">
          {page.title || 'Untitled'}
        </span>

        {/* Actions (visible on hover) */}
        <div className="hidden group-hover:flex items-center gap-1">
          <button
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-300"
            onClick={(e) => {
              e.stopPropagation();
              createChildPage(page.id);
            }}
          >
            <PlusIcon className="w-3 h-3" />
          </button>
          <button className="w-5 h-5 flex items-center justify-center rounded hover:bg-gray-300">
            <MoreIcon className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Children */}
      {isExpanded && hasChildren && (
        <div>
          {childPages.map(child => (
            <PageTreeItem key={child.id} page={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
```

---

### 9. Trade-offs and Decisions

| Decision | Chosen Approach | Alternative | Rationale |
|----------|----------------|-------------|-----------|
| Rich text editing | contentEditable | ProseMirror/Slate | Simpler for MVP, custom control |
| Block rendering | Component delegation | Single switch | Easier to extend, isolated logic |
| Virtualization | @tanstack/react-virtual | react-window | Better dynamic height support |
| State management | Zustand + immer | Redux Toolkit | Simpler API, less boilerplate |
| Drag and drop | @dnd-kit | react-beautiful-dnd | More flexible, better for nested |
| Styling | Tailwind CSS | CSS Modules | Faster iteration, consistent design |

---

### 10. Future Frontend Enhancements

1. **Full ProseMirror/Slate integration** - Production-grade rich text editing
2. **Collaborative cursors with Yjs** - Character-level cursor sync
3. **Offline with IndexedDB** - Full offline-first with background sync
4. **Mobile-responsive** - Touch gestures for block manipulation
5. **Keyboard accessibility** - Full screen reader support
6. **Animation polish** - Smooth block transitions with Framer Motion
