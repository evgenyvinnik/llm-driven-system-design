/**
 * Hybrid Logical Clock for CRDT operations
 * Provides causally-ordered timestamps even with clock drift
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
 * Initialize HLC with a node ID
 */
export function initHLC(nodeId: string): void {
  lastHLC = {
    timestamp: Date.now(),
    counter: 0,
    nodeId,
  };
}

/**
 * Generate a new HLC timestamp
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
 * Update local HLC based on received remote HLC
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
 * Compare two HLC timestamps
 * @returns negative if a < b, 0 if equal, positive if a > b
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
 * Convert HLC to a single comparable number (for database storage)
 */
export function hlcToNumber(hlc: HLC): number {
  // Combine timestamp and counter into a single number
  // This works as long as counter doesn't exceed 999999
  return hlc.timestamp * 1000000 + Math.min(hlc.counter, 999999);
}

/**
 * Convert number back to HLC (approximate, loses nodeId)
 */
export function numberToHLC(num: number, nodeId: string = ''): HLC {
  return {
    timestamp: Math.floor(num / 1000000),
    counter: num % 1000000,
    nodeId,
  };
}
