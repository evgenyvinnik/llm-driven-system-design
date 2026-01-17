import type { Op, OperationData, RetainOp, InsertOp, DeleteOp } from '../types';

/**
 * TextOperation class implementing Operational Transformation for text editing.
 *
 * This is the client-side implementation of the OT algorithm.
 * Operations are represented as a sequence of retain, insert, and delete
 * components that describe a transformation from one document state to another.
 *
 * Used for:
 * - Creating operations from user edits
 * - Applying remote operations to the local document
 * - Serializing operations for transmission to the server
 *
 * @see backend TextOperation for the server-side implementation
 */
export class TextOperation {
  /** Array of operation components (retain, insert, delete) */
  ops: Op[];
  /** Length of the document this operation expects as input */
  baseLength: number;
  /** Length of the document after applying this operation */
  targetLength: number;

  constructor() {
    this.ops = [];
    this.baseLength = 0;
    this.targetLength = 0;
  }

  /**
   * Create a TextOperation from JSON data.
   * Used to deserialize operations received from the server.
   *
   * @param data - The serialized operation data
   * @returns A new TextOperation instance
   */
  static fromJSON(data: OperationData): TextOperation {
    const op = new TextOperation();
    op.ops = [...data.ops];
    op.baseLength = data.baseLength;
    op.targetLength = data.targetLength;
    return op;
  }

  /**
   * Convert to JSON-serializable format.
   * Used when sending operations to the server.
   *
   * @returns The operation data as a plain object
   */
  toJSON(): OperationData {
    return {
      ops: this.ops,
      baseLength: this.baseLength,
      targetLength: this.targetLength,
    };
  }

  /**
   * Retain n characters (skip without modifying).
   * Advances the cursor position without making changes.
   *
   * @param n - Number of characters to retain
   * @returns This operation for method chaining
   */
  retain(n: number): this {
    if (n <= 0) return this;
    this.baseLength += n;
    this.targetLength += n;

    const lastOp = this.ops[this.ops.length - 1];
    if (lastOp && 'retain' in lastOp) {
      lastOp.retain += n;
    } else {
      this.ops.push({ retain: n });
    }
    return this;
  }

  /**
   * Insert a string at the current position.
   * The inserted text becomes part of the output document.
   *
   * @param str - The string to insert
   * @param attributes - Optional formatting attributes for rich text
   * @returns This operation for method chaining
   */
  insert(str: string, attributes?: Record<string, unknown>): this {
    if (str.length === 0) return this;
    this.targetLength += str.length;

    const op: InsertOp = { insert: str };
    if (attributes && Object.keys(attributes).length > 0) {
      op.attributes = attributes;
    }

    const lastOp = this.ops[this.ops.length - 1];
    if (lastOp && 'insert' in lastOp && !lastOp.attributes && !attributes) {
      lastOp.insert += str;
    } else {
      this.ops.push(op);
    }
    return this;
  }

  /**
   * Delete n characters at the current position.
   * Removes characters from the input document.
   *
   * @param n - Number of characters to delete
   * @returns This operation for method chaining
   */
  delete(n: number): this {
    if (n <= 0) return this;
    this.baseLength += n;

    const lastOp = this.ops[this.ops.length - 1];
    if (lastOp && 'delete' in lastOp) {
      lastOp.delete += n;
    } else {
      this.ops.push({ delete: n });
    }
    return this;
  }

  /**
   * Check if this operation has no effect on the document.
   * A no-op either has no operations or only retains the entire document.
   *
   * @returns True if applying this operation would not change the document
   */
  isNoop(): boolean {
    return this.ops.length === 0 || (this.ops.length === 1 && 'retain' in this.ops[0]);
  }

  /**
   * Apply this operation to a string.
   * Transforms the input string according to the operation sequence.
   *
   * @param str - The input string (must match baseLength)
   * @returns The transformed string
   * @throws Error if the input string length does not match baseLength
   */
  apply(str: string): string {
    if (str.length !== this.baseLength) {
      throw new Error(
        `Base length mismatch: expected ${this.baseLength}, got ${str.length}`
      );
    }

    let result = '';
    let strIndex = 0;

    for (const op of this.ops) {
      if ('retain' in op) {
        result += str.slice(strIndex, strIndex + op.retain);
        strIndex += op.retain;
      } else if ('insert' in op) {
        result += op.insert;
      } else if ('delete' in op) {
        strIndex += op.delete;
      }
    }

    return result;
  }
}

/**
 * Type guard to check if an operation component is a retain.
 *
 * @param op - The operation component to check
 * @returns True if the operation is a RetainOp
 */
export function isRetain(op: Op): op is RetainOp {
  return 'retain' in op;
}

/**
 * Type guard to check if an operation component is an insert.
 *
 * @param op - The operation component to check
 * @returns True if the operation is an InsertOp
 */
export function isInsert(op: Op): op is InsertOp {
  return 'insert' in op;
}

/**
 * Type guard to check if an operation component is a delete.
 *
 * @param op - The operation component to check
 * @returns True if the operation is a DeleteOp
 */
export function isDelete(op: Op): op is DeleteOp {
  return 'delete' in op;
}
