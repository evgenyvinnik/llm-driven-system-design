import { TextOperation, isRetain, isInsert, isDelete } from './TextOperation';
import type { Op } from '../types';

/**
 * OT Transformer for client-side operation transformation
 */
export class OTTransformer {
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
