import { v4 as uuidv4 } from 'uuid';
import { HealthDataTypes, normalizeUnit } from './healthTypes.js';

export class HealthSample {
  constructor(data) {
    this.id = data.id || uuidv4();
    this.userId = data.userId;
    this.type = data.type;
    this.value = data.value;
    this.unit = data.unit;
    this.startDate = new Date(data.startDate);
    this.endDate = new Date(data.endDate || data.startDate);
    this.sourceDevice = data.sourceDevice;
    this.sourceDeviceId = data.sourceDeviceId;
    this.sourceApp = data.sourceApp;
    this.metadata = data.metadata || {};
    this.createdAt = new Date();
  }

  validate() {
    // Check required fields
    if (!this.userId) {
      throw new Error('userId is required');
    }
    if (!this.type) {
      throw new Error('type is required');
    }
    if (this.value === undefined || this.value === null) {
      throw new Error('value is required');
    }
    if (!this.startDate || isNaN(this.startDate.getTime())) {
      throw new Error('valid startDate is required');
    }

    // Validate health type
    const typeConfig = HealthDataTypes[this.type];
    if (!typeConfig) {
      throw new Error(`Unknown health type: ${this.type}`);
    }

    // Normalize unit if needed
    if (this.unit && typeConfig.unit && this.unit !== typeConfig.unit) {
      this.value = normalizeUnit(this.value, this.unit, typeConfig.unit);
      this.unit = typeConfig.unit;
    } else if (!this.unit && typeConfig.unit) {
      this.unit = typeConfig.unit;
    }

    // Validate value range
    if (typeof this.value !== 'number' || isNaN(this.value)) {
      throw new Error('value must be a valid number');
    }

    return true;
  }

  toRow() {
    return {
      id: this.id,
      user_id: this.userId,
      type: this.type,
      value: this.value,
      unit: this.unit,
      start_date: this.startDate,
      end_date: this.endDate,
      source_device: this.sourceDevice,
      source_device_id: this.sourceDeviceId,
      source_app: this.sourceApp,
      metadata: JSON.stringify(this.metadata)
    };
  }

  static fromRow(row) {
    return new HealthSample({
      id: row.id,
      userId: row.user_id,
      type: row.type,
      value: row.value,
      unit: row.unit,
      startDate: row.start_date,
      endDate: row.end_date,
      sourceDevice: row.source_device,
      sourceDeviceId: row.source_device_id,
      sourceApp: row.source_app,
      metadata: row.metadata
    });
  }
}
