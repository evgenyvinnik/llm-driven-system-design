/**
 * Shape-level CRDT Service
 *
 * Implements Last-Writer-Wins (LWW) merge at the element level.
 * Each element carries an `id`, `version`, and `updatedAt` timestamp.
 * When merging concurrent edits, the element with the highest version
 * (or latest updatedAt for tie-breaking) wins.
 *
 * This is simpler than full OT or CRDT libraries but sufficient for
 * shape-level collaborative editing where users typically work on
 * different elements.
 */

export interface CrdtElement {
  id: string;
  type: string;
  version: number;
  updatedAt: number;
  isDeleted: boolean;
  [key: string]: unknown;
}

/**
 * True if `incoming` should replace `current`: higher version wins, and a
 * later updatedAt breaks a version tie. Version-first means a client with a
 * skewed clock can only win among edits made from the same base version.
 */
const wins = (incoming: CrdtElement, current: CrdtElement): boolean =>
  incoming.version > current.version ||
  (incoming.version === current.version && incoming.updatedAt > current.updatedAt);

/**
 * Merge two sets of elements using LWW strategy.
 * For each element_id, keep the version with the highest version number.
 * If versions are equal, use updatedAt timestamp as tie-breaker.
 */
/** Merges remote CRDT elements with local state using last-write-wins conflict resolution. */
export const mergeElements = (
  existing: CrdtElement[],
  incoming: CrdtElement[]
): CrdtElement[] => {
  const elementMap = new Map<string, CrdtElement>();

  // Add all existing elements to the map
  for (const element of existing) {
    elementMap.set(element.id, element);
  }

  // Merge incoming elements
  for (const element of incoming) {
    const current = elementMap.get(element.id);

    if (!current || wins(element, current)) {
      elementMap.set(element.id, element);
    }
    // Otherwise, keep existing (it has higher version or newer timestamp)
  }

  // Return all non-deleted elements, preserving deleted ones for sync
  return Array.from(elementMap.values());
};

/**
 * Apply a single operation (add, update, delete, move) to the element list.
 * Returns the updated element list.
 */
/** Applies a single CRDT operation (add, update, delete) to the element set. */
export const applyOperation = (
  elements: CrdtElement[],
  operation: {
    type: 'add' | 'update' | 'delete' | 'move';
    elementId: string;
    elementData?: CrdtElement;
  }
): CrdtElement[] => {
  const elementMap = new Map<string, CrdtElement>();
  for (const el of elements) {
    elementMap.set(el.id, el);
  }

  switch (operation.type) {
    // Add and update follow the same rule as a merge. An unconditional add
    // let a replayed add resurrect a tombstoned element, and `>=` on update
    // let an equal-version edit win regardless of time.
    case 'add':
    case 'update':
      if (operation.elementData) {
        const existing = elementMap.get(operation.elementId);
        if (!existing || wins(operation.elementData, existing)) {
          elementMap.set(operation.elementId, operation.elementData);
        }
      }
      break;

    case 'delete': {
      const toDelete = elementMap.get(operation.elementId);
      if (toDelete) {
        elementMap.set(operation.elementId, {
          ...toDelete,
          isDeleted: true,
          version: toDelete.version + 1,
          updatedAt: Date.now(),
        });
      }
      break;
    }

    case 'move':
      if (operation.elementData) {
        const toMove = elementMap.get(operation.elementId);
        if (toMove) {
          elementMap.set(operation.elementId, {
            ...toMove,
            x: operation.elementData.x,
            y: operation.elementData.y,
            version: Math.max(toMove.version, operation.elementData.version),
            updatedAt: Date.now(),
          });
        }
      }
      break;
  }

  return Array.from(elementMap.values());
};

/**
 * Filter out soft-deleted elements for rendering.
 * The full list (including deleted) is kept for CRDT merge purposes.
 */
/** Filters out deleted elements and returns only visible ones. */
export const getVisibleElements = (elements: CrdtElement[]): CrdtElement[] => {
  return elements.filter((el) => !el.isDeleted);
};

export default {
  mergeElements,
  applyOperation,
  getVisibleElements,
};
