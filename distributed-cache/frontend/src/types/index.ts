export interface NodeStatus {
  url: string;
  healthy: boolean;
  nodeId?: string;
  uptime?: number;
  error?: string;
  lastCheck: string;
  consecutiveFailures: number;
}

export interface NodeStats {
  nodeId: string;
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  expirations: number;
  size: number;
  memoryMB: string;
  hitRate: string;
  maxSize: number;
  maxMemoryMB: number;
  currentSize: number;
  currentMemoryBytes: number;
}

export interface ClusterInfo {
  coordinator: {
    port: number;
    uptime: number;
  };
  ring: {
    virtualNodes: number;
    activeNodes: string[];
  };
  nodes: NodeStatus[];
  timestamp: string;
}

export interface ClusterStats {
  totalNodes: number;
  totalHits: number;
  totalMisses: number;
  totalSets: number;
  totalDeletes: number;
  totalEvictions: number;
  totalSize: number;
  totalMemoryMB: string;
  overallHitRate: string;
  perNode: Array<NodeStats & { nodeUrl: string }>;
  timestamp: string;
}

export interface CacheEntry {
  key: string;
  value: unknown;
  ttl: number;
  _routing?: {
    nodeUrl: string;
  };
}

export interface KeyInfo {
  key: string;
  valueType: string;
  valuePreview: string;
  sizeBytes: number;
  ttl: number;
  createdAt: string;
  updatedAt: string;
}

export interface KeysResponse {
  pattern: string;
  totalCount: number;
  perNode: Record<string, number>;
  keys: string[];
}

export interface HealthResponse {
  status: string;
  coordinator: boolean;
  port: number;
  totalNodes: number;
  healthyNodes: number;
  uptime: number;
  timestamp: string;
}
