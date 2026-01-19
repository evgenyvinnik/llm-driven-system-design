/**
 * Priority Queue implementation using a binary min-heap
 * Used for A* pathfinding algorithm
 */

interface HeapItem {
  node: string;
  priority: number;
}

export class PriorityQueue {
  private heap: HeapItem[];
  private nodeIndices: Map<string, number>;

  constructor() {
    this.heap = [];
    this.nodeIndices = new Map();
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  size(): number {
    return this.heap.length;
  }

  enqueue(node: string, priority: number): void {
    const existingIndex = this.nodeIndices.get(node);

    if (existingIndex !== undefined) {
      const heapItem = this.heap[existingIndex];
      if (heapItem && priority < heapItem.priority) {
        heapItem.priority = priority;
        this._bubbleUp(existingIndex);
      }
      return;
    }

    const item: HeapItem = { node, priority };
    this.heap.push(item);
    const index = this.heap.length - 1;
    this.nodeIndices.set(node, index);
    this._bubbleUp(index);
  }

  dequeue(): string | null {
    if (this.isEmpty()) return null;

    const min = this.heap[0];
    const last = this.heap.pop();
    if (min) {
      this.nodeIndices.delete(min.node);
    }

    if (this.heap.length > 0 && last) {
      this.heap[0] = last;
      this.nodeIndices.set(last.node, 0);
      this._bubbleDown(0);
    }

    return min?.node ?? null;
  }

  private _bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const current = this.heap[index];
      const parent = this.heap[parentIndex];
      if (!current || !parent || current.priority >= parent.priority) break;

      this._swap(index, parentIndex);
      index = parentIndex;
    }
  }

  private _bubbleDown(index: number): void {
    const length = this.heap.length;

    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      const currentSmallest = this.heap[smallest];
      const left = this.heap[leftChild];
      const right = this.heap[rightChild];

      if (leftChild < length && left && currentSmallest && left.priority < currentSmallest.priority) {
        smallest = leftChild;
      }

      const newSmallest = this.heap[smallest];
      if (rightChild < length && right && newSmallest && right.priority < newSmallest.priority) {
        smallest = rightChild;
      }

      if (smallest === index) break;

      this._swap(index, smallest);
      index = smallest;
    }
  }

  private _swap(i: number, j: number): void {
    const itemI = this.heap[i];
    const itemJ = this.heap[j];
    if (!itemI || !itemJ) return;

    [this.heap[i], this.heap[j]] = [itemJ, itemI];
    this.nodeIndices.set(itemI.node, j);
    this.nodeIndices.set(itemJ.node, i);
  }
}

function toRad(deg: number): number {
  return deg * Math.PI / 180;
}

/**
 * Calculate haversine distance between two points in meters
 */
export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate bearing between two points in degrees
 */
export function calculateBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);

  const bearing = Math.atan2(y, x) * 180 / Math.PI;
  return (bearing + 360) % 360;
}

/**
 * Calculate turn angle between two segments
 */
export function calculateTurnAngle(bearing1: number, bearing2: number): number {
  let angle = bearing2 - bearing1;

  // Normalize to -180 to 180
  while (angle > 180) angle -= 360;
  while (angle < -180) angle += 360;

  return angle;
}

/**
 * Format distance for display
 */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Format duration for display
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)} sec`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} min`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return `${hours} hr ${mins} min`;
}
