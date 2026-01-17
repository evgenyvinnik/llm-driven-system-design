/**
 * Min-Heap implementation for Top K algorithm
 * Used to efficiently maintain the top K elements from a stream
 */
export class MinHeap {
  constructor(compareFn = (a, b) => a.score - b.score) {
    this.heap = [];
    this.compare = compareFn;
  }

  get size() {
    return this.heap.length;
  }

  peek() {
    return this.heap[0];
  }

  push(item) {
    this.heap.push(item);
    this._bubbleUp(this.heap.length - 1);
  }

  pop() {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();

    const min = this.heap[0];
    this.heap[0] = this.heap.pop();
    this._bubbleDown(0);
    return min;
  }

  _bubbleUp(index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (this.compare(this.heap[index], this.heap[parentIndex]) >= 0) break;
      [this.heap[index], this.heap[parentIndex]] = [this.heap[parentIndex], this.heap[index]];
      index = parentIndex;
    }
  }

  _bubbleDown(index) {
    const length = this.heap.length;
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let smallest = index;

      if (leftChild < length && this.compare(this.heap[leftChild], this.heap[smallest]) < 0) {
        smallest = leftChild;
      }
      if (rightChild < length && this.compare(this.heap[rightChild], this.heap[smallest]) < 0) {
        smallest = rightChild;
      }

      if (smallest === index) break;

      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
  }

  toArray() {
    return [...this.heap];
  }

  toSortedArray() {
    return [...this.heap].sort((a, b) => this.compare(b, a)); // Descending order
  }
}

/**
 * TopK maintains the top K elements efficiently using a min-heap
 *
 * Algorithm:
 * - Keep a min-heap of size K
 * - When a new element comes in:
 *   - If heap size < K: add element
 *   - Else if element > heap.min: remove min, add element
 *
 * Time complexity: O(log K) per update
 * Space complexity: O(K)
 */
export class TopK {
  constructor(k = 10) {
    this.k = k;
    this.heap = new MinHeap((a, b) => a.score - b.score);
    this.itemMap = new Map(); // Track items in heap for updates
  }

  /**
   * Update or insert an item with a new score
   */
  update(id, score) {
    // If item is already in heap, we need to handle update
    if (this.itemMap.has(id)) {
      // For simplicity, rebuild when updating
      // In production, use a more efficient data structure like indexed heap
      const items = this.heap.toArray().filter(item => item.id !== id);
      items.push({ id, score });

      this.heap = new MinHeap((a, b) => a.score - b.score);
      this.itemMap.clear();

      // Re-add all items
      for (const item of items) {
        this._addItem(item);
      }
      return;
    }

    // New item
    this._addItem({ id, score });
  }

  _addItem(item) {
    if (this.heap.size < this.k) {
      this.heap.push(item);
      this.itemMap.set(item.id, item);
    } else if (item.score > this.heap.peek().score) {
      const removed = this.heap.pop();
      this.itemMap.delete(removed.id);
      this.heap.push(item);
      this.itemMap.set(item.id, item);
    }
  }

  /**
   * Get the current top K items sorted by score descending
   */
  getTopK() {
    return this.heap.toSortedArray();
  }

  /**
   * Build top K from a map of id -> score
   */
  static fromMap(scoreMap, k = 10) {
    const topK = new TopK(k);
    for (const [id, score] of scoreMap.entries()) {
      topK.update(id, score);
    }
    return topK;
  }
}

/**
 * Count-Min Sketch for approximate frequency counting
 * Useful for high cardinality streams where exact counting is too expensive
 *
 * Properties:
 * - Never underestimates count
 * - May overestimate by bounded amount
 * - Space: O(width * depth)
 * - Error: O(total / width) with probability 1 - (1/2)^depth
 */
export class CountMinSketch {
  constructor(width = 10000, depth = 5) {
    this.width = width;
    this.depth = depth;
    this.tables = Array.from({ length: depth }, () => new Array(width).fill(0));
    this.seeds = Array.from({ length: depth }, (_, i) => i * 31337);
  }

  /**
   * Simple hash function for demonstration
   * In production, use MurmurHash or similar
   */
  _hash(item, seed) {
    const str = String(item);
    let hash = seed;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % this.width;
  }

  /**
   * Increment count for an item
   */
  increment(item, count = 1) {
    for (let i = 0; i < this.depth; i++) {
      const index = this._hash(item, this.seeds[i]);
      this.tables[i][index] += count;
    }
  }

  /**
   * Get estimated count for an item (minimum across all tables)
   */
  estimate(item) {
    let min = Infinity;
    for (let i = 0; i < this.depth; i++) {
      const index = this._hash(item, this.seeds[i]);
      min = Math.min(min, this.tables[i][index]);
    }
    return min;
  }
}

/**
 * Space-Saving Algorithm for finding frequent items (Heavy Hitters)
 * Maintains exact top K with bounded error
 *
 * Guarantees: Reports all items with frequency > (n/k)
 * where n is total count and k is number of counters
 */
export class SpaceSaving {
  constructor(k = 100) {
    this.k = k;
    this.counters = new Map(); // id -> { count, error }
    this.minBucket = new Map(); // count -> Set of ids with that count
    this.minCount = 0;
  }

  /**
   * Increment count for an item
   */
  increment(id) {
    if (this.counters.has(id)) {
      // Item already tracked - increment its count
      const entry = this.counters.get(id);
      this._removeFromBucket(id, entry.count);
      entry.count++;
      this._addToBucket(id, entry.count);
      this._updateMinCount();
    } else if (this.counters.size < this.k) {
      // Space available - add new counter
      this.counters.set(id, { count: 1, error: 0 });
      this._addToBucket(id, 1);
      this._updateMinCount();
    } else {
      // Replace minimum counter
      const minId = this._getMinId();
      const minEntry = this.counters.get(minId);

      // Remove old entry
      this._removeFromBucket(minId, minEntry.count);
      this.counters.delete(minId);

      // Add new entry with count = minCount + 1
      const newCount = this.minCount + 1;
      this.counters.set(id, { count: newCount, error: this.minCount });
      this._addToBucket(id, newCount);
      this._updateMinCount();
    }
  }

  _addToBucket(id, count) {
    if (!this.minBucket.has(count)) {
      this.minBucket.set(count, new Set());
    }
    this.minBucket.get(count).add(id);
  }

  _removeFromBucket(id, count) {
    const bucket = this.minBucket.get(count);
    if (bucket) {
      bucket.delete(id);
      if (bucket.size === 0) {
        this.minBucket.delete(count);
      }
    }
  }

  _getMinId() {
    const minBucket = this.minBucket.get(this.minCount);
    if (minBucket && minBucket.size > 0) {
      return minBucket.values().next().value;
    }
    return null;
  }

  _updateMinCount() {
    if (this.counters.size === 0) {
      this.minCount = 0;
      return;
    }

    // Find the minimum count with a non-empty bucket
    const counts = Array.from(this.minBucket.keys()).sort((a, b) => a - b);
    for (const count of counts) {
      if (this.minBucket.get(count)?.size > 0) {
        this.minCount = count;
        return;
      }
    }
  }

  /**
   * Get top K items sorted by count
   */
  getTopK(k) {
    const entries = Array.from(this.counters.entries())
      .map(([id, { count, error }]) => ({ id, count, error }))
      .sort((a, b) => b.count - a.count);

    return entries.slice(0, k);
  }

  /**
   * Get estimated count for an item
   */
  getCount(id) {
    const entry = this.counters.get(id);
    return entry ? entry.count : 0;
  }
}
