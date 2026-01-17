/**
 * Priority Queue implementation using a binary min-heap
 * Used for A* pathfinding algorithm
 */
export class PriorityQueue {
  constructor() {
    this.heap = [];
    this.nodeIndices = new Map(); // Track node positions for efficient updates
  }

  isEmpty() {
    return this.heap.length === 0;
  }

  size() {
    return this.heap.length;
  }

  enqueue(node, priority) {
    const existingIndex = this.nodeIndices.get(node);

    if (existingIndex !== undefined) {
      // Update existing node priority if lower
      if (priority < this.heap[existingIndex].priority) {
        this.heap[existingIndex].priority = priority;
        this._bubbleUp(existingIndex);
      }
      return;
    }

    const item = { node, priority };
    this.heap.push(item);
    const index = this.heap.length - 1;
    this.nodeIndices.set(node, index);
    this._bubbleUp(index);
  }

  dequeue() {
    if (this.isEmpty()) return null;

    const min = this.heap[0];
    const last = this.heap.pop();
    this.nodeIndices.delete(min.node);

    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.nodeIndices.set(last.node, 0);
      this._bubbleDown(0);
    }

    return min.node;
  }

  _bubbleUp(index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.heap[index].priority >= this.heap[parentIndex].priority) break;

      this._swap(index, parentIndex);
      index = parentIndex;
    }
  }

  _bubbleDown(index) {
    const length = this.heap.length;

    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < length && this.heap[leftChild].priority < this.heap[smallest].priority) {
        smallest = leftChild;
      }

      if (rightChild < length && this.heap[rightChild].priority < this.heap[smallest].priority) {
        smallest = rightChild;
      }

      if (smallest === index) break;

      this._swap(index, smallest);
      index = smallest;
    }
  }

  _swap(i, j) {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
    this.nodeIndices.set(this.heap[i].node, i);
    this.nodeIndices.set(this.heap[j].node, j);
  }
}

/**
 * Calculate haversine distance between two points in meters
 */
export function haversineDistance(lat1, lng1, lat2, lng2) {
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

function toRad(deg) {
  return deg * Math.PI / 180;
}

/**
 * Calculate bearing between two points in degrees
 */
export function calculateBearing(lat1, lng1, lat2, lng2) {
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);

  let bearing = Math.atan2(y, x) * 180 / Math.PI;
  return (bearing + 360) % 360;
}

/**
 * Calculate turn angle between two segments
 */
export function calculateTurnAngle(bearing1, bearing2) {
  let angle = bearing2 - bearing1;

  // Normalize to -180 to 180
  while (angle > 180) angle -= 360;
  while (angle < -180) angle += 360;

  return angle;
}

/**
 * Format distance for display
 */
export function formatDistance(meters) {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Format duration for display
 */
export function formatDuration(seconds) {
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
