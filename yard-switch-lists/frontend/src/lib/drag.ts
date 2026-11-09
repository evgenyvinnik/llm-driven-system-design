/**
 * The geometry of dragging a row: pure, so it can be unit tested without a DOM.
 */

/** Which index a dragged row should land at, given where the pointer is. */
export function insertionIndex(pointerY: number, rows: { top: number; bottom: number }[], fromIndex: number): number {
  for (let i = 0; i < rows.length; i++) {
    const mid = (rows[i].top + rows[i].bottom) / 2
    if (pointerY < mid) return i > fromIndex ? i - 1 : i
  }
  return rows.length - 1
}

/** Index to send the server, after this row is taken out of the list. */
export function clampToEditable(toIndex: number, firstEditable: number, length: number): number {
  return Math.max(firstEditable, Math.min(length - 1, toIndex))
}
