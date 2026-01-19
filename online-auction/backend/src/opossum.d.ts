declare module 'opossum' {
  interface CircuitBreakerOptions {
    timeout?: number;
    errorThresholdPercentage?: number;
    resetTimeout?: number;
    volumeThreshold?: number;
    rollingCountTimeout?: number;
    rollingCountBuckets?: number;
    name?: string;
  }

  interface CircuitBreakerStats {
    failures: number;
    successes: number;
    rejects: number;
    fires: number;
    timeouts: number;
    cacheHits: number;
    cacheMisses: number;
    semaphoreRejections: number;
    percentiles: Record<string, number>;
    latencyTimes: number[];
    latencyMean: number;
  }

  interface CircuitBreakerStatus {
    state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    enabled: boolean;
  }

  class CircuitBreaker<TArgs extends unknown[] = unknown[], TReturn = unknown> {
    constructor(action: (...args: TArgs) => Promise<TReturn>, options?: CircuitBreakerOptions);

    fire(...args: TArgs): Promise<TReturn>;
    fallback(func: (...args: TArgs) => TReturn): void;

    on(event: 'success', listener: (result: TReturn) => void): this;
    on(event: 'failure' | 'timeout', listener: (error: Error) => void): this;
    on(event: 'reject' | 'open' | 'halfOpen' | 'close', listener: () => void): this;

    get stats(): CircuitBreakerStats;
    get status(): CircuitBreakerStatus;

    enable(): void;
    disable(): void;
    open(): void;
    close(): void;
    halfOpen(): void;
  }

  export default CircuitBreaker;
}
