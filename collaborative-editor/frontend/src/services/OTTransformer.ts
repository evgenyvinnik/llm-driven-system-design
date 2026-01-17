import { TextOperation, isRetain, isInsert, isDelete } from './TextOperation';
import type { Op } from '../types';

/**
 * OT Transformer for client-side operation transformation.
 *
 * This class provides the transform and compose functions needed
 * to handle concurrent operations in the client. When a remote
 * operation arrives, the client must transform it against any
 * pending local operations to maintain consistency.
 *
 * The transform function ensures that:
 *   apply(apply(doc, op1), op2') = apply(apply(doc, op2), op1')
 *
 * This property guarantees convergence across all clients.
 */
export class OTTransformer {
  /**
   * Transform op1 against op2.
   *
   * Given two operations that were created against the same document state,
   * produces transformed versions that can be applied in either order
   * while preserving the intended changes.
   *
   * @param op1 - The first operation
   * @param op2 - The second operation (must have same baseLength as op1)
   * @returns A tuple [op1', op2'] where op1' can be applied after op2,
   *          and op2' can be applied after op1
   * @throws Error if the operations have different base lengths
   */
  static transform(
    op1: TextOperation,
    op2: TextOperation
  ): [TextOperation, TextOperation] {
    if (op1.baseLength !== op2.baseLength) {
      throw new Error(
        `Transform base length mismatch: ${op1.baseLength} vs ${op2.baseLength}`
      );
    }

    const op1Prime = new TextOperation();
    const op2Prime = new TextOperation();

    const ops1 = [...op1.ops];
    const ops2 = [...op2.ops];

    let i1 = 0;
    let i2 = 0;
    let o1: Op | undefined = ops1[i1];
    let o2: Op | undefined = ops2[i2];

    while (o1 !== undefined || o2 !== undefined) {
      if (o1 && isInsert(o1)) {
        op1Prime.insert(o1.insert, o1.attributes);
        op2Prime.retain(o1.insert.length);
        i1++;
        o1 = ops1[i1];
        continue;
      }

      if (o2 && isInsert(o2)) {
        op1Prime.retain(o2.insert.length);
        op2Prime.insert(o2.insert, o2.attributes);
        i2++;
        o2 = ops2[i2];
        continue;
      }

      if (o1 === undefined) {
        throw new Error('Transform failed: op1 ran out of operations');
      }
      if (o2 === undefined) {
        throw new Error('Transform failed: op2 ran out of operations');
      }

      if (isRetain(o1) && isRetain(o2)) {
        const minLen = Math.min(o1.retain, o2.retain);
        op1Prime.retain(minLen);
        op2Prime.retain(minLen);

        if (o1.retain > o2.retain) {
          ops1[i1] = { retain: o1.retain - o2.retain };
          i2++;
          o2 = ops2[i2];
        } else if (o1.retain < o2.retain) {
          ops2[i2] = { retain: o2.retain - o1.retain };
          i1++;
          o1 = ops1[i1];
        } else {
          i1++;
          i2++;
          o1 = ops1[i1];
          o2 = ops2[i2];
        }
      } else if (isDelete(o1) && isDelete(o2)) {
        const minLen = Math.min(o1.delete, o2.delete);

        if (o1.delete > o2.delete) {
          ops1[i1] = { delete: o1.delete - o2.delete };
          i2++;
          o2 = ops2[i2];
        } else if (o1.delete < o2.delete) {
          ops2[i2] = { delete: o2.delete - o1.delete };
          i1++;
          o1 = ops1[i1];
        } else {
          i1++;
          i2++;
          o1 = ops1[i1];
          o2 = ops2[i2];
        }
      } else if (isDelete(o1) && isRetain(o2)) {
        const minLen = Math.min(o1.delete, o2.retain);
        op1Prime.delete(minLen);

        if (o1.delete > o2.retain) {
          ops1[i1] = { delete: o1.delete - o2.retain };
          i2++;
          o2 = ops2[i2];
        } else if (o1.delete < o2.retain) {
          ops2[i2] = { retain: o2.retain - o1.delete };
          i1++;
          o1 = ops1[i1];
        } else {
          i1++;
          i2++;
          o1 = ops1[i1];
          o2 = ops2[i2];
        }
      } else if (isRetain(o1) && isDelete(o2)) {
        const minLen = Math.min(o1.retain, o2.delete);
        op2Prime.delete(minLen);

        if (o1.retain > o2.delete) {
          ops1[i1] = { retain: o1.retain - o2.delete };
          i2++;
          o2 = ops2[i2];
        } else if (o1.retain < o2.delete) {
          ops2[i2] = { delete: o2.delete - o1.retain };
          i1++;
          o1 = ops1[i1];
        } else {
          i1++;
          i2++;
          o1 = ops1[i1];
          o2 = ops2[i2];
        }
      } else {
        throw new Error('Transform failed: unexpected operation combination');
      }
    }

    return [op1Prime, op2Prime];
  }

  /**
   * Compose two operations into a single operation.
   *
   * Creates a new operation that has the same effect as applying op1
   * followed by op2. Used to combine multiple pending local operations
   * into a single operation before sending to the server.
   *
   * @param op1 - The first operation to apply
   * @param op2 - The second operation to apply (op2.baseLength must equal op1.targetLength)
   * @returns A single operation equivalent to applying op1 then op2
   * @throws Error if op1.targetLength does not match op2.baseLength
   */
  static compose(op1: TextOperation, op2: TextOperation): TextOperation {
    if (op1.targetLength !== op2.baseLength) {
      throw new Error(
        `Compose length mismatch: op1.targetLength=${op1.targetLength}, op2.baseLength=${op2.baseLength}`
      );
    }

    const composed = new TextOperation();
    const ops1 = [...op1.ops];
    const ops2 = [...op2.ops];

    let i1 = 0;
    let i2 = 0;
    let o1: Op | undefined = ops1[i1];
    let o2: Op | undefined = ops2[i2];

    while (o1 !== undefined || o2 !== undefined) {
      if (o1 && isDelete(o1)) {
        composed.delete(o1.delete);
        i1++;
        o1 = ops1[i1];
        continue;
      }

      if (o2 && isInsert(o2)) {
        composed.insert(o2.insert, o2.attributes);
        i2++;
        o2 = ops2[i2];
        continue;
      }

      if (o1 === undefined) {
        throw new Error('Compose failed: op1 ran out of operations');
      }
      if (o2 === undefined) {
        throw new Error('Compose failed: op2 ran out of operations');
      }

      if (isInsert(o1) && isRetain(o2)) {
        const minLen = Math.min(o1.insert.length, o2.retain);
        composed.insert(o1.insert.slice(0, minLen), o1.attributes);

        if (o1.insert.length > o2.retain) {
          ops1[i1] = { insert: o1.insert.slice(o2.retain), attributes: o1.attributes };
          i2++;
          o2 = ops2[i2];
        } else if (o1.insert.length < o2.retain) {
          ops2[i2] = { retain: o2.retain - o1.insert.length };
          i1++;
          o1 = ops1[i1];
        } else {
          i1++;
          i2++;
          o1 = ops1[i1];
          o2 = ops2[i2];
        }
      } else if (isInsert(o1) && isDelete(o2)) {
        const minLen = Math.min(o1.insert.length, o2.delete);

        if (o1.insert.length > o2.delete) {
          ops1[i1] = { insert: o1.insert.slice(o2.delete), attributes: o1.attributes };
          i2++;
          o2 = ops2[i2];
        } else if (o1.insert.length < o2.delete) {
          ops2[i2] = { delete: o2.delete - o1.insert.length };
          i1++;
          o1 = ops1[i1];
        } else {
          i1++;
          i2++;
          o1 = ops1[i1];
          o2 = ops2[i2];
        }
      } else if (isRetain(o1) && isRetain(o2)) {
        const minLen = Math.min(o1.retain, o2.retain);
        composed.retain(minLen);

        if (o1.retain > o2.retain) {
          ops1[i1] = { retain: o1.retain - o2.retain };
          i2++;
          o2 = ops2[i2];
        } else if (o1.retain < o2.retain) {
          ops2[i2] = { retain: o2.retain - o1.retain };
          i1++;
          o1 = ops1[i1];
        } else {
          i1++;
          i2++;
          o1 = ops1[i1];
          o2 = ops2[i2];
        }
      } else if (isRetain(o1) && isDelete(o2)) {
        const minLen = Math.min(o1.retain, o2.delete);
        composed.delete(minLen);

        if (o1.retain > o2.delete) {
          ops1[i1] = { retain: o1.retain - o2.delete };
          i2++;
          o2 = ops2[i2];
        } else if (o1.retain < o2.delete) {
          ops2[i2] = { delete: o2.delete - o1.retain };
          i1++;
          o1 = ops1[i1];
        } else {
          i1++;
          i2++;
          o1 = ops1[i1];
          o2 = ops2[i2];
        }
      } else {
        throw new Error('Compose failed: unexpected operation combination');
      }
    }

    return composed;
  }

  /**
   * Transform a cursor position against an operation.
   *
   * Adjusts a cursor position to account for insertions and deletions
   * that occurred before or at the cursor location. Used to keep
   * cursor positions accurate when applying remote operations.
   *
   * @param cursor - The current cursor position (zero-based index)
   * @param op - The operation to transform against
   * @param isOwnCursor - If true, inserts at the cursor position go after
   *                      the cursor (used for the local user's cursor)
   * @returns The new cursor position after the operation
   */
  static transformCursor(
    cursor: number,
    op: TextOperation,
    isOwnCursor: boolean = false
  ): number {
    let newCursor = cursor;
    let index = 0;

    for (const o of op.ops) {
      if (isInsert(o)) {
        if (index < cursor || (index === cursor && !isOwnCursor)) {
          newCursor += o.insert.length;
        }
      } else if (isRetain(o)) {
        index += o.retain;
      } else if (isDelete(o)) {
        if (index < cursor) {
          const deleteEnd = index + o.delete;
          if (deleteEnd <= cursor) {
            newCursor -= o.delete;
          } else {
            newCursor = index;
          }
        }
        index += o.delete;
      }
    }

    return Math.max(0, newCursor);
  }
}
