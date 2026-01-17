export interface Suggestion {
  phrase: string;
  count: number;
  score?: number;
  lastUpdated?: number;
  isFuzzy?: boolean;
  distance?: number;
  scores?: {
    popularity: number;
    recency: number;
    personal: number;
    trending: number;
    match: number;
  };
}

export interface SuggestionsResponse {
  prefix: string;
  suggestions: Suggestion[];
  meta: {
    count: number;
    responseTimeMs: number;
    cached: boolean;
  };
}

export interface TrendingResponse {
  trending: Array<{
    phrase: string;
    score: number;
  }>;
  meta: {
    count: number;
    timestamp: string;
  };
}

export interface HistoryItem {
  phrase: string;
  count: number;
  timestamp: number;
}

export interface HistoryResponse {
  history: HistoryItem[];
  meta: {
    count: number;
    userId: string;
  };
}

export interface AnalyticsSummary {
  today: {
    totalQueries: number;
    uniqueQueries: number;
    uniqueUsers: number;
    avgQueryLength: string;
  };
  allTime: {
    totalQueries: number;
    uniqueQueries: number;
  };
  phrases: {
    totalPhrases: number;
    totalSearches: number;
    maxPhraseCount: number;
  };
  trie: {
    phraseCount: number;
    nodeCount: number;
    maxDepth: number;
    topK: number;
  };
  aggregation: {
    bufferSize: number;
    isRunning: boolean;
    flushInterval: number;
  };
  timestamp: string;
}

export interface HourlyStats {
  hour: string;
  queryCount: number;
  uniqueQueries: number;
  uniqueUsers: number;
}

export interface TopPhrase {
  phrase: string;
  count: number;
  lastUpdated: string;
}

export interface SystemStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  services: {
    redis: string;
    postgres: string;
  };
  trie: {
    phraseCount: number;
    nodeCount: number;
    maxDepth: number;
    topK: number;
  };
  aggregation: {
    bufferSize: number;
    isRunning: boolean;
    flushInterval: number;
  };
  uptime: number;
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  timestamp: string;
}
