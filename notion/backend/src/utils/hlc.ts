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

/**
 * Converts an HLC to a single sortable number for database storage.
 * Combines timestamp and counter; works as long as counter < 999999.
 *
 * @param hlc - The HLC timestamp to convert
 * @returns A sortable numeric representation
 */
export function hlcToNumber(hlc: HLC): number {
  // Combine timestamp and counter into a single number
  // This works as long as counter doesn't exceed 999999
  return hlc.timestamp * 1000000 + Math.min(hlc.counter, 999999);
}

/**
 * Reconstructs an HLC from a numeric representation.
 * Note: The nodeId is lost during numeric conversion.
 *
 * @param num - The numeric HLC representation
 * @param nodeId - Optional nodeId to assign (defaults to empty string)
 * @returns An HLC timestamp (approximate, without original nodeId)
 */
export function numberToHLC(num: number, nodeId: string = ''): HLC {
  return {
    timestamp: Math.floor(num / 1000000),
    counter: num % 1000000,
    nodeId,
  };
}
