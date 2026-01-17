/**
 * Renders collaborator cursor and selection overlays for real-time presence.
 * Shows where other users are in the spreadsheet with colored indicators.
 *
 * @module components/CollaboratorCursors
 */

import { useSpreadsheetStore } from '../stores/spreadsheet';

/**
 * Props for the CollaboratorCursors component.
 */
interface CollaboratorCursorsProps {
  /**
   * Function to get the width of a specific column.
   * @param index - Column index
   * @returns Width in pixels
   */
  getColumnWidth: (index: number) => number;

  /**
   * Function to get the height of a specific row.
   * @param index - Row index
   * @returns Height in pixels
   */
  getRowHeight: (index: number) => number;
}

/**
 * Displays cursor positions and selections of other collaborators.
 * Each collaborator has a unique color for their cursor and name label.
 * Selection ranges are shown with semi-transparent overlays.
 *
 * @param props - Functions to calculate cell positions
 * @returns Cursor and selection overlay elements
 */
export function CollaboratorCursors({
  getColumnWidth,
  getRowHeight,
}: CollaboratorCursorsProps) {
  const collaborators = useSpreadsheetStore((state) => state.collaborators);
  const userId = useSpreadsheetStore((state) => state.userId);

  /**
   * Calculates the pixel position and size of a cell.
   * Sums row heights and column widths up to the target position.
   *
   * @param row - Cell row index
   * @param col - Cell column index
   * @returns Position object with top, left, width, and height
   */
  const getCellPosition = (row: number, col: number) => {
    let top = 0;
    let left = 0;

    for (let r = 0; r < row; r++) {
      top += getRowHeight(r);
    }

    for (let c = 0; c < col; c++) {
      left += getColumnWidth(c);
    }

    return { top, left, width: getColumnWidth(col), height: getRowHeight(row) };
  };

  return (
    <>
      {/* Cursor indicators for each collaborator */}
      {Array.from(collaborators.values())
        .filter((collab) => collab.userId !== userId && collab.cursor)
        .map((collab) => {
          const { top, left, width, height } = getCellPosition(
            collab.cursor!.row,
            collab.cursor!.col
          );

          return (
            <div key={collab.userId}>
              {/* Cursor outline around the cell */}
              <div
                style={{
                  position: 'absolute',
                  top,
                  left,
                  width,
                  height,
                  border: `2px solid ${collab.color}`,
                  pointerEvents: 'none',
                  zIndex: 5,
                }}
              />
              {/* Name label above the cursor */}
              <div
                style={{
                  position: 'absolute',
                  top: top - 20,
                  left,
                  backgroundColor: collab.color,
                  color: 'white',
                  fontSize: '11px',
                  padding: '2px 6px',
                  borderRadius: '3px 3px 0 0',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  zIndex: 6,
                }}
              >
                {collab.name}
              </div>
            </div>
          );
        })}

      {/* Selection overlays for collaborators */}
      {Array.from(collaborators.values())
        .filter((collab) => collab.userId !== userId && collab.selection)
        .map((collab) => {
          const { selection } = collab;
          if (!selection) return null;

          // Calculate bounding box for the selection range
          const startPos = getCellPosition(
            Math.min(selection.startRow, selection.endRow),
            Math.min(selection.startCol, selection.endCol)
          );
          const endPos = getCellPosition(
            Math.max(selection.startRow, selection.endRow),
            Math.max(selection.startCol, selection.endCol)
          );

          return (
            <div
              key={`selection-${collab.userId}`}
              style={{
                position: 'absolute',
                top: startPos.top,
                left: startPos.left,
                width: endPos.left + endPos.width - startPos.left,
                height: endPos.top + endPos.height - startPos.top,
                backgroundColor: `${collab.color}20`, // 20% opacity
                border: `1px solid ${collab.color}`,
                pointerEvents: 'none',
                zIndex: 4,
              }}
            />
          );
        })}
    </>
  );
}
