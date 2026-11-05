/**
 * Stable partitioning by locomotive id (FNV-1a), the same idea as Kafka's
 * key-hash partitioner: every reading from one locomotive lands in one
 * partition, so one consumer sees that locomotive's readings in order.
 * @module shared/partition
 */
export function partitionFor(key: string, partitions: number): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % partitions
}
