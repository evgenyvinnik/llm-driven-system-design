/**
 * Individual spreadsheet cell component with editing and selection support.
 * Uses React.memo for performance optimization in large grids.
 *
 * @module components/Cell
 */

import { memo, useRef, useEffect } from 'react';
import { useSpreadsheetStore } from '../stores/spreadsheet';

/**
 * Props for the Cell component.
 */
interface CellProps {
  /** 0-based row index of this cell */
  rowIndex: number;
  /** 0-based column index of this cell */
  colIndex: number;
  /** CSS positioning styles for virtualized rendering */
  style: React.CSSProperties;
}

/**
 * Renders a single spreadsheet cell with editing, selection, and formatting.
 * Supports double-click to edit, keyboard navigation, and displays cell values.
 * Memoized to prevent unnecessary re-renders in the virtualized grid.
 *
 * @param props - Cell position and styling props
 * @returns The cell element with appropriate state (viewing/editing/selected)
 */
export const Cell = memo(function Cell({ rowIndex, colIndex, style }: CellProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const cell = useSpreadsheetStore((state) => state.getCell(rowIndex, colIndex));
  const isSelected = useSpreadsheetStore((state) => state.isSelected(rowIndex, colIndex));
  const isActive = useSpreadsheetStore((state) => state.isActiveCell(rowIndex, colIndex));
  const editingCell = useSpreadsheetStore((state) => state.editingCell);
  const editValue = useSpreadsheetStore((state) => state.editValue);

  const setActiveCell = useSpreadsheetStore((state) => state.setActiveCell);
  const startSelecting = useSpreadsheetStore((state) => state.startSelecting);
  const stopSelecting = useSpreadsheetStore((state) => state.stopSelecting);
  const extendSelection = useSpreadsheetStore((state) => state.extendSelection);
  const startEditing = useSpreadsheetStore((state) => state.startEditing);
  const setEditValue = useSpreadsheetStore((state) => state.setEditValue);
  const commitEdit = useSpreadsheetStore((state) => state.commitEdit);
  const cancelEdit = useSpreadsheetStore((state) => state.cancelEdit);

  const isEditing = editingCell?.row === rowIndex && editingCell?.col === colIndex;

  // Auto-focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  /**
   * Handles mouse down for cell selection.
   * Sets this cell as active and begins drag selection.
   */
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setActiveCell(rowIndex, colIndex);
    startSelecting();
  };

  /**
   * Extends selection when dragging over cells.
   */
  const handleMouseEnter = () => {
    extendSelection(rowIndex, colIndex);
  };

  /**
   * Ends drag selection on mouse up.
   */
  const handleMouseUp = () => {
    stopSelecting();
  };

  /**
   * Enters edit mode on double-click.
   */
  const handleDoubleClick = () => {
    startEditing(rowIndex, colIndex);
  };

  /**
   * Updates edit value as user types.
   */
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  };

  /**
   * Handles keyboard events during editing.
   * Enter commits, Escape cancels, Tab commits and moves.
   */
  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commitEdit();
    }
  };

  /**
   * Commits edit when input loses focus.
   */
  const handleInputBlur = () => {
    commitEdit();
  };

  const displayValue = cell?.computedValue ?? cell?.rawValue ?? '';

  return (
    <div
      className={`cell ${isSelected ? 'selected' : ''} ${isActive ? 'active' : ''}`}
      style={{
        ...style,
        display: 'flex',
        alignItems: 'center',
        boxSizing: 'border-box',
        borderRight: '1px solid #e0e0e0',
        borderBottom: '1px solid #e0e0e0',
        backgroundColor: isSelected ? '#e8f0fe' : 'white',
        outline: isActive ? '2px solid #1a73e8' : 'none',
        outlineOffset: '-2px',
        zIndex: isActive ? 1 : 0,
        overflow: 'hidden',
      }}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
      onMouseUp={handleMouseUp}
      onDoubleClick={handleDoubleClick}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={handleInputChange}
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputBlur}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            outline: 'none',
            padding: '0 4px',
            fontSize: '13px',
            fontFamily: 'Arial, sans-serif',
            backgroundColor: 'white',
          }}
        />
      ) : (
        <span
          style={{
            padding: '0 4px',
            fontSize: '13px',
            fontFamily: 'Arial, sans-serif',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontWeight: cell?.format?.bold ? 'bold' : 'normal',
            fontStyle: cell?.format?.italic ? 'italic' : 'normal',
            color: cell?.format?.color || 'inherit',
          }}
        >
          {displayValue}
        </span>
      )}
    </div>
  );
}, (prev, next) => {
  // Custom comparison to optimize re-renders
  return prev.rowIndex === next.rowIndex && prev.colIndex === next.colIndex;
});
