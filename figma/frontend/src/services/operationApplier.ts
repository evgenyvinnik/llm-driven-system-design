import type { CanvasData, DesignObject, Operation } from '../types';

/**
 * Set a nested property on an object using a dot-notation path
 * e.g., setNestedProperty(obj, 'style.fill', '#ff0000')
 */
function setNestedProperty(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[keys[keys.length - 1]] = value;
}

/**
 * Apply an operation to canvas data and return new immutable state
 * This mirrors the backend's operationService.applyOperation logic
 */
export function applyOperation(canvasData: CanvasData, operation: Operation): CanvasData {
  const newData: CanvasData = {
    ...canvasData,
    objects: [...canvasData.objects],
    pages: [...canvasData.pages],
  };

  switch (operation.operationType) {
    case 'create': {
      const newObject = operation.newValue as DesignObject;
      if (newObject) {
        // Check if object already exists (duplicate operation)
        const existingIndex = newData.objects.findIndex((o) => o.id === newObject.id);
        if (existingIndex === -1) {
          newData.objects.push(newObject);
        }
      }
      break;
    }

    case 'update': {
      const index = newData.objects.findIndex((o) => o.id === operation.objectId);
      if (index !== -1) {
        const updatedObject = { ...newData.objects[index] };

        if (operation.propertyPath) {
          // Update specific property using dot notation path
          setNestedProperty(
            updatedObject as unknown as Record<string, unknown>,
            operation.propertyPath,
            operation.newValue
          );
        } else if (operation.newValue && typeof operation.newValue === 'object') {
          // Merge new value into object
          Object.assign(updatedObject, operation.newValue);
        }

        newData.objects[index] = updatedObject;
      }
      break;
    }

    case 'delete': {
      const index = newData.objects.findIndex((o) => o.id === operation.objectId);
      if (index !== -1) {
        newData.objects.splice(index, 1);
      }
      break;
    }

    case 'move': {
      // Move changes z-order (layer position)
      const fromIndex = newData.objects.findIndex((o) => o.id === operation.objectId);
      if (fromIndex !== -1 && typeof operation.newValue === 'number') {
        const toIndex = operation.newValue as number;
        const [obj] = newData.objects.splice(fromIndex, 1);
        newData.objects.splice(toIndex, 0, obj);
      }
      break;
    }
  }

  return newData;
}

/**
 * Apply multiple operations in sequence
 */
export function applyOperations(canvasData: CanvasData, operations: Operation[]): CanvasData {
  return operations.reduce((data, op) => applyOperation(data, op), canvasData);
}

/**
 * Create an operation for object creation
 */
export function createAddOperation(
  fileId: string,
  userId: string,
  clientId: string,
  object: DesignObject
): Operation {
  return {
    id: crypto.randomUUID(),
    fileId,
    userId,
    operationType: 'create',
    objectId: object.id,
    newValue: object,
    timestamp: Date.now(),
    clientId,
  };
}

/**
 * Create an operation for object update
 */
export function createUpdateOperation(
  fileId: string,
  userId: string,
  clientId: string,
  objectId: string,
  updates: Partial<DesignObject>,
  propertyPath?: string
): Operation {
  return {
    id: crypto.randomUUID(),
    fileId,
    userId,
    operationType: 'update',
    objectId,
    propertyPath,
    newValue: propertyPath ? updates[propertyPath as keyof DesignObject] : updates,
    timestamp: Date.now(),
    clientId,
  };
}

/**
 * Create an operation for object deletion
 */
export function createDeleteOperation(
  fileId: string,
  userId: string,
  clientId: string,
  objectId: string
): Operation {
  return {
    id: crypto.randomUUID(),
    fileId,
    userId,
    operationType: 'delete',
    objectId,
    timestamp: Date.now(),
    clientId,
  };
}

/**
 * Create an operation for z-order change
 */
export function createMoveOperation(
  fileId: string,
  userId: string,
  clientId: string,
  objectId: string,
  newIndex: number
): Operation {
  return {
    id: crypto.randomUUID(),
    fileId,
    userId,
    operationType: 'move',
    objectId,
    newValue: newIndex,
    timestamp: Date.now(),
    clientId,
  };
}
