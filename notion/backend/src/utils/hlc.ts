/**
 * @fileoverview Hybrid Logical Clock (HLC) for CRDT operations.
 *
 * HLCs combine physical timestamps with logical counters to provide
 * causally-ordered timestamps even in the presence of clock drift.
 * This is essential for ordering operations in a distributed system
 * where multiple clients may be editing simultaneously.
 *
 * Reference: https://cse.buffalo.edu/tech-reports/2014-04.pdf
 */

/**
 * Represents a Hybrid Logical Clock timestamp.
 * The combination of timestamp, counter, and nodeId ensures global uniqueness.
 */
export interface HLC {
  timestamp: number;
  counter: number;
  nodeId: string;
}

let lastHLC: HLC = {
  timestamp: 0,
  counter: 0,
  nodeId: '',
};

/**
 * Initializes the HLC with a unique node identifier.
 * Must be called once at startup before generating timestamps.
 *
 * @param nodeId - Unique identifier for this server/client instance
 */
export function initHLC(nodeId: string): void {
  lastHLC = {
    timestamp: Date.now(),
    counter: 0,
    nodeId,
  };
}

/**
 * Generates a new HLC timestamp for a local event.
 * The timestamp is guaranteed to be greater than all previous timestamps
 * from this node.
 *
 * @returns A new HLC timestamp
 */
export function generateHLC(): HLC {
  const now = Date.now();

  if (now > lastHLC.timestamp) {
    lastHLC = {
      timestamp: now,
      counter: 0,
      nodeId: lastHLC.nodeId,
    };
  } else {
    lastHLC = {
      timestamp: lastHLC.timestamp,
      counter: lastHLC.counter + 1,
      nodeId: lastHLC.nodeId,
    };
  }

  return { ...lastHLC };
}

/**
 * Updates local HLC based on a received remote timestamp.
 * Ensures the local clock stays synchronized with the cluster.
 *
 * @param remote - The HLC timestamp received from another node
 * @returns The updated local HLC timestamp
 */
export function receiveHLC(remote: HLC): HLC {
  const now = Date.now();
  const maxTs = Math.max(now, lastHLC.timestamp, remote.timestamp);

  if (maxTs === lastHLC.timestamp && maxTs === remote.timestamp) {
    lastHLC = {
      timestamp: maxTs,
      counter: Math.max(lastHLC.counter, remote.counter) + 1,
      nodeId: lastHLC.nodeId,
    };
  } else if (maxTs === lastHLC.timestamp) {
    lastHLC = {
      timestamp: maxTs,
      counter: lastHLC.counter + 1,
      nodeId: lastHLC.nodeId,
    };
  } else if (maxTs === remote.timestamp) {
    lastHLC = {
      timestamp: maxTs,
      counter: remote.counter + 1,
      nodeId: lastHLC.nodeId,
    };
  } else {
    lastHLC = {
      timestamp: maxTs,
      counter: 0,
      nodeId: lastHLC.nodeId,
    };
  }

  return { ...lastHLC };
}

/**
 * Compares two HLC timestamps for ordering.
 *
 * @param a - First HLC timestamp
 * @param b - Second HLC timestamp
 * @returns Negative if a < b, 0 if equal, positive if a > b
 */
export function compareHLC(a: HLC, b: HLC): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  if (a.counter !== b.counter) {
    return a.counter - b.counter;
  }
  return a.nodeId.localeCompare(b.nodeId);
}

/** Bits reserved for the logical counter when an HLC is packed into a BIGINT. */
const COUNTER_BITS = 16n;
const COUNTER_MASK = (1n << COUNTER_BITS) - 1n;

/**
 * Packs an HLC into a sortable BIGINT: physical milliseconds in the high bits,
 * the logical counter in the low 16 bits. Returned as a decimal string because
 * milliseconds * 2^16 is far beyond Number.MAX_SAFE_INTEGER; the previous
 * `timestamp * 1e6 + counter` encoding silently rounded the counter away.
 *
 * @param hlc - The HLC timestamp to encode
 * @returns Decimal string suitable for a BIGINT column
 */
export function encodeHLC(hlc: HLC): string {
  const counter = BigInt(Math.min(Math.max(hlc.counter, 0), Number(COUNTER_MASK)));
  return ((BigInt(hlc.timestamp) << COUNTER_BITS) | counter).toString();
}

/**
 * Reverses encodeHLC. The nodeId is not stored in the packed form.
 *
 * @param value - Packed HLC as returned by encodeHLC (or read from PostgreSQL)
 * @param nodeId - Optional nodeId to assign
 * @returns The decoded HLC
 */
export function decodeHLC(value: string | number | bigint, nodeId: string = ''): HLC {
  const packed = BigInt(value);
  return {
    timestamp: Number(packed >> COUNTER_BITS),
    counter: Number(packed & COUNTER_MASK),
    nodeId,
  };
}
