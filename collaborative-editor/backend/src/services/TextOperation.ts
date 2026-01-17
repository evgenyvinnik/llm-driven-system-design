import type { Op, OperationData, RetainOp, InsertOp, DeleteOp } from '../types/index.js';

/**
 * TextOperation class implementing Operational Transformation for text editing.
 * Based on the OT algorithm used in Google Wave and similar collaborative editors.
 */
export class TextOperation {
  ops: Op[];
  baseLength: number;
  targetLength: number;

  constructor() {
    this.ops = [];
    this.baseLength = 0;
    this.targetLength = 0;
  }

  /**
   * Create a TextOperation from JSON data
   */
  static fromJSON(data: OperationData): TextOperation {
    const op = new TextOperation();
    op.ops = [...data.ops];
    op.baseLength = data.baseLength;
    op.targetLength = data.targetLength;
    return op;
  }

  /**
   * Convert to JSON-serializable format
   */
  toJSON(): OperationData {
    return {
      ops: this.ops,
      baseLength: this.baseLength,
      targetLength: this.targetLength,
    };
  }

  /**
   * Retain n characters (skip without modifying)
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
   * Insert a string at the current position
   */
  insert(str: string, attributes?: Record<string, unknown>): this {
    if (str.length === 0) return this;
    this.targetLength += str.length;

    const op: InsertOp = { insert: str };
    if (attributes && Object.keys(attributes).length > 0) {
      op.attributes = attributes;
    }

    // Merge with previous insert if possible
    const lastOp = this.ops[this.ops.length - 1];
    if (lastOp && 'insert' in lastOp && !lastOp.attributes && !attributes) {
      lastOp.insert += str;
    } else {
      this.ops.push(op);
    }
    return this;
  }

  /**
   * Delete n characters at the current position
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
   * Check if this is a no-op
   */
  isNoop(): boolean {
    return this.ops.length === 0 || (this.ops.length === 1 && 'retain' in this.ops[0]);
  }

  /**
   * Apply this operation to a string
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

  /**
   * Invert this operation (for undo)
   */
  invert(str: string): TextOperation {
    const inverse = new TextOperation();
    let strIndex = 0;

    for (const op of this.ops) {
      if ('retain' in op) {
        inverse.retain(op.retain);
        strIndex += op.retain;
      } else if ('insert' in op) {
        inverse.delete(op.insert.length);
      } else if ('delete' in op) {
        inverse.insert(str.slice(strIndex, strIndex + op.delete));
        strIndex += op.delete;
      }
    }

    return inverse;
  }
}

/**
 * Helper functions for type checking operations
 */
export function isRetain(op: Op): op is RetainOp {
  return 'retain' in op;
}

export function isInsert(op: Op): op is InsertOp {
  return 'insert' in op;
}

export function isDelete(op: Op): op is DeleteOp {
  return 'delete' in op;
}

/**
 * Get the length of an operation component
 */
export function opLength(op: Op): number {
  if (isRetain(op)) return op.retain;
  if (isInsert(op)) return op.insert.length;
  if (isDelete(op)) return op.delete;
  return 0;
}
