import { query, execute } from '../db/postgres.js';
import { v4 as uuidv4 } from 'uuid';
import type { Operation, CanvasData, DesignObject } from '../types/index.js';
import { fileService } from './fileService.js';

interface OperationRow {
  id: string;
  file_id: string;
  user_id: string | null;
  operation_type: string;
  object_id: string;
  property_path: string | null;
  old_value: unknown;
  new_value: unknown;
  timestamp: string;
  client_id: string;
  created_at: Date;
}

// Simple Lamport clock for ordering
let lamportClock = Date.now();

export class OperationService {
  // Generate next timestamp
  getNextTimestamp(): number {
    lamportClock = Math.max(lamportClock + 1, Date.now());
    return lamportClock;
  }

  // Update clock based on received timestamp
  updateClock(receivedTimestamp: number): void {
    lamportClock = Math.max(lamportClock, receivedTimestamp) + 1;
  }

  // Apply operation to canvas data
  applyOperation(canvasData: CanvasData, operation: Operation): CanvasData {
    const newData = { ...canvasData, objects: [...canvasData.objects] };

    switch (operation.operationType) {
      case 'create': {
        const newObject = operation.newValue as DesignObject;
        newData.objects.push(newObject);
        break;
      }
      case 'update': {
        const index = newData.objects.findIndex(o => o.id === operation.objectId);
        if (index !== -1) {
          if (operation.propertyPath) {
            // Update specific property
            const obj = { ...newData.objects[index] };
            this.setNestedProperty(obj, operation.propertyPath, operation.newValue);
            newData.objects[index] = obj;
          } else {
            // Replace entire object
            newData.objects[index] = {
              ...newData.objects[index],
              ...(operation.newValue as Partial<DesignObject>),
            };
          }
        }
        break;
      }
      case 'delete': {
        const index = newData.objects.findIndex(o => o.id === operation.objectId);
        if (index !== -1) {
          newData.objects.splice(index, 1);
        }
        break;
      }
      case 'move': {
        const fromIndex = newData.objects.findIndex(o => o.id === operation.objectId);
        if (fromIndex !== -1 && typeof operation.newValue === 'number') {
          const [obj] = newData.objects.splice(fromIndex, 1);
          newData.objects.splice(operation.newValue as number, 0, obj);
        }
        break;
      }
    }

    return newData;
  }

  // Set nested property using dot notation
  private setNestedProperty(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    current[parts[parts.length - 1]] = value;
  }

  // Store operation in database
  async storeOperation(operation: Operation): Promise<void> {
    await execute(
      `INSERT INTO operations (id, file_id, user_id, operation_type, object_id, property_path, old_value, new_value, timestamp, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        operation.id,
        operation.fileId,
        operation.userId,
        operation.operationType,
        operation.objectId,
        operation.propertyPath || null,
        operation.oldValue ? JSON.stringify(operation.oldValue) : null,
        operation.newValue ? JSON.stringify(operation.newValue) : null,
        operation.timestamp,
        operation.clientId,
      ]
    );
  }

  // Get operations since a timestamp
  async getOperationsSince(fileId: string, sinceTimestamp: number): Promise<Operation[]> {
    const rows = await query<OperationRow>(
      `SELECT * FROM operations WHERE file_id = $1 AND timestamp > $2 ORDER BY timestamp ASC`,
      [fileId, sinceTimestamp]
    );
    return rows.map(this.mapOperationRow);
  }

  // Process and apply operation
  async processOperation(operation: Operation): Promise<CanvasData> {
    this.updateClock(operation.timestamp);

    // Get current file
    const file = await fileService.getFile(operation.fileId);
    if (!file) throw new Error('File not found');

    // Apply operation
    const newCanvasData = this.applyOperation(file.canvas_data, operation);

    // Store operation
    await this.storeOperation(operation);

    // Update file
    await fileService.updateCanvasData(operation.fileId, newCanvasData);

    return newCanvasData;
  }

  // Create an operation
  createOperation(
    fileId: string,
    userId: string,
    operationType: 'create' | 'update' | 'delete' | 'move',
    objectId: string,
    newValue?: unknown,
    oldValue?: unknown,
    propertyPath?: string
  ): Operation {
    return {
      id: uuidv4(),
      fileId,
      userId,
      operationType,
      objectId,
      propertyPath,
      oldValue,
      newValue,
      timestamp: this.getNextTimestamp(),
      clientId: `server-${process.env.PORT || 3000}`,
    };
  }

  private mapOperationRow(row: OperationRow): Operation {
    return {
      id: row.id,
      fileId: row.file_id,
      userId: row.user_id || '',
      operationType: row.operation_type as Operation['operationType'],
      objectId: row.object_id,
      propertyPath: row.property_path || undefined,
      oldValue: row.old_value,
      newValue: row.new_value,
      timestamp: parseInt(row.timestamp),
      clientId: row.client_id,
    };
  }
}

export const operationService = new OperationService();
