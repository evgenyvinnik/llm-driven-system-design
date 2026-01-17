import type { Operation, TextOperation, DeleteOperation } from '../types/index.js';

/**
 * Operational Transformation Engine
 *
 * This implements a simplified OT algorithm for text operations.
 * The key insight is that operations must be transformed against each other
 * so that they produce the same result regardless of application order.
 */

/**
 * Transform operation op1 against op2.
 * Returns the transformed op1 that should be applied after op2.
 * This is the core of OT - ensures convergent document state.
 *
 * @param op1 - The operation to transform
 * @param op2 - The operation that op1 must be transformed against
 * @returns The transformed version of op1
 */
export function transform(op1: Operation, op2: Operation): Operation {
  // Insert vs Insert
  if (op1.type === 'insert' && op2.type === 'insert') {
    return transformInsertInsert(op1, op2);
  }

  // Insert vs Delete
  if (op1.type === 'insert' && op2.type === 'delete') {
    return transformInsertDelete(op1, op2);
  }

  // Delete vs Insert
  if (op1.type === 'delete' && op2.type === 'insert') {
    return transformDeleteInsert(op1, op2);
  }

  // Delete vs Delete
  if (op1.type === 'delete' && op2.type === 'delete') {
    return transformDeleteDelete(op1, op2);
  }

  // Format operations - simplified handling
  if (op1.type === 'format' || op2.type === 'format') {
    return op1;
  }

  // Retain operations don't need transformation
  return op1;
}

/**
 * Transform insert against insert.
 * Adjusts position based on relative insertion points.
 *
 * @param op1 - Insert operation to transform
 * @param op2 - Insert operation that was applied first
 * @returns Transformed insert operation
 */
function transformInsertInsert(op1: TextOperation, op2: TextOperation): TextOperation {
  if (op1.position < op2.position) {
    // op1 is before op2, no change needed
    return op1;
  } else if (op1.position > op2.position) {
    // op1 is after op2, shift position by length of op2's text
    return {
      ...op1,
      position: op1.position + op2.text.length,
    };
  } else {
    // Same position - use some tie-breaking rule (e.g., by user ID)
    // For simplicity, we'll shift op1 after op2
    return {
      ...op1,
      position: op1.position + op2.text.length,
    };
  }
}

/**
 * Transform insert against delete.
 * Adjusts insert position if delete removed characters before it.
 *
 * @param op1 - Insert operation to transform
 * @param op2 - Delete operation that was applied first
 * @returns Transformed insert operation
 */
function transformInsertDelete(op1: TextOperation, op2: DeleteOperation): TextOperation {
  if (op1.position <= op2.position) {
    // Insert before delete range, no change
    return op1;
  } else if (op1.position >= op2.position + op2.length) {
    // Insert after delete range, shift back
    return {
      ...op1,
      position: op1.position - op2.length,
    };
  } else {
    // Insert within delete range, move to start of delete
    return {
      ...op1,
      position: op2.position,
    };
  }
}

/**
 * Transform delete against insert.
 * Adjusts delete position if insert added characters before it.
 *
 * @param op1 - Delete operation to transform
 * @param op2 - Insert operation that was applied first
 * @returns Transformed delete operation
 */
function transformDeleteInsert(op1: DeleteOperation, op2: TextOperation): DeleteOperation {
  if (op1.position >= op2.position) {
    // Delete is after insert, shift position
    return {
      ...op1,
      position: op1.position + op2.text.length,
    };
  } else if (op1.position + op1.length <= op2.position) {
    // Delete is entirely before insert, no change
    return op1;
  } else {
    // Delete range spans insert point
    // Increase delete length by insert length
    return {
      ...op1,
      length: op1.length + op2.text.length,
    };
  }
}

/**
 * Transform delete against delete.
 * Handles overlapping deletions by adjusting position and length.
 *
 * @param op1 - Delete operation to transform
 * @param op2 - Delete operation that was applied first
 * @returns Transformed delete operation
 */
function transformDeleteDelete(op1: DeleteOperation, op2: DeleteOperation): DeleteOperation {
  // If op1 is entirely before op2
  if (op1.position + op1.length <= op2.position) {
    return op1;
  }

  // If op1 is entirely after op2
  if (op1.position >= op2.position + op2.length) {
    return {
      ...op1,
      position: op1.position - op2.length,
    };
  }

  // Overlapping deletes
  const op1End = op1.position + op1.length;
  const op2End = op2.position + op2.length;

  // op2 contains op1
  if (op2.position <= op1.position && op2End >= op1End) {
    return { ...op1, length: 0 };
  }

  // op1 contains op2
  if (op1.position <= op2.position && op1End >= op2End) {
    return {
      ...op1,
      length: op1.length - op2.length,
    };
  }

  // Partial overlap at start
  if (op2.position <= op1.position && op2End > op1.position) {
    const overlap = op2End - op1.position;
    return {
      type: 'delete',
      position: op2.position,
      length: Math.max(0, op1.length - overlap),
    };
  }

  // Partial overlap at end
  if (op1.position < op2.position && op1End > op2.position) {
    const overlap = op1End - op2.position;
    return {
      type: 'delete',
      position: op1.position,
      length: op1.length - overlap,
    };
  }

  return op1;
}

/**
 * Transform an array of operations against another array.
 * Each operation in ops1 is transformed against all operations in ops2.
 *
 * @param ops1 - Operations to transform
 * @param ops2 - Operations to transform against
 * @returns Transformed array of operations
 */
export function transformOperations(ops1: Operation[], ops2: Operation[]): Operation[] {
  let transformed = [...ops1];

  for (const op2 of ops2) {
    transformed = transformed.map(op1 => transform(op1, op2));
  }

  return transformed;
}

/**
 * Apply an operation to a text string.
 * Returns the resulting text after the operation is applied.
 *
 * @param text - Original text string
 * @param op - Operation to apply
 * @returns Resulting text after operation
 */
export function applyOperationToText(text: string, op: Operation): string {
  switch (op.type) {
    case 'insert':
      return text.slice(0, op.position) + op.text + text.slice(op.position);

    case 'delete':
      return text.slice(0, op.position) + text.slice(op.position + op.length);

    case 'retain':
    case 'format':
      return text;

    default:
      return text;
  }
}

/**
 * Compose multiple operations into one.
 * Filters out no-op operations (empty inserts/deletes).
 *
 * @param ops - Array of operations to compose
 * @returns Filtered array of non-empty operations
 */
export function composeOperations(ops: Operation[]): Operation[] {
  // Simple implementation: just return the operations array
  // A more sophisticated implementation would merge adjacent inserts/deletes
  return ops.filter(op => {
    if (op.type === 'insert') return op.text.length > 0;
    if (op.type === 'delete') return op.length > 0;
    if (op.type === 'retain') return op.length > 0;
    return true;
  });
}

/**
 * Calculate the inverse of an operation (for undo).
 * Insert becomes delete, delete becomes insert.
 *
 * @param op - Operation to invert
 * @param originalText - Text before operation was applied (needed for delete inversion)
 * @returns Inverse operation that undoes the original
 */
export function invertOperation(op: Operation, originalText: string): Operation {
  switch (op.type) {
    case 'insert':
      return {
        type: 'delete',
        position: op.position,
        length: op.text.length,
      };

    case 'delete':
      return {
        type: 'insert',
        position: op.position,
        text: originalText.slice(op.position, op.position + op.length),
      };

    default:
      return op;
  }
}

/**
 * Transform anchor positions for comments/suggestions.
 * Updates anchor positions to remain valid after an operation is applied.
 *
 * @param start - Start position of anchor
 * @param end - End position of anchor
 * @param op - Operation to transform anchor against
 * @returns New anchor positions after operation
 */
export function transformAnchor(
  start: number,
  end: number,
  op: Operation
): { start: number; end: number } {
  switch (op.type) {
    case 'insert':
      if (op.position <= start) {
        return {
          start: start + op.text.length,
          end: end + op.text.length,
        };
      } else if (op.position < end) {
        return {
          start,
          end: end + op.text.length,
        };
      }
      return { start, end };

    case 'delete':
      const deleteEnd = op.position + op.length;

      if (deleteEnd <= start) {
        return {
          start: start - op.length,
          end: end - op.length,
        };
      } else if (op.position >= end) {
        return { start, end };
      } else if (op.position <= start && deleteEnd >= end) {
        // Entire anchor deleted
        return { start: op.position, end: op.position };
      } else if (op.position <= start) {
        const overlap = deleteEnd - start;
        return {
          start: op.position,
          end: end - op.length,
        };
      } else if (deleteEnd >= end) {
        return {
          start,
          end: op.position,
        };
      } else {
        return {
          start,
          end: end - op.length,
        };
      }

    default:
      return { start, end };
  }
}
